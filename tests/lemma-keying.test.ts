// Tests specifically focused on LEMMA KEYING in tokenindex.ts:
// a conjugated form and its dictionary form must map to the same lemma,
// counted once in comprehensibility/dueIntersection/encounters.
//
// These tests use a stub tokenizer that directly controls basic_form,
// so they are deterministic (no dict needed).

import { describe, expect, test } from "bun:test";
import {
  buildEntryIndex,
  comprehensibility,
  dueIntersection,
  encounters,
} from "../src/lib/tokenindex.ts";
import type { KToken } from "../src/lib/jatok.ts";

type Cue = { start: number; end: number; text: string };

function cue(start: number, text: string): Cue {
  return { start, end: start + 2, text };
}

// A tokenizer that emits the tokens passed as arguments (indexed by cue text).
function staticTokenize(tokenMap: Record<string, KToken[]>) {
  return (text: string): KToken[] => tokenMap[text] ?? [];
}

// ---------------------------------------------------------------------------
// LEMMA KEYING: conjugation + dict form → same lemma
// ---------------------------------------------------------------------------

describe("LEMMA KEYING — conjugated + dictionary form are ONE lemma", () => {
  test("食べた and 食べる in the same cue count as one lemma key", async () => {
    const tok = staticTokenize({
      "食べた食べる": [
        { surface_form: "食べた",   basic_form: "食べる", pos: "動詞" },
        { surface_form: "食べる",   basic_form: "食べる", pos: "動詞" },
      ],
    });
    const ix = await buildEntryIndex(
      { id: "ep" },
      [cue(0, "食べた食べる")],
      tok,
    );
    // Only ONE lemma key: 食べる
    expect(ix.lemmas.size).toBe(1);
    expect(ix.lemmas.has("食べる")).toBe(true);
    // Count = 2 (both occurrences)
    expect(ix.lemmas.get("食べる")!.count).toBe(2);
    expect(ix.totalLexical).toBe(2);
  });

  test("食べた, 食べない, 食べる across three cues → one lemma, count 3", async () => {
    const tok = staticTokenize({
      "食べた":   [{ surface_form: "食べた",   basic_form: "食べる", pos: "動詞" }],
      "食べない": [{ surface_form: "食べない", basic_form: "食べる", pos: "動詞" }],
      "食べる":   [{ surface_form: "食べる",   basic_form: "食べる", pos: "動詞" }],
    });
    const ix = await buildEntryIndex(
      { id: "ep" },
      [cue(0, "食べた"), cue(5, "食べない"), cue(10, "食べる")],
      tok,
    );
    expect(ix.lemmas.size).toBe(1);
    expect(ix.lemmas.get("食べる")!.count).toBe(3);
    expect(ix.totalLexical).toBe(3);
  });

  test("comprehensibility: knowing 食べる covers ALL conjugated occurrences", async () => {
    const tok = staticTokenize({
      "食べた":   [{ surface_form: "食べた",   basic_form: "食べる", pos: "動詞" }],
      "食べない": [{ surface_form: "食べない", basic_form: "食べる", pos: "動詞" }],
      "猫が":     [{ surface_form: "猫",       basic_form: "猫",     pos: "名詞" }],
    });
    const ix = await buildEntryIndex(
      { id: "ep" },
      [cue(0, "食べた"), cue(5, "食べない"), cue(10, "猫が")],
      tok,
    );
    // totalLexical = 3; 食べる-lemma appears twice, 猫 appears once
    expect(ix.totalLexical).toBe(3);
    const c = comprehensibility(ix, new Set(["食べる"]));
    expect(c.pctKnown).toBeCloseTo(2 / 3, 5);
    expect(c.unknownLemmas).toHaveLength(1);
    expect(c.unknownLemmas[0]!.lemma).toBe("猫");
  });

  test("knowing ONLY conjugated form does NOT help (knownSet must use lemma key)", async () => {
    // The knownSet is keyed by lemma (食べる), not by surface (食べた).
    // If the caller mistakenly passes 食べた to knownSet, it must NOT match
    // the 食べた token (which is stored under lemma 食べる).
    const tok = staticTokenize({
      "食べた": [{ surface_form: "食べた", basic_form: "食べる", pos: "動詞" }],
    });
    const ix = await buildEntryIndex({ id: "ep" }, [cue(0, "食べた")], tok);
    // knownSet has the SURFACE form, not the lemma — should NOT be counted as known
    const cWrong = comprehensibility(ix, new Set(["食べた"]));
    expect(cWrong.pctKnown).toBe(0); // 食べた ≠ lemma 食べる in the index
    // knownSet with the LEMMA form → correctly counted as known
    const cRight = comprehensibility(ix, new Set(["食べる"]));
    expect(cRight.pctKnown).toBe(1);
  });

  test("dueIntersection: due lemma 食べる matches entry with 食べた token", async () => {
    const tok = staticTokenize({
      "食べた": [{ surface_form: "食べた", basic_form: "食べる", pos: "動詞" }],
    });
    const ix = await buildEntryIndex({ id: "ep" }, [cue(0, "食べた")], tok);
    const due = dueIntersection(ix, new Set(["食べる"]));
    expect(due.count).toBe(1);
    expect(due.lemmas[0]!.lemma).toBe("食べる");
  });

  test("encounters: lemma 食べる found via conjugated token", async () => {
    const tok = staticTokenize({
      "食べた": [{ surface_form: "食べた", basic_form: "食べる", pos: "動詞" }],
    });
    const ix = await buildEntryIndex({ id: "ep" }, [cue(0, "食べた")], tok);
    const enc = encounters("食べる", [ix]);
    expect(enc).toHaveLength(1);
    expect(enc[0]!.count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// HOMOGRAPH HANDLING in the index
// (same surface, different basic_form → different lemma keys)
// ---------------------------------------------------------------------------

describe("HOMOGRAPH lemma keying", () => {
  test("same surface with different basic_form → two separate lemma keys", async () => {
    // 上る (のぼる) vs 上がる (あがる) — different basic_forms
    const tok = staticTokenize({
      "上った上がった": [
        { surface_form: "上った",   basic_form: "上る",   pos: "動詞" },
        { surface_form: "上がった", basic_form: "上がる", pos: "動詞" },
      ],
    });
    const ix = await buildEntryIndex(
      { id: "ep" },
      [cue(0, "上った上がった")],
      tok,
    );
    expect(ix.lemmas.size).toBe(2);
    expect(ix.lemmas.has("上る")).toBe(true);
    expect(ix.lemmas.has("上がる")).toBe(true);
  });

  test("homograph comprehensibility: knowing one reading covers only its occurrences", async () => {
    const tok = staticTokenize({
      "上った": [{ surface_form: "上った", basic_form: "上る",   pos: "動詞" }],
      "上がった": [{ surface_form: "上がった", basic_form: "上がる", pos: "動詞" }],
    });
    const ix = await buildEntryIndex(
      { id: "ep" },
      [cue(0, "上った"), cue(5, "上がった")],
      tok,
    );
    // Only know 上る → 50%
    const c = comprehensibility(ix, new Set(["上る"]));
    expect(c.pctKnown).toBeCloseTo(0.5, 5);
  });
});

// ---------------------------------------------------------------------------
// CUE EXAMPLE DEDUPLICATION
// (each lemma records at most one example per cue, not per occurrence)
// ---------------------------------------------------------------------------

describe("cue example deduplication", () => {
  test("repeated lemma in one cue produces only ONE example cue entry", async () => {
    const tok = staticTokenize({
      "猫猫猫": [
        { surface_form: "猫", basic_form: "猫", pos: "名詞" },
        { surface_form: "猫", basic_form: "猫", pos: "名詞" },
        { surface_form: "猫", basic_form: "猫", pos: "名詞" },
      ],
    });
    const ix = await buildEntryIndex({ id: "ep" }, [cue(0, "猫猫猫")], tok);
    const neko = ix.lemmas.get("猫")!;
    // count = 3 (every occurrence)
    expect(neko.count).toBe(3);
    // but cues array has only 1 entry (deduplicated per cue)
    expect(neko.cues).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// EDGE CASES
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  test("token with basic_form='*' uses surface as lemma", async () => {
    const tok = staticTokenize({
      "ほげ": [{ surface_form: "ほげ", basic_form: "*", pos: "名詞" }],
    });
    const ix = await buildEntryIndex({ id: "ep" }, [cue(0, "ほげ")], tok);
    expect(ix.lemmas.has("ほげ")).toBe(true);
    expect(ix.lemmas.has("*")).toBe(false);
  });

  test("token with no basic_form uses surface as lemma", async () => {
    const tok = staticTokenize({
      "ほげ": [{ surface_form: "ほげ", pos: "名詞" }],
    });
    const ix = await buildEntryIndex({ id: "ep" }, [cue(0, "ほげ")], tok);
    expect(ix.lemmas.has("ほげ")).toBe(true);
  });

  test("記号 tokens are not indexed regardless of basic_form", async () => {
    const tok = staticTokenize({
      "。": [{ surface_form: "。", pos: "記号", basic_form: "。" }],
    });
    const ix = await buildEntryIndex({ id: "ep" }, [cue(0, "。")], tok);
    expect(ix.totalLexical).toBe(0);
    expect(ix.lemmas.size).toBe(0);
  });

  test("comprehensibility with topN=0 returns empty unknownLemmas list", async () => {
    const tok = staticTokenize({
      "猫犬": [
        { surface_form: "猫", pos: "名詞" },
        { surface_form: "犬", pos: "名詞" },
      ],
    });
    const ix = await buildEntryIndex({ id: "ep" }, [cue(0, "猫犬")], tok);
    const c = comprehensibility(ix, new Set(), 0);
    expect(c.unknownLemmas).toHaveLength(0);
    expect(c.pctKnown).toBe(0);
  });

  test("encounters returns results sorted most-hits first", async () => {
    const tok = staticTokenize({
      "猫猫": [
        { surface_form: "猫", pos: "名詞" },
        { surface_form: "猫", pos: "名詞" },
      ],
      "猫": [{ surface_form: "猫", pos: "名詞" }],
    });
    const ix1 = await buildEntryIndex({ id: "ep1" }, [cue(0, "猫猫")], tok);
    const ix2 = await buildEntryIndex({ id: "ep2" }, [cue(0, "猫")], tok);
    const enc = encounters("猫", [ix1, ix2]);
    expect(enc[0]!.mediaId).toBe("ep1");
    expect(enc[0]!.count).toBe(2);
    expect(enc[1]!.mediaId).toBe("ep2");
  });

  test("dueIntersection sorted most-frequent first", async () => {
    const tok = staticTokenize({
      "猫猫犬": [
        { surface_form: "猫", pos: "名詞" },
        { surface_form: "猫", pos: "名詞" },
        { surface_form: "犬", pos: "名詞" },
      ],
    });
    const ix = await buildEntryIndex({ id: "ep" }, [cue(0, "猫猫犬")], tok);
    const di = dueIntersection(ix, new Set(["猫", "犬"]));
    expect(di.lemmas[0]!.lemma).toBe("猫");
    expect(di.lemmas[1]!.lemma).toBe("犬");
  });
});
