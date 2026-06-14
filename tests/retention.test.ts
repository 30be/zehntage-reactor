// F7 retention-decay coloring: overdue deck words drift toward unknown-red.
//
// Signal: ProgressEntry.isDue gates whether a word rots; ProgressEntry
// .daysOverdue (decoded server-side from last-review + interval vs now)
// modulates HOW MUCH — the longer past due, the louder the "you're forgetting
// this" signal. interval is the legacy fallback magnitude when daysOverdue is
// absent (remote anki-mcp path). decayFactor() is pure; learningColor()
// applies it.

import { describe, expect, test } from "bun:test";
import {
  learningColor,
  decayFactor,
  MAX_DECAY,
  DECAY_FULL_DAYS,
  LEARNING_BLUE,
  UNKNOWN_RED,
} from "../web/progress.ts";
import { decodeDaysOverdue } from "../src/lib/anki.ts";

// interval here doubles as the daysOverdue signal (they coincide once a card
// has sat exactly `interval` days past its last review) AND, by symmetry, as
// the legacy interval-fallback magnitude — so existing magnitude assertions
// hold under the new daysOverdue-driven ramp.
const P = (interval: number, isDue?: boolean, daysOverdue?: number) =>
  ({ interval, isDue, daysOverdue: daysOverdue ?? interval }) as never;

// fraction of unknown-red mixed in, parsed out of the outer color-mix
function redPct(color: string | null): number {
  if (!color) return 0;
  const m = color.match(/var\(--tok-unk[^)]*\) (\d+)%/);
  return m ? Number(m[1]) : 0;
}

describe("decayFactor", () => {
  test("no entry never decays", () => {
    expect(decayFactor(undefined)).toBe(0);
  });

  test("non-overdue (isDue absent) never decays", () => {
    expect(decayFactor(P(5))).toBe(0);
    expect(decayFactor(P(50))).toBe(0);
  });

  test("non-overdue (isDue === false) never decays", () => {
    expect(decayFactor(P(10, false))).toBe(0);
  });

  test("overdue decays, scaling with interval", () => {
    const small = decayFactor(P(2, true));
    const big = decayFactor(P(14, true));
    expect(small).toBeGreaterThan(0);
    expect(big).toBeGreaterThan(small);
  });

  test("clamps at MAX_DECAY for very mature overdue cards", () => {
    expect(decayFactor(P(DECAY_FULL_DAYS, true))).toBeCloseTo(MAX_DECAY, 6);
    expect(decayFactor(P(DECAY_FULL_DAYS * 10, true))).toBeCloseTo(MAX_DECAY, 6);
  });

  test("a freshly-due card (0 days overdue) has ~no decay", () => {
    expect(decayFactor(P(0, true))).toBe(0);
  });

  test("ramps with daysOverdue independent of interval", () => {
    // same interval, different days-overdue -> the more-overdue rots harder
    const fresh = decayFactor({ interval: 50, isDue: true, daysOverdue: 1 } as never);
    const stale = decayFactor({ interval: 50, isDue: true, daysOverdue: 10 } as never);
    expect(stale).toBeGreaterThan(fresh);
  });

  test("daysOverdue at/over DECAY_FULL_DAYS clamps to MAX_DECAY", () => {
    const c = { interval: 3, isDue: true, daysOverdue: DECAY_FULL_DAYS * 4 } as never;
    expect(decayFactor(c)).toBeCloseTo(MAX_DECAY, 6);
  });

  test("falls back to interval when daysOverdue is absent (remote path)", () => {
    const a = decayFactor({ interval: 2, isDue: true } as never);
    const b = decayFactor({ interval: 12, isDue: true } as never);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
  });
});

