import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { accentOf, accentPattern, kataToHira, morae } from "../web/accent.ts";

const ACCENTS = join(import.meta.dir, "..", "public", "accents.json");
const file = Bun.file(ACCENTS);
const haveData = await file.exists();
const accents: Map<string, number> = haveData
  ? new Map(Object.entries((await file.json()) as Record<string, number>))
  : new Map();

describe("accentOf (generated accents.json)", () => {
  it.skipIf(!haveData)("箸 vs 橋 (はし): 1 vs 2", () => {
    expect(accentOf(accents, "箸", "ハシ")).toBe(1);
    expect(accentOf(accents, "橋", "はし")).toBe(2);
  });

  it.skipIf(!haveData)("雨 vs 飴 (あめ): 1 vs 0", () => {
    expect(accentOf(accents, "雨", "アメ")).toBe(1);
    expect(accentOf(accents, "飴", "あめ")).toBe(0);
  });

  it.skipIf(!haveData)("dictForm fallback with dict reading: 食べる", () => {
    expect(accentOf(accents, "食べた", "たべる", "食べる")).toBe(2);
  });

  it.skipIf(!haveData)("unknown word → null", () => {
    expect(accentOf(accents, "存在しない単語XYZ", "そんざい")).toBeNull();
  });
});

describe("kataToHira", () => {
  it("converts katakana, keeps ー and hiragana", () => {
    expect(kataToHira("トーキョー")).toBe("とーきょー");
    expect(kataToHira("たべル")).toBe("たべる");
  });
});

describe("morae", () => {
  it("small kana joins previous; っ/ん/ー are own morae", () => {
    expect(morae("きょう")).toEqual(["きょ", "う"]);
    expect(morae("がっこう")).toEqual(["が", "っ", "こ", "う"]);
    expect(morae("にっぽん")).toEqual(["に", "っ", "ぽ", "ん"]);
    expect(morae("とーきょー")).toEqual(["と", "ー", "きょ", "ー"]);
  });
});

describe("accentPattern", () => {
  it("heiban (0): L then all high", () => {
    expect(accentPattern("さかな", 0)).toEqual([false, true, true]);
  });
  it("atamadaka (1): H then all low", () => {
    expect(accentPattern("あめ", 1)).toEqual([true, false]);
  });
  it("nakadaka (2): はし(橋) L H — drop after final mora (odaka)", () => {
    expect(accentPattern("はし", 2)).toEqual([false, true]);
  });
  it("nakadaka (3) on 5 morae", () => {
    expect(accentPattern("ひこうじょう", 3)).toEqual([false, true, true, false, false]);
  });
  it("counts morae, not chars: きょう accent 1", () => {
    expect(accentPattern("きょう", 1)).toEqual([true, false]);
  });
});
