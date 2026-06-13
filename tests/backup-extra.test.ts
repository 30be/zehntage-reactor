/**
 * Supplemental backup tests covering gaps:
 *   - Path-traversal guard: reject entries with ".." or absolute paths
 *   - createBackup when events file doesn't exist
 *   - createBackup when config dir doesn't exist
 *   - rotateBackups: empty dir, dir doesn't exist, non-matching files ignored
 *   - listBackups: empty/missing dir
 *   - findSubsDirs: case-insensitive "Subs", node_modules skipped
 *   - configDirPath uses ZR_CONFIG_DIR
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createBackup,
  restoreBackup,
  rotateBackups,
  listBackups,
  findSubsDirs,
  configDirPath,
} from "../src/lib/backup.ts";

let base: string;
let configDir: string;
let eventsFile: string;
let library: string;
let dest: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "zr-backup-extra-"));
  configDir = join(base, "config");
  eventsFile = join(base, "events.jsonl");
  library = join(base, "library");
  dest = join(base, "backups");
  savedEnv["ZR_CONFIG_DIR"] = process.env.ZR_CONFIG_DIR;
  savedEnv["ZR_EVENTS_FILE"] = process.env.ZR_EVENTS_FILE;
  process.env.ZR_CONFIG_DIR = configDir;
  process.env.ZR_EVENTS_FILE = eventsFile;
  await mkdir(configDir, { recursive: true });
});

afterEach(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(base, { recursive: true, force: true });
});

// ─── path-traversal guard ────────────────────────────────────────────────────

describe("restoreBackup path-traversal guard", () => {
  /**
   * Helper: create a real tar.gz with a crafted entry name.
   * We use a two-step approach: write a safe file and then craft the tar
   * using Bun.spawn with a rename via --transform (GNU tar only) or just
   * build the tarball programmatically.
   *
   * Since the guard works by listing entries with `tar -tzf`, we craft a
   * tarball that has an entry whose name starts with "/" or contains "..".
   *
   * GNU tar rejects creating such entries, so we build it with Node's
   * built-in Buffer packing. However to keep this simple we use a known
   * trick: create a symlink-based archive isn't portable. Instead we use
   * `tar` with `--absolute-names` which GNU tar allows for listing.
   *
   * Simplest portable approach: use Python to build the tarball (always
   * available on the test machine). If not available, skip.
   */
  async function makeMaliciousTar(entryName: string, destFile: string): Promise<boolean> {
    // Write a harmless file
    const src = join(base, "harmless.txt");
    await writeFile(src, "harmless content");

    // Use Python to build a tar with the crafted entry name
    const proc = Bun.spawn(
      [
        "python3",
        "-c",
        `
import tarfile, sys
with tarfile.open(sys.argv[1], 'w:gz') as t:
    info = tarfile.TarInfo(name=sys.argv[2])
    info.size = 7
    import io
    t.addfile(info, io.BytesIO(b'content'))
`,
        destFile,
        entryName,
      ],
      { stdout: "ignore", stderr: "pipe" },
    );
    const code = await proc.exited;
    return code === 0;
  }

  test("rejects archive with absolute path entry", async () => {
    const tarPath = join(dest, "evil-absolute.tar.gz");
    await mkdir(dest, { recursive: true });
    const ok = await makeMaliciousTar("/etc/passwd", tarPath);
    if (!ok) {
      console.log("skipping: python3 not available");
      return;
    }
    await expect(restoreBackup(tarPath)).rejects.toThrow(/unsafe path/);
  });

  test("rejects archive with .. segment in entry path", async () => {
    const tarPath = join(dest, "evil-dotdot.tar.gz");
    await mkdir(dest, { recursive: true });
    const ok = await makeMaliciousTar("../../../etc/cron.d/malicious", tarPath);
    if (!ok) {
      console.log("skipping: python3 not available");
      return;
    }
    await expect(restoreBackup(tarPath)).rejects.toThrow(/unsafe path/);
  });

  test("accepts archive with safe paths (no rejection)", async () => {
    // Create a legitimate backup first
    await Bun.write(eventsFile, '{"ts":1,"type":"heartbeat"}\n');
    const { path } = await createBackup(dest);
    // Should not throw
    const res = await restoreBackup(path);
    expect(res.manifest).not.toBeNull();
  });
});

