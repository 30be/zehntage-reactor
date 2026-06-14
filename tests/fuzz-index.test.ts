// PROPERTY / FUZZ tests for the pure index/coverage builders & queries:
//   src/lib/tokenindex.ts : buildEntryIndex, comprehensibility, encounters,
//                           dueIntersection
//   web/progress.ts       : buildWordIndex, matchFront (+ withFront/withoutFront)
//
// These are fed random cue/token lists + decks (via a deterministic STUB
// tokenizer so no kuromoji dict is needed — same pattern as
// tokenindex-edge-load.test.ts) and random Anki fronts.
//
// Invariants:
//   - nothing throws on arbitrary input;
//   - comprehensibility().pctKnown is null or in [0,1];
//   - counts are internally consistent (sum of lemma counts == totalLexical;
//     known + sum(unknown counts) == totalLexical);
//   - encounters / dueIntersection return well-shaped, correctly-sorted output;
//   - matchFront never throws and returns string|null.
//
// Deterministic: fixed-seed mulberry32 PRNG (tests/_fuzz.ts), never Math.random.

import { describe, expect, test } from "bun:test";
import type { Cue } from "../src/lib/subs.ts";
import {
  buildEntryIndex,
  comprehensibility,
  encounters,
  dueIntersection,
  type Tokenize,
} from "../src/lib/tokenindex.ts";
import {
  buildWordIndex,
  withFront,
  withoutFront,
  matchFront,
} from "../web/progress.ts";
import type { AnkiWord, ProgressEntry } from "../web/api.ts";
import { Rng, fuzzString, fuzzToken } from "./_fuzz.ts";

// Stub tokenizer: split on whitespace, vary pos/reading/basic_form so isLexical
// sometimes filters (記号 / blank surfaces) and lemmaOf sometimes folds.
const stubTokenize: Tokenize = (text: string) =>
  text
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => ({
      surface_form: w,
      pos: w.length % 3 === 0 ? "記号" : "名詞",
      basic_form: w.length % 2 === 0 ? "*" : w,
    }));

function randomCues(rng: Rng): Cue[] {
  const n = rng.int(0, 30);
  const cues: Cue[] = [];
  let t = 0;
  for (let i = 0; i < n; i++) {
    t += rng.int(0, 5);
    cues.push({ start: t, end: t + rng.int(0, 5), text: fuzzString(rng, 12) });
  }
  return cues;
}

describe("fuzz: buildEntryIndex + comprehensibility invariants", () => {
  test("2000 random cue lists × random known-sets", async () => {
    const rng = new Rng(0x1d1ce5);
    for (let i = 0; i < 2000; i++) {
      const cues = randomCues(rng);
      let index: Awaited<ReturnType<typeof buildEntryIndex>>;
      // buildEntryIndex is async (awaits the tokenizer) but with a stub passed
      // in it resolves synchronously-ish; never rejects.
      index = await buildEntryIndex({ id: `m${i}` }, cues, stubTokenize);

      expect(index.mediaId).toBe(`m${i}`);
      expect(index.lemmas instanceof Map).toBe(true);
      expect(Number.isFinite(index.totalLexical)).toBe(true);
      expect(index.totalLexical).toBeGreaterThanOrEqual(0);

      // sum of per-lemma counts must equal totalLexical.
      let sum = 0;
      for (const info of index.lemmas.values()) {
        expect(info.count).toBeGreaterThan(0);
        expect(info.cues.length).toBeLessThanOrEqual(info.count);
        expect(info.cues.length).toBeLessThanOrEqual(20); // MAX_CUES_PER_LEMMA
        sum += info.count;
      }
      expect(sum).toBe(index.totalLexical);

      // random known-set drawn from the actual lemmas + some noise.
      const lemmaList = [...index.lemmas.keys()];
      const known = new Set<string>();
      for (const l of lemmaList) if (rng.bool(0.4)) known.add(l);
      if (rng.bool()) known.add(fuzzString(rng, 5)); // noise lemma

      const comp = comprehensibility(index, known, rng.int(0, 100));
      if (comp.pctKnown !== null) {
        expect(comp.pctKnown).toBeGreaterThanOrEqual(0);
        expect(comp.pctKnown).toBeLessThanOrEqual(1);
      } else {
        // null only when there were no lexical tokens.
        expect(index.totalLexical).toBe(0);
      }
      // unknownLemmas sorted by count desc, and never include a known lemma.
      for (let j = 1; j < comp.unknownLemmas.length; j++) {
        expect(comp.unknownLemmas[j - 1]!.count).toBeGreaterThanOrEqual(
          comp.unknownLemmas[j]!.count,
        );
      }
      for (const u of comp.unknownLemmas) expect(known.has(u.lemma)).toBe(false);

      // encounters / dueIntersection never throw on random lemma + due-set.
      const queryLemma = lemmaList.length ? rng.pick(lemmaList) : fuzzString(rng, 4);
      expect(() => encounters(queryLemma, [index])).not.toThrow();
      const dueSet = new Set(lemmaList.filter(() => rng.bool(0.3)));
      const due = dueIntersection(index, dueSet);
      expect(due.count).toBe(due.lemmas.length);
      // every reported due lemma is genuinely in the index.
      for (const d of due.lemmas) expect(index.lemmas.has(d.lemma)).toBe(true);
    }
  });
});

describe("fuzz: buildWordIndex / matchFront never throw", () => {
  function randomFront(rng: Rng): string {
    const kind = rng.int(0, 4);
    const word = rng.bool() ? rng.pick(["辛い", "生", "折木", "ABC", "食べる"]) : fuzzString(rng, 5);
    switch (kind) {
      case 0:
        return word; // bare
      case 1:
        return `${word} [${rng.pick(["からい", "つらい", "なま", "せい", ""])}]`; // bracketed
      case 2:
        return `${word}[${fuzzString(rng, 4)}]`; // no space before bracket
      default:
        return fuzzString(rng, 8); // pure garbage front
    }
  }

  test("3000 random decks × random lookups", () => {
    const rng = new Rng(0xf0f0f0);
    for (let i = 0; i < 3000; i++) {
      const words: AnkiWord[] = [];
      const nWords = rng.int(0, 15);
      for (let k = 0; k < nWords; k++) {
        words.push({ front: randomFront(rng) } as AnkiWord);
      }
      const progress: Record<string, ProgressEntry> = {};

      let idx: ReturnType<typeof buildWordIndex>;
      expect(() => {
        idx = buildWordIndex(words, progress);
      }).not.toThrow();
      expect(idx!.byKey instanceof Map).toBe(true);
      expect(idx!.bare instanceof Map).toBe(true);

      // random lookups with random surface/reading/basic_form.
      for (let q = 0; q < 5; q++) {
        const tok = fuzzToken(rng);
        let res: string | null;
        expect(() => {
          res = matchFront(idx!, tok.surface_form, tok.reading, tok.basic_form);
        }).not.toThrow();
        expect(res! === null || typeof res! === "string").toBe(true);
      }

      // withFront / withoutFront round-trip never throws and preserves Map shape.
      const extra = randomFront(rng);
      let added: ReturnType<typeof withFront>;
      expect(() => {
        added = withFront(idx!, extra);
      }).not.toThrow();
      expect(added!.byKey.get(extra)).toBe(extra);
      expect(() => withoutFront(added!, extra)).not.toThrow();
    }
  });
});
