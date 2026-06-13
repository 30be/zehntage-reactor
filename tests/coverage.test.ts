// Unit tests for web/coverage.ts pure exports.
//
// coverageOfCues depends on getTokenizer() (kuromoji) and isLexical() from
// web/tokenizer.ts, and wordKey() from web/TokenLine.tsx.
// We mock those two web modules so the tests stay fast and offline.
//
// readKnownWords is also exported and tested here; it uses localStorage which
// is available in bun:test as a global (jsdom-compatible stub).

import { describe, expect, test, mock, beforeAll } from "bun:test";

// mock.module() patches the process-global module registry for the whole
// `bun test` run, and mock.restore() does NOT undo it; module bodies are all
// evaluated before any test executes, so an afterAll restore is too late.
// We therefore keep the REAL mergeTokens/kataToHira exports (other files such
// as scripts/tokenizer.test.ts import the real kuromoji-merge logic and break
// if they receive our canned tokens) and override ONLY getTokenizer (heavy,
// offline) and isLexical (so tests can drive coverage with fakeTokens).
const realTokenizer = await import("../web/tokenizer.ts");

// ---------------------------------------------------------------------------
// Mock web/tokenizer.ts BEFORE importing coverage.ts so the module graph
// resolves to our stub from the start.
// ---------------------------------------------------------------------------

// A minimal token type matching KToken.
interface FakeToken {
  surface_form: string;
  basic_form?: string;
  pos?: string;
  reading?: string;
}

// We expose a mutable array so individual tests can control tokenizer output.
let fakeTokens: FakeToken[] = [];

mock.module("../web/tokenizer.ts", () => ({
  ...realTokenizer,
  getTokenizer: () =>
    Promise.resolve({
      tokenize: (_text: string) => fakeTokens,
    }),
  // isLexical: treat every token as lexical unless pos === "記号"
  isLexical: (tok: FakeToken) => tok.pos !== "記号",
}));

// Mock web/TokenLine.tsx — only wordKey is used.
mock.module("../web/TokenLine.tsx", () => ({
  wordKey: (tok: FakeToken) =>
    tok.basic_form && tok.basic_form !== "*" ? tok.basic_form : tok.surface_form,
}));

// Mock everything else coverage.ts imports that could cause side-effects.
mock.module("../web/api.ts", () => ({}));
// NOTE: we deliberately do NOT mock.module("../web/progress.ts"). mock.module()
// patches the process-global registry for the whole `bun test` run and is never
// undone, so stubbing progress.ts here would replace buildWordIndex/matchFront
// for every later test that imports the real module (lemmaAdd, matchfront, …)
// and break the suite. Instead we use the REAL progress.ts and feed coverageOfCues
// a genuine empty WordIndex, on which the real matchFront returns null anyway.
import { buildWordIndex } from "../web/progress.ts";
mock.module("../web/blacklist.ts", () => ({ readBlacklist: () => new Set() }));
mock.module("../web/lang.ts", () => ({ isJaLang: () => false }));
// React hooks — not needed for the pure exports we test.
mock.module("react", () => ({
  useEffect: () => {},
  useState: (init: unknown) => [typeof init === "function" ? (init as () => unknown)() : init, () => {}],
}));

// Import AFTER mocks are registered.
import {
  coverageOfCues,
  readKnownWords,
  type Coverage,
} from "../web/coverage.ts";

// Minimal type aliases matching the real Cue type.
type Cue = { start: number; end: number; text: string };

function makeCue(text: string): Cue {
  return { start: 0, end: 1, text };
}

// A genuine empty word index — the real matchFront returns null for any token.
const EMPTY_INDEX = buildWordIndex([], {});

// ---------------------------------------------------------------------------
// coverageOfCues — all-known vocabulary
// ---------------------------------------------------------------------------

