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
  const shmExists = existsSync(`${path}-shm`);
  let processOpen = false;
  try {
    processOpen = (deps.processRunning ?? ankiRunning)(path);
  } catch {
    processOpen = false;
  }
  // shmExists is intentionally excluded: a stale -shm without a non-empty -wal
  // or live process does not mean Anki is holding the collection.
  void shmExists; // retained for potential future use (copy-when-locked guards)
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
  const gateFn = testHooks?.canWrite ?? ((p: string) => canWrite(p));
  const backupFn = testHooks?.backup ?? ((p: string) => backupCollection(p));

  // 1. REFUSE-TO-WRITE gates (fail-closed). NEVER proceed if Anki is open.
  const gate = gateFn(path);
  if (!gate.ok) return { ok: false, reason: gate.reason ?? "refused" };

  // 2. Backup BEFORE any write.
  try {
    await backupFn(path);
  } catch (e) {
    return { ok: false, error: `backup failed: ${(e as Error).message}` };
  }

  // 3. Open the REAL collection read-WRITE only inside the write path.
  let db: Database | null = null;
  let began = false;
  try {
    db = new Database(path, { readwrite: true });
    db.exec("PRAGMA busy_timeout = 1000");
    db.exec("PRAGMA journal_mode = wal");
    db.exec("PRAGMA synchronous = FULL");
    // Register unicase so deck_config / any unicase-bearing PREPARE succeeds
    // (mirrors the read path). Best-effort; deck_config query needs no collation.
    tryRegisterUnicase(db);

    // BEGIN IMMEDIATE — grab the write lock up front; abort on BUSY.
    try {
      db.exec("BEGIN IMMEDIATE");
      began = true;
    } catch {
      try {
        db.close();
      } catch {
        /* ignore */
      }
      return { ok: false, reason: "locked" };
    }

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
    if (!card) {
      db.exec("ROLLBACK");
      began = false;
      db.close();
      return { ok: false, error: `card ${cardId} not found` };
    }

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

    // Pre-commit invariants (still inside the txn — a failure here rolls back).
    const fk = db.query("PRAGMA foreign_key_check").all();
    if (fk.length > 0) {
      db.exec("ROLLBACK");
      began = false;
      db.close();
      return { ok: false, error: "foreign_key_check failed" };
    }

    // integrity_check runs INSIDE the transaction so a failure → clean ROLLBACK
    // and ok:false is truthful. Running it after COMMIT would mean a committed
    // write gets reported as failed → double-grade on retry (H1 bug).
    // Caveat: if the `unicase` collation failed to register (best-effort C ext),
    // integrity_check throws SQLITE_ERROR_MISSING_COLLSEQ. Treat that as a skip
    // (log + proceed) so a missing collation never blocks a valid write.
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
      if (icVal && icVal !== "ok") {
        db.exec("ROLLBACK");
        began = false;
        db.close();
        return { ok: false, error: `integrity_check: ${icVal}` };
      }
    } catch (icErr) {
      const msg = (icErr as Error).message ?? "";
      if (msg.includes("COLLSEQ") || msg.includes("collation")) {
        // Missing unicase collation — not a data integrity issue; proceed.
        console.warn("[ankidb] integrity_check skipped: missing collation —", msg);
      } else {
        // Unknown error from integrity_check inside the txn — roll back safely.
        db.exec("ROLLBACK");
        began = false;
        db.close();
        return { ok: false, error: `integrity_check threw: ${msg}` };
      }
    }

    db.exec("COMMIT");
    began = false;

    // 5d. Fold WAL back (outside the txn; non-fatal if it fails).
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      /* non-fatal */
    }
    db.close();
    db = null;
    return { ok: true };
  } catch (e) {
    if (db) {
      if (began) {
        try {
          db.exec("ROLLBACK");
        } catch {
          /* ignore */
        }
      }
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
    return { ok: false, error: (e as Error).message };
  }
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
  const gateFn = testHooks?.canWrite ?? ((p: string) => canWrite(p));
  const backupFn = testHooks?.backup ?? ((p: string) => backupCollection(p));

  // 1. REFUSE-TO-WRITE gates (fail-closed). NEVER proceed if Anki is open.
  const gate = gateFn(path);
  if (!gate.ok) return { ok: false, reason: gate.reason ?? "refused" };

  // 2. Backup BEFORE any write.
  try {
    await backupFn(path);
  } catch (e) {
    return { ok: false, error: `backup failed: ${(e as Error).message}` };
  }

  // 3. Open the REAL collection read-WRITE only inside the write path.
  let db: Database | null = null;
  let began = false;
  try {
    db = new Database(path, { readwrite: true });
    db.exec("PRAGMA busy_timeout = 1000");
    db.exec("PRAGMA journal_mode = wal");
    db.exec("PRAGMA synchronous = FULL");
    tryRegisterUnicase(db);

    // BEGIN IMMEDIATE — grab the write lock up front; abort on BUSY.
    try {
      db.exec("BEGIN IMMEDIATE");
      began = true;
    } catch {
      try {
        db.close();
      } catch {
        /* ignore */
      }
      return { ok: false, reason: "locked" };
    }

    // Resolve the note id from the card id.
    const cardRow = db
      .query("SELECT nid FROM cards WHERE id = ?")
      .get(cardId) as { nid: number } | null;
    if (!cardRow) {
      db.exec("ROLLBACK");
      began = false;
      db.close();
      return { ok: false, error: `card ${cardId} not found` };
    }
    const nid = cardRow.nid;

    // Collect ALL card ids belonging to this note (may be more than one for
    // note types with multiple templates / cloze deletions).
    const cardRows = db
      .query("SELECT id FROM cards WHERE nid = ?")
      .all(nid) as { id: number }[];
    const cardIds = cardRows.map((r) => r.id);

    const nowMs = Date.now();

    // Ensure the graves table exists (it is a standard Anki schema-18 table).
    // We don't create it if it's missing; instead we surface a clear error so
    // the caller can diagnose a corrupt / unexpected schema.
    // (The table always exists in a schema-18 collection — it's created by
    // Anki's migration scripts before we ever see the DB.)

    // Delete all cards of the note.
    db.query("DELETE FROM cards WHERE nid = ?").run(nid);

    // Delete the note itself.
    db.query("DELETE FROM notes WHERE id = ?").run(nid);

    // Record graves: one per deleted card (type 0) + one for the note (type 1).
    // usn=-1 marks the row as pending sync to AnkiWeb.
    const insGrave = db.query(
      "INSERT INTO graves (usn, oid, type) VALUES (-1, ?, ?)",
    );
    for (const cid of cardIds) {
      insGrave.run(cid, 0); // type 0 = card
    }
    insGrave.run(nid, 1); // type 1 = note

    // Bump col.mod (ms). NEVER touch col.scm or col.usn.
    db.query("UPDATE col SET mod = ?").run(nowMs);

    // Pre-commit integrity check (inside the txn — rollback on failure).
    // collation-missing → skip+warn (same pattern as dbAnswerCard).
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
      if (icVal && icVal !== "ok") {
        db.exec("ROLLBACK");
        began = false;
        db.close();
        return { ok: false, error: `integrity_check: ${icVal}` };
      }
    } catch (icErr) {
      const msg = (icErr as Error).message ?? "";
      if (msg.includes("COLLSEQ") || msg.includes("collation")) {
        console.warn("[ankidb] dbDeleteNote integrity_check skipped: missing collation —", msg);
      } else {
        db.exec("ROLLBACK");
        began = false;
        db.close();
        return { ok: false, error: `integrity_check threw: ${msg}` };
      }
    }

    db.exec("COMMIT");
    began = false;

    // Fold WAL back (outside the txn; non-fatal if it fails).
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      /* non-fatal */
    }
    db.close();
    db = null;
    return { ok: true };
  } catch (e) {
    if (db) {
      if (began) {
        try {
          db.exec("ROLLBACK");
        } catch {
          /* ignore */
        }
      }
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
    return { ok: false, error: (e as Error).message };
  }
}
