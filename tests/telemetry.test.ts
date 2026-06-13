import { describe, expect, test } from "bun:test";
import {
  summarizeEvents,
  summarizeComprehension,
  healthSummary,
  todayStats,
  currentStreak,
  type TelemetryEvent,
} from "../src/lib/telemetry.ts";

const DAY = new Date(2026, 5, 10, 12, 0, 0).getTime(); // local noon

function hb(ts: number, mediaId: string, position: number, paused = false): TelemetryEvent {
  return { ts, type: "heartbeat", mediaId, position, paused };
}

describe("summarizeEvents", () => {
  test("empty log → empty summary", () => {
    expect(summarizeEvents([])).toEqual({ days: [], media: [] });
  });

  test("heartbeats split playing/paused wall time and estimate content time", () => {
    const ev = [
      hb(DAY, "m1", 10),
      hb(DAY + 15_000, "m1", 25), // +15s content
      hb(DAY + 30_000, "m1", 40), // +15s content
      hb(DAY + 45_000, "m1", 40, true), // paused
      hb(DAY + 60_000, "m1", 500), // seek: delta 460 > 60 → no content
    ];
    const s = summarizeEvents(ev);
    expect(s.days).toHaveLength(1);
    const d = s.days[0]!;
    expect(d.playSec).toBe(4 * 15);
    expect(d.pauseSec).toBe(15);
    expect(d.mediaCount).toBe(1);
    const m = s.media[0]!;
    expect(m.mediaId).toBe("m1");
    expect(m.wallSec).toBe(4 * 15);
    expect(m.contentSec).toBe(30);
  });

  test("anki_add and lookup counted per day and per media", () => {
    const ev: TelemetryEvent[] = [
      { ts: DAY, type: "anki_add", mediaId: "m1" },
      { ts: DAY + 1000, type: "lookup", mediaId: "m1" },
      { ts: DAY + 2000, type: "lookup" }, // no media — day-only
      hb(DAY + 3000, "m1", 5),
    ];
    const s = summarizeEvents(ev);
    expect(s.days[0]!.ankiAdds).toBe(1);
    expect(s.days[0]!.lookups).toBe(2);
    expect(s.media[0]!.ankiAdds).toBe(1);
    expect(s.media[0]!.lookups).toBe(1);
  });

  test("days are sorted and split across midnights", () => {
    const day2 = DAY + 24 * 3600 * 1000;
    const s = summarizeEvents([hb(day2, "m1", 1), hb(DAY, "m1", 0)]);
    expect(s.days).toHaveLength(2);
    expect(s.days[0]!.date < s.days[1]!.date).toBe(true);
  });

  test("unknown event types are ignored in aggregates", () => {
    const s = summarizeEvents([{ ts: DAY, type: "route_change", route: "stats" }]);
    expect(s.days[0]!.playSec).toBe(0);
    expect(s.media).toEqual([]);
  });
});

// --- summarizeComprehension tests ---

const quiz = (ts: number, correct: number, total: number, mediaId?: string): TelemetryEvent => ({
  ts,
  type: "quiz.result",
  correct,
  total,
  ...(mediaId ? { mediaId } : {}),
});

describe("summarizeComprehension", () => {
  test("empty log → zeroed summary", () => {
    expect(summarizeComprehension([])).toEqual({
      points: [],
      quizzes: 0,
      avgPct: 0,
      totalQuestions: 0,
      totalCorrect: 0,
    });
  });

  test("aggregates quiz.result into points, averages, totals", () => {
    const s = summarizeComprehension([
      quiz(DAY, 8, 10, "m1"), // 80%
      quiz(DAY + 1000, 6, 10), // 60%
    ]);
    expect(s.quizzes).toBe(2);
    expect(s.points.map((p) => p.pct)).toEqual([80, 60]);
    expect(s.avgPct).toBe(70);
    expect(s.totalQuestions).toBe(20);
    expect(s.totalCorrect).toBe(14);
    expect(s.points[0]!.date).toBe("2026-06-10");
  });

  test("points are chronological regardless of input order", () => {
    const s = summarizeComprehension([
      quiz(DAY + 5000, 1, 2),
      quiz(DAY, 2, 2),
    ]);
    expect(s.points.map((p) => p.ts)).toEqual([DAY, DAY + 5000]);
  });

  test("ignores non-quiz events and zero/negative-total quizzes", () => {
    const s = summarizeComprehension([
      { ts: DAY, type: "heartbeat", mediaId: "m1", position: 1 },
      quiz(DAY, 0, 0), // torn/empty quiz → skipped
      quiz(DAY + 1, 3, 4),
    ]);
    expect(s.quizzes).toBe(1);
    expect(s.points[0]!.pct).toBe(75);
  });

  test("rounds comprehension % per quiz", () => {
    const s = summarizeComprehension([quiz(DAY, 1, 3)]); // 33.33 → 33
    expect(s.points[0]!.pct).toBe(33);
  });
});

