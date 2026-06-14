import { expect, test } from "bun:test";
import {
  clampGoal,
  DEFAULT_GOAL,
  goalFraction,
  goalMet,
  ringDashoffset,
} from "../web/goal.ts";

const C = 100; // circumference for dashoffset tests

test("goalFraction: zero / partial / met / over-goal", () => {
  expect(goalFraction(0, 10)).toBe(0);
  expect(goalFraction(3, 10)).toBeCloseTo(0.3);
  expect(goalFraction(10, 10)).toBe(1);
  expect(goalFraction(25, 10)).toBe(1); // clamped at 100%
});

test("goalFraction: goal<=0 is satisfied, negative value floors at 0", () => {
  expect(goalFraction(5, 0)).toBe(1);
  expect(goalFraction(5, -3)).toBe(1);
  expect(goalFraction(-2, 10)).toBe(0);
});

test("goalMet matches the fraction", () => {
  expect(goalMet(9, 10)).toBe(false);
  expect(goalMet(10, 10)).toBe(true);
  expect(goalMet(11, 10)).toBe(true);
  expect(goalMet(0, 0)).toBe(true); // no goal → met
});

test("ringDashoffset: full at 0, empty at met, monotonic decreasing", () => {
  expect(ringDashoffset(0, 10, C)).toBe(C);
  expect(ringDashoffset(10, 10, C)).toBe(0);
  expect(ringDashoffset(20, 10, C)).toBe(0); // clamped, never negative
  const a = ringDashoffset(2, 10, C);
  const b = ringDashoffset(5, 10, C);
  const c = ringDashoffset(8, 10, C);
  expect(a).toBeGreaterThan(b);
  expect(b).toBeGreaterThan(c);
});

test("ringDashoffset: goal=0 yields empty (filled) ring, no NaN", () => {
  const off = ringDashoffset(0, 0, C);
  expect(Number.isNaN(off)).toBe(false);
  expect(off).toBe(0);
});

test("clampGoal: range, rounding, garbage", () => {
  expect(clampGoal(10)).toBe(10);
  expect(clampGoal(0)).toBe(1); // GOAL_MIN
  expect(clampGoal(999)).toBe(100); // GOAL_MAX
  expect(clampGoal(7.6)).toBe(8); // rounded
  expect(clampGoal(NaN)).toBe(DEFAULT_GOAL);
  expect(clampGoal(Infinity)).toBe(DEFAULT_GOAL);
});
