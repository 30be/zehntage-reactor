// Wave 18 — DB-direct, READ-ONLY Anki review queue.
//
// Reads the user's Anki `collection.anki2` (schema ver 18, v3 scheduler, FSRS)
// WITHOUT Anki running and WITHOUT AnkiConnect. This module NEVER writes to the
// real collection. It opens the DB read-only; when Anki holds the WAL lock it
// reads a private, disposable copy in a temp dir instead (a plain byte copy of
// the real file — the real DB is never opened read-write here).
//
// What it computes:
//   - dbStatus()       — collection presence / openness / schema sanity.
//   - dbReviewQueue()  — today's due set (Anki's day-number semantics), rendered.
//   - dbDeckCounts()   — {new, learning, review} due counts under deck daily caps.
//
// Scope:
//   - "zehntage" — cards whose note carries the ` zehntage ` tag (deck "Mixed").
//   - "all"      — Anki's actual due queue for the "Mixed" deck (deck-limited),
//                  matching the scope=all UI recommendation in wave18-minimal-ui.
//
// Rendering of question/answer HTML is delegated to ./ankirender.ts (written
// concurrently by another agent). We import its documented surface
// (decodeTemplate / decodeNotetype / renderCard / rewriteAnkiMedia) and fall
// back to a self-contained renderer if that module is unavailable or throws, so
// dbReviewQueue() never throws on the render path.
//
// === unicase collation note ===
// The decks / fields / templates / notetypes / deck_config tables declare a
// `name TEXT COLLATE unicase` column (and unique indexes on it). SQLite needs
// the `unicase` collation registered at statement-PREPARE time to touch those
// tables — and bun:sqlite exposes NO collation-registration API. We therefore
// register `unicase` via a tiny loadable SQLite extension (compiled once into a
// temp dir with the system C compiler, then cached). If no compiler is
// available the extension load is skipped: queue selection (cards + notes only,
// no unicase) and counts still work; rendering degrades gracefully to plain
// fields. This keeps the read path correct even on a toolchain-less host.

import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Reuse the project's existing safety/openness helpers (read-only, never write).
import {
  ankiRunning,
  backupCollection,
  canWrite,
  readSchemaVer,
  schemaSupported,
} from "./ankilock.ts";

// FSRS-6 scheduling kernel (pure math; phase-aware).
import {
  type CardPhase,
  type CardState,
  type FsrsParams,
  type Grade,
  schedule,
} from "./fsrs.ts";

// Card rendering is owned by ./ankirender.ts (see /tmp/wave18-card-render.md).
import {
  decodeDeckConfig,
  decodeNotetype,
  decodeTemplate,
  renderCard,
  rewriteAnkiMedia,
  splitFields,
} from "./ankirender.ts";

// ---------------------------------------------------------------------------
// Public types (ReviewCard shape must match src/lib/anki.ts exactly).
// ---------------------------------------------------------------------------

export interface ReviewCard {
  cardId: number;
  question: string;
  answer: string;
  front: string;
}

export interface DeckCounts {
  new: number;
  learning: number;
  review: number;
}

export interface DbStatus {
  /** collection.anki2 exists and a schema version could be read. */
  present: boolean;
  /** Anki appears to be running / holding the DB (WAL/-shm or live process). */
  ankiOpen: boolean;
  /** col.ver (0 if unreadable). */
  ver: number;
  /** col.ver is a version we understand (18). */
  schemaOk: boolean;
}

export type ReviewScope = "zehntage" | "all";

// ---------------------------------------------------------------------------
// Constants — observed in the user's collection (see /tmp/wave18-anki-db.md).
// ---------------------------------------------------------------------------

/** Deck holding zehntage cards. */
const MIXED_DECK_ID = 1701241966991;
/** Default day-rollover hour when the `config` table doesn't say otherwise. */
const DEFAULT_ROLLOVER_HOUR = 4;
/** Field separator inside notes.flds. */
const FLD_SEP = "\x1f";

/** Default collection path; override with ZEHNTAGE_ANKI_DB. */
export function collectionPath(): string {
  return (
    process.env.ZEHNTAGE_ANKI_DB ||
    join(homedir(), ".local", "share", "Anki2", "User 1", "collection.anki2")
  );
}

// ---------------------------------------------------------------------------
// unicase collation extension (compiled once, cached).
// ---------------------------------------------------------------------------

const UNICASE_SRC = `#include <sqlite3ext.h>
SQLITE_EXTENSION_INIT1
#include <ctype.h>
static int zr_unicase(void *u, int la, const void *a, int lb, const void *b) {
  int n = la < lb ? la : lb;
  const unsigned char *x = a, *y = b;
  for (int i = 0; i < n; i++) {
    int ca = tolower(x[i]), cb = tolower(y[i]);
    if (ca != cb) return ca < cb ? -1 : 1;
  }
  return la < lb ? -1 : la > lb ? 1 : 0;
}
int sqlite3_unicase_init(sqlite3 *db, char **err, const sqlite3_api_routines *api) {
  SQLITE_EXTENSION_INIT2(api);
  sqlite3_create_collation(db, "unicase", SQLITE_UTF8, 0, zr_unicase);
  return SQLITE_OK;
}
`;

let unicaseSoPath: string | null = null;
let unicaseTried = false;

/**
 * Build (once) a tiny loadable extension that registers the `unicase`
 * collation, and return its path. Returns null if no C compiler / header is
 * available — callers must tolerate that (skip unicase-bearing tables).
 */
