// Headless tokenizer test (no Chrome). Runs real kuromoji against the bundled
// IPADIC and asserts our merge pass undoes the 姉貴 over-segmentation.
// Run: bun test scripts/tokenizer.test.ts
import { expect, test } from "bun:test";
import kuromoji from "@sglkc/kuromoji";
import { mergeTokens } from "../web/tokenizer.ts";

const DICT = new URL("../node_modules/@sglkc/kuromoji/dict/", import.meta.url)
  .pathname;

const tokenizer: { tokenize: (s: string) => any[] } = await new Promise(
  (resolve, reject) =>
    kuromoji
      .builder({ dicPath: DICT })
      .build((err: unknown, tok: any) => (err ? reject(err) : resolve(tok))),
);

function surfaces(s: string): string[] {
  return mergeTokens(tokenizer.tokenize(s)).map((t) => t.surface_form);
}

test("姉貴 stays a single token inside a sentence", () => {
  const s = surfaces("姉貴が書いた通りなんだが");
  expect(s).toContain("姉貴");
  expect(s).not.toContain("姉");
  expect(s).not.toContain("貴");
});

test("姉貴 in isolation is one token", () => {
  expect(surfaces("姉貴")).toEqual(["姉貴"]);
});

test("なんだ does not explode into single kana", () => {
  const s = surfaces("姉貴が書いた通りなんだが");
  expect(s).toContain("なん");
  // no lone な / ん kana tokens
  expect(s).not.toContain("ん");
});

test("legitimate compounds are preserved", () => {
  expect(surfaces("日本語を勉強する")).toContain("日本語");
  expect(surfaces("私は学生です")).toContain("学生");
});

test("consecutive person-name parts merge into one name token", () => {
  const merged = mergeTokens([
    { surface_form: "折木", reading: "オレキ", pos: "名詞", pos_detail_1: "固有名詞", pos_detail_2: "人名" },
    { surface_form: "奉太郎", reading: "ホウタロウ", pos: "名詞", pos_detail_1: "固有名詞", pos_detail_2: "人名" },
    { surface_form: "は", reading: "ハ", pos: "助詞", pos_detail_1: "係助詞", pos_detail_2: "*" },
  ]);
  expect(merged.map((t) => t.surface_form)).toEqual(["折木奉太郎", "は"]);
  const name = merged[0]!;
  expect(name.reading).toBe("オレキホウタロウ");
  expect(name.basic_form).toBe("折木奉太郎");
  expect(name.pos).toBe("名詞");
  expect(name.pos_detail_1).toBe("固有名詞");
  expect(name.pos_detail_2).toBe("人名");
});

test("place + person proper nouns do NOT merge", () => {
  const merged = mergeTokens([
    { surface_form: "東京", reading: "トウキョウ", pos: "名詞", pos_detail_1: "固有名詞", pos_detail_2: "地域" },
    { surface_form: "折木", reading: "オレキ", pos: "名詞", pos_detail_1: "固有名詞", pos_detail_2: "人名" },
  ]);
  expect(merged.map((t) => t.surface_form)).toEqual(["東京", "折木"]);
});

test("conditional ば attaches to its verb, lemma preserved", () => {
  const merged = mergeTokens([
    { surface_form: "いえ", reading: "イエ", pos: "動詞", pos_detail_1: "自立", pos_detail_2: "*", basic_form: "いう" },
    { surface_form: "ば", reading: "バ", pos: "助詞", pos_detail_1: "接続助詞", pos_detail_2: "*" },
  ]);
  expect(merged.map((t) => t.surface_form)).toEqual(["いえば"]);
  const v = merged[0]!;
  expect(v.surface_form).toBe("いえば");
  expect(v.reading).toBe("イエバ");
  expect(v.basic_form).toBe("いう");
});

test("standalone ば not after a verb/adjective does NOT merge", () => {
  const merged = mergeTokens([
    { surface_form: "は", reading: "ハ", pos: "助詞", pos_detail_1: "係助詞", pos_detail_2: "*" },
    { surface_form: "ば", reading: "バ", pos: "助詞", pos_detail_1: "接続助詞", pos_detail_2: "*" },
  ]);
  expect(merged.map((t) => t.surface_form)).toEqual(["は", "ば"]);
});

test("merged name with a missing-reading part drops the partial reading", () => {
  const merged = mergeTokens([
    { surface_form: "折木", reading: "オレキ", pos: "名詞", pos_detail_1: "固有名詞", pos_detail_2: "人名" },
    { surface_form: "奉太郎", pos: "名詞", pos_detail_1: "固有名詞", pos_detail_2: "人名" },
  ]);
  expect(merged.map((t) => t.surface_form)).toEqual(["折木奉太郎"]);
  expect(merged[0]!.reading).toBeUndefined();
});
