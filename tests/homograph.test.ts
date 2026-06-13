// Homograph-aware vocabKey: words written the same but meaning different
// things (生 なま/せい, は wa/ha, 入る はいる/いる) must get DIFFERENT keys and
// be tracked separately, while a verb's conjugations collapse to ONE key.
//
// vocabKey is mirrored byte-identically in src/lib/jatok.ts (server) and
// web/tokenizer.ts (browser); these tests assert both copies agree.

import { describe, expect, test } from "bun:test";
import { vocabKey as serverVocabKey, type KToken } from "../src/lib/jatok.ts";
import { vocabKey as browserVocabKey } from "../web/tokenizer.ts";

// Reading is katakana in IPADIC; vocabKey normalizes katakana→hiragana.
const NAMA: KToken = { surface_form: "生", reading: "ナマ", pos: "名詞", basic_form: "生" };
const SEI: KToken = { surface_form: "生", reading: "セイ", pos: "名詞", basic_form: "生" };
const KATA: KToken = { surface_form: "方", reading: "カタ", pos: "名詞", basic_form: "方" };
const HOU: KToken = { surface_form: "方", reading: "ホウ", pos: "名詞", basic_form: "方" };
// は: same surface AND same reading — only POS distinguishes (助詞 vs 動詞).
const HA_PARTICLE: KToken = { surface_form: "は", reading: "ハ", pos: "助詞", basic_form: "は" };
const HA_VERB: KToken = { surface_form: "は", reading: "ハ", pos: "動詞", basic_form: "は" };

describe("vocabKey — homographs get DIFFERENT keys", () => {
  test("生 なま vs 生 せい (different reading, same POS) → 2 keys", () => {
    expect(serverVocabKey(NAMA)).not.toBe(serverVocabKey(SEI));
    expect(serverVocabKey(NAMA)).toBe("生|なま|名詞");
    expect(serverVocabKey(SEI)).toBe("生|せい|名詞");
  });

  test("方 かた vs 方 ほう → 2 keys", () => {
    expect(serverVocabKey(KATA)).not.toBe(serverVocabKey(HOU));
  });

  test("は 助詞 vs は 動詞 (reading equal, POS differs) → 2 keys", () => {
    expect(serverVocabKey(HA_PARTICLE)).not.toBe(serverVocabKey(HA_VERB));
    expect(serverVocabKey(HA_PARTICLE)).toBe("は|は|助詞");
    expect(serverVocabKey(HA_VERB)).toBe("は|動詞"); // 動詞 inflects → reading dropped
  });

  test("browser known-set (vocabKey) tracks homographs separately", () => {
    // The known-set / blacklist / coverage universe keys tokens by browserVocabKey,
    // so marking 生(なま) known leaves 生(せい) unknown.
    const known = new Set<string>([browserVocabKey(NAMA)]);
    expect(known.has(browserVocabKey(NAMA))).toBe(true);
    expect(known.has(browserVocabKey(SEI))).toBe(false);
  });
});

describe("vocabKey — verb conjugations COLLAPSE to one key", () => {
  const taberu: KToken = { surface_form: "食べる", reading: "タベル", pos: "動詞", basic_form: "食べる" };
  const tabeta: KToken = { surface_form: "食べた", reading: "タベタ", pos: "動詞", basic_form: "食べる" };
  const tabenai: KToken = { surface_form: "食べない", reading: "タベナイ", pos: "動詞", basic_form: "食べる" };

  test("食べる / 食べた / 食べない → SAME vocabKey", () => {
    const k = serverVocabKey(taberu);
    expect(serverVocabKey(tabeta)).toBe(k);
    expect(serverVocabKey(tabenai)).toBe(k);
    expect(k).toBe("食べる|動詞"); // reading dropped for inflecting POS
  });

  test("i-adjective conjugations collapse (辛い / 辛かった)", () => {
    const a1: KToken = { surface_form: "辛い", reading: "カライ", pos: "形容詞", basic_form: "辛い" };
    const a2: KToken = { surface_form: "辛かった", reading: "カラカッタ", pos: "形容詞", basic_form: "辛い" };
    expect(serverVocabKey(a1)).toBe(serverVocabKey(a2));
  });

  test("conjugation family collapses to a single distinct key", () => {
    const keys = new Set([taberu, tabeta, tabenai].map(serverVocabKey));
    expect(keys.size).toBe(1);
  });
});

describe("vocabKey — server and browser copies are IDENTICAL", () => {
  const cases: KToken[] = [
    NAMA, SEI, KATA, HOU, HA_PARTICLE, HA_VERB,
    { surface_form: "食べた", reading: "タベタ", pos: "動詞", basic_form: "食べる" },
    { surface_form: "猫", reading: "ネコ", pos: "名詞", basic_form: "猫" },
    { surface_form: "辛い", reading: "ツライ", pos: "形容詞", basic_form: "辛い" },
  ];
  test("same token → same key in both copies", () => {
    for (const t of cases) {
      expect(browserVocabKey(t)).toBe(serverVocabKey(t));
    }
  });
});

describe("vocabKey — fallback chain (never crash, never over-split)", () => {
  test("reading missing, non-inflecting pos → bare lemma (no over-split)", () => {
    const oov: KToken = { surface_form: "ほげ", pos: "名詞", basic_form: "ほげ" };
    expect(serverVocabKey(oov)).toBe("ほげ");
    expect(browserVocabKey(oov)).toBe("ほげ");
  });

  test("reading missing, inflecting pos → lemma|pos (conjugation collapse)", () => {
    const v: KToken = { surface_form: "食べる", pos: "動詞", basic_form: "食べる" };
    expect(serverVocabKey(v)).toBe("食べる|動詞");
    expect(browserVocabKey(v)).toBe("食べる|動詞");
  });

  test("no pos → bare lemma", () => {
    const t: KToken = { surface_form: "ほげ", reading: "ホゲ" };
    expect(serverVocabKey(t)).toBe("ほげ");
    expect(browserVocabKey(t)).toBe("ほげ");
  });

  test("basic_form '*' falls back to surface, no crash", () => {
    const t: KToken = { surface_form: "ふが", basic_form: "*", pos: "名詞", reading: "フガ" };
    expect(serverVocabKey(t)).toBe("ふが|ふが|名詞");
    expect(browserVocabKey(t)).toBe("ふが|ふが|名詞");
  });

  test("missing surface trimmed gracefully — never throws", () => {
    const t: KToken = { surface_form: "x" };
    expect(() => serverVocabKey(t)).not.toThrow();
    expect(serverVocabKey(t)).toBe(browserVocabKey(t));
  });
});