function ensureUnicaseExtension(): string | null {
  if (unicaseTried) return unicaseSoPath;
  unicaseTried = true;
  // sqlite3ext.h is required to build against bun's bundled SQLite ABI.
  const headerDirs = ["/usr/include", "/usr/local/include"];
  const incDir = headerDirs.find((d) => existsSync(join(d, "sqlite3ext.h")));
  if (!incDir) return null;
  const cc = process.env.CC || "cc";
  try {
    const dir = mkdtempSync(join(tmpdir(), "zr-unicase-"));
    const cFile = join(dir, "unicase.c");
    const soFile = join(dir, "unicase.so");
    writeFileSync(cFile, UNICASE_SRC);
    execFileSync(cc, ["-O2", "-fPIC", "-shared", `-I${incDir}`, cFile, "-o", soFile], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    unicaseSoPath = soFile;
  } catch {
    unicaseSoPath = null;
  }
  return unicaseSoPath;
}

/** Best-effort: register `unicase` on an open DB. Returns true on success. */
function tryRegisterUnicase(db: Database): boolean {
  const so = ensureUnicaseExtension();
  if (!so) return false;
  try {
    db.loadExtension(so, "sqlite3_unicase_init");
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Read-only DB handle, robust to Anki holding the WAL lock.
// ---------------------------------------------------------------------------

interface OpenDb {
  db: Database;
  /** Whether `unicase` is registered (i.e. fields/templates are queryable). */
  unicase: boolean;
  /** Temp dir to clean up on close (null when we opened the real file). */
  tmpDir: string | null;
}

/**
 * Open the collection read-only. First tries the real file directly; if that
 * fails (Anki holds an exclusive WAL lock → SQLITE_BUSY) we copy the file
 * (+ -wal/-shm) into a private temp dir and open the copy. The real DB is
 * NEVER opened read-write.
 */
function openReadOnly(path: string): OpenDb | null {
  if (!existsSync(path)) return null;

  // Open `file` read-only, enforce query_only, smoke-read the collation-free
  // `col` table, and register unicase best-effort. Throws on any failure.
  const openHandle = (file: string): { db: Database; unicase: boolean } => {
    const db = new Database(file, { readonly: true });
    try {
      db.exec("PRAGMA query_only = ON");
    } catch {
      /* ignore */
    }
    // Smoke-read the always-present, collation-free `col` table.
    db.query("SELECT crt FROM col LIMIT 1").get();
    return { db, unicase: tryRegisterUnicase(db) };
  };

  // 1. Direct read-only open (works when Anki is closed / WAL checkpointed).
  try {
    const { db, unicase } = openHandle(path);
    return { db, unicase, tmpDir: null };
  } catch {
    /* fall through to copy path */
  }

  // 2. Copy to a private temp dir and open the copy (Anki is mid-session).
  let tmpDir: string | null = null;
  try {
    tmpDir = mkdtempSync(join(tmpdir(), "zr-ankidb-"));
    const dst = join(tmpDir, "collection.anki2");
    copyFileSync(path, dst);
    for (const ext of ["-wal", "-shm"]) {
      if (existsSync(path + ext)) copyFileSync(path + ext, dst + ext);
    }
    const { db, unicase } = openHandle(dst);
    return { db, unicase, tmpDir };
  } catch {
    if (tmpDir) {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    return null;
  }
}

function closeDb(h: OpenDb): void {
  try {
    h.db.close();
  } catch {
    /* ignore */
  }
  if (h.tmpDir) {
    try {
      rmSync(h.tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/** Close a DB handle, swallowing any error (close-and-ignore boilerplate). */
function closeQuiet(db: Database | null | undefined): void {
  try {
    db?.close();
  } catch {
    /* ignore */
  }
}

/** Run a statement on a DB, swallowing any error (e.g. ROLLBACK best-effort). */
function execQuiet(db: Database | null | undefined, sql: string): void {
  try {
    db?.exec(sql);
  } catch {
    /* ignore */
  }
}

/**
 * Memoizing map lookup: return the cached value for `key`, computing + storing
 * it on first access. `undefined` is a valid stored result (a resolved miss),
 * so presence is checked with `has`, not truthiness.
 */
function getOrCompute<K, V>(cache: Map<K, V>, key: K, make: () => V): V {
  if (cache.has(key)) return cache.get(key) as V;
  const v = make();
  cache.set(key, v);
  return v;
}

// ---------------------------------------------------------------------------
// Shared write-transaction scaffolding (dbAnswerCard / dbDeleteNote / dbAddNote).
//
// Every collection writer shares the SAME fail-closed safety wrapper:
//   1. canWrite() gate (refuse if Anki open / hot WAL / wrong schema).
//   2. backup BEFORE the first byte is written.
//   3. open the REAL collection read-WRITE only inside the write path, with
//      busy_timeout / journal_mode=wal / synchronous=FULL and best-effort unicase.
//   4. BEGIN IMMEDIATE (grab the write lock up front; abort with reason "locked").
//   5. run the caller's mutation body.
//   6. PRAGMA foreign_key_check + PRAGMA integrity_check INSIDE the txn; any
//      failure → clean ROLLBACK and a truthful ok:false (collation-missing on
//      integrity_check is logged + skipped, never blocking a valid write).
//   7. COMMIT, then wal_checkpoint(TRUNCATE) (non-fatal), then close.
// On ANY thrown error: ROLLBACK (if a txn began) + close, surfaced as ok:false.
//
// The body may abort early by throwing a WriteAbort carrying the exact result
// object the legacy inline `ROLLBACK; close; return {...}` path produced — the
// wrapper rolls back, closes, and returns that object verbatim.
// ---------------------------------------------------------------------------

/** Thrown by a write body to roll back and return a specific result. */
class WriteAbort<R> {
  constructor(readonly result: R) {}
}

interface WriteTxnCtx<R> {
  db: Database;
  /** Whether the unicase collation registered (mirrors the read path). */
  unicase: boolean;
  /** Roll back + close and return `result` from the wrapper (early exit). */
  abort: (result: R) => never;
}

interface WriteTxnOpts {
  path: string;
  gateFn: (p: string) => { ok: boolean; reason?: string };
  /** Backup before any write. Omit for writers that take no backup. */
  backupFn?: (p: string) => Promise<unknown>;
  /** Label used in the integrity_check collation-skip warning. */
  label?: string;
  /** Run PRAGMA foreign_key_check before integrity_check (default true). */
  foreignKeyCheck?: boolean;
}

/**
 * Run a guarded write transaction. `body` performs the table mutations and may
 * call `ctx.abort(result)` (or `throw new WriteAbort(result)`) to roll back and
 * return `result`. On normal return, the wrapper runs foreign_key_check +
 * integrity_check (inside the txn), commits, checkpoints, and returns `body`'s
 * value. Preserves every safety invariant byte-for-byte.
 */
async function withWriteTxn<R extends { ok: boolean }>(
  opts: WriteTxnOpts,
  refused: () => R,
  body: (ctx: WriteTxnCtx<R>) => R,
): Promise<R> {
  const { path, gateFn, backupFn, label, foreignKeyCheck = true } = opts;

  // 1. REFUSE-TO-WRITE gates (fail-closed). NEVER proceed if Anki is open.
  const gate = gateFn(path);
  if (!gate.ok) return { ...refused(), reason: gate.reason ?? "refused" } as R;

  // 2. Backup BEFORE any write.
  if (backupFn) {
    try {
      await backupFn(path);
    } catch (e) {
      return { ...refused(), error: `backup failed: ${(e as Error).message}` } as R;
    }
  }

  // 3. Open the REAL collection read-WRITE only inside the write path.
  let db: Database | null = null;
  let began = false;
  try {
    db = new Database(path, { readwrite: true });
    db.exec("PRAGMA busy_timeout = 1000");
    db.exec("PRAGMA journal_mode = wal");
    db.exec("PRAGMA synchronous = FULL");
    // Register unicase so PREPARE against unicase-bearing tables succeeds.
    const unicase = tryRegisterUnicase(db);

    // 4. BEGIN IMMEDIATE — grab the write lock up front; abort on BUSY.
    try {
      db.exec("BEGIN IMMEDIATE");
      began = true;
    } catch {
      closeQuiet(db);
      return { ...refused(), reason: "locked" } as R;
    }

    const ctx: WriteTxnCtx<R> = {
      db,
      unicase,
      abort: (result: R): never => {
        throw new WriteAbort(result);
      },
    };

    let out: R;
    try {
      out = body(ctx);
    } catch (e) {
      if (e instanceof WriteAbort) {
        execQuiet(db, "ROLLBACK");
        began = false;
        closeQuiet(db);
        return e.result as R;
      }
      throw e;
    }

    // 6. Pre-commit invariants (inside the txn — failure → ROLLBACK).
    if (foreignKeyCheck) {
      const fk = db.query("PRAGMA foreign_key_check").all();
      if (fk.length > 0) {
        execQuiet(db, "ROLLBACK");
        began = false;
        closeQuiet(db);
        return { ...refused(), error: "foreign_key_check failed" } as R;
      }
    }

    const icFail = runIntegrityCheck(db, label);
    if (icFail !== null) {
      execQuiet(db, "ROLLBACK");
      began = false;
      closeQuiet(db);
      return { ...refused(), error: icFail } as R;
    }

    // 7. COMMIT, fold WAL back (non-fatal), close.
    db.exec("COMMIT");
    began = false;
    execQuiet(db, "PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
    db = null;
    return out;
  } catch (e) {
    if (db) {
      if (began) execQuiet(db, "ROLLBACK");
      closeQuiet(db);
    }
    return { ...refused(), error: (e as Error).message } as R;
  }
}

/**
 * Run PRAGMA integrity_check INSIDE the txn. Returns null when the collection is
 * "ok" (or the unicase collation is missing → skip+warn), or an error string
 * describing the failure (caller rolls back). NEVER throws.
 */
function runIntegrityCheck(db: Database, label?: string): string | null {
  try {
    const ic = db.query("PRAGMA integrity_check").get() as
      | { integrity_check?: string }
      | Record<string, unknown>
      | null;
    const icVal =
      ic && typeof ic === "object"
        ? String(
            (ic as Record<string, unknown>).integrity_check ??
              Object.values(ic)[0] ??
              "",
          )
        : "";
    if (icVal && icVal !== "ok") return `integrity_check: ${icVal}`;
    return null;
  } catch (icErr) {
    const msg = (icErr as Error).message ?? "";
    if (msg.includes("COLLSEQ") || msg.includes("collation")) {
      // Missing unicase collation — not a data integrity issue; proceed.
      const where = label ? `${label} ` : "";
      console.warn(`[ankidb] ${where}integrity_check skipped: missing collation —`, msg);
      return null;
    }
    // Unknown error from integrity_check inside the txn — roll back safely.
    return `integrity_check threw: ${msg}`;
  }
}

// ---------------------------------------------------------------------------
// Anki day-number computation.
// ---------------------------------------------------------------------------

/** Decode a `config` table value (stored as a JSON-ish byte blob). */
function readConfigInt(db: Database, key: string): number | null {
  try {
    const row = db.query('SELECT val FROM config WHERE "key" = ?').get(key) as
      | { val: Uint8Array | string }
      | null;
    if (!row) return null;
    const text =
      typeof row.val === "string" ? row.val : new TextDecoder().decode(row.val as Uint8Array);
    const n = Number(text.trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * Anki's "today" day-number = whole days since col.crt, shifted by the rollover
 * hour. Matches Anki's `lastUnburied` for the live collection (verified 1174).
 */
function todayDayNumber(db: Database, nowEpoch = Math.floor(Date.now() / 1000)): number {
  const col = db.query("SELECT crt FROM col LIMIT 1").get() as { crt: number };
  const crt = col.crt;
  const rollover = readConfigInt(db, "rollover") ?? DEFAULT_ROLLOVER_HOUR;
  return Math.floor((nowEpoch - crt - rollover * 3600) / 86400);
}

// ---------------------------------------------------------------------------
// Due selection (cards + notes only — no unicase tables touched).
// ---------------------------------------------------------------------------

interface DueRow {
  cid: number;
  nid: number;
  ord: number;
  flds: string;
  mid: number;
  queue: number;
  due: number;
}

/** Build the SQL predicate + params restricting cards to a scope. */
function scopeJoin(scope: ReviewScope): {
  join: string;
  where: string;
  params: (string | number)[];
} {
  if (scope === "zehntage") {
    // tags are space-delimited; sentinel spaces match a whole tag.
    return {
      join: "JOIN notes n ON c.nid = n.id",
      where: "(' ' || n.tags || ' ') LIKE '% zehntage %'",
      params: [],
    };
  }
  // scope "all": Anki's due queue for the Mixed deck (where zehntage lives).
  return {
    join: "JOIN notes n ON c.nid = n.id",
    where: "c.did = ?",
    params: [MIXED_DECK_ID],
  };
}

/**
 * Select today's due cards in Anki's priority order: learning (by due), then
 * review (by due), then new (by position). Returns raw rows for rendering.
 *
 * Due semantics (v3 scheduler):
 *   - learning   queue=1 : due is absolute epoch seconds → due <= now.
 *   - review     queue=2 : due is a day-number          → due <= today.
 *   - day-learn  queue=3 : due is a day-number          → due <= today.
 *   - new        queue=0 : ordered by `due` (position), capped by new/day.
 */
function selectDue(
  h: OpenDb,
  scope: ReviewScope,
  limit: number,
): { rows: DueRow[]; due: number; counts: DeckCounts } {
  const { db } = h;
  const today = todayDayNumber(db);
  const now = Math.floor(Date.now() / 1000);
  const { join, where, params } = scopeJoin(scope);

  const sel = (extra: string, p: (string | number)[]): DueRow[] =>
    db
      .query(
        `SELECT c.id AS cid, c.nid AS nid, c.ord AS ord, n.flds AS flds, n.mid AS mid,
                c.queue AS queue, c.due AS due
         FROM cards c ${join}
         WHERE ${where} AND ${extra}`,
      )
      .all(...params, ...p) as unknown as DueRow[];

  const learning = sel("c.queue IN (1, 3) AND c.due <= ? ORDER BY c.due ASC", [
    // queue 1 due is epoch-seconds; queue 3 is a day-number. Compare each
    // against the right horizon by using the larger bound and re-filtering.
    Math.max(now, today),
  ]).filter((r) => (r.queue === 1 ? r.due <= now : r.due <= today));

  const review = sel("c.queue = 2 AND c.due <= ? ORDER BY c.due ASC", [today]);

  // New cards, capped by the deck's remaining new/day allowance.
  const newCap = remainingNewCap(h, scope);
  const fresh =
    newCap > 0 ? sel("c.queue = 0 ORDER BY c.due ASC LIMIT ?", [newCap]) : [];

  const counts: DeckCounts = {
    new: fresh.length,
    learning: learning.length,
    review: review.length,
  };

  const ordered = [...learning, ...review, ...fresh];
  return { rows: ordered.slice(0, limit), due: ordered.length, counts };
}

// ---------------------------------------------------------------------------
// Deck daily limits (new/day) — gates the new-card count.
// ---------------------------------------------------------------------------

/**
 * The deck_config new/day limit (DeckConfig.Config wire field 9), decoded via
 * ankirender's decodeDeckConfig. Falls back to a large value when unreadable,
 * so the new-card cap never wrongly hides cards. All decks reference config id 1.
 */
function newPerDay(db: Database): number {
  try {
    const row = db.query("SELECT config FROM deck_config WHERE id = 1").get() as
      | { config: Uint8Array }
      | null;
    if (!row) return 9999;
    const n = decodeDeckConfig(new Uint8Array(row.config)).newPerDay;
    if (Number.isFinite(n) && n > 0) return n;
  } catch {
    /* ignore */
  }
  return 9999;
}

/**
 * Count of new cards already introduced today (revlog type=0 since day start),
 * scoped to the deck. Used to subtract from newPerDay.
 */
function newDoneToday(db: Database, scope: ReviewScope): number {
  try {
    const col = db.query("SELECT crt FROM col LIMIT 1").get() as { crt: number };
    const rollover = readConfigInt(db, "rollover") ?? DEFAULT_ROLLOVER_HOUR;
    const today = todayDayNumber(db);
    const dayStartMs = (col.crt + today * 86400 + rollover * 3600) * 1000;
    if (scope === "all") {
      const r = db
        .query(
          `SELECT COUNT(*) AS c FROM revlog rl
           JOIN cards c ON c.id = rl.cid
           WHERE rl.id >= ? AND rl.type = 0 AND c.did = ?`,
        )
        .get(dayStartMs, MIXED_DECK_ID) as { c: number };
      return r.c;
    }
    const r = db
      .query(
        `SELECT COUNT(*) AS c FROM revlog rl
         JOIN cards c ON c.id = rl.cid
         JOIN notes n ON c.nid = n.id
         WHERE rl.id >= ? AND rl.type = 0 AND (' ' || n.tags || ' ') LIKE '% zehntage %'`,
      )
      .get(dayStartMs) as { c: number };
    return r.c;
  } catch {
    return 0;
  }
}

/** Remaining new cards we may surface today (>= 0). */
function remainingNewCap(h: OpenDb, scope: ReviewScope): number {
  const limit = newPerDay(h.db);
  const done = newDoneToday(h.db, scope);
  return Math.max(0, limit - done);
}

// ---------------------------------------------------------------------------
// Rendering — delegate to ./ankirender.ts (decodeTemplate / decodeNotetype /
// renderCard / rewriteAnkiMedia / splitFields). All render calls are wrapped so
// dbReviewQueue never throws even if a stray note can't be rendered.
// ---------------------------------------------------------------------------

/** Cached per-notetype template/css/fieldNames (requires unicase tables). */
interface NotetypeRender {
  qfmt: string;
  afmt: string;
  css: string;
  fieldNames: string[];
}

/**
 * Read + decode a notetype's template (ord 0), CSS, and ordered field names.
 * Requires the `unicase` collation (fields/templates tables). Returns null when
 * unavailable so the caller degrades gracefully.
 */
function readNotetypeRender(h: OpenDb, ntid: number): NotetypeRender | null {
  if (!h.unicase) return null;
  try {
    const tplRow = h.db
      .query("SELECT config FROM templates WHERE ntid = ? AND ord = 0")
      .get(ntid) as { config: Uint8Array } | null;
    if (!tplRow) return null;
    const { qfmt, afmt } = decodeTemplate(new Uint8Array(tplRow.config));

    const ntRow = h.db.query("SELECT config FROM notetypes WHERE id = ?").get(ntid) as
      | { config: Uint8Array }
      | null;
    const css = ntRow ? decodeNotetype(new Uint8Array(ntRow.config)).css : "";

    // The field NAME lives in the `name` column (unicase TEXT), not in `config`
    // (which holds font/rtl metadata). unicase is registered so this is safe.
    const fieldRows = h.db
      .query("SELECT ord, name FROM fields WHERE ntid = ? ORDER BY ord")
      .all(ntid) as { ord: number; name: string }[];
    const fieldNames = fieldRows.map((r) => r.name ?? `Field${r.ord}`);

    return { qfmt, afmt, css, fieldNames };
  } catch {
    return null;
  }
}

/** Strip HTML to plain text (mirrors anki.ts stripHtml for the `front` label). */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Render one due row to a ReviewCard. Never throws: on any render failure it
 * falls back to raw fields so the queue stays usable. `ntCache` memoizes the
 * decoded notetype (templates/fields are stable across cards of one model).
 */
function renderRow(
  h: OpenDb,
  row: DueRow,
  ntCache: Map<number, NotetypeRender | null>,
): ReviewCard {
  const values = row.flds.split(FLD_SEP);
  const firstField = values[0] ?? "";

  const nt = getOrCompute(ntCache, row.mid, () => readNotetypeRender(h, row.mid));

  if (nt) {
    try {
      const fields = splitFields(row.flds, nt.fieldNames);
      const { question, answer } = renderCard(fields, nt.qfmt, nt.afmt, nt.css);
      const firstName = nt.fieldNames[0];
      const frontText = (firstName ? fields[firstName] : undefined) ?? firstField;
      return {
        cardId: row.cid,
        question: rewriteAnkiMedia(question),
        answer: rewriteAnkiMedia(answer),
        front: stripHtml(frontText),
      };
    } catch {
      /* fall through to raw */
    }
  }

  // Last resort: no usable notetype (e.g. no compiler → no unicase). Raw fields.
  const q = rewriteAnkiMedia(firstField);
  const a = rewriteAnkiMedia(values.slice(1).join("<br>"));
  return { cardId: row.cid, question: q, answer: a, front: stripHtml(q) };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Collection presence + openness + schema sanity. Read-only, never throws.
 */
/** Injectable deps for dbStatus (testability seam, mirrors canWrite's deps).
 *  Production always uses the real ankiRunning /proc scan. Tests that exercise
 *  the WAL/-shm file heuristic in isolation can stub the live-process signal so
 *  the result is deterministic regardless of whether the dev has Anki open. */
export interface DbStatusDeps {
  /** Live-process openness check; defaults to the real ankiRunning. */
  processRunning?: (collectionPath: string) => boolean;
}

export function dbStatus(deps: DbStatusDeps = {}): DbStatus {
  const path = collectionPath();
  const present = existsSync(path);
  if (!present) {
    return { present: false, ankiOpen: false, ver: 0, schemaOk: false };
  }

  // Openness: a non-empty -wal indicates an active or uncommitted WAL transaction;
  // a live Anki process means the DB is held open. These are the two reliable
  // signals that the collection is genuinely in use.
  //
  // NOTE: a stale `-shm` file alone does NOT mean Anki is open. SQLite leaves
  // `-shm` behind after a non-clean shutdown even when Anki has fully exited and
  // the `-wal` is empty (or absent). Counting a lone `-shm` would produce a
  // false-positive and block windowless grading. Only WAL non-empty or a live
  // process constitutes "open".
  const walNonEmpty = (() => {
    try {
      return statSync(`${path}-wal`).size > 0;
    } catch {
      return false;
    }
  })();
  let processOpen = false;
  try {
    processOpen = (deps.processRunning ?? ankiRunning)(path);
  } catch {
    processOpen = false;
  }
  // A stale -shm (without a non-empty -wal or live process) does NOT mean Anki
  // is holding the collection, so it is intentionally excluded from this signal.
  const ankiOpen = walNonEmpty || processOpen;

  const ver = readSchemaVer(path) ?? 0;
  const schemaOk = ver > 0 && schemaSupported(ver);
  return { present: ver > 0, ankiOpen, ver, schemaOk };
}

/**
 * Today's due review queue for a scope, rendered to ReviewCards. Read-only.
 * Returns { available:false } when the collection can't be opened. Never throws.
 */
export function dbReviewQueue(
  scope: ReviewScope = "zehntage",
  limit = 50,
): { available: boolean; due: number; cards: ReviewCard[] } {
  const h = openReadOnly(collectionPath());
  if (!h) return { available: false, due: 0, cards: [] };
  try {
    const { rows, due } = selectDue(h, scope, limit);
    const ntCache = new Map<number, NotetypeRender | null>();
    const cards = rows.map((row) => renderRow(h, row, ntCache));
    return { available: true, due, cards };
  } catch {
    return { available: false, due: 0, cards: [] };
  } finally {
    closeDb(h);
  }
}

/**
 * Due counts {new, learning, review} respecting deck daily limits. Read-only.
 * Returns zeros when the collection can't be opened. Never throws.
 */
export function dbDeckCounts(scope: ReviewScope = "zehntage"): DeckCounts {
  const h = openReadOnly(collectionPath());
  if (!h) return { new: 0, learning: 0, review: 0 };
  try {
    // selectDue with a large limit gives accurate counts cheaply enough here.
    const { counts } = selectDue(h, scope, 0);
    return counts;
  } catch {
    return { new: 0, learning: 0, review: 0 };
  } finally {
    closeDb(h);
  }
}

// ===========================================================================
// WINDOWLESS READ PATHS (Stage 2a — remove AnkiConnect dependency for reads).
//
// These mirror, byte-for-byte in output shape, the three AnkiConnect-only reads:
//   acListCards()  → dbListCards()   (Cards tab note list)
//   acProgress()   → dbProgress()    (per-word scheduling state for coloring)
//   retrieveMedia()→ dbGetMedia()    (card image/audio bytes)
//
// All are read-only: they open the collection via openReadOnly (snapshot-copy
// when Anki holds the WAL lock), never write, take no backup, and never throw —
// returning an empty/neutral result on any failure so the caller degrades to the
// AnkiConnect path or an empty list. Field names are resolved BY NAME from the
// notetype (reuse of the dbAddNote spec's resolution), so the mapping survives a
// field rename the same way acFieldMap does.
// ===========================================================================

/** Anki note tags are stored space-padded (" a b c "); split to a string[]. */
function parseTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw.trim().split(/\s+/).filter(Boolean);
}

/**
 * Resolve the field-name → ordinal map for a notetype, matching acFieldMap()'s
 * case-insensitive resolution exactly:
 *   front   = /front/i  (else ord 0)
 *   back    = /back/i   (else ord 1)
 *   notes   = /note/i   (optional)
 *   context = /usage|context/i and != the notes field (optional)
 * Returns ordinals into the FLD_SEP-split flds array. Requires unicase (the
 * `fields` table carries a unicase TEXT name column). Returns null otherwise.
 */
interface DbFieldMap {
  front: number;
  back: number;
  notes?: number;
  context?: number;
}
function resolveFieldMap(h: OpenDb, ntid: number): DbFieldMap | null {
  if (!h.unicase) return null;
  try {
    const rows = h.db
      .query("SELECT ord, name FROM fields WHERE ntid = ? ORDER BY ord")
      .all(ntid) as { ord: number; name: string }[];
    if (rows.length === 0) return null;
    const names = rows.map((r) => r.name ?? "");
    const findOrd = (re: RegExp): number | undefined => {
      const i = names.findIndex((n) => re.test(n));
      return i >= 0 ? rows[i]!.ord : undefined;
    };
    const front = findOrd(/front/i) ?? rows[0]!.ord;
    const back = findOrd(/back/i) ?? rows[1]?.ord ?? rows[0]!.ord;
    const map: DbFieldMap = { front, back };
    const notesOrd = findOrd(/note/i);
    if (notesOrd !== undefined) map.notes = notesOrd;
    // context = /usage|context/i AND not the same field as notes (mirrors acFieldMap).
    const ctxIdx = names.findIndex(
      (n, i) => /usage|context/i.test(n) && rows[i]!.ord !== notesOrd,
    );
    if (ctxIdx >= 0) map.context = rows[ctxIdx]!.ord;
    return map;
  } catch {
    return null;
  }
}

/** Resolve a deck id by name (unicase TEXT). Falls back to the known Mixed id. */
function resolveDeckId(h: OpenDb, name: string): number {
  if (h.unicase) {
    try {
      const row = h.db.query("SELECT id FROM decks WHERE name = ?").get(name) as
        | { id: number }
        | null;
      if (row && Number.isFinite(row.id)) return row.id;
    } catch {
      /* fall through */
    }
  }
  return MIXED_DECK_ID;
}

/**
 * Days a review card is overdue (>= 0), decoded identically to anki.ts
 * decodeDaysOverdue: only queue===2; nextDue = mod*1000 + ivl*DAY_MS;
 * floor((now - nextDue)/DAY_MS), clamped >= 0. mod is epoch SECONDS.
 */
function decodeDaysOverdueDb(
  interval: number,
  queue: number,
  mod: number,
  now: number = Date.now(),
): number {
  if (queue !== 2) return 0;
  if (
    typeof interval !== "number" ||
    typeof mod !== "number" ||
    !Number.isFinite(interval) ||
    !Number.isFinite(mod) ||
    interval < 0 ||
    mod <= 0
  ) {
    return 0;
  }
  const DAY_MS = 86_400_000;
  const nextDueMs = mod * 1000 + interval * DAY_MS;
  const overdue = Math.floor((now - nextDueMs) / DAY_MS);
  if (!Number.isFinite(overdue) || overdue < 0) return 0;
  return overdue;
}

/** AnkiCard subset returned by dbListCards (matches acListCards's output). */
export interface DbListedCard {
  front: string;
  back: string;
  notes: string;
  context: string;
  noteId: number;
  tags: string[];
}

/**
 * Read every note in the Mixed deck and return the SAME shape acListCards
 * returns: { front, back, notes, context, noteId, tags } with RAW field values
 * (HTML intact — the Cards tab strips/render-decides itself). Read-only; returns
 * [] on any failure (caller falls back to AnkiConnect / remote).
 *
 * Notes are selected via their cards' deck membership (a note may back several
 * cards; DISTINCT by note id). Field ordinals are resolved per-notetype by name.
 */
export function dbListCards(scope: ReviewScope = "all"): DbListedCard[] {
  const h = openReadOnly(collectionPath());
  if (!h) return [];
  try {
    const deckId = resolveDeckId(h, "Mixed");
    const { join: joinSql, where, params } = scope === "zehntage"
      ? {
          join: "JOIN notes n ON c.nid = n.id",
          where: "(' ' || n.tags || ' ') LIKE '% zehntage %'",
          params: [] as (string | number)[],
        }
      : {
          join: "JOIN notes n ON c.nid = n.id",
          where: "c.did = ?",
          params: [deckId] as (string | number)[],
        };
    const rows = h.db
      .query(
        `SELECT DISTINCT n.id AS id, n.mid AS mid, n.flds AS flds, n.tags AS tags
         FROM cards c ${joinSql}
         WHERE ${where}`,
      )
      .all(...params) as { id: number; mid: number; flds: string; tags: string }[];

    const fmCache = new Map<number, DbFieldMap | null>();
    const out: DbListedCard[] = [];
    for (const r of rows) {
      const fm = getOrCompute(fmCache, r.mid, () => resolveFieldMap(h, r.mid));
      const v = r.flds.split(FLD_SEP);
      const at = (ord: number | undefined): string =>
        ord === undefined ? "" : v[ord] ?? "";
      if (fm) {
        out.push({
          front: at(fm.front),
          back: at(fm.back),
          notes: at(fm.notes),
          context: at(fm.context),
          noteId: r.id,
          tags: parseTags(r.tags),
        });
      } else {
        // No unicase → can't resolve names. Fall back to positional fields so
        // the list still renders (front/back/notes/context = ord 0..3).
        out.push({
          front: v[0] ?? "",
          back: v[1] ?? "",
          notes: v[2] ?? "",
          context: v[3] ?? "",
          noteId: r.id,
          tags: parseTags(r.tags),
        });
      }
    }
    return out;
  } catch {
    return [];
  } finally {
    closeDb(h);
  }
}

/** ProgressEntry shape — identical to acProgress's per-word value. */
export interface DbProgressEntry {
  interval: number;
  due: number;
  reps: number;
  lapses: number;
  ease: number;
  queue: number;
  type: number;
  isDue: boolean;
  daysOverdue: number;
}

/**
 * Read scheduling state for ALL Mixed-deck cards and return the SAME per-word
 * map acProgress returns, KEYED BY THE RAW `front` FIELD VALUE (exactly as
 * acProgress keys by `c.fields[fm.front].value`). Each entry carries
 * { interval, due, reps, lapses, ease(=factor), queue, type, isDue, daysOverdue }.
 *
 * isDue is computed with Anki's own due semantics (mirrors selectDue):
 *   queue 1 (learning) → due <= now (epoch seconds)
 *   queue 2/3 (review/day-learn) → due <= today (day-number)
 * daysOverdue uses decodeDaysOverdue's algorithm on (ivl, queue, mod).
 *
 * When a note backs several cards with the same front, the last one wins — the
 * same as acProgress, which overwrites out[front] per card. Read-only; returns
 * {} on any failure.
 */
export function dbProgress(
  scope: ReviewScope = "all",
  now: number = Date.now(),
): Record<string, DbProgressEntry> {
  const h = openReadOnly(collectionPath());
  if (!h) return {};
  try {
    const deckId = resolveDeckId(h, "Mixed");
    const today = todayDayNumber(h.db, Math.floor(now / 1000));
    const nowSec = Math.floor(now / 1000);
    const { join: joinSql, where, params } = scope === "zehntage"
      ? {
          join: "JOIN notes n ON c.nid = n.id",
          where: "(' ' || n.tags || ' ') LIKE '% zehntage %'",
          params: [] as (string | number)[],
        }
      : {
          join: "JOIN notes n ON c.nid = n.id",
          where: "c.did = ?",
          params: [deckId] as (string | number)[],
        };
    const rows = h.db
      .query(
        `SELECT c.ivl AS ivl, c.due AS due, c.reps AS reps, c.lapses AS lapses,
                c.factor AS factor, c.queue AS queue, c.type AS type, c.mod AS mod,
                n.mid AS mid, n.flds AS flds
         FROM cards c ${joinSql}
         WHERE ${where}`,
      )
      .all(...params) as {
        ivl: number;
        due: number;
        reps: number;
        lapses: number;
        factor: number;
        queue: number;
        type: number;
        mod: number;
        mid: number;
        flds: string;
      }[];

    const fmCache = new Map<number, DbFieldMap | null>();
    const out: Record<string, DbProgressEntry> = {};
    for (const r of rows) {
      const fm = getOrCompute(fmCache, r.mid, () => resolveFieldMap(h, r.mid));
      const v = r.flds.split(FLD_SEP);
      const front = fm ? v[fm.front] ?? "" : v[0] ?? "";
      // acProgress skips cards whose front is empty/falsy (`if (!front) continue`).
      if (!front) continue;
      const isDue =
        r.queue === 1
          ? r.due <= nowSec
          : r.queue === 2 || r.queue === 3
            ? r.due <= today
            : false;
      out[front] = {
        interval: r.ivl,
        due: r.due,
        reps: r.reps,
        lapses: r.lapses,
        ease: r.factor,
        queue: r.queue,
        type: r.type,
        isDue,
        daysOverdue: decodeDaysOverdueDb(r.ivl, r.queue, r.mod, now),
      };
    }
    return out;
  } catch {
    return {};
  } finally {
    closeDb(h);
  }
}

/** Content-type for a media filename (mirrors the server's extension map). */
function mediaContentType(name: string): string {
  const i = name.lastIndexOf(".");
  const ext = i >= 0 ? name.slice(i).toLowerCase() : "";
  const types: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".oga": "audio/ogg",
    ".opus": "audio/ogg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".flac": "audio/flac",
    ".webm": "video/webm",
  };
  return types[ext] ?? "application/octet-stream";
}

export interface DbMediaResult {
  bytes: Uint8Array;
  contentType: string;
}

/**
 * Read raw bytes of a media file from the on-disk collection.media/ directory,
 * equivalent to retrieveMedia (AnkiConnect retrieveMediaFile). Returns null when
 * the file is missing or unreadable — same graceful posture as retrieveMedia
 * (which returns null on miss). Path-traversal-safe: refuses names containing a
 * slash, backslash, NUL, or "..".
 */
export function dbGetMedia(
  filename: string,
  testHooks?: { path?: string },
): DbMediaResult | null {
  const path = testHooks?.path ?? collectionPath();
  if (
    !filename ||
    filename.includes("/") ||
    filename.includes("\\") ||
    filename.includes("\0") ||
    filename.includes("..")
  ) {
    return null;
  }
  try {
    const { dir } = mediaPaths(path);
    const full = join(dir, filename);
    if (!existsSync(full)) return null;
    const bytes = new Uint8Array(readFileSync(full));
    return { bytes, contentType: mediaContentType(filename) };
  } catch {
    return null;
  }
}

// ===========================================================================
// WRITE-BACK — dbAnswerCard (windowless, offline-only). See:
//   /tmp/wave18-fsrs-writeback.md  (exact mutation recipe, schema ver 18)
//   /tmp/wave18-db-safety.md       (refuse-to-write / backup / atomicity)
//
// Fail-closed posture: this NEVER opens the real collection read-write unless
// ankilock.canWrite() passes EVERY gate (Anki not running, no hot WAL/journal,
// schema 18). A backup is taken before the first byte is written. All work
// happens inside a single BEGIN IMMEDIATE transaction; any error rolls back.
// ===========================================================================

/** Map a card's (type, queue) to the FSRS phase the kernel needs. */
function phaseOf(type: number, _queue: number): CardPhase {
  // type: 0=new 1=learning 2=review 3=relearning ; queue<0 means suspended/buried.
  if (type === 0) return "new";
  if (type === 1) return "learning";
  if (type === 3) return "relearning";
  return "review"; // type === 2
}

/** Decoded `cards.data` FSRS memory blob. */
interface CardData {
  pos?: number;
  s?: number;
  d?: number;
  dr?: number;
  decay?: number;
  lrt?: number;
  [k: string]: unknown;
}

function parseCardData(raw: unknown): CardData {
  if (raw == null) return {};
  let text: string;
  if (typeof raw === "string") text = raw;
  else if (raw instanceof Uint8Array) text = new TextDecoder().decode(raw);
  else return {};
  text = text.trim();
  if (!text) return {};
  try {
    const o = JSON.parse(text);
    return o && typeof o === "object" ? (o as CardData) : {};
  } catch {
    return {};
  }
}

/** Deck FSRS params, with per-card dr/decay overriding deck defaults. */
function deckFsrsParams(db: Database, data: CardData): FsrsParams {
  const row = db.query("SELECT config FROM deck_config WHERE id = 1").get() as
    | { config: Uint8Array }
    | null;
  if (!row) throw new Error("deck_config id=1 missing");
  const dc = decodeDeckConfig(new Uint8Array(row.config)); // throws if weights != 21
  const w = dc.weights;
  // decay magnitude: per-card `decay` is the source of truth (= -w[20]); fall
  // back to w[20] from the deck weight vector. Both should match (0.1 here).
  const decay =
    Number.isFinite(data.decay) && (data.decay as number) > 0
      ? (data.decay as number)
      : w[20];
  if (!Number.isFinite(decay) || (decay as number) <= 0) {
    throw new Error(`invalid decay ${decay}`);
  }
  // desiredRetention: per-card `dr` is canonical (spec §1.3 — the deck proto
  // float for DR decoded implausibly). Fall back to deck DR if in (0,1], else 0.9.
  let dr = Number.isFinite(data.dr) ? (data.dr as number) : NaN;
  if (!(dr > 0 && dr <= 1)) {
    dr = dc.desiredRetention > 0 && dc.desiredRetention <= 1 ? dc.desiredRetention : 0.9;
  }
  const maxInterval =
    dc.maximumReviewInterval > 0 ? dc.maximumReviewInterval : 36500;
  return {
    w,
    decay: decay as number,
    desiredRetention: dr,
    learningSteps: dc.learningSteps,
    relearningSteps: dc.relearningSteps,
    maxInterval,
  };
}

/**
 * Encode the learning `left` field: a*1000 + b where b = steps remaining to
 * graduate and a = reps remaining today (we use b for both, matching Anki's
 * fresh-step encoding closely enough for a windowless writer; spec §3.A note).
 */
function encodeLeft(stepsRemaining: number): number {
  const b = Math.max(0, stepsRemaining);
  return b * 1000 + b;
}

export interface AnswerResult {
  ok: boolean;
  error?: string;
  reason?: string;
}

export interface DeleteResult {
  ok: boolean;
  error?: string;
  reason?: string;
}

/**
 * Grade a single card directly in the real collection (offline only).
 *
 * @param cardId the `cards.id` to answer.
 * @param ease   button pressed: 1=Again, 2=Hard, 3=Good, 4=Easy.
 * @returns {ok:true} on a committed, integrity-checked write; otherwise
 *          {ok:false, reason} for a refused write (gate failed) or
 *          {ok:false, error} for an operational failure (rolled back).
 *
 * SAFETY: refuses unless ankilock.canWrite() passes all gates (Anki closed,
 * no hot WAL/journal, schema 18). Backs up before writing. One BEGIN IMMEDIATE
 * transaction; rollback on any error; never touches col.scm; sets usn=-1.
 */
export async function dbAnswerCard(
  cardId: number,
  ease: 1 | 2 | 3 | 4,
  // Test-only seam. Production code must NOT pass this. It lets the test suite
  // (a) point at a TEMP COPY collection and (b) inject the write-gate / backup
  // so the happy path can run against the copy while the real Anki is open and
  // the real collection is never touched. Defaults wire the real, fail-closed
  // implementations against the user's real collectionPath().
  testHooks?: {
    path?: string;
    canWrite?: (p: string) => { ok: boolean; reason?: string };
    backup?: (p: string) => Promise<unknown>;
  },
): Promise<AnswerResult> {
  const path = testHooks?.path ?? collectionPath();
  return withWriteTxn<AnswerResult>(
    {
      path,
      gateFn: testHooks?.canWrite ?? ((p: string) => canWrite(p)),
      backupFn: testHooks?.backup ?? ((p: string) => backupCollection(p)),
    },
    () => ({ ok: false }),
    ({ db, abort }) => {
    const card = db
      .query(
        "SELECT id, type, queue, due, ivl, factor, reps, lapses, left, data FROM cards WHERE id = ?",
      )
      .get(cardId) as
      | {
          id: number;
          type: number;
          queue: number;
          due: number;
          ivl: number;
          factor: number;
          reps: number;
          lapses: number;
          left: number;
          data: unknown;
        }
      | null;
    if (!card) return abort({ ok: false, error: `card ${cardId} not found` });

    const colRow = db.query("SELECT crt FROM col LIMIT 1").get() as { crt: number };
    const crt = colRow.crt;
    const rollover = readConfigInt(db, "rollover") ?? DEFAULT_ROLLOVER_HOUR;

    const nowMs = Date.now();
    const nowSec = Math.floor(nowMs / 1000);
    const today = Math.floor((nowSec - crt - rollover * 3600) / 86400);

    const data = parseCardData(card.data);
    const params = deckFsrsParams(db, data);
    const phase = phaseOf(card.type, card.queue);

    // Elapsed days since last review (whole days, >= 0). New cards: 0.
    const lrt = Number.isFinite(data.lrt) ? (data.lrt as number) : 0;
    const elapsedDays =
      lrt > 0 ? Math.max(0, Math.round((nowSec - lrt) / 86400)) : 0;

    const state: CardState = {
      stability: Number.isFinite(data.s) ? (data.s as number) : null,
      difficulty: Number.isFinite(data.d) ? (data.d as number) : null,
    };

    const grade = ease as Grade;
    const res = schedule(state, grade, elapsedDays, params, phase);

    // -- Derive the new card row + revlog row per spec §3/§4/§5. --
    const learnSteps =
      params.learningSteps.length > 0 ? params.learningSteps : [1, 10];
    const relearnSteps =
      params.relearningSteps.length > 0 ? params.relearningSteps : [10];
    const prevIvlDays = card.ivl; // pre-answer interval in days (column units)

    let newType: number;
    let newQueue: number;
    let newDue: number;
    let newIvl: number;
    let newLeft = card.left;
    let reps = card.reps + 1;
    let lapses = card.lapses;
    let revlogType: number; // 0 learn, 1 review, 2 relearn (pre-answer path)
    let revlogIvl: number; // signed: negative=seconds, positive=days
    let revlogLastIvl: number;

    const wasReview = phase === "review";
    const wasLearning = phase === "learning";
    const wasRelearning = phase === "relearning";
    const wasNew = phase === "new";

    // revlog "type" follows the card's PRE-answer scheduling path.
    revlogType = wasReview ? 1 : wasRelearning ? 2 : 0;

    // lastIvl: what the interval was before this review (signed).
    if (wasReview) {
      revlogLastIvl = prevIvlDays; // days
    } else if (wasLearning || wasRelearning) {
      // intraday step: previous step length unknown precisely; use seconds of
      // the current (about-to-leave) step horizon if due is epoch-sec, else 0.
      revlogLastIvl =
        card.queue === 1 && card.due > today
          ? -Math.max(60, card.due - nowSec)
          : 0;
    } else {
      revlogLastIvl = 0; // new card
    }

    const graduateToReview = () => {
      newType = 2;
      newQueue = 2;
      newIvl = res.intervalDays;
      newDue = today + newIvl;
      newLeft = 0;
      revlogIvl = newIvl; // positive days
    };

    const enterLearn = (steps: number[], stepIdx: number, relearn: boolean) => {
      const stepMin = steps[Math.min(stepIdx, steps.length - 1)] ?? 1;
      const stepSec = Math.round(stepMin * 60);
      newType = relearn ? 3 : 1;
      newQueue = 1;
      newDue = nowSec + stepSec;
      newIvl = 0;
      newLeft = encodeLeft(steps.length - stepIdx);
      revlogIvl = -stepSec; // negative seconds
    };

    if (wasNew) {
      if (grade === 4) {
        // Easy → graduate straight to review.
        graduateToReview();
      } else if (grade === 3) {
        // Good → advance to the next learning step (or graduate if 1 step).
        if (learnSteps.length <= 1) graduateToReview();
        else enterLearn(learnSteps, 1, false);
      } else {
        // Again/Hard → first learning step.
        enterLearn(learnSteps, 0, false);
      }
    } else if (wasLearning) {
      if (grade === 1) {
        enterLearn(learnSteps, 0, false); // back to step 0
      } else if (grade === 4) {
        graduateToReview();
      } else {
        // Good/Hard advance. Decode current step from `left`.
        const stepsLeft = card.left % 1000; // b = steps remaining to graduate
        const curIdx = Math.max(0, learnSteps.length - stepsLeft);
        const nextIdx = grade === 3 ? curIdx + 1 : curIdx; // Hard repeats step
        if (nextIdx >= learnSteps.length) graduateToReview();
        else enterLearn(learnSteps, nextIdx, false);
      }
    } else if (wasRelearning) {
      if (grade === 1) {
        enterLearn(relearnSteps, 0, true); // restart relearn (no extra lapse)
      } else if (grade === 4) {
        graduateToReview();
      } else {
        const stepsLeft = card.left % 1000;
        const curIdx = Math.max(0, relearnSteps.length - stepsLeft);
        const nextIdx = grade === 3 ? curIdx + 1 : curIdx;
        if (nextIdx >= relearnSteps.length) graduateToReview();
        else enterLearn(relearnSteps, nextIdx, true);
      }
    } else {
      // wasReview
      if (grade === 1) {
        // Lapse → enter relearning (or straight back to review if no steps).
        lapses += 1;
        if (relearnSteps.length > 0) {
          enterLearn(relearnSteps, 0, true);
          revlogType = 1; // the lapse review row is a review-type row
        } else {
          newType = 2;
          newQueue = 2;
          newIvl = res.intervalDays;
          newDue = today + newIvl;
          revlogIvl = newIvl;
        }
        revlogLastIvl = prevIvlDays;
      } else {
        // Hard/Good/Easy recall → stay review.
        newType = 2;
        newQueue = 2;
        newIvl = res.intervalDays;
        newDue = today + newIvl;
        revlogIvl = newIvl;
      }
    }

    // The closures assign through outer lets; assert all set.
    // (TS can't prove definite assignment across closures, so coerce.)
    const finalType = newType!;
    const finalQueue = newQueue!;
    const finalDue = newDue!;
    const finalIvl = newIvl!;
    const finalRevlogIvl = revlogIvl!;

    // Updated FSRS memory state JSON. Preserve pos; refresh s/d/dr/decay/lrt.
    const newData: CardData = {
      ...data,
      s: res.stability,
      d: res.difficulty,
      dr: params.desiredRetention,
      decay: params.decay,
      lrt: nowSec,
    };
    const dataJson = JSON.stringify(newData);

    // 5a. UPDATE cards (usn=-1, mod in SECONDS). Leave factor/odue/odid as-is.
    db.query(
      `UPDATE cards SET type=?, queue=?, due=?, ivl=?, factor=?,
          reps=?, lapses=?, left=?, data=?, mod=?, usn=-1
       WHERE id=?`,
    ).run(
      finalType,
      finalQueue,
      finalDue,
      finalIvl,
      card.factor,
      reps,
      lapses,
      newLeft,
      dataJson,
      nowSec,
      cardId,
    );

    // 5b. INSERT revlog. id = epoch-ms (unique; bump on collision). usn=-1.
    let revId = nowMs;
    const exists = db.query("SELECT 1 FROM revlog WHERE id=? LIMIT 1");
    while (exists.get(revId)) revId += 1;
    db.query(
      `INSERT INTO revlog (id, cid, usn, ease, ivl, lastIvl, factor, time, type)
       VALUES (?, ?, -1, ?, ?, ?, ?, ?, ?)`,
    ).run(
      revId,
      cardId,
      grade,
      finalRevlogIvl,
      revlogLastIvl,
      card.factor,
      0, // answer duration unknown in a windowless writer; 0ms
      revlogType,
    );

    // 5c. col bookkeeping: bump col.mod (MS). NEVER touch col.scm or col.usn.
    db.query("UPDATE col SET mod=?").run(nowMs);

    return { ok: true };
    },
  );
}

// ===========================================================================
// WRITE-BACK — dbDeleteNote (windowless, offline-only).
//
// Deletes a note (and all its cards) from the real collection, records graves
// so the deletion syncs to AnkiWeb, bumps col.mod, never touches col.scm.
//
// Same safety posture as dbAnswerCard: fail-closed, backup-first, one BEGIN
// IMMEDIATE transaction, integrity_check inside the txn (rollback on failure),
// collation-missing → skip+warn (same pattern).
// ===========================================================================

/**
 * Delete a note (resolved from `cardId`) directly in the real collection.
 *
 * @param cardId any card belonging to the note to delete.
 * @returns {ok:true} on a committed, integrity-checked write; otherwise
 *          {ok:false, reason} for refused writes or {ok:false, error} for
 *          operational failures (always rolled back).
 *
 * SAFETY: identical posture to dbAnswerCard. Refuses unless canWrite() passes.
 * Backs up before any write. One BEGIN IMMEDIATE transaction; rollback on any
 * error. Inserts graves (usn=-1) so deletions sync to AnkiWeb. Never touches
 * col.scm. Bumps col.mod (ms).
 *
 * Graves table: (usn integer, oid integer, type integer)
 *   type 0 = card, type 1 = note, type 2 = deck.
 * One grave per deleted card (type 0) + one grave for the note (type 1), all
 * with usn=-1, so the next AnkiWeb sync propagates the deletion.
 */
export async function dbDeleteNote(
  cardId: number,
  testHooks?: {
    path?: string;
    canWrite?: (p: string) => { ok: boolean; reason?: string };
    backup?: (p: string) => Promise<unknown>;
  },
): Promise<DeleteResult> {
  const path = testHooks?.path ?? collectionPath();
  return withWriteTxn<DeleteResult>(
    {
      path,
      gateFn: testHooks?.canWrite ?? ((p: string) => canWrite(p)),
      backupFn: testHooks?.backup ?? ((p: string) => backupCollection(p)),
      label: "dbDeleteNote",
      // dbDeleteNote historically ran integrity_check only (no foreign_key_check).
      foreignKeyCheck: false,
    },
    () => ({ ok: false }),
    ({ db, abort }) => {
      // Resolve the note id from the card id.
      const cardRow = db
        .query("SELECT nid FROM cards WHERE id = ?")
        .get(cardId) as { nid: number } | null;
      if (!cardRow) return abort({ ok: false, error: `card ${cardId} not found` });
      const nid = cardRow.nid;

      // Collect ALL card ids belonging to this note (may be more than one for
      // note types with multiple templates / cloze deletions).
      const cardRows = db
        .query("SELECT id FROM cards WHERE nid = ?")
        .all(nid) as { id: number }[];
      const cardIds = cardRows.map((r) => r.id);

      const nowMs = Date.now();

      // graves is a standard schema-18 table (created by Anki's migrations).
      // Delete all cards of the note, then the note itself.
      db.query("DELETE FROM cards WHERE nid = ?").run(nid);
      db.query("DELETE FROM notes WHERE id = ?").run(nid);

      // Record graves: one per deleted card (type 0) + one for the note (type 1).
      // usn=-1 marks the row as pending sync to AnkiWeb.
      const insGrave = db.query(
        "INSERT INTO graves (usn, oid, type) VALUES (-1, ?, ?)",
      );
      for (const cid of cardIds) insGrave.run(cid, 0); // type 0 = card
      insGrave.run(nid, 1); // type 1 = note

      // Bump col.mod (ms). NEVER touch col.scm or col.usn.
      db.query("UPDATE col SET mod = ?").run(nowMs);

      return { ok: true };
    },
  );
}

/**
 * Delete a note identified by its FRONT field value (the un-mine path: the web
 * only knows the card's front, e.g. `語 [よみ]`). Resolves the front to a
 * concrete cardId read-only, then delegates to dbDeleteNote (same fail-closed /
 * backup-first / graves write). Windowless — no AnkiConnect.
 *
 * Matching mirrors dbListCards: a note is read via the Mixed deck and its front
 * field is compared exactly to `front`. If several notes share a front, the
 * first found is deleted (un-mine removes the user's mined card for that word).
 *
 * @returns {ok:false, reason:"not-found"} when no note matches (treated as a
 *          no-op success by the caller — the word is already absent).
 */
export async function dbDeleteNoteByFront(
  front: string,
  testHooks?: {
    path?: string;
    canWrite?: (p: string) => { ok: boolean; reason?: string };
    backup?: (p: string) => Promise<unknown>;
  },
): Promise<DeleteResult> {
  const path = testHooks?.path ?? collectionPath();
  // Resolve front → a cardId read-only (no write, no lock).
  let cardId: number | null = null;
  const h = openReadOnly(path);
  if (h) {
    try {
      const deckId = resolveDeckId(h, "Mixed");
      const rows = h.db
        .query(
          `SELECT c.id AS cid, n.mid AS mid, n.flds AS flds
           FROM cards c JOIN notes n ON c.nid = n.id
           WHERE c.did = ?`,
        )
        .all(deckId) as { cid: number; mid: number; flds: string }[];
      const fmCache = new Map<number, DbFieldMap | null>();
      for (const r of rows) {
        const fm = getOrCompute(fmCache, r.mid, () => resolveFieldMap(h, r.mid));
        const v = r.flds.split(FLD_SEP);
        const f = fm ? v[fm.front] ?? "" : v[0] ?? "";
        if (f === front) {
          cardId = r.cid;
          break;
        }
      }
    } catch {
      cardId = null;
    } finally {
      closeDb(h);
    }
  }
  if (cardId === null) return { ok: false, reason: "not-found" };
  return dbDeleteNote(cardId, testHooks);
}

// ===========================================================================
// WRITE — dbAddNote (windowless, offline-only). See:
//   /tmp/zehntage-dbaddnote-spec.md  (empirically verified, schema ver 18)
//
// Creates EXACTLY the note + card(s) AnkiConnect's addNote would create, but by
// writing the on-disk collection directly (Anki closed). Identical safety
// posture to dbAnswerCard / dbDeleteNote: fail-closed via canWrite(), backup
// first, ONE BEGIN IMMEDIATE txn, integrity_check inside the txn (rollback on
// failure; collation-missing → skip+warn), usn=-1 on every new row, bump
// col.mod (ms), NEVER touch col.scm / col.usn / col.ver.
// ===========================================================================

/** The notetype zehntage cards use; resolved BY NAME at runtime (never the id). */
const ZR_NOTETYPE_NAME = "Back+Front+Usage";
/** The deck zehntage cards live in; resolved BY NAME at runtime. */
const ZR_DECK_NAME = "Mixed";
/** The single tag this app stamps mined cards with. */
const ZR_TAG = "zehntage";

/**
 * Anki's base91 GUID alphabet (pylib `anki/utils.py` _base91 / rslib base91).
 * 62 alphanumerics then 29 symbols — verified against real guids in the spec.
 */
const B91 =
  "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ!#$%&()*+,-./:;<=>?@[]^_`{|}~";

/**
 * Anki's `guid64()`: a random 64-bit unsigned int encoded in base91,
 * least-significant-digit first. Yields ~10 chars (91^10 > 2^64). Uniqueness is
 * for dupe/import detection, not a DB constraint.
 */
function guid64(): string {
  // 8 random bytes → unsigned 64-bit BigInt.
  const b = randomBytes(8);
  let n = 0n;
  for (let i = 0; i < 8; i++) n = (n << 8n) | BigInt(b[i] as number);
  const base = 91n;
  if (n === 0n) return B91[0] as string;
  let s = "";
  while (n > 0n) {
    s += B91[Number(n % base)] as string;
    n = n / base;
  }
  return s;
}

/** Lowercase 40-char SHA1 hex of a UTF-8 string. */
function sha1hex(s: string): string {
  return createHash("sha1").update(s, "utf8").digest("hex");
}

/** Lowercase 40-char SHA1 hex of raw bytes (media checksum). */
function sha1hexBytes(bytes: Uint8Array): string {
  return createHash("sha1").update(bytes).digest("hex");
}

/**
 * Strip a field exactly the way Anki's `fieldChecksum` (strip_html_media) does
 * for the FIRST field: remove `[sound:...]` / `[anki:...]` media tokens and HTML
 * tags, decode `&nbsp;`, but do NOT collapse internal whitespace (Anki doesn't
 * for the checksum). Our first field is `word [reading]` (no HTML), so this
 * matches the verified samples; the dedicated helper stays Anki-faithful even if
 * a reading ever contains markup.
 */
function stripForChecksum(s: string): string {
  return s
    .replace(/\[(?:sound|anki):[^\]]*\]/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ");
}

/**
 * Anki's `fieldChecksum`: int(sha1(strip_html_media(firstField))[:8], 16).
 * Verified exact against 5 real notes (spec §4.2).
 */
function fieldChecksum(firstFieldText: string): number {
  const hex = sha1hex(stripForChecksum(firstFieldText));
  return parseInt(hex.slice(0, 8), 16);
}

/** Format Anki's space-padded tag string, e.g. `" zehntage "`; `""` if none. */
function formatTags(tags: string[] | undefined): string {
  const clean = (tags ?? [])
    .map((t) => t.replace(/\s+/g, "_"))
    .filter((t) => t.length > 0);
  if (clean.length === 0) return "";
  return ` ${clean.join(" ")} `;
}

export interface AddNoteResult {
  ok: boolean;
  error?: string;
  reason?: string;
  noteId?: number;
  cardIds?: number[];
}

/**
 * Create a note (+ one card per template) directly in the real collection
 * (offline only). Field mapping mirrors AnkiConnect's acAddCard:
 *   Front ← card.front, Back ← card.back, notes ← card.notes, context ← card.context
 * Tags default to ["zehntage"]. Deck = "Mixed", notetype = "Back+Front+Usage"
 * (both resolved BY NAME from the DB; fail-closed if missing).
 *
 * @returns {ok:true, noteId, cardIds} on a committed, integrity-checked write;
 *          {ok:false, reason} for a refused write (gate failed / duplicate /
 *          locked); {ok:false, error} for an operational failure (rolled back).
 *
 * SAFETY: refuses unless canWrite() passes (Anki closed, no hot WAL/journal,
 * schema 18). Backs up before writing. One BEGIN IMMEDIATE txn; rollback on any
 * error. usn=-1 on note + cards; bumps col.mod (ms); never touches col.scm.
 */
export async function dbAddNote(
  card: {
    front: string;
    back: string;
    notes?: string;
    context?: string;
    tags?: string[];
  },
  testHooks?: {
    path?: string;
    canWrite?: (p: string) => { ok: boolean; reason?: string };
    backup?: (p: string) => Promise<unknown>;
    /** Skip the AnkiConnect-parity duplicate guard (default: enforced). */
    allowDuplicate?: boolean;
  },
): Promise<AddNoteResult> {
  const path = testHooks?.path ?? collectionPath();
  const allowDuplicate = testHooks?.allowDuplicate ?? false;
  return withWriteTxn<AddNoteResult>(
    {
      path,
      gateFn: testHooks?.canWrite ?? ((p: string) => canWrite(p)),
      backupFn: testHooks?.backup ?? ((p: string) => backupCollection(p)),
      label: "dbAddNote",
    },
    () => ({ ok: false }),
    ({ db, unicase: haveUnicase, abort }) => {
    // Early-exit alias: roll back + close + return `out` (wrapper-owned).
    const fail = (out: AddNoteResult): AddNoteResult => abort(out);

    // -- Resolve mid (notetype by name). Requires unicase. --
    if (!haveUnicase) {
      return fail({
        ok: false,
        error: "unicase collation unavailable; cannot resolve notetype by name",
      });
    }
    const ntRow = db
      .query("SELECT id FROM notetypes WHERE name = ?")
      .get(ZR_NOTETYPE_NAME) as { id: number } | null;
    if (!ntRow) {
      return fail({ ok: false, error: `notetype '${ZR_NOTETYPE_NAME}' not found` });
    }
    const mid = ntRow.id;

    // -- Field ordinals + names (ordered). --
    const fieldRows = db
      .query("SELECT ord, name FROM fields WHERE ntid = ? ORDER BY ord")
      .all(mid) as { ord: number; name: string }[];
    if (fieldRows.length === 0) {
      return fail({ ok: false, error: `notetype ${mid} has no fields` });
    }

    // -- Template ordinals (one card per row). --
    const tplRows = db
      .query("SELECT ord FROM templates WHERE ntid = ? ORDER BY ord")
      .all(mid) as { ord: number }[];
    if (tplRows.length === 0) {
      return fail({ ok: false, error: `notetype ${mid} has no templates` });
    }

    // -- Deck id by name. --
    const deckRow = db
      .query("SELECT id FROM decks WHERE name = ?")
      .get(ZR_DECK_NAME) as { id: number } | null;
    if (!deckRow) {
      return fail({ ok: false, error: `deck '${ZR_DECK_NAME}' not found` });
    }
    const did = deckRow.id;

    // -- Build flds / sfld / csum by field ordinal. --
    // Map our four logical fields onto the notetype's fields case-insensitively
    // (mirrors anki.ts acFieldMap: front→/front/i, back→/back/i, notes→/note/i,
    // context→/usage|context/i). Unmatched fields stay empty.
    const valueFor = (name: string): string => {
      if (/front/i.test(name)) return card.front;
      if (/back/i.test(name)) return card.back;
      if (/note/i.test(name)) return typeof card.notes === "string" ? card.notes : "";
      if (/usage|context/i.test(name))
        return typeof card.context === "string" ? card.context : "";
      return "";
    };
    const parts: string[] = [];
    for (const f of fieldRows) parts[f.ord] = valueFor(f.name);
    for (let i = 0; i < parts.length; i++) if (parts[i] === undefined) parts[i] = "";
    const flds = parts.join(FLD_SEP);
    const firstField = parts[0] ?? "";
    // sfld = first field, HTML/media stripped. Anki stores an int affinity when
    // the stripped value is a pure integer; otherwise text. Bind accordingly.
    const sfldText = stripForChecksum(firstField).replace(/\s+/g, " ").trim();
    const sfldNum = Number(sfldText);
    const sfld: string | number =
      sfldText !== "" && Number.isInteger(sfldNum) && String(sfldNum) === sfldText
        ? sfldNum
        : sfldText;
    const csum = fieldChecksum(firstField);
    const tags = formatTags(card.tags ?? [ZR_TAG]);

    // -- Duplicate guard (replicate allowDuplicate:false, duplicateScope:deck). --
    if (!allowDuplicate) {
      const dup = db
        .query(
          `SELECT 1 FROM notes n JOIN cards c ON c.nid = n.id
           WHERE n.csum = ? AND n.mid = ? AND c.did = ? LIMIT 1`,
        )
        .get(csum, mid, did);
      if (dup) {
        return fail({ ok: false, reason: "duplicate" });
      }
    }

    // -- guid (unique among notes; regenerate on the astronomically rare hit). --
    const guidExists = db.query("SELECT 1 FROM notes WHERE guid = ? LIMIT 1");
    let guid = guid64();
    let guidTries = 0;
    while (guidExists.get(guid) && guidTries < 16) {
      guid = guid64();
      guidTries++;
    }

    const nowMs = Date.now();
    const nowSec = Math.floor(nowMs / 1000);

    // -- Allocate unique ids (note + one per template, all distinct). --
    const nExists = db.query("SELECT 1 FROM notes WHERE id = ? LIMIT 1");
    let nid = nowMs;
    while (nExists.get(nid)) nid += 1;

    const cExists = db.query("SELECT 1 FROM cards WHERE id = ? LIMIT 1");
    const cardIds: number[] = [];
    let cid = Math.max(nid + 1, nowMs);
    for (let i = 0; i < tplRows.length; i++) {
      while (cExists.get(cid) || cid === nid || cardIds.includes(cid)) cid += 1;
      cardIds.push(cid);
      cid += 1;
    }

    // -- Next new-card position from config.nextPos (fallback to max(due)+1). --
    let pos = readConfigInt(db, "nextPos");
    const nextPosPresent = pos !== null;
    if (pos === null) {
      const mx = db
        .query("SELECT COALESCE(MAX(due),0)+1 AS p FROM cards WHERE type=0")
        .get() as { p: number };
      pos = mx.p;
    }

    // -- INSERT note. --
    db.query(
      `INSERT INTO notes (id, guid, mid, mod, usn, tags, flds, sfld, csum, flags, data)
       VALUES (?, ?, ?, ?, -1, ?, ?, ?, ?, 0, '')`,
    ).run(nid, guid, mid, nowSec, tags, flds, sfld, csum);

    // -- INSERT one card per template ordinal. --
    const insCard = db.query(
      `INSERT INTO cards (id, nid, did, ord, mod, usn, type, queue, due, ivl,
         factor, reps, lapses, left, odue, odid, flags, data)
       VALUES (?, ?, ?, ?, ?, -1, 0, 0, ?, 0, 0, 0, 0, 0, 0, 0, 0, '')`,
    );
    for (let i = 0; i < tplRows.length; i++) {
      insCard.run(
        cardIds[i] as number,
        nid,
        did,
        tplRows[i]!.ord,
        nowSec,
        (pos as number) + i,
      );
    }

    // -- Persist the bumped new-card position. --
    const newPos = (pos as number) + tplRows.length;
    if (nextPosPresent) {
      db.query(
        `UPDATE config SET val = ?, usn = -1, mtime_secs = ? WHERE key = 'nextPos'`,
      ).run(new TextEncoder().encode(JSON.stringify(newPos)), nowSec);
    } else {
      db.query(
        `INSERT INTO config (key, usn, mtime_secs, val) VALUES ('nextPos', -1, ?, ?)`,
      ).run(nowSec, new TextEncoder().encode(JSON.stringify(newPos)));
    }

    // -- col bookkeeping: bump col.mod (MS). NEVER touch col.scm / col.usn. --
    db.query("UPDATE col SET mod = ?").run(nowMs);

    return { ok: true, noteId: nid, cardIds };
    },
  );
}

// ===========================================================================
// MEDIA — dbStoreMedia (windowless, offline-only; Option A from the spec).
//
// Writes media bytes into collection.media/ AND registers the row in
// collection.media.db2 so the file syncs to AnkiWeb. Additive-only (new file +
// new/updated row); never mutates note data. Fail-closed if the media dir/db is
// missing. Best-effort callers should treat failure as non-fatal (drop audio).
// ===========================================================================

/** Path to the media dir / db2 next to a given collection.anki2. */
function mediaPaths(collection: string): { dir: string; db2: string } {
  const base = dirname(collection);
  return {
    dir: join(base, "collection.media"),
    db2: join(base, "collection.media.db2"),
  };
}

/** Split a filename into (stem, ext) where ext includes the leading dot. */
function splitExt(name: string): { stem: string; ext: string } {
  const i = name.lastIndexOf(".");
  if (i <= 0) return { stem: name, ext: "" };
  return { stem: name.slice(0, i), ext: name.slice(i) };
}

export interface StoreMediaResult {
  ok: boolean;
  error?: string;
  reason?: string;
  /** The canonical filename actually stored (may be disambiguated). */
  filename?: string;
}

/**
 * Store raw media bytes into the LOCAL collection.media/ directory and register
 * the file in collection.media.db2 (Option A — preserves audio when Anki is
 * closed). Dedups by filename+content: identical bytes under the same name reuse
 * it; different bytes under a taken name get a `-<n>` suffix.
 *
 * @returns {ok:true, filename} on success; {ok:false, error/reason} otherwise.
 */
export async function dbStoreMedia(
  bytes: Uint8Array,
  filename: string,
  testHooks?: {
    path?: string;
    canWrite?: (p: string) => { ok: boolean; reason?: string };
  },
): Promise<StoreMediaResult> {
  const path = testHooks?.path ?? collectionPath();
  const gateFn = testHooks?.canWrite ?? ((p: string) => canWrite(p));

  // Same fail-closed posture: only write media when Anki is closed.
  const gate = gateFn(path);
  if (!gate.ok) return { ok: false, reason: gate.reason ?? "refused" };

  const { dir, db2 } = mediaPaths(path);
  if (!existsSync(dir) || !existsSync(db2)) {
    return { ok: false, error: "media dir or media.db2 not present" };
  }

  // Sanitize (our generated names are already safe; be defensive anyway).
  const safe = filename.replace(/[/\\\x00]+/g, "_");
  const wantCsum = sha1hexBytes(bytes);

  let db: Database | null = null;
  let began = false;
  try {
    // Resolve a free / matching filename.
    const { stem, ext } = splitExt(safe);
    let stored = safe;
    let n = 0;
    while (existsSync(join(dir, stored))) {
      // Same name on disk — compare bytes. Identical → reuse (idempotent).
      try {
        const existing = readFileSync(join(dir, stored));
        if (sha1hexBytes(new Uint8Array(existing)) === wantCsum) {
          // Reuse: keep `stored`; the media row is upserted below.
          break;
        }
      } catch {
        /* fall through to disambiguate */
      }
      n += 1;
      stored = `${stem}-${n}${ext}`;
    }
    const fullPath = join(dir, stored);
    const reuse = existsSync(fullPath);
    if (!reuse) {
      writeFileSync(fullPath, bytes);
    }

    const mtime = Date.now();
    db = new Database(db2, { readwrite: true });
    db.exec("PRAGMA busy_timeout = 1000");
    db.exec("BEGIN IMMEDIATE");
    began = true;
    db.query(
      `INSERT INTO media (fname, csum, mtime, dirty) VALUES (?, ?, ?, 1)
       ON CONFLICT(fname) DO UPDATE SET csum=excluded.csum, mtime=excluded.mtime, dirty=1`,
    ).run(stored, wantCsum, mtime);
    db.exec("COMMIT");
    began = false;
    db.close();
    db = null;
    return { ok: true, filename: stored };
  } catch (e) {
    if (db) {
      if (began) execQuiet(db, "ROLLBACK");
      closeQuiet(db);
    }
    return { ok: false, error: (e as Error).message };
  }
}