// --- healthSummary tests ---

const NOW = Date.now();
const H = 3600_000;

function perf(type: string, ms: number, extra: Record<string, unknown> = {}): TelemetryEvent {
  return { ts: NOW - H, type, ms, ...extra };
}

describe("healthSummary", () => {
  test("empty log", () => {
    const s = healthSummary([], NOW);
    expect(s.perfStats).toEqual([]);
    expect(s.slowestRoutes).toEqual([]);
    expect(s.anomalyCounts).toEqual([]);
    expect(s.whisperWarnings).toEqual([]);
  });

  test("p50/p95 computed correctly for a type", () => {
    const events: TelemetryEvent[] = Array.from({ length: 10 }, (_, i) =>
      perf("perf.gemini", (i + 1) * 100),
    );
    const s = healthSummary(events, NOW);
    const gem = s.perfStats.find((r) => r.type === "perf.gemini");
    expect(gem).toBeTruthy();
    expect(gem!.count).toBe(10);
    // p50 of [100..1000] = 500 or 600 (median of 10 values)
    expect(gem!.p50).toBeGreaterThanOrEqual(500);
    expect(gem!.p50).toBeLessThanOrEqual(600);
    expect(gem!.p95).toBeGreaterThanOrEqual(900);
  });

  test("events older than 24h are excluded", () => {
    const old: TelemetryEvent = { ts: NOW - 25 * H, type: "perf.gemini", ms: 9999 };
    const recent: TelemetryEvent = perf("perf.gemini", 100);
    const s = healthSummary([old, recent], NOW);
    const gem = s.perfStats.find((r) => r.type === "perf.gemini")!;
    expect(gem.count).toBe(1);
    expect(gem.p50).toBe(100);
  });

  test("slowest 10 routes returned in desc order", () => {
    const events: TelemetryEvent[] = Array.from({ length: 15 }, (_, i) =>
      ({ ts: NOW - H, type: "perf.route", ms: i * 100, path: "/api/x", status: 200 }),
    );
    const s = healthSummary(events, NOW);
    expect(s.slowestRoutes).toHaveLength(10);
    expect(s.slowestRoutes[0]!.ms).toBeGreaterThanOrEqual(s.slowestRoutes[1]!.ms);
  });

  test("anomaly counts aggregated", () => {
    const events: TelemetryEvent[] = [
      { ts: NOW - H, type: "anomaly.anki_slow", ms: 4000 },
      { ts: NOW - H, type: "anomaly.anki_slow", ms: 5000 },
      { ts: NOW - H, type: "anomaly.gemini_fail" },
    ];
    const s = healthSummary(events, NOW);
    const anki = s.anomalyCounts.find((a) => a.type === "anomaly.anki_slow");
    expect(anki!.count).toBe(2);
  });

  test("whisper warnings collected", () => {
    const events: TelemetryEvent[] = [
      { ts: NOW - H, type: "anomaly.whisper_warning", message: "coverage hole: 45s–60s", mediaId: "abc" },
    ];
    const s = healthSummary(events, NOW);
    expect(s.whisperWarnings[0]!.message).toBe("coverage hole: 45s–60s");
  });
});

// --- currentStreak tests ---

const DAY_MS = 24 * 3600 * 1000;
// local noon anchors so day-boundary math is unambiguous
const d = (y: number, m: number, day: number) => new Date(y, m, day, 12).getTime();
const ds = (ts: number) => {
  const x = new Date(ts);
  const mm = String(x.getMonth() + 1).padStart(2, "0");
  const dd = String(x.getDate()).padStart(2, "0");
  return `${x.getFullYear()}-${mm}-${dd}`;
};

