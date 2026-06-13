// Unit tests for src/lib/jatok.ts — pure helper functions.
// All tests are synchronous and require no tokenizer dictionary.
//
// Key concerns:
//   - lemmaOf: conjugated forms that share a basic_form map to ONE lemma key
//   - isLexical: correct filtering of punctuation / symbols / whitespace
//   - mergeTokens: gluing logic for over-segmented kuromoji output

import { describe, expect, test } from "bun:test";
import { lemmaOf, isLexical, kataToHira, mergeTokens, type KToken } from "../src/lib/jatok.ts";

// ---------------------------------------------------------------------------
// lemmaOf — the core lemma-keying function
// ---------------------------------------------------------------------------

describe("lemmaOf", () => {
  test("uses basic_form when present and not '*'", () => {
    const tok: KToken = { surface_form: "食べた", basic_form: "食べる", pos: "動詞" };
    expect(lemmaOf(tok)).toBe("食べる");
  });

  test("falls back to surface_form when basic_form is '*'", () => {
    const tok: KToken = { surface_form: "hogehoge", basic_form: "*" };
    expect(lemmaOf(tok)).toBe("hogehoge");
  });

  test("falls back to surface_form when basic_form is absent", () => {
    const tok: KToken = { surface_form: "猫" };
    expect(lemmaOf(tok)).toBe("猫");
  });

  test("falls back to surface_form when basic_form is empty string", () => {
    const tok: KToken = { surface_form: "猫", basic_form: "" };
    // empty string is falsy → treated as absent
    expect(lemmaOf(tok)).toBe("猫");
  });

  test("conjugation keying: 食べた, 食べない, 食べる all yield '食べる'", () => {
    const forms: KToken[] = [
      { surface_form: "食べた",   basic_form: "食べる", pos: "動詞" },
      { surface_form: "食べない", basic_form: "食べる", pos: "動詞" },
      { surface_form: "食べる",   basic_form: "食べる", pos: "動詞" },
    ];
    const lemmas = new Set(forms.map(lemmaOf));
    expect(lemmas.size).toBe(1);
    expect([...lemmas][0]).toBe("食べる");
  });

  test("different verbs yield different lemmas", () => {
    const tok1: KToken = { surface_form: "食べた", basic_form: "食べる" };
    const tok2: KToken = { surface_form: "飲んだ", basic_form: "飲む" };
    expect(lemmaOf(tok1)).not.toBe(lemmaOf(tok2));
  });
});

// ---------------------------------------------------------------------------
// isLexical — punctuation / symbol filtering
// ---------------------------------------------------------------------------

