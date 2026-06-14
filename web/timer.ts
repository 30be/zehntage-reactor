// Pure helpers for the immersion timer (G4) — focused watch time this session
// and progress toward a daily minutes goal. Mirrors web/goal.ts: pure math kept
// DOM-free for trivial bun-testing (tests/timer.test.ts), plus thin
// localStorage load/save wrappers (the only impure part, untested core).

export const MINUTES_GOAL_KEY = "zr.goal.minutesPerDay";
export const DEFAULT_MINUTES_GOAL = 30;
export const MINUTES_GOAL_MIN = 1;
export const MINUTES_GOAL_MAX = 600;

/**
 * Format an elapsed duration (in seconds) compactly:
 *   <1 min      → "m:ss" (e.g. 0:00, 0:42)
 *   <1 hour     → "mm:ss" (e.g. 23:05)
 *   >=1 hour    → "h:mm:ss" (e.g. 1:02:09)
 * Negative / NaN inputs floor at 0.
 */
export function formatElapsed(seconds: number): string {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${ss}`;
  return `${m}:${ss}`;
}

/** Fraction of the minutes goal reached, clamped to [0, 1]. goal<=0 → 1. */
export function minutesFraction(minutes: number, goal: number): number {
  if (!(goal > 0)) return 1; // no/zero goal: already satisfied
  const f = minutes / goal;
  if (!(f > 0)) return 0; // negative / NaN → 0
  return f > 1 ? 1 : f;
}

/** Has today's watched minutes reached the goal? goal<=0 counts as met. */
export function minutesGoalMet(minutes: number, goal: number): boolean {
  return minutesFraction(minutes, goal) >= 1;
}

/** Clamp a user-entered minutes goal into range, snapped to an integer. */
export function clampMinutesGoal(goal: number): number {
  if (!Number.isFinite(goal)) return DEFAULT_MINUTES_GOAL;
  const n = Math.round(goal);
  if (n < MINUTES_GOAL_MIN) return MINUTES_GOAL_MIN;
  if (n > MINUTES_GOAL_MAX) return MINUTES_GOAL_MAX;
  return n;
}

/** Load the daily minutes goal from localStorage (clamped; default on miss). */
export function loadMinutesGoal(): number {
  try {
    const raw = localStorage.getItem(MINUTES_GOAL_KEY);
    if (raw == null) return DEFAULT_MINUTES_GOAL;
    return clampMinutesGoal(Number(raw));
  } catch {
    return DEFAULT_MINUTES_GOAL;
  }
}

/** Persist the daily minutes goal to localStorage. */
export function saveMinutesGoal(goal: number): void {
  try {
    localStorage.setItem(MINUTES_GOAL_KEY, String(goal));
  } catch {
    /* ignore quota / disabled storage */
  }
}
