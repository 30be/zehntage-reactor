// Backup/restore of zehntage-reactor state.
//
// A backup is a tar.gz containing:
//   manifest.json     — { createdAt, version, files[] }
//   events.jsonl      — telemetry log (if it exists)
//   config/…          — the whole config dir (settings.json etc.)
//   subs/<rel>/…      — every subs/ dir under the library root
//                       (rel = path of the subs dir relative to the root)
//
// Default destination: ~/.local/share/zehntage-reactor/backups/, with
// rotation keeping the newest KEEP_BACKUPS archives.
//
// restoreBackup() puts back events.jsonl and config/ ONLY. Subtitles are
// deliberately NOT restored automatically: subs/ dirs live inside the
// user's media library, whose layout may have changed since the backup
// (moved/renamed shows, different mediaRoot). Silently writing into the
// library could clobber newer generated subs or recreate directories for
// media that no longer exists — extract the tarball manually instead.

import { homedir, tmpdir } from "node:os";
import { join, dirname, relative } from "node:path";
import { mkdir, mkdtemp, readdir, rm, stat, cp, copyFile } from "node:fs/promises";
import { eventsFilePath } from "./telemetry.ts";
import { buildExportBundle, type ExportBundle } from "./datatransfer.ts";
import { appVersion } from "./assets.ts";

export const KEEP_BACKUPS = 10;

export interface BackupManifest {
  createdAt: string;
  version: string;
  /** Paths inside the archive (relative, POSIX). */
  files: string[];
}

export interface BackupResult {
  /** Absolute path of the created tar.gz. */
  path: string;
  manifest: BackupManifest;
}

/** Config dir, resolved at call time (ZR_CONFIG_DIR override for tests). */
export function configDirPath(): string {
  return process.env.ZR_CONFIG_DIR || join(homedir(), ".config", "zehntage-reactor");
}

export function defaultBackupDir(): string {
  return join(homedir(), ".local", "share", "zehntage-reactor", "backups");
}

// App version: compile-time constant in a release binary, package.json in dev
// (see assets.ts). Reading ../../package.json via import.meta.url would break in
// a `bun build --compile` binary that has no repo beside it.
function packageVersion(): Promise<string> {
  return appVersion();
}

/** mediaRoot from settings.json (read directly so env overrides apply at call time). */
async function libraryRootFromSettings(): Promise<string | null> {
  try {
    const s = (await Bun.file(join(configDirPath(), "settings.json")).json()) as {
      mediaRoot?: unknown;
    };
    return typeof s.mediaRoot === "string" && s.mediaRoot ? s.mediaRoot : null;
  } catch {
    return null;
  }
}

/** Recursively collect dirs named "subs" (case-insensitive) under root. */
export async function findSubsDirs(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (name.startsWith(".") || name === "node_modules") continue;
      const full = join(dir, name);
      let st;
      try {
        st = await stat(full);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      if (name.toLowerCase() === "subs") out.push(full);
      else await walk(full);
    }
  }
  await walk(root);
  return out;
}

async function listFilesRec(dir: string, prefix: string, out: string[]): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names.sort()) {
    const full = join(dir, name);
    const st = await stat(full).catch(() => null);
    if (!st) continue;
    if (st.isDirectory()) await listFilesRec(full, `${prefix}${name}/`, out);
    else out.push(`${prefix}${name}`);
  }
}

async function runTar(args: string[]): Promise<void> {
  const proc = Bun.spawn(["tar", ...args], { stdout: "ignore", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`tar ${args[0]} failed (exit ${code}): ${err.trim()}`);
  }
}

/** Delete all but the newest `keep` backup-*.tar.gz in dir. Returns deleted paths. */
// Best-effort delete each name under dir; returns the paths actually removed.
async function rmEach(dir: string, names: string[]): Promise<string[]> {
  const deleted: string[] = [];
  for (const name of names) {
    try {
      await rm(join(dir, name));
      deleted.push(join(dir, name));
    } catch {
      // best effort
    }
  }
  return deleted;
}

export async function rotateBackups(dir: string, keep = KEEP_BACKUPS): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const backups = names.filter((n) => /^backup-.*\.tar\.gz$/.test(n)).sort();
  const doomed = backups.slice(0, Math.max(0, backups.length - keep));
  return rmEach(dir, doomed);
}

export interface CreateBackupOptions {
  /** Override library root (default: settings.mediaRoot; none → no subs). */
  libraryRoot?: string;
  /** Rotation count (default KEEP_BACKUPS). */
  keep?: number;
}

