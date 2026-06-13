// Pure OP/ED skip-gap detection (DOM-free, unit-tested).
//
// Extracted verbatim from the skip-gap effect in Player.tsx. A >60s hole in the
// primary cues means no dialogue (opening/ending/silence). While playback sits
// inside such a hole (and past the first 10s of the file), this returns the
// time to jump to: 1s before the next cue. Otherwise null (no skip offered).
//
// `currentTime` is the raw video time; `subOffset` is the subtitle offset.

import type { Cue } from "../api.ts";
import { activeCueIndex } from "../cues.ts";

/** Skip target time, or null when no OP/ED gap skip is available. */
export function findSkipTarget(
  cues: Cue[],
  currentTime: number,
  subOffset: number,
): number | null {
  if (currentTime > 10 && cues.length > 0) {
    const t = currentTime - subOffset;
    if (activeCueIndex(cues, t) < 0) {
      const nextIdx = cues.findIndex((c) => c.start > t);
      if (nextIdx >= 0) {
        const prevEnd = nextIdx > 0 ? cues[nextIdx - 1]!.end : 0;
        if (cues[nextIdx]!.start - prevEnd > 60) {
          return Math.max(0, cues[nextIdx]!.start + subOffset - 1);
        }
      }
    }
  }
  return null;
}
