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
    if (hira) {
      // reading-aware bracket lookup on the dictionary form first
      const f = idx.byKey.get(`${basicForm} [${hira}]`);
      if (f) return f;
    }
    const exactBase = idx.byKey.get(basicForm);
    if (exactBase) return exactBase;
    const cands = idx.bare.get(basicForm);
    // This branch is only reached for a CONJUGATED token (surface !== basicForm,
    // guarded above). The token's surface reading (食べた → タベタ) can't be
    // checked against the dictionary-form card reading (たべる), so we accept the
    // lemma match without a reading veto — that's how 食べた lights up a 食べる
    // card. The uninflected homograph veto (辛い[からい] ≠ 辛い read つらい) is
    // already enforced upstream: with a reading present, an uninflected token
    // only matches via the exact bracket lookup at the top, else falls through
    // to null. The reading-aware dict-form bracket lookup above (`basicForm
    // [hira]`) still gives precise homograph matches when the reading IS known.
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
/** Fallback unknown-red hue intent (the per-context `--tok-unk` in styles.css
 *  resolves to AA-clearing literals: #9e2f3a on light, #f2a0a8 on dark). */
export const UNKNOWN_RED = "#b35454";
/** Interval (days) at which a learning word reaches the ambient color. */
export const LEARNING_MATURE_DAYS = 21;
/**
 * Max fraction (0..1) an overdue word's color is pulled back toward the
 * unknown-red. Kept SUBTLE so it reads as a tint, not a full red repaint.
 */
export const MAX_DECAY = 0.55;
/**
 * Interval (days) at which an overdue word reaches MAX_DECAY. A mature card
 * that has gone overdue is the strongest "I'm forgetting this" signal — the
 * longer you'd been retaining it, the more it should visibly rot. (We can't
 * read true days-overdue: the server leaves Anki's `due` column undecoded —
 * days-vs-epoch is queue-dependent — so isDue is the only reliable overdue
 * signal client-side; interval modulates HOW MUCH a due word rots.)
 */
export const DECAY_FULL_DAYS = LEARNING_MATURE_DAYS;

/**
 * Retention-decay factor 0..1 for a deck word: how far its color is dragged
 * back toward the unknown-red. 0 unless the word is currently overdue
 * (`isDue`). For overdue words it scales with the card's interval (more
 * mature = more alarming rot), clamped to MAX_DECAY. Non-overdue words and
 * words with no progress entry never decay.
 */
export function decayFactor(p?: ProgressEntry): number {
  if (!p || p.isDue !== true) return 0;
  const days = Math.max(0, p.interval || 0);
  const t = Math.min(1, days / DECAY_FULL_DAYS);
  return t * MAX_DECAY;
}

/**
 * Text color for a word IN the deck.
 *
 * Base: blue -> ambient as the SRS interval grows (OKLCH interpolation).
 * At/after maturity (>= 21d) the base is the ambient color (returns null
 * only when there is NO decay to apply, so the token renders plain text).
 *
 * Retention decay: if the word is currently OVERDUE (`isDue`), the base
 * color is additionally pulled a fraction (`decayFactor`) toward the
 * unknown-red so neglected words visibly "rot" and stand out for review.
 * Non-overdue words keep the unchanged blue->ambient interpolation.
 */
export function learningColor(p?: ProgressEntry): string | null {
  const days = p ? Math.max(0, p.interval || 0) : 0;
  const t = Math.min(1, days / LEARNING_MATURE_DAYS);
  const bluePct = Math.round((1 - t) * 100);
  const base =
    t >= 1
      ? "var(--tok-ambient, currentColor)"
      : `color-mix(in oklch, var(--learn-blue, ${LEARNING_BLUE}) ${bluePct}%, var(--tok-ambient, currentColor))`;

  const decay = decayFactor(p);
  if (decay <= 0) return t >= 1 ? null : base;

  const redPct = Math.round(decay * 100);
  return `color-mix(in oklch, var(--tok-unk, ${UNKNOWN_RED}) ${redPct}%, ${base})`;
}
