import { describe, expect, test } from "bun:test";
import {
  buildQuiz,
  pickClozeWord,
  blankOut,
  checkCloze,
  normalizeAnswer,
  BLANK,
  type QuizCue,
  type McItem,
  type ClozeItem,
} from "../web/quiz.ts";

const w = (surface: string, lemma = surface) => ({ surface, lemma });

const CUES: QuizCue[] = [
  { text: "勉強します。", translation: "Я учусь.", words: [w("勉強")] },
  { text: "図書館へ行きます。", translation: "Я иду в библиотеку.", words: [w("図書館"), w("行き", "行く")] },
  { text: "気になります。", translation: "Меня это интересует.", words: [w("気")] },
  { text: "本を読みました。", translation: "Я прочитал книгу.", words: [w("本"), w("読み", "読む")] },
  { text: "友達と話します。", translation: "Я говорю с друзьями.", words: [w("友達"), w("話し", "話す")] },
];

describe("blankOut", () => {
  test("replaces first occurrence with BLANK", () => {
    expect(blankOut("図書館へ行きます。", "図書館")).toBe(`${BLANK}へ行きます。`);
  });
  test("only the first occurrence", () => {
    expect(blankOut("本本", "本")).toBe(`${BLANK}本`);
  });
  test("missing surface leaves text untouched", () => {
    expect(blankOut("あいう", "xyz")).toBe("あいう");
  });
});

describe("pickClozeWord", () => {
  test("prefers a deck (learning) word", () => {
    const cue: QuizCue = { text: "図書館へ行きます。", words: [w("図書館"), w("行き", "行く")] };
    const got = pickClozeWord(cue, new Set(["行く"]), new Set());
    expect(got?.lemma).toBe("行く");
  });
  test("falls back to an unknown content word", () => {
    const cue: QuizCue = { text: "図書館へ行きます。", words: [w("図書館"), w("行き", "行く")] };
    const got = pickClozeWord(cue, new Set(), new Set(["図書館"]));
    expect(got?.lemma).toBe("行く");
  });
  test("falls back to longest when all known and none in deck", () => {
    const cue: QuizCue = { text: "図書館本。", words: [w("本"), w("図書館")] };
    const got = pickClozeWord(cue, new Set(), new Set(["本", "図書館"]));
    expect(got?.surface).toBe("図書館");
  });
  test("returns null with no content words", () => {
    expect(pickClozeWord({ text: "。", words: [] }, new Set(), new Set())).toBeNull();
  });
});

describe("normalizeAnswer / checkCloze", () => {
  test("trims and lowercases and strips inner spaces", () => {
    expect(normalizeAnswer("  Foo Bar ")).toBe("foobar");
  });
  test("checkCloze tolerant match", () => {
    expect(checkCloze(" 図書館 ", "図書館")).toBe(true);
    expect(checkCloze("ちがう", "図書館")).toBe(false);
  });
});

describe("buildQuiz", () => {
  test("is deterministic for a fixed seed", () => {
    const a = buildQuiz(CUES, { seed: 42 });
    const b = buildQuiz(CUES, { seed: 42 });
    expect(a).toEqual(b);
  });

  test("respects count cap", () => {
    expect(buildQuiz(CUES, { seed: 1, count: 3 })).toHaveLength(3);
  });

  test("produces MC items when enough distinct translations exist", () => {
    const items = buildQuiz(CUES, { seed: 1 });
    const mc = items.filter((i): i is McItem => i.kind === "mc");
    expect(mc.length).toBeGreaterThan(0);
  });

  test("every MC item has a correct answer pointing at the real translation", () => {
    const items = buildQuiz(CUES, { seed: 7 });
    for (const it of items) {
      if (it.kind !== "mc") continue;
      const cue = CUES.find((c) => c.text === it.prompt)!;
      expect(it.options[it.answer]).toBe(cue.translation);
      // options are unique and bounded
      expect(new Set(it.options).size).toBe(it.options.length);
      expect(it.options.length).toBeGreaterThanOrEqual(3);
      expect(it.options.length).toBeLessThanOrEqual(4);
    }
  });

  test("falls back to cloze when translations are absent", () => {
    const noTr: QuizCue[] = CUES.map((c) => ({ text: c.text, words: c.words }));
    const items = buildQuiz(noTr, { seed: 1 });
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.kind === "cloze")).toBe(true);
    for (const it of items as ClozeItem[]) {
      expect(it.prompt).toContain(BLANK);
      expect(it.answer.length).toBeGreaterThan(0);
    }
  });

  test("cloze blanks a deck word when MC is unavailable", () => {
    // single cue → no distractor pool → cloze path
    const one: QuizCue[] = [
      { text: "図書館へ行きます。", translation: "x", words: [w("図書館"), w("行き", "行く")] },
    ];
    const items = buildQuiz(one, { seed: 1, deck: new Set(["行く"]) });
    expect(items).toHaveLength(1);
    const it = items[0] as ClozeItem;
    expect(it.kind).toBe("cloze");
    expect(it.answer).toBe("行き");
    expect(it.prompt).toBe(`図書館へ${BLANK}ます。`);
  });

  test("skips empty cues and produces nothing from junk", () => {
    expect(buildQuiz([{ text: "  " }], { seed: 1 })).toEqual([]);
  });

  test("never exceeds available material", () => {
    const items = buildQuiz(CUES.slice(0, 2), { seed: 1, count: 10 });
    expect(items.length).toBeLessThanOrEqual(2);
  });
});