export async function createBackup(
  destDir?: string,
  opts: CreateBackupOptions = {},
): Promise<BackupResult> {
  const dest = destDir ?? defaultBackupDir();
  await mkdir(dest, { recursive: true });
  const staging = await mkdtemp(join(tmpdir(), "zr-backup-"));
  try {
    const files: string[] = [];

    // events.jsonl
    const events = eventsFilePath();
    if (await Bun.file(events).exists()) {
      await copyFile(events, join(staging, "events.jsonl"));
      files.push("events.jsonl");
    }

    // config dir
    const configDir = configDirPath();
    if (await stat(configDir).then((s) => s.isDirectory()).catch(() => false)) {
      await cp(configDir, join(staging, "config"), { recursive: true });
      await listFilesRec(join(staging, "config"), "config/", files);
    }

    // subs/ dirs under the library root
    const root = opts.libraryRoot ?? (await libraryRootFromSettings());
    if (root) {
      for (const subsDir of await findSubsDirs(root)) {
        const rel = relative(root, subsDir).split("/").join("/"); // POSIX on linux
        const target = join(staging, "subs", rel);
        await mkdir(dirname(target), { recursive: true });
        await cp(subsDir, target, { recursive: true });
        await listFilesRec(target, `subs/${rel}/`, files);
      }
    }

    const manifest: BackupManifest = {
      createdAt: new Date().toISOString(),
      version: await packageVersion(),
      files: files.sort(),
    };
    await Bun.write(join(staging, "manifest.json"), JSON.stringify(manifest, null, 2));

    const stampSrc = manifest.createdAt.replace(/[:.]/g, "-");
    const tarPath = join(dest, `backup-${stampSrc}.tar.gz`);
    await runTar(["-czf", tarPath, "-C", staging, "."]);
    await rotateBackups(dest, opts.keep ?? KEEP_BACKUPS);
    return { path: tarPath, manifest };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export interface RestoreResult {
  manifest: BackupManifest | null;
  /** Absolute paths written. */
  restored: string[];
  /** subs/ entries present in the archive but intentionally skipped. */
  skippedSubs: number;
}

/**
 * Restore events.jsonl and config/ from a backup archive.
 * Subtitles in the archive are NOT restored (see module comment).
 */
export async function restoreBackup(tarPath: string): Promise<RestoreResult> {
  if (!(await Bun.file(tarPath).exists())) {
    throw new Error(`No such backup: ${tarPath}`);
  }
  const staging = await mkdtemp(join(tmpdir(), "zr-restore-"));
  try {
    // Path-traversal guard: list entries before extracting and reject any
    // that contain ".." segments or start with "/" (absolute paths).
    const listProc = Bun.spawn(["tar", "-tzf", tarPath], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const listCode = await listProc.exited;
    if (listCode !== 0) {
      const err = await new Response(listProc.stderr).text();
      throw new Error(`tar -tzf failed (exit ${listCode}): ${err.trim()}`);
    }
    const listing = await new Response(listProc.stdout).text();
    for (const entry of listing.split("\n")) {
      if (!entry) continue;
      if (entry.startsWith("/") || entry.split("/").includes("..")) {
        throw new Error(`Refusing to extract archive: unsafe path "${entry}"`);
      }
    }
    await runTar(["-xzf", tarPath, "-C", staging]);

    let manifest: BackupManifest | null = null;
    try {
      manifest = (await Bun.file(join(staging, "manifest.json")).json()) as BackupManifest;
    } catch {
      // tolerate manifest-less archives
    }

    const restored: string[] = [];

    const eventsSrc = join(staging, "events.jsonl");
    if (await Bun.file(eventsSrc).exists()) {
      const target = eventsFilePath();
      await mkdir(dirname(target), { recursive: true });
      await copyFile(eventsSrc, target);
      restored.push(target);
    }

    const configSrc = join(staging, "config");
    if (await stat(configSrc).then((s) => s.isDirectory()).catch(() => false)) {
      const target = configDirPath();
      await mkdir(target, { recursive: true });
      await cp(configSrc, target, { recursive: true, force: true });
      const copied: string[] = [];
      await listFilesRec(configSrc, "", copied);
      for (const rel of copied) restored.push(join(target, rel));
    }

    const skippedSubs =
      manifest?.files.filter((f) => f.startsWith("subs/")).length ??
      (await (async () => {
        const out: string[] = [];
        await listFilesRec(join(staging, "subs"), "", out);
        return out.length;
      })());

    return { manifest, restored, skippedSubs };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export interface BackupInfo {
  path: string;
  name: string;
  size: number;
  mtimeMs: number;
}

/** List backup archives in dir (default location), newest first. */
export async function listBackups(dir?: string): Promise<BackupInfo[]> {
  const d = dir ?? defaultBackupDir();
  let names: string[];
  try {
    names = await readdir(d);
  } catch {
    return [];
  }
  const out: BackupInfo[] = [];
  for (const name of names.filter((n) => /^backup-.*\.tar\.gz$/.test(n)).sort().reverse()) {
    const st = await stat(join(d, name)).catch(() => null);
    if (st) out.push({ path: join(d, name), name, size: st.size, mtimeMs: st.mtimeMs });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Auto-backup snapshots (F9)
//
// A "snapshot" is a portable JSON export bundle (datatransfer.ts) written to a
// dedicated snapshots dir with a timestamped name. The server takes one on
// startup (throttled), keeps the newest KEEP_SNAPSHOTS, and lets the user roll
// back via the existing importBundle path. Distinct from the tar `backups/`
// dir above (which also captures subs/). Snapshots are lightweight + restorable.
// ---------------------------------------------------------------------------

export const KEEP_SNAPSHOTS = 3;
/** Skip taking a startup snapshot if the most recent one is younger than this. */
export const SNAPSHOT_THROTTLE_MS = 6 * 60 * 60 * 1000; // 6h

/** Snapshot filename matcher: zr-snapshot-<ISO with :.→->.json */
const SNAPSHOT_RE = /^zr-snapshot-.*\.json$/;

export function defaultSnapshotDir(): string {
  return join(homedir(), ".local", "share", "zehntage-reactor", "snapshots");
}

/** Build the timestamped snapshot filename for a given moment. */
export function snapshotFileName(now: Date = new Date()): string {
  return `zr-snapshot-${now.toISOString().replace(/[:.]/g, "-")}.json`;
}

export interface SnapshotInfo {
  path: string;
  name: string;
  size: number;
  mtimeMs: number;
}

/**
 * Pure rotation logic: given a list of snapshot entries (name + mtimeMs), return
 * the names that should be DELETED to keep only the newest `keep`. Newest =
 * largest mtimeMs; ties broken by name (so the result is deterministic). Does no
 * I/O — unit-testable. When there are <= keep entries, returns [].
 */
export function snapshotsToDelete(
  entries: { name: string; mtimeMs: number }[],
  keep = KEEP_SNAPSHOTS,
): string[] {
  if (keep < 0) keep = 0;
  // Sort newest-first (desc mtime, then desc name as a stable tiebreak).
  const sorted = [...entries].sort(
    (a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0),
  );
  return sorted.slice(keep).map((e) => e.name);
}

/**
 * Pure throttle logic: should we take a new snapshot now, given the most recent
 * existing snapshot's mtime (or null if none)? Skips when the latest snapshot is
 * younger than `throttleMs`. No I/O — unit-testable.
 */
export function shouldSnapshot(
  latestMtimeMs: number | null,
  now: number = Date.now(),
  throttleMs = SNAPSHOT_THROTTLE_MS,
): boolean {
  if (latestMtimeMs == null) return true;
  return now - latestMtimeMs >= throttleMs;
}

/** List snapshot bundles in dir (default location), newest first. */
export async function listSnapshots(dir?: string): Promise<SnapshotInfo[]> {
  const d = dir ?? defaultSnapshotDir();
  let names: string[];
  try {
    names = await readdir(d);
  } catch {
    return [];
  }
  const out: SnapshotInfo[] = [];
  for (const name of names.filter((n) => SNAPSHOT_RE.test(n))) {
    const st = await stat(join(d, name)).catch(() => null);
    if (st) out.push({ path: join(d, name), name, size: st.size, mtimeMs: st.mtimeMs });
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  return out;
}

/** Delete all but the newest `keep` snapshots in dir. Returns deleted paths. */
export async function rotateSnapshots(dir?: string, keep = KEEP_SNAPSHOTS): Promise<string[]> {
  const d = dir ?? defaultSnapshotDir();
  const infos = await listSnapshots(d);
  return rmEach(d, snapshotsToDelete(infos, keep));
}

export interface SnapshotResult {
  path: string;
  name: string;
  bundle: ExportBundle;
}

/** Write the current export bundle as a timestamped snapshot, then rotate. */
export async function createSnapshot(
  dir?: string,
  keep = KEEP_SNAPSHOTS,
): Promise<SnapshotResult> {
  const d = dir ?? defaultSnapshotDir();
  await mkdir(d, { recursive: true });
  const bundle = await buildExportBundle();
  const name = snapshotFileName(new Date(bundle.exportedAt));
  const path = join(d, name);
  await Bun.write(path, JSON.stringify(bundle, null, 2));
  await rotateSnapshots(d, keep);
  return { path, name, bundle };
}

/**
 * Take a startup snapshot only if the newest existing one is older than the
 * throttle window. Returns the result, or null when skipped.
 */
export async function maybeSnapshotOnStartup(
  dir?: string,
  keep = KEEP_SNAPSHOTS,
  throttleMs = SNAPSHOT_THROTTLE_MS,
): Promise<SnapshotResult | null> {
  const d = dir ?? defaultSnapshotDir();
  const existing = await listSnapshots(d);
  const latest = existing.length > 0 ? existing[0]!.mtimeMs : null;
  if (!shouldSnapshot(latest, Date.now(), throttleMs)) return null;
  return createSnapshot(d, keep);
}

/** Resolve a snapshot name to its absolute path, guarding against traversal. */
export function snapshotPath(name: string, dir?: string): string {
  const d = dir ?? defaultSnapshotDir();
  if (!SNAPSHOT_RE.test(name) || name.includes("/") || name.includes("\\")) {
    throw new Error(`Invalid snapshot name: ${name}`);
  }
  return join(d, name);
}

/** Read + parse a snapshot bundle by name (for restore via importBundle). */
export async function readSnapshot(name: string, dir?: string): Promise<unknown> {
  const path = snapshotPath(name, dir);
  if (!(await Bun.file(path).exists())) {
    throw new Error(`No such snapshot: ${name}`);
  }
  return Bun.file(path).json();
}
