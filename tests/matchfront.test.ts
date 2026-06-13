// Thorough unit tests for web/progress.ts: matchFront, progressBucket,
// buildWordIndex, withFront, withoutFront.
//
// Focus: lemma/conjugation matching that powers "verb added once highlights all
// forms", and reading-disambiguated homograph handling.

import { describe, expect, test } from "bun:test";
import {
  buildWordIndex,
  matchFront,
  progressBucket,
  withFront,
  withoutFront,
  type WordIndex,
} from "../web/progress.ts";
import type { AnkiWord, ProgressEntry } from "../web/api.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function word(front: string): AnkiWord {
  return { front } as AnkiWord;
}

function idx(fronts: string[], progress: Record<string, ProgressEntry> = {}): WordIndex {
  return buildWordIndex(fronts.map(word), progress);
}

// ---------------------------------------------------------------------------
// buildWordIndex
// ---------------------------------------------------------------------------

describe("buildWordIndex", () => {
  test("empty deck → empty index", () => {
    const i = idx([]);
    expect(i.byKey.size).toBe(0);
    expect(i.bare.size).toBe(0);
  });

  test("bare front (no brackets) is stored in byKey", () => {
    const i = idx(["猫"]);
    expect(i.byKey.get("猫")).toBe("猫");
    // bare word without bracket → not in .bare map
    expect(i.bare.has("猫")).toBe(false);
  });

  test("bracketed front is indexed under both exact and normalised keys", () => {
    const i = idx(["食べる [たべる]"]);
    // original
    expect(i.byKey.get("食べる [たべる]")).toBe("食べる [たべる]");
    // normalised kata->hira (already hira here, no change)
    expect(i.byKey.get("食べる [たべる]")).toBeTruthy();
    // bare index
    const list = i.bare.get("食べる")!;
    expect(list).toBeDefined();
    expect(list[0]!.front).toBe("食べる [たべる]");
    expect(list[0]!.reading).toBe("たべる");
  });

  test("katakana reading in front is normalised to hiragana in byKey", () => {
    // Card fronts written with katakana readings (some Anki templates do this)
    const i = idx(["辛い [カライ]"]);
    // byKey should hold the hira-normalised key "辛い [からい]"
    expect(i.byKey.get("辛い [からい]")).toBe("辛い [カライ]");
  });

  test("multiple cards for same bare word populate bare list", () => {
    const i = idx(["辛い [からい]", "辛い [つらい]"]);
    const list = i.bare.get("辛い")!;
    expect(list).toHaveLength(2);
    const readings = list.map((e) => e.reading).sort();
    expect(readings).toEqual(["からい", "つらい"]);
  });

  test("progress record is stored on the index", () => {
    const prog: Record<string, ProgressEntry> = {
      "猫": { interval: 10 } as ProgressEntry,
    };
    const i = buildWordIndex([word("猫")], prog);
    expect(i.progress["猫"]!.interval).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// matchFront — surface + reading (no basic_form)
// ---------------------------------------------------------------------------

describe("matchFront — surface+reading match", () => {
  test("exact surface+reading match returns the front", () => {
    const i = idx(["猫 [ねこ]"]);
    expect(matchFront(i, "猫", "ねこ")).toBe("猫 [ねこ]");
  });

  test("katakana reading in token is normalised for lookup", () => {
    const i = idx(["猫 [ねこ]"]);
    expect(matchFront(i, "猫", "ネコ")).toBe("猫 [ねこ]");
  });

  test("wrong reading does NOT match bracketed card (homograph guard)", () => {
    const i = idx(["辛い [からい]"]);
    // token read as つらい — should NOT match the からい card
    expect(matchFront(i, "辛い", "つらい")).toBeNull();
  });

  test("homograph: correct reading picks the right card", () => {
    const i = idx(["辛い [からい]", "辛い [つらい]"]);
    expect(matchFront(i, "辛い", "からい")).toBe("辛い [からい]");
    expect(matchFront(i, "辛い", "つらい")).toBe("辛い [つらい]");
  });
});

// ---------------------------------------------------------------------------
// matchFront — exact bare front (no brackets)
// ---------------------------------------------------------------------------

describe("matchFront — bare front (readingless card)", () => {
  test("bare front matches by exact surface text", () => {
    const i = idx(["猫"]);
    expect(matchFront(i, "猫")).toBe("猫");
  });

  test("bare front is not confused by different surface", () => {
    const i = idx(["猫"]);
    expect(matchFront(i, "犬")).toBeNull();
  });

  test("no reading on token → bare front matched from .bare map", () => {
    const i = idx(["辛い [からい]"]);
    // No reading provided — can't verify homograph, so first candidate returned
    expect(matchFront(i, "辛い")).toBe("辛い [からい]");
  });

  test("token with reading skips .bare map (homograph safety)", () => {
    // Only a からい card exists. Token arrives as つらい.
    const i = idx(["辛い [からい]"]);
    // The からい card should NOT match a つらい token.
    expect(matchFront(i, "辛い", "つらい")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// matchFront — basic_form (conjugation) fallback
// (this is the core of "verb added once highlights all forms")
// ---------------------------------------------------------------------------

describe("matchFront — basic_form / conjugation fallback", () => {
  test("conjugated form matches via basic_form (食べた → 食べる)", () => {
    const i = idx(["食べる"]);
    expect(matchFront(i, "食べた", undefined, "食べる")).toBe("食べる");
  });

  test("negative form matches via basic_form (食べない → 食べる)", () => {
    const i = idx(["食べる"]);
    expect(matchFront(i, "食べない", undefined, "食べる")).toBe("食べる");
  });

  test("polite form matches via basic_form (食べます → 食べる)", () => {
    const i = idx(["食べる"]);
    expect(matchFront(i, "食べます", undefined, "食べる")).toBe("食べる");
  });

  test("bracketed card with basic_form fallback also matched", () => {
    const i = idx(["食べる [たべる]"]);
    // Surface is conjugated, no reading on the conjugated token.
    expect(matchFront(i, "食べた", undefined, "食べる")).toBe("食べる [たべる]");
  });

  test("basic_form='*' is treated as absent (no fallback)", () => {
    const i = idx(["食べる"]);
    // basic_form of '*' means kuromoji has no entry — should not match
    expect(matchFront(i, "食べた", undefined, "*")).toBeNull();
  });

  test("basic_form equal to surface does not create infinite loop / duplicate match", () => {
    const i = idx(["猫"]);
    // basic_form === surface → the basic_form branch is skipped (guard in source)
    expect(matchFront(i, "猫", undefined, "猫")).toBe("猫"); // matches via byKey first
  });

  test("three conjugations of the same verb → all match the single card", () => {
    const i = idx(["書く"]);
    const forms = [
      ["書いた", "書く"],
      ["書かない", "書く"],
      ["書きます", "書く"],
    ] as [string, string][];
    for (const [surface, basic] of forms) {
      expect(matchFront(i, surface, undefined, basic)).toBe("書く");
    }
  });

  test("conjugation fallback does NOT match a different verb", () => {
    const i = idx(["読む"]);
    expect(matchFront(i, "書いた", undefined, "書く")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// matchFront — homograph disambiguation with basic_form
// ---------------------------------------------------------------------------

describe("matchFront — homograph + conjugation combo", () => {
  test("reading-disambiguated homograph: conjugated form still matches correct card", () => {
    // Two cards for 上る (のぼる) and 上がる (あがる).
    const i = idx(["上る [のぼる]", "上がる [あがる]"]);
    // 上った → basic_form = 上る → matches 上る card
    expect(matchFront(i, "上った", undefined, "上る")).toBe("上る [のぼる]");
    // 上がった → basic_form = 上がる → matches 上がる card
    expect(matchFront(i, "上がった", undefined, "上がる")).toBe("上がる [あがる]");
  });
});

// ---------------------------------------------------------------------------
// matchFront — null result cases
// ---------------------------------------------------------------------------

describe("matchFront — null cases", () => {
  test("unknown surface → null", () => {
    const i = idx(["猫"]);
    expect(matchFront(i, "象")).toBeNull();
  });

  test("empty index always returns null", () => {
    const i = idx([]);
    expect(matchFront(i, "猫", "ねこ", "猫")).toBeNull();
  });

  test("no basic_form and no match → null", () => {
    const i = idx(["食べる"]);
    expect(matchFront(i, "食べた")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// progressBucket
// ---------------------------------------------------------------------------

describe("progressBucket", () => {
  test("interval 0 → bucket 0 (newest)", () => {
    expect(progressBucket(0)).toBe(0);
  });

  test("negative interval clamps to 0 → bucket 0", () => {
    expect(progressBucket(-5)).toBe(0);
  });

  test("interval 1 → bucket 1", () => {
    expect(progressBucket(1)).toBe(1);
  });

  test("interval 4 → bucket 2", () => {
    expect(progressBucket(4)).toBe(2);
  });

  test("interval 11 → bucket 3", () => {
    expect(progressBucket(11)).toBe(3);
  });

  test("interval 30 → bucket 4", () => {
    expect(progressBucket(30)).toBe(4);
  });

  test("interval 90 → bucket 5 (most mature)", () => {
    expect(progressBucket(90)).toBe(5);
  });

  test("interval 365 → bucket 5", () => {
    expect(progressBucket(365)).toBe(5);
  });

  test("thresholds are exclusive upper bounds (boundary: 3 < 4, 10 < 11)", () => {
    // < 1 → 0, < 4 → 1, < 11 → 2, < 30 → 3, < 90 → 4, else → 5
    expect(progressBucket(0)).toBe(0);
    expect(progressBucket(3)).toBe(1);  // 3 < 4 → bucket 1
    expect(progressBucket(10)).toBe(2); // 10 < 11 → bucket 2
    expect(progressBucket(29)).toBe(3); // 29 < 30 → bucket 3
    expect(progressBucket(89)).toBe(4); // 89 < 90 → bucket 4
  });
});

// ---------------------------------------------------------------------------
// withFront / withoutFront — immutability and correctness
// ---------------------------------------------------------------------------

describe("withFront", () => {
  test("does not mutate the original index", () => {
    const original = idx(["猫"]);
    const originalSize = original.byKey.size;
    withFront(original, "犬");
    expect(original.byKey.size).toBe(originalSize);
  });

  test("new front is findable in returned index", () => {
    const original = idx(["猫"]);
    const next = withFront(original, "犬");
    expect(matchFront(next, "犬")).toBe("犬");
    expect(matchFront(original, "犬")).toBeNull(); // original unchanged
  });

  test("adding a bracketed front populates bare list without mutating original", () => {
    const original = idx(["辛い [からい]"]);
    const origBare = original.bare.get("辛い")!;
    const next = withFront(original, "辛い [つらい]");
    // original bare list must be unmodified
    expect(origBare).toHaveLength(1);
    // new index has both
    expect(next.bare.get("辛い")).toHaveLength(2);
  });
});

describe("withoutFront", () => {
  test("does not mutate the original index", () => {
    const original = idx(["猫", "犬"]);
    withoutFront(original, "犬");
    expect(matchFront(original, "犬")).toBe("犬");
  });

  test("removed front is not findable in returned index", () => {
    const original = idx(["猫", "犬"]);
    const next = withoutFront(original, "犬");
    expect(matchFront(next, "犬")).toBeNull();
    expect(matchFront(next, "猫")).toBe("猫");
  });

  test("removing one homograph card leaves the other", () => {
    const original = idx(["辛い [からい]", "辛い [つらい]"]);
    const next = withoutFront(original, "辛い [からい]");
    expect(matchFront(next, "辛い", "からい")).toBeNull();
    expect(matchFront(next, "辛い", "つらい")).toBe("辛い [つらい]");
  });

  test("removing last card for a bare word removes the bare entry too", () => {
    const original = idx(["辛い [からい]"]);
    const next = withoutFront(original, "辛い [からい]");
    expect(next.bare.has("辛い")).toBe(false);
  });
});
