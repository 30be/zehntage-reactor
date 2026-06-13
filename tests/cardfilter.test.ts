// Unit tests for web/cardfilter.ts pure helpers.
// DOM-free; no mocking needed.

import { describe, expect, test } from "bun:test";
import {
  cardStage,
  filterCards,
  frontWord,
  MATURE_INTERVAL_DAYS,
  type CardLite,
  type CardFilterOpts,
} from "../web/cardfilter.ts";

// ---------------------------------------------------------------------------
// cardStage
// ---------------------------------------------------------------------------

describe("cardStage", () => {
  test("undefined interval → new", () => {
    expect(cardStage(undefined)).toBe("new");
  });

  test("0 → new", () => {
    expect(cardStage(0)).toBe("new");
  });

  test("negative → new", () => {
    expect(cardStage(-5)).toBe("new");
  });

  test("1 day → learning", () => {
    expect(cardStage(1)).toBe("learning");
  });

  test("just below mature threshold → learning", () => {
    expect(cardStage(MATURE_INTERVAL_DAYS - 1)).toBe("learning");
  });

  test("exactly at mature threshold → mature", () => {
    expect(cardStage(MATURE_INTERVAL_DAYS)).toBe("mature");
  });

  test("well above mature → mature", () => {
    expect(cardStage(100)).toBe("mature");
  });
});

// ---------------------------------------------------------------------------
// frontWord — bracket stripping
// ---------------------------------------------------------------------------

