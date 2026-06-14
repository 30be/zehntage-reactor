/**
 * Tests for G2 vocab-growth + the wordHistory read bound.
 *   - wordsAddedPerDay: empty, single day, multi-day cumulative, out-of-order,
 *     non-anki_add ignored, NaN-ts guard.
 *   - readRecentEvents / wordHistoryFromFile: caps to the last N parsed events.
 * Pure/deterministic — timestamps are passed in (no Date.now in assertions).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  wordsAddedPerDay,
  readRecentEvents,
  wordHistory,
  wordHistoryFromFile,
  logEvents,
  type TelemetryEvent,
} from "../src/lib/telemetry.ts";

// ts at local noon on a given calendar day — timezone-stable for localDate().
const ts = (y: number, m: number, d: number, extraMs = 0) =>
  new Date(y, m - 1, d, 12, 0, 0).getTime() + extraMs;

describe("wordsAddedPerDay", () => {
  test("empty log → empty series", () => {
    expect(wordsAddedPerDay([])).toEqual([]);
  });

  test("single day buckets all adds with cumulative === count", () => {
    const events: TelemetryEvent[] = [
      { ts: ts(2026, 1, 5), type: "anki_add", word: "猫" },
      { ts: ts(2026, 1, 5, 1000), type: "anki_add", word: "犬" },
      { ts: ts(2026, 1, 5, 2000), type: "anki_add", word: "鳥" },
    ];
    const out = wordsAddedPerDay(events);
    expect(out).toEqual([{ date: "2026-01-05", count: 3, cumulative: 3 }]);
  });

  test("multi-day cumulative is monotone and sorted", () => {
    const events: TelemetryEvent[] = [
      { ts: ts(2026, 1, 1), type: "anki_add", word: "a" },
      { ts: ts(2026, 1, 2), type: "anki_add", word: "b" },
      { ts: ts(2026, 1, 2), type: "anki_add", word: "c" },
      { ts: ts(2026, 1, 4), type: "anki_add", word: "d" },
    ];
    const out = wordsAddedPerDay(events);
    expect(out).toEqual([
      { date: "2026-01-01", count: 1, cumulative: 1 },
      { date: "2026-01-02", count: 2, cumulative: 3 },
      { date: "2026-01-04", count: 1, cumulative: 4 },
    ]);
  });

  test("out-of-order events still produce sorted, correct cumulative", () => {
    const events: TelemetryEvent[] = [
      { ts: ts(2026, 1, 4), type: "anki_add", word: "d" },
      { ts: ts(2026, 1, 1), type: "anki_add", word: "a" },
      { ts: ts(2026, 1, 2), type: "anki_add", word: "b" },
    ];
    const out = wordsAddedPerDay(events);
    expect(out.map((p) => p.date)).toEqual([
      "2026-01-01",
      "2026-01-02",
      "2026-01-04",
    ]);
    expect(out.map((p) => p.cumulative)).toEqual([1, 2, 3]);
  });

  test("ignores non-anki_add events and NaN ts", () => {
    const events: TelemetryEvent[] = [
      { ts: ts(2026, 1, 1), type: "lookup", word: "x" },
      { ts: ts(2026, 1, 1), type: "heartbeat" },
      { ts: NaN, type: "anki_add", word: "bad" },
      { ts: ts(2026, 1, 1), type: "anki_add", word: "ok" },
    ];
    expect(wordsAddedPerDay(events)).toEqual([
      { date: "2026-01-01", count: 1, cumulative: 1 },
    ]);
  });
});

describe("readRecentEvents bound", () => {
  let base: string;
  const saved = process.env.ZR_EVENTS_FILE;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "zr-growth-"));
    process.env.ZR_EVENTS_FILE = join(base, "events.jsonl");
  });
  afterEach(async () => {
    if (saved === undefined) delete process.env.ZR_EVENTS_FILE;
    else process.env.ZR_EVENTS_FILE = saved;
    await rm(base, { recursive: true, force: true });
  });

  test("missing file → empty", async () => {
    expect(await readRecentEvents(10)).toEqual([]);
  });

  test("caps to the last N parsed events", async () => {
    const all: TelemetryEvent[] = [];
    for (let i = 0; i < 20; i++)
      all.push({ ts: ts(2026, 1, 1) + i, type: "lookup", word: `w${i}` });
    await logEvents(all);
    const recent = await readRecentEvents(5);
    expect(recent.length).toBe(5);
    expect(recent.map((e) => e.word)).toEqual(["w15", "w16", "w17", "w18", "w19"]);
  });

  test("returns everything when fewer than the bound", async () => {
    await logEvents([{ ts: ts(2026, 1, 1), type: "anki_add", word: "猫" }]);
    expect((await readRecentEvents(100)).length).toBe(1);
  });

  test("wordHistoryFromFile only sees events within the bound", async () => {
    // An old add followed by many newer events that push it past the cap.
    const events: TelemetryEvent[] = [
      { ts: ts(2026, 1, 1), type: "anki_add", word: "古" },
    ];
    for (let i = 0; i < 60_000; i++)
      events.push({ ts: ts(2026, 2, 1) + i, type: "heartbeat" });
    await logEvents(events);
    // Beyond the default 50k bound the old add is dropped from the read.
    const h = await wordHistoryFromFile(["古"]);
    expect(h.addedAt).toBeUndefined();
    // The pure aggregator over the full array still finds it (correctness ref).
    expect(wordHistory(events, ["古"]).addedAt).toBe(ts(2026, 1, 1));
  });
});