// ─── createBackup edge cases ─────────────────────────────────────────────────

describe("createBackup edge cases", () => {
  test("succeeds when events file doesn't exist (no events.jsonl in archive)", async () => {
    // eventsFile doesn't exist
    const { manifest } = await createBackup(dest);
    expect(manifest.files).not.toContain("events.jsonl");
    // config dir is empty (just the dir itself) but we created it
    // so config/ entries may still be there from configDir setup
  });

  test("succeeds when config dir doesn't exist", async () => {
    await rm(configDir, { recursive: true, force: true });
    await Bun.write(eventsFile, '{"ts":1,"type":"heartbeat"}\n');
    const { manifest } = await createBackup(dest);
    expect(manifest.files).toContain("events.jsonl");
    // no config/ entries
    expect(manifest.files.filter((f) => f.startsWith("config/"))).toHaveLength(0);
  });

  test("no libraryRoot → no subs in manifest", async () => {
    await Bun.write(eventsFile, '{"ts":1,"type":"heartbeat"}\n');
    const { manifest } = await createBackup(dest, { libraryRoot: undefined });
    const subEntries = manifest.files.filter((f) => f.startsWith("subs/"));
    expect(subEntries).toHaveLength(0);
  });

  test("multiple files in config dir are all archived", async () => {
    await Bun.write(join(configDir, "settings.json"), JSON.stringify({ targetLang: "ja" }));
    await Bun.write(join(configDir, "state.json"), JSON.stringify({}));
    await Bun.write(eventsFile, '{"ts":1,"type":"heartbeat"}\n');
    const { manifest } = await createBackup(dest);
    expect(manifest.files).toContain("config/settings.json");
    expect(manifest.files).toContain("config/state.json");
  });
});

// ─── rotateBackups edge cases ─────────────────────────────────────────────────

describe("rotateBackups edge cases", () => {
  test("returns [] when dir doesn't exist", async () => {
    const deleted = await rotateBackups(join(base, "nonexistent"), 5);
    expect(deleted).toEqual([]);
  });

  test("returns [] when dir is empty", async () => {
    await mkdir(dest, { recursive: true });
    const deleted = await rotateBackups(dest, 5);
    expect(deleted).toEqual([]);
  });

  test("ignores non-backup files", async () => {
    await mkdir(dest, { recursive: true });
    await Bun.write(join(dest, "readme.txt"), "hello");
    await Bun.write(join(dest, "backup-2026-01-01.tar.gz"), "x");
    const deleted = await rotateBackups(dest, 1);
    expect(deleted).toHaveLength(0); // only 1 backup, keep=1 → nothing deleted
    // readme.txt must be untouched
    expect(await Bun.file(join(dest, "readme.txt")).exists()).toBe(true);
  });

  test("deletes oldest when count > keep", async () => {
    await mkdir(dest, { recursive: true });
    for (let i = 1; i <= 5; i++) {
      await Bun.write(
        join(dest, `backup-2026-01-0${i}.tar.gz`),
        "x",
      );
    }
    const deleted = await rotateBackups(dest, 3);
    expect(deleted).toHaveLength(2);
    // oldest two should be deleted
    expect(await Bun.file(join(dest, "backup-2026-01-01.tar.gz")).exists()).toBe(false);
    expect(await Bun.file(join(dest, "backup-2026-01-02.tar.gz")).exists()).toBe(false);
    // newest three survive
    expect(await Bun.file(join(dest, "backup-2026-01-05.tar.gz")).exists()).toBe(true);
  });

  test("keep=0 deletes everything", async () => {
    await mkdir(dest, { recursive: true });
    await Bun.write(join(dest, "backup-2026-01-01.tar.gz"), "x");
    await Bun.write(join(dest, "backup-2026-01-02.tar.gz"), "x");
    const deleted = await rotateBackups(dest, 0);
    expect(deleted).toHaveLength(2);
  });
});

