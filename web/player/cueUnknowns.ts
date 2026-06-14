// Pure cue -> unknown-lexical-token computation (DOM-free, unit-tested).
//
// Single source of truth for "what counts as an unknown word in a cue",
// previously duplicated inline in Player.tsx (the cue-unknowns effect and the
// pre-study builder). A token is an unknown lexical token when:
//   - it is lexical (isLexical) and not a particle/auxiliary (助詞 / 助動詞),
//   - its word-key is in neither the known-words set nor the blacklist,
//   - it does not match an existing Anki card front (matchFront).
//
// Deterministic: takes an already-built tokenizer + the lexical sets, so it has
// no async and no side effects. The caller keeps the getTokenizer() plumbing.

import { isLexical, type KToken } from "../tokenizer.ts";
import { matchFront, type WordIndex } from "../progress.ts";
import { wordKey } from "../TokenLine.tsx";

export interface Tokenizer {
  tokenize: (text: string) => KToken[];
}

export interface UnknownSets {
  wordIndex: WordIndex;
  knownWords: Set<string>;
  blacklist: Set<string>;
}

/** Unknown lexical-token keys for a single cue text. */
export function cueUnknownKeys(
  text: string,
  tok: Tokenizer,
  sets: UnknownSets,
): string[] {
  const us: string[] = [];
  for (const t of tok.tokenize(text)) {
    if (!isLexical(t)) continue;
    if (t.pos === "助詞" || t.pos === "助動詞") continue; // particles/aux
    const key = wordKey(t);
    if (sets.knownWords.has(key) || sets.blacklist.has(key)) continue;
    if (
      matchFront(sets.wordIndex, t.surface_form, t.reading, t.basic_form, t.pos) !=
      null
    )
      continue;
    us.push(key);
  }
  return us;
}

/** Per-cue unknown keys + counts for a list of cue texts. */
export function computeCueUnknowns(
  texts: string[],
  tok: Tokenizer,
  sets: UnknownSets,
): { counts: number[]; lemmas: string[][] } {
  const lemmas: string[][] = [];
  const counts = texts.map((text) => {
    const us = cueUnknownKeys(text, tok, sets);
    lemmas.push(us);
    return us.length;
  });
  return { counts, lemmas };
}
