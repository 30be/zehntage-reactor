// G5 — "word of the day" / spaced resurfacing. Pure, deterministic picker for a
// single previously-learned deck word to passively re-expose on Home each day.
//
// The core (pickWordOfDay) is impurity-free: it takes the deck word list, an
// optional progress map (interval/reps → "maturity") and a YYYY-MM-DD day seed,
// and deterministically returns ONE word — stable for a given day, rotating
// across days, preferring mature/known cards. Date.now lives only at the edge
// (the component derives today's string via statsfmt.localDateStr and passes it
// in). A thin localStorage wrapper caches today's pick so it doesn't re-shuffle
// on every reload.

export interface WordDayCard {
  /** Anki front, e.g. "勉強 [べんきょう]". */
  front: string;
  /** Anki back / meaning. */
  back: string;
  /** Optional explicit reading (some payloads carry it alongside the front). */
  reading?: string;
}

export interface WordDayProgress {
  /** SRS interval in days (bigger → more mature). */
  interval?: number;
  reps?: number;
  lapses?: number;
}

export interface WordOfDay {
  /** Bare headword, reading stripped out of the front. */
  word: string;
  /** Reading (from explicit field, else parsed from "word [reading]"). */
  reading: string;
  /** Meaning / back. */
  meaning: string;
  /** The original front (for encounter lookups by lemma). */
  front: string;
}

/** Bare word of a front ("word [reading]" → "word"). */
function bareWord(front: string): string {
  return front.replace(/\s*\[.*$/, "").trim();
}

/** Reading parsed from a "word [reading]" front, or "" when absent. */
function readingOfFront(front: string): string {
  const m = front.match(/\[([^\]]*)\]/);
  return m ? m[1]!.trim() : "";
}

/**
 * Stable 32-bit hash of a string (FNV-1a). Deterministic across runs/platforms.
 */
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Day index = integer days since the epoch for a YYYY-MM-DD string. */
function dayIndex(day: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return hash32(day); // unparseable seed → still deterministic
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Math.floor(t / 86_400_000);
}

/**
 * Maturity score for ranking: mature, well-reviewed cards float to the front of
 * the candidate pool so we resurface words the learner actually knows (not raw
 * brand-new adds). Higher = more mature.
 */
function maturity(p: WordDayProgress | undefined): number {
  if (!p) return 0;
  const interval = Number.isFinite(p.interval) ? Math.max(0, p.interval!) : 0;
  const reps = Number.isFinite(p.reps) ? Math.max(0, p.reps!) : 0;
  return interval + reps;
}

/**
 * Deterministically pick the word of the day.
 *
 * - Filters to usable cards (non-empty front + back).
 * - Ranks by maturity (mature first), and within the SAME maturity by a stable
 *   per-front hash so order is total & deterministic regardless of input order.
 * - Restricts to the top "mature pool" (cards whose maturity >= the median of
 *   the ranked list, but always at least one) so we prefer known words, then
 *   rotates within that pool by the day index → stable per day, different across
 *   days.
 * - Empty / all-unusable deck → null.
 */
export function pickWordOfDay(
  cards: readonly WordDayCard[],
  progress: Readonly<Record<string, WordDayProgress>> | undefined,
  day: string,
): WordOfDay | null {
  const usable = cards.filter(
    (c) => c && typeof c.front === "string" && c.front.trim() !== "" &&
      typeof c.back === "string" && c.back.trim() !== "",
  );
  if (usable.length === 0) return null;

  const prog = progress ?? {};
  const ranked = [...usable].sort((a, b) => {
    const ma = maturity(prog[a.front]);
    const mb = maturity(prog[b.front]);
    if (mb !== ma) return mb - ma; // mature first
    return hash32(a.front) - hash32(b.front); // stable tiebreak
  });

  // Prefer the more-mature half (always keep >=1). With no progress at all this
  // is just the whole deck (all maturity 0).
  const poolSize = Math.max(1, Math.ceil(ranked.length / 2));
  const pool = ranked.slice(0, poolSize);

  const idx = ((dayIndex(day) % pool.length) + pool.length) % pool.length;
  const chosen = pool[idx]!;

  return {
    word: bareWord(chosen.front),
    reading: (chosen.reading && chosen.reading.trim()) ||
      readingOfFront(chosen.front),
    meaning: chosen.back.trim(),
    front: chosen.front,
  };
}

// --- thin localStorage cache (edge; not used by the pure tests) -------------

export const WORDDAY_KEY = "zr.wordday.pick";

interface CachedPick {
  day: string;
  pick: WordOfDay;
}

/** Today's cached pick if it matches `day`, else null. */
export function loadCachedWordOfDay(day: string): WordOfDay | null {
  try {
    const raw = localStorage.getItem(WORDDAY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedPick;
    return parsed && parsed.day === day && parsed.pick ? parsed.pick : null;
  } catch {
    return null;
  }
}

/** Persist today's pick so reloads stay stable without recomputing. */
export function saveCachedWordOfDay(day: string, pick: WordOfDay): void {
  try {
    localStorage.setItem(WORDDAY_KEY, JSON.stringify({ day, pick }));
  } catch {
    /* ignore quota / disabled storage */
  }
}
