// "Continue watching" selection logic (pure, DOM-free — bun-testable).
//
// Resume positions are persisted by the Player as `zr.pos.<id>` (seconds) and
// `zr.posAt.<id>` (epoch ms of the last save). The picker turns those raw
// entries into the most-recently-played items worth resuming.

/** A candidate resume record for one episode. */
export interface ResumeRecord {
  id: string;
  /** Resume position in seconds. */
  pos: number;
  /** When the position was last saved (epoch ms); null if unknown. */
  at: number | null;
}

/** Ignore positions in the first few seconds — not worth a "continue" row. */
export const MIN_RESUME_SEC = 5;

/**
 * Pick the most-recently-played episodes that have a meaningful resume
 * position. Records with pos <= MIN_RESUME_SEC are dropped. Results are sorted
 * newest-first by `at` (records without a timestamp sort last but are still
 * eligible), and capped at `limit`.
 */
export function pickContinueWatching(
  records: readonly ResumeRecord[],
  limit = 3,
): ResumeRecord[] {
  return records
    .filter((r) => Number.isFinite(r.pos) && r.pos > MIN_RESUME_SEC)
    .slice()
    .sort((a, b) => (b.at ?? -1) - (a.at ?? -1))
    .slice(0, Math.max(0, limit));
}

/** Read resume records for the given episode ids from localStorage. */
export function readResumeRecords(ids: readonly string[]): ResumeRecord[] {
  const out: ResumeRecord[] = [];
  for (const id of ids) {
    let pos = NaN;
    let at: number | null = null;
    try {
      pos = parseFloat(localStorage.getItem(`zr.pos.${id}`) ?? "");
      const rawAt = parseFloat(localStorage.getItem(`zr.posAt.${id}`) ?? "");
      at = Number.isFinite(rawAt) ? rawAt : null;
    } catch {
      /* ignore */
    }
    if (Number.isFinite(pos)) out.push({ id, pos, at });
  }
  return out;
}
