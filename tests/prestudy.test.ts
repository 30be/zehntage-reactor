import { describe, expect, test } from "bun:test";
import { rankPreStudy, MUDDY_UNKNOWNS } from "../web/prestudy.ts";

const item = (lemma: string, checked = true) => ({ lemma, checked });

describe("rankPreStudy", () => {
  test("promotes i+1 candidates to the top (stable within groups)", () => {
    const items = [item("a"), item("b"), item("c")];
    // "c" is the only unknown in one cue; a/b share a 2-unknown cue
    const cues = [["a", "b"], ["c"]];
    const out = rankPreStudy(items, cues);
    expect(out.map((x) => x.lemma)).toEqual(["c", "a", "b"]);
    expect(out[0]!.iPlusOne).toBe(true);
    expect(out[1]!.iPlusOne).toBe(false);
  });

  test("demotes and unchecks muddy items (every cue >= MUDDY_UNKNOWNS)", () => {
    expect(MUDDY_UNKNOWNS).toBe(3);
    const items = ["a", "b", "c", "d", "e", "f", "g"].map((l) => item(l));
    // "g" only appears in a 3-unknown cue → muddy; others in clean-ish cues
    const cues = [
      ["g", "x", "y"],
      ["a", "b"],
      ["c"],
      ["d", "e"],
      ["f"],
    ];
    const out = rankPreStudy(items, cues);
    const g = out.find((x) => x.lemma === "g")!;
    expect(g.muddy).toBe(true);
    expect(out[out.length - 1]!.lemma).toBe("g");
    expect(g.checked).toBe(false); // demoted past the top-5 → unchecked
  });

  test("a muddy item inside the overall top 5 stays checked", () => {
    const items = [item("a"), item("b")];
    const cues = [
      ["a", "x", "y"],
      ["b", "x", "y"],
    ];
    const out = rankPreStudy(items, cues);
    // both muddy, but both within the top 5 — keep checked
    expect(out.every((x) => x.muddy)).toBe(true);
    expect(out.every((x) => x.checked)).toBe(true);
  });

  test("an i+1 occurrence overrides muddiness", () => {
    const items = [item("a")];
    const cues = [["a", "x", "y"], ["a"]];
    const out = rankPreStudy(items, cues);
    expect(out[0]!.iPlusOne).toBe(true);
    expect(out[0]!.muddy).toBe(false);
  });

  test("items absent from every cue are neither i+1 nor muddy", () => {
    const out = rankPreStudy([item("z")], [["a", "b", "c"]]);
    expect(out[0]!.iPlusOne).toBe(false);
    expect(out[0]!.muddy).toBe(false);
    expect(out[0]!.checked).toBe(true);
  });
});
