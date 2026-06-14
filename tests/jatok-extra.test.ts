// Wave-13 extra coverage for src/lib/jatok.ts :: mergeTokens
// Coverage gap items #12 (OOV reading nullification, attachConditionalBa lemma).
//
// These tests feed pre-built kuromoji-shaped tokens directly to mergeTokens,
// so no dictionary is required — they exercise the pure gluing logic.

import { describe, expect, test } from "bun:test";
import { mergeTokens, type KToken } from "../src/lib/jatok.ts";

// A pair of adjacent single-kanji content nouns triggers the glueKanji rule.
function kanji(surface: string, reading?: string): KToken {
  return { surface_form: surface, reading, pos: "名詞" };
}

describe("mergeTokens — OOV reading nullification on merge", () => {
  test("known kanji + OOV kanji (reading undefined) → merged reading undefined", () => {
    const [a, b] = [kanji("姉", "アネ"), kanji("貴" /* no reading: OOV */)];
    const out = mergeTokens([a, b]);
    expect(out).toHaveLength(1);
    expect(out[0]!.surface_form).toBe("姉貴");
    expect(out[0]!.reading).toBeUndefined();
  });

  test("OOV kanji (reading undefined) + known kanji → merged reading undefined", () => {
    const out = mergeTokens([kanji("姉" /* OOV */), kanji("貴", "キ")]);
    expect(out).toHaveLength(1);
    expect(out[0]!.surface_form).toBe("姉貴");
    expect(out[0]!.reading).toBeUndefined();
  });

  test("two OOV kanji → merged reading still undefined", () => {
    const out = mergeTokens([kanji("姉"), kanji("貴")]);
    expect(out).toHaveLength(1);
    expect(out[0]!.reading).toBeUndefined();
  });

  test("contrast: two kanji both with readings → concatenated reading", () => {
    const out = mergeTokens([kanji("姉", "アネ"), kanji("貴", "キ")]);
    expect(out).toHaveLength(1);
    expect(out[0]!.surface_form).toBe("姉貴");
    expect(out[0]!.reading).toBe("アネキ");
  });

  test("null reading (not just undefined) on either side nullifies", () => {
    // kuromoji can emit reading as the JS value null on some OOV tokens.
    const a = { surface_form: "姉", reading: "アネ", pos: "名詞" } as KToken;
    const b = { surface_form: "貴", reading: null as unknown as string, pos: "名詞" } as KToken;
    const out = mergeTokens([a, b]);
    expect(out).toHaveLength(1);
    expect(out[0]!.reading).toBeUndefined();
  });
});

describe("mergeTokens — attachConditionalBa keeps verb basic_form", () => {
  test("いえ + ば glues surface to いえば but basic_form stays いう", () => {
    const verb: KToken = {
      surface_form: "いえ",
      reading: "イエ",
      pos: "動詞",
      basic_form: "いう",
    };
    const ba: KToken = {
      surface_form: "ば",
      reading: "バ",
      pos: "助詞",
      pos_detail_1: "接続助詞",
    };
    const out = mergeTokens([verb, ba]);
    expect(out).toHaveLength(1);
    expect(out[0]!.surface_form).toBe("いえば");
    // The crucial assertion: basic_form is NOT clobbered to the surface いえば.
    expect(out[0]!.basic_form).toBe("いう");
  });

  test("adjective + ば also preserves basic_form (e.g. 良けれ+ば)", () => {
    const adj: KToken = {
      surface_form: "良けれ",
      reading: "ヨケレ",
      pos: "形容詞",
      basic_form: "良い",
    };
    const ba: KToken = {
      surface_form: "ば",
      pos: "助詞",
      pos_detail_1: "接続助詞",
      reading: "バ",
    };
    const out = mergeTokens([adj, ba]);
    expect(out).toHaveLength(1);
    expect(out[0]!.surface_form).toBe("良ければ");
    expect(out[0]!.basic_form).toBe("良い");
  });

  test("contrast: glueKanji DOES overwrite basic_form with surface", () => {
    // For non-ba merges the comment says basic_form := surface; pin that.
    const out = mergeTokens([
      { surface_form: "姉", reading: "アネ", pos: "名詞", basic_form: "姉" },
      { surface_form: "貴", reading: "キ", pos: "名詞", basic_form: "貴" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.basic_form).toBe("姉貴");
  });

  test("ば does not glue after a non-verb/adj (e.g. noun) — left separate", () => {
    const noun: KToken = { surface_form: "猫", pos: "名詞", basic_form: "猫" };
    const ba: KToken = {
      surface_form: "ば",
      pos: "助詞",
      pos_detail_1: "接続助詞",
    };
    const out = mergeTokens([noun, ba]);
    expect(out).toHaveLength(2);
  });
});
