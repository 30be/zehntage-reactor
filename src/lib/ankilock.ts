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
  rmSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
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
  return /(^|[\\/\s])anki(\b|[\s/\\.-])/i.test(text) || /\baqt\b/i.test(text);
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
    // /proc unavailable (non-Linux). Fall through to pgrep.
  }

  if (scanned) return false;

  // Fallback: pgrep anki (best-effort, never throws).
  try {
    const out = execFileSync("pgrep", ["-i", "-f", "anki"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.split("\n").some((line) => line.trim() && line.trim() !== self);
  } catch {
    // pgrep exit 1 = no match.
    return false;
  }
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
 * Attempt a BEGIN IMMEDIATE write-lock probe against a SQLite file. Returns
 * true if the lock could NOT be acquired (busy/locked) OR the open failed —
 * i.e. "locked / unsafe". Caller decides whether to run this against a copy.
 *
 * NEVER call this against the real collection: opening rwc can create -wal/-shm
 * and acquiring the lock is itself a write intent. Use it on a temp copy only.
 */
export function busyProbeLocked(path: string): boolean {
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
 * Is the collection locked / unsafe to write?
 *
 * - true if a non-empty `<path>-wal` exists (uncheckpointed changes), or
 * - a hot `<path>-journal` exists, or
 * - (only when `opts.probe` is set, e.g. against a temp copy) a BEGIN IMMEDIATE
 *   busy-probe fails.
 *
 * For the REAL DB we pass no probe option: we only inspect sidecar files and
 * never open it read-write.
 */
export function collectionLocked(
  collectionPath: string,
  opts: { probe?: boolean } = {},
): boolean {
  if (fileNonEmpty(`${collectionPath}-wal`)) return true;
  // A rollback journal is "hot" if it exists with non-zero size.
  if (existsSync(`${collectionPath}-journal`) && fileNonEmpty(`${collectionPath}-journal`)) {
    return true;
  }
  if (opts.probe) {
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
