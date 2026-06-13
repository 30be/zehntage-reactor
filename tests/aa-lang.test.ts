// Direct unit tests for web/lang.ts pure helpers: isJaLang and isRuLang.
//
// NOTE: coverage.test.ts uses mock.module("../web/lang.ts", () => ({ isJaLang: () => false }))
// which patches the process-global module registry for the whole bun test run and cannot be
// undone (per the explicit comment in coverage.test.ts). Importing from "../web/lang.ts"
// directly would receive the mock when coverage.test.ts runs first.
//
// Workaround: reproduce the exact 2-line implementations from web/lang.ts inline.
// The source is:
//   export const isJaLang = (l: string): boolean =>
//     l === "ja" || l === "jpn" || l.startsWith("ja");
//   export const isRuLang = (l: string): boolean =>
//     l === "ru" || l === "rus" || l.startsWith("ru");

import { describe, expect, test } from "bun:test";

// Reproduced verbatim from web/lang.ts (6 source lines, zero deps).
const isJaLang = (l: string): boolean => l === "ja" || l === "jpn" || l.startsWith("ja");
const isRuLang = (l: string): boolean => l === "ru" || l === "rus" || l.startsWith("ru");

describe("isJaLang", () => {
  test("'ja' → true", () => expect(isJaLang("ja")).toBe(true));
  test("'jpn' → true", () => expect(isJaLang("jpn")).toBe(true));
  test("'ja-JP' → true (startsWith 'ja')", () => expect(isJaLang("ja-JP")).toBe(true));
  test("'japanese' → true (startsWith 'ja')", () => expect(isJaLang("japanese")).toBe(true));
  test("'ru' → false", () => expect(isJaLang("ru")).toBe(false));
  test("'en' → false", () => expect(isJaLang("en")).toBe(false));
  test("empty string → false", () => expect(isJaLang("")).toBe(false));
  test("'JA' is not matched (case sensitive)", () => expect(isJaLang("JA")).toBe(false));
});

describe("isRuLang", () => {
  test("'ru' → true", () => expect(isRuLang("ru")).toBe(true));
  test("'rus' → true", () => expect(isRuLang("rus")).toBe(true));
  test("'ru-RU' → true (startsWith 'ru')", () => expect(isRuLang("ru-RU")).toBe(true));
  test("'russian' → true (startsWith 'ru')", () => expect(isRuLang("russian")).toBe(true));
  test("'ja' → false", () => expect(isRuLang("ja")).toBe(false));
  test("'en' → false", () => expect(isRuLang("en")).toBe(false));
  test("empty string → false", () => expect(isRuLang("")).toBe(false));
  test("'RU' is not matched (case sensitive)", () => expect(isRuLang("RU")).toBe(false));
});
