import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  snapshotsToDelete,
  shouldSnapshot,
  snapshotFileName,
  snapshotPath,
  listSnapshots,
  rotateSnapshots,
  createSnapshot,
  readSnapshot,
  KEEP_SNAPSHOTS,
  SNAPSHOT_THROTTLE_MS,
} from "../src/lib/backup.ts";

// ── pure rotation logic ─────────────────────────────────────────────
describe("snapshotsToDelete", () => {
  const mk = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      name: `zr-snapshot-${i}.json`,
      mtimeMs: i, // higher = newer
    }));

  test("fewer than keep → delete nothing", () => {
    expect(snapshotsToDelete(mk(3), 10)).toEqual([]);
    expect(snapshotsToDelete([], 10)).toEqual([]);
  });

  test("exactly keep → delete nothing", () => {
    expect(snapshotsToDelete(mk(10), 10)).toEqual([]);
  });

  test("more than keep → delete the oldest", () => {
    const doomed = snapshotsToDelete(mk(13), 10);
    // oldest three: mtime 0,1,2
    expect(doomed.sort()).toEqual(
      ["zr-snapshot-0.json", "zr-snapshot-1.json", "zr-snapshot-2.json"].sort(),
    );
  });

  test("keeps the newest N regardless of input order", () => {
    const shuffled = [...mk(12)].reverse();
    const doomed = snapshotsToDelete(shuffled, 10);
    expect(doomed.length).toBe(2);
    expect(doomed).toContain("zr-snapshot-0.json");
    expect(doomed).toContain("zr-snapshot-1.json");
  });

  test("ties on mtime broken deterministically by name", () => {
    const entries = [
      { name: "zr-snapshot-a.json", mtimeMs: 5 },
      { name: "zr-snapshot-b.json", mtimeMs: 5 },
      { name: "zr-snapshot-c.json", mtimeMs: 5 },
    ];
    // keep 2 newest: by name desc tiebreak, c & b kept, a deleted
    expect(snapshotsToDelete(entries, 2)).toEqual(["zr-snapshot-a.json"]);
  });

  test("keep 0 deletes everything", () => {
    expect(snapshotsToDelete(mk(3), 0).length).toBe(3);
  });

  test("negative keep treated as 0", () => {
    expect(snapshotsToDelete(mk(2), -5).length).toBe(2);
  });
});

// ── pure throttle logic ─────────────────────────────────────────────
describe("shouldSnapshot", () => {
  test("no prior snapshot → take one", () => {
    expect(shouldSnapshot(null)).toBe(true);
  });

  test("recent snapshot → skip", () => {
    const now = 1_000_000_000;
    expect(shouldSnapshot(now - 1000, now, SNAPSHOT_THROTTLE_MS)).toBe(false);
  });

  test("old snapshot (past throttle) → take one", () => {
    const now = 1_000_000_000;
    expect(shouldSnapshot(now - SNAPSHOT_THROTTLE_MS - 1, now)).toBe(true);
  });

  test("exactly at the throttle boundary → take one", () => {
    const now = 1_000_000_000;
    expect(shouldSnapshot(now - SNAPSHOT_THROTTLE_MS, now)).toBe(true);
  });
});

// ── filename + path guards ──────────────────────────────────────────
describe("snapshotFileName / snapshotPath", () => {
  test("filename is ISO with colons/dots replaced, matches the pattern", () => {
    const name = snapshotFileName(new Date("2026-06-14T12:34:56.789Z"));
    expect(name).toBe("zr-snapshot-2026-06-14T12-34-56-789Z.json");
  });

  test("snapshotPath accepts a valid generated name", () => {
    const name = snapshotFileName(new Date());
    expect(() => snapshotPath(name, "/tmp/x")).not.toThrow();
  });

  test("snapshotPath rejects traversal / bad names", () => {
    expect(() => snapshotPath("../etc/passwd", "/tmp/x")).toThrow();
    expect(() => snapshotPath("zr-snapshot-x/../y.json", "/tmp/x")).toThrow();
    expect(() => snapshotPath("not-a-snapshot.json", "/tmp/x")).toThrow();
    expect(() => snapshotPath("zr-snapshot-x.txt", "/tmp/x")).toThrow();
  });
});

// ── fs-backed round-trip (uses an isolated tmp dir + config override) ─
describe("snapshot bundle shape + rotation (tmp fs)", () => {
  test("createSnapshot writes a valid bundle and rotates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zr-snap-test-"));
    const cfg = await mkdtemp(join(tmpdir(), "zr-snap-cfg-"));
    const prevCfg = process.env.ZR_CONFIG_DIR;
    process.env.ZR_CONFIG_DIR = cfg;
    try {
      await writeFile(
        join(cfg, "settings.json"),
        JSON.stringify({ mediaRoot: "" }),
      );

      const res = await createSnapshot(dir, 3);
      expect(res.name).toMatch(/^zr-snapshot-.*\.json$/);
      // bundle shape from buildExportBundle
      expect(typeof res.bundle.version).toBe("number");
      expect(typeof res.bundle.exportedAt).toBe("string");
      expect(typeof res.bundle.settings).toBe("object");
      expect(typeof res.bundle.state).toBe("object");
      expect(Array.isArray(res.bundle.events)).toBe(true);

      // file is on disk and re-readable through readSnapshot
      const round = (await readSnapshot(res.name, dir)) as { version: number };
      expect(round.version).toBe(res.bundle.version);

      const listed = await listSnapshots(dir);
      expect(listed.some((s) => s.name === res.name)).toBe(true);
    } finally {
      if (prevCfg === undefined) delete process.env.ZR_CONFIG_DIR;
      else process.env.ZR_CONFIG_DIR = prevCfg;
      await rm(dir, { recursive: true, force: true });
      await rm(cfg, { recursive: true, force: true });
    }
  });

  test("rotateSnapshots keeps the newest N on disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zr-snap-rot-"));
    try {
      // write 5 fake snapshots with increasing mtimes
      for (let i = 0; i < 5; i++) {
        const p = join(dir, `zr-snapshot-2026-06-1${i}T00-00-00-000Z.json`);
        await writeFile(p, "{}");
        // bump mtime so ordering is unambiguous
        const t = new Date(2026, 5, 10 + i);
        await Bun.write(p, "{}");
        await (await import("node:fs/promises")).utimes(p, t, t);
      }
      const deleted = await rotateSnapshots(dir, 2);
      expect(deleted.length).toBe(3);
      const remaining = (await readdir(dir)).sort();
      expect(remaining.length).toBe(2);
      // newest two (i=3, i=4) survive
      expect(remaining).toContain("zr-snapshot-2026-06-13T00-00-00-000Z.json");
      expect(remaining).toContain("zr-snapshot-2026-06-14T00-00-00-000Z.json");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("listSnapshots returns [] for a missing dir", async () => {
    expect(await listSnapshots(join(tmpdir(), "zr-does-not-exist-xyz"))).toEqual(
      [],
    );
  });

  test("KEEP_SNAPSHOTS default is 3", () => {
    expect(KEEP_SNAPSHOTS).toBe(3);
  });
});