describe("isLexical", () => {
  test("noun is lexical", () => {
    expect(isLexical({ surface_form: "猫", pos: "名詞" })).toBe(true);
  });

  test("verb is lexical", () => {
    expect(isLexical({ surface_form: "食べる", pos: "動詞" })).toBe(true);
  });

  test("adjective is lexical", () => {
    expect(isLexical({ surface_form: "辛い", pos: "形容詞" })).toBe(true);
  });

  test("記号 (symbol) is NOT lexical", () => {
    expect(isLexical({ surface_form: "。", pos: "記号" })).toBe(false);
    expect(isLexical({ surface_form: "！", pos: "記号" })).toBe(false);
    expect(isLexical({ surface_form: "・", pos: "記号" })).toBe(false);
  });

  test("whitespace-only surface is NOT lexical", () => {
    expect(isLexical({ surface_form: " " })).toBe(false);
    expect(isLexical({ surface_form: "\t" })).toBe(false);
    expect(isLexical({ surface_form: "　" })).toBe(false); // full-width space
  });

  test("token with no pos is lexical (default)", () => {
    // No pos field → isLexical falls through, returns true
    expect(isLexical({ surface_form: "猫" })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// kataToHira — katakana → hiragana conversion
// ---------------------------------------------------------------------------

describe("kataToHira", () => {
  test("converts katakana to hiragana", () => {
    expect(kataToHira("ネコ")).toBe("ねこ");
    expect(kataToHira("タベル")).toBe("たべる");
  });

  test("hiragana passthrough (no change)", () => {
    expect(kataToHira("ねこ")).toBe("ねこ");
  });

  test("mixed string converts only katakana portion", () => {
    expect(kataToHira("ネこ")).toBe("ねこ");
  });

  test("empty string → empty string", () => {
    expect(kataToHira("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// mergeTokens — gluing rules
// ---------------------------------------------------------------------------

function tok(
  surface: string,
  pos: string,
  opts: Partial<KToken> = {},
): KToken {
  return { surface_form: surface, pos, ...opts };
}

describe("mergeTokens — single-kanji gluing", () => {
  test("two adjacent single-kanji nouns are glued", () => {
    const raw: KToken[] = [
      tok("姉", "名詞"),
      tok("貴", "名詞"),
    ];
    const out = mergeTokens(raw);
    expect(out).toHaveLength(1);
    expect(out[0]!.surface_form).toBe("姉貴");
  });

  test("three adjacent single-kanji nouns: only first pair glues (glued result is no longer single-kanji)", () => {
    // mergeTokens glues pairs of single-kanji tokens. After 折+木→折木, the
    // accumulated surface is 2 chars and isContentKanji returns false, so 奈
    // is NOT further glued. This is the documented pairwise behaviour.
    const raw: KToken[] = [
      tok("折", "名詞"),
      tok("木", "名詞"),
      tok("奈", "名詞"),
    ];
    const out = mergeTokens(raw);
    // 折木 is one token; 奈 is separate because the accumulated token is no longer single-kanji.
    expect(out).toHaveLength(2);
    expect(out[0]!.surface_form).toBe("折木");
    expect(out[1]!.surface_form).toBe("奈");
  });

  test("multi-kanji compound is not re-glued", () => {
    // 日本語 arrives as a single token — should pass through unchanged
    const raw: KToken[] = [tok("日本語", "名詞")];
    const out = mergeTokens(raw);
    expect(out).toHaveLength(1);
    expect(out[0]!.surface_form).toBe("日本語");
  });

  test("non-noun single kanji is NOT glued with adjacent noun", () => {
    // 助詞 (particle) next to a noun — should not glue
    const raw: KToken[] = [
      tok("猫", "名詞"),
      { surface_form: "が", pos: "助詞", pos_detail_1: "格助詞" },
    ];
    const out = mergeTokens(raw);
    expect(out).toHaveLength(2);
  });
});

describe("mergeTokens — person name gluing", () => {
  test("consecutive 固有名詞/人名 tokens are glued", () => {
    const raw: KToken[] = [
      { surface_form: "折木", pos: "名詞", pos_detail_1: "固有名詞", pos_detail_2: "人名" },
      { surface_form: "奉太郎", pos: "名詞", pos_detail_1: "固有名詞", pos_detail_2: "人名" },
    ];
    const out = mergeTokens(raw);
    expect(out).toHaveLength(1);
    expect(out[0]!.surface_form).toBe("折木奉太郎");
    expect(out[0]!.pos_detail_1).toBe("固有名詞");
    expect(out[0]!.pos_detail_2).toBe("人名");
  });

  test("place noun followed by person name is NOT glued", () => {
    const raw: KToken[] = [
      { surface_form: "東京", pos: "名詞", pos_detail_1: "固有名詞", pos_detail_2: "地域" },
      { surface_form: "折木", pos: "名詞", pos_detail_1: "固有名詞", pos_detail_2: "人名" },
    ];
    const out = mergeTokens(raw);
    expect(out).toHaveLength(2);
  });
});

describe("mergeTokens — conditional ば gluing", () => {
  test("verb + ば are glued while preserving verb basic_form", () => {
    const raw: KToken[] = [
      { surface_form: "いえ", pos: "動詞", basic_form: "いう", reading: "イエ" },
      { surface_form: "ば", pos: "助詞", pos_detail_1: "接続助詞", reading: "バ" },
    ];
    const out = mergeTokens(raw);
    expect(out).toHaveLength(1);
    expect(out[0]!.surface_form).toBe("いえば");
    // basic_form should be preserved as the verb's form, NOT overwritten with surface
    expect(out[0]!.basic_form).toBe("いう");
  });

  test("non-verb + ば is NOT glued", () => {
    const raw: KToken[] = [
      { surface_form: "猫", pos: "名詞" },
      { surface_form: "ば", pos: "助詞", pos_detail_1: "接続助詞" },
    ];
    const out = mergeTokens(raw);
    expect(out).toHaveLength(2);
  });
});

describe("mergeTokens — reading concatenation", () => {
  test("readings are concatenated when both tokens have readings", () => {
    const raw: KToken[] = [
      { surface_form: "姉", pos: "名詞", reading: "アネ" },
      { surface_form: "貴", pos: "名詞", reading: "キ" },
    ];
    const out = mergeTokens(raw);
    expect(out[0]!.reading).toBe("アネキ");
  });

  test("reading becomes undefined when either token has no reading", () => {
    const raw: KToken[] = [
      { surface_form: "姉", pos: "名詞", reading: "アネ" },
      { surface_form: "貴", pos: "名詞" }, // no reading
    ];
    const out = mergeTokens(raw);
    expect(out[0]!.reading).toBeUndefined();
  });
});

describe("mergeTokens — edge cases", () => {
  test("empty input → empty output", () => {
    expect(mergeTokens([])).toEqual([]);
  });

  test("single token passes through unchanged", () => {
    const raw: KToken[] = [{ surface_form: "猫", pos: "名詞", reading: "ネコ" }];
    const out = mergeTokens(raw);
    expect(out).toHaveLength(1);
    expect(out[0]!.surface_form).toBe("猫");
  });
});
