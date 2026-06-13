import { test, expect, describe } from "bun:test";
import { shouldSkipAutopause } from "../web/player/autopause.ts";
import { pickResumeTime } from "../web/player/resume.ts";
import { findSkipTarget } from "../web/player/skipGap.ts";
import {
  cueUnknownKeys,
  computeCueUnknowns,
} from "../web/player/cueUnknowns.ts";
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
