// F7 retention-decay coloring: overdue deck words drift toward unknown-red.
//
// Signal: ProgressEntry.isDue (the only reliable overdue flag client-side —
// the server leaves Anki's `due` column undecoded). interval modulates HOW
// MUCH a due word rots (a mature card going overdue is the loudest "you're
// forgetting this" signal). decayFactor() is pure; learningColor() applies it.

import { describe, expect, test } from "bun:test";
import {
  learningColor,
  decayFactor,
  MAX_DECAY,
  DECAY_FULL_DAYS,
  LEARNING_BLUE,
  UNKNOWN_RED,
} from "../web/progress.ts";

const P = (interval: number, isDue?: boolean) =>
  ({ interval, isDue }) as never;

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

  test("a freshly-due card (interval 0) has ~no decay", () => {
    expect(decayFactor(P(0, true))).toBe(0);
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
    expect(learningColor(P(30))).toBeNull();
    expect(learningColor(P(21))).toBeNull();
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
