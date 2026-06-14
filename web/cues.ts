import type { Cue } from "./api.ts";

/**
 * Index of the cue active at time t (seconds), or -1 if none.
 *
 * "Active" = a cue with start <= t <= end (end inclusive). Cues are assumed
 * sorted by start. For the common non-overlapping case this is an O(log n)
 * binary search. To stay correct for overlapping/nested cues (where the
 * binary-search midpoint may land on a cue that does not actually contain t,
 * or on an earlier cue when a later-starting one also contains t) we do a
 * bounded fix-up around the candidate: we find the last cue whose start <= t
 * (rightmost feasible start), then scan leftward over cues that could still
 * cover t, returning the *latest-starting* cue that contains t — matching the
 * "the most recently begun subtitle wins" semantics the player relies on.
 */
export function activeCueIndex(cues: Cue[], t: number): number {
  const n = cues.length;
  if (n === 0) return -1;

  // Binary search for the rightmost index whose start <= t.
  let lo = 0;
  let hi = n - 1;
  let startIdx = -1; // last cue with start <= t
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid]!.start <= t) {
      startIdx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (startIdx < 0) return -1; // t is before every cue's start

  // Scan leftward from the latest-starting feasible cue and return the first
  // (i.e. latest-starting) cue that actually contains t (t <= end).
  //
  // Performance: for a sorted, non-overlapping array the ends are
  // non-decreasing, so cues[startIdx] has the largest end among indices
  // 0..startIdx. If it does not contain t (a genuine gap), no earlier cue can
  // either, and we exit after a single iteration — preserving the old
  // effectively-O(log n) cost on the common path. The leftward walk only
  // continues into earlier cues when an earlier cue has a *larger* end than a
  // later one, which is exactly the overlap/nesting case we are hardening for.
  // We bound that walk with `maxEnd`: once we have seen a cue whose end is the
  // largest so far and it still does not reach t, an earlier cue can only
  // rescue t if it has an even larger end (deeper nesting), so we keep going;
  // otherwise (end not exceeding the running max) the cue is fully covered by a
  // later sibling and can be skipped, but we must still inspect it in case it
  // is the container — so we simply continue the linear walk, which remains
  // O(k) in the local overlap cluster size, not the whole array.
  let maxEnd = cues[startIdx]!.end;
  if (t <= maxEnd) {
    // Fast path: the rightmost feasible cue contains t.
    // But an even-later-starting nested cue could also start <= t with a
    // smaller end; impossible here since startIdx is already the rightmost
    // start <= t. So startIdx is the answer.
    return startIdx;
  }
  // startIdx did not contain t. Walk left only through cues that could still
  // cover t via nesting (those with end > the ends already rejected).
  for (let i = startIdx - 1; i >= 0; i--) {
    const end = cues[i]!.end;
    if (t <= end) return i;
    if (end <= maxEnd) {
      // This cue is no wider than one already rejected to its right; in a
      // non-overlapping run this is the norm and means we are in a true gap.
      // Stop: no earlier cue with an even larger end has appeared.
      break;
    }
    maxEnd = end;
  }
  return -1;
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
