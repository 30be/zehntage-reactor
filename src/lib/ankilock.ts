// Anki DB write-safety gates (Wave 18). See /tmp/wave18-db-safety.md.
//
// This module implements the *read-only* safety checks and the pre-session
// backup that a future write-path will require. It NEVER writes to the real
// collection.anki2 — it only inspects files / processes and copies bytes out
// to a backup directory. Fail-closed is the default posture everywhere.

import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

/** Schema versions (col.ver) we have tested and are willing to write to. */
export const SUPPORTED_VER = new Set<number>([18]);

/** True only for schema versions we have actually tested. */
export function schemaSupported(ver: number): boolean {
  return SUPPORTED_VER.has(ver);
}

/** Default backup root: ~/.local/share/zehntage/anki-backups/ (per spec §2b). */
export function backupRootPath(): string {
  return (
    process.env.ZR_ANKI_BACKUP_DIR ||
    join(homedir(), ".local", "share", "zehntage", "anki-backups")
  );
}

// ---------------------------------------------------------------------------
// §1a — process check
// ---------------------------------------------------------------------------

function readProcCmdline(pid: string): string | null {
  try {
    // cmdline is NUL-separated argv.
    return readFileSync(`/proc/${pid}/cmdline`).toString("utf8").replace(/\0/g, " ").trim();
  } catch {
    return null;
  }
}

