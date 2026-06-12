import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, readdir } from "node:fs/promises";
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
  base = await mkdtemp(join(tmpdir(), "zr-backup-test-"));
  configDir = join(base, "config");
  eventsFile = join(base, "events.jsonl");
  library = join(base, "library");
  dest = join(base, "backups");
  savedEnv["ZR_CONFIG_DIR"] = process.env.ZR_CONFIG_DIR;
  savedEnv["ZR_EVENTS_FILE"] = process.env.ZR_EVENTS_FILE;
  process.env.ZR_CONFIG_DIR = configDir;
  process.env.ZR_EVENTS_FILE = eventsFile;

  await mkdir(configDir, { recursive: true });
  await Bun.write(join(configDir, "settings.json"), JSON.stringify({ targetLang: "ja" }));
  await Bun.write(eventsFile, '{"ts":1,"type":"heartbeat"}\n');
  await mkdir(join(library, "Hyouka", "subs"), { recursive: true });
  await Bun.write(join(library, "Hyouka", "subs", "ep01.ja.srt"), "1\nsub content\n");
});

afterEach(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(base, { recursive: true, force: true });
});

describe("createBackup / restoreBackup roundtrip", () => {
  test("archives events, config, subs and restores events+config only", async () => {
    const { path, manifest } = await createBackup(dest, { libraryRoot: library });
    expect(await Bun.file(path).exists()).toBe(true);
    expect(manifest.files).toContain("events.jsonl");
    expect(manifest.files).toContain("config/settings.json");
    expect(manifest.files).toContain("subs/Hyouka/subs/ep01.ja.srt");
    expect(manifest.version).not.toBe("");

    // mutate state, then restore
    await Bun.write(eventsFile, "corrupted\n");
    await Bun.write(join(configDir, "settings.json"), "{}");
    await rm(join(library, "Hyouka", "subs", "ep01.ja.srt"));

    const res = await restoreBackup(path);
    expect(res.manifest?.files).toEqual(manifest.files);
    expect(await Bun.file(eventsFile).text()).toBe('{"ts":1,"type":"heartbeat"}\n');
    const settings = await Bun.file(join(configDir, "settings.json")).json();
    expect(settings.targetLang).toBe("ja");
    // subs intentionally NOT restored
    expect(await Bun.file(join(library, "Hyouka", "subs", "ep01.ja.srt")).exists()).toBe(false);
    expect(res.skippedSubs).toBe(1);
    expect(res.restored).toContain(eventsFile);
  });

  test("library root falls back to settings.mediaRoot", async () => {
    await Bun.write(
      join(configDir, "settings.json"),
      JSON.stringify({ mediaRoot: library }),
    );
    const { manifest } = await createBackup(dest);
    expect(manifest.files).toContain("subs/Hyouka/subs/ep01.ja.srt");
  });

  test("restore of a nonexistent archive throws", async () => {
    expect(restoreBackup(join(base, "nope.tar.gz"))).rejects.toThrow("No such backup");
  });
});

describe("rotation and listing", () => {
  test("rotateBackups keeps the newest N", async () => {
    await mkdir(dest, { recursive: true });
    for (let i = 0; i < 13; i++) {
      await Bun.write(join(dest, `backup-2026-01-${String(i + 1).padStart(2, "0")}.tar.gz`), "x");
    }
    const deleted = await rotateBackups(dest, 10);
    expect(deleted).toHaveLength(3);
    const left = (await readdir(dest)).sort();
    expect(left).toHaveLength(10);
    expect(left[0]).toBe("backup-2026-01-04.tar.gz");
  });

  test("createBackup rotates", async () => {
    for (let i = 0; i < 4; i++) {
      await createBackup(dest, { libraryRoot: library, keep: 3 });
      await new Promise((r) => setTimeout(r, 5)); // distinct timestamps
    }
    const names = (await readdir(dest)).filter((n) => n.endsWith(".tar.gz"));
    expect(names.length).toBeLessThanOrEqual(3);
  });

  test("listBackups returns newest first with sizes", async () => {
    await createBackup(dest, { libraryRoot: library });
    const list = await listBackups(dest);
    expect(list).toHaveLength(1);
    expect(list[0]!.size).toBeGreaterThan(0);
    expect(list[0]!.name).toMatch(/^backup-.*\.tar\.gz$/);
  });
});

describe("helpers", () => {
  test("configDirPath honors ZR_CONFIG_DIR", () => {
    expect(configDirPath()).toBe(configDir);
  });

  test("findSubsDirs finds nested subs dirs, skips hidden", async () => {
    await mkdir(join(library, ".hidden", "subs"), { recursive: true });
    const dirs = await findSubsDirs(library);
    expect(dirs).toEqual([join(library, "Hyouka", "subs")]);
  });
});
