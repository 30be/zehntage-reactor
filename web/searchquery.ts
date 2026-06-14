// Pure helpers for the global subtitle-search route (web/SearchRoute.tsx).
// No React, no timers, no I/O — unit-testable in isolation (tests/searchquery.test.ts).
//
// The server's /api/search normalizes both query and cue text the same way
// before matching (katakana→hiragana, lowercase). We mirror that here so the
// client-side highlight lands on the exact substring the server matched.

import { kataToHira } from "./tokenizer.ts";

/**
 * One transcript hit as returned by GET /api/search. `text` is always the JA
 * cue. The optional fields are present once the server also indexes RU sidecars:
 *   - `ru`        the paired RU translation of this cue (when one exists)
 *   - `matchedLang` which language the query actually matched on
 * Older servers omit these → JA-only behavior, fully backward-compatible.
 */
export interface SearchHit {
  mediaId: string;
  name: string;
  start: number;
  text: string;
  ru?: string;
  matchedLang?: "ja" | "ru";
}

/** Server-parity JA normalization: katakana→hiragana + lowercase. */
export function normalizeQuery(s: string): string {
  return kataToHira(s.trim().toLowerCase());
}

/** Server-parity RU normalization: lowercase + trim (kana-folding is JA-only). */
export function normalizeQueryRu(s: string): string {
  return s.trim().toLowerCase();
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
  return highlightSplitWith(text, query, normalizeQuery, (s) =>
    kataToHira(s.toLowerCase()),
  );
}

/** RU-language highlight: lowercase-only normalization (no kana folding). */
export function highlightSplitRu(text: string, query: string): HighlightSegment[] {
  return highlightSplitWith(text, query, normalizeQueryRu, (s) => s.toLowerCase());
}

/**
 * Highlight a hit for rendering. The JA line is always returned; the RU line is
 * returned when the hit carries one. Highlighting is applied only to the line
 * the query actually matched (per `matchedLang`, defaulting to JA for old hits).
 */
export function highlightHit(
  hit: SearchHit,
  query: string,
): { ja: HighlightSegment[]; ru: HighlightSegment[] | null } {
  const matchedRu = hit.matchedLang === "ru";
  return {
    ja: matchedRu
      ? [{ text: hit.text, match: false }]
      : highlightSplit(hit.text, query),
    ru:
      hit.ru == null
        ? null
        : matchedRu
          ? highlightSplitRu(hit.ru, query)
          : [{ text: hit.ru, match: false }],
  };
}

/** Length-preserving normalizers keep indices 1:1, so highlighted slices come
 * from the ORIGINAL (un-normalized) text. */
function highlightSplitWith(
  text: string,
  query: string,
  normQuery: (s: string) => string,
  normHay: (s: string) => string,
): HighlightSegment[] {
  const nq = normQuery(query);
  if (!nq) return [{ text, match: false }];
  const hay = normHay(text);
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
