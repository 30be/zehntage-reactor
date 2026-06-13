import { describe, expect, test } from "bun:test";
import {
  knownBand,
  learningValue,
  rankEpisodes,
  studyNext,
  TARGET_KNOWN,
  KNOWN_SPREAD,
  type EpisodeSignal,
} from "../web/curriculum.ts";

const sig = (id: string, pct: number, i1density: number): EpisodeSignal => ({
  id,
  pct,
  i1density,
});

describe("knownBand", () => {
  test("peaks at the target and tapers to zero at the spread edges", () => {
    expect(knownBand(TARGET_KNOWN)).toBe(1);
    expect(knownBand(TARGET_KNOWN - KNOWN_SPREAD)).toBe(0);
    expect(knownBand(TARGET_KNOWN + KNOWN_SPREAD)).toBeCloseTo(0);
  });
  test("clamps to zero well outside the band", () => {
    expect(knownBand(0)).toBe(0);
    expect(knownBand(10)).toBe(0);
  });
  test("is symmetric around the target", () => {
    expect(knownBand(TARGET_KNOWN - 10)).toBeCloseTo(knownBand(TARGET_KNOWN + 10));
  });
});

describe("learningValue", () => {
  test("zero i+1 density yields zero learning value", () => {
    expect(learningValue(sig("a", TARGET_KNOWN, 0))).toBe(0);
  });
  test("an episode at the target outscores one outside the band, same density", () => {
    const at = learningValue(sig("a", TARGET_KNOWN, 0.3));
    const off = learningValue(sig("b", 30, 0.3));
    expect(at).toBeGreaterThan(off);
  });
  test("higher density outscores lower density within the same band", () => {
    expect(learningValue(sig("a", TARGET_KNOWN, 0.5))).toBeGreaterThan(
      learningValue(sig("b", TARGET_KNOWN, 0.2)),
    );
  });
  test("stays within 0..1", () => {
    expect(learningValue(sig("a", TARGET_KNOWN, 1))).toBeLessThanOrEqual(1);
    expect(learningValue(sig("a", TARGET_KNOWN, 1))).toBeGreaterThan(0);
  });
  test("density just outside the band still has a baseline value (not zeroed)", () => {
    // pct far from target -> band 0, but baseline 0.25 keeps density visible
    expect(learningValue(sig("a", 0, 0.4))).toBeCloseTo(0.4 * 0.25);
  });
});

describe("rankEpisodes", () => {
  test("orders by descending learning value", () => {
    const out = rankEpisodes([
      sig("easy", 99, 0.1), // nearly known, low density
      sig("sweet", TARGET_KNOWN, 0.5), // sweet spot, high density
      sig("hard", 20, 0.5), // too hard despite density
    ]);
    expect(out[0]!.id).toBe("sweet");
    expect(out.map((e) => e.score)).toEqual([...out.map((e) => e.score)].sort((a, b) => b - a));
  });
  test("breaks ties deterministically by id", () => {
    const out = rankEpisodes([
      sig("b", TARGET_KNOWN, 0.3),
      sig("a", TARGET_KNOWN, 0.3),
    ]);
    expect(out.map((e) => e.id)).toEqual(["a", "b"]);
  });
  test("empty input yields empty output", () => {
    expect(rankEpisodes([])).toEqual([]);
  });
});

describe("studyNext", () => {
  test("returns the top episode id when one has positive value", () => {
    expect(
      studyNext([sig("a", 99, 0.05), sig("b", TARGET_KNOWN, 0.6)]),
    ).toBe("b");
  });
  test("returns null when every candidate scores zero", () => {
    expect(studyNext([sig("a", TARGET_KNOWN, 0), sig("b", 100, 0)])).toBeNull();
  });
  test("returns null on empty input", () => {
    expect(studyNext([])).toBeNull();
  });
});
