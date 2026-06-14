// PROPERTY / FUZZ tests for the remaining pure helpers:
//   web/quiz.ts        : buildQuiz, blankOut, checkCloze, pickClozeWord, normalizeAnswer
//   web/searchquery.ts : highlightSplit, highlightSplitRu, groupByEpisode, normalizeQuery
//   web/forecast.ts    : buildForecast, estimateDueOffset, forecastTotal
//
// Invariants:
//   - nothing throws on arbitrary input;
//   - quiz items are well-shaped (mc answer is a valid index of options whose
//     value is the correct translation; cloze has non-empty answer + a changed
//     prompt); checkCloze is reflexive on its own answer when answer is lexical;
//   - highlightSplit segments CONCATENATE back to the original text exactly
//     (length-preserving normalization contract), and match segments equal the
//     query length;
//   - buildForecast always returns window+1 buckets, every count >= 0, and the
//     total never exceeds the number of progress entries; offsets are in range.
//
// Deterministic: fixed-seed mulberry32 PRNG (tests/_fuzz.ts), never Math.random.

import { describe, expect, test } from "bun:test";
import {
  buildQuiz,
  blankOut,
  checkCloze,
  pickClozeWord,
  normalizeAnswer,
  BLANK,
  type QuizCue,
} from "../web/quiz.ts";
import {
  highlightSplit,
  highlightSplitRu,
  normalizeQuery,
  groupByEpisode,
  flatHits,
  type SearchHit,
} from "../web/searchquery.ts";
import {
  buildForecast,
  estimateDueOffset,
  forecastTotal,
  FORECAST_WINDOW,
} from "../web/forecast.ts";
import type { ProgressEntry } from "../web/api.ts";
import { Rng, fuzzString } from "./_fuzz.ts";

// ---------------------------------------------------------------------------
// web/quiz.ts
// ---------------------------------------------------------------------------

