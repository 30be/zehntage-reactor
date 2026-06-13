import { describe, expect, test } from "bun:test";
import {
  normalizeJa,
  diffChars,
  scoreDictation,
  tooShortForEcho,
} from "../web/dictation.ts";

describe("normalizeJa", () => {
  test("strips punctuation and spaces", () => {
    expect(normalizeJa("こんにちは、 世界！")).toBe("こんにちは世界");
  });
  test("folds katakana to hiragana", () => {
    expect(normalizeJa("コンニチハ")).toBe("こんにちは");
  });
});

describe("diffChars", () => {
  test("all ok on exact match", () => {
    const d = diffChars("あいう", "あいう");
    expect(d.every((c) => c.ok)).toBe(true);
    expect(d.map((c) => c.ch).join("")).toBe("あいう");
  });
  test("marks missing chars not ok", () => {
    const d = diffChars("あいう", "あう");
    expect(d.map((c) => c.ok)).toEqual([true, false, true]);
  });
  test("ignores extra got chars", () => {
    const d = diffChars("あう", "あいう");
    expect(d.every((c) => c.ok)).toBe(true);
  });
});

describe("scoreDictation", () => {
  test("perfect score after normalization", () => {
    const s = scoreDictation("コンニチハ。", "こんにちは");
    expect(s.correct).toBe(s.total);
    expect(s.total).toBe(5);
  });
  test("partial score", () => {
    const s = scoreDictation("あいう", "あう");
    expect(s.correct).toBe(2);
    expect(s.total).toBe(3);
  });
});

describe("tooShortForEcho", () => {
  test("short interjections skipped", () => {
    expect(tooShortForEcho("あ。")).toBe(true);
    expect(tooShortForEcho("ん")).toBe(true);
  });
  test("real lines kept", () => {
    expect(tooShortForEcho("勉強する")).toBe(false);
  });
});
