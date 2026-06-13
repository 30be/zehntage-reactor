import { describe, expect, test } from "bun:test";
import {
  summarizeEvents,
  summarizeComprehension,
  healthSummary,
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
