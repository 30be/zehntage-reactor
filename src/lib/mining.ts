// jpdb-inspired mining queries over the per-entry lemma indexes
// (src/lib/tokenindex.ts). Server route: GET /api/index/showfreq uses
// showFrequency(); the client-side i+1 / prestudy ranking lives in
// web/prestudy.ts (it reuses the Player's own tokenization pass instead).

import type { EntryIndex } from "./tokenindex.ts";

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
