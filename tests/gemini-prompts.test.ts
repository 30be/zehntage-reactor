// Unit tests for exported pure helpers in src/lib/gemini.ts that are NOT
// covered by the existing gemini.test.ts (buildExplainPrompt, buildAskPrompt,
// languageName, TranslationCountError class identity).
//
// No network, no filesystem, fully deterministic.

import { describe, expect, test } from "bun:test";
import {
  buildExplainPrompt,
  buildAskPrompt,
  DEFAULT_EXPLAIN_PROMPT,
  TranslationCountError,
  languageName,
} from "../src/lib/gemini.ts";

// ---------------------------------------------------------------------------
// languageName — the gemini.ts version (separate from subs.ts)
// ---------------------------------------------------------------------------

describe("languageName (gemini.ts)", () => {
  test("ru → Russian", () => {
    expect(languageName("ru")).toBe("Russian");
  });

  test("de → German", () => {
    expect(languageName("de")).toBe("German");
  });

  test("en → English", () => {
    expect(languageName("en")).toBe("English");
  });

  test("ja → Japanese", () => {
    expect(languageName("ja")).toBe("Japanese");
  });

  test("case-insensitive lookup", () => {
    expect(languageName("RU")).toBe("Russian");
    expect(languageName("JA")).toBe("Japanese");
  });

  test("unknown code is returned as-is", () => {
    expect(languageName("fr")).toBe("fr");
    expect(languageName("zh")).toBe("zh");
  });
});

// ---------------------------------------------------------------------------
// TranslationCountError — class identity
// ---------------------------------------------------------------------------

describe("TranslationCountError", () => {
  test("is instanceof Error", () => {
    const e = new TranslationCountError("oops");
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(TranslationCountError);
  });

  test("message is preserved", () => {
    const e = new TranslationCountError("count mismatch: 3 vs 5");
    expect(e.message).toBe("count mismatch: 3 vs 5");
  });

  test("can be caught as Error", () => {
    expect(() => {
      throw new TranslationCountError("test");
    }).toThrow("test");
  });
});

// ---------------------------------------------------------------------------
// buildExplainPrompt — placeholder substitution and template fallback
// ---------------------------------------------------------------------------

describe("buildExplainPrompt", () => {
  test("substitutes all four placeholders", () => {
    const result = buildExplainPrompt(
      "気になります", // sentence
      "Мне интересно",  // secondary (existing translation)
      "Hyouka E01",     // source
      "前の台詞\n(current)\n次の台詞", // context
    );
    expect(result).toContain("気になります");
    expect(result).toContain("Мне интересно");
    expect(result).toContain("Hyouka E01");
    expect(result).toContain("前の台詞");
    // none of the raw placeholders survive
    expect(result).not.toContain("{sentence}");
    expect(result).not.toContain("{secondary}");
    expect(result).not.toContain("{source}");
    expect(result).not.toContain("{context}");
  });

  test("uses DEFAULT_EXPLAIN_PROMPT when no custom template given", () => {
    const fromDefault = buildExplainPrompt("A", "B", "C");
    expect(fromDefault).toContain("Russian speaker");
    expect(fromDefault).toContain("A"); // sentence
    expect(fromDefault).toContain("B"); // secondary
    expect(fromDefault).toContain("C"); // source
  });

  test("uses DEFAULT_EXPLAIN_PROMPT when template is empty/whitespace", () => {
    const fromDefault = buildExplainPrompt("A", "B", "C");
    expect(buildExplainPrompt("A", "B", "C", "", "")).toBe(fromDefault);
    expect(buildExplainPrompt("A", "B", "C", "", "   ")).toBe(fromDefault);
  });

  test("uses custom template when provided", () => {
    const tpl = "S={sentence}|SEC={secondary}|SRC={source}|CTX={context}";
    const out = buildExplainPrompt("文", "перевод", "ep1", "context", tpl);
    expect(out).toBe("S=文|SEC=перевод|SRC=ep1|CTX=context");
  });

  test("DEFAULT_EXPLAIN_PROMPT contains the expected placeholders", () => {
    expect(DEFAULT_EXPLAIN_PROMPT).toContain("{sentence}");
    expect(DEFAULT_EXPLAIN_PROMPT).toContain("{secondary}");
    expect(DEFAULT_EXPLAIN_PROMPT).toContain("{source}");
    expect(DEFAULT_EXPLAIN_PROMPT).toContain("{context}");
  });

  test("context defaults to empty string when omitted", () => {
    const withoutCtx = buildExplainPrompt("文", "transl", "src");
    const withEmpty = buildExplainPrompt("文", "transl", "src", "");
    expect(withoutCtx).toBe(withEmpty);
  });

  test("repeated placeholders are all replaced (replaceAll)", () => {
    const tpl = "{sentence} AND {sentence}";
    const out = buildExplainPrompt("猫", "cat", "src", "", tpl);
    expect(out).toBe("猫 AND 猫");
  });
});

// ---------------------------------------------------------------------------
// buildAskPrompt — optional fields and question always present
// ---------------------------------------------------------------------------

describe("buildAskPrompt", () => {
  test("question is always included in the output", () => {
    const out = buildAskPrompt({ question: "どういう意味ですか？" });
    expect(out).toContain("どういう意味ですか？");
    expect(out).toContain("Question:");
  });

  test("word field included when provided", () => {
    const out = buildAskPrompt({ question: "q", word: "氷菓" });
    expect(out).toContain("氷菓");
    expect(out).toContain("Word being studied:");
  });

  test("word field absent when not provided", () => {
    const out = buildAskPrompt({ question: "q" });
    expect(out).not.toContain("Word being studied:");
  });

  test("sentence field included when provided", () => {
    const out = buildAskPrompt({ question: "q", sentence: "気になります！" });
    expect(out).toContain("気になります！");
    expect(out).toContain("Sentence:");
  });

  test("priorAnswer field included when provided", () => {
    const out = buildAskPrompt({ question: "q", priorAnswer: "prior explanation here" });
    expect(out).toContain("prior explanation here");
    expect(out).toContain("Explanation already shown");
  });

  test("source field included when provided", () => {
    const out = buildAskPrompt({ question: "q", source: "Hyouka E03" });
    expect(out).toContain("Hyouka E03");
    expect(out).toContain("Source:");
  });

  test("all fields together", () => {
    const out = buildAskPrompt({
      question: "なぜ？",
      word: "古典部",
      sentence: "古典部へようこそ。",
      priorAnswer: "Классический клуб — школьный кружок.",
      source: "Hyouka E01",
    });
    expect(out).toContain("なぜ？");
    expect(out).toContain("古典部");
    expect(out).toContain("古典部へようこそ。");
    expect(out).toContain("Классический клуб");
    expect(out).toContain("Hyouka E01");
  });

  test("no optional fields → output still contains intro and question", () => {
    const out = buildAskPrompt({ question: "分かった？" });
    expect(out).toContain("Russian speaker");
    expect(out).toContain("分かった？");
  });
});
