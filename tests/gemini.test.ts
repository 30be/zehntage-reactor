import { expect, test, describe } from "bun:test";
import {
  buildWordPrompt,
  DEFAULT_LOOKUP_PROMPT,
  assertTranslationCount,
  stripEnumerator,
  editDistance,
  acceptCorrection,
  sanitizeCueLine,
  buildTranslateBatchPrompt,
  buildCorrectBatchPrompt,
  translateCues,
} from "../src/lib/gemini.ts";
import type { Cue } from "../src/lib/subs.ts";

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

describe("DEFAULT_LOOKUP_PROMPT quality instructions + contract", () => {
  // OUTPUT CONTRACT: the four schema fields the client parses must stay named.
  test("declares all four output fields the schema requires", () => {
    expect(DEFAULT_LOOKUP_PROMPT).toContain("reading:");
    expect(DEFAULT_LOOKUP_PROMPT).toContain("translation:");
    expect(DEFAULT_LOOKUP_PROMPT).toContain("notes:");
    expect(DEFAULT_LOOKUP_PROMPT).toContain("context:");
  });

  test("asks for the meaning AS USED, not an exhaustive dump", () => {
    expect(DEFAULT_LOOKUP_PROMPT).toContain("AS USED HERE");
    expect(DEFAULT_LOOKUP_PROMPT).toMatch(/exhaustive/i);
  });

  test("requests a natural Russian gloss, dictionary base form", () => {
    expect(DEFAULT_LOOKUP_PROMPT).toContain("natural Russian gloss");
    expect(DEFAULT_LOOKUP_PROMPT).toContain("dictionary base form");
  });

  test("embeds the shared Hyouka name glossary for consistent names", () => {
    expect(DEFAULT_LOOKUP_PROMPT).toContain("Ореки Хотаро");
    expect(DEFAULT_LOOKUP_PROMPT).toContain("Читанда Эру");
    expect(DEFAULT_LOOKUP_PROMPT).toContain("Polivanov");
  });

  test("still keeps reading as kana and the <b> context-sentence rule", () => {
    expect(DEFAULT_LOOKUP_PROMPT).toContain("base) form in kana");
    expect(DEFAULT_LOOKUP_PROMPT).toContain("<b></b>");
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

describe("stripEnumerator", () => {
  test("strips '1.' prefix for index 0", () => {
    expect(stripEnumerator("1. こんにちは", 0)).toBe("こんにちは");
  });

  test("strips '2)' prefix for index 1", () => {
    expect(stripEnumerator("2) hello", 1)).toBe("hello");
  });

  test("does not strip when number does not match index+1", () => {
    // index=0 → looks for '1.' but line starts with '2.'
    expect(stripEnumerator("2. wrong", 0)).toBe("2. wrong");
  });

  test("strips with leading whitespace before number", () => {
    expect(stripEnumerator("  3. text", 2)).toBe("text");
  });

  test("no enumerator → returns line unchanged", () => {
    expect(stripEnumerator("普通の行です", 0)).toBe("普通の行です");
  });

  test("strips enumerator from line at large index", () => {
    expect(stripEnumerator("10. tenth line", 9)).toBe("tenth line");
  });

  test("empty line returns empty string", () => {
    expect(stripEnumerator("", 0)).toBe("");
  });
});

describe("editDistance", () => {
  test("identical strings have distance 0", () => {
    expect(editDistance("abc", "abc")).toBe(0);
  });

  test("empty strings have distance 0", () => {
    expect(editDistance("", "")).toBe(0);
  });

  test("empty vs non-empty is length of non-empty", () => {
    expect(editDistance("", "abc")).toBe(3);
    expect(editDistance("abc", "")).toBe(3);
  });

  test("single substitution", () => {
    expect(editDistance("cat", "bat")).toBe(1);
  });

  test("single insertion", () => {
    expect(editDistance("cat", "cats")).toBe(1);
  });

  test("single deletion", () => {
    expect(editDistance("cats", "cat")).toBe(1);
  });

  test("completely different strings", () => {
    expect(editDistance("abc", "xyz")).toBe(3);
  });

  test("handles surrogate pairs as single code points", () => {
    // 𩸽 is a surrogate pair (U+29E3D). editDistance uses [...s] to iterate
    // code points, so 𩸽 counts as one character, not two surrogates.
    const fish = "𩸽"; // 1 code point
    expect(editDistance(fish, fish)).toBe(0);
    expect(editDistance(fish, "")).toBe(1);
    expect(editDistance("", fish)).toBe(1);
  });

  test("Japanese kana strings", () => {
    expect(editDistance("こんにちは", "こんにちわ")).toBe(1);
  });
});

describe("acceptCorrection", () => {
  test("identical original and corrected → accepted", () => {
    expect(acceptCorrection("hello", "hello")).toBe(true);
  });

  test("empty corrected → rejected", () => {
    expect(acceptCorrection("hello", "")).toBe(false);
    expect(acceptCorrection("hello", "   ")).toBe(false);
  });

  test("1-char fix on 5-char string → accepted (dist=1 ≤ limit=1)", () => {
    // len=5 ≤ 6 → limit=1; dist=1 → accept
    expect(acceptCorrection("oreki", "0reki")).toBe(true);
  });

  test("2-char rewrite on 5-char string → rejected (dist=2 > limit=1)", () => {
    // len=5 ≤ 6 → limit=1; dist=2 → reject (previously allowed under old 40% rule)
    expect(acceptCorrection("oreki", "00eki")).toBe(false);
  });

  test("change exceeding budget on longer line → rejected", () => {
    // len=5, but use a string that exceeds even the old budget to keep test valid
    // 5-char original, limit=1; replace 3 chars → dist=3 > 1 → reject
    expect(acceptCorrection("abcde", "xyzde")).toBe(false);
  });

  test("short line (1 char): budget = max(1,0) = 1, so 1-char change accepted", () => {
    // budget = max(1, floor(1*0.4)) = max(1,0) = 1; dist=1 → accept
    expect(acceptCorrection("a", "b")).toBe(true);
  });

  test("large change on long line is rejected", () => {
    const original = "彼女の名前はえるです"; // 9 code points
    // budget = floor(9 * 0.4) = 3; completely different string → dist >> 3 → reject
    expect(acceptCorrection(original, "全然違う文章ですよ!")).toBe(false);
  });

  test("surrogate pair characters count as 1 in budget calculation", () => {
    // 𩸽 = 1 code point; original = "𩸽abc" (4 code points), len=4 ≤ 6 → limit=1
    // 1-char sub → dist=1 ≤ 1 → accept
    const orig = "𩸽abc";
    const corr = "𩸽abx";
    expect(acceptCorrection(orig, corr)).toBe(true);
  });
});

describe("sanitizeCueLine (ASS multiline cues → one wire line)", () => {
  test("collapses literal ASS hard-break \\N marker to a space", () => {
    expect(sanitizeCueLine("first\\Nsecond")).toBe("first second");
  });

  test("collapses literal ASS \\n marker to a space", () => {
    expect(sanitizeCueLine("first\\nsecond")).toBe("first second");
  });

  test("collapses real newlines (\\n \\r \\r\\n) to a space", () => {
    expect(sanitizeCueLine("a\nb\rc\r\nd")).toBe("a b c d");
  });

  test("collapses runs of whitespace and trims", () => {
    expect(sanitizeCueLine("  a   b  ")).toBe("a b");
  });

  test("single-line text is unchanged (srt cues stay intact)", () => {
    expect(sanitizeCueLine("just one line")).toBe("just one line");
  });
});

describe("batch prompts: each cue is exactly ONE physical line", () => {
  test("translate prompt: multiline cue does not add extra numbered lines", () => {
    const lines = ["plain one", "two\\Nwith\\Nbreaks", "three\nreal\nnewline"];
    const prompt = buildTranslateBatchPrompt(lines, "ru");
    // The numbered region must have exactly 3 numbered lines.
    const numbered = prompt.split("\n").filter((l) => /^\d+\.\s/.test(l));
    expect(numbered).toHaveLength(3);
    expect(numbered[1]).toBe("2. two with breaks");
    expect(numbered[2]).toBe("3. three real newline");
  });

  test("correct prompt: multiline cue does not add extra numbered lines", () => {
    const lines = ["a", "b\\Nb2", "c\nc2"];
    const prompt = buildCorrectBatchPrompt(lines, ["折木"]);
    const numbered = prompt.split("\n").filter((l) => /^\d+\.\s/.test(l));
    expect(numbered).toHaveLength(3);
  });
});

describe("translate prompt: quality instructions + Hyouka glossary", () => {
  test("ru target includes natural-translation + honorific guidance", () => {
    const p = buildTranslateBatchPrompt(["一", "二"], "ru");
    expect(p).toContain("natural, fluent, idiomatic");
    expect(p).toContain("register and tone");
    expect(p).toMatch(/honorific/i);
    expect(p).toContain("-san");
  });

  test("ru target embeds the Hyouka name glossary and Polivanov rule", () => {
    const p = buildTranslateBatchPrompt(["一"], "ru");
    expect(p).toContain("Ореки Хотаро");
    expect(p).toContain("Читанда Эру");
    expect(p).toContain("Фукубэ Сатоси");
    expect(p).toContain("Ибара Маяка");
    expect(p).toContain("клуб классической литературы");
    expect(p).toContain("старшая школа Камияма");
    expect(p).toMatch(/Polivanov/i);
  });

  test("non-ru target keeps generic natural-translation, no glossary", () => {
    const p = buildTranslateBatchPrompt(["一"], "en");
    expect(p).toContain("natural, fluent, idiomatic");
    expect(p).not.toContain("Ореки Хотаро");
    expect(p).not.toContain("Hyouka");
  });

  test("line-count contract unchanged: N cues → N numbered lines (ru & en)", () => {
    const lines = ["a", "b", "c", "d", "e"];
    for (const lang of ["ru", "en", "de"]) {
      const p = buildTranslateBatchPrompt(lines, lang);
      const numbered = p.split("\n").filter((l) => /^\d+\.\s/.test(l));
      expect(numbered).toHaveLength(lines.length);
      expect(p).toContain(`Return exactly ${lines.length} translations`);
    }
  });
});

describe("translateCues (GEMINI_FAKE) with multiline cues", () => {
  test("a multiline cue still yields exactly N outputs, timings preserved", async () => {
    const prev = process.env.GEMINI_FAKE;
    process.env.GEMINI_FAKE = "1";
    try {
      const cues: Cue[] = [
        { start: 0, end: 1, text: "hello" },
        { start: 1, end: 2, text: "multi\\Nline\\Ncue" },
        { start: 2, end: 3, text: "real\nnewline\ncue" },
      ];
      const out = await translateCues(cues, "ru");
      expect(out).toHaveLength(3);
      expect(out[0]!.start).toBe(0);
      expect(out[2]!.end).toBe(3);
    } finally {
      if (prev === undefined) delete process.env.GEMINI_FAKE;
      else process.env.GEMINI_FAKE = prev;
    }
  });
});
