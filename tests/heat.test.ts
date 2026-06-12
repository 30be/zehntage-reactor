import { describe, expect, test } from "bun:test";
import { heatBins, heatAlpha, heatStyle } from "../web/heat.ts";

const cue = (start: number, end: number, text = "x") => ({ start, end, text });

describe("heatBins", () => {
  test("empty/invalid input", () => {
    expect(heatBins([], [], 10, 0)).toEqual([]);
    expect(heatBins([], [], 0, 100)).toEqual([]);
    const bins = heatBins([], [], 10, 30);
    expect(bins.length).toBe(3);
    expect(bins.every((b) => b.density === 0 && b.unknownRatio === 0)).toBe(true);
  });

  test("bin count = ceil(duration / binSeconds)", () => {
    expect(heatBins([], [], 10, 95).length).toBe(10);
  });

  test("full-bin cue -> density 1", () => {
    const bins = heatBins([cue(0, 10)], [0], 10, 20);
    expect(bins[0]!.density).toBe(1);
    expect(bins[1]!.density).toBe(0);
  });

  test("cue straddling bins splits density and unknowns proportionally", () => {
    // 8..12 over 10s bins: 2s in bin0, 2s in bin1; 2 unknowns split 1/1
    const bins = heatBins([cue(8, 12)], [2], 10, 20);
    expect(bins[0]!.density).toBeCloseTo(0.2);
    expect(bins[1]!.density).toBeCloseTo(0.2);
    expect(bins[0]!.unknownRatio).toBeCloseTo(bins[1]!.unknownRatio);
  });

  test("unknownRatio saturates at 3 unknowns per cue", () => {
    const low = heatBins([cue(0, 5)], [1], 10, 10)[0]!;
    const sat = heatBins([cue(0, 5)], [9], 10, 10)[0]!;
    expect(low.unknownRatio).toBeCloseTo(1 / 3);
    expect(sat.unknownRatio).toBe(1);
  });

  test("cues past duration are clamped, not crashing", () => {
    const bins = heatBins([cue(95, 200)], [1], 10, 100);
    expect(bins.length).toBe(10);
    expect(bins[9]!.density).toBeCloseTo(0.5);
  });
});

describe("heat colors", () => {
  test("alpha = 0.15 + 0.5*ratio when speech present", () => {
    expect(heatAlpha({ density: 0.5, unknownRatio: 0 })).toBeCloseTo(0.15);
    expect(heatAlpha({ density: 0.5, unknownRatio: 1 })).toBeCloseTo(0.65);
  });

  test("silent bin -> transparent", () => {
    expect(heatAlpha({ density: 0, unknownRatio: 1 })).toBe(0);
    expect(heatStyle({ density: 0, unknownRatio: 1 }).background).toBe("transparent");
  });

  test("style emits rgba white", () => {
    expect(heatStyle({ density: 1, unknownRatio: 0 }).background).toBe(
      "rgba(255,255,255,0.150)",
    );
  });
});
