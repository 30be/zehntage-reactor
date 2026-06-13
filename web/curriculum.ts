// Pure "study next" curriculum ranking. Given per-episode comprehensibility
// signals we ALREADY collect (web/coverage.ts: known-word % and i+1 density),
// score each episode by learning value and surface the best next one.
//
// DOM-free + dependency-free so bun test covers it without a browser.
//
// Learning value favours episodes that are:
//   - rich in i+1 cues (exactly one unknown lexical token — instantly minable),
//   - in the comfortable comprehension band (not too hard, not too easy).
//
// The known-% band uses a triangular sweet-spot centred on TARGET_KNOWN: an
// episode you already understand fully teaches nothing, and one where almost
// everything is unknown is noise. Both ends taper the score to zero.

/** Per-episode signals consumed by the ranker (subset of web/coverage.ts). */
export interface EpisodeSignal {
  id: string;
  pct: number; // known-word %, 0-100
  i1density: number; // share of cues with exactly one unknown, 0-1
}

export interface RankedEpisode extends EpisodeSignal {
  score: number; // learning value, 0-1 (higher = better next study target)
}

// The comprehension sweet spot: ~80% known is the classic comprehensible-input
// target — enough scaffolding to follow along, enough novelty to learn.
export const TARGET_KNOWN = 80;
// How far either side of the target before learning value hits zero.
export const KNOWN_SPREAD = 40; // band ≈ [40%, 100%]

/** Triangular 0-1 band weight: 1 at TARGET_KNOWN, tapering to 0 at the edges. */
export function knownBand(pct: number): number {
  const d = Math.abs(pct - TARGET_KNOWN);
  return Math.max(0, 1 - d / KNOWN_SPREAD);
}

/**
 * Learning value for one episode, 0-1. i+1 density is the primary driver
 * (clean minable cards); the comprehension band gates it so a dense-but-brutal
 * or dense-but-trivial episode is discounted.
 */
export function learningValue(s: EpisodeSignal): number {
  const band = knownBand(s.pct);
  const density = Math.max(0, Math.min(1, s.i1density));
  // Weighted blend: density dominates, band modulates. Pure multiply would
  // zero out otherwise-good episodes sitting just outside the band, so keep a
  // floor of band influence via the 0.25 baseline.
  return density * (0.25 + 0.75 * band);
}

/**
 * Rank episodes by descending learning value. Ties (and equal scores) fall
 * back to id for a stable, deterministic order. Episodes whose signals are
 * missing should be filtered out by the caller before ranking.
 */
export function rankEpisodes(signals: EpisodeSignal[]): RankedEpisode[] {
  return signals
    .map((s) => ({ ...s, score: learningValue(s) }))
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * The single best "study next" episode id, or null when there's nothing worth
 * recommending (no signals, or every candidate scores zero — e.g. all fully
 * known or no i+1 cues anywhere).
 */
export function studyNext(signals: EpisodeSignal[]): string | null {
  const ranked = rankEpisodes(signals);
  const top = ranked[0];
  return top && top.score > 0 ? top.id : null;
}
