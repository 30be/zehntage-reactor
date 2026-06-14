// Pure-picker tests for G5 "word of the day". No Date.now — the day seed is
// always passed in explicitly so determinism is directly assertable.

import { describe, expect, test } from "bun:test";
import {
  pickWordOfDay,
  type WordDayCard,
  type WordDayProgress,
} from "../web/wordday.ts";

const deck: WordDayCard[] = [
  { front: "勉強 [べんきょう]", back: "учёба" },
  { front: "図書館 [としょかん]", back: "библиотека" },
  { front: "先生 [せんせい]", back: "учитель" },
  { front: "学校 [がっこう]", back: "школа" },
];

describe("pickWordOfDay", () => {
  test("empty deck → null", () => {
    expect(pickWordOfDay([], {}, "2026-06-14")).toBeNull();
  });

  test("deck of all-unusable cards (blank back) → null", () => {
    expect(
      pickWordOfDay([{ front: "x", back: "" }], {}, "2026-06-14"),
    ).toBeNull();
  });

  test("single-word deck always returns that word", () => {
    const one: WordDayCard[] = [{ front: "猫 [ねこ]", back: "кошка" }];
    const a = pickWordOfDay(one, {}, "2026-06-14");
    const b = pickWordOfDay(one, {}, "2099-01-01");
    expect(a?.word).toBe("猫");
    expect(a?.reading).toBe("ねこ");
    expect(a?.meaning).toBe("кошка");
    expect(b?.word).toBe("猫");
  });

  test("stable for the same day (deterministic across calls)", () => {
    const a = pickWordOfDay(deck, {}, "2026-06-14");
    const b = pickWordOfDay(deck, {}, "2026-06-14");
    expect(a).toEqual(b);
    expect(a?.word).toBeTruthy();
  });

  test("input order does not change the same-day pick", () => {
    const shuffled = [deck[3]!, deck[0]!, deck[2]!, deck[1]!];
    const a = pickWordOfDay(deck, {}, "2026-06-14");
    const b = pickWordOfDay(shuffled, {}, "2026-06-14");
    expect(a).toEqual(b);
  });

  test("rotates: at least two different picks across a span of days", () => {
    const picks = new Set<string>();
    for (let d = 1; d <= 20; d++) {
      const day = `2026-06-${String(d).padStart(2, "0")}`;
      picks.add(pickWordOfDay(deck, {}, day)!.word);
    }
    expect(picks.size).toBeGreaterThan(1);
  });

  test("prefers mature words: only mature cards are ever picked", () => {
    // Two mature, two brand-new (no progress). Over many days only the mature
    // pool (top half) should ever surface.
    const progress: Record<string, WordDayProgress> = {
      "勉強 [べんきょう]": { interval: 60, reps: 10 },
      "図書館 [としょかん]": { interval: 45, reps: 8 },
      // 先生 / 学校 have no progress → maturity 0, excluded from top half.
    };
    const seen = new Set<string>();
    for (let d = 1; d <= 30; d++) {
      const day = `2026-07-${String(d).padStart(2, "0")}`;
      seen.add(pickWordOfDay(deck, progress, day)!.word);
    }
    expect(seen.has("先生")).toBe(false);
    expect(seen.has("学校")).toBe(false);
    expect([...seen].every((w) => w === "勉強" || w === "図書館")).toBe(true);
  });

  test("explicit reading field wins over parsed front", () => {
    const p = pickWordOfDay(
      [{ front: "音 [おと]", back: "звук", reading: "OVERRIDE" }],
      {},
      "2026-06-14",
    );
    expect(p?.reading).toBe("OVERRIDE");
  });

  test("front without a reading → empty reading, bare word", () => {
    const p = pickWordOfDay([{ front: "ねこ", back: "кошка" }], {}, "2026-06-14");
    expect(p?.word).toBe("ねこ");
    expect(p?.reading).toBe("");
  });

  test("unparseable day seed still returns deterministically", () => {
    const a = pickWordOfDay(deck, {}, "not-a-date");
    const b = pickWordOfDay(deck, {}, "not-a-date");
    expect(a).toEqual(b);
    expect(a?.word).toBeTruthy();
  });
});
