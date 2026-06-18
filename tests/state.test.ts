import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  merge,
  sanitize,
  readState,
  mergeIntoFile,
  type ZrState,
} from "../src/lib/state.ts";

describe("merge (last-write-wins per key)", () => {
  test("newer incoming wins", () => {
    const base: ZrState = { "zr.a": { v: "old", ts: 100 } };
    const inc: ZrState = { "zr.a": { v: "new", ts: 200 } };
    expect(merge(base, inc)["zr.a"]!.v).toBe("new");
  });

  test("older incoming loses", () => {
    const base: ZrState = { "zr.a": { v: "keep", ts: 300 } };
    const inc: ZrState = { "zr.a": { v: "stale", ts: 200 } };
    expect(merge(base, inc)["zr.a"]!.v).toBe("keep");
  });

  test("tie keeps base (idempotent replay)", () => {
    const base: ZrState = { "zr.a": { v: "base", ts: 100 } };
    const inc: ZrState = { "zr.a": { v: "inc", ts: 100 } };
    expect(merge(base, inc)["zr.a"]!.v).toBe("base");
  });

  test("disjoint keys union; merge does not mutate inputs", () => {
    const base: ZrState = { "zr.a": { v: "1", ts: 1 } };
    const inc: ZrState = { "zr.b": { v: "2", ts: 2 } };
    const m = merge(base, inc);
    expect(Object.keys(m).sort()).toEqual(["zr.a", "zr.b"]);
    expect(base["zr.b"]).toBeUndefined();
  });
});

describe("merge — OR-Set keys (zr.known / zr.blacklist) union, not LWW", () => {
  const members = (v: string) => {
    const o = JSON.parse(v) as {
      adds: Record<string, number>;
      removes: Record<string, number>;
    };
    const out = new Set<string>();
    for (const [m, t] of Object.entries(o.adds)) {
      const rm = o.removes[m];
      if (rm === undefined || t > rm) out.add(m);
    }
    return out;
  };
  const set = (adds: Record<string, number>, removes: Record<string, number> = {}) =>
    JSON.stringify({ adds, removes });

  test("concurrent different members UNION even with older incoming ts", () => {
    const base: ZrState = { "zr.known": { v: set({ 猫: 100 }), ts: 100 } };
    const inc: ZrState = { "zr.known": { v: set({ 犬: 50 }), ts: 50 } };
    const m = merge(base, inc);
    expect(members(m["zr.known"]!.v)).toEqual(new Set(["猫", "犬"]));
    expect(m["zr.known"]!.ts).toBe(100); // ts -> max
  });

  test("legacy plain-array base migrates then merges (lossless)", () => {
    const base: ZrState = { "zr.blacklist": { v: '["a"]', ts: 100 } };
    const inc: ZrState = { "zr.blacklist": { v: set({ b: 200 }), ts: 200 } };
    expect(members(merge(base, inc)["zr.blacklist"]!.v)).toEqual(
      new Set(["a", "b"]),
    );
  });

  test("remove tombstone with newer ts wins over older add", () => {
    const base: ZrState = { "zr.known": { v: set({ a: 100 }), ts: 100 } };
    const inc: ZrState = { "zr.known": { v: set({}, { a: 200 }), ts: 200 } };
    expect(members(merge(base, inc)["zr.known"]!.v)).toEqual(new Set());
  });
});

describe("sanitize", () => {
  test("drops malformed entries, keeps valid ones", () => {
    const raw = {
      "zr.ok": { v: "x", ts: 5 },
      "zr.badV": { v: 7, ts: 5 },
      "zr.badTs": { v: "x", ts: "nope" },
      "zr.null": null,
    };
    expect(Object.keys(sanitize(raw))).toEqual(["zr.ok"]);
  });

  test("non-object input -> empty", () => {
    expect(sanitize("junk")).toEqual({});
    expect(sanitize(null)).toEqual({});
  });
});

describe("file round-trip (ZR_CONFIG_DIR)", () => {
  beforeEach(() => {
    process.env.ZR_CONFIG_DIR = mkdtempSync(join(tmpdir(), "zr-state-"));
  });

  test("readState on missing file -> {}", async () => {
    expect(await readState()).toEqual({});
  });

  test("mergeIntoFile persists and merges partial pushes", async () => {
    await mergeIntoFile({ "zr.a": { v: "1", ts: 10 } });
    const merged = await mergeIntoFile({
      "zr.a": { v: "stale", ts: 5 },
      "zr.b": { v: "2", ts: 20 },
    });
    expect(merged["zr.a"]!.v).toBe("1"); // older push lost
    expect(merged["zr.b"]!.v).toBe("2");
    const onDisk = await readState();
    expect(onDisk).toEqual(merged);
  });
});
