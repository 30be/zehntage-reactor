// Wave-13 extra coverage for src/lib/tokenindex.ts :: buildEntryIndex
// Coverage gap item #8: per-cue cap at MAX_CUES_PER_LEMMA (20) and the
// within-cue dedup (count increments twice, only one example cue).
//
// buildEntryIndex takes an optional `tokenize` injection, so these tests run
// without the kuromoji dictionary by supplying a deterministic tokenizer.

import { describe, expect, test } from "bun:test";
import type { Cue } from "../src/lib/subs.ts";
import { buildEntryIndex, type Tokenize } from "../src/lib/tokenindex.ts";
import { sniffSubtitleLang } from "../src/lib/library.ts";
import type { KToken } from "../src/lib/jatok.ts";

function cue(start: number, text: string): Cue {
  return { start, end: start + 2, text };
}

// A tokenizer that splits a cue on spaces; each whitespace-delimited piece
// becomes one lexical noun token (basic_form === surface so lemmaOf is stable).
const splitTokenize: Tokenize = (text: string): KToken[] =>
  text
    .split(/\s+/)
    .filter((s) => s.length > 0)
    .map((s) => ({ surface_form: s, basic_form: s, pos: "名詞" }));

describe("buildEntryIndex — per-cue example cap (MAX_CUES_PER_LEMMA = 20)", () => {
  test("lemma in 21 distinct cues → cues.length === 20, count === 21", async () => {
    const cues = Array.from({ length: 21 }, (_, i) => cue(i, "ねこ"));
    const ix = await buildEntryIndex({ id: "ep" }, cues, splitTokenize);
    const info = ix.lemmas.get("ねこ")!;
    expect(info.count).toBe(21);
    expect(info.cues).toHaveLength(20);
    // The retained examples are the FIRST 20 cues (idx 0..19).
    expect(info.cues.map((c) => c.idx)).toEqual(
      Array.from({ length: 20 }, (_, i) => i),
    );
  });

  test("exactly 20 cues → all 20 kept (boundary, no drop)", async () => {
    const cues = Array.from({ length: 20 }, (_, i) => cue(i, "ねこ"));
    const ix = await buildEntryIndex({ id: "ep" }, cues, splitTokenize);
    const info = ix.lemmas.get("ねこ")!;
    expect(info.count).toBe(20);
    expect(info.cues).toHaveLength(20);
  });
});

describe("buildEntryIndex — within-cue dedup", () => {
  test("same lemma twice in ONE cue → count += 2 but one example", async () => {
    const ix = await buildEntryIndex(
      { id: "ep" },
      [cue(0, "ねこ ねこ")],
      splitTokenize,
    );
    const info = ix.lemmas.get("ねこ")!;
    expect(info.count).toBe(2);
    expect(info.cues).toHaveLength(1);
    expect(info.cues[0]!.idx).toBe(0);
    // totalLexical counts every occurrence (denominator), not deduped.
    expect(ix.totalLexical).toBe(2);
  });

  test("same lemma in two cues → count 2, two examples", async () => {
    const ix = await buildEntryIndex(
      { id: "ep" },
      [cue(0, "ねこ"), cue(5, "ねこ")],
      splitTokenize,
    );
    const info = ix.lemmas.get("ねこ")!;
    expect(info.count).toBe(2);
    expect(info.cues).toHaveLength(2);
    expect(info.cues.map((c) => c.idx)).toEqual([0, 1]);
  });

  test("dedup + cap combine: lemma 3x/cue across 21 cues → count 63, 20 examples", async () => {
    const cues = Array.from({ length: 21 }, (_, i) => cue(i, "ねこ ねこ ねこ"));
    const ix = await buildEntryIndex({ id: "ep" }, cues, splitTokenize);
    const info = ix.lemmas.get("ねこ")!;
    expect(info.count).toBe(63);
    expect(info.cues).toHaveLength(20);
  });
});

// ---------------------------------------------------------------------------
// library.ts :: sniffSubtitleLang — borderline thresholds (gap item #9).
// kana/letters STRICT > 0.1 → "ja"; else cyr/letters STRICT > 0.5 → "ru".
// Whitespace is skipped; digits/punctuation/{tags} are stripped before counting.
// ---------------------------------------------------------------------------

describe("sniffSubtitleLang — kana ratio strict > 0.1", () => {
  test("exactly 10% kana (1 kana / 10 letters) → und (strict >, not >=)", () => {
    // 1 hiragana + 9 latin letters = 10 letters, kana ratio = 0.1 exactly.
    expect(sniffSubtitleLang("あabcdefghi")).toBe("und");
  });

  test("just over 10% (1 kana / 9 letters ≈ 0.111) → ja", () => {
    expect(sniffSubtitleLang("あabcdefgh")).toBe("ja");
  });

  test("katakana also counts as kana", () => {
    // 1 katakana + 8 latin = 9 letters, 0.111 > 0.1 → ja
    expect(sniffSubtitleLang("アabcdefgh")).toBe("ja");
  });

  test("kana wins over cyrillic when both present and kana > 0.1", () => {
    // 2 kana + 8 cyr = 10 letters: kana 0.2 > 0.1 → ja (checked first)
    expect(sniffSubtitleLang("ねこприветдф")).toBe("ja");
  });
});

describe("sniffSubtitleLang — cyrillic strict > 0.5", () => {
  test("exactly 50% cyrillic (no kana) → und (strict >, not >=)", () => {
    // 4 cyrillic + 4 latin = 8 letters, cyr ratio = 0.5 exactly.
    expect(sniffSubtitleLang("дома abcd")).toBe("und");
  });

  test("just over 50% cyrillic → ru", () => {
    // 5 cyrillic + 4 latin = 9 letters, 0.555 > 0.5 → ru
    expect(sniffSubtitleLang("домаа abcd")).toBe("ru");
  });

  test("clearly dominant cyrillic → ru", () => {
    expect(sniffSubtitleLang("привет как дела")).toBe("ru");
  });
});

describe("sniffSubtitleLang — stripping and empty cases", () => {
  test("timestamp / index / arrow lines are stripped before counting", () => {
    const srt = [
      "1",
      "00:00:01,000 --> 00:00:02,000",
      "あいうえお",
      "",
    ].join("\n");
    expect(sniffSubtitleLang(srt)).toBe("ja");
  });

  test("ASS {tags} are stripped — only the dialogue letters count", () => {
    // tag holds latin; visible text is all kana → ja
    expect(sniffSubtitleLang("{\\an8\\fnArial}ねこだいすき")).toBe("ja");
  });

  test("no letters at all → und", () => {
    expect(sniffSubtitleLang("123 --> 456\n00:00\n!!!")).toBe("und");
  });
});
