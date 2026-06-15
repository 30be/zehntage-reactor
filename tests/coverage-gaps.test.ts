// Targeted edge-case coverage for several pure helpers whose existing suites
// miss specific boundaries (see /tmp/zehntage-coverage-gaps.md). All pure +
// deterministic: no Date.now / Math.random / network / fs / DOM.

import { describe, expect, test } from "bun:test";
import { rankPreStudy } from "../web/prestudy.ts";
import { collapseRepeatedCues, dropRepeatingCycles, type Cue } from "../src/lib/subs.ts";
import { buildQuiz, normalizeAnswer, type QuizCue } from "../web/quiz.ts";
import { toCsv, type EpisodeDayRow } from "../src/lib/telemetry.ts";
import { frontWord } from "../web/cardfilter.ts";

// ---------------------------------------------------------------------------
// web/prestudy.ts :: rankPreStudy
// ---------------------------------------------------------------------------

const item = (key: string, checked = true) => ({ key, checked });

describe("rankPreStudy — edge cases", () => {
  test("empty items → empty output", () => {
    expect(rankPreStudy([], [["a"], ["b", "c"]])).toEqual([]);
  });

  test("empty cue list → nothing flagged, all stay tier 1 in original order", () => {
    const out = rankPreStudy([item("a"), item("b")], []);
    expect(out.map((x) => x.key)).toEqual(["a", "b"]);
    expect(out.every((x) => !x.iPlusOne && !x.muddy)).toBe(true);
    expect(out.every((x) => x.checked)).toBe(true);
  });

  test("2-unknown cue (below muddy threshold, not i+1) → normal tier 1, stays checked", () => {
    // "a" and "b" only co-occur in a 2-unknown cue: not i+1 (clean), not muddy
    // (needs >=3 unknowns). They remain plain tier-1 items.
    const out = rankPreStudy([item("a"), item("b")], [["a", "b"]]);
    expect(out.map((x) => x.key)).toEqual(["a", "b"]);
    expect(out.every((x) => !x.iPlusOne && !x.muddy)).toBe(true);
    expect(out.every((x) => x.checked)).toBe(true);
  });

  test("top-5 protection: first 5 stay checked even if muddy, 6th muddy unchecked", () => {
    // 6 items, each appearing only in its OWN 3-unknown (muddy) cue, so all are
    // muddy. After sort (all tier 2, stable) the first 5 stay checked; #6 off.
    const keys = ["a", "b", "c", "d", "e", "f"];
    const items = keys.map((k) => item(k, true));
    const cues = keys.map((k) => [k, "x", "y"]); // each cue has 3 unknowns
    const out = rankPreStudy(items, cues);
    expect(out.every((x) => x.muddy)).toBe(true);
    expect(out.slice(0, 5).every((x) => x.checked)).toBe(true);
    expect(out[5]!.checked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// src/lib/subs.ts :: collapseRepeatedCues / dropRepeatingCycles
// (only cases NOT already in tests/subs.test.ts)
// ---------------------------------------------------------------------------

const cue = (start: number, end: number, text: string): Cue => ({ start, end, text });
const texts = (cs: { text: string }[]) => cs.map((c) => c.text);

describe("collapseRepeatedCues — threshold edges", () => {
  test("run shorter than minRun (and under span) is NOT collapsed", () => {
    // 3-run, short span (< 20s) → kept verbatim.
    const cues = [
      cue(0, 1, "ループ"),
      cue(1, 2, "ループ"),
      cue(2, 3, "ループ"),
      cue(3, 4, "次"),
    ];
    expect(collapseRepeatedCues(cues)).toEqual(cues);
  });

  test("explicit higher minRun: a 4-run survives when minRun=5", () => {
    const cues = Array.from({ length: 4 }, (_, i) => cue(i, i + 1, "ループ"));
    expect(collapseRepeatedCues(cues, 5)).toEqual(cues);
  });

  test("run exactly at minRun threshold collapses (minRun=3, 3 identical short cues)", () => {
    const cues = [
      cue(0, 1, "ループ"),
      cue(1, 2, "ループ"),
      cue(2, 3, "ループ"),
      cue(3, 4, "次"),
    ];
    const out = collapseRepeatedCues(cues, 3);
    expect(texts(out)).toEqual(["ループ", "次"]);
  });
});

describe("dropRepeatingCycles — cycle edges", () => {
  test("empty input → empty output", () => {
    expect(dropRepeatingCycles([])).toEqual([]);
  });

  test("single-element 'cycle' (period 1, 1 rep) is untouched", () => {
    const cues = [cue(0, 1, "A"), cue(1, 2, "B")];
    expect(dropRepeatingCycles(cues)).toEqual(cues);
  });

  test("period-2 block repeated keeps only the first block", () => {
    // A B A B A B → keep one A B
    const cues = [
      cue(0, 1, "letterA"),
      cue(1, 2, "letterB"),
      cue(2, 3, "letterA"),
      cue(3, 4, "letterB"),
      cue(4, 5, "letterA"),
      cue(5, 6, "letterB"),
      cue(6, 7, "本物"),
    ];
    const out = dropRepeatingCycles(cues);
    expect(texts(out)).toEqual(["letterA", "letterB", "本物"]);
  });

  test("period-2 with trailing partial repeat (wrap-around drift) consumes the partial tail", () => {
    // A B A B A → the trailing lone A still matches cycle position 0, dropped.
    const cues = [
      cue(0, 1, "letterA"),
      cue(1, 2, "letterB"),
      cue(2, 3, "letterA"),
      cue(3, 4, "letterB"),
      cue(4, 5, "letterA"),
      cue(5, 6, "別物のセリフ"),
    ];
    const out = dropRepeatingCycles(cues);
    expect(texts(out)).toEqual(["letterA", "letterB", "別物のセリフ"]);
  });

  test("period-2 block appearing only once is NOT dropped", () => {
    const cues = [cue(0, 1, "letterA"), cue(1, 2, "letterB"), cue(2, 3, "別物")];
    expect(dropRepeatingCycles(cues)).toEqual(cues);
  });
});

// ---------------------------------------------------------------------------
// web/quiz.ts :: buildQuiz (MC mode) + normalizeAnswer
// ---------------------------------------------------------------------------

describe("buildQuiz — MC item generation", () => {
  test("cues with distinct translations generate MC items with the right answer index", () => {
    const cues: QuizCue[] = [
      { text: "猫が好き", translation: "люблю кошек" },
      { text: "犬が好き", translation: "люблю собак" },
      { text: "鳥が好き", translation: "люблю птиц" },
      { text: "魚が好き", translation: "люблю рыб" },
    ];
    const items = buildQuiz(cues, { seed: 7, count: 4 });
    expect(items.length).toBeGreaterThan(0);
    const mc = items.filter((i) => i.kind === "mc");
    expect(mc.length).toBeGreaterThan(0);
    for (const it of mc) {
      if (it.kind !== "mc") continue;
      // answer index points at the correct option, which must be present
      expect(it.options[it.answer]).toBeDefined();
      expect(it.options.length).toBeGreaterThanOrEqual(2);
      // options unique and include the prompt cue's own translation
      const cue = cues.find((c) => c.text === it.prompt)!;
      expect(it.options).toContain(cue.translation!);
      expect(it.options.indexOf(cue.translation!)).toBe(it.answer);
    }
  });

  test("deterministic given the same seed", () => {
    const cues: QuizCue[] = [
      { text: "猫", translation: "кошка" },
      { text: "犬", translation: "собака" },
      { text: "鳥", translation: "птица" },
    ];
    expect(buildQuiz(cues, { seed: 3 })).toEqual(buildQuiz(cues, { seed: 3 }));
  });

  test("empty cue list → [] without throwing", () => {
    expect(buildQuiz([])).toEqual([]);
  });
});

describe("normalizeAnswer — full-width / kana / punctuation", () => {
  test("strips brackets, spaces and punctuation, lowercases", () => {
    expect(normalizeAnswer("  [Cat] ")).toBe("cat");
    expect(normalizeAnswer("ABC")).toBe("abc");
  });

  test("punctuation-only guess normalizes to empty string", () => {
    expect(normalizeAnswer("[]　。！")).toBe("");
  });

  test("kanji/kana content is preserved, full-width punctuation removed", () => {
    expect(normalizeAnswer("猫だ！")).toBe("猫だ");
    expect(normalizeAnswer("ねこ、")).toBe("ねこ");
  });
});

// ---------------------------------------------------------------------------
// src/lib/telemetry.ts :: toCsv
// ---------------------------------------------------------------------------

const row = (over: Partial<EpisodeDayRow> = {}): EpisodeDayRow => ({
  mediaId: "ep1",
  date: "2026-06-14",
  wallPlayingSec: 100,
  wallPausedSec: 0,
  contentSec: 90,
  coefficient: null,
  lookups: 0,
  ankiAdds: 0,
  cardsPerMin: null,
  ...over,
});

describe("toCsv — escaping + empty contract", () => {
  test("empty input → header-only line plus trailing newline", () => {
    const csv = toCsv([]);
    expect(csv).toBe(
      "mediaId,date,wallPlayingSec,wallPausedSec,contentSec,coefficient,lookups,ankiAdds,cardsPerMin\n",
    );
  });

  test("mediaId containing a comma is wrapped in quotes", () => {
    const csv = toCsv([row({ mediaId: "ep,1" })]);
    const dataLine = csv.split("\n")[1]!;
    expect(dataLine.startsWith('"ep,1",')).toBe(true);
  });

  test("mediaId containing a quote has it doubled and is wrapped", () => {
    const csv = toCsv([row({ mediaId: 'a"b' })]);
    const dataLine = csv.split("\n")[1]!;
    expect(dataLine.startsWith('"a""b",')).toBe(true);
  });

  test("numeric fields: integers bare, floats to 3 decimals, null → empty", () => {
    const csv = toCsv([row({ coefficient: 1.23456, cardsPerMin: null, wallPlayingSec: 60 })]);
    const cells = csv.split("\n")[1]!.split(",");
    // header order: mediaId,date,wallPlayingSec,wallPausedSec,contentSec,coefficient,lookups,ankiAdds,cardsPerMin
    expect(cells[2]).toBe("60"); // integer bare
    expect(cells[5]).toBe("1.235"); // float, 3 decimals
    expect(cells[8]).toBe(""); // null → empty
  });
});

// ---------------------------------------------------------------------------
// web/cardfilter.ts :: frontWord
// ---------------------------------------------------------------------------

describe("frontWord — 'word [reading]' parsing", () => {
  test("strips the [reading] suffix", () => {
    expect(frontWord("猫 [ねこ]")).toBe("猫");
  });

  test("no bracket → trimmed whole string", () => {
    expect(frontWord("猫")).toBe("猫");
    expect(frontWord("  食べる  ")).toBe("食べる");
  });

  test("empty string → empty string", () => {
    expect(frontWord("")).toBe("");
  });

  test("malformed/unclosed bracket still strips from the bracket on", () => {
    expect(frontWord("猫 [ねこ")).toBe("猫");
  });

  test("extra whitespace before the bracket is removed", () => {
    expect(frontWord("食べる    [たべる]")).toBe("食べる");
  });
});
