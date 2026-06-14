// Pure helpers for the global subtitle-search route (web/SearchRoute.tsx).
// No React, no timers, no I/O — unit-testable in isolation (tests/searchquery.test.ts).
//
// The server's /api/search normalizes both query and cue text the same way
// before matching (katakana→hiragana, lowercase). We mirror that here so the
// client-side highlight lands on the exact substring the server matched.

import { kataToHira } from "./tokenizer.ts";

/** One transcript hit as returned by GET /api/search (shape is JA-only). */
export interface SearchHit {
  mediaId: string;
  name: string;
  start: number;
  text: string;
}

/** Server-parity normalization: katakana→hiragana + lowercase. */
export function normalizeQuery(s: string): string {
  return kataToHira(s.trim().toLowerCase());
}

/** A run of cue text; `match` marks the segment(s) that matched the query. */
export interface HighlightSegment {
  text: string;
  match: boolean;
}

/**
 * Split a cue's text into alternating non-match / match segments around every
 * occurrence of the (normalized) query. Length-preserving normalization means
 * indices in the normalized string map 1:1 back onto the original text, so the
 * highlighted slices are the original (un-normalized) characters.
 *
 * Empty / whitespace-only query → single non-match segment (whole text).
 * No match → single non-match segment (whole text).
 */
export function highlightSplit(text: string, query: string): HighlightSegment[] {
  const nq = normalizeQuery(query);
  if (!nq) return [{ text, match: false }];
  const hay = kataToHira(text.toLowerCase());
  const segments: HighlightSegment[] = [];
  let from = 0;
  let i = hay.indexOf(nq, from);
  if (i < 0) return [{ text, match: false }];
  while (i >= 0) {
    if (i > from) segments.push({ text: text.slice(from, i), match: false });
    segments.push({ text: text.slice(i, i + nq.length), match: true });
    from = i + nq.length;
    i = hay.indexOf(nq, from);
  }
  if (from < text.length) segments.push({ text: text.slice(from), match: false });
  return segments;
}

/** A group of hits for one episode, preserving server (start) ordering. */
export interface SearchGroup {
  mediaId: string;
  name: string;
  hits: SearchHit[];
}

/**
 * Group hits by episode (mediaId), preserving first-seen order of both groups
 * and hits within a group (the server returns hits already sorted per entry).
 */
export function groupByEpisode(hits: SearchHit[]): SearchGroup[] {
  const order: string[] = [];
  const byId = new Map<string, SearchGroup>();
  for (const h of hits) {
    let g = byId.get(h.mediaId);
    if (!g) {
      g = { mediaId: h.mediaId, name: h.name, hits: [] };
      byId.set(h.mediaId, g);
      order.push(h.mediaId);
    }
    g.hits.push(h);
  }
  return order.map((id) => byId.get(id)!);
}

/** Strip a trailing file extension from an episode name for display. */
export function displayName(name: string): string {
  return name.replace(/\.[^.]+$/, "");
}

/** "m:ss" timestamp (mirrors App.fmtCueTime, duplicated to stay pure/testable). */
export function fmtTimestamp(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Deep-link hash into the player at a given cue start. */
export function cueLink(mediaId: string, start: number): string {
  return `#/play/${mediaId}@${start}`;
}

/**
 * Flatten groups back into a single ordered hit list — used to drive a single
 * keyboard-selection index across grouped rendering.
 */
export function flatHits(groups: SearchGroup[]): SearchHit[] {
  return groups.flatMap((g) => g.hits);
}
