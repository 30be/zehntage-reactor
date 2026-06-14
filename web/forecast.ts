// Pure helpers for the Review/Cram "SRS due-forecast histogram" (G3).
//
// DOM-free + network-free so `bun test` covers them fully; ReviewRoute.tsx only
// renders the buckets these emit.
//
// GOAL: from the deck's progress entries, estimate how many cards become due
// over the coming days (today, +1, +2, … +N), so the learner sees their
// upcoming review load.
//
// SIGNAL & HONEST LIMITATIONS
// ---------------------------
// Per card the client has (ProgressEntry): `interval` (days), `isDue`,
// `daysOverdue` (whole days a review card is overdue, >= 0), `due` (Anki's
// queue-dependent column — ambiguous without the collection's "today" day, so
// we deliberately DON'T decode it), `queue`, `type`.
//
// We do NOT have each card's last-review timestamp on the client, so we cannot
// pin a precise FUTURE due date. We therefore build the most honest histogram
// the available signal allows:
//
//   • Bucket 0 ("due now"): every card that is currently due — `isDue === true`
//     OR `daysOverdue > 0`. These need reviewing today.
//
//   • Future buckets (1..N): a not-currently-due review card with interval `d`
//     will come due at the EARLIEST in ~`d` days (it can't come due sooner than
//     its own interval from a just-completed review). With no last-review signal
//     this earliest-possible day is the only defensible estimate, so we place
//     such a card at `min(d, N)` days out. This is an approximation of the
//     upcoming load, NOT an exact schedule — a card last reviewed a while ago is
//     really due sooner than `d`, but without `mod` we can't know by how much.
//
//   • Cards we can't schedule (new cards / interval <= 0 / no progress and not
//     due) are excluded from the future buckets (they have no review date yet).
//
// Buckets beyond the window are clamped into the last bucket (N).

import type { ProgressEntry } from "./api.ts";

/** One histogram column: `count` cards become due `dayOffset` days from today. */
export interface ForecastBucket {
  /** 0 = due now / overdue; 1..N = days from today. */
  dayOffset: number;
  count: number;
}

/** Default forecast window: today + 14 days (15 buckets, 0..14). */
export const FORECAST_WINDOW = 14;

/** A card is due right now when Anki flags it or our overdue estimate is > 0. */
function isDueNow(p: ProgressEntry): boolean {
  if (p.isDue === true) return true;
  if (typeof p.daysOverdue === "number" && p.daysOverdue > 0) return true;
  return false;
}

/**
 * Estimated whole-day offset (>= 0) at which a card next becomes due, or `null`
 * when the card has no defensible review date (new / interval <= 0).
 *
 * Due-now cards → 0. Otherwise the earliest-possible next due is the card's
 * interval (see module note); clamped to [0, window].
 */
export function estimateDueOffset(
  p: ProgressEntry,
  window: number = FORECAST_WINDOW,
): number | null {
  if (isDueNow(p)) return 0;
  const interval = p.interval;
  if (typeof interval !== "number" || !Number.isFinite(interval) || interval <= 0) {
    // New card / learning card / unknown: no scheduled review date to forecast.
    return null;
  }
  const offset = Math.round(interval);
  if (offset <= 0) return 0;
  return Math.min(offset, window);
}

/**
 * Bucket the deck's progress entries into day-offset buckets [0..window].
 * Always returns `window + 1` buckets in ascending dayOffset order (counts 0
 * when nothing falls in a day), so the histogram has a stable shape.
 *
 * Deterministic: depends only on the progress entries + window (no Date.now).
 * Cards with no schedulable due date are skipped.
 */
export function buildForecast(
  progress: Record<string, ProgressEntry>,
  window: number = FORECAST_WINDOW,
): ForecastBucket[] {
  const w = Number.isFinite(window) && window >= 0 ? Math.floor(window) : FORECAST_WINDOW;
  const counts = new Array<number>(w + 1).fill(0);
  for (const key of Object.keys(progress)) {
    const p = progress[key];
    if (!p) continue;
    const offset = estimateDueOffset(p, w);
    if (offset == null) continue;
    counts[offset] = (counts[offset] ?? 0) + 1;
  }
  return counts.map((count, dayOffset) => ({ dayOffset, count }));
}

/** Total cards represented across all buckets (for empty-state / a11y labels). */
export function forecastTotal(buckets: ForecastBucket[]): number {
  return buckets.reduce((s, b) => s + b.count, 0);
}
