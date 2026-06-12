// Pure pre-study ranking: i+1 promotion + muddy-sentence demotion.
// (DOM-free so bun test covers it without a browser.)
//
// Inputs: candidate items in their base order (show-frequency desc) plus, for
// every cue in the scanned window, the list of unknown lemmas it contains.
//
// - i+1: the lemma is the ONLY unknown in at least one window cue — instantly
//   minable as a clean card. Promoted to the top (stable within the group).
// - muddy: every cue the lemma appears in has >= MUDDY_UNKNOWNS unknowns —
//   any card from those contexts would be noise. Demoted to the bottom and
//   unchecked by default (but the overall top 5 stay checked so an all-muddy
//   window doesn't produce an empty selection).

export const MUDDY_UNKNOWNS = 3;

export interface PreRankFlags {
  iPlusOne: boolean;
  muddy: boolean;
}

export function rankPreStudy<T extends { lemma: string; checked: boolean }>(
  items: T[],
  cueUnknownLemmas: string[][],
): (T & PreRankFlags)[] {
  const cueSets = cueUnknownLemmas.map((l) => new Set(l));
  const flagged = items.map((it) => {
    let appears = 0;
    let clean = 0;
    let muddyCues = 0;
    for (const s of cueSets) {
      if (!s.has(it.lemma)) continue;
      appears++;
      if (s.size === 1) clean++;
      if (s.size >= MUDDY_UNKNOWNS) muddyCues++;
    }
    const iPlusOne = clean > 0;
    const muddy = !iPlusOne && appears > 0 && muddyCues === appears;
    return { ...it, iPlusOne, muddy };
  });
  const tier = (x: PreRankFlags) => (x.iPlusOne ? 0 : x.muddy ? 2 : 1);
  const sorted = flagged
    .map((x, i) => [x, i] as const)
    .sort((a, b) => tier(a[0]) - tier(b[0]) || a[1] - b[1])
    .map(([x]) => x);
  // muddy items default to unchecked — except inside the overall top 5
  return sorted.map((x, i) =>
    x.muddy && i >= 5 && x.checked ? { ...x, checked: false } : x,
  );
}
