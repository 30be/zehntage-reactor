import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildExportBundle,
  exportFileName,
  validateBundle,
  importBundle,
  BUNDLE_VERSION,
} from "../src/lib/datatransfer.ts";
import { readSettings } from "../src/lib/settings.ts";
import { readState } from "../src/lib/state.ts";
import { readEvents } from "../src/lib/telemetry.ts";

let base: string;
let configDir: string;
let eventsFile: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "zr-datatransfer-test-"));
  configDir = join(base, "config");
  eventsFile = join(base, "events.jsonl");
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

describe("buildExportBundle", () => {
  test("assembles settings, state and events", async () => {
    await Bun.write(
      join(configDir, "settings.json"),
      JSON.stringify({ targetLang: "ja", knownLang: "de" }),
    );
    await Bun.write(
      join(configDir, "state.json"),
      JSON.stringify({ "zr.known": { v: "[\"a\"]", ts: 1000 } }),
    );
    await Bun.write(eventsFile, '{"ts":1,"type":"heartbeat"}\n{"ts":2,"type":"lookup"}\n');

    const b = await buildExportBundle(new Date("2026-06-13T10:00:00Z"));
    expect(b.version).toBe(BUNDLE_VERSION);
    expect(b.exportedAt).toBe("2026-06-13T10:00:00.000Z");
    expect(b.settings.targetLang).toBe("ja");
    expect(b.settings.knownLang).toBe("de");
    expect(b.state["zr.known"]).toEqual({ v: '["a"]', ts: 1000 });
    expect(b.events.length).toBe(2);
    expect(b.eventsTruncated).toBe(false);
  });

  test("returns defaults / empties when nothing on disk", async () => {
    const b = await buildExportBundle();
    // readSettings folds in DEFAULTS, so settings is never empty.
    expect(b.settings.targetLang).toBe("ja");
    expect(b.state).toEqual({});
    expect(b.events).toEqual([]);
  });

  test("exportFileName uses the date", () => {
    expect(exportFileName(new Date("2026-06-13T10:00:00Z"))).toBe(
      "zehntage-export-2026-06-13.json",
    );
  });
});

describe("validateBundle", () => {
  test("rejects non-objects", () => {
    expect(() => validateBundle(null)).toThrow();
    expect(() => validateBundle([])).toThrow();
    expect(() => validateBundle("x")).toThrow();
  });
  test("rejects missing version", () => {
    expect(() => validateBundle({ settings: {} })).toThrow(/version/);
  });
  test("rejects newer version", () => {
    expect(() => validateBundle({ version: BUNDLE_VERSION + 1 })).toThrow(
      /Unsupported/,
    );
  });
  test("rejects wrong-typed fields", () => {
    expect(() => validateBundle({ version: 1, settings: [] })).toThrow(/settings/);
    expect(() => validateBundle({ version: 1, state: 5 })).toThrow(/state/);
    expect(() => validateBundle({ version: 1, events: {} })).toThrow(/events/);
  });
  test("fills defaults for absent fields", () => {
    const b = validateBundle({ version: 1 });
    expect(b.settings).toEqual({});
    expect(b.state).toEqual({});
    expect(b.events).toEqual([]);
  });
});

describe("importBundle", () => {
  test("merges settings and state, skips events by default", async () => {
    // Pre-existing state with an older ts that should lose to the incoming one.
    await Bun.write(
      join(configDir, "state.json"),
      JSON.stringify({ "zr.known": { v: "[\"old\"]", ts: 1 } }),
    );

    const res = await importBundle({
      version: 1,
      exportedAt: "2026-06-13T10:00:00.000Z",
      settings: { targetLang: "fr", knownLang: "en" },
      state: { "zr.known": { v: "[\"new\"]", ts: 999 } },
      events: [{ ts: 5, type: "lookup" }],
    });

    expect(res.settingsImported).toBe(true);
    expect(res.stateKeys).toBe(1);
    expect(res.eventsImported).toBe(0);

    const s = await readSettings();
    expect(s.targetLang).toBe("fr");
    const st = await readState();
    expect(st["zr.known"]).toEqual({ v: '["new"]', ts: 999 });
    // Events were skipped.
    expect(await readEvents()).toEqual([]);
  });

  test("LWW keeps newer existing state over older incoming", async () => {
    await Bun.write(
      join(configDir, "state.json"),
      JSON.stringify({ "zr.known": { v: "[\"keep\"]", ts: 500 } }),
    );
    await importBundle({
      version: 1,
      settings: {},
      state: { "zr.known": { v: "[\"stale\"]", ts: 100 } },
      events: [],
    });
    const st = await readState();
    expect(st["zr.known"]).toEqual({ v: '["keep"]', ts: 500 });
  });

  test("imports events when opted in", async () => {
    const res = await importBundle(
      {
        version: 1,
        settings: {},
        state: {},
        events: [
          { ts: 5, type: "lookup" },
          { ts: 6, type: "heartbeat" },
          { bad: true },
        ],
      },
      { importEvents: true },
    );
    expect(res.eventsImported).toBe(2); // malformed dropped
    const ev = await readEvents();
    expect(ev.map((e) => e.type).sort()).toEqual(["heartbeat", "lookup"]);
  });

  test("throws on malformed bundle", async () => {
    await expect(importBundle({ nope: true })).rejects.toThrow(/version/);
  });

  test("round-trips: export then import is stable", async () => {
    await Bun.write(
      join(configDir, "settings.json"),
      JSON.stringify({ targetLang: "ja" }),
    );
    await Bun.write(
      join(configDir, "state.json"),
      JSON.stringify({ "zr.resume.x": { v: "42", ts: 7 } }),
    );
    const bundle = await buildExportBundle();
    const res = await importBundle(bundle);
    expect(res.stateKeys).toBe(1);
    const st = await readState();
    expect(st["zr.resume.x"]).toEqual({ v: "42", ts: 7 });
  });
});