describe("decodeDaysOverdue", () => {
  const DAY = 86_400_000;
  const now = 1_700_000_000_000; // fixed reference (ms)
  const modSecAgo = (days: number) => (now - days * DAY) / 1000;

  test("non-review queue is never overdue", () => {
    // learn (1)/new (0)/suspended (-1): due column is not interval-based.
    expect(decodeDaysOverdue({ queue: 0, interval: 5, mod: modSecAgo(99) }, now)).toBe(0);
    expect(decodeDaysOverdue({ queue: 1, interval: 5, mod: modSecAgo(99) }, now)).toBe(0);
    expect(decodeDaysOverdue({ queue: -1, interval: 5, mod: modSecAgo(99) }, now)).toBe(0);
  });

  test("review card not yet due -> 0", () => {
    // reviewed 2d ago, interval 10 -> due in 8d, not overdue.
    expect(decodeDaysOverdue({ queue: 2, interval: 10, mod: modSecAgo(2) }, now)).toBe(0);
  });

  test("review card overdue = days past (last review + interval)", () => {
    // reviewed 13d ago, interval 10 -> 3 days overdue.
    expect(decodeDaysOverdue({ queue: 2, interval: 10, mod: modSecAgo(13) }, now)).toBe(3);
  });

  test("defensive: garbage interval/mod -> 0", () => {
    expect(decodeDaysOverdue({ queue: 2, interval: NaN, mod: modSecAgo(99) }, now)).toBe(0);
    expect(decodeDaysOverdue({ queue: 2, interval: 10, mod: 0 }, now)).toBe(0);
    expect(decodeDaysOverdue({ queue: 2, interval: -5, mod: modSecAgo(99) }, now)).toBe(0);
  });

  test("never negative", () => {
    expect(
      decodeDaysOverdue({ queue: 2, interval: 100, mod: modSecAgo(1) }, now),
    ).toBe(0);
  });
});

describe("learningColor retention decay", () => {
  test("non-overdue keeps the plain blue->ambient interpolation (no red)", () => {
    const fresh = learningColor(P(0))!;
    expect(fresh).toContain(`var(--learn-blue, ${LEARNING_BLUE}) 100%`);
    expect(fresh).not.toContain("--tok-unk");

    const mid = learningColor(P(7))!;
    expect(mid).not.toContain("--tok-unk");
  });

  test("mature non-overdue word renders plain (null), unchanged", () => {
    // maturity is now 60d (~2 months); intervals >= 60 render plain
    expect(learningColor(P(60))).toBeNull();
    expect(learningColor(P(90))).toBeNull();
  });

  test("overdue word mixes unknown-red into its base color", () => {
    const c = learningColor(P(10, true))!;
    expect(c).toContain(`var(--tok-unk, ${UNKNOWN_RED})`);
    expect(redPct(c)).toBeGreaterThan(0);
  });

  test("more-overdue (larger interval) = more red", () => {
    const small = redPct(learningColor(P(3, true)));
    const big = redPct(learningColor(P(18, true)));
    expect(big).toBeGreaterThan(small);
  });

  test("red fraction clamps at MAX_DECAY", () => {
    const c = learningColor(P(DECAY_FULL_DAYS * 5, true))!;
    expect(redPct(c)).toBe(Math.round(MAX_DECAY * 100));
  });

  test("a mature overdue word still rots (red on ambient base)", () => {
    // interval >= maturity: base is ambient, but isDue pulls it toward red.
    const c = learningColor(P(40, true))!;
    expect(c).toContain("--tok-unk");
    expect(c).toContain("var(--tok-ambient");
    expect(redPct(c)).toBe(Math.round(MAX_DECAY * 100));
  });

  test("the base color is preserved inside the decayed mix", () => {
    const c = learningColor(P(5, true))!;
    // still carries the blue->ambient base under the red tint
    expect(c).toContain("var(--learn-blue");
    expect(c).toContain("var(--tok-ambient");
  });
});

// Guard: decay is GATED on a real progress entry with isDue. Tokens that are
// known/unknown/blacklisted never reach learningColor() in TokenLine (only
// in-deck tokens call it), so a non-deck token's color is never decayed.
describe("retention decay only affects in-deck learning words", () => {
  test("no progress entry (the shape passed for non-deck paths) = no decay", () => {
    expect(decayFactor(undefined)).toBe(0);
    expect(learningColor(undefined)).not.toContain("--tok-unk");
  });
});
