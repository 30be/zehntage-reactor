import { describe, expect, test } from "bun:test";
import type { EntryIndex, LemmaInfo, CueRef } from "../src/lib/tokenindex.ts";
import {
  showFrequency,
  prestudyRank,
  prestudyOrder,
  iPlusOne,
  parseBlacklist,
  filterCounts,
} from "../src/lib/mining.ts";

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

describe("prestudyRank / prestudyOrder", () => {
  const show = new Map([
    ["猫", 4],
    ["謎", 2],
    ["好き", 2],
  ]);
  const global = new Map([
    ["好き", 100],
    ["謎", 5000],
  ]);

  test("higher show count beats global rank", () => {
    expect(prestudyRank("猫", show, global)).toBeGreaterThan(
      prestudyRank("好き", show, global),
    );
  });

  test("show-count tie broken by global rank asc", () => {
    expect(prestudyRank("好き", show, global)).toBeGreaterThan(
      prestudyRank("謎", show, global),
    );
  });

  test("globally-unranked sorts last among equals", () => {
    const s = new Map([
      ["a", 1],
      ["b", 1],
    ]);
    const g = new Map([["b", 1]]);
    expect(prestudyOrder(s, g)).toEqual(["b", "a"]);
  });

  test("full order", () => {
    expect(prestudyOrder(show, global)).toEqual(["猫", "好き", "謎"]);
  });
});

describe("iPlusOne", () => {
  const known = new Set(["が", "好き", "と", "犬"]);

  test("finds cues where target is the only unknown", () => {
    const hits = iPlusOne("猫", [ep1, ep2], known);
    // cue0 "猫が好き" (others known), cue1 "犬と猫" (others known),
    // ep2 cue0 "猫好き"; NOT ep1 cue2 (氷菓/面白い/謎 unknown)
    expect(hits.length).toBe(3);
    expect(hits.map((h) => h.cue.text)).not.toContain("氷菓面白い猫謎");
    // shortest first
    expect(hits[0]!.cue.text.length).toBeLessThanOrEqual(hits[1]!.cue.text.length);
    expect(hits.map((h) => h.cue.text).sort()).toEqual(
      ["猫が好き", "犬と猫", "猫好き"].sort(),
    );
  });

  test("blacklist counts as known", () => {
    const none = iPlusOne("謎", [ep1], new Set(["猫"]));
    expect(none.length).toBe(0); // 氷菓/面白い block it
    const bl = new Set(["氷菓", "面白い"]);
    const hits = iPlusOne("謎", [ep1], new Set(["猫"]), bl);
    expect(hits.length).toBe(1);
    expect(hits[0]!.mediaId).toBe("ep1");
  });

  test("caps at 3 results", () => {
    const big = makeIndex(
      "big",
      [
        ["x", "a"],
        ["x", "a", "a"],
        ["x"],
        ["x", "a", "a", "a"],
      ],
    );
    const hits = iPlusOne("x", [big], new Set(["a"]));
    expect(hits.length).toBe(3);
    expect(hits[0]!.cue.text).toBe("x");
  });

  test("absent target -> empty", () => {
    expect(iPlusOne("zz", [ep1, ep2], known)).toEqual([]);
  });
});

describe("blacklist plumbing", () => {
  test("parseBlacklist tolerates junk", () => {
    expect(parseBlacklist(["a", 5, "b", null])).toEqual(new Set(["a", "b"]));
    expect(parseBlacklist("garbage")).toEqual(new Set());
  });

  test("filterCounts strips blacklisted lemmas", () => {
    const m = new Map([
      ["a", 3],
      ["b", 1],
    ]);
    const out = filterCounts(m, new Set(["b"]));
    expect([...out.keys()]).toEqual(["a"]);
    // empty blacklist returns a copy, not the same map
    const copy = filterCounts(m, new Set());
    expect(copy).not.toBe(m);
    expect(copy).toEqual(m);
  });
});
