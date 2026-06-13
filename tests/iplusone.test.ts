import { describe, expect, test } from "bun:test";
import { iPlusOneIndices, nextIPlusOne } from "../web/iplusone.ts";

describe("iPlusOneIndices", () => {
  test("returns cues with exactly one unknown", () => {
    expect(iPlusOneIndices([0, 1, 2, 1, 3])).toEqual([1, 3]);
  });
  test("empty when none qualify", () => {
    expect(iPlusOneIndices([0, 2, 3])).toEqual([]);
  });
  test("null counts → empty", () => {
    expect(iPlusOneIndices(null)).toEqual([]);
  });
});

describe("nextIPlusOne", () => {
  const counts = [2, 1, 0, 1, 3]; // i+1 at indices 1 and 3
  test("finds the next i+1 after the current cue", () => {
    expect(nextIPlusOne(counts, -1)).toBe(1);
    expect(nextIPlusOne(counts, 0)).toBe(1);
    expect(nextIPlusOne(counts, 1)).toBe(3);
  });
  test("wraps to the first when past the last", () => {
    expect(nextIPlusOne(counts, 3)).toBe(1);
    expect(nextIPlusOne(counts, 99)).toBe(1);
  });
  test("null when no i+1 cues exist", () => {
    expect(nextIPlusOne([0, 2, 3], 0)).toBe(null);
    expect(nextIPlusOne(null, 0)).toBe(null);
  });
});