describe("currentStreak", () => {
  const NOW2 = d(2026, 5, 13); // 2026-06-13

  test("no activity → 0", () => {
    expect(currentStreak(new Set(), NOW2)).toBe(0);
  });

  test("activity today but not yesterday → 1", () => {
    expect(currentStreak(new Set([ds(NOW2)]), NOW2)).toBe(1);
  });

  test("three consecutive days ending today → 3", () => {
    const set = new Set([
      ds(NOW2),
      ds(NOW2 - DAY_MS),
      ds(NOW2 - 2 * DAY_MS),
    ]);
    expect(currentStreak(set, NOW2)).toBe(3);
  });

  test("a gap breaks the streak", () => {
    const set = new Set([
      ds(NOW2),
      ds(NOW2 - DAY_MS),
      // skip 2 days back
      ds(NOW2 - 4 * DAY_MS),
    ]);
    expect(currentStreak(set, NOW2)).toBe(2);
  });

  test("no activity today → 0 even with a past run", () => {
    const set = new Set([ds(NOW2 - DAY_MS), ds(NOW2 - 2 * DAY_MS)]);
    expect(currentStreak(set, NOW2)).toBe(0);
  });
});

// --- todayStats tests ---

describe("todayStats", () => {
  const NOW3 = d(2026, 5, 13); // today = 2026-06-13
  const T = NOW3; // an event timestamp "today"
  const YEST = NOW3 - DAY_MS;

  test("empty log → inactive zeros, today's date", () => {
    const s = todayStats([], NOW3);
    expect(s.active).toBe(false);
    expect(s.date).toBe("2026-06-13");
    expect(s).toMatchObject({
      cuesWatched: 0,
      wordsMined: 0,
      lookups: 0,
      quizzes: 0,
      minutes: 0,
      streak: 0,
    });
  });

  test("counts today's events only; minutes from playing heartbeats", () => {
    const ev: TelemetryEvent[] = [
      { ts: T, type: "anki_add", mediaId: "m1" },
      { ts: T + 1, type: "anki_add", mediaId: "m1" },
      { ts: T + 2, type: "lookup", mediaId: "m1" },
      { ts: T + 3, type: "quiz.result", correct: 4, total: 6, mediaId: "m1" },
      { ts: T + 4, type: "heartbeat", mediaId: "m1", position: 5, paused: false },
      { ts: T + 5, type: "heartbeat", mediaId: "m1", position: 20, paused: false },
      { ts: T + 6, type: "heartbeat", mediaId: "m1", position: 20, paused: true }, // not counted
      // yesterday's events must not leak into today's tiles
      { ts: YEST, type: "anki_add", mediaId: "m1" },
      { ts: YEST, type: "lookup", mediaId: "m1" },
    ];
    const s = todayStats(ev, NOW3);
    expect(s.wordsMined).toBe(2);
    expect(s.lookups).toBe(1);
    expect(s.quizzes).toBe(1);
    // 2 playing heartbeats × 15s = 30s → rounds to 1 minute
    expect(s.minutes).toBe(1);
    expect(s.active).toBe(true);
    // streak: today + yesterday both active → 2
    expect(s.streak).toBe(2);
  });

  test("distinct cue_active events counted, replays deduped", () => {
    const ev: TelemetryEvent[] = [
      { ts: T, type: "cue_active", mediaId: "m1", idx: 0 },
      { ts: T + 1, type: "cue_active", mediaId: "m1", idx: 1 },
      { ts: T + 2, type: "cue_active", mediaId: "m1", idx: 0 }, // replay → not new
      { ts: T + 3, type: "cue_active", mediaId: "m2", idx: 0 }, // different media
    ];
    const s = todayStats(ev, NOW3);
    expect(s.cuesWatched).toBe(3);
    expect(s.active).toBe(true);
  });

  test("minutes round from playing wall time", () => {
    // 8 playing heartbeats × 15s = 120s = 2 min
    const ev: TelemetryEvent[] = Array.from({ length: 8 }, (_, i) => ({
      ts: T + i,
      type: "heartbeat",
      mediaId: "m1",
      position: i,
      paused: false,
    }));
    expect(todayStats(ev, NOW3).minutes).toBe(2);
  });
});
