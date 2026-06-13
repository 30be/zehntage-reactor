import { describe, expect, test } from "bun:test";
import type { EntryIndex, LemmaInfo, CueRef } from "../src/lib/tokenindex.ts";
import { showFrequency } from "../src/lib/mining.ts";

// Build a synthetic EntryIndex from cue "sentences" given as lemma arrays.
function makeIndex(mediaId: string, cueLemmas: string[][]): EntryIndex {
  const lemmas = new Map<string, LemmaInfo>();
  let totalLexical = 0;
  cueLemmas.forEach((ls, idx) => {
    const text = ls.join("");
    const ref: CueRef = { idx, start: idx * 5, text };
    const seen = new Set<string>();
    for (const l of ls) {
      totalLexical++;
      let info = lemmas.get(l);
      if (!info) lemmas.set(l, (info = { count: 0, cues: [] }));
      info.count++;
      if (!seen.has(l)) {
        info.cues.push(ref);
        seen.add(l);
      }
    }
  });
  return { mediaId, lemmas, totalLexical };
}

const ep1 = makeIndex("ep1", [
  ["猫", "が", "好き"],
  ["犬", "と", "猫"],
  ["氷菓", "面白い", "猫", "謎"],
]);
const ep2 = makeIndex("ep2", [
  ["猫", "好き"],
  ["謎", "解く"],
]);

describe("showFrequency", () => {
  test("sums counts across entries", () => {
    const f = showFrequency([ep1, ep2]);
    expect(f.get("猫")).toBe(4);
    expect(f.get("謎")).toBe(2);
    expect(f.get("解く")).toBe(1);
    expect(f.get("nope")).toBeUndefined();
  });
});
