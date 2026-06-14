// Unit tests for web/forecast.ts — the SRS due-forecast histogram bucketing.
// Deterministic: no Date.now in assertions; all signal passed in explicitly.

import { describe, expect, test } from "bun:test";
import {
  buildForecast,
  estimateDueOffset,
  forecastTotal,
  FORECAST_WINDOW,
} from "../web/forecast.ts";
import type { ProgressEntry } from "../web/api.ts";

// Minimal review-card progress factory (queue 2 = review).
function p(over: Partial<ProgressEntry>): ProgressEntry {
  return {
    interval: 0,
    due: 0,
    reps: 1,
    lapses: 0,
    ease: 2500,
    queue: 2,
    type: 2,
    ...over,
  };
}

describe("estimateDueOffset", () => {
  test("isDue card → bucket 0", () => {
    expect(estimateDueOffset(p({ isDue: true, interval: 10 }))).toBe(0);
  });

  test("overdue card → bucket 0", () => {
    expect(estimateDueOffset(p({ daysOverdue: 3, interval: 10 }))).toBe(0);
  });

  test("not-due review card → interval days out", () => {
    expect(estimateDueOffset(p({ interval: 5, isDue: false }))).toBe(5);
  });

  test("interval rounds to nearest whole day", () => {
    expect(estimateDueOffset(p({ interval: 2.4 }))).toBe(2);
    expect(estimateDueOffset(p({ interval: 2.6 }))).toBe(3);
  });

  test("interval beyond window clamps to window", () => {
    expect(estimateDueOffset(p({ interval: 999 }), 14)).toBe(14);
  });

  test("new card (interval 0) → null (no schedulable date)", () => {
    expect(estimateDueOffset(p({ interval: 0, isDue: false }))).toBeNull();
  });

  test("negative / non-finite interval → null", () => {
    expect(estimateDueOffset(p({ interval: -1 }))).toBeNull();
    expect(estimateDueOffset(p({ interval: NaN }))).toBeNull();
  });
});

describe("buildForecast", () => {
  test("empty deck → all-zero buckets of stable length", () => {
    const buckets = buildForecast({}, 14);
    expect(buckets).toHaveLength(15); // 0..14
    expect(forecastTotal(buckets)).toBe(0);
    expect(buckets.every((b) => b.count === 0)).toBe(true);
    expect(buckets.map((b) => b.dayOffset)).toEqual(
      Array.from({ length: 15 }, (_, i) => i),
    );
  });

  test("due-now bucket aggregates isDue + overdue", () => {
    const buckets = buildForecast(
      {
        a: p({ isDue: true, interval: 7 }),
        b: p({ daysOverdue: 2, interval: 9 }),
        c: p({ interval: 3, isDue: false }),
      },
      14,
    );
    expect(buckets[0]!.count).toBe(2); // a + b
    expect(buckets[3]!.count).toBe(1); // c
    expect(forecastTotal(buckets)).toBe(3);
  });

  test("future buckets placed at interval offset", () => {
    const buckets = buildForecast(
      {
        a: p({ interval: 1 }),
        b: p({ interval: 5 }),
        c: p({ interval: 5 }), // tie: same bucket
      },
      14,
    );
    expect(buckets[1]!.count).toBe(1);
    expect(buckets[5]!.count).toBe(2);
  });

  test("cards beyond window clamp into the last bucket", () => {
    const buckets = buildForecast(
      { a: p({ interval: 100 }), b: p({ interval: 30 }) },
      14,
    );
    expect(buckets[14]!.count).toBe(2);
  });

  test("new / unscheduled cards excluded", () => {
    const buckets = buildForecast(
      { a: p({ interval: 0, isDue: false }), b: p({ interval: 4 }) },
      14,
    );
    expect(forecastTotal(buckets)).toBe(1);
    expect(buckets[4]!.count).toBe(1);
  });

  test("default window is FORECAST_WINDOW", () => {
    const buckets = buildForecast({});
    expect(buckets).toHaveLength(FORECAST_WINDOW + 1);
  });

  test("deterministic across calls", () => {
    const deck = { a: p({ interval: 3 }), b: p({ isDue: true }) };
    expect(buildForecast(deck, 7)).toEqual(buildForecast(deck, 7));
  });
});
