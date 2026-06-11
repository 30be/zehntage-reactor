// Headless unit test (no Chrome) for the progress maturity gradient.
// Run: bun test scripts/progress.test.ts
import { expect, test } from "bun:test";
import {
  PROGRESS_COLORS,
  progressBucket,
  progressColor,
} from "../web/progress.ts";
import type { ProgressEntry } from "../web/api.ts";

function entry(interval: number): ProgressEntry {
  return {
    interval,
    due: 0,
    reps: 0,
    lapses: 0,
    ease: 2500,
    queue: 2,
    type: 2,
  };
}

test("interval buckets map to the 6 discrete steps", () => {
  expect(progressBucket(0)).toBe(0); // brand new / 0 interval -> red
  expect(progressBucket(0.5)).toBe(0); // < 1 day -> red
  expect(progressBucket(1)).toBe(1); // 1 day -> orange
  expect(progressBucket(3)).toBe(1); // < 4 -> orange
  expect(progressBucket(4)).toBe(2); // 4 -> yellow
  expect(progressBucket(10)).toBe(2); // < 11 -> yellow
  expect(progressBucket(11)).toBe(3); // 11 -> green
  expect(progressBucket(29)).toBe(3); // < 30 -> green
  expect(progressBucket(30)).toBe(4); // 30 -> cyan
  expect(progressBucket(89)).toBe(4); // < 90 -> cyan
  expect(progressBucket(90)).toBe(5); // 90 -> blue (mature)
  expect(progressBucket(1000)).toBe(5);
});

test("negative / NaN intervals clamp to step 0", () => {
  expect(progressBucket(-5)).toBe(0);
  expect(progressBucket(NaN)).toBe(0);
});

test("progressColor returns the matching step color", () => {
  expect(progressColor(undefined)).toBe(PROGRESS_COLORS[0]); // no SRS data -> red
  expect(progressColor(entry(0))).toBe(PROGRESS_COLORS[0]); // 0 interval -> red
  expect(progressColor(entry(2))).toBe(PROGRESS_COLORS[1]); // orange
  expect(progressColor(entry(15))).toBe(PROGRESS_COLORS[3]); // green
  expect(progressColor(entry(120))).toBe(PROGRESS_COLORS[5]); // blue
});

test("RED is step 0 and BLUE is step 5", () => {
  expect(PROGRESS_COLORS[0]).toBe("#ef4444");
  expect(PROGRESS_COLORS[5]).toBe("#3b82f6");
  expect(PROGRESS_COLORS).toHaveLength(6);
});
