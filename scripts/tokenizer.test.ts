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
