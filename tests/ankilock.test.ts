import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  backupCollection,
  canWrite,
  collectionLocked,
  listBackupDirs,
  pruneBackups,
  schemaSupported,
  timestampUtc,
} from "../src/lib/ankilock.ts";

let base: string;
let col: string; // fake collection.anki2

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "zr-ankilock-"));
  col = join(base, "collection.anki2");
  // A minimal fake "collection" — just bytes; these tests never need a real DB.
  await writeFile(col, "FAKE-SQLITE-BYTES");
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("schemaSupported", () => {
  test("ver 18 supported, ver 17 not", () => {
    expect(schemaSupported(18)).toBe(true);
    expect(schemaSupported(17)).toBe(false);
    expect(schemaSupported(11)).toBe(false);
  });
});

describe("collectionLocked", () => {
  test("false when no sidecar files exist", () => {
    expect(collectionLocked(col)).toBe(false);
  });

  test("detects a non-empty -wal", async () => {
    await writeFile(`${col}-wal`, "uncheckpointed");
    expect(collectionLocked(col)).toBe(true);
  });

  test("ignores an empty -wal", async () => {
    await writeFile(`${col}-wal`, "");
    expect(collectionLocked(col)).toBe(false);
  });

  test("detects a hot -journal", async () => {
    await writeFile(`${col}-journal`, "rollback");
    expect(collectionLocked(col)).toBe(true);
  });
});

describe("backupCollection", () => {
  test("copies the collection and returns an existing path", async () => {
    const root = join(base, "backups");
    const res = await backupCollection(col, timestampUtc(), root);
    expect(existsSync(res.collection)).toBe(true);
    expect(res.files.length).toBe(1);
    expect(await Bun.file(res.collection).text()).toBe("FAKE-SQLITE-BYTES");
  });

  test("also copies -wal and -shm when present", async () => {
    await writeFile(`${col}-wal`, "wal-bytes");
    await writeFile(`${col}-shm`, "shm-bytes");
    const root = join(base, "backups");
    const res = await backupCollection(col, "20260614T000000Z", root);
    expect(res.files.length).toBe(3);
    expect(existsSync(join(res.dir, "collection.anki2-wal"))).toBe(true);
    expect(existsSync(join(res.dir, "collection.anki2-shm"))).toBe(true);
  });

  test("throws when the source is missing", async () => {
    await expect(backupCollection(join(base, "nope.anki2"))).rejects.toThrow();
  });
});

describe("pruneBackups", () => {
  test("keeps the most recent N dirs", async () => {
    const root = join(base, "backups");
    for (const ts of ["20260101T000000Z", "20260102T000000Z", "20260103T000000Z"]) {
      await mkdir(join(root, ts), { recursive: true });
    }
    const removed = pruneBackups(2, root);
    expect(removed.length).toBe(1);
    expect(removed[0]).toContain("20260101T000000Z");
    const left = listBackupDirs(root).map((p) => p.split("/").pop());
    expect(left).toEqual(["20260102T000000Z", "20260103T000000Z"]);
  });

  test("never prunes below one, and no-ops on missing root", () => {
    expect(pruneBackups(0, join(base, "absent"))).toEqual([]);
  });
});

describe("canWrite", () => {
  test("missing file => ok:false reason:missing", () => {
    expect(canWrite(join(base, "absent.anki2"))).toEqual({ ok: false, reason: "missing" });
  });

  test("ok:false reason:anki-open when ankiRunning stubbed true", () => {
    const res = canWrite(col, {
      exists: () => true,
      ankiRunning: () => true,
      collectionLocked: () => false,
      readSchemaVer: () => 18,
    });
    expect(res).toEqual({ ok: false, reason: "anki-open" });
  });

  test("ok:false reason:locked when sidecar lock present", () => {
    const res = canWrite(col, {
      exists: () => true,
      ankiRunning: () => false,
      collectionLocked: () => true,
      readSchemaVer: () => 18,
    });
    expect(res).toEqual({ ok: false, reason: "locked" });
  });

  test("ok:false reason:schema when ver unsupported or unreadable", () => {
    const deps = {
      exists: () => true,
      ankiRunning: () => false,
      collectionLocked: () => false,
    };
    expect(canWrite(col, { ...deps, readSchemaVer: () => 17 })).toEqual({
      ok: false,
      reason: "schema",
    });
    expect(canWrite(col, { ...deps, readSchemaVer: () => null })).toEqual({
      ok: false,
      reason: "schema",
    });
  });

  test("ok:true when all gates pass", () => {
    const res = canWrite(col, {
      exists: () => true,
      ankiRunning: () => false,
      collectionLocked: () => false,
      readSchemaVer: () => 18,
    });
    expect(res).toEqual({ ok: true });
  });
});
