// Reading progress: tracks the furthest paragraph index the user has reached
// per document, persisted via the zr.* localStorage pattern (picked up by the
// startSync() monkey-patch, so it round-trips to the server like other state).

const PREFIX = "zr.read.pos.";

/** Read the furthest-read paragraph index for a document (0-based). */
export function readFurthest(mediaId: string): number {
  try {
    const v = parseInt(localStorage.getItem(PREFIX + mediaId) ?? "", 10);
    return isNaN(v) ? -1 : v;
  } catch {
    return -1;
  }
}

/** Persist the furthest paragraph index if it advances. */
export function writeFurthest(mediaId: string, index: number): void {
  try {
    const prev = readFurthest(mediaId);
    if (index > prev) {
      localStorage.setItem(PREFIX + mediaId, String(index));
    }
  } catch {
    /* quota / SSR — ignore */
  }
}

/** 0-100 progress percentage (0 when no paragraphs). */
export function calcProgress(furthest: number, total: number): number {
  if (total <= 0) return 0;
  if (furthest < 0) return 0;
  return Math.round(((furthest + 1) / total) * 100);
}
