// Persistent, disk-backed cache for Gemini word lookups.
//
// A NEW sqlite db owned entirely by this app (NOT the Anki collection), living
// next to settings.json in the config dir. Survives server restarts, so a word
// already explained once never costs another Gemini call. Keyed on the
// homograph-aware `vocabKey` (lemma+reading; e.g. distinguishes 生[なま] from
// 生[せい]) ALONE — context-independent, so a word cached once in any sentence
// is reused everywhere (offline-everywhere).
//
// Only TEXT lookups are cached here; frame (image) lookups are visual and bypass
// this layer entirely (see /api/lookup).

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { WordLookup } from "./gemini.ts";

// Mirror settings.ts: ZR_CONFIG_DIR override, resolved lazily so tests can set
// the env var after import.
function configDir(): string {
  return process.env.ZR_CONFIG_DIR || join(homedir(), ".config", "zehntage-reactor");
}

/** Cache key = the homograph-aware vocabKey, trimmed. */
export function cacheKey(vocabKey: string): string {
  return (vocabKey ?? "").trim();
}

/**
 * A result is only worth caching/serving if it has BOTH a gloss and a note.
 * The popup always renders `translation` but HIDES `notes` when empty, so a
 * result with empty `notes` shows "no description" — the bug this guards. An
 * unusable result is never written and an already-stored one is treated as a
 * miss, so the word self-heals (refetches) instead of staying blank forever.
 */
export function isUsableLookup(r: { translation?: string; notes?: string }): boolean {
  return !!r.translation?.trim() && !!r.notes?.trim();
}

let _db: Database | undefined;
let _dbDir: string | undefined;
function db(): Database {
  const dir = configDir();
  if (_db && _dbDir === dir) return _db;
  // configDir changed since the handle was opened (tests switch ZR_CONFIG_DIR;
  // the old dir may even be deleted) — drop the stale handle and reopen at the
  // current dir instead of writing through a dead handle.
  if (_db) _db.close();
  _db = undefined;
  mkdirSync(dir, { recursive: true });
  const d = new Database(join(dir, "lookup-cache.db"));
  d.run(`CREATE TABLE IF NOT EXISTS lookups(
    k TEXT PRIMARY KEY,
    word TEXT,
    context TEXT,
    reading TEXT,
    translation TEXT,
    notes TEXT,
    ctx TEXT,
    created INTEGER
  )`);
  _db = d;
  _dbDir = dir;
  return d;
}

/** Cache hit → the stored WordLookup; miss → undefined. Keyed by vocabKey. */
export function getCachedLookup(vocabKey: string): WordLookup | undefined {
  const row = db()
    .query("SELECT reading, translation, notes, ctx FROM lookups WHERE k = ?")
    .get(cacheKey(vocabKey)) as
    | { reading: string; translation: string; notes: string; ctx: string }
    | null;
  if (!row) return undefined;
  const result: WordLookup = {
    reading: row.reading,
    translation: row.translation,
    notes: row.notes,
    context: row.ctx,
  };
  // Legacy poisoned rows (written before isUsableLookup existed) read as a miss
  // so the caller refetches and overwrites them.
  return isUsableLookup(result) ? result : undefined;
}

/**
 * Upsert a lookup result keyed by `vocabKey`. `ctx` stores the WordLookup
 * example sentence; the optional `word`/`context` columns are kept for
 * readability/debugging only and are NOT part of the key.
 */
export function putCachedLookup(
  vocabKey: string,
  result: WordLookup,
  word = "",
  context = "",
): void {
  // Single chokepoint: never persist a result that would render as "no
  // description" (also guards putManyCachedLookups and all write call sites).
  if (!isUsableLookup(result)) return;
  db().run(
    `INSERT INTO lookups(k, word, context, reading, translation, notes, ctx, created)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(k) DO UPDATE SET
       reading = excluded.reading,
       translation = excluded.translation,
       notes = excluded.notes,
       ctx = excluded.ctx,
       created = excluded.created`,
    [
      cacheKey(vocabKey),
      word,
      context ?? "",
      result.reading,
      result.translation,
      result.notes,
      result.context,
      Date.now(),
    ],
  );
}

/**
 * Bulk upsert (one transaction). For the "cache all unknown words" batch ingest,
 * where hundreds–thousands of results land at once; a single txn is far cheaper
 * than N autocommit writes. Each row is keyed by its vocabKey.
 */
export function putManyCachedLookups(
  rows: Array<{ vocabKey: string; result: WordLookup }>,
): void {
  const d = db();
  const tx = d.transaction((items: typeof rows) => {
    for (const r of items) putCachedLookup(r.vocabKey, r.result);
  });
  tx(rows);
}

/** Total rows cached. */
export function cachedLookupCount(): number {
  const row = db().query("SELECT COUNT(*) AS n FROM lookups").get() as { n: number };
  return row.n;
}

/**
 * Every cached key as a Set, in one query. For batch "how many of these
 * vocabKeys are already cached" intersections (e.g. the per-episode cache
 * status poll), where calling getCachedLookup per word would be N queries per
 * poll. A few thousand keys — cheap to materialize and intersect in memory.
 */
export function getAllCachedKeys(): Set<string> {
  const rows = db()
    .query("SELECT k, translation, notes FROM lookups")
    .all() as Array<{ k: string; translation: string; notes: string }>;
  const set = new Set<string>();
  // Skip poisoned rows so the batch sees them as "not cached" and re-attempts.
  for (const r of rows) if (isUsableLookup(r)) set.add(r.k);
  return set;
}