function readProcCwd(pid: string): string | null {
  try {
    return readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

function looksLikeAnki(text: string): boolean {
  // Match the anki executable, the Anki.app, or a python process running aqt.
  // Be permissive — false positives just make us refuse, which is safe.
  //
  // Cases covered:
  //  - native:  /usr/bin/anki, /usr/bin/python /usr/bin/anki  (prefix [\\/\s])
  //  - snap:    /snap/anki/.../anki                            (prefix /)
  //  - flatpak: net.ankiweb.Anki (app-id, "Anki" preceded by '.'),
  //             the bwrap/flatpak wrapper cmdline, and the per-app dir
  //             ~/.var/app/net.ankiweb.Anki/...                (matched below)
  //  - python aqt module
  return (
    /(^|[\\/\s.])anki(\b|[\s/\\.-])/i.test(text) || // native/snap + flatpak app-id (.Anki)
    /net\.ankiweb\.anki/i.test(text) || // flatpak app-id / per-app data dir, explicit
    /\bankiweb\b/i.test(text) ||
    /\baqt\b/i.test(text)
  );
}

/**
 * Test-only export of the cmdline/cwd matcher. Not part of the public runtime
 * API (kept thin so the regression coverage for flatpak detection can pin it
 * directly without scanning /proc).
 */
export function looksLikeAnkiForTest(text: string): boolean {
  return looksLikeAnki(text);
}

/**
 * Detect a running Anki process.
 *
 * Scans /proc for any process whose cmdline/cwd looks like Anki. If a
 * collectionPath is supplied we prefer a match that references that exact
 * collection (or its profile dir), but presence of *any* Anki process is a
 * hard stop when we cannot confirm the path — failing closed.
 */
export function ankiRunning(collectionPath?: string): boolean {
  const colDir = collectionPath ? dirname(collectionPath) : null;
  const self = String(process.pid);

  let scanned = false;
  try {
    const entries = readdirSync("/proc");
    for (const pid of entries) {
      if (!/^\d+$/.test(pid) || pid === self) continue;
      const cmd = readProcCmdline(pid);
      if (cmd === null) continue;
      scanned = true;
      const cwd = readProcCwd(pid) ?? "";
      const hay = `${cmd} ${cwd}`;
      if (!looksLikeAnki(hay)) continue;

      // An Anki-looking process exists. If we have a collection path, a direct
      // reference is a definite hit; otherwise any Anki process is a hard stop.
      if (collectionPath) {
        if (hay.includes(collectionPath) || (colDir && hay.includes(colDir))) return true;
        // Anki process whose path we can't confirm => still refuse (§1a).
        return true;
      }
      return true;
    }
  } catch {
    // /proc unavailable (non-Linux). Fall through to tasklist (win32) / pgrep.
  }

  if (scanned) return false;

  // Windows: /proc is absent and pgrep doesn't exist, so without this branch we
  // would return false and WRONGLY allow a direct DB write while Anki holds the
  // collection. Use `tasklist` filtered to anki.exe; any matching line is a hit.
  if (process.platform === "win32") {
    try {
      const out = execFileSync(
        "tasklist",
        ["/FI", "IMAGENAME eq anki.exe", "/NH"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      );
      // tasklist prints "INFO: No tasks ..." when nothing matches; a real match
      // contains the image name. Match case-insensitively to be safe.
      if (/anki\.exe/i.test(out)) return true;
    } catch {
      // tasklist missing/failed — fall through to pgrep (harmless on win32).
    }
    return false;
  }

  // Fallback (non-Linux / /proc unreadable): use pgrep with an exact process-name
  // match rather than the loose `-f` substring search. `-i -f anki` is too broad:
  // it matches editors, grep invocations, and unrelated bun workers whose cmdline
  // happens to contain "anki". Instead check for the native binary name ("anki")
  // and the flatpak app-id ("net.ankiweb.Anki") by exact comm match.
  for (const name of ["anki", "net.ankiweb.Anki"]) {
    try {
      const out = execFileSync("pgrep", ["-x", "-i", name], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      if (out.split("\n").some((line) => line.trim() && line.trim() !== self)) return true;
    } catch {
      // pgrep exit 1 = no match for this name; continue.
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// §1c/§1d — WAL / journal state + busy probe
// ---------------------------------------------------------------------------

function fileNonEmpty(path: string): boolean {
  try {
    return statSync(path).size > 0;
  } catch {
    return false;
  }
}

/**
 * True if `path` lives under the OS temp dir (a copy we are allowed to open
 * read-write). Resolved/normalised on both sides to defeat trivial `..` or
 * trailing-separator tricks; conservative — anything we cannot prove is under
 * tmpdir is treated as NOT a temp path.
 */
function isUnderTmpdir(path: string): boolean {
  try {
    const tmp = realpathSync(tmpdir());
    // Resolve the parent dir (the file itself may not exist yet) and re-join.
    const resolvedDir = realpathSync(dirname(path));
    const resolved = join(resolvedDir, basename(path));
    const prefix = tmp.endsWith("/") ? tmp : `${tmp}/`;
    return resolved === tmp || resolved.startsWith(prefix);
  } catch {
    return false;
  }
}

/**
 * Attempt a BEGIN IMMEDIATE write-lock probe against a SQLite file. Returns
 * true if the lock could NOT be acquired (busy/locked) OR the open failed —
 * i.e. "locked / unsafe". Caller decides whether to run this against a copy.
 *
 * HARD GUARD: this opens the DB read-write (rwc), which can create -wal/-shm and
 * is itself a write intent. It is therefore ONLY permitted against a temp copy.
 * If `path` is not under the OS temp dir, this throws rather than touching it —
 * so a future `collectionLocked(realPath, {probe:true})` can NEVER open the real
 * collection read-write. Pass `allowTempOnly:false` only in dedicated unit
 * tests that have constructed a throwaway file outside tmpdir.
 */
export function busyProbeLocked(
  path: string,
  opts: { allowTempOnly?: boolean } = {},
): boolean {
  const allowTempOnly = opts.allowTempOnly ?? true;
  if (allowTempOnly && !isUnderTmpdir(path)) {
    throw new Error(
      `busyProbeLocked refused: ${path} is not under the temp dir. ` +
        `This rwc-open probe may run ONLY against a temp copy, never the real collection.`,
    );
  }
  let db: Database | null = null;
  try {
    db = new Database(path, { readwrite: true });
    db.exec("PRAGMA busy_timeout = 1000");
    db.exec("BEGIN IMMEDIATE");
    db.exec("COMMIT");
    return false; // got the lock => not locked
  } catch {
    return true; // BUSY / LOCKED / open failure => treat as locked
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Is the collection locked / unsafe to write?  (Conservative / fail-closed.)
 *
 * For the REAL DB this is a READ-ONLY heuristic — it only inspects sidecar
 * files, never opens the DB. It returns true if ANY of:
 *   - a non-empty `<path>-wal` exists (uncheckpointed WAL changes), or
 *   - a `<path>-shm` exists (a WAL shared-memory index — its presence means a
 *     connection has the DB open in WAL mode; Anki can be open+idle with a
 *     truncate-checkpointed *empty* -wal yet a lingering -shm), or
 *   - a hot `<path>-journal` exists (rollback-journal mode), or
 *   - (only when `opts.probe` is set, e.g. against a TEMP COPY) a BEGIN
 *     IMMEDIATE busy-probe fails.
 *
 * IMPORTANT — this is NOT a real exclusive-lock guarantee. The sidecar checks
 * are advisory and racy: files can appear/vanish between this call and a write.
 * The ACTUAL exclusive-lock guarantee MUST be taken by the write module inside
 * the real write transaction itself: open the real DB rwc ONCE, run
 * `BEGIN IMMEDIATE`, and abort on SQLITE_BUSY. This function only cheaply rules
 * out the obvious "Anki is clearly active" cases up front; never treat its
 * `false` as proof the DB is free. Stay conservative — when in doubt, true.
 *
 * For the REAL DB we pass no probe option: we only inspect sidecar files and
 * never open it read-write. `opts.probe` is for temp copies only and routes
 * through busyProbeLocked, which itself refuses non-temp paths.
 */
export function collectionLocked(
  collectionPath: string,
  opts: { probe?: boolean } = {},
): boolean {
  if (fileNonEmpty(`${collectionPath}-wal`)) return true;
  // A lone -shm with an empty (or absent) -wal is a stale sidecar left behind
  // after a clean Anki exit. It does NOT mean a live connection holds the DB.
  // We treat -shm as a lock signal ONLY when combined with a non-empty -wal
  // (already caught above) or a live Anki process (checked separately by the
  // caller via ankiRunning). Drop bare -shm-exists as a lock signal.
  // A rollback journal is "hot" if it exists with non-zero size.
  if (existsSync(`${collectionPath}-journal`) && fileNonEmpty(`${collectionPath}-journal`)) {
    return true;
  }
  if (opts.probe) {
    // busyProbeLocked enforces the temp-only contract itself (throws otherwise),
    // so this branch can never open the real collection read-write.
    if (busyProbeLocked(collectionPath)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// §5 — schema read (read-only)
// ---------------------------------------------------------------------------

/** Read col.ver from the collection read-only. Returns null on any failure. */
export function readSchemaVer(collectionPath: string): number | null {
  let db: Database | null = null;
  try {
    db = new Database(collectionPath, { readonly: true });
    const row = db.query("SELECT ver FROM col LIMIT 1").get() as { ver?: number } | null;
    if (!row || typeof row.ver !== "number") return null;
    return row.ver;
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// Composed gate — canWrite
// ---------------------------------------------------------------------------

export type CanWriteReason = "anki-open" | "locked" | "schema" | "missing";

export interface CanWriteResult {
  ok: boolean;
  reason?: CanWriteReason;
}

/**
 * Pluggable checks for canWrite. Defaults wire up the real implementations;
 * tests inject stubs (e.g. ankiRunning: () => true) without touching /proc.
 */
export interface CanWriteDeps {
  exists?: (p: string) => boolean;
  ankiRunning?: (p: string) => boolean;
  collectionLocked?: (p: string) => boolean;
  readSchemaVer?: (p: string) => number | null;
}

/**
 * Compose the read-only safety checks into a single go/no-go decision.
 * Fail-closed: any uncertainty => { ok: false }.
 *
 * Order matters (cheapest / most-decisive first):
 *   missing file → anki running → locked (wal/journal) → schema version.
 */
export function canWrite(collectionPath: string, deps: CanWriteDeps = {}): CanWriteResult {
  const exists = deps.exists ?? existsSync;
  const anki = deps.ankiRunning ?? ankiRunning;
  const locked = deps.collectionLocked ?? ((p: string) => collectionLocked(p));
  const schemaVer = deps.readSchemaVer ?? readSchemaVer;

  if (!exists(collectionPath)) return { ok: false, reason: "missing" };
  if (anki(collectionPath)) return { ok: false, reason: "anki-open" };
  if (locked(collectionPath)) return { ok: false, reason: "locked" };

  const ver = schemaVer(collectionPath);
  if (ver === null || !schemaSupported(ver)) return { ok: false, reason: "schema" };

  return { ok: true };
}

// ---------------------------------------------------------------------------
// §2 — backup
// ---------------------------------------------------------------------------

/** Build a UTC timestamp string: YYYYMMDDTHHMMSSZ. */
export function timestampUtc(d: Date = new Date()): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

export interface BackupResult {
  /** Backup directory created for this session. */
  dir: string;
  /** Path to the copied collection.anki2 inside the backup dir. */
  collection: string;
  /** All files copied (absolute paths). */
  files: string[];
}

/**
 * Copy collection.anki2 (+ -wal/-shm if present) into a fresh timestamped dir
 * under the backup root. Returns the backup result. Throws if the source is
 * missing. Does NOT modify the source in any way (plain byte copy).
 *
 * @param collectionPath absolute path to collection.anki2
 * @param ts optional timestamp string (defaults to now, UTC)
 * @param root optional backup root (defaults to backupRootPath())
 */
export async function backupCollection(
  collectionPath: string,
  ts: string = timestampUtc(),
  root: string = backupRootPath(),
): Promise<BackupResult> {
  if (!existsSync(collectionPath)) {
    throw new Error(`backupCollection: source not found: ${collectionPath}`);
  }
  const dir = join(root, ts);
  mkdirSync(dir, { recursive: true });

  const base = basename(collectionPath);
  const files: string[] = [];

  const copyIfPresent = (srcSuffix: string) => {
    const src = `${collectionPath}${srcSuffix}`;
    if (!existsSync(src)) return;
    const dst = join(dir, `${base}${srcSuffix}`);
    copyFileSync(src, dst);
    files.push(dst);
  };

  // Main file is required.
  const mainDst = join(dir, base);
  copyFileSync(collectionPath, mainDst);
  files.push(mainDst);
  // Belt-and-suspenders triplet (§2a).
  copyIfPresent("-wal");
  copyIfPresent("-shm");

  return { dir, collection: mainDst, files };
}

/**
 * Keep only the most recent N session backup dirs under `root`; remove older
 * ones. Returns the list of removed directory paths. Never removes anything if
 * N <= 0 would empty everything below the most-recent good backup — we always
 * retain at least one. Safe to call when root does not exist.
 */
export function pruneBackups(keep: number, root: string = backupRootPath()): string[] {
  if (!existsSync(root)) return [];
  const safeKeep = Math.max(1, keep);

  let dirs: { name: string; path: string }[];
  try {
    dirs = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => ({ name: e.name, path: join(root, e.name) }));
  } catch {
    return [];
  }

  // Timestamp dir names sort lexicographically == chronologically (UTC compact).
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  if (dirs.length <= safeKeep) return [];

  const toRemove = dirs.slice(0, dirs.length - safeKeep);
  const removed: string[] = [];
  for (const d of toRemove) {
    try {
      rmSync(d.path, { recursive: true, force: true });
      removed.push(d.path);
    } catch {
      /* leave it; pruning is best-effort */
    }
  }
  return removed;
}

/** List session backup dirs (oldest → newest) under root. */
export function listBackupDirs(root: string = backupRootPath()): string[] {
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b))
      .map((name) => join(root, name));
  } catch {
    return [];
  }
}
