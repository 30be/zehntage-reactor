// Per-library-entry lemma index built with kuromoji on the server (Bun).
//
// The dictionary ships inside the @sglkc/kuromoji package
// (node_modules/@sglkc/kuromoji/dict/*.dat.gz); the builder accepts that
// directory as a filesystem dicPath.

import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import kuromoji from "@sglkc/kuromoji";
import type { Cue } from "./subs.ts";
import type { LibraryEntry } from "./library.ts";
import { mergeTokens, isLexical, lemmaOf, type KToken } from "./jatok.ts";

// Internal index version. Bump when the index key shape changes so the
// in-memory mtime-keyed cache cannot serve stale entries across a hot reload
// that keeps the process alive. Folded into the per-entry cache key.
const INDEX_VERSION = "v2-homograph";

export type Tokenize = (text: string) => KToken[];

/** Path to the IPADIC bundled with @sglkc/kuromoji, or null if not found. */
export function defaultDicPath(): string | null {
  try {
    const req = createRequire(import.meta.url);
    const pkg = req.resolve("@sglkc/kuromoji/package.json");
    const dict = join(dirname(pkg), "dict");
    return existsSync(join(dict, "base.dat.gz")) ? dict : null;
  } catch {
    return null;
  }
}

let tokenizerPromise: Promise<Tokenize> | null = null;

/** Lazily-built, cached server-side tokenizer (mergeTokens applied). */
export function getServerTokenizer(dicPath?: string): Promise<Tokenize> {
  if (!tokenizerPromise) {
    tokenizerPromise = new Promise<Tokenize>((resolve, reject) => {
      const dic = dicPath ?? defaultDicPath();
      if (!dic) {
        reject(new Error("kuromoji dictionary not found in node_modules"));
        return;
      }
      kuromoji
        .builder({ dicPath: dic.endsWith("/") ? dic : dic + "/" })
        .build((err, tok) => {
          if (err) reject(err);
          else resolve((text: string) => mergeTokens(tok.tokenize(text)));
        });
    });
    tokenizerPromise.catch(() => {
      tokenizerPromise = null; // allow retry after failure
    });
  }
  return tokenizerPromise;
}

export interface CueRef {
  /** Index into the cues array the entry was indexed with. */
  idx: number;
  /** Cue start, seconds. */
  start: number;
  text: string;
}

export interface LemmaInfo {
  /** Total occurrences across the entry. */
  count: number;
  /** Example cues, capped at MAX_CUES_PER_LEMMA. */
  cues: CueRef[];
}

export interface EntryIndex {
  mediaId: string;
  lemmas: Map<string, LemmaInfo>;
  /** Total lexical token occurrences (denominator for comprehensibility). */
  totalLexical: number;
}

const MAX_CUES_PER_LEMMA = 20;

/** Build the lemma index for one library entry from its cues. */
export async function buildEntryIndex(
  entry: Pick<LibraryEntry, "id">,
  cues: Cue[],
  tokenize?: Tokenize,
): Promise<EntryIndex> {
  const tok = tokenize ?? (await getServerTokenizer());
  const lemmas = new Map<string, LemmaInfo>();
  let totalLexical = 0;
  for (let idx = 0; idx < cues.length; idx++) {
    const cue = cues[idx]!;
    const seenInCue = new Set<string>();
    for (const t of tok(cue.text)) {
      if (!isLexical(t)) continue;
      totalLexical++;
      const lemma = lemmaOf(t);
      let info = lemmas.get(lemma);
      if (!info) {
        info = { count: 0, cues: [] };
        lemmas.set(lemma, info);
      }
      info.count++;
      // one example per cue, capped
      if (!seenInCue.has(lemma) && info.cues.length < MAX_CUES_PER_LEMMA) {
        info.cues.push({ idx, start: cue.start, text: cue.text });
        seenInCue.add(lemma);
      }
    }
  }
  return { mediaId: entry.id, lemmas, totalLexical };
}

// --- in-memory library index with mtime-based invalidation ------------------

interface CacheSlot {
  /** Fingerprint of every file the cues may come from (media + sidecars). */
  key: string;
  index: Promise<EntryIndex>;
}

const indexCache = new Map<string, CacheSlot>();

// Per-entry in-flight guard: getIndex awaits file stats BEFORE it can check
// the cache, so two concurrent callers for the same entry both miss it and
// tokenize twice (stampede — e.g. the library page firing the due-badge and
// comprehensibility queries at once). Serializing per entry id lets the
// second caller hit the cache the first one populated.
const entryLocks = new Map<string, Promise<unknown>>();

