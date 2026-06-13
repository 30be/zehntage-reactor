import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import {
  editDistance,
  acceptCorrection,
  correctNames,
  buildCorrectBatchPrompt,
  stripEnumerator,
} from "../src/lib/gemini.ts";
import { loadGlossary, DEFAULT_GLOSSARY } from "../src/lib/glossary.ts";
import type { Cue } from "../src/lib/subs.ts";

describe("editDistance", () => {
  test("identical strings = 0", () => {
    expect(editDistance("折木", "折木")).toBe(0);
  });
  test("one substitution", () => {
    expect(editDistance("折木", "析木")).toBe(1);
  });
  test("empty vs string", () => {
    expect(editDistance("", "abc")).toBe(3);
  });
  test("surrogate-pair char counts as one edit", () => {
    // U+1F600 GRINNING FACE is a supplementary-plane char encoded as a
    // surrogate pair in UTF-16 (.length === 2 in JS). It must count as a
    // single code point, so the distance between "𩸽" and "𩸽a" should be 1.
    const fish = "\u{29E3D}"; // CJK supplementary ideograph, surrogate pair
    expect(editDistance(fish, fish + "a")).toBe(1);
    expect(editDistance(fish + fish, fish)).toBe(1);
    // If we accidentally counted code units, editDistance("𩸽","𩸽a") would
    // still be 1 but editDistance("𩸽𩸽","𩸽") would be 2 (wrong).
  });
});

describe("acceptCorrection safety guard", () => {
  test("unchanged line accepted", () => {
    expect(acceptCorrection("こんにちは", "こんにちは")).toBe(true);
  });
  test("small name fix accepted", () => {
    const orig = "おれき先輩、それは違います";
    const fixed = "折木先輩、それは違います";
    expect(acceptCorrection(orig, fixed)).toBe(true);
  });
  test("wholesale rewrite rejected", () => {
    const orig = "おれきほうたろうです";
    const rewrite = "全く別の長い文章になってしまった例";
    expect(acceptCorrection(orig, rewrite)).toBe(false);
  });
  test("empty correction rejected", () => {
    expect(acceptCorrection("テスト", "")).toBe(false);
  });
});

describe("correctNames fake mode", () => {
  let prev: string | undefined;
  beforeAll(() => {
    prev = process.env.GEMINI_FAKE;
    process.env.GEMINI_FAKE = "1";
  });
  afterAll(() => {
    if (prev === undefined) delete process.env.GEMINI_FAKE;
    else process.env.GEMINI_FAKE = prev;
  });
  test("returns cues unchanged", async () => {
    const cues: Cue[] = [
      { start: 0, end: 1, text: "おれき" },
      { start: 1, end: 2, text: "ちたんだ" },
    ];
    const out = await correctNames(cues, DEFAULT_GLOSSARY);
    expect(out).toEqual(cues);
  });
});

describe("stripEnumerator leaked-prefix guard", () => {
  test("strips matching expected number (3. for line index 2)", () => {
    // line 3 is index 2; model echoed "3. " back into the text
    expect(stripEnumerator("3. 折木奉太郎", 2)).toBe("折木奉太郎");
  });
  test("strips with closing paren and surrounding spaces", () => {
    expect(stripEnumerator("  4) 古典部 ", 3)).toBe("古典部 ");
  });
  test("does NOT strip a non-matching leading number", () => {
    // line index 2 expects "3."; a legit "99." must be left untouched
    expect(stripEnumerator("99. 折木奉太郎さんですよね", 2)).toBe(
      "99. 折木奉太郎さんですよね",
    );
  });
  test("leaves text without enumerator untouched", () => {
    expect(stripEnumerator("折木奉太郎", 2)).toBe("折木奉太郎");
  });
  test("prefix equal to index works at index 0 (line 1)", () => {
    expect(stripEnumerator("1. こんにちは", 0)).toBe("こんにちは");
  });
});

describe("buildCorrectBatchPrompt", () => {
  test("includes glossary and numbered lines", () => {
    const p = buildCorrectBatchPrompt(["a", "b"], ["折木奉太郎", "古典部"]);
    expect(p).toContain("折木奉太郎");
    expect(p).toContain("1. a");
    expect(p).toContain("2. b");
    expect(p).toContain("EXACTLY 2");
  });
});

describe("loadGlossary", () => {
  test("default only when no names.txt", () => {
    const g = loadGlossary("/nonexistent-dir-xyz");
    expect(g).toEqual([...new Set(DEFAULT_GLOSSARY)]);
    expect(g).toContain("折木奉太郎");
  });
});