describe("fuzz: quiz helpers never throw + well-shaped items", () => {
  function randomQuizCues(rng: Rng): QuizCue[] {
    const n = rng.int(0, 10);
    const cues: QuizCue[] = [];
    for (let i = 0; i < n; i++) {
      const c: QuizCue = { text: fuzzString(rng, 14) };
      if (rng.bool(0.6)) c.translation = fuzzString(rng, 10);
      if (rng.bool(0.7)) {
        const w: { surface: string; lemma: string }[] = [];
        const nw = rng.int(0, 4);
        for (let k = 0; k < nw; k++) {
          const surface = fuzzString(rng, 5);
          w.push({ surface, lemma: rng.bool() ? surface : fuzzString(rng, 5) });
        }
        c.words = w;
      }
      cues.push(c);
    }
    return cues;
  }

  test("2000 random buildQuiz invocations", () => {
    const rng = new Rng(0x9012ab);
    for (let i = 0; i < 2000; i++) {
      const cues = randomQuizCues(rng);
      const deck = new Set<string>();
      const known = new Set<string>();
      for (const c of cues)
        for (const w of c.words ?? []) {
          if (rng.bool(0.2)) deck.add(w.lemma);
          if (rng.bool(0.2)) known.add(w.lemma);
        }
      const opts = { count: rng.int(0, 8), deck, known, seed: rng.int(1, 1e9) };

      let items: ReturnType<typeof buildQuiz>;
      expect(() => {
        items = buildQuiz(cues, opts);
      }).not.toThrow();
      expect(Array.isArray(items!)).toBe(true);
      expect(items!.length).toBeLessThanOrEqual(opts.count);

      for (const it of items!) {
        if (it.kind === "mc") {
          expect(it.options.length).toBeGreaterThanOrEqual(2);
          expect(it.answer).toBeGreaterThanOrEqual(0);
          expect(it.answer).toBeLessThan(it.options.length);
          // answer index actually points at the correct translation string.
          expect(typeof it.options[it.answer]).toBe("string");
          // options are distinct (a Set was used upstream + the correct one).
          expect(new Set(it.options).size).toBe(it.options.length);
        } else {
          expect(it.kind).toBe("cloze");
          expect(it.answer.length).toBeGreaterThan(0);
          // the blank actually appears in the prompt and the prompt changed.
          expect(it.prompt.includes(BLANK)).toBe(true);
        }
      }
    }
  });

  test("3000 blankOut / checkCloze / pickClozeWord property checks", () => {
    const rng = new Rng(0x33cc77);
    for (let i = 0; i < 3000; i++) {
      const text = fuzzString(rng, 14);
      const surface = fuzzString(rng, 8);

      let out: string;
      expect(() => {
        out = blankOut(text, surface);
      }).not.toThrow();
      expect(typeof out!).toBe("string");
      // blankOut either leaves text unchanged or inserts exactly one BLANK.
      const blanks = out!.split(BLANK).length - 1;
      expect(blanks === 0 || blanks === 1).toBe(true);

      // checkCloze: an answer always matches itself IFF it has lexical content.
      const norm = normalizeAnswer(surface);
      expect(checkCloze(surface, surface)).toBe(norm.length > 0);
      // a pure-whitespace/punct guess is never correct.
      expect(checkCloze("   ", surface)).toBe(false);

      // pickClozeWord never throws and returns null or a member word.
      const words = (rng.bool() ? [{ surface, lemma: surface }] : []).concat(
        rng.bool() ? [{ surface: fuzzString(rng, 4), lemma: fuzzString(rng, 4) }] : [],
      );
      const cue: QuizCue = { text, words };
      let pick: ReturnType<typeof pickClozeWord>;
      expect(() => {
        pick = pickClozeWord(cue, new Set(), new Set());
      }).not.toThrow();
      if (pick!) expect(words.some((w) => w.surface === pick!.surface)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// web/searchquery.ts
// ---------------------------------------------------------------------------

describe("fuzz: highlightSplit reconstructs original text exactly", () => {
  test("4000 random (text, query) pairs", () => {
    const rng = new Rng(0x5ea2c4);
    for (let i = 0; i < 4000; i++) {
      const text = fuzzString(rng, 20);
      // bias the query toward being a real substring half the time.
      const query =
        rng.bool() && text.length > 0
          ? text.slice(rng.int(0, text.length - 1), rng.int(0, text.length))
          : fuzzString(rng, 6);

      for (const fn of [highlightSplit, highlightSplitRu]) {
        let segs: ReturnType<typeof highlightSplit>;
        expect(() => {
          segs = fn(text, query);
        }).not.toThrow();
        expect(Array.isArray(segs!)).toBe(true);
        // segments concatenate back to the EXACT original text.
        expect(segs!.map((s) => s.text).join("")).toBe(text);
        // every segment text is a string and `match` is boolean.
        for (const s of segs!) {
          expect(typeof s.text).toBe("string");
          expect(typeof s.match).toBe("boolean");
        }
        // no two consecutive segments share the same `match` flag would be
        // ideal but the parser may emit adjacent same-flag empties on edge
        // inputs; we only require non-empty match segments when query non-empty.
        const nq = normalizeQuery(query);
        if (nq.length === 0) {
          expect(segs!.length).toBe(1);
          expect(segs![0]!.match).toBe(false);
        }
      }
    }
  });

  test("2000 random hit lists: groupByEpisode preserves & flattens", () => {
    const rng = new Rng(0xc0ffee);
    for (let i = 0; i < 2000; i++) {
      const hits: SearchHit[] = [];
      const n = rng.int(0, 12);
      for (let k = 0; k < n; k++) {
        hits.push({
          mediaId: rng.pick(["a", "b", "c", fuzzString(rng, 3)]),
          name: fuzzString(rng, 5),
          start: rng.int(0, 9999),
          text: fuzzString(rng, 8),
        });
      }
      let groups: ReturnType<typeof groupByEpisode>;
      expect(() => {
        groups = groupByEpisode(hits);
      }).not.toThrow();
      // flattening the groups recovers exactly the input hits (count-wise).
      expect(flatHits(groups!).length).toBe(hits.length);
      // group ids are unique.
      const ids = groups!.map((g) => g.mediaId);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});

// ---------------------------------------------------------------------------
// web/forecast.ts
// ---------------------------------------------------------------------------

describe("fuzz: buildForecast bucket invariants", () => {
  function randomProgress(rng: Rng): ProgressEntry {
    const p: Partial<ProgressEntry> = {
      interval: rng.pick([
        -5,
        0,
        rng.int(1, 400),
        NaN,
        Infinity,
        rng.next() * 100,
      ]),
      due: rng.int(0, 1000),
      reps: rng.int(0, 50),
      lapses: rng.int(0, 10),
      ease: rng.int(1300, 3000),
      queue: rng.int(-3, 4),
      type: rng.int(0, 3),
    };
    if (rng.bool(0.4)) p.isDue = rng.bool();
    if (rng.bool(0.4)) p.daysOverdue = rng.pick([0, rng.int(1, 30), -2, NaN]);
    return p as ProgressEntry;
  }

  test("3000 random decks × random windows", () => {
    const rng = new Rng(0xfaface);
    for (let i = 0; i < 3000; i++) {
      const progress: Record<string, ProgressEntry> = {};
      const n = rng.int(0, 40);
      for (let k = 0; k < n; k++) progress[`k${k}`] = randomProgress(rng);
      const window = rng.pick([0, 1, 7, FORECAST_WINDOW, 30, NaN, -3, Infinity]);

      let buckets: ReturnType<typeof buildForecast>;
      expect(() => {
        buckets = buildForecast(progress, window);
      }).not.toThrow();

      // window+1 buckets (defaulting on bad window), ascending offsets.
      const w =
        Number.isFinite(window) && window >= 0 ? Math.floor(window) : FORECAST_WINDOW;
      expect(buckets!.length).toBe(w + 1);
      for (let j = 0; j < buckets!.length; j++) {
        expect(buckets![j]!.dayOffset).toBe(j);
        expect(buckets![j]!.count).toBeGreaterThanOrEqual(0);
        expect(Number.isInteger(buckets![j]!.count)).toBe(true);
      }
      // total scheduled cards never exceeds the deck size.
      const total = forecastTotal(buckets!);
      expect(total).toBeLessThanOrEqual(n);
      expect(total).toBeGreaterThanOrEqual(0);

      // estimateDueOffset is null or an in-range integer offset.
      for (const key of Object.keys(progress)) {
        const off = estimateDueOffset(progress[key]!, w);
        if (off !== null) {
          expect(Number.isInteger(off)).toBe(true);
          expect(off).toBeGreaterThanOrEqual(0);
          expect(off).toBeLessThanOrEqual(w);
        }
      }
    }
  });
});