async function fileSig(path: string): Promise<string> {
  try {
    const st = await stat(path);
    return `${path}:${st.mtimeMs}:${st.size}`;
  } catch {
    return `${path}:gone`; // unstat-able file still participates in the key
  }
}

/**
 * Cached index for a library entry. The cues come from sidecar subtitle files
 * (or the media container itself), so the cache key fingerprints the media
 * file AND every sidecar sub — regenerating/editing a sidecar invalidates the
 * index even though the media file is untouched. `cuesProvider` is only
 * called on (re)build.
 */
export async function getIndex(
  entry: LibraryEntry,
  cuesProvider: () => Promise<Cue[]>,
  tokenize?: Tokenize,
): Promise<EntryIndex> {
  const prev = entryLocks.get(entry.id) ?? Promise.resolve();
  const run = prev
    .catch(() => {}) // a failed predecessor must not poison the chain
    .then(() => getIndexUnlocked(entry, cuesProvider, tokenize));
  const tail = run.catch(() => {});
  entryLocks.set(entry.id, tail);
  try {
    return await run;
  } finally {
    // drop the chain tail once settled so the map stays library-sized
    if (entryLocks.get(entry.id) === tail) entryLocks.delete(entry.id);
  }
}

async function getIndexUnlocked(
  entry: LibraryEntry,
  cuesProvider: () => Promise<Cue[]>,
  tokenize?: Tokenize,
): Promise<EntryIndex> {
  const sources = [entry.absPath, ...entry.sidecarSubs.map((s) => s.path)];
  const key =
    INDEX_VERSION + "|" + (await Promise.all(sources.map(fileSig))).join("|");
  const hit = indexCache.get(entry.id);
  if (hit && hit.key === key) return hit.index;
  const index = (async () =>
    buildEntryIndex(entry, await cuesProvider(), tokenize))();
  indexCache.set(entry.id, { key, index });
  index.catch(() => {
    // don't cache failures
    if (indexCache.get(entry.id)?.index === index) indexCache.delete(entry.id);
  });
  return index;
}

/** Drop all cached entry indexes (tests / library rescans). */
export function clearIndexCache(): void {
  indexCache.clear();
}

// --- queries -----------------------------------------------------------------

export interface Encounter {
  mediaId: string;
  count: number;
  cues: CueRef[];
}

/** All entries (from the given indexes) containing `lemma`, most hits first. */
export function encounters(
  lemma: string,
  indexes: Iterable<EntryIndex>,
): Encounter[] {
  const out: Encounter[] = [];
  for (const ix of indexes) {
    const info = ix.lemmas.get(lemma);
    if (info) out.push({ mediaId: ix.mediaId, count: info.count, cues: info.cues });
  }
  return out.sort((a, b) => b.count - a.count);
}

export interface Comprehensibility {
  /** Fraction (0..1) of lexical token OCCURRENCES whose lemma is known.
   * null when the entry has no lexical tokens. */
  pctKnown: number | null;
  /** Unknown lemmas, most frequent first (top `topN`). */
  unknownLemmas: { lemma: string; count: number }[];
}

/** How comprehensible an entry is for a learner with `knownSet` lemmas. */
export function comprehensibility(
  index: EntryIndex,
  knownSet: ReadonlySet<string>,
  topN = 50,
): Comprehensibility {
  if (index.totalLexical === 0) return { pctKnown: null, unknownLemmas: [] };
  let known = 0;
  const unknown: { lemma: string; count: number }[] = [];
  for (const [lemma, info] of index.lemmas) {
    if (knownSet.has(lemma)) known += info.count;
    else unknown.push({ lemma, count: info.count });
  }
  unknown.sort((a, b) => b.count - a.count || a.lemma.localeCompare(b.lemma));
  return {
    pctKnown: known / index.totalLexical,
    unknownLemmas: unknown.slice(0, topN),
  };
}

export interface DueIntersection {
  /** Distinct due lemmas present in the entry. */
  count: number;
  lemmas: { lemma: string; count: number; cues: CueRef[] }[];
}

/** Which currently-due lemmas appear in this entry (most frequent first). */
export function dueIntersection(
  entryIndex: EntryIndex,
  dueLemmaSet: ReadonlySet<string>,
): DueIntersection {
  const lemmas: DueIntersection["lemmas"] = [];
  for (const lemma of dueLemmaSet) {
    const info = entryIndex.lemmas.get(lemma);
    if (info) lemmas.push({ lemma, count: info.count, cues: info.cues });
  }
  lemmas.sort((a, b) => b.count - a.count || a.lemma.localeCompare(b.lemma));
  return { count: lemmas.length, lemmas };
}
