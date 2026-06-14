import { describe, expect, it } from "bun:test";
import { activeCueIndex, contextAround } from "../web/cues.ts";
import type { Cue } from "../web/api.ts";

function makeCue(start: number, end: number, text = ""): Cue {
  return { start, end, text };
}

// Cue array used across activeCueIndex tests:
// [0] 1.0–2.0, [1] 3.0–4.0, [2] 5.0–6.0
const CUES: Cue[] = [
  makeCue(1.0, 2.0, "first"),
  makeCue(3.0, 4.0, "second"),
  makeCue(5.0, 6.0, "third"),
];

describe("activeCueIndex", () => {
  it("returns -1 for empty cue list", () => {
    expect(activeCueIndex([], 1.5)).toBe(-1);
  });

  it("returns -1 when t is before the first cue", () => {
    expect(activeCueIndex(CUES, 0.5)).toBe(-1);
  });

  it("returns -1 when t is after the last cue", () => {
    expect(activeCueIndex(CUES, 7.0)).toBe(-1);
  });

  it("returns -1 when t falls in a gap between cues", () => {
    // gap between cue[0] (end=2.0) and cue[1] (start=3.0)
    expect(activeCueIndex(CUES, 2.5)).toBe(-1);
  });

  it("returns correct index when t is exactly at cue start boundary", () => {
    expect(activeCueIndex(CUES, 1.0)).toBe(0);
    expect(activeCueIndex(CUES, 3.0)).toBe(1);
    expect(activeCueIndex(CUES, 5.0)).toBe(2);
  });

  it("returns correct index when t is exactly at cue end boundary", () => {
    expect(activeCueIndex(CUES, 2.0)).toBe(0);
    expect(activeCueIndex(CUES, 4.0)).toBe(1);
    expect(activeCueIndex(CUES, 6.0)).toBe(2);
  });

  it("returns correct index when t is in the middle of a cue", () => {
    expect(activeCueIndex(CUES, 1.5)).toBe(0);
    expect(activeCueIndex(CUES, 3.7)).toBe(1);
    expect(activeCueIndex(CUES, 5.9)).toBe(2);
  });

  it("works with a single-cue list", () => {
    const single = [makeCue(10, 20, "only")];
    expect(activeCueIndex(single, 5)).toBe(-1);
    expect(activeCueIndex(single, 10)).toBe(0);
    expect(activeCueIndex(single, 15)).toBe(0);
    expect(activeCueIndex(single, 20)).toBe(0);
    expect(activeCueIndex(single, 21)).toBe(-1);
  });

  it("handles t = 0 before any cue starting at 0", () => {
    const cues = [makeCue(0, 1, "zero")];
    expect(activeCueIndex(cues, 0)).toBe(0);
  });
});

describe("contextAround", () => {
  const cues: Cue[] = [
    makeCue(0, 1, "alpha"),
    makeCue(1, 2, "beta"),
    makeCue(2, 3, "gamma"),
  ];

  it("returns empty string for i = -1", () => {
    expect(contextAround(cues, -1)).toBe("");
  });

  it("returns text of first cue plus next when i = 0 (no prev)", () => {
    expect(contextAround(cues, 0)).toBe("alpha beta");
  });

  it("returns prev + current + next for middle cue", () => {
    expect(contextAround(cues, 1)).toBe("alpha beta gamma");
  });

  it("returns prev + text of last cue (no next) when i = last", () => {
    expect(contextAround(cues, 2)).toBe("beta gamma");
  });

  it("returns just the single cue text when list has one element", () => {
    const one = [makeCue(0, 1, "solo")];
    expect(contextAround(one, 0)).toBe("solo");
  });

  it("returns empty string for large negative index", () => {
    expect(contextAround(cues, -5)).toBe("");
  });
});

describe("activeCueIndex — overlapping / nested cues (defensive hardening)", () => {
  // Semantics: "active" = a cue with start <= t <= end (end inclusive). When
  // several cues contain t, the LATEST-starting one wins. For the normal
  // non-overlapping case this is identical to the prior binary search.

  it("t in the overlap returns the latest-starting cue that contains t", () => {
    const cues: Cue[] = [makeCue(0, 5), makeCue(3, 8)];
    const i = activeCueIndex(cues, 4);
    expect(i).toBe(1);
    // and it genuinely contains t
    expect(cues[i]!.start).toBeLessThanOrEqual(4);
    expect(cues[i]!.end).toBeGreaterThanOrEqual(4);
  });

  it("t inside only the earlier overlapping cue", () => {
    const cues: Cue[] = [makeCue(0, 5), makeCue(3, 8)];
    expect(activeCueIndex(cues, 1)).toBe(0);
  });

  it("t inside only the later overlapping cue", () => {
    const cues: Cue[] = [makeCue(0, 5), makeCue(3, 8)];
    expect(activeCueIndex(cues, 7)).toBe(1);
  });

  it("later cue starts before t but ends before t → falls back to container", () => {
    // cue[1] is a short cue nested inside cue[0]'s span; t is outside cue[1].
    const cues: Cue[] = [makeCue(0, 100), makeCue(10, 20)];
    expect(activeCueIndex(cues, 50)).toBe(0);
  });

  it("adjacent cues sharing a boundary → latest-starting wins", () => {
    const cues: Cue[] = [makeCue(0, 2), makeCue(2, 4)];
    expect(activeCueIndex(cues, 2)).toBe(1);
    expect(activeCueIndex(cues, 1)).toBe(0);
    expect(activeCueIndex(cues, 3)).toBe(1);
  });

  it("nested cues: innermost containing cue wins", () => {
    const cues: Cue[] = [makeCue(0, 100), makeCue(10, 90), makeCue(40, 60)];
    expect(activeCueIndex(cues, 50)).toBe(2); // innermost
    expect(activeCueIndex(cues, 30)).toBe(1); // middle, not innermost
    expect(activeCueIndex(cues, 5)).toBe(0); // outermost only
    expect(activeCueIndex(cues, 70)).toBe(1); // past innermost end
    expect(activeCueIndex(cues, 100)).toBe(0); // outer end boundary
  });

  it("gap after overlapping cluster still returns -1", () => {
    const cues: Cue[] = [makeCue(0, 5), makeCue(3, 8), makeCue(20, 25)];
    expect(activeCueIndex(cues, 12)).toBe(-1);
  });
});
