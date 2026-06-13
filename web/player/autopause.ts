// Pure autopause decision logic (DOM-free, unit-tested).
//
// Extracted verbatim from the active-cue effect in Player.tsx (the
// `echoSkip` / `skip` branch). Decides whether a finished cue should be
// SKIPPED (i.e. NOT paused on) given the current mode and the cue's unknown
// lexical-token count.
//
// Safe default: when there is no unknown-count data for the cue
// (`unknownCount == null`, e.g. counts not computed yet, or a streaming
// whisper cue appended after the last compute), we do NOT skip — playback
// pauses. This mirrors the missing-counts-array behaviour in Player.tsx.

import { tooShortForEcho } from "../dictation.ts";

export type AutopauseMode = "every" | "unknown";

export interface AutopauseOpts {
  /** Echo (dictation) mode forces a pause at EVERY cue end, except cues
   *  too short to dictate. */
  echo: boolean;
  /** Autopause mode: "every" pauses at every cue, "unknown" only pauses on
   *  cues with >= `min` unknown lexical tokens. */
  mode: AutopauseMode;
  /** Minimum unknown lexical-token count to pause on (smart mode). */
  min: number;
  /** Text of the finished cue (used only for the echo length check). */
  cueText: string;
  /** Unknown lexical-token count for the finished cue, or null when unknown. */
  unknownCount: number | null;
}

/** Whether to SKIP (not pause on) the finished cue. */
export function shouldSkipAutopause(opts: AutopauseOpts): boolean {
  const { echo, mode, min, cueText, unknownCount } = opts;
  return echo
    ? tooShortForEcho(cueText)
    : mode === "unknown" && unknownCount != null && unknownCount < min;
}
