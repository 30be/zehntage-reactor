// Episode vocabulary coverage: % of lexical tokens whose word the learner
// already knows (Anki front match or the local zr.known set) plus the count of
// distinct unknown lemmas. Computed client-side with the kuromoji tokenizer,
// cached in localStorage keyed by (mediaId, ja track id, anki count, known
// count) so it only recomputes when the subs or the deck actually changed.

import { useEffect, useState } from "react";
import {
  api,
  type AnkiWordsResponse,
  type Cue,
  type LibraryEntry,
} from "./api.ts";
import { getTokenizer, isLexical } from "./tokenizer.ts";
import { buildWordIndex, matchFront, type WordIndex } from "./progress.ts";
import { wordKey } from "./TokenLine.tsx";
import { readBlacklist } from "./blacklist.ts";
import { isJaLang } from "./lang.ts";
import {
  parseOrSet,
  orSetMembers,
  orSetAdd,
  orSetRemove,
  serializeOrSet,
} from "./orset.ts";
import { emitVocabChanged } from "./sync.ts";

export interface Coverage {
  pct: number; // 0-100, rounded
  newCount: number; // distinct unknown lemmas
  // i+1 density: share (0-1) of non-empty cues with EXACTLY one unknown lexical
  // token — the cues that are instantly minable as clean cards. Drives the
  // "study next" curriculum ranking (web/curriculum.ts).
  i1density: number;
}

// v4: bumped for homograph-aware vocabKey keying (lemma|reading|pos) — the
// known/coverage unknown-set keys changed shape, so old lemma-only coverage
// caches must recompute.
// v3: bumped when interactive Anki adds switched to writing the dictionary
// (lemma) form as the card front, so cached coverage recomputes against the
// corrected lemma-add behaviour (all conjugations now match a single card).
export const CACHE_PREFIX = "zr.cov.v4.";

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
      i1density?: number;
    };
    if (
      v.trackId !== trackId ||
      v.ankiCount !== ankiCount ||
      v.knownCount !== knownCount ||
      // i1density was added later — treat older cache entries lacking it as a
      // miss so they get recomputed instead of surfacing undefined density.
      typeof v.i1density !== "number"
    )
      return null;
    return { pct: v.pct, newCount: v.newCount, i1density: v.i1density };
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
  // i+1 density: count cues with at least one lexical token, and of those how
  // many carry exactly one unknown lexical token.
  let cuesWithLex = 0;
  let i1cues = 0;
  for (const cue of cues) {
    let cueLex = 0;
    let cueUnknown = 0;
    for (const t of tok.tokenize(cue.text)) {
      if (!isLexical(t)) continue;
      lexical++;
      cueLex++;
      const key = wordKey(t);
      const isKnown =
        knownWords.has(key) ||
        matchFront(wordIndex, t.surface_form, t.reading, t.basic_form, t.pos) !=
          null;
      if (isKnown) known++;
      else {
        unknown.add(key);
        cueUnknown++;
      }
    }
    if (cueLex > 0) {
      cuesWithLex++;
      if (cueUnknown === 1) i1cues++;
    }
  }
  return {
    pct: lexical > 0 ? Math.round((known / lexical) * 100) : 100,
    newCount: unknown.size,
    i1density: cuesWithLex > 0 ? i1cues / cuesWithLex : 0,
  };
}

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
  const ja = tracks.find((t) => isJaLang(t.lang));
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

const KNOWN_KEY = "zr.known";

function readKnownRaw(): string | null {
  try {
    return localStorage.getItem(KNOWN_KEY);
  } catch {
    return null;
  }
}

/**
 * Read the local zr.known set (same storage the Player uses). The value is an
 * OR-Set (web/orset.ts); a legacy plain array is transparently migrated on read.
 */
export function readKnownWords(): Set<string> {
  return orSetMembers(parseOrSet(readKnownRaw(), Date.now()));
}

/**
 * Mark / un-mark a single lemma known, preserving OR-Set tombstones so removes
 * survive a concurrent stale add. Writes through localStorage (sync picks it up)
 * and notifies same-tab subscribers (Player/ReadRoute) to repaint.
 */
export function markKnown(key: string, on: boolean): void {
  try {
    const now = Date.now();
    let o = parseOrSet(readKnownRaw(), now);
    o = on ? orSetAdd(o, key, now) : orSetRemove(o, key, now);
    localStorage.setItem(KNOWN_KEY, serializeOrSet(o));
    emitVocabChanged([KNOWN_KEY]);
  } catch {
    /* ignore quota / private mode */
  }
}

/** Idle-time helper: resolves in an idle slice (setTimeout fallback). */
function idle(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    // Resolve immediately when aborted — a never-settling promise would leave
    // the caller's async loop suspended forever. Callers re-check the signal.
    if (signal.aborted) return resolve();
    const ric = (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void })
      .requestIdleCallback;
    if (typeof ric === "function") ric(() => resolve(), { timeout: 2000 });
    else setTimeout(resolve, 200);
  });
}

/**
 * Auto-compute per-episode coverage in idle time: one episode at a time, only
 * entries with subs, abortable on unmount. Never blocks the UI. Used by the
 * Library and Stats pages.
 *
 * `anki`: pass the page's already-loaded deck snapshot, or leave undefined to
 * have the hook fetch it; pass null while the page's own fetch is in flight
 * (the loop waits for the snapshot to arrive).
 */
export function useCoverage(
  entries: LibraryEntry[] | null,
  anki?: AnkiWordsResponse | null,
): Map<string, Coverage | null> {
  const [coverage, setCoverage] = useState<Map<string, Coverage | null>>(
    () => new Map(),
  );
  useEffect(() => {
    if (!entries || entries.length === 0) return;
    if (anki === null) return; // page snapshot still loading
    const ctrl = new AbortController();
    const { signal } = ctrl;
    void (async () => {
      const deck =
        anki ??
        (await api.ankiWords().catch(() => ({ words: [], progress: {} })));
      if (signal.aborted) return;
      const wordIndex = buildWordIndex(deck.words, deck.progress);
      // blacklisted lemmas count as "known" — excluded from coverage %
      const known = new Set([...readKnownWords(), ...readBlacklist()]);
      for (const e of entries) {
        if (signal.aborted) return;
        if (e.subLangs.length === 0) continue;
        await idle(signal);
        if (signal.aborted) return;
        try {
          const cov = await computeCoverage(
            e.id,
            wordIndex,
            known,
            deck.words.length,
            signal,
          );
          if (signal.aborted) return;
          setCoverage((prev) => new Map(prev).set(e.id, cov));
        } catch {
          /* skip this entry — tokenizer/network hiccup */
        }
      }
    })();
    return () => ctrl.abort();
  }, [entries, anki]);
  return coverage;
}
