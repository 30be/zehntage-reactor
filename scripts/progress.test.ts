// Headless unit test (no Chrome) for the progress maturity gradient.
// Run: bun test scripts/progress.test.ts
import { expect, test } from "bun:test";
import {
  learningColor,
  LEARNING_MATURE_DAYS,
  progressBucket,
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

test("learningColor fades blue -> ambient, null at maturity", () => {
  // no SRS data -> fresh blue (full --learn-blue mix)
  const fresh = learningColor(undefined);
  expect(fresh).toContain("var(--learn-blue");
  expect(fresh).toContain("100%");

  // mid-learning -> a non-null color-mix that still references --learn-blue
  const mid = learningColor(entry(10));
  expect(mid).not.toBeNull();
  expect(mid).toContain("color-mix");
  expect(mid).toContain("var(--learn-blue");

  // a smaller interval keeps MORE blue than a larger one
  expect(learningColor(entry(1))).toContain("95%");

  // at/after maturity -> null (render plain ambient text)
  expect(learningColor(entry(LEARNING_MATURE_DAYS))).toBeNull();
  expect(learningColor(entry(120))).toBeNull();
});