describe("frontWord", () => {
  test("bare word unchanged", () => {
    expect(frontWord("猫")).toBe("猫");
  });

  test("strips reading bracket", () => {
    expect(frontWord("猫 [ねこ]")).toBe("猫");
  });

  test("strips bracket without space", () => {
    expect(frontWord("猫[ねこ]")).toBe("猫");
  });

  test("strips trailing content after bracket open", () => {
    expect(frontWord("word [reading] extra")).toBe("word");
  });

  test("empty string stays empty", () => {
    expect(frontWord("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// filterCards — helpers
// ---------------------------------------------------------------------------

function card(
  front: string,
  noteId?: number,
): CardLite {
  return { front, back: "b", notes: "", context: "", noteId };
}

const NOW = 1_700_000_000_000; // fixed epoch for determinism

// ---------------------------------------------------------------------------
// date-range filter
// ---------------------------------------------------------------------------

describe("filterCards date-range", () => {
  // "today" boundary: midnight of NOW's day
  const todayStart = (() => {
    const d = new Date(NOW);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  })();

  const beforeToday = todayStart - 1;
  const afterTodayStart = todayStart + 1000;

  test("range=all passes everything regardless of noteId", () => {
    const cards = [card("A", beforeToday), card("B", afterTodayStart), card("C")];
    const result = filterCards(cards, { range: "all", now: NOW });
    expect(result.length).toBe(3);
  });

  test("range=today excludes card added before midnight", () => {
    const cards = [card("old", beforeToday), card("new", afterTodayStart)];
    const result = filterCards(cards, { range: "today", now: NOW });
    expect(result.map((c) => c.front)).toContain("new");
    expect(result.map((c) => c.front)).not.toContain("old");
  });

  test("range=today passes card with no noteId (remote backend)", () => {
    const cards = [card("remote")]; // no noteId
    const result = filterCards(cards, { range: "today", now: NOW });
    expect(result.length).toBe(1);
  });

  test("range=7d excludes card older than 7 days", () => {
    const old = NOW - 8 * 86_400_000;
    const recent = NOW - 3 * 86_400_000;
    const cards = [card("old", old), card("recent", recent)];
    const result = filterCards(cards, { range: "7d", now: NOW });
    expect(result.map((c) => c.front)).toEqual(["recent"]);
  });

  test("range=30d excludes card older than 30 days", () => {
    const old = NOW - 31 * 86_400_000;
    const recent = NOW - 15 * 86_400_000;
    const cards = [card("old", old), card("recent", recent)];
    const result = filterCards(cards, { range: "30d", now: NOW });
    expect(result.map((c) => c.front)).toEqual(["recent"]);
  });
});

// ---------------------------------------------------------------------------
// stage filter
// ---------------------------------------------------------------------------

describe("filterCards stage filter", () => {
  const intervals = new Map([
    ["new_word", 0],
    ["learning_word", 5],
    ["mature_word", 30],
  ]);

  const cards: CardLite[] = [
    card("new_word"),
    card("learning_word"),
    card("mature_word"),
  ];

  test("stage=all returns all", () => {
    const r = filterCards(cards, { stage: "all", intervals });
    expect(r.length).toBe(3);
  });

  test("stage=new returns only new card", () => {
    const r = filterCards(cards, { stage: "new", intervals });
    expect(r.map((c) => c.front)).toEqual(["new_word"]);
  });

  test("stage=learning returns only learning card", () => {
    const r = filterCards(cards, { stage: "learning", intervals });
    expect(r.map((c) => c.front)).toEqual(["learning_word"]);
  });

  test("stage=mature returns only mature card", () => {
    const r = filterCards(cards, { stage: "mature", intervals });
    expect(r.map((c) => c.front)).toEqual(["mature_word"]);
  });
});

// ---------------------------------------------------------------------------
// rarity filter
// ---------------------------------------------------------------------------

describe("filterCards rarity filter", () => {
  function cardWithFreq(word: string, rank: number | null): { card: CardLite; rank: number | null } {
    return { card: { front: word, back: "", notes: "", context: "" }, rank };
  }

  const entries = [
    cardWithFreq("top1k", 500),
    cardWithFreq("top3k", 2000),
    cardWithFreq("top10k", 7000),
    cardWithFreq("top30k", 20_000),
    cardWithFreq("rare", 50_000),
    cardWithFreq("norank", null),
  ];

  function makeFreq(): ReadonlyMap<string, number> {
    const m = new Map<string, number>();
    for (const e of entries) {
      if (e.rank != null) m.set(e.card.front, e.rank);
    }
    return m;
  }

  const freq = makeFreq();
  const cards = entries.map((e) => e.card);

  test("rarity=all passes everything", () => {
    expect(filterCards(cards, { freq, rarity: "all" }).length).toBe(6);
  });

  test("rarity=top 1k", () => {
    const r = filterCards(cards, { freq, rarity: "top 1k" });
    expect(r.map((c) => c.front)).toEqual(["top1k"]);
  });

  test("rarity=top 3k", () => {
    const r = filterCards(cards, { freq, rarity: "top 3k" });
    expect(r.map((c) => c.front)).toEqual(["top3k"]);
  });

  test("rarity=top 10k", () => {
    const r = filterCards(cards, { freq, rarity: "top 10k" });
    expect(r.map((c) => c.front)).toEqual(["top10k"]);
  });

  test("rarity=top 30k", () => {
    const r = filterCards(cards, { freq, rarity: "top 30k" });
    expect(r.map((c) => c.front)).toEqual(["top30k"]);
  });

  test("rarity=rare includes null-rank and high-rank", () => {
    const r = filterCards(cards, { freq, rarity: "rare" });
    const fronts = r.map((c) => c.front);
    expect(fronts).toContain("rare");
    expect(fronts).toContain("norank");
    expect(fronts.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// sort / tiebreak
// ---------------------------------------------------------------------------

describe("filterCards sort order", () => {
  test("cards with noteIds sorted newest first", () => {
    const cards = [card("A", 1000), card("B", 3000), card("C", 2000)];
    const result = filterCards(cards, {});
    expect(result.map((c) => c.front)).toEqual(["B", "C", "A"]);
  });

  test("cards without any noteId are reversed (remote oldest-first → newest shown first)", () => {
    const cards = [
      { front: "first", back: "", notes: "", context: "" },
      { front: "second", back: "", notes: "", context: "" },
      { front: "third", back: "", notes: "", context: "" },
    ];
    const result = filterCards(cards, {});
    expect(result.map((c) => c.front)).toEqual(["third", "second", "first"]);
  });

  test("cards without noteId sink when mixed with noteId cards", () => {
    // When at least one noteId exists, sort by noteId (missing → -1)
    const cards = [
      card("no-id"),
      card("high-id", 5000),
      card("low-id", 1000),
    ];
    const result = filterCards(cards, {});
    expect(result[0]!.front).toBe("high-id");
    expect(result[1]!.front).toBe("low-id");
    expect(result[2]!.front).toBe("no-id");
  });
});

// ---------------------------------------------------------------------------
// query filter
// ---------------------------------------------------------------------------

describe("filterCards query filter", () => {
  const cards: CardLite[] = [
    { front: "猫", back: "cat", notes: "", context: "" },
    { front: "犬", back: "dog", notes: "", context: "" },
  ];

  test("q matches front, non-matching card excluded", () => {
    const r = filterCards(cards, { q: "猫" });
    expect(r.map((c) => c.front)).toContain("猫");
    expect(r.map((c) => c.front)).not.toContain("犬");
  });

  test("q matches back", () => {
    const r = filterCards(cards, { q: "dog" });
    expect(r.map((c) => c.front)).toContain("犬");
    expect(r.map((c) => c.front)).not.toContain("猫");
  });

  test("empty q returns all", () => {
    expect(filterCards(cards, { q: "" }).length).toBe(2);
  });
});
