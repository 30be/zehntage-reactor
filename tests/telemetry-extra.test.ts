/**
 * Supplemental telemetry tests — covering gaps not addressed by telemetry.test.ts:
 *   - logEvents / logEvent: NaN-ts filtering, empty batch, file write
 *   - readEvents: missing file, malformed/torn lines
 *   - summarizeEvents: NaN-ts guard, no-mediaId heartbeat, huge event set,
 *     content-delta edge cases (exactly 60s, backward, no position)
 *   - currentStreak: single-day, very long run
 *   - todayStats: active=false when only paused heartbeats
 *   - healthSummary: single-event percentiles, perf event with no ms field
 *   - summarizeComprehension: negative total skipped
 *   - episodeSeries: basic rows, coefficient null < 60s, cardsPerMin
 *   - overview: last30Days zero-fill, ankiCumulative
 *   - toCsv: header, null cells, quoting
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  logEvents,
  logEvent,
  readEvents,
  summarizeEvents,
  summarizeComprehension,
  healthSummary,
  todayStats,
  currentStreak,
  episodeSeries,
  overview,
  toCsv,
  type TelemetryEvent,
} from "../src/lib/telemetry.ts";

let base: string;
let eventsFile: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "zr-tel-extra-"));
  eventsFile = join(base, "events.jsonl");
  savedEnv["ZR_EVENTS_FILE"] = process.env.ZR_EVENTS_FILE;
  process.env.ZR_EVENTS_FILE = eventsFile;
});

afterEach(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(base, { recursive: true, force: true });
});

// ─── logEvents / logEvent ────────────────────────────────────────────────────

describe("logEvents", () => {
  test("empty batch is a no-op (no file created)", async () => {
    await logEvents([]);
    const exists = await Bun.file(eventsFile).exists();
    expect(exists).toBe(false);
  });

  test("filters out events with NaN / negative / Infinity ts", async () => {
    const bad: TelemetryEvent[] = [
      { ts: NaN, type: "heartbeat" },
      { ts: -1, type: "lookup" },
      { ts: Infinity, type: "anki_add" },
      { ts: 0, type: "heartbeat" }, // ts must be > 0
    ];
    await logEvents(bad);
    const exists = await Bun.file(eventsFile).exists();
    expect(exists).toBe(false); // nothing valid to write
  });

  test("filters out events with non-string type", async () => {
    // @ts-expect-error intentionally wrong shape
    await logEvents([{ ts: 1000, type: 42 }, { ts: 1001, type: null }]);
    const exists = await Bun.file(eventsFile).exists();
    expect(exists).toBe(false);
  });

  test("writes valid events, skips invalid ones in the same batch", async () => {
    const events: TelemetryEvent[] = [
      { ts: 1000, type: "lookup" },
      { ts: NaN, type: "lookup" }, // invalid → dropped
      { ts: 2000, type: "anki_add" },
    ];
    await logEvents(events);
    const lines = (await readFile(eventsFile, "utf8"))
      .split("\n")
      .filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).type).toBe("lookup");
    expect(JSON.parse(lines[1]!).type).toBe("anki_add");
  });

  test("multiple logEvents calls append (not overwrite)", async () => {
    await logEvents([{ ts: 1, type: "heartbeat" }]);
    await logEvents([{ ts: 2, type: "lookup" }]);
    const lines = (await readFile(eventsFile, "utf8"))
      .split("\n")
      .filter(Boolean);
    expect(lines).toHaveLength(2);
  });

  test("logEvent convenience wrapper writes one event", async () => {
    await logEvent("quiz.result", { total: 5, correct: 3 });
    const events = await readEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("quiz.result");
    expect(events[0]!.total).toBe(5);
  });
});

// ─── readEvents ──────────────────────────────────────────────────────────────

describe("readEvents", () => {
  test("returns [] when file does not exist", async () => {
    // eventsFile doesn't exist yet
    expect(await readEvents()).toEqual([]);
  });

  test("skips torn/garbage lines but keeps valid ones", async () => {
    await Bun.write(
      eventsFile,
      [
        '{"ts":1,"type":"heartbeat"}',
        "NOT JSON AT ALL",
        '{"ts":2,"type":"lookup"}',
        "{partial:",
        '{"ts":3,"type":"anki_add"}',
        "",
      ].join("\n"),
    );
    const ev = await readEvents();
    expect(ev.map((e) => e.ts)).toEqual([1, 2, 3]);
  });

  test("skips lines missing ts or type", async () => {
    await Bun.write(
      eventsFile,
      [
        '{"ts":1}',              // no type
        '{"type":"heartbeat"}',   // no ts
        '{"ts":5,"type":"ok"}',
      ].join("\n") + "\n",
    );
    const ev = await readEvents();
    expect(ev).toHaveLength(1);
    expect(ev[0]!.type).toBe("ok");
  });

  test("empty file returns []", async () => {
    await Bun.write(eventsFile, "");
    expect(await readEvents()).toEqual([]);
  });

  test("round-trip: written events can be read back intact", async () => {
    const original: TelemetryEvent[] = [
      { ts: 100, type: "heartbeat", mediaId: "ep01", position: 42, paused: false },
      { ts: 200, type: "anki_add", mediaId: "ep01" },
    ];
    await logEvents(original);
    const read = await readEvents();
    expect(read).toHaveLength(2);
    expect(read[0]!.position).toBe(42);
    expect(read[1]!.type).toBe("anki_add");
  });
});

// ─── summarizeEvents (extra edge cases) ──────────────────────────────────────

const DAY = new Date(2026, 5, 10, 12, 0, 0).getTime(); // local noon June 10

describe("summarizeEvents extra", () => {
  test("NaN-ts events are skipped silently", () => {
    const ev: TelemetryEvent[] = [
      { ts: NaN, type: "heartbeat", mediaId: "m1", position: 0 },
      { ts: DAY, type: "anki_add", mediaId: "m1" },
    ];
    const s = summarizeEvents(ev);
    expect(s.days).toHaveLength(1);
    expect(s.days[0]!.ankiAdds).toBe(1);
    expect(s.days[0]!.playSec).toBe(0); // NaN heartbeat discarded
  });

  test("heartbeat without mediaId contributes to day but not media", () => {
    const ev: TelemetryEvent[] = [
      { ts: DAY, type: "heartbeat", position: 5, paused: false },
    ];
    const s = summarizeEvents(ev);
    expect(s.days[0]!.playSec).toBe(15);
    expect(s.media).toEqual([]);
  });

  test("content delta exactly 60s IS counted (boundary inclusive)", () => {
    const ev: TelemetryEvent[] = [
      { ts: DAY, type: "heartbeat", mediaId: "m1", position: 0 },
      { ts: DAY + 15_000, type: "heartbeat", mediaId: "m1", position: 60 },
    ];
    const s = summarizeEvents(ev);
    expect(s.media[0]!.contentSec).toBe(60);
  });

  test("content delta of 61s (seek) is NOT counted", () => {
    const ev: TelemetryEvent[] = [
      { ts: DAY, type: "heartbeat", mediaId: "m1", position: 0 },
      { ts: DAY + 15_000, type: "heartbeat", mediaId: "m1", position: 61 },
    ];
    const s = summarizeEvents(ev);
    expect(s.media[0]!.contentSec).toBe(0);
  });

  test("backward position (rewind) is NOT counted as content", () => {
    const ev: TelemetryEvent[] = [
      { ts: DAY, type: "heartbeat", mediaId: "m1", position: 100 },
      { ts: DAY + 15_000, type: "heartbeat", mediaId: "m1", position: 50 },
    ];
    const s = summarizeEvents(ev);
    expect(s.media[0]!.contentSec).toBe(0);
  });

  test("heartbeat without position doesn't crash and doesn't count content", () => {
    const ev: TelemetryEvent[] = [
      { ts: DAY, type: "heartbeat", mediaId: "m1" }, // no position
      { ts: DAY + 15_000, type: "heartbeat", mediaId: "m1" },
    ];
    const s = summarizeEvents(ev);
    expect(s.media[0]!.contentSec).toBe(0);
    expect(s.media[0]!.wallSec).toBe(30);
  });

  test("huge event set (5000 events) completes without error", () => {
    const events: TelemetryEvent[] = Array.from({ length: 5000 }, (_, i) => ({
      ts: DAY + i * 15_000,
      type: i % 3 === 0 ? "heartbeat" : i % 3 === 1 ? "anki_add" : "lookup",
      mediaId: `m${i % 5}`,
      position: i * 10,
    }));
    const s = summarizeEvents(events);
    expect(s.days.length).toBeGreaterThan(0);
    expect(s.media.length).toBe(5);
  });

  test("mediaCount reflects distinct media per day", () => {
    const ev: TelemetryEvent[] = [
      { ts: DAY, type: "anki_add", mediaId: "a" },
      { ts: DAY + 100, type: "anki_add", mediaId: "a" }, // duplicate
      { ts: DAY + 200, type: "anki_add", mediaId: "b" },
      { ts: DAY + 300, type: "anki_add" }, // no mediaId — doesn't count
    ];
    const s = summarizeEvents(ev);
    expect(s.days[0]!.mediaCount).toBe(2);
  });

  test("media list sorted by wallSec descending", () => {
    const ev: TelemetryEvent[] = [
      { ts: DAY, type: "heartbeat", mediaId: "low", position: 0 },
      { ts: DAY, type: "heartbeat", mediaId: "high", position: 0 },
      { ts: DAY + 15_000, type: "heartbeat", mediaId: "high", position: 15 },
    ];
    const s = summarizeEvents(ev);
    expect(s.media[0]!.mediaId).toBe("high");
  });
});

// ─── summarizeComprehension extra ────────────────────────────────────────────

describe("summarizeComprehension extra", () => {
  test("negative total is skipped (same guard as zero)", () => {
    const s = summarizeComprehension([
      { ts: DAY, type: "quiz.result", total: -5, correct: 3 },
      { ts: DAY + 1, type: "quiz.result", total: 4, correct: 4 },
    ]);
    expect(s.quizzes).toBe(1);
    expect(s.points[0]!.pct).toBe(100);
  });

  test("100% and 0% scores both round correctly", () => {
    const s = summarizeComprehension([
      { ts: DAY, type: "quiz.result", total: 5, correct: 5 },
      { ts: DAY + 1, type: "quiz.result", total: 5, correct: 0 },
    ]);
    expect(s.points[0]!.pct).toBe(100);
    expect(s.points[1]!.pct).toBe(0);
    expect(s.avgPct).toBe(50);
  });

  test("non-numeric correct/total default to 0", () => {
    const s = summarizeComprehension([
      ({ ts: DAY, type: "quiz.result", total: "oops", correct: "nope" } as unknown as TelemetryEvent),
    ]);
    // total becomes 0 → skipped
    expect(s.quizzes).toBe(0);
  });
});

// ─── currentStreak extra ─────────────────────────────────────────────────────

const DAY_MS = 24 * 3600 * 1000;
const noon = (y: number, m: number, day: number) => new Date(y, m, day, 12).getTime();
const ds = (ts: number) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

describe("currentStreak extra", () => {
  const NOW = noon(2026, 5, 13); // 2026-06-13

  test("streak of 1 (only today)", () => {
    expect(currentStreak(new Set([ds(NOW)]), NOW)).toBe(1);
  });

  test("30-day consecutive run", () => {
    const set = new Set(
      Array.from({ length: 30 }, (_, i) => ds(NOW - i * DAY_MS)),
    );
    expect(currentStreak(set, NOW)).toBe(30);
  });

  test("gap in the middle breaks it even if dates further back exist", () => {
    const set = new Set([
      ds(NOW),
      // skip yesterday
      ds(NOW - 2 * DAY_MS),
      ds(NOW - 3 * DAY_MS),
    ]);
    expect(currentStreak(set, NOW)).toBe(1);
  });
});

// ─── todayStats extra ────────────────────────────────────────────────────────

describe("todayStats extra", () => {
  const NOW = noon(2026, 5, 13);

  test("active=false when only paused heartbeats today", () => {
    const ev: TelemetryEvent[] = [
      { ts: NOW, type: "heartbeat", mediaId: "m1", position: 0, paused: true },
      { ts: NOW + 15000, type: "heartbeat", mediaId: "m1", position: 0, paused: true },
    ];
    const s = todayStats(ev, NOW);
    // paused heartbeats do not count as playSec — but they ARE activity events,
    // so activeDates has today. active requires also having playSec OR counts.
    expect(s.minutes).toBe(0);
    // NOTE: active checks cueSet, wordsMined, lookups, quizzes, playSec — all 0
    // but activeDates HAS today (heartbeat is activity for streak purposes).
    // So active=false is expected here.
    expect(s.active).toBe(false);
    // The streak still counts since heartbeat registers the day
    expect(s.streak).toBe(1);
  });

  test("yesterday-only activity contributes to streak but not today's tiles", () => {
    const YEST = NOW - DAY_MS;
    const ev: TelemetryEvent[] = [
      { ts: YEST, type: "anki_add", mediaId: "m1" },
    ];
    const s = todayStats(ev, NOW);
    expect(s.wordsMined).toBe(0);
    expect(s.streak).toBe(0); // today has no activity → streak broken
    expect(s.active).toBe(false);
  });

  test("cue_active with non-numeric idx deduplication", () => {
    const ev: TelemetryEvent[] = [
      { ts: NOW, type: "cue_active", mediaId: "m1", idx: "special" },
      { ts: NOW + 1, type: "cue_active", mediaId: "m1", idx: "special" }, // dupe
      { ts: NOW + 2, type: "cue_active", mediaId: "m1", idx: "other" },
    ];
    const s = todayStats(ev, NOW);
    expect(s.cuesWatched).toBe(2); // "special" deduped, "other" is new
  });

  test("non-activity events are ignored for streak/active", () => {
    const ev: TelemetryEvent[] = [
      { ts: NOW, type: "route_change", route: "/home" },
      { ts: NOW + 1, type: "whisper_done", mediaId: "m1" },
    ];
    const s = todayStats(ev, NOW);
    expect(s.streak).toBe(0);
    expect(s.active).toBe(false);
  });
});

// ─── healthSummary extra ─────────────────────────────────────────────────────

const NOW_H = Date.now();
const HR = 3600_000;

describe("healthSummary extra", () => {
  test("single-event percentile: p50=p95=min=max=that value", () => {
    const s = healthSummary(
      [{ ts: NOW_H - HR, type: "perf.gemini", ms: 777 }],
      NOW_H,
    );
    const gem = s.perfStats.find((r) => r.type === "perf.gemini")!;
    expect(gem.count).toBe(1);
    expect(gem.p50).toBe(777);
    expect(gem.p95).toBe(777);
    expect(gem.min).toBe(777);
    expect(gem.max).toBe(777);
  });

  test("perf event without ms field is excluded from stats", () => {
    const s = healthSummary(
      [{ ts: NOW_H - HR, type: "perf.gemini" }], // no ms
      NOW_H,
    );
    expect(s.perfStats).toEqual([]);
  });

  test("perf.route without ms field not included in slowestRoutes ms", () => {
    // ms defaults to 0 for route events
    const s = healthSummary(
      [{ ts: NOW_H - HR, type: "perf.route", path: "/api/state", status: 200 }],
      NOW_H,
    );
    expect(s.slowestRoutes[0]!.ms).toBe(0);
  });

  test("anomaly.whisper_warning without mediaId omits mediaId field", () => {
    const s = healthSummary(
      [{ ts: NOW_H - HR, type: "anomaly.whisper_warning", message: "oops" }],
      NOW_H,
    );
    const w = s.whisperWarnings[0]!;
    expect(w.message).toBe("oops");
    expect("mediaId" in w).toBe(false);
  });

  test("windowMs is always 24h in ms", () => {
    const s = healthSummary([], NOW_H);
    expect(s.windowMs).toBe(24 * 3600 * 1000);
  });

  test("anomalyCounts sorted by count descending", () => {
    const events: TelemetryEvent[] = [
      { ts: NOW_H - HR, type: "anomaly.gemini_fail" },
      { ts: NOW_H - HR, type: "anomaly.anki_slow" },
      { ts: NOW_H - HR, type: "anomaly.anki_slow" },
      { ts: NOW_H - HR, type: "anomaly.anki_slow" },
    ];
    const s = healthSummary(events, NOW_H);
    expect(s.anomalyCounts[0]!.type).toBe("anomaly.anki_slow");
    expect(s.anomalyCounts[0]!.count).toBe(3);
  });

  test("perfStats sorted alphabetically by type", () => {
    const events: TelemetryEvent[] = [
      { ts: NOW_H - HR, type: "perf.whisper", ms: 100 },
      { ts: NOW_H - HR, type: "perf.anki", ms: 50 },
      { ts: NOW_H - HR, type: "perf.gemini", ms: 200 },
    ];
    const s = healthSummary(events, NOW_H);
    const types = s.perfStats.map((p) => p.type);
    expect(types).toEqual([...types].sort());
  });
});

// ─── episodeSeries ────────────────────────────────────────────────────────────

describe("episodeSeries", () => {
  test("empty input → empty array", () => {
    expect(episodeSeries([])).toEqual([]);
  });

  test("events without mediaId are ignored", () => {
    const ev: TelemetryEvent[] = [
      { ts: DAY, type: "heartbeat", position: 0, paused: false }, // no mediaId
    ];
    expect(episodeSeries(ev)).toEqual([]);
  });

  test("basic row: playing heartbeats, lookups, ankiAdds", () => {
    const ev: TelemetryEvent[] = [
      { ts: DAY, type: "heartbeat", mediaId: "ep01", position: 0, paused: false },
      { ts: DAY + 15_000, type: "heartbeat", mediaId: "ep01", position: 15, paused: false },
      { ts: DAY + 30_000, type: "lookup", mediaId: "ep01" },
      { ts: DAY + 31_000, type: "anki_add", mediaId: "ep01" },
    ];
    const rows = episodeSeries(ev);
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.mediaId).toBe("ep01");
    expect(r.wallPlayingSec).toBe(30);
    expect(r.wallPausedSec).toBe(0);
    expect(r.contentSec).toBe(15);
    expect(r.lookups).toBe(1);
    expect(r.ankiAdds).toBe(1);
  });

  test("coefficient is null when contentSec < 60", () => {
    const ev: TelemetryEvent[] = [
      { ts: DAY, type: "heartbeat", mediaId: "ep01", position: 0, paused: false },
      { ts: DAY + 15_000, type: "heartbeat", mediaId: "ep01", position: 15, paused: false },
    ];
    const rows = episodeSeries(ev);
    expect(rows[0]!.coefficient).toBeNull();
  });

  test("coefficient computed correctly when contentSec >= 60", () => {
    // 5 consecutive heartbeats, each +15s position → 60s content
    const ev: TelemetryEvent[] = Array.from({ length: 5 }, (_, i) => ({
      ts: DAY + i * 15_000,
      type: "heartbeat",
      mediaId: "ep01",
      position: i * 15,
      paused: false,
    }));
    const rows = episodeSeries(ev);
    expect(rows[0]!.contentSec).toBe(60);
    // coefficient = (wallPlaying + wallPaused) / content = (75 + 0) / 60
    expect(rows[0]!.coefficient).toBeCloseTo(75 / 60, 5);
  });

  test("cardsPerMin is null when no playing time", () => {
    const ev: TelemetryEvent[] = [
      { ts: DAY, type: "heartbeat", mediaId: "ep01", position: 0, paused: true },
      { ts: DAY + 1000, type: "anki_add", mediaId: "ep01" },
    ];
    const rows = episodeSeries(ev);
    expect(rows[0]!.cardsPerMin).toBeNull();
  });

  test("cardsPerMin computed: 4 cards over 2 min playing", () => {
    // 8 playing heartbeats = 120s = 2 min
    const ev: TelemetryEvent[] = [
      ...Array.from({ length: 8 }, (_, i) => ({
        ts: DAY + i * 15_000,
        type: "heartbeat",
        mediaId: "ep01",
        position: i * 15,
        paused: false,
      })),
      ...Array.from({ length: 4 }, (_, i) => ({
        ts: DAY + i * 1000,
        type: "anki_add",
        mediaId: "ep01",
      })),
    ];
    const rows = episodeSeries(ev);
    expect(rows[0]!.cardsPerMin).toBeCloseTo(4 / 2, 5);
  });

  test("rows split by date boundary", () => {
    const day2 = DAY + 24 * 3600 * 1000;
    const ev: TelemetryEvent[] = [
      { ts: DAY, type: "heartbeat", mediaId: "ep01", position: 0, paused: false },
      { ts: day2, type: "heartbeat", mediaId: "ep01", position: 15, paused: false },
    ];
    const rows = episodeSeries(ev);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.date < rows[1]!.date).toBe(true);
  });

  test("sorted by date then mediaId", () => {
    const ev: TelemetryEvent[] = [
      { ts: DAY, type: "anki_add", mediaId: "zzz" },
      { ts: DAY, type: "anki_add", mediaId: "aaa" },
    ];
    const rows = episodeSeries(ev);
    expect(rows[0]!.mediaId).toBe("aaa");
    expect(rows[1]!.mediaId).toBe("zzz");
  });
});

// ─── overview ─────────────────────────────────────────────────────────────────

describe("overview", () => {
  test("empty events → zero totals, 30 zero-filled days anchored on now", () => {
    const ov = overview([], DAY);
    expect(ov.totals.ankiAdds).toBe(0);
    expect(ov.totals.mediaCount).toBe(0);
    expect(ov.last30Days).toHaveLength(30);
    expect(ov.last30Days.every((d) => d.ankiAdds === 0)).toBe(true);
    expect(ov.ankiCumulative).toEqual([]);
  });

  test("totals aggregate across all rows", () => {
    const ev: TelemetryEvent[] = [
      { ts: DAY, type: "heartbeat", mediaId: "m1", position: 0, paused: false },
      { ts: DAY, type: "anki_add", mediaId: "m1" },
      { ts: DAY, type: "lookup", mediaId: "m2" },
    ];
    const ov = overview(ev, DAY);
    expect(ov.totals.ankiAdds).toBe(1);
    expect(ov.totals.lookups).toBe(1);
    expect(ov.totals.wallPlayingSec).toBe(15);
    expect(ov.totals.mediaCount).toBe(2);
  });

  test("last30Days contains today's date and has length 30", () => {
    const ev: TelemetryEvent[] = [
      { ts: DAY, type: "anki_add", mediaId: "m1" },
    ];
    const ov = overview(ev, DAY);
    expect(ov.last30Days).toHaveLength(30);
    const today = new Date(DAY);
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    expect(ov.last30Days[29]!.date).toBe(todayStr);
  });

  test("ankiCumulative only includes days with adds, running total correct", () => {
    const day2 = DAY + 24 * 3600 * 1000;
    const ev: TelemetryEvent[] = [
      { ts: DAY, type: "anki_add", mediaId: "m1" },
      { ts: DAY + 100, type: "anki_add", mediaId: "m1" },
      { ts: day2, type: "anki_add", mediaId: "m1" },
      { ts: day2 + 100, type: "lookup", mediaId: "m1" }, // no add — not in cumulative
    ];
    const ov = overview(ev, day2);
    expect(ov.ankiCumulative).toHaveLength(2);
    expect(ov.ankiCumulative[0]!.total).toBe(2);
    expect(ov.ankiCumulative[1]!.total).toBe(3);
  });
});

// ─── toCsv ───────────────────────────────────────────────────────────────────

describe("toCsv", () => {
  test("empty rows → header only (with trailing newline)", () => {
    const csv = toCsv([]);
    expect(csv).toMatch(/^mediaId,date,/);
    expect(csv.endsWith("\n")).toBe(true);
    expect(csv.split("\n").filter(Boolean)).toHaveLength(1); // just header
  });

  test("null cells render as empty", () => {
    const ev: TelemetryEvent[] = [
      { ts: DAY, type: "heartbeat", mediaId: "ep01", position: 0, paused: false },
    ];
    const rows = episodeSeries(ev);
    const csv = toCsv(rows);
    const dataLine = csv.split("\n")[1]!;
    // coefficient and cardsPerMin are null → empty cells
    expect(dataLine).toContain(",,"); // at least one adjacent empty cell
  });

  test("mediaId with commas is quoted", () => {
    const ev: TelemetryEvent[] = [
      { ts: DAY, type: "anki_add", mediaId: "ep,01" },
    ];
    const rows = episodeSeries(ev);
    const csv = toCsv(rows);
    expect(csv).toContain('"ep,01"');
  });

  test("mediaId with double-quotes is escaped", () => {
    const ev: TelemetryEvent[] = [
      { ts: DAY, type: "anki_add", mediaId: 'ep"01"' },
    ];
    const rows = episodeSeries(ev);
    const csv = toCsv(rows);
    expect(csv).toContain('"ep""01"""');
  });

  test("numbers: integers as-is, floats to 3dp", () => {
    // cardsPerMin: 1 card / (15/60 min) = 4.0 exactly — integer → no decimal
    const ev: TelemetryEvent[] = [
      { ts: DAY, type: "heartbeat", mediaId: "m1", position: 0, paused: false },
      { ts: DAY + 15000, type: "anki_add", mediaId: "m1" },
    ];
    const rows = episodeSeries(ev);
    const csv = toCsv(rows);
    const dataLine = csv.split("\n")[1]!;
    // cardsPerMin = 1/(15/60) = 4.0 → integer → "4"
    expect(dataLine).toContain(",4");
  });
});
