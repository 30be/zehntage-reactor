import { expect, test, describe } from "bun:test";
import { buildWordPrompt, DEFAULT_LOOKUP_PROMPT, assertTranslationCount } from "../src/lib/gemini.ts";

describe("buildWordPrompt template substitution", () => {
  test("uses built-in default when no template given", () => {
    const p = buildWordPrompt("図書館", "彼は図書館にいる", "Hyouka E1");
    expect(p).toContain("native Russian speaker");
    expect(p).toContain("図書館"); // word substituted
    expect(p).toContain("彼は図書館にいる"); // context substituted
    expect(p).toContain("Hyouka E1"); // source substituted
    expect(p).not.toContain("{word}");
    expect(p).not.toContain("{context}");
    expect(p).not.toContain("{source}");
  });

  test("uses built-in default when template is empty/whitespace", () => {
    const fromDefault = buildWordPrompt("x", "y", "z");
    expect(buildWordPrompt("x", "y", "z", "")).toBe(fromDefault);
    expect(buildWordPrompt("x", "y", "z", "   ")).toBe(fromDefault);
  });

  test("uses custom template and substitutes all placeholders", () => {
    const tpl = "W={word} | C={context} | S={source} | {word}";
    expect(buildWordPrompt("猫", "黒い猫", "src")).not.toContain("W=");
    expect(buildWordPrompt("猫", "黒い猫", "src", tpl)).toBe(
      "W=猫 | C=黒い猫 | S=src | 猫",
    );
  });

  test("DEFAULT_LOOKUP_PROMPT is exported with placeholders", () => {
    expect(DEFAULT_LOOKUP_PROMPT).toContain("{word}");
    expect(DEFAULT_LOOKUP_PROMPT).toContain("{context}");
    expect(DEFAULT_LOOKUP_PROMPT).toContain("{source}");
  });
});

describe("assertTranslationCount", () => {
  test("exact match does not throw", () => {
    expect(() => assertTranslationCount(["a", "b", "c"], 3)).not.toThrow();
  });

  test("too few translations throws with clear message", () => {
    expect(() => assertTranslationCount(["a", "b"], 3)).toThrow(
      "Gemini returned 2 translations for 3 cues",
    );
  });

  test("too many translations throws with clear message", () => {
    expect(() => assertTranslationCount(["a", "b", "c", "d"], 3)).toThrow(
      "Gemini returned 4 translations for 3 cues",
    );
  });

  test("empty array for non-zero expected throws", () => {
    expect(() => assertTranslationCount([], 1)).toThrow(
      "Gemini returned 0 translations for 1 cues",
    );
  });
});
