// Edge-case and load/stress tests for src/lib/tokenindex.ts
// Does NOT duplicate coverage from tests/tokenindex.test.ts.
// Uses the stub tokenizer pattern (no real kuromoji dict needed).

import { describe, expect, test } from "bun:test";
import type { Cue } from "../src/lib/subs.ts";
import {
  buildEntryIndex,
  encounters,
  comprehensibility,
  dueIntersection,
  type EntryIndex,
} from "../src/lib/tokenindex.ts";

function cue(start: number, text: string): Cue {
  return { start, end: start + 2, text };
}

// Stub tokenizer: splits on whitespace, all pos="名詞"
const stubTokenize = (text: string) =>
  text
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => ({ surface_form: w, pos: "名詞" as const }));

// Stub that produces all-punctuation tokens (記号)
const punctTokenize = (text: string) =>
  text
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => ({ surface_form: w, pos: "記号" as const }));

async function stubIndex(id: string, lines: string[]): Promise<EntryIndex> {
  return buildEntryIndex({ id }, lines.map((l, i) => cue(i * 5, l)), stubTokenize);
}

// ---------------------------------------------------------------------------
// buildEntryIndex — degenerate inputs
// ---------------------------------------------------------------------------

describe("buildEntryIndex — degenerate inputs", () => {
  test("empty cue list → totalLexical=0, no lemmas", async () => {
    const ix = await buildEntryIndex({ id: "empty" }, [], stubTokenize);
    expect(ix.totalLexical).toBe(0);
    expect(ix.lemmas.size).toBe(0);
    expect(ix.mediaId).toBe("empty");
  });

  test("single cue with single token", async () => {
    const ix = await buildEntryIndex({ id: "one" }, [cue(0, "猫")], stubTokenize);
    expect(ix.totalLexical).toBe(1);
    expect(ix.lemmas.has("猫")).toBe(true);
    expect(ix.lemmas.get("猫")!.count).toBe(1);
  });

  test("all-punctuation cues produce nothing", async () => {
    const ix = await buildEntryIndex(
      { id: "punct" },
      [cue(0, "。 ！ ？ … ♪")],
      punctTokenize,
    );
    expect(ix.totalLexical).toBe(0);
    expect(ix.lemmas.size).toBe(0);
  });

  test("cue with empty string text contributes nothing", async () => {
    const ix = await buildEntryIndex(
      { id: "empty-text" },
      [cue(0, ""), cue(5, "犬")],
      stubTokenize,
    );
    expect(ix.totalLexical).toBe(1);
    expect(ix.lemmas.has("犬")).toBe(true);
    expect(ix.lemmas.has("")).toBe(false);
  });

  test("same token across all 5000 cues: count=5000, cues capped at 20", async () => {
    const N = 5_000;
    const cues = Array.from({ length: N }, (_, i) => cue(i * 3, "猫"));
    const ix = await buildEntryIndex({ id: "mono" }, cues, stubTokenize);
    const info = ix.lemmas.get("猫")!;
    expect(info.count).toBe(N);
    expect(info.cues.length).toBe(20); // capped
    expect(ix.totalLexical).toBe(N);
  });

  test("N distinct tokens each appearing once → N lemmas", async () => {
    const N = 1_000;
    const cues = Array.from({ length: N }, (_, i) => cue(i * 3, `語彙${i}`));
    const ix = await buildEntryIndex({ id: "distinct" }, cues, stubTokenize);
    expect(ix.lemmas.size).toBe(N);
    expect(ix.totalLexical).toBe(N);
  });
});

// ---------------------------------------------------------------------------
// LOAD: 10k-cue buildEntryIndex
// ---------------------------------------------------------------------------

describe("buildEntryIndex — LOAD: 10k cues", () => {
  test("10k cues with 100 distinct lemmas (cycled) → correct counts, no hang", async () => {
    const VOCAB = 100;
    const N = 10_000;
    const cues = Array.from({ length: N }, (_, i) => cue(i * 3, `語彙${i % VOCAB}`));
    const ix = await buildEntryIndex({ id: "large" }, cues, stubTokenize);
    expect(ix.lemmas.size).toBe(VOCAB);
    expect(ix.totalLexical).toBe(N);
    // Each of the 100 lemmas appears N/VOCAB = 100 times
    for (let v = 0; v < VOCAB; v++) {
      const info = ix.lemmas.get(`語彙${v}`)!;
      expect(info.count).toBe(N / VOCAB);
      expect(info.cues.length).toBe(20); // capped
    }
  });
});

// ---------------------------------------------------------------------------
// encounters — edge cases
// ---------------------------------------------------------------------------

