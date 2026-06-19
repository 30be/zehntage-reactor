// Server-side enumerator of every UNKNOWN Japanese subtitle word in the library.
//
// Produces the list of word-lookup targets to pre-cache: every UNIQUE Japanese
// word that appears in the library's ja subtitles but is NOT already known —
// neither matched by an Anki deck card nor present in the user's "known" set.
// Each target carries a representative context line so a downstream Gemini batch
// can pre-compute the lookups.
//
// This mirrors the client coverage logic (web/coverage.ts `coverageOfCues`):
//   - tokenize ja cues with kuromoji,
//   - keep lexical tokens (jatok `isLexical`),
//   - identity key is the homograph-aware `vocabKey` (== web `wordKey`),
//   - a token is "known" if its vocabKey is in the known set OR a deck card
//     front matches it (reading-aware, mirroring web/progress.ts `matchFront`).
//
// It reuses the SAME server-side tokenizer the library index uses
// (`getServerTokenizer` from tokenindex.ts), and the SAME token helpers
// (`isLexical`/`lemmaOf`/`vocabKey`/`kataToHira` from jatok.ts). The web
// progress/matchFront helpers live under web/ (excluded from the server tsc
// program and importing a browser-only kuromoji), so their matching logic is
// re-implemented here against the deck card fronts.

import type { Cue } from "./subs.ts";
import type { LibraryEntry } from "./library.ts";
import { getServerTokenizer, type Tokenize } from "./tokenindex.ts";
import {
  isLexical,
  vocabKey,
  kataToHira,
  type KToken,
} from "./jatok.ts";

/** One word to pre-cache a lookup for. */
export interface LookupTarget {
  /** Surface/dictionary form used for the lookup prompt. */
  word: string;
  /** Representative subtitle line (the cue text where the word first occurred). */
  context: string;
  /** Entry/episode name the context came from. */
  source: string;
  /** Stable vocab identity (homograph-aware vocabKey) — the dedup key. */
  key: string;
}

// --- deck-front index (server mirror of web/progress.ts) ---------------------
//
// The deck card fronts are "word" or "word [reading]". We index them so a cue
// token can be tested for "already has a card" the SAME reading-aware way the
// client does in matchFront — otherwise the corpus would re-list words the
// learner already mined.

interface FrontIndex {
  /** Exact front text + "word [hira-reading]" → true. */
  byKey: Set<string>;
  /** Bare word of bracketed fronts → their readings (hiragana). */
  bare: Map<string, string[]>;
}

/** Build the deck-front index from card fronts (mirrors buildWordIndex). */
export function buildFrontIndex(fronts: Iterable<string>): FrontIndex {
  const idx: FrontIndex = { byKey: new Set(), bare: new Map() };
  for (const front of fronts) {
    if (!front) continue;
    idx.byKey.add(front);
    const m = front.match(/^(.+?)\s*\[(.+?)\]\s*$/);
    if (m) {
      const word = m[1]!.trim();
      const reading = kataToHira(m[2]!.trim());
      idx.byKey.add(`${word} [${reading}]`);
      const list = idx.bare.get(word);
      if (list) list.push(reading);
      else idx.bare.set(word, [reading]);
    }
  }
  return idx;
}

/**
 * Does the deck already have a card for this token? Reading-aware, mirroring
 * web/progress.ts `matchFront`:
 *   - a bracketed card matches only if its reading agrees (hira-normalized);
 *   - a readingless front matches exact surface text;
 *   - a non-inflecting noun/suffix token whose reading didn't match any bracket
 *     still matches IF there's exactly one bare card for the spelling (kuromoji
 *     compound on/kun mis-tag tolerance);
 *   - falls back to the dictionary (basic) form for conjugated tokens.
 */
