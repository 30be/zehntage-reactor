import { test, expect, describe } from "bun:test";
import { shouldSkipAutopause } from "../web/player/autopause.ts";
import { pickResumeTime } from "../web/player/resume.ts";
import { findSkipTarget } from "../web/player/skipGap.ts";
import {
  cueUnknownKeys,
  computeCueUnknowns,
} from "../web/player/cueUnknowns.ts";
import { pickDisplayCues } from "../web/player/displayCues.ts";
import type { KToken } from "../web/tokenizer.ts";
import { buildWordIndex } from "../web/progress.ts";
import type { Cue } from "../web/api.ts";

// ---- autopause.ts ----
describe("shouldSkipAutopause", () => {
  const base = {
    echo: false,
    mode: "unknown" as const,
    min: 2,
    cueText: "今日はいい天気ですね",
    unknownCount: 0 as number | null,
  };

  test("smart mode: skip when below threshold", () => {
    expect(shouldSkipAutopause({ ...base, unknownCount: 1 })).toBe(true);
  });
  test("smart mode: pause (no skip) when at/above threshold", () => {
    expect(shouldSkipAutopause({ ...base, unknownCount: 2 })).toBe(false);
    expect(shouldSkipAutopause({ ...base, unknownCount: 5 })).toBe(false);
  });
  test("safe default: null count => pause (no skip)", () => {
    expect(shouldSkipAutopause({ ...base, unknownCount: null })).toBe(false);
  });
  test('mode "every": never skip on count, only echo length matters', () => {
    expect(
      shouldSkipAutopause({ ...base, mode: "every", unknownCount: 0 }),
    ).toBe(false);
  });
  test("echo mode: skip only when too short to dictate", () => {
    // very short cue -> too short -> skip
    expect(
      shouldSkipAutopause({ ...base, echo: true, cueText: "あ" }),
    ).toBe(true);
    // long cue -> not too short -> pause
    expect(
      shouldSkipAutopause({
        ...base,
        echo: true,
        cueText: "これは十分に長い文章なので聞き取りの練習になります",
      }),
    ).toBe(false);
  });
});

// ---- resume.ts ----
describe("pickResumeTime", () => {
  test("resumes mid-file", () => {
    expect(pickResumeTime({ saved: 100, duration: 1000 })).toBe(100);
  });
  test("skips near-start (<=15s)", () => {
    expect(pickResumeTime({ saved: 15, duration: 1000 })).toBe(null);
    expect(pickResumeTime({ saved: 10, duration: 1000 })).toBe(null);
  });
  test("just past 15s resumes", () => {
    expect(pickResumeTime({ saved: 15.5, duration: 1000 })).toBe(15.5);
  });
  test("skips near-end (within 10s)", () => {
    expect(pickResumeTime({ saved: 995, duration: 1000 })).toBe(null);
    expect(pickResumeTime({ saved: 990, duration: 1000 })).toBe(null);
  });
  test("just before end-10 resumes", () => {
    expect(pickResumeTime({ saved: 989, duration: 1000 })).toBe(989);
  });
  test("unknown duration (0) => null", () => {
    expect(pickResumeTime({ saved: 100, duration: 0 })).toBe(null);
  });
  test("non-finite saved => null", () => {
    expect(pickResumeTime({ saved: NaN, duration: 1000 })).toBe(null);
  });
});

// ---- skipGap.ts ----
describe("findSkipTarget", () => {
  const cue = (start: number, end: number): Cue => ({ start, end, text: "x" });

  test("no cues => null", () => {
    expect(findSkipTarget([], 50, 0)).toBe(null);
  });
  test("within first 10s => null", () => {
    expect(findSkipTarget([cue(0, 5), cue(200, 205)], 5, 0)).toBe(null);
  });
  test("inside a >60s gap => target 1s before next cue", () => {
    // gap from end=5 to start=200 (195s). t=50 is inside the gap.
    expect(findSkipTarget([cue(0, 5), cue(200, 205)], 50, 0)).toBe(199);
  });
  test("gap <=60s => null", () => {
    // gap from end=5 to start=60 (55s)
    expect(findSkipTarget([cue(0, 5), cue(60, 65)], 30, 0)).toBe(null);
  });
  test("inside an active cue => null", () => {
    expect(findSkipTarget([cue(0, 100)], 50, 0)).toBe(null);
  });
  test("respects subOffset", () => {
    // subOffset 2 => t = 50-2 = 48, still in gap; target = 200 + 2 - 1 = 201
    expect(findSkipTarget([cue(0, 5), cue(200, 205)], 50, 2)).toBe(201);
  });
  test("leading gap from 0 counts", () => {
    // single cue far in; prevEnd defaults to 0; gap = 200 > 60
    expect(findSkipTarget([cue(200, 205)], 50, 0)).toBe(199);
  });
});

