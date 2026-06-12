// Load audit: 10k synthetic cards / progress entries through the hot pure
// paths — matchFront index build, Cards-page filtering, comprehensibility.
// These run on every popup/page render, so they must stay well under 200ms.

import { describe, expect, test } from "bun:test";
import { buildWordIndex, matchFront } from "../web/progress.ts";
import { filterCards, type CardLite } from "../web/cardfilter.ts";
import { comprehensibility, type EntryIndex } from "../src/lib/tokenindex.ts";
import type { AnkiWord, ProgressEntry } from "../web/api.ts";

const N = 10_000;
const BUDGET_MS = 200;

function makeWords(): { words: AnkiWord[]; progress: Record<string, ProgressEntry> } {
  const words: AnkiWord[] = [];
  const progress: Record<string, ProgressEntry> = {};
  for (let i = 0; i < N; i++) {
    const front = `単語${i} [たんご${i}]`;
    words.push({ front, back: `meaning ${i}`, notes: `note ${i}`, context: "" });
    progress[front] = {
      interval: i % 50,
      due: 0,
      reps: i % 7,
      lapses: i % 3,
      ease: 2500,
      queue: i % 4,
      type: 2,
    };
  }
  return { words, progress };
}

function timed(fn: () => void): number {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}

describe("10k-card load audit (pure functions, <200ms each)", () => {
  test("matchFront map build + 10k lookups", () => {
    const { words, progress } = makeWords();
    let idx!: ReturnType<typeof buildWordIndex>;
    const buildMs = timed(() => {
      idx = buildWordIndex(words, progress);
    });
    expect(buildMs).toBeLessThan(BUDGET_MS);

    let hits = 0;
    const lookupMs = timed(() => {
      for (let i = 0; i < N; i++) {
        if (matchFront(idx, `単語${i}`, `タンゴ${i}`, `単語${i}`)) hits++;
        // miss path too (worst case walks every fallback)
        matchFront(idx, `未知${i}`, `ミチ${i}`, `未知${i}`);
      }
    });
    expect(hits).toBe(N);
    expect(lookupMs).toBeLessThan(BUDGET_MS);
  });

  test("Cards page filter over 10k cards", () => {
    const { progress } = makeWords();
    const cards: CardLite[] = [];
    const now = Date.now();
    for (let i = 0; i < N; i++) {
      cards.push({
        front: `単語${i} [たんご${i}]`,
        back: `meaning ${i}`,
        notes: "",
        context: `文${i}<br><img src="zr-${i}.jpg"><br>ep @ 0:0${i % 10}`,
        noteId: now - i * 60_000, // one per minute back in time
      });
    }
    const intervals = new Map(
      Object.entries(progress).map(([f, p]) => [f, p.interval]),
    );
    const freq = new Map<string, number>();
    for (let i = 0; i < N; i++) freq.set(`単語${i}`, i + 1);

    let out: CardLite[] = [];
    const ms = timed(() => {
      out = filterCards(cards, {
        q: "meaning 12",
        range: "30d",
        stage: "learning",
        rarity: "top 3k",
        intervals,
        freq,
        now,
      });
    });
    expect(ms).toBeLessThan(BUDGET_MS);
    expect(out.length).toBeGreaterThan(0);
    // newest first
    expect(out[0]!.noteId!).toBeGreaterThanOrEqual(out[out.length - 1]!.noteId!);

    // unfiltered pass (the common initial render) must also be fast
    const msAll = timed(() => {
      out = filterCards(cards, { intervals, freq });
    });
    expect(msAll).toBeLessThan(BUDGET_MS);
    expect(out.length).toBe(N);
  });

  test("comprehensibility payload over a 10k-lemma index", () => {
    const lemmas = new Map<string, { count: number; cues: never[] }>();
    let total = 0;
    for (let i = 0; i < N; i++) {
      const count = 1 + (i % 9);
      total += count;
      lemmas.set(`語彙${i}`, { count, cues: [] });
    }
    const ix: EntryIndex = { mediaId: "x".repeat(12), lemmas, totalLexical: total };
    const known = new Set<string>();
    for (let i = 0; i < N; i += 2) known.add(`語彙${i}`);

    let res!: ReturnType<typeof comprehensibility>;
    const ms = timed(() => {
      res = comprehensibility(ix, known, 10);
    });
    expect(ms).toBeLessThan(BUDGET_MS);
    expect(res.pctKnown).toBeGreaterThan(0.3);
    expect(res.pctKnown).toBeLessThan(0.7);
    expect(res.unknownLemmas.length).toBe(10);
  });
});