function deckHasCard(idx: FrontIndex, t: KToken): boolean {
  const surface = t.surface_form;
  const hira = t.reading ? kataToHira(t.reading) : null;
  const pos = t.pos ?? "";
  const basicForm = t.basic_form;

  if (hira && idx.byKey.has(`${surface} [${hira}]`)) return true;
  if (idx.byKey.has(surface)) return true;

  if (!hira) {
    if ((idx.bare.get(surface)?.length ?? 0) > 0) return true;
  } else if (pos === "名詞" || pos === "接尾") {
    if (idx.bare.get(surface)?.length === 1) return true;
  }

  if (basicForm && basicForm !== "*" && basicForm !== surface) {
    if (hira && idx.byKey.has(`${basicForm} [${hira}]`)) return true;
    if (idx.byKey.has(basicForm)) return true;
    if (!hira) {
      if ((idx.bare.get(basicForm)?.length ?? 0) > 0) return true;
    } else if (pos === "名詞" || pos === "接尾") {
      if (idx.bare.get(basicForm)?.length === 1) return true;
    }
  }
  return false;
}

// --- corpus enumeration ------------------------------------------------------

/**
 * Loader the caller wires from the server request scope: given a library entry,
 * return its ja subtitle cues, or null when the entry has no ja track. The
 * route already has `bestJapaneseTrackId(entry)` + `cuesForTrack(entry, id)` in
 * scope — wrap them:
 *
 *   const cuesFor = async (e) => {
 *     const id = await bestJapaneseTrackId(e);
 *     return id ? await cuesForTrack(e, id) : null;
 *   };
 */
export type CuesForEntry = (entry: LibraryEntry) => Promise<Cue[] | null>;

export interface CollectOptions {
  /** Library entries to scan (e.g. `library.list()`). */
  entries: LibraryEntry[];
  /** ja-cue loader bound to the server's track/cue helpers (see CuesForEntry). */
  cuesFor: CuesForEntry;
  /** Deck card fronts ("word" / "word [reading]") — e.g. `(await listCardsAuto()).map(c => c.front)`. */
  deckFronts: Iterable<string>;
  /** The user's "known" vocabKey set (zr.known ∪ blacklist). */
  known: ReadonlySet<string>;
  /** Optional pre-built server tokenizer (else getServerTokenizer()). */
  tokenize?: Tokenize;
  /**
   * For the offline CACHE enumeration (not coverage): when true, DO NOT skip
   * words already carried by a deck card — every distinct subtitle word (minus
   * known/blacklist and punctuation) becomes a lookup target so each gets a full
   * Gemini gloss. Coverage / "new words" callers MUST leave this false so the
   * unknown-word semantics (not-in-deck-only) are unchanged.
   */
  includeDeck?: boolean;
}

/**
 * Enumerate every unique unknown Japanese word across the library's ja subs.
 *
 * Iterates every entry, loads its ja cues (skips entries without a ja track),
 * tokenizes, keeps lexical tokens whose vocabKey is neither in `known` nor
 * already carried by a deck card, and dedups by vocabKey across the WHOLE
 * library — first occurrence wins and keeps its cue text + source.
 *
 * Returns targets in first-encounter order.
 */
export async function collectUnknownLookupTargets(
  opts: CollectOptions,
): Promise<LookupTarget[]> {
  const tok = opts.tokenize ?? (await getServerTokenizer());
  const fronts = buildFrontIndex(opts.deckFronts);
  const seen = new Set<string>();
  const out: LookupTarget[] = [];

  for (const entry of opts.entries) {
    let cues: Cue[] | null;
    try {
      cues = await opts.cuesFor(entry);
    } catch {
      continue; // tokenizer/track hiccup — skip this entry
    }
    if (!cues || cues.length === 0) continue; // no ja subs

    for (const cue of cues) {
      for (const t of tok(cue.text)) {
        if (!isLexical(t)) continue;
        const key = vocabKey(t);
        if (seen.has(key)) continue;
        if (opts.known.has(key)) continue;
        // Coverage path drops in-deck words; the cache path (includeDeck) keeps
        // them so every subtitle word gets a full cached gloss.
        if (!opts.includeDeck && deckHasCard(fronts, t)) continue;
        seen.add(key);
        out.push({
          word: lookupWord(t),
          context: cue.text,
          source: entry.name,
          key,
        });
      }
    }
  }
  return out;
}

/** Count of unique unknown words; derives from the full collection. */
export async function countUnknownLookupTargets(
  opts: CollectOptions,
): Promise<number> {
  return (await collectUnknownLookupTargets(opts)).length;
}

/** Lookup prompt word: dictionary form when kuromoji has one, else surface. */
function lookupWord(t: KToken): string {
  const b = t.basic_form;
  return b && b !== "*" ? b : t.surface_form;
}
