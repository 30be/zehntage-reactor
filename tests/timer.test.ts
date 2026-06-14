import { expect, test } from "bun:test";
import {
  clampMinutesGoal,
  DEFAULT_MINUTES_GOAL,
  formatElapsed,
  minutesFraction,
  minutesGoalMet,
} from "../web/timer.ts";

test("formatElapsed: zero, sub-minute, minutes, hours", () => {
  expect(formatElapsed(0)).toBe("0:00");
  expect(formatElapsed(42)).toBe("0:42");
  expect(formatElapsed(65)).toBe("1:05");
  expect(formatElapsed(23 * 60 + 5)).toBe("23:05");
  expect(formatElapsed(3600)).toBe("1:00:00");
  expect(formatElapsed(3600 + 2 * 60 + 9)).toBe("1:02:09");
});

test("formatElapsed: negative / NaN floor at 0, fractional floors", () => {
  expect(formatElapsed(-10)).toBe("0:00");
  expect(formatElapsed(NaN)).toBe("0:00");
  expect(formatElapsed(59.9)).toBe("0:59");
});

test("minutesFraction: zero / partial / met / over → clamp", () => {
  expect(minutesFraction(0, 30)).toBe(0);
  expect(minutesFraction(15, 30)).toBeCloseTo(0.5);
  expect(minutesFraction(30, 30)).toBe(1);
  expect(minutesFraction(45, 30)).toBe(1); // clamped at 100%
});

test("minutesFraction: goal<=0 satisfied, negative value floors at 0", () => {
  expect(minutesFraction(10, 0)).toBe(1);
  expect(minutesFraction(10, -5)).toBe(1);
  expect(minutesFraction(-2, 30)).toBe(0);
});

test("minutesGoalMet matches the fraction", () => {
  expect(minutesGoalMet(29, 30)).toBe(false);
  expect(minutesGoalMet(30, 30)).toBe(true);
  expect(minutesGoalMet(31, 30)).toBe(true);
  expect(minutesGoalMet(0, 0)).toBe(true); // no goal → met
});

test("clampMinutesGoal: range, rounding, garbage", () => {
  expect(clampMinutesGoal(30)).toBe(30);
  expect(clampMinutesGoal(0)).toBe(1); // MIN
  expect(clampMinutesGoal(9999)).toBe(600); // MAX
  expect(clampMinutesGoal(7.6)).toBe(8); // rounded
  expect(clampMinutesGoal(NaN)).toBe(DEFAULT_MINUTES_GOAL);
  expect(clampMinutesGoal(Infinity)).toBe(DEFAULT_MINUTES_GOAL);
});