describe("encounters — edge cases", () => {
  test("lemma not in any index → []", async () => {
    const a = await stubIndex("a", ["猫 犬"]);
    expect(encounters("象", [a])).toEqual([]);
  });

  test("single index, lemma in one cue → returns that entry", async () => {
    const a = await stubIndex("a", ["猫 猫 猫"]);
    const enc = encounters("猫", [a]);
    expect(enc).toHaveLength(1);
    expect(enc[0]!.count).toBe(3);
    expect(enc[0]!.mediaId).toBe("a");
  });

  test("5 indexes, lemma in all → sorted most-hits first", async () => {
    const indexes = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        stubIndex(`ep${i}`, [Array.from({ length: i + 1 }, () => "猫").join(" ")]),
      ),
    );
    const enc = encounters("猫", indexes);
    expect(enc).toHaveLength(5);
    // Sorted descending by count
    for (let i = 0; i < enc.length - 1; i++) {
      expect(enc[i]!.count).toBeGreaterThanOrEqual(enc[i + 1]!.count);
    }
    expect(enc[0]!.count).toBe(5); // ep4 has 5 occurrences
  });

  test("LOAD: encounters over 500 indexes → returns correct top-hit entry", async () => {
    const N = 500;
    const indexes = await Promise.all(
      Array.from({ length: N }, (_, i) => stubIndex(`ep${i}`, ["猫"])),
    );
    // All have count=1; still returns N results
    const enc = encounters("猫", indexes);
    expect(enc).toHaveLength(N);
    expect(enc.every((e) => e.count === 1)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// comprehensibility — edge cases
// ---------------------------------------------------------------------------

describe("comprehensibility — edge cases", () => {
  test("empty index (totalLexical=0) → pctKnown null", async () => {
    const ix = await buildEntryIndex({ id: "empty" }, [], stubTokenize);
    const c = comprehensibility(ix, new Set(["猫"]));
    expect(c.pctKnown).toBeNull();
    expect(c.unknownLemmas).toHaveLength(0);
  });

  test("all known → pctKnown=1, no unknowns", async () => {
    const ix = await stubIndex("a", ["猫 犬 鳥"]);
    const c = comprehensibility(ix, new Set(["猫", "犬", "鳥"]));
    expect(c.pctKnown).toBe(1);
    expect(c.unknownLemmas).toHaveLength(0);
  });

  test("all unknown → pctKnown=0", async () => {
    const ix = await stubIndex("a", ["猫 犬"]);
    const c = comprehensibility(ix, new Set());
    expect(c.pctKnown).toBe(0);
    expect(c.unknownLemmas).toHaveLength(2);
  });

  test("topN=0 → unknownLemmas is empty even with unknowns", async () => {
    const ix = await stubIndex("a", ["猫 犬"]);
    const c = comprehensibility(ix, new Set(), 0);
    expect(c.pctKnown).toBe(0);
    expect(c.unknownLemmas).toHaveLength(0);
  });

  test("topN larger than unknowns → returns all unknowns", async () => {
    const ix = await stubIndex("a", ["猫 犬"]);
    const c = comprehensibility(ix, new Set(), 100);
    expect(c.unknownLemmas).toHaveLength(2);
  });

  test("LOAD: 10k-lemma index, half known → pctKnown ~0.5", () => {
    const N = 10_000;
    const lemmas = new Map<string, { count: number; cues: never[] }>();
    let total = 0;
    for (let i = 0; i < N; i++) {
      lemmas.set(`語彙${i}`, { count: 1, cues: [] });
      total++;
    }
    const ix: EntryIndex = { mediaId: "big", lemmas, totalLexical: total };
    const known = new Set(Array.from({ length: N / 2 }, (_, i) => `語彙${i}`));
    const c = comprehensibility(ix, known, 5);
    expect(c.pctKnown).toBeCloseTo(0.5, 3);
    expect(c.unknownLemmas).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// dueIntersection — edge cases
// ---------------------------------------------------------------------------

describe("dueIntersection — edge cases", () => {
  test("empty due set → count 0", async () => {
    const ix = await stubIndex("a", ["猫 犬"]);
    const di = dueIntersection(ix, new Set());
    expect(di.count).toBe(0);
    expect(di.lemmas).toHaveLength(0);
  });

  test("due lemma not in entry → count 0", async () => {
    const ix = await stubIndex("a", ["猫"]);
    const di = dueIntersection(ix, new Set(["象"]));
    expect(di.count).toBe(0);
  });

  test("all due lemmas in entry → count = distinct lemmas in entry", async () => {
    const ix = await stubIndex("a", ["猫 犬 鳥"]);
    const di = dueIntersection(ix, new Set(["猫", "犬", "鳥", "象"]));
    // 象 not in entry, so count=3
    expect(di.count).toBe(3);
    expect(di.lemmas.map((l) => l.lemma).sort()).toEqual(["犬", "猫", "鳥"].sort());
  });

  test("LOAD: 500-lemma entry, 250 due → count=250", async () => {
    const VOCAB = 500;
    const cues = Array.from({ length: VOCAB }, (_, i) => cue(i * 3, `語彙${i}`));
    const ix = await buildEntryIndex({ id: "big" }, cues, stubTokenize);
    const due = new Set(Array.from({ length: 250 }, (_, i) => `語彙${i}`));
    const di = dueIntersection(ix, due);
    expect(di.count).toBe(250);
    expect(di.lemmas).toHaveLength(250);
  });
});
