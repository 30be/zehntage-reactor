import { describe, expect, test } from "bun:test";
import { freqRank, freqTier, freqRankOf } from "../web/freq.ts";

// freqRank and freqTier are pure functions with no DOM/fetch dependencies.
// loadFreq is skipped — it calls fetch("/freq.json") which is untestable here.

describe("freqRank", () => {
  const freq = new Map<string, number>([
    ["食べる", 42],
    ["食べ", 999],
    ["走る", 500],
  ]);

  test("basic_form wins over surface when both exist", () => {
    const tok = { surface_form: "食べ", basic_form: "食べる" };
    expect(freqRank(freq, tok)).toBe(42);
  });

  test("surface fallback when basic_form missing from map", () => {
    const tok = { surface_form: "走る", basic_form: "走る" };
    expect(freqRank(freq, tok)).toBe(500);
  });

  test("surface fallback when basic_form is '*'", () => {
    // basic_form === "*" means kuromoji could not determine it; fall back to surface
    const tok = { surface_form: "食べ", basic_form: "*" };
    expect(freqRank(freq, tok)).toBe(999);
  });

  test("returns null when neither basic_form nor surface is in map", () => {
    const tok = { surface_form: "xyz", basic_form: "xyz" };
    expect(freqRank(freq, tok)).toBeNull();
  });

  test("returns null when basic_form is '*' and surface also missing", () => {
    const tok = { surface_form: "zzz", basic_form: "*" };
    expect(freqRank(freq, tok)).toBeNull();
  });

  test("basic_form empty string falls through to surface lookup", () => {
    // empty string is falsy — the guard `if (tok.basic_form && ...)` skips it
    const tok = { surface_form: "食べ", basic_form: "" };
    expect(freqRank(freq, tok)).toBe(999);
  });
});

describe("freqTier", () => {
  test("null rank → 'rare'", () => {
    expect(freqTier(null)).toBe("rare");
  });

  test("rank 1 → 'top 1k'", () => {
    expect(freqTier(1)).toBe("top 1k");
  });

  test("rank 1000 → 'top 1k' (boundary inclusive)", () => {
    expect(freqTier(1000)).toBe("top 1k");
  });

  test("rank 1001 → 'top 3k'", () => {
    expect(freqTier(1001)).toBe("top 3k");
  });

  test("rank 3000 → 'top 3k' (boundary inclusive)", () => {
    expect(freqTier(3000)).toBe("top 3k");
  });

  test("rank 3001 → 'top 10k'", () => {
    expect(freqTier(3001)).toBe("top 10k");
  });

  test("rank 10000 → 'top 10k' (boundary inclusive)", () => {
    expect(freqTier(10_000)).toBe("top 10k");
  });

  test("rank 10001 → 'top 30k'", () => {
    expect(freqTier(10_001)).toBe("top 30k");
  });

  test("rank 30000 → 'top 30k' (boundary inclusive)", () => {
    expect(freqTier(30_000)).toBe("top 30k");
  });

  test("rank 30001 → 'rare'", () => {
    expect(freqTier(30_001)).toBe("rare");
  });
});

describe("freqRankOf", () => {
  const freq = new Map<string, number>([
    ["食べる", 42],
    ["食べ", 999],
  ]);

  test("dictForm preferred over word when both present", () => {
    expect(freqRankOf(freq, "食べ", "食べる")).toBe(42);
  });

  test("falls back to word when dictForm not in map", () => {
    expect(freqRankOf(freq, "食べ", "存在しない")).toBe(999);
  });

  test("word only (no dictForm) returns word rank", () => {
    expect(freqRankOf(freq, "食べ")).toBe(999);
  });

  test("both missing → null", () => {
    expect(freqRankOf(freq, "xyz", "abc")).toBeNull();
  });

  test("no dictForm, word missing → null", () => {
    expect(freqRankOf(freq, "xyz")).toBeNull();
  });
});
