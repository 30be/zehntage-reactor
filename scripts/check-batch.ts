// Hourly batch watcher: polls the original Gemini Batch job DIRECTLY (by
// batchName saved in cache-all-job.BATCH-BACKUP.json) — independent of the
// running server — and, once it SUCCEEDS, injects every result into the
// offline lookup cache (lookup-cache.db) keyed by vocabKey. Idempotent: skips
// vocabKeys already cached, so re-running is safe. Run hourly via cron.
//
//   bun run scripts/check-batch.ts
//
// Exits 0 always (cron-friendly); appends a one-line summary to stdout (cron
// captures it to the log file).

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  pollLookupBatch,
  fetchLookupBatchResults,
  cancelLookupBatch,
} from "../src/lib/geminibatch.ts";
import {
  getCachedLookup,
  putCachedLookup,
  cachedLookupCount,
} from "../src/lib/lookupcache.ts";

const CFG =
  process.env.ZR_CONFIG_DIR || join(homedir(), ".config", "zehntage-reactor");
const BACKUP = join(CFG, "cache-all-job.BATCH-BACKUP.json");

type Target = { key: string; word: string; context: string; vocabKey: string };

const stamp = () => new Date().toISOString();

async function main(): Promise<void> {
  let backup: { batchName?: string; targets?: Target[] };
  try {
    backup = JSON.parse(readFileSync(BACKUP, "utf8"));
  } catch (e) {
    console.log(`[${stamp()}] check-batch: no backup file (${BACKUP}) — nothing to do.`);
    return;
  }
  const batchName = backup.batchName;
  const targets = backup.targets ?? [];
  if (!batchName) {
    console.log(`[${stamp()}] check-batch: backup has no batchName — nothing to do.`);
    return;
  }
  const byKey = new Map(targets.map((t) => [t.key, t]));

  const before = cachedLookupCount();
  let poll;
  try {
    poll = await pollLookupBatch(batchName);
  } catch (e) {
    console.log(`[${stamp()}] check-batch: poll failed: ${e instanceof Error ? e.message : e}`);
    return;
  }

  if (poll.state !== "succeeded") {
    // No results yet (still queued, or terminal failure). If the 7h deadline
    // has passed and we haven't already done it, cancel the stuck batch and
    // kick off the Flex run (server caches every uncached word in minutes).
    await maybeFlexFallback(batchName!, poll.state, before);
    return;
  }

  if (!poll.destFileName) {
    console.log(`[${stamp()}] check-batch: succeeded but no destFileName — cannot fetch.`);
    return;
  }

  let results;
  try {
    results = await fetchLookupBatchResults(poll.destFileName);
  } catch (e) {
    console.log(`[${stamp()}] check-batch: fetch results failed: ${e instanceof Error ? e.message : e}`);
    return;
  }

  let injected = 0;
  let skipped = 0;
  let errored = 0;
  for (const r of results) {
    if (!r.result) {
      errored++;
      continue;
    }
    const t = byKey.get(r.key);
    if (!t) {
      errored++;
      continue;
    }
    if (getCachedLookup(t.vocabKey)) {
      skipped++;
      continue;
    }
    try {
      putCachedLookup(t.vocabKey, r.result, t.word, t.context);
      injected++;
    } catch {
      errored++;
    }
  }
  console.log(
    `[${stamp()}] check-batch: SUCCEEDED — injected ${injected}, skipped(already) ${skipped}, ` +
      `errors ${errored}. cached rows ${before} -> ${cachedLookupCount()}.`,
  );
}

// If the batch hasn't produced results by the deadline, switch to Flex:
// cancel the stuck batch (best-effort) and POST the server's cache-all route,
// which now runs synchronously via the Gemini Flex tier (~minutes, same cost).
// A marker file makes this fire at most once.
async function maybeFlexFallback(
  batchName: string,
  state: string,
  cachedRows: number,
): Promise<void> {
  const DEADLINE_FILE = join(CFG, "batch-flex-deadline");
  const MARKER = join(CFG, "batch-flex-fallback.done");
  let deadline = 0;
  try {
    deadline = parseInt(readFileSync(DEADLINE_FILE, "utf8").trim(), 10) || 0;
  } catch {
    /* no deadline configured → never auto-fallback */
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const past = deadline > 0 && nowSec > deadline;
  const alreadyDid = existsSync(MARKER);

  if (alreadyDid) {
    console.log(`[${stamp()}] check-batch: batch ${state} (cached=${cachedRows}). Flex fallback already triggered earlier.`);
    return;
  }
  if (!past) {
    const leftH = deadline ? Math.max(0, (deadline - nowSec) / 3600) : 0;
    console.log(
      `[${stamp()}] check-batch: batch ${state} (cached=${cachedRows}). ` +
        (deadline ? `waiting ~${leftH.toFixed(1)}h until Flex fallback.` : "no deadline set."),
    );
    return;
  }

  // Past deadline, still no results → switch to Flex.
  console.log(`[${stamp()}] check-batch: 7h deadline passed, batch still ${state} — switching to Flex.`);
  try {
    await cancelLookupBatch(batchName);
    console.log(`[${stamp()}] cancelled stuck batch ${batchName}.`);
  } catch (e) {
    console.log(`[${stamp()}] cancel failed (ignoring): ${e instanceof Error ? e.message : e}`);
  }
  try {
    const r = await fetch("http://localhost:8417/api/lookup/cache-all", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const body = await r.text();
    console.log(`[${stamp()}] POST /api/lookup/cache-all (Flex) -> ${r.status} ${body}`);
    if (r.ok) {
      writeFileSync(MARKER, stamp());
      console.log(`[${stamp()}] Flex run started; marker written. Future hourly runs will report progress.`);
    } else {
      console.log(`[${stamp()}] Flex trigger non-OK; will retry next hour.`);
    }
  } catch (e) {
    console.log(`[${stamp()}] Flex trigger failed: ${e instanceof Error ? e.message : e} (will retry next hour).`);
  }
}

await main();