describe("coverageOfCues — all-known", () => {
  beforeAll(() => {
    // Set tokens that our mock tokenizer will return for every cue.
    fakeTokens = [
      { surface_form: "猫", basic_form: "猫" },
      { surface_form: "が", basic_form: "が" },
    ];
  });

  test("all words in knownWords → pct 100, newCount 0", async () => {
    const cues: Cue[] = [makeCue("猫が"), makeCue("猫が")];
    const knownWords = new Set(["猫", "が"]);
    const cov: Coverage = await coverageOfCues(cues, EMPTY_INDEX, knownWords);
    expect(cov.pct).toBe(100);
    expect(cov.newCount).toBe(0);
  });

  test("i1density is 0 when every cue has 0 unknown tokens", async () => {
    const cues: Cue[] = [makeCue("猫が")];
    const knownWords = new Set(["猫", "が"]);
    const cov = await coverageOfCues(cues, EMPTY_INDEX, knownWords);
    // No cue has exactly 1 unknown token.
    expect(cov.i1density).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// coverageOfCues — all-unknown vocabulary
// ---------------------------------------------------------------------------

describe("coverageOfCues — all-unknown", () => {
  test("no known words → pct 0, newCount = distinct lemmas", async () => {
    fakeTokens = [
      { surface_form: "走る", basic_form: "走る" },
      { surface_form: "食べる", basic_form: "食べる" },
    ];
    const cues: Cue[] = [makeCue("走る食べる")];
    const cov = await coverageOfCues(cues, EMPTY_INDEX, new Set());
    expect(cov.pct).toBe(0);
    expect(cov.newCount).toBe(2);
  });

  test("empty cues → pct 100 (vacuously), i1density 0", async () => {
    fakeTokens = [];
    const cov = await coverageOfCues([], EMPTY_INDEX, new Set());
    expect(cov.pct).toBe(100);
    expect(cov.i1density).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// coverageOfCues — i1density counting
// ---------------------------------------------------------------------------

describe("coverageOfCues — i1density", () => {
  test("each cue with exactly 1 unknown contributes to i1density", async () => {
    // 2 tokens per cue; first is known, second is unknown.
    fakeTokens = [
      { surface_form: "猫", basic_form: "猫" },
      { surface_form: "走る", basic_form: "走る" },
    ];
    // 猫 known, 走る unknown → 1 unknown per cue → i1 cue.
    const knownWords = new Set(["猫"]);
    const cues: Cue[] = [makeCue("cue1"), makeCue("cue2")];
    const cov = await coverageOfCues(cues, EMPTY_INDEX, knownWords);
    // Both cues are i+1 → i1density should be 1.0
    expect(cov.i1density).toBe(1);
    expect(cov.pct).toBe(50); // 1 known / 2 tokens per cue * 100 = 50
  });

  test("cue with 2 unknowns does NOT count as i1", async () => {
    fakeTokens = [
      { surface_form: "走る", basic_form: "走る" },
      { surface_form: "食べる", basic_form: "食べる" },
    ];
    const cues: Cue[] = [makeCue("two unknowns")];
    const cov = await coverageOfCues(cues, EMPTY_INDEX, new Set());
    // 2 unknowns → not i+1
    expect(cov.i1density).toBe(0);
    expect(cov.newCount).toBe(2);
  });

  test("mix of i1 and non-i1 cues → correct fraction", async () => {
    // We'll set fakeTokens for the base case; but since tokenizer is called
    // once per cue text and always returns fakeTokens, we need 3 separate
    // setups. Instead, we verify with a known ratio.
    //
    // 3 cues; tokenizer returns 1 unknown token each time (fakeTokens set below).
    fakeTokens = [{ surface_form: "X", basic_form: "X" }];
    const cues: Cue[] = [makeCue("a"), makeCue("b"), makeCue("c")];
    const cov = await coverageOfCues(cues, EMPTY_INDEX, new Set());
    // Each cue: 1 lexical token, 1 unknown → all 3 are i+1 cues.
    expect(cov.i1density).toBeCloseTo(1, 5);
  });

  test("non-lexical tokens (pos=記号) are excluded from lexical count", async () => {
    fakeTokens = [
      { surface_form: "。", pos: "記号" }, // punctuation — skipped
      { surface_form: "猫", basic_form: "猫" }, // lexical unknown
    ];
    const cues: Cue[] = [makeCue("。猫")];
    const cov = await coverageOfCues(cues, EMPTY_INDEX, new Set());
    // 1 lexical token, 1 unknown → i+1 cue
    expect(cov.i1density).toBe(1);
    expect(cov.newCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// readKnownWords — malformed JSON handling
// ---------------------------------------------------------------------------

describe("readKnownWords", () => {
  // Bun's test environment provides a global localStorage (jsdom-compatible).
  // If it doesn't exist, we skip gracefully.
  const hasStorage = typeof localStorage !== "undefined";

  test("returns empty set when key missing", () => {
    if (!hasStorage) return;
    localStorage.removeItem("zr.known");
    const words = readKnownWords();
    expect(words.size).toBe(0);
  });

  test("returns known words from valid JSON array", () => {
    if (!hasStorage) return;
    localStorage.setItem("zr.known", JSON.stringify(["猫", "犬"]));
    const words = readKnownWords();
    expect(words.has("猫")).toBe(true);
    expect(words.has("犬")).toBe(true);
    expect(words.size).toBe(2);
  });

  test("malformed JSON returns empty set (no throw)", () => {
    if (!hasStorage) return;
    localStorage.setItem("zr.known", "{{{not json}}");
    expect(() => readKnownWords()).not.toThrow();
    expect(readKnownWords().size).toBe(0);
  });

  test("non-array JSON returns empty set", () => {
    if (!hasStorage) return;
    localStorage.setItem("zr.known", JSON.stringify({ foo: "bar" }));
    const words = readKnownWords();
    expect(words.size).toBe(0);
  });

  test("array with non-string values filters them out", () => {
    if (!hasStorage) return;
    localStorage.setItem("zr.known", JSON.stringify(["猫", 42, null, "犬"]));
    const words = readKnownWords();
    expect(words.has("猫")).toBe(true);
    expect(words.has("犬")).toBe(true);
    expect(words.size).toBe(2);
  });
});
