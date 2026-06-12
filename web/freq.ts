// Japanese word-frequency ranks. public/freq.json is a compact JSON array of
// the ~30k most common words in frequency order (rank = index + 1), generated
// by scripts/gen-freq.ts from the Leeds-corpus-derived hingston/japanese list
// (Leeds frequency lists are CC BY 2.5).

import type { KToken } from "./tokenizer.ts";

let freqPromise: Promise<Map<string, number>> | null = null;

export function loadFreq(): Promise<Map<string, number>> {
  if (!freqPromise) {
    freqPromise = fetch("/freq.json")
      .then((r) => {
        if (!r.ok) throw new Error(`freq.json → ${r.status}`);
        return r.json() as Promise<string[]>;
      })
      .then((words) => {
        const m = new Map<string, number>();
        for (let i = 0; i < words.length; i++) {
          const w = words[i]!;
          if (!m.has(w)) m.set(w, i + 1);
        }
        return m;
      })
      .catch((e) => {
        freqPromise = null; // allow a retry on transient failure
        throw e;
      });
  }
  return freqPromise;
}

/** Frequency rank for a token: basic_form first, then surface. */
export function freqRank(
  freq: Map<string, number>,
  tok: Pick<KToken, "surface_form" | "basic_form">,
): number | null {
  if (tok.basic_form && tok.basic_form !== "*") {
    const r = freq.get(tok.basic_form);
    if (r != null) return r;
  }
  return freq.get(tok.surface_form) ?? null;
}

/** Same lookup by raw strings (popup has no token object). */
export function freqRankOf(
  freq: Map<string, number>,
  word: string,
  dictForm?: string,
): number | null {
  if (dictForm) {
    const r = freq.get(dictForm);
    if (r != null) return r;
  }
  return freq.get(word) ?? null;
}

/** Tiny tier label for the popup tag: "top 1k" … "rare". */
export function freqTier(rank: number | null): string {
  if (rank == null) return "rare";
  if (rank <= 1000) return "top 1k";
  if (rank <= 3000) return "top 3k";
  if (rank <= 10_000) return "top 10k";
  if (rank <= 30_000) return "top 30k";
  return "rare";
}
