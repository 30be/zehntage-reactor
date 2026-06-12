// Wave 11: learning-word text color (blue -> ambient via OKLCH color-mix).

import { describe, expect, test } from "bun:test";
import {
  learningColor,
  LEARNING_BLUE,
  LEARNING_MATURE_DAYS,
} from "../web/progress.ts";

describe("learningColor", () => {
  test("no progress entry (remote path without intervals) = fresh full blue", () => {
    expect(learningColor(undefined)).toBe(
      `color-mix(in oklch, ${LEARNING_BLUE} 100%, var(--tok-ambient, currentColor))`,
    );
  });

  test("interval 0 = fresh full blue", () => {
    expect(learningColor({ interval: 0 } as never)).toContain(`${LEARNING_BLUE} 100%`);
  });

  test("mid interval mixes toward ambient", () => {
    const c = learningColor({ interval: 7 } as never)!;
    const pct = Number(c.match(/ (\d+)%/)![1]);
    expect(pct).toBeGreaterThan(0);
    expect(pct).toBeLessThan(100);
    expect(c).toContain("var(--tok-ambient");
  });

  test("monotonic: longer interval -> less blue", () => {
    const pct = (d: number) =>
      Number(learningColor({ interval: d } as never)!.match(/ (\d+)%/)![1]);
    expect(pct(1)).toBeGreaterThan(pct(10));
    expect(pct(10)).toBeGreaterThan(pct(20));
  });

  test("mature (>= 21d) renders ambient (null), negative clamps to fresh", () => {
    expect(learningColor({ interval: LEARNING_MATURE_DAYS } as never)).toBeNull();
    expect(learningColor({ interval: 365 } as never)).toBeNull();
    expect(learningColor({ interval: -3 } as never)).toContain("100%");
  });
});
