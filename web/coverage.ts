// Episode vocabulary coverage: % of lexical tokens whose word the learner
// already knows (Anki front match or the local zr.known set) plus the count of
// distinct unknown lemmas. Computed client-side with the kuromoji tokenizer,
// cached in localStorage keyed by (mediaId, ja track id, anki count, known
// count) so it only recomputes when the subs or the deck actually changed.

import { api, type Cue } from "./api.ts";
import { getTokenizer, isLexical } from "./tokenizer.ts";
import { matchFront, type WordIndex } from "./progress.ts";
import { wordKey } from "./TokenLine.tsx";

export interface Coverage {
  pct: number; // 0-100, rounded
  newCount: number; // distinct unknown lemmas
}

const CACHE_PREFIX = "zr.cov.";

// Cache key deliberately does NOT include the cue count: knowing it would
// require downloading the full cue list, which is exactly the expensive call
// the cache exists to avoid. trackId changes when subs are regenerated, and
// ankiCount/knownCount change when the deck or zr.known set changes.
function readCache(
  mediaId: string,
  trackId: string,
  ankiCount: number,
  knownCount: number,
): Coverage | null {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + mediaId);
    if (!raw) return null;
    const v = JSON.parse(raw) as {
      trackId: string;
      ankiCount: number;
      knownCount: number;
      pct: number;
      newCount: number;
    };
    if (
      v.trackId !== trackId ||
      v.ankiCount !== ankiCount ||
      v.knownCount !== knownCount
    )
      return null;
    return { pct: v.pct, newCount: v.newCount };
  } catch {
    return null;
  }
}

function writeCache(
  mediaId: string,
  trackId: string,
  ankiCount: number,
  knownCount: number,
  cov: Coverage,
): void {
  try {
    localStorage.setItem(
      CACHE_PREFIX + mediaId,
      JSON.stringify({ trackId, ankiCount, knownCount, ...cov }),
    );
  } catch {
    /* ignore quota */
  }
}

/** Pure computation over already-fetched cues (also used by tests). */
export async function coverageOfCues(
  cues: Cue[],
  wordIndex: WordIndex,
  knownWords: Set<string>,
): Promise<Coverage> {
  const tok = await getTokenizer();
  let lexical = 0;
  let known = 0;
  const unknown = new Set<string>();
  for (const cue of cues) {
    for (const t of tok.tokenize(cue.text)) {
      if (!isLexical(t)) continue;
      lexical++;
      const key = wordKey(t);
      const isKnown =
        knownWords.has(key) ||
        matchFront(wordIndex, t.surface_form, t.reading, t.basic_form) != null;
      if (isKnown) known++;
      else unknown.add(key);
    }
  }
  return {
    pct: lexical > 0 ? Math.round((known / lexical) * 100) : 100,
    newCount: unknown.size,
  };
}

const isJa = (l: string) => l === "ja" || l === "jpn" || l.startsWith("ja");

/**
 * Coverage for one library entry. Returns null when it has no ja track.
 * Checks the localStorage cache first; `signal` aborts between steps.
 */
export async function computeCoverage(
  mediaId: string,
  wordIndex: WordIndex,
  knownWords: Set<string>,
  ankiCount: number,
  signal?: AbortSignal,
): Promise<Coverage | null> {
  const tracks = await api.subs(mediaId);
  if (signal?.aborted) return null;
  const ja = tracks.find((t) => isJa(t.lang));
  if (!ja) return null;
  // Check the cache BEFORE fetching cues — the whole point is to skip the
  // heavy per-episode cue download on repeat library visits.
  const cached = readCache(mediaId, ja.id, ankiCount, knownWords.size);
  if (cached) return cached;
  const cues = await api.cues(mediaId, ja.id);
  if (signal?.aborted) return null;
  const cov = await coverageOfCues(cues, wordIndex, knownWords);
  if (signal?.aborted) return null;
  writeCache(mediaId, ja.id, ankiCount, knownWords.size, cov);
  return cov;
}

/** Read the local zr.known set (same storage the Player uses). */
export function readKnownWords(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem("zr.known") ?? "[]");
    return new Set(
      Array.isArray(raw) ? raw.filter((w) => typeof w === "string") : [],
    );
  } catch {
    return new Set();
  }
}
