// Map Anki learning progress to a RED -> GREEN underline color.

import type { AnkiWord, ProgressEntry } from "./api.ts";
import { kataToHira } from "./tokenizer.ts";

export interface WordIndex {
  // normalized surface (and "surface [reading]") -> front
  byKey: Map<string, string>;
  progress: Record<string, ProgressEntry>;
}

export function buildWordIndex(
  words: AnkiWord[],
  progress: Record<string, ProgressEntry>,
): WordIndex {
  const byKey = new Map<string, string>();
  for (const w of words) {
    const front = w.front;
    byKey.set(front, front);
    // front is "word" or "word [reading]" — index both the bare word and full.
    const m = front.match(/^(.+?)\s*\[(.+?)\]\s*$/);
    if (m) {
      byKey.set(m[1]!.trim(), front);
    }
  }
  return { byKey, progress };
}

/** Find the matching Anki front for a surface form (+ optional reading).
 * Falls back to the dictionary form (basic_form) so conjugated tokens like
 * 食べた still match a 食べる card. */
export function matchFront(
  idx: WordIndex,
  surface: string,
  reading?: string,
  basicForm?: string,
): string | null {
  if (idx.byKey.has(surface)) return idx.byKey.get(surface)!;
  if (reading) {
    const hira = kataToHira(reading);
    const withReading = `${surface} [${hira}]`;
    if (idx.byKey.has(withReading)) return idx.byKey.get(withReading)!;
    if (idx.byKey.has(`${surface} [${reading}]`))
      return idx.byKey.get(`${surface} [${reading}]`)!;
  }
  if (basicForm && basicForm !== "*" && basicForm !== surface) {
    if (idx.byKey.has(basicForm)) return idx.byKey.get(basicForm)!;
  }
  return null;
}

/**
 * Discrete RED -> BLUE maturity gradient in 6 steps, keyed off the SRS
 * `interval` (days). A word in the deck with no/0 interval = step 0 (red).
 *
 * Buckets (interval in days):
 *   step 0: < 1    (#ef4444 red       — brand-new / learning)
 *   step 1: < 4    (#f97316 orange)
 *   step 2: < 11   (#eab308 yellow)
 *   step 3: < 30   (#22c55e green)
 *   step 4: < 90   (#06b6d4 cyan)
 *   step 5: >= 90  (#3b82f6 blue      — mature)
 */
export const PROGRESS_COLORS = [
  "#ef4444", // 0 red
  "#f97316", // 1 orange
  "#eab308", // 2 yellow
  "#22c55e", // 3 green
  "#06b6d4", // 4 cyan
  "#3b82f6", // 5 blue
] as const;

const PROGRESS_THRESHOLDS = [1, 4, 11, 30, 90]; // upper bounds (exclusive) for steps 0..4

/** Map an interval (days) into a 0..5 maturity bucket. */
export function progressBucket(intervalDays: number): number {
  const days = Math.max(0, intervalDays || 0);
  for (let i = 0; i < PROGRESS_THRESHOLDS.length; i++) {
    if (days < PROGRESS_THRESHOLDS[i]!) return i;
  }
  return 5;
}

/**
 * Color for a known word. No progress entry (or 0 interval) => step 0 red.
 * A word NOT in the deck should not call this (render no underline instead).
 */
export function progressColor(p?: ProgressEntry): string {
  const days = p ? Math.max(0, p.interval || 0) : 0;
  return PROGRESS_COLORS[progressBucket(days)]!;
}
