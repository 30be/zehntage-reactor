// Direct edge-case unit tests for web/tokenizer.ts::vocabKey (browser copy).
// Existing tests/homograph.test.ts asserts server/browser PARITY but has no
// dedicated branch coverage of the browser copy. These exercise each of
// vocabKey's three branches in isolation:
//   - inflecting POS (動詞/形容詞/助動詞): reading dropped, conjugations collapse
//   - non-inflecting noun with reading: reading discriminates homographs
//   - OOV / no-reading / missing-pos fallback to bare lemma
//
// Pure + synchronous: no kuromoji dictionary needed (KToken objects hand-built).

import { describe, expect, test } from "bun:test";
import { vocabKey, type KToken } from "../web/tokenizer.ts";

describe("vocabKey — inflecting POS drops reading", () => {
  test("動詞: conjugations of one lemma collapse to a single key", () => {
    const forms: KToken[] = [
      { surface_form: "食べた", basic_form: "食べる", pos: "動詞", reading: "タベタ" },
      { surface_form: "食べない", basic_form: "食べる", pos: "動詞", reading: "タベナイ" },
      { surface_form: "食べる", basic_form: "食べる", pos: "動詞", reading: "タベル" },
    ];
    const keys = new Set(forms.map(vocabKey));
    expect(keys.size).toBe(1);
    expect([...keys][0]).toBe("食べる|動詞");
  });

  test("動詞: key is lemma|pos, NOT lemma|reading|pos (surface reading excluded)", () => {
    const tok: KToken = { surface_form: "食べた", basic_form: "食べる", pos: "動詞", reading: "タベタ" };
    expect(vocabKey(tok)).toBe("食べる|動詞");
    expect(vocabKey(tok)).not.toContain("タベタ");
  });

  test("形容詞: conjugations collapse on lemma|pos", () => {
    const a: KToken = { surface_form: "辛かった", basic_form: "辛い", pos: "形容詞", reading: "カラカッタ" };
    const b: KToken = { surface_form: "辛い", basic_form: "辛い", pos: "形容詞", reading: "カライ" };
    expect(vocabKey(a)).toBe("辛い|形容詞");
    expect(vocabKey(a)).toBe(vocabKey(b));
  });

  test("助動詞: reading dropped", () => {
    const tok: KToken = { surface_form: "です", basic_form: "です", pos: "助動詞", reading: "デス" };
    expect(vocabKey(tok)).toBe("です|助動詞");
  });
});

describe("vocabKey — non-inflecting noun with reading discriminates homographs", () => {
  test("noun with reading: key is lemma|hira(reading)|pos", () => {
    const tok: KToken = { surface_form: "箸", basic_form: "箸", pos: "名詞", reading: "ハシ" };
    expect(vocabKey(tok)).toBe("箸|はし|名詞");
  });

  test("same surface, different reading → different keys (homograph split)", () => {
    const hashi: KToken = { surface_form: "箸", basic_form: "箸", pos: "名詞", reading: "ハシ" };
    const hasi2: KToken = { surface_form: "橋", basic_form: "橋", pos: "名詞", reading: "ハシ" };
    // different lemma, same reading → still distinct on lemma
    expect(vocabKey(hashi)).not.toBe(vocabKey(hasi2));
    // true homograph: same surface+lemma, different reading
    const nama: KToken = { surface_form: "生", basic_form: "生", pos: "名詞", reading: "ナマ" };
    const sei: KToken = { surface_form: "生", basic_form: "生", pos: "名詞", reading: "セイ" };
    expect(vocabKey(nama)).not.toBe(vocabKey(sei));
    expect(vocabKey(nama)).toBe("生|なま|名詞");
    expect(vocabKey(sei)).toBe("生|せい|名詞");
  });

  test("katakana reading is normalized to hiragana in the key", () => {
    const tok: KToken = { surface_form: "猫", basic_form: "猫", pos: "名詞", reading: "ネコ" };
    expect(vocabKey(tok)).toBe("猫|ねこ|名詞");
  });
});

describe("vocabKey — OOV / no-reading / missing-pos fallbacks", () => {
  test("non-inflecting noun without reading (OOV) → bare lemma, no pipe", () => {
    const tok: KToken = { surface_form: "ＸＹＺ", basic_form: "ＸＹＺ", pos: "名詞" };
    expect(vocabKey(tok)).toBe("ＸＹＺ");
    expect(vocabKey(tok)).not.toContain("|");
  });

  test("missing pos → bare lemma", () => {
    const tok: KToken = { surface_form: "猫", basic_form: "猫", reading: "ネコ" };
    expect(vocabKey(tok)).toBe("猫");
    expect(vocabKey(tok)).not.toContain("|");
  });

  test("empty pos string → bare lemma (falsy pos guard)", () => {
    const tok: KToken = { surface_form: "猫", basic_form: "猫", pos: "", reading: "ネコ" };
    expect(vocabKey(tok)).toBe("猫");
  });

  test("basic_form '*' falls back to surface for the lemma", () => {
    const tok: KToken = { surface_form: "hogehoge", basic_form: "*", pos: "名詞" };
    expect(vocabKey(tok)).toBe("hogehoge");
  });

  test("absent basic_form falls back to surface for the lemma", () => {
    const tok: KToken = { surface_form: "謎語", pos: "名詞", reading: "ナゾゴ" };
    expect(vocabKey(tok)).toBe("謎語|なぞご|名詞");
  });

  test("empty reading string is treated as no reading → bare lemma", () => {
    const tok: KToken = { surface_form: "猫", basic_form: "猫", pos: "名詞", reading: "" };
    expect(vocabKey(tok)).toBe("猫");
  });
});
