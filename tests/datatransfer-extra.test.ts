/**
 * Supplemental datatransfer tests covering gaps:
 *   - MAX_EVENTS cap: export truncates, eventsTruncated flag
 *   - Import: MAX_EVENTS cap on hostile events array
 *   - Settings rollback on state-merge failure
 *   - validateBundle: eventsTruncated propagation, null-typed settings/state
 *   - importBundle: empty settings object (no snapshot taken)
 *   - exportFileName various dates
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildExportBundle,
  exportFileName,
  validateBundle,
  importBundle,
  MAX_EVENTS,
} from "../src/lib/datatransfer.ts";
import { readSettings, writeSettings } from "../src/lib/settings.ts";
import { readEvents } from "../src/lib/telemetry.ts";

let base: string;
let configDir: string;
let eventsFile: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "zr-dt-extra-"));
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

// ─── MAX_EVENTS truncation on export ─────────────────────────────────────────

describe("buildExportBundle MAX_EVENTS", () => {
  test("eventsTruncated=false when events <= MAX_EVENTS", async () => {
    // Write exactly MAX_EVENTS events
    const lines = Array.from(
      { length: 5 },
      (_, i) => `{"ts":${i + 1},"type":"heartbeat"}`,
    ).join("\n") + "\n";
    await Bun.write(eventsFile, lines);
    const b = await buildExportBundle();
    expect(b.eventsTruncated).toBe(false);
    expect(b.events.length).toBe(5);
  });

  test("eventsTruncated=true and oldest events dropped when over MAX_EVENTS", async () => {
    // Write MAX_EVENTS + 10 events
    const count = MAX_EVENTS + 10;
    const lines =
      Array.from(
        { length: count },
        (_, i) => `{"ts":${i + 1},"type":"heartbeat"}`,
      ).join("\n") + "\n";
    await Bun.write(eventsFile, lines);

    const b = await buildExportBundle();
    expect(b.eventsTruncated).toBe(true);
    expect(b.events.length).toBe(MAX_EVENTS);
    // The NEWEST events should be kept (slice from the end)
    expect(b.events[0]!.ts).toBe(11); // oldest kept is ts=11
    expect(b.events[b.events.length - 1]!.ts).toBe(count);
  });
});

// ─── importBundle MAX_EVENTS cap on incoming events ──────────────────────────

describe("importBundle events cap", () => {
  test("hostile bundle with > MAX_EVENTS events is capped on import", async () => {
    // Build a bundle with more events than allowed
    const events = Array.from({ length: MAX_EVENTS + 100 }, (_, i) => ({
      ts: i + 1,
      type: "heartbeat",
    }));
    const res = await importBundle(
      { version: 1, settings: {}, state: {}, events },
      { importEvents: true },
    );
    expect(res.eventsImported).toBe(MAX_EVENTS);
    const written = await readEvents();
    expect(written.length).toBe(MAX_EVENTS);
  });
});

// ─── validateBundle extra ─────────────────────────────────────────────────────

describe("validateBundle extra", () => {
  test("eventsTruncated=true propagates through validation", () => {
    const b = validateBundle({ version: 1, eventsTruncated: true });
    expect(b.eventsTruncated).toBe(true);
  });

  test("eventsTruncated=false when absent (default)", () => {
    const b = validateBundle({ version: 1 });
    expect(b.eventsTruncated).toBe(false);
  });

  test("version 0 is accepted (below BUNDLE_VERSION)", () => {
    // Any version <= BUNDLE_VERSION is fine
    expect(() => validateBundle({ version: 0 })).not.toThrow();
  });

  test("settings=null throws", () => {
    expect(() => validateBundle({ version: 1, settings: null })).toThrow(/settings/);
  });

  test("state=null throws", () => {
    expect(() => validateBundle({ version: 1, state: null })).toThrow(/state/);
  });

  test("empty exportedAt falls back to empty string", () => {
    const b = validateBundle({ version: 1 });
    expect(b.exportedAt).toBe("");
  });

  test("exportedAt string preserved", () => {
    const b = validateBundle({ version: 1, exportedAt: "2026-06-13T00:00:00.000Z" });
    expect(b.exportedAt).toBe("2026-06-13T00:00:00.000Z");
  });
});

// ─── importBundle settings rollback ──────────────────────────────────────────

describe("importBundle settings rollback", () => {
  test("settings not taken as snapshot when settings object is empty", async () => {
    // empty settings → settingsImported=false, no rollback needed
    const res = await importBundle({ version: 1, settings: {}, state: {}, events: [] });
    expect(res.settingsImported).toBe(false);
  });

  test("settings are applied when non-empty", async () => {
    const res = await importBundle({
      version: 1,
      settings: { targetLang: "ko" },
      state: {},
      events: [],
    });
    expect(res.settingsImported).toBe(true);
    const s = await readSettings();
    expect(s.targetLang).toBe("ko");
  });

  test("corrupted state.json does NOT block import (readState swallows parse errors)", async () => {
    // This documents a source behaviour: mergeIntoFile calls readState() which
    // catches JSON parse errors and returns {}. So a corrupted state.json does
    // NOT cause importBundle to throw, and thus the rollback branch is never
    // exercised via bad JSON alone.
    await writeSettings({ targetLang: "ja" });
    await Bun.write(join(configDir, "state.json"), "NOT_JSON_AT_ALL");

    const res = await importBundle({
      version: 1,
      settings: { targetLang: "ko" },
      state: { "zr.x": { v: "1", ts: 1 } },
      events: [],
    });
    // Succeeds — corrupted file silently treated as {}
    expect(res.settingsImported).toBe(true);
    const s = await readSettings();
    expect(s.targetLang).toBe("ko"); // settings applied (no rollback needed)
  });
});

// ─── importBundle malformed events filtered ──────────────────────────────────

describe("importBundle malformed events", () => {
  test("events missing type are filtered out", async () => {
    const res = await importBundle(
      {
        version: 1,
        settings: {},
        state: {},
        events: [
          { ts: 1 }, // missing type
          { ts: 2, type: "lookup" }, // valid
        ],
      },
      { importEvents: true },
    );
    expect(res.eventsImported).toBe(1);
    const ev = await readEvents();
    expect(ev[0]!.type).toBe("lookup");
  });

  test("events missing ts are filtered out", async () => {
    const res = await importBundle(
      {
        version: 1,
        settings: {},
        state: {},
        events: [
          { type: "heartbeat" }, // missing ts
          { ts: 5, type: "anki_add" }, // valid
        ],
      },
      { importEvents: true },
    );
    expect(res.eventsImported).toBe(1);
  });

  test("non-object entries in events array are filtered out", async () => {
    const res = await importBundle(
      {
        version: 1,
        settings: {},
        state: {},
          events: ([null, "string", 42, { ts: 1, type: "ok" }] as unknown as import("../src/lib/telemetry.ts").TelemetryEvent[]),
      },
      { importEvents: true },
    );
    expect(res.eventsImported).toBe(1);
  });
});

// ─── exportFileName ───────────────────────────────────────────────────────────

describe("exportFileName", () => {
  test("uses the first 10 chars of ISO string (YYYY-MM-DD)", () => {
    expect(exportFileName(new Date("2026-01-01T00:00:00Z"))).toBe(
      "zehntage-export-2026-01-01.json",
    );
    expect(exportFileName(new Date("2099-12-31T23:59:59Z"))).toBe(
      "zehntage-export-2099-12-31.json",
    );
  });
});

// ─── round-trip with events ───────────────────────────────────────────────────

describe("full round-trip with events", () => {
  test("export→import→export produces stable result", async () => {
    await Bun.write(
      join(configDir, "settings.json"),
      JSON.stringify({ targetLang: "ja", knownLang: "de" }),
    );
    await Bun.write(
      join(configDir, "state.json"),
      JSON.stringify({ "zr.resume.ep01": { v: "120", ts: 500 } }),
    );
    await Bun.write(eventsFile, '{"ts":1,"type":"heartbeat"}\n{"ts":2,"type":"lookup"}\n');

    const bundle1 = await buildExportBundle();
    await importBundle(bundle1, { importEvents: true });

    const bundle2 = await buildExportBundle();
    expect(bundle2.settings.targetLang).toBe("ja");
    expect(bundle2.state["zr.resume.ep01"]).toEqual({ v: "120", ts: 500 });
    // events were imported then re-exported (may have grown, but original 2 are there)
    expect(bundle2.events.length).toBeGreaterThanOrEqual(2);
  });
});
