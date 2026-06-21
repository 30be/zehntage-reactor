// Pure helper deriving the on-screen subtitle text(s) from the active-cue
// index. Extracted so the "two-line / never-blank" logic is unit-testable in
// isolation (no React, no <video>). The rendering in Player.tsx/SubOverlay just
// consumes { curText, prevText }.
//
// twoLine OFF  → today's behavior: current cue text, blank in gaps.
// twoLine ON   → never blank: during a gap we HOLD the last-shown cue (heldIdx),
//                and we also surface the PREVIOUS cue's line above it (when one
//                exists, i.e. eff-1 >= 0). At eff===0 there is no prev line.

import type { Cue } from "../api.ts";

export function pickDisplayCues(
  cues: Cue[],
  activeP: number,
  heldIdx: number,
  opts: { twoLine: boolean },
): { curText: string; prevText: string } {
  // Effective index: the live active cue when one is playing; otherwise (gap)
  // hold the last cue ONLY in twoLine mode, else show nothing.
  const eff = activeP >= 0 ? activeP : opts.twoLine ? heldIdx : -1;
  const curText = cues[eff]?.text ?? "";
  const prevText =
    opts.twoLine && eff - 1 >= 0 ? (cues[eff - 1]?.text ?? "") : "";
  return { curText, prevText };
}
