// Pure i+1 cue selection: given per-cue unknown-token counts, find the cues
// that have EXACTLY one unknown lexical token ("i+1" — the next-best sentence
// to study, instantly minable as a clean card). DOM-free so bun test covers it.

/** Indices (in displayCues order) of all i+1 cues — exactly one unknown. */
export function iPlusOneIndices(cueUnknowns: readonly number[] | null): number[] {
  if (!cueUnknowns) return [];
  const out: number[] = [];
  for (let i = 0; i < cueUnknowns.length; i++) {
    if (cueUnknowns[i] === 1) out.push(i);
  }
  return out;
}

/**
 * Next i+1 cue index strictly after `fromIdx` (wraps to the first one), or
 * null when there are none. `fromIdx` is the current active cue index (-1 when
 * before the first cue). Wrapping makes repeated presses cycle the episode.
 */
export function nextIPlusOne(
  cueUnknowns: readonly number[] | null,
  fromIdx: number,
): number | null {
  const hits = iPlusOneIndices(cueUnknowns);
  if (hits.length === 0) return null;
  const after = hits.find((i) => i > fromIdx);
  return after ?? hits[0]!;
}