// ---- cueUnknowns.ts ----
describe("cueUnknowns", () => {
  // Minimal fake tokenizer: returns one noun token per space-split word.
  const fakeTok = {
    tokenize: (text: string): KToken[] =>
      text
        .split(" ")
        .filter(Boolean)
        .map((w) => ({ surface_form: w, pos: "名詞", basic_form: w })),
  };

  const sets = (known: string[] = [], black: string[] = []) => ({
    wordIndex: buildWordIndex([], {}),
    knownWords: new Set(known),
    blacklist: new Set(black),
  });

  test("all tokens unknown by default", () => {
    expect(cueUnknownKeys("猫 犬 鳥", fakeTok, sets())).toEqual([
      "猫",
      "犬",
      "鳥",
    ]);
  });
  test("known words filtered out", () => {
    expect(cueUnknownKeys("猫 犬 鳥", fakeTok, sets(["犬"]))).toEqual([
      "猫",
      "鳥",
    ]);
  });
  test("blacklist filtered out", () => {
    expect(cueUnknownKeys("猫 犬 鳥", fakeTok, sets([], ["鳥"]))).toEqual([
      "猫",
      "犬",
    ]);
  });
  test("particles/aux excluded", () => {
    const tok = {
      tokenize: (): KToken[] => [
        { surface_form: "猫", pos: "名詞", basic_form: "猫" },
        { surface_form: "は", pos: "助詞", basic_form: "は" },
        { surface_form: "だ", pos: "助動詞", basic_form: "だ" },
      ],
    };
    expect(cueUnknownKeys("x", tok, sets())).toEqual(["猫"]);
  });
  test("non-lexical (記号) excluded", () => {
    const tok = {
      tokenize: (): KToken[] => [
        { surface_form: "猫", pos: "名詞", basic_form: "猫" },
        { surface_form: "。", pos: "記号", basic_form: "。" },
      ],
    };
    expect(cueUnknownKeys("x", tok, sets())).toEqual(["猫"]);
  });
  test("computeCueUnknowns returns parallel counts + lemmas", () => {
    const { counts, lemmas } = computeCueUnknowns(
      ["猫 犬", "鳥"],
      fakeTok,
      sets(["犬"]),
    );
    expect(counts).toEqual([1, 1]);
    expect(lemmas).toEqual([["猫"], ["鳥"]]);
  });
});

