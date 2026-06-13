// Pure auto-resume decision (DOM-free, unit-tested).
//
// Extracted verbatim from the loadedmetadata handler in Player.tsx. Given a
// saved playback position and the media duration, returns the time to seek to
// for auto-resume, or null when no resume should happen.
//
// Rule (unchanged): resume only when the saved position is finite, more than
// 15s in (skip near-start), the duration is known (>0), and the saved position
// is more than 10s before the end (skip near-end).

export interface ResumeOpts {
  saved: number;
  duration: number;
}

/** Target resume time, or null when auto-resume should be skipped. */
export function pickResumeTime(opts: ResumeOpts): number | null {
  const { saved, duration } = opts;
  if (
    Number.isFinite(saved) &&
    saved > 15 &&
    duration > 0 &&
    saved < duration - 10
  ) {
    return saved;
  }
  return null;
}
