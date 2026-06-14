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
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// Reuse the project's existing safety/openness helpers (read-only, never write).
import { ankiRunning, readSchemaVer, schemaSupported } from "./ankilock.ts";

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
/** The single zehntage notetype "Back+Front+Usage". */
const ZEHNTAGE_NOTETYPE_ID = 1680028238431;
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

  // 1. Direct read-only open (works when Anki is closed / WAL checkpointed).
  try {
    const db = new Database(path, { readonly: true });
    try {
      db.exec("PRAGMA query_only = ON");
    } catch {
      /* ignore */
    }
    // Smoke-read the always-present, collation-free `col` table.
    db.query("SELECT crt FROM col LIMIT 1").get();
    const unicase = tryRegisterUnicase(db);
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
    const db = new Database(dst, { readonly: true });
    try {
      db.exec("PRAGMA query_only = ON");
    } catch {
      /* ignore */
    }
    db.query("SELECT crt FROM col LIMIT 1").get();
    const unicase = tryRegisterUnicase(db);
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

  let nt = ntCache.get(row.mid);
  if (nt === undefined) {
    nt = readNotetypeRender(h, row.mid);
    ntCache.set(row.mid, nt);
  }

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
export function dbStatus(): DbStatus {
  const path = collectionPath();
  const present = existsSync(path);
  if (!present) {
    return { present: false, ankiOpen: false, ver: 0, schemaOk: false };
  }

  // Openness: a non-empty -wal or a -shm, or a live Anki process.
  const walNonEmpty = (() => {
    try {
      return statSync(`${path}-wal`).size > 0;
    } catch {
      return false;
    }
  })();
  const shmExists = existsSync(`${path}-shm`);
  let processOpen = false;
  try {
    processOpen = ankiRunning(path);
  } catch {
    processOpen = false;
  }
  const ankiOpen = walNonEmpty || shmExists || processOpen;

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
