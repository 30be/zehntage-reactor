// Bounded-concurrency runner for bulk offline word-lookups via the Gemini FLEX
// inference tier (see lookupWordFlex in ./gemini.ts).
//
// Replaces the async Batch API path for the offline lookup-cache feature: instead
// of "submit a batch + poll for up to 24h", we fire N synchronous flex
// generateContent calls through a small worker pool. Flex is ~50% cheaper than
// standard (the SAME rate as Batch — input $0.125/1M, output $0.75/1M for
// gemini-3.1-flash-lite) with a best-effort ~1–15 min target latency, so a whole
// library caches in MINUTES at batch prices.
//
// Each successful result is written into the offline lookup cache via
// putCachedLookup AS IT COMPLETES, and onProgress(done, total) fires after every
// item — so the UI progress bar advances in REAL TIME (unlike batch, where
// done stayed 0 until the whole job finished). Per-item failures are tolerated:
// they're counted and skipped, never aborting the whole run.
//
// Concurrency is kept moderate (default 10). flash-lite Tier-1 RPM limits are
// high, but flex is best-effort, so we lean on lookupWordFlex's built-in
// 429/5xx backoff retry (inherited from callGemini) rather than hammering hard.

import { lookupWordFlex } from "./gemini.ts";
import { putCachedLookup } from "./lookupcache.ts";

/** One bulk-lookup target: the prompt inputs plus the homograph-aware cache key. */
export interface FlexTarget {
  /** Surface/dictionary form used for the lookup prompt. */
  word: string;
  /** Representative subtitle line (context for sense disambiguation). */
  context: string;
  /** Entry/episode name the context came from. */
  source: string;
  /** Stable vocab identity (homograph-aware vocabKey) — the cache key. */
  vocabKey: string;
}

export interface FlexRunOptions {
  /** Worker-pool size. Default 10 (moderate; flex is best-effort). */
  concurrency?: number;
  /** Called after EACH item settles (success or failure), for live progress. */
  onProgress?: (done: number, total: number) => void;
  /** Optional cooperative cancel: checked before each item is started. */
  shouldStop?: () => boolean;
  /** DI seam (tests): the lookup call. Defaults to the real flex Gemini call. */
  lookup?: typeof lookupWordFlex;
  /** DI seam (tests): the cache write. Defaults to the real putCachedLookup. */
  putCache?: typeof putCachedLookup;
}

export interface FlexRunResult {
  /** Total targets in the run. */
  total: number;
  /** Items written to the cache (successful lookups). */
  succeeded: number;
  /** Items that errored (counted, skipped — did not abort the run). */
  failed: number;
  /** True if the run ended early because shouldStop() returned true. */
  stopped: boolean;
}

const DEFAULT_CONCURRENCY = 10;

/**
 * Run flex lookups for `targets` with a bounded worker pool, writing each success
 * into the offline lookup cache as it completes and reporting live progress.
 *
 * - `done` (passed to onProgress) counts every SETTLED item — successes AND
 *   failures — so the progress bar reflects real work, not just cache writes.
 * - Per-item failures are swallowed (counted in `failed`); the run continues.
 * - On `shouldStop()` → true, no NEW items are started; in-flight items finish.
 *
 * Returns counts; the caller computes cost from `succeeded`/`total` as it likes.
 */
export async function runFlexLookups(
  targets: FlexTarget[],
  opts: FlexRunOptions = {},
): Promise<FlexRunResult> {
  const total = targets.length;
  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);
  const { onProgress, shouldStop } = opts;
  const lookup = opts.lookup ?? lookupWordFlex;
  const putCache = opts.putCache ?? putCachedLookup;

  let next = 0; // index of the next target to claim
  let done = 0; // settled (success + failure)
  let succeeded = 0;
  let failed = 0;
  let stopped = false;

  async function worker(): Promise<void> {
    for (;;) {
      if (shouldStop?.()) {
        stopped = true;
        return;
      }
      const i = next++;
      if (i >= total) return;
      const t = targets[i]!;
      try {
        const result = await lookup(t.word, t.context, t.source);
        // Write each result the moment it lands — survives a mid-run crash and
        // lets the per-episode/status polls see cache growth immediately.
        putCache(t.vocabKey, result, t.word, t.context);
        succeeded++;
      } catch {
        // Tolerate per-item failure: count it, skip it, keep going. The bulk
        // cache is best-effort; a re-click will retry whatever stayed uncached.
        failed++;
      } finally {
        done++;
        onProgress?.(done, total);
      }
    }
  }

  if (total === 0) {
    onProgress?.(0, 0);
    return { total: 0, succeeded: 0, failed: 0, stopped: false };
  }

  const pool = Array.from({ length: Math.min(concurrency, total) }, () => worker());
  await Promise.all(pool);

  return { total, succeeded, failed, stopped };
}