// ─── listBackups edge cases ───────────────────────────────────────────────────

describe("listBackups edge cases", () => {
  test("returns [] when dir doesn't exist", async () => {
    const list = await listBackups(join(base, "nonexistent"));
    expect(list).toEqual([]);
  });

  test("returns [] when dir is empty", async () => {
    await mkdir(dest, { recursive: true });
    const list = await listBackups(dest);
    expect(list).toEqual([]);
  });

  test("non-backup files not listed", async () => {
    await mkdir(dest, { recursive: true });
    await Bun.write(join(dest, "notes.txt"), "ignored");
    await Bun.write(join(dest, "backup-2026-01-01.tar.gz"), "x");
    const list = await listBackups(dest);
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe("backup-2026-01-01.tar.gz");
  });

  test("newest first ordering", async () => {
    await mkdir(dest, { recursive: true });
    await Bun.write(join(dest, "backup-2026-01-01.tar.gz"), "x");
    await Bun.write(join(dest, "backup-2026-01-03.tar.gz"), "x");
    await Bun.write(join(dest, "backup-2026-01-02.tar.gz"), "x");
    const list = await listBackups(dest);
    expect(list[0]!.name).toBe("backup-2026-01-03.tar.gz");
    expect(list[2]!.name).toBe("backup-2026-01-01.tar.gz");
  });
});

// ─── findSubsDirs edge cases ──────────────────────────────────────────────────

describe("findSubsDirs extra", () => {
  test("case-insensitive: 'Subs' (capital S) is found", async () => {
    await mkdir(join(library, "Show", "Subs"), { recursive: true });
    const dirs = await findSubsDirs(library);
    expect(dirs).toContain(join(library, "Show", "Subs"));
  });

  test("case-insensitive: 'SUBS' (all caps) is found", async () => {
    await mkdir(join(library, "Show", "SUBS"), { recursive: true });
    const dirs = await findSubsDirs(library);
    expect(dirs).toContain(join(library, "Show", "SUBS"));
  });

  test("node_modules directory is skipped", async () => {
    await mkdir(join(library, "node_modules", "subs"), { recursive: true });
    const dirs = await findSubsDirs(library);
    expect(dirs).not.toContain(join(library, "node_modules", "subs"));
  });

  test("hidden directories (dot-prefix) are skipped", async () => {
    await mkdir(join(library, ".hidden", "subs"), { recursive: true });
    const dirs = await findSubsDirs(library);
    expect(dirs).not.toContain(join(library, ".hidden", "subs"));
  });

  test("non-subs dirs are not returned", async () => {
    await mkdir(join(library, "subtitles"), { recursive: true }); // not "subs"
    await mkdir(join(library, "Show", "subs"), { recursive: true }); // is "subs"
    const dirs = await findSubsDirs(library);
    expect(dirs).toHaveLength(1);
    expect(dirs[0]).toContain("subs");
    expect(dirs).not.toContain(join(library, "subtitles"));
  });

  test("returns [] for nonexistent root", async () => {
    const dirs = await findSubsDirs(join(base, "nope"));
    expect(dirs).toEqual([]);
  });

  test("nested subs dirs are all found", async () => {
    await mkdir(join(library, "Show1", "subs"), { recursive: true });
    await mkdir(join(library, "Show2", "subs"), { recursive: true });
    await mkdir(join(library, "Deep", "Season1", "subs"), { recursive: true });
    const dirs = await findSubsDirs(library);
    expect(dirs).toHaveLength(3);
  });
});

// ─── configDirPath ────────────────────────────────────────────────────────────

describe("configDirPath", () => {
  test("returns ZR_CONFIG_DIR when set", () => {
    expect(configDirPath()).toBe(configDir);
  });

  test("falls back to homedir path when env not set", () => {
    const saved = process.env.ZR_CONFIG_DIR;
    delete process.env.ZR_CONFIG_DIR;
    const p = configDirPath();
    expect(p).toMatch(/zehntage-reactor/);
    expect(p).toMatch(/\.config/);
    process.env.ZR_CONFIG_DIR = saved;
  });
});
