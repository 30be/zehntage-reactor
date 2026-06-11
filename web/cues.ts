import type { Cue } from "./api.ts";

/** Binary search for the cue active at time t (seconds). null if none. */
export function activeCueIndex(cues: Cue[], t: number): number {
  let lo = 0;
  let hi = cues.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = cues[mid]!;
    if (t < c.start) {
      hi = mid - 1;
    } else if (t > c.end) {
      lo = mid + 1;
    } else {
      ans = mid;
      break;
    }
  }
  return ans;
}

/** Sentence context = active cue plus immediate neighbors, for lookup. */
export function contextAround(cues: Cue[], i: number): string {
  if (i < 0) return "";
  const parts: string[] = [];
  if (cues[i - 1]) parts.push(cues[i - 1]!.text);
  parts.push(cues[i]!.text);
  if (cues[i + 1]) parts.push(cues[i + 1]!.text);
  return parts.join(" ");
}
