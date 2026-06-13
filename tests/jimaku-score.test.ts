// Focused unit tests for scoreJimakuCandidate ranking logic.
// Supplements the brief coverage in jimaku.test.ts.
// Pure, no network.

import { describe, expect, test } from "bun:test";
import { scoreJimakuCandidate, rankJimakuCandidates } from "../src/lib/jimaku.ts";

describe("scoreJimakuCandidate — format bonus", () => {
  test(".srt scores higher than .ass (format bonus)", () => {
    expect(scoreJimakuCandidate("Hyouka.srt")).toBeGreaterThan(
      scoreJimakuCandidate("Hyouka.ass"),
    );
  });

  test(".vtt scores higher than .ass", () => {
    expect(scoreJimakuCandidate("Hyouka.vtt")).toBeGreaterThan(
      scoreJimakuCandidate("Hyouka.ssa"),
    );
  });

  test(".srt and .vtt score equally (both text formats)", () => {
    expect(scoreJimakuCandidate("ep.srt")).toBe(scoreJimakuCandidate("ep.vtt"));
  });

  test(".ass and .ssa score equally (both styled formats)", () => {
    expect(scoreJimakuCandidate("ep.ass")).toBe(scoreJimakuCandidate("ep.ssa"));
  });
});

describe("scoreJimakuCandidate — language hints", () => {
  test("JA hint (.ja.srt) boosts score above no-hint", () => {
    expect(scoreJimakuCandidate("ep.ja.srt")).toBeGreaterThan(scoreJimakuCandidate("ep.srt"));
  });

  test("[jp] hint boosts score", () => {
    expect(scoreJimakuCandidate("Hyouka [jp].ass")).toBeGreaterThan(
      scoreJimakuCandidate("Hyouka.ass"),
    );
  });

  test("[jpn] hint boosts score", () => {
    expect(scoreJimakuCandidate("ep.jpn.srt")).toBeGreaterThan(scoreJimakuCandidate("ep.srt"));
  });

  test("CN hint (.chs) gives negative score (penalty dominates any format bonus)", () => {
    expect(scoreJimakuCandidate("ep.chs.srt")).toBeLessThan(0);
  });

  test("CN hint (.cht) is penalized", () => {
    expect(scoreJimakuCandidate("ep.cht.srt")).toBeLessThan(0);
  });

  test("CN hint (.zh) is penalized", () => {
    expect(scoreJimakuCandidate("ep.zh.ass")).toBeLessThan(0);
  });

  test("Chinese fansub group name (星空) is penalized", () => {
    expect(scoreJimakuCandidate("星空字幕组 Hyouka 01.ass")).toBeLessThan(0);
  });

  test("xksub is penalized", () => {
    expect(scoreJimakuCandidate("[XKsub] Hyouka 01.ass")).toBeLessThan(0);
  });

  test("JA hint always beats CN hint (JA .ass > CN .srt)", () => {
    expect(scoreJimakuCandidate("Hyouka.ja.ass")).toBeGreaterThan(
      scoreJimakuCandidate("Hyouka.chs.srt"),
    );
  });

  test("no hint, unknown extension → score 0 (no format match)", () => {
    expect(scoreJimakuCandidate("ep.txt")).toBe(0);
  });
});

describe("rankJimakuCandidates — ordering edge cases", () => {
  const f = (name: string) => ({ name });

  test("JA .ass outranks CN .srt", () => {
    const files = [f("ep.zh.srt"), f("ep.ja.ass")];
    expect(rankJimakuCandidates(files)[0]!.name).toBe("ep.ja.ass");
  });

  test("empty list returns empty list", () => {
    expect(rankJimakuCandidates([])).toEqual([]);
  });

  test("only non-sub files → all dropped", () => {
    const files = [f("notes.txt"), f("cover.jpg"), f("README.md")];
    expect(rankJimakuCandidates(files)).toEqual([]);
  });

  test("mixed valid and invalid: only valid survive, in score order", () => {
    const files = [f("notes.txt"), f("ep.chs.srt"), f("ep.ja.srt")];
    const result = rankJimakuCandidates(files).map((x) => x.name);
    expect(result).toEqual(["ep.ja.srt", "ep.chs.srt"]);
  });

  test("multiple JA files keep server order (stable sort on equal scores)", () => {
    const files = [f("first.ja.srt"), f("second.ja.srt")];
    expect(rankJimakuCandidates(files).map((x) => x.name)).toEqual([
      "first.ja.srt",
      "second.ja.srt",
    ]);
  });
});
