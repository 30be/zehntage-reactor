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
