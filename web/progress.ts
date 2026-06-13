// Map Anki learning progress to token text colors.

import type { AnkiWord, ProgressEntry } from "./api.ts";
import { kataToHira } from "./tokenizer.ts";

export interface WordIndex {
  // exact keys: the full front and "word [hiragana-reading]" -> front
  byKey: Map<string, string>;
  // bare word of bracketed fronts -> candidate cards WITH their reading, so a
  // token's reading can veto homograph matches (辛い[からい] ≠ 辛い(つらい)).
  bare: Map<string, Array<{ front: string; reading: string }>>;
  progress: Record<string, ProgressEntry>;
}

function indexFront(idx: WordIndex, front: string): void {
  idx.byKey.set(front, front);
  // front is "word" or "word [reading]".
  const m = front.match(/^(.+?)\s*\[(.+?)\]\s*$/);
  if (m) {
    const word = m[1]!.trim();
    const reading = kataToHira(m[2]!.trim());
    idx.byKey.set(`${word} [${reading}]`, front);
    const list = idx.bare.get(word);
    if (list) list.push({ front, reading });
    else idx.bare.set(word, [{ front, reading }]);
  }
}

export function buildWordIndex(
  words: AnkiWord[],
  progress: Record<string, ProgressEntry>,
): WordIndex {
  const idx: WordIndex = { byKey: new Map(), bare: new Map(), progress };
  for (const w of words) indexFront(idx, w.front);
  return idx;
}

/** Clone-with-extra-front: optimistic add path (instant token coloring). */
export function withFront(idx: WordIndex, front: string): WordIndex {
  const next: WordIndex = {
    byKey: new Map(idx.byKey),
    bare: new Map(idx.bare),
    progress: idx.progress,
  };
  // don't mutate a shared bare list — copy the bucket we touch
  const m = front.match(/^(.+?)\s*\[(.+?)\]\s*$/);
  if (m) {
    const word = m[1]!.trim();
    next.bare.set(word, [...(next.bare.get(word) ?? [])]);
  }
  indexFront(next, front);
  return next;
}

/** Clone-without-front: optimistic delete path. */
export function withoutFront(idx: WordIndex, front: string): WordIndex {
  const byKey = new Map<string, string>();
  for (const [k, f] of idx.byKey) if (f !== front) byKey.set(k, f);
  const bare = new Map<string, Array<{ front: string; reading: string }>>();
  for (const [k, list] of idx.bare) {
    const kept = list.filter((e) => e.front !== front);
    if (kept.length) bare.set(k, kept);
  }
  return { byKey, bare, progress: idx.progress };
}

/** Find the matching Anki front for a surface form (+ optional reading).
 *
 * Reading-aware: when the token has a reading, a bracketed card only matches
 * if its bracket reading agrees (kataToHira-normalized) — a 辛い[からい]
 * card never claims 辛い read as つらい. Readingless fronts (sentence cards,
 * legacy bare lemmas) match on exact text. Falls back to the dictionary form
 * (basic_form) so conjugated tokens like 食べた still match a 食べる card —
 * the surface reading can't be checked against the dictionary form there. */
export function matchFront(
  idx: WordIndex,
  surface: string,
  reading?: string,
  basicForm?: string,
): string | null {
  const hira = reading ? kataToHira(reading) : null;
  if (hira) {
    const f = idx.byKey.get(`${surface} [${hira}]`);
    if (f) return f;
  }
  // exact front text (readingless card, or a full "word [reading]" string)
  const exact = idx.byKey.get(surface);
  if (exact) return exact;
  if (!hira) {
    // no token reading to verify — accept any card for this bare word
    const cands = idx.bare.get(surface);
    if (cands && cands.length > 0) return cands[0]!.front;
  }
  if (basicForm && basicForm !== "*" && basicForm !== surface) {
    const exactBase = idx.byKey.get(basicForm);
    if (exactBase) return exactBase;
    const cands = idx.bare.get(basicForm);
    if (cands && cands.length > 0) return cands[0]!.front;
  }
  return null;
}

const PROGRESS_THRESHOLDS = [1, 4, 11, 30, 90]; // upper bounds (exclusive) for steps 0..4

/** Map an interval (days) into a 0..5 maturity bucket (TokenLine uses
 *  MATURE_BUCKET=4 to gate furigana display). */
export function progressBucket(intervalDays: number): number {
  const days = Math.max(0, intervalDays || 0);
  for (let i = 0; i < PROGRESS_THRESHOLDS.length; i++) {
    if (days < PROGRESS_THRESHOLDS[i]!) return i;
  }
  return 5;
}

// --- learning-word text color ------------------------------------------------
//
// Words in the deck render in BLUE that fades toward the ambient text color
// as the SRS interval grows (OKLCH interpolation, hue-aware). At >= 21 days
// (Anki "mature") the word is indistinguishable from plain text.
// Both the blue and the ambient are CSS custom properties resolved at the
// token: `--learn-blue` is per-context (darker on light bg, lighter on the
// dark overlay — see styles.css) so contrast clears AA in either place, and
// `--tok-ambient` (currentColor at the token) is what the blue fades into.

/** Fallback fresh-learning blue if `--learn-blue` is unset. */
export const LEARNING_BLUE = "oklch(0.65 0.15 250)";
/** Interval (days) at which a learning word reaches the ambient color. */
export const LEARNING_MATURE_DAYS = 21;

/**
 * Text color for a word IN the deck: blue -> ambient as interval grows.
 * Returns null at/after maturity (>= 21d) — render plain (ambient) text.
 * No progress entry (e.g. remote path without intervals) = fresh blue.
 */
export function learningColor(p?: ProgressEntry): string | null {
  const days = p ? Math.max(0, p.interval || 0) : 0;
  const t = Math.min(1, days / LEARNING_MATURE_DAYS);
  if (t >= 1) return null;
  const pct = Math.round((1 - t) * 100);
  return `color-mix(in oklch, var(--learn-blue, ${LEARNING_BLUE}) ${pct}%, var(--tok-ambient, currentColor))`;
}
