// Pure goal math for the Home "Today" daily-goal ring (F3). No DOM, no React —
// kept isolated so it's trivially bun-testable (tests/goal.test.ts).

export const GOAL_KEY = "zr.goal.cardsPerDay";
export const DEFAULT_GOAL = 10;
export const GOAL_MIN = 1;
export const GOAL_MAX = 100;

/** Fraction of the goal reached, clamped to [0, 1]. goal<=0 → 1 (nothing to do). */
export function goalFraction(value: number, goal: number): number {
  if (!(goal > 0)) return 1; // no/zero goal: treat as already satisfied
  const f = value / goal;
  if (!(f > 0)) return 0; // negative / NaN → 0
  return f > 1 ? 1 : f;
}

/** Has today's count reached the goal? goal<=0 counts as met. */
export function goalMet(value: number, goal: number): boolean {
  return goalFraction(value, goal) >= 1;
}

/**
 * stroke-dashoffset for an SVG ring of the given circumference. Full ring at
 * fraction 0 (offset = circumference), empty offset at fraction 1. Monotonic
 * decreasing in `value`.
 */
export function ringDashoffset(
  value: number,
  goal: number,
  circumference: number,
): number {
  return circumference * (1 - goalFraction(value, goal));
}

/** Clamp a user-entered goal into the allowed range, snapped to an integer. */
export function clampGoal(goal: number): number {
  if (!Number.isFinite(goal)) return DEFAULT_GOAL;
  const n = Math.round(goal);
  if (n < GOAL_MIN) return GOAL_MIN;
  if (n > GOAL_MAX) return GOAL_MAX;
  return n;
}
