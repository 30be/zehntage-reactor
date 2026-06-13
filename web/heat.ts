// Difficulty "heat" for the seekbar density strip.
//
// Used by the Vbar seekbar strip (web/player/Vbar.tsx):
//   - heatBins(cues, unknownCounts, binSeconds, duration) -> HeatBin[]
//       cues: the active subtitle track's cues
//       unknownCounts[i]: number of unknown lexical tokens in cues[i]
//         (the Player computes per-cue unknowns from its word index;
//          pass 0s if not yet computed — bar degrades to plain density)
//       binSeconds: e.g. 10; duration: media duration in seconds
//   - heatStyle(bin) -> { background } CSS for one bin segment (b/w theme:
//       white at alpha 0.15 + 0.5 * unknownRatio, scaled by density).
//   - Render: a flex row of <span> per bin, each with heatStyle(bin).

export interface CueLike {
  start: number;
  end: number;
  text: string;
}

export interface HeatBin {
  /** Speech density in the bin: cue-covered seconds / binSeconds, 0..1. */
  density: number;
  /** Unknown lexical tokens / total cue-words proxy in the bin, 0..1. */
  unknownRatio: number;
}

/**
 * Bucket cues into fixed-width time bins. A cue contributes to every bin it
 * overlaps, proportionally to the overlap (both for density seconds and for
 * its unknown count, so a long cue straddling bins doesn't double-count).
 */
export function heatBins(
  cues: CueLike[],
  unknownCounts: number[],
  binSeconds: number,
  duration: number,
): HeatBin[] {
  if (!(binSeconds > 0) || !(duration > 0)) return [];
  const n = Math.max(1, Math.ceil(duration / binSeconds));
  const covered = new Array<number>(n).fill(0); // seconds of speech per bin
  const unknown = new Array<number>(n).fill(0); // overlap-weighted unknowns
  const cueSec = new Array<number>(n).fill(0); // overlap-weighted cue count

  for (let i = 0; i < cues.length; i++) {
    const c = cues[i]!;
    const start = Math.max(0, Math.min(c.start, duration));
    const end = Math.max(start, Math.min(c.end, duration));
    const len = end - start;
    const unk = unknownCounts[i] ?? 0;
    const first = Math.min(n - 1, Math.floor(start / binSeconds));
    const last = Math.min(n - 1, Math.floor(Math.max(start, end - 1e-9) / binSeconds));
    for (let b = first; b <= last; b++) {
      const binStart = b * binSeconds;
      const binEnd = binStart + binSeconds;
      const ov = Math.min(end, binEnd) - Math.max(start, binStart);
      if (ov <= 0 && len > 0) continue;
      const frac = len > 0 ? ov / len : 1; // zero-length cue: all to its bin
      covered[b]! += Math.max(ov, 0);
      unknown[b]! += unk * frac;
      cueSec[b]! += frac;
    }
  }

  const bins: HeatBin[] = [];
  for (let b = 0; b < n; b++) {
    const density = Math.min(1, covered[b]! / binSeconds);
    // unknowns per overlapping cue, squashed into 0..1 (3+ unknowns/cue = max)
    const perCue = cueSec[b]! > 0 ? unknown[b]! / cueSec[b]! : 0;
    bins.push({ density, unknownRatio: Math.min(1, perCue / 3) });
  }
  return bins;
}

/** b/w theme: white with alpha 0.15 + 0.5*ratio; empty bins are transparent. */
export function heatAlpha(bin: HeatBin): number {
  if (bin.density <= 0) return 0;
  return 0.15 + 0.5 * bin.unknownRatio;
}

/** Inline style for one bin segment of the density bar. */
export function heatStyle(bin: HeatBin): { background: string } {
  const a = heatAlpha(bin);
  return { background: a > 0 ? `rgba(255,255,255,${a.toFixed(3)})` : "transparent" };
}
