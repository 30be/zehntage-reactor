// jpdb-inspired mining queries over the per-entry lemma indexes.
//
// WIRING CONTRACT (for the integration agent):
//   - All functions are pure over EntryIndex objects (src/lib/tokenindex.ts);
//     the server route handler gathers indexes via getIndex() and calls these.
//   - Suggested routes:
//       GET /api/mining/show-freq?ids=a,b   -> [{lemma, count}] (showFrequency)
//       GET /api/mining/prestudy?ids=...    -> ranked lemmas (prestudyRank
//                                              with loadGlobalFreq())
//       GET /api/mining/iplusone?lemma=...  -> IPlusOneHit[] (iPlusOne; the
//                                              caller supplies knownSet from
//                                              Anki fronts + zr.known, and the
//                                              blacklist from zr.blacklist)
//   - Blacklist storage: client keeps it in localStorage "zr.blacklist" as a
//     JSON string[]; ships to the server inside the request body/query.

import type { EntryIndex, CueRef } from "./tokenindex.ts";

// --- show-local frequency ----------------------------------------------------

/** lemma -> total occurrences across the given entries ("show frequency"). */
export function showFrequency(indexes: Iterable<EntryIndex>): Map<string, number> {
  const out = new Map<string, number>();
  for (const ix of indexes) {
    for (const [lemma, info] of ix.lemmas) {
      out.set(lemma, (out.get(lemma) ?? 0) + info.count);
    }
  }
  return out;
}

// --- prestudy ranking ----------------------------------------------------------

/**
 * Combined prestudy score. FORMULA: primary key = show-local count
 * (descending — the more this show uses a word, the sooner to learn it);
 * tie-break = global frequency rank (ascending — commoner overall wins).
 * Unranked-globally words get rank Infinity (sort last among equals).
 * Returned as a single comparable number: count * 1e7 - min(globalRank, 1e7-1),
 * so HIGHER score = study FIRST.
 */
export function prestudyRank(
  lemma: string,
  showFreqMap: Map<string, number>,
  globalRank: Map<string, number>,
): number {
  const count = showFreqMap.get(lemma) ?? 0;
  const rank = globalRank.get(lemma) ?? 1e7 - 1;
  return count * 1e7 - Math.min(rank, 1e7 - 1);
}

/** All lemmas of the show, best-to-study first (see prestudyRank formula). */
export function prestudyOrder(
  showFreqMap: Map<string, number>,
  globalRank: Map<string, number>,
): string[] {
  return [...showFreqMap.keys()].sort(
    (a, b) =>
      prestudyRank(b, showFreqMap, globalRank) -
      prestudyRank(a, showFreqMap, globalRank),
  );
}

/** Load public/freq.json (rank = index + 1) for prestudy tie-breaking. */
export async function loadGlobalFreq(
  path = new URL("../../public/freq.json", import.meta.url).pathname,
): Promise<Map<string, number>> {
  const words = (await Bun.file(path).json()) as string[];
  const m = new Map<string, number>();
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (!m.has(w)) m.set(w, i + 1);
  }
  return m;
}

// --- i+1 sentence search -------------------------------------------------------

export interface IPlusOneHit {
  mediaId: string;
  cue: CueRef;
}

/**
 * Cues containing `targetLemma` where EVERY other lexical lemma is in
 * knownSet ∪ blacklist — i.e. exactly one unknown (the target). Best 3,
 * shortest cue text first (short sentences make cleaner cards).
 *
 * Implementation detail: EntryIndex stores example cues per lemma, so for a
 * candidate cue of the target we check, for every OTHER lemma in the entry,
 * whether that lemma also lists this cue index — no re-tokenization needed.
 */
export function iPlusOne(
  targetLemma: string,
  indexes: Iterable<EntryIndex>,
  knownSet: Set<string>,
  blacklist: Set<string> = new Set(),
): IPlusOneHit[] {
  const ok = (lemma: string) =>
    lemma === targetLemma || knownSet.has(lemma) || blacklist.has(lemma);
  const hits: IPlusOneHit[] = [];
  for (const ix of indexes) {
    const target = ix.lemmas.get(targetLemma);
    if (!target) continue;
    // cue idx -> set of lemmas occurring there (built once per entry)
    const cueLemmas = new Map<number, string[]>();
    for (const [lemma, info] of ix.lemmas) {
      for (const c of info.cues) {
        let arr = cueLemmas.get(c.idx);
        if (!arr) cueLemmas.set(c.idx, (arr = []));
        arr.push(lemma);
      }
    }
    for (const cue of target.cues) {
      const lemmas = cueLemmas.get(cue.idx) ?? [targetLemma];
      if (lemmas.every(ok)) hits.push({ mediaId: ix.mediaId, cue });
    }
  }
  hits.sort((a, b) => a.cue.text.length - b.cue.text.length);
  return hits.slice(0, 3);
}

// --- blacklist plumbing ----------------------------------------------------------

/** Lemmas the user never wants counted as "unknown" (names, onomatopoeia…). */
export type Blacklist = Set<string>;

export function parseBlacklist(raw: unknown): Blacklist {
  return new Set(
    Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [],
  );
}

/** Strip blacklisted lemmas out of an unknown-lemma count map. */
export function filterCounts(
  unknownLemmas: Map<string, number>,
  blacklist: Blacklist,
): Map<string, number> {
  if (blacklist.size === 0) return new Map(unknownLemmas);
  const out = new Map<string, number>();
  for (const [lemma, n] of unknownLemmas) {
    if (!blacklist.has(lemma)) out.set(lemma, n);
  }
  return out;
}