// ---- displayCues.ts ----
//
// pickDisplayCues(cues, activeP, heldIdx, {twoLine}) derives the on-screen
// subtitle text(s) for the dual-line "retard mode" feature. The contract:
//   twoLine OFF → current cue only (blank during gaps).
//   twoLine ON  → never blank: hold the last-active cue (heldIdx) through gaps
//                 and surface the previous cue's text above it (when eff-1 >= 0).
// These tests pin every branch + the active→gap→active transition behaviour the
// Player drives via heldCueIdxRef.
describe("pickDisplayCues", () => {
  function makeCue(start: number, end: number, text = ""): Cue {
    return { start, end, text };
  }
  const CUES: Cue[] = [
    makeCue(1, 2, "first"),
    makeCue(3, 4, "second"),
    makeCue(5, 6, "third"),
  ];

  // ---------------------------------------------------------------------------
  // toggle OFF: current cue only, blank in gaps, never a prev line.
  // ---------------------------------------------------------------------------
  describe("twoLine OFF", () => {
    test("active cue → current text only, no prev", () => {
      expect(pickDisplayCues(CUES, 1, -1, { twoLine: false })).toEqual({
        curText: "second",
        prevText: "",
      });
    });

    test("active at index 0 → still no prev line (OFF never shows prev)", () => {
      expect(pickDisplayCues(CUES, 0, -1, { twoLine: false })).toEqual({
        curText: "first",
        prevText: "",
      });
    });

    test("every active index shows exactly that cue and never a prev line", () => {
      for (let i = 0; i < CUES.length; i++) {
        expect(pickDisplayCues(CUES, i, -1, { twoLine: false })).toEqual({
          curText: CUES[i]!.text,
          prevText: "",
        });
      }
    });

    test("gap (activeP=-1) → fully blank, NO hold even with a valid heldIdx", () => {
      // heldIdx points at a real cue but OFF mode ignores it entirely.
      expect(pickDisplayCues(CUES, -1, 1, { twoLine: false })).toEqual({
        curText: "",
        prevText: "",
      });
      // ...and with no held index either.
      expect(pickDisplayCues(CUES, -1, -1, { twoLine: false })).toEqual({
        curText: "",
        prevText: "",
      });
    });
  });

  // ---------------------------------------------------------------------------
  // toggle ON: current + previous; never blank while a cue has played.
  // ---------------------------------------------------------------------------
  describe("twoLine ON — active cue", () => {
    test("active cue surfaces the previous line above it", () => {
      expect(pickDisplayCues(CUES, 2, -1, { twoLine: true })).toEqual({
        curText: "third",
        prevText: "second",
      });
      expect(pickDisplayCues(CUES, 1, -1, { twoLine: true })).toEqual({
        curText: "second",
        prevText: "first",
      });
    });

    test("at index 0 the prev line is empty (no cue before the first)", () => {
      expect(pickDisplayCues(CUES, 0, -1, { twoLine: true })).toEqual({
        curText: "first",
        prevText: "",
      });
    });

    test("for every i>0, curText=cues[i], prevText=cues[i-1]", () => {
      for (let i = 1; i < CUES.length; i++) {
        expect(pickDisplayCues(CUES, i, -1, { twoLine: true })).toEqual({
          curText: CUES[i]!.text,
          prevText: CUES[i - 1]!.text,
        });
      }
    });
  });

  describe("twoLine ON — gaps hold (never blank)", () => {
    test("single gap holds heldIdx and shows its prev", () => {
      // activeP === -1 but heldIdx points at cue[1]: hold it, show its prev above
      expect(pickDisplayCues(CUES, -1, 1, { twoLine: true })).toEqual({
        curText: "second",
        prevText: "first",
      });
    });

    test("gap while held at index 0 → holds first, prev empty", () => {
      expect(pickDisplayCues(CUES, -1, 0, { twoLine: true })).toEqual({
        curText: "first",
        prevText: "",
      });
    });

    test("gap held at the LAST cue → holds last, shows prev", () => {
      expect(pickDisplayCues(CUES, -1, 2, { twoLine: true })).toEqual({
        curText: "third",
        prevText: "second",
      });
    });

    test("multiple consecutive gap renders keep holding the same cue", () => {
      // Player keeps heldCueIdxRef pinned across every gap render — assert the
      // function is a pure function of (heldIdx) here: repeated calls are stable.
      for (let k = 0; k < 5; k++) {
        expect(pickDisplayCues(CUES, -1, 1, { twoLine: true })).toEqual({
          curText: "second",
          prevText: "first",
        });
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Defensive / boundary inputs: must never throw, always {string,string}.
  // ---------------------------------------------------------------------------
  describe("twoLine ON — safe on bad indices / empty inputs", () => {
    test("heldIdx out of range (too high) → blank, no throw", () => {
      expect(pickDisplayCues(CUES, -1, 99, { twoLine: true })).toEqual({
        curText: "",
        prevText: "",
      });
    });

    test("heldIdx === -1 during a gap (nothing has played yet) → blank", () => {
      expect(pickDisplayCues(CUES, -1, -1, { twoLine: true })).toEqual({
        curText: "",
        prevText: "",
      });
    });

    test("negative heldIdx other than -1 → blank, no throw", () => {
      expect(pickDisplayCues(CUES, -1, -5, { twoLine: true })).toEqual({
        curText: "",
        prevText: "",
      });
    });

    test("empty cue array → blank for both ON and OFF, no throw", () => {
      expect(pickDisplayCues([], 0, 0, { twoLine: true })).toEqual({
        curText: "",
        prevText: "",
      });
      expect(pickDisplayCues([], -1, 5, { twoLine: true })).toEqual({
        curText: "",
        prevText: "",
      });
      expect(pickDisplayCues([], 0, 0, { twoLine: false })).toEqual({
        curText: "",
        prevText: "",
      });
    });

    test("single-cue list: active shows it with empty prev (ON and OFF)", () => {
      const one = [makeCue(1, 2, "only")];
      expect(pickDisplayCues(one, 0, -1, { twoLine: true })).toEqual({
        curText: "only",
        prevText: "",
      });
      expect(pickDisplayCues(one, 0, -1, { twoLine: false })).toEqual({
        curText: "only",
        prevText: "",
      });
    });

    test("single-cue list: gap holds it with empty prev", () => {
      const one = [makeCue(1, 2, "only")];
      expect(pickDisplayCues(one, -1, 0, { twoLine: true })).toEqual({
        curText: "only",
        prevText: "",
      });
    });

    test("activeP beyond the array length → blank curText (no cue there)", () => {
      // A stale activeP one render ahead of a shrunk cue list must not throw.
      expect(pickDisplayCues(CUES, 99, -1, { twoLine: true })).toEqual({
        curText: "",
        // eff-1 = 98 also has no cue → empty prev
        prevText: "",
      });
      expect(pickDisplayCues(CUES, 99, -1, { twoLine: false })).toEqual({
        curText: "",
        prevText: "",
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Transition simulation: active → gap → active, mirroring the Player's
  // heldCueIdxRef update (`if (activeP >= 0) held = activeP`). In ON mode the
  // line must NEVER blank once any cue has been active; in OFF mode gaps blank.
  // ---------------------------------------------------------------------------
  describe("active→gap→active transitions (heldIdx tracking)", () => {
    // Drive a timeline of activeP values through the same held-index update the
    // Player does, collecting the rendered {curText, prevText} at each step.
    function runTimeline(activeSeq: number[], twoLine: boolean) {
      let held = -1;
      return activeSeq.map((activeP) => {
        if (activeP >= 0) held = activeP; // mirrors Player.tsx line 1094
        return pickDisplayCues(CUES, activeP, held, { twoLine });
      });
    }

    test("ON: cue0 → gap → cue1 → gap → cue2 never blanks and tracks prev", () => {
      const out = runTimeline([0, -1, 1, -1, 2, -1], true);
      expect(out).toEqual([
        { curText: "first", prevText: "" }, // active cue0
        { curText: "first", prevText: "" }, // gap holds cue0
        { curText: "second", prevText: "first" }, // active cue1
        { curText: "second", prevText: "first" }, // gap holds cue1
        { curText: "third", prevText: "second" }, // active cue2
        { curText: "third", prevText: "second" }, // gap holds cue2
      ]);
      // Invariant: not a single blank curText after the first cue played.
      for (const r of out) expect(r.curText).not.toBe("");
    });

    test("ON: leading gap BEFORE any cue is blank, then never blanks again", () => {
      const out = runTimeline([-1, -1, 0, -1, 1], true);
      expect(out[0]).toEqual({ curText: "", prevText: "" }); // nothing has played
      expect(out[1]).toEqual({ curText: "", prevText: "" });
      expect(out[2]).toEqual({ curText: "first", prevText: "" });
      // After cue0 played, every later render is non-blank.
      for (const r of out.slice(2)) expect(r.curText).not.toBe("");
    });

    test("ON: a long run of consecutive gaps keeps holding the last cue", () => {
      const out = runTimeline([1, -1, -1, -1, -1], true);
      for (const r of out) {
        expect(r).toEqual({ curText: "second", prevText: "first" });
      }
    });

    test("OFF: the SAME timeline blanks during every gap", () => {
      const out = runTimeline([0, -1, 1, -1, 2, -1], false);
      expect(out).toEqual([
        { curText: "first", prevText: "" },
        { curText: "", prevText: "" }, // gap → blank
        { curText: "second", prevText: "" },
        { curText: "", prevText: "" }, // gap → blank
        { curText: "third", prevText: "" },
        { curText: "", prevText: "" }, // gap → blank
      ]);
    });
  });
});
