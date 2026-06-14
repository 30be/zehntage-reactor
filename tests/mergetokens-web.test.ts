// Stub-token tests for web/tokenizer.ts::mergeTokens (BROWSER copy).
// The server copy (src/lib/jatok.ts) is covered by tests/jatok.test.ts; the
// browser copy is otherwise only exercised end-to-end through the real kuromoji
// tokenizer. These mirror the server cases so any future divergence between
// web/tokenizer.ts and src/lib/jatok.ts is caught.
//
// Pure + synchronous: no dictionary needed.

import { describe, expect, test } from "bun:test";
import { mergeTokens, type KToken } from "../web/tokenizer.ts";

function tok(surface: string, pos: string, opts: Partial<KToken> = {}): KToken {
  return { surface_form: surface, pos, ...opts };
}

describe("mergeTokens (web) — single-kanji gluing", () => {
  test("two adjacent single-kanji nouns are glued", () => {
    const out = mergeTokens([tok("姉", "名詞"), tok("貴", "名詞")]);
    expect(out).toHaveLength(1);
    expect(out[0]!.surface_form).toBe("姉貴");
    expect(out[0]!.pos).toBe("名詞");
  });

  test("multi-kanji compound passes through unchanged", () => {
    const out = mergeTokens([tok("日本語", "名詞")]);
    expect(out).toHaveLength(1);
    expect(out[0]!.surface_form).toBe("日本語");
  });

  test("noun + particle not glued", () => {
    const out = mergeTokens([
      tok("猫", "名詞"),
      { surface_form: "が", pos: "助詞", pos_detail_1: "格助詞" },
    ]);
    expect(out).toHaveLength(2);
  });
});

describe("mergeTokens (web) — dependent kana attachment", () => {
  test("single-kana dependent noun glues onto all-kana preceding token", () => {
    const out = mergeTokens([
      { surface_form: "な", pos: "名詞" },
      { surface_form: "ん", pos: "名詞", pos_detail_1: "非自立" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.surface_form).toBe("なん");
  });
});

describe("mergeTokens (web) — person-name gluing", () => {
  test("consecutive 固有名詞/人名 tokens are glued and tagged", () => {
    const out = mergeTokens([
      { surface_form: "折木", pos: "名詞", pos_detail_1: "固有名詞", pos_detail_2: "人名" },
      { surface_form: "奉太郎", pos: "名詞", pos_detail_1: "固有名詞", pos_detail_2: "人名" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.surface_form).toBe("折木奉太郎");
    expect(out[0]!.pos_detail_1).toBe("固有名詞");
    expect(out[0]!.pos_detail_2).toBe("人名");
  });

  test("place + person name is NOT glued", () => {
    const out = mergeTokens([
      { surface_form: "東京", pos: "名詞", pos_detail_1: "固有名詞", pos_detail_2: "地域" },
      { surface_form: "折木", pos: "名詞", pos_detail_1: "固有名詞", pos_detail_2: "人名" },
    ]);
    expect(out).toHaveLength(2);
  });
});

describe("mergeTokens (web) — conditional ば gluing preserves basic_form", () => {
  test("verb + ば glued; verb lemma kept (not clobbered by surface)", () => {
    const out = mergeTokens([
      { surface_form: "いえ", pos: "動詞", basic_form: "いう", reading: "イエ" },
      { surface_form: "ば", pos: "助詞", pos_detail_1: "接続助詞", reading: "バ" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.surface_form).toBe("いえば");
    expect(out[0]!.basic_form).toBe("いう");
  });

  test("noun + ば is NOT glued", () => {
    const out = mergeTokens([
      { surface_form: "猫", pos: "名詞" },
      { surface_form: "ば", pos: "助詞", pos_detail_1: "接続助詞" },
    ]);
    expect(out).toHaveLength(2);
  });
});

describe("mergeTokens (web) — reading concatenation + edges", () => {
  test("readings concatenated when both present", () => {
    const out = mergeTokens([
      { surface_form: "姉", pos: "名詞", reading: "アネ" },
      { surface_form: "貴", pos: "名詞", reading: "キ" },
    ]);
    expect(out[0]!.reading).toBe("アネキ");
  });

  test("reading undefined when either part lacks a reading", () => {
    const out = mergeTokens([
      { surface_form: "姉", pos: "名詞", reading: "アネ" },
      { surface_form: "貴", pos: "名詞" },
    ]);
    expect(out[0]!.reading).toBeUndefined();
  });

  test("empty input → empty output", () => {
    expect(mergeTokens([])).toEqual([]);
  });

  test("single token passes through", () => {
    const out = mergeTokens([{ surface_form: "猫", pos: "名詞", reading: "ネコ" }]);
    expect(out).toHaveLength(1);
    expect(out[0]!.surface_form).toBe("猫");
  });
});
