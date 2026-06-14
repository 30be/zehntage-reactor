import { expect, test } from "bun:test";
import {
  normalizeQuery,
  normalizeQueryRu,
  highlightSplit,
  highlightSplitRu,
  highlightHit,
  groupByEpisode,
  displayName,
  fmtTimestamp,
  cueLink,
  flatHits,
  type SearchHit,
} from "../web/searchquery.ts";

test("normalizeQuery: trims, lowercases, katakana→hiragana", () => {
  expect(normalizeQuery("  Hello  ")).toBe("hello");
  expect(normalizeQuery("カタカナ")).toBe("かたかな");
  expect(normalizeQuery("")).toBe("");
  expect(normalizeQuery("   ")).toBe("");
});

test("highlightSplit: empty query → whole text, no match", () => {
  expect(highlightSplit("勉強します", "")).toEqual([
    { text: "勉強します", match: false },
  ]);
  expect(highlightSplit("勉強します", "   ")).toEqual([
    { text: "勉強します", match: false },
  ]);
});

test("highlightSplit: no match → single non-match segment", () => {
  expect(highlightSplit("勉強します", "図書")).toEqual([
    { text: "勉強します", match: false },
  ]);
});

test("highlightSplit: single match in the middle", () => {
  expect(highlightSplit("図書館へ行きます", "図書")).toEqual([
    { text: "図書", match: true },
    { text: "館へ行きます", match: false },
  ]);
});

test("highlightSplit: match at the end keeps no trailing segment", () => {
  expect(highlightSplit("本を読みました", "ました")).toEqual([
    { text: "本を読み", match: false },
    { text: "ました", match: true },
  ]);
});

test("highlightSplit: multiple matches in one cue", () => {
  expect(highlightSplit("はいはい", "はい")).toEqual([
    { text: "はい", match: true },
    { text: "はい", match: true },
  ]);
  expect(highlightSplit("あはあはあ", "は")).toEqual([
    { text: "あ", match: false },
    { text: "は", match: true },
    { text: "あ", match: false },
    { text: "は", match: true },
    { text: "あ", match: false },
  ]);
});

test("highlightSplit: katakana query matches hiragana text (and vice-versa)", () => {
  // query in katakana, text in hiragana — server normalization parity
  const segs = highlightSplit("ともだち", "トモ");
  expect(segs).toEqual([
    { text: "とも", match: true },
    { text: "だち", match: false },
  ]);
  // case-insensitive latin
  expect(highlightSplit("ABCdef", "cde")).toEqual([
    { text: "AB", match: false },
    { text: "Cde", match: true },
    { text: "f", match: false },
  ]);
});

const hits: SearchHit[] = [
  { mediaId: "a", name: "ep1.mp4", start: 2, text: "x" },
  { mediaId: "b", name: "ep2.mp4", start: 5, text: "y" },
  { mediaId: "a", name: "ep1.mp4", start: 9, text: "z" },
];

test("groupByEpisode: groups by mediaId, preserves order", () => {
  const groups = groupByEpisode(hits);
  expect(groups.map((g) => g.mediaId)).toEqual(["a", "b"]);
  expect(groups[0]!.hits.map((h) => h.start)).toEqual([2, 9]);
  expect(groups[1]!.hits.map((h) => h.start)).toEqual([5]);
  expect(groups[0]!.name).toBe("ep1.mp4");
});

test("groupByEpisode: empty input → empty groups", () => {
  expect(groupByEpisode([])).toEqual([]);
});

test("flatHits: flattens groups back in order", () => {
  const groups = groupByEpisode(hits);
  expect(flatHits(groups).map((h) => h.start)).toEqual([2, 9, 5]);
});

test("displayName strips a trailing extension", () => {
  expect(displayName("Hyouka 01.mkv")).toBe("Hyouka 01");
  expect(displayName("noext")).toBe("noext");
});

test("fmtTimestamp formats m:ss", () => {
  expect(fmtTimestamp(0)).toBe("0:00");
  expect(fmtTimestamp(9)).toBe("0:09");
  expect(fmtTimestamp(75)).toBe("1:15");
  expect(fmtTimestamp(605)).toBe("10:05");
});

test("cueLink builds the player deep-link", () => {
  expect(cueLink("abc123", 9)).toBe("#/play/abc123@9");
});

// --- RU-language search helpers --------------------------------------------

test("normalizeQueryRu: lowercases + trims, no kana folding", () => {
  expect(normalizeQueryRu("  Привет  ")).toBe("привет");
  expect(normalizeQueryRu("КНИГА")).toBe("книга");
  // katakana is NOT folded to hiragana (RU normalization is JA-agnostic)
  expect(normalizeQueryRu("カ")).toBe("カ");
});

test("highlightSplitRu: highlights matched RU substring (case-insensitive)", () => {
  expect(highlightSplitRu("Иду в библиотеку", "библиотек")).toEqual([
    { text: "Иду в ", match: false },
    { text: "библиотек", match: true },
    { text: "у", match: false },
  ]);
  // case-insensitive, original casing preserved in the slice
  expect(highlightSplitRu("Книга", "книг")).toEqual([
    { text: "Книг", match: true },
    { text: "а", match: false },
  ]);
});

test("highlightSplitRu: no kana folding (katakana query won't match hiragana)", () => {
  expect(highlightSplitRu("ともだち", "トモ")).toEqual([
    { text: "ともだち", match: false },
  ]);
});

test("highlightHit: JA match highlights JA line, RU line shown unhighlighted", () => {
  const hit: SearchHit = {
    mediaId: "m",
    name: "ep",
    start: 1,
    text: "図書館へ行く",
    ru: "Иду в библиотеку",
    matchedLang: "ja",
  };
  const { ja, ru } = highlightHit(hit, "図書");
  expect(ja).toEqual([
    { text: "図書", match: true },
    { text: "館へ行く", match: false },
  ]);
  expect(ru).toEqual([{ text: "Иду в библиотеку", match: false }]);
});

test("highlightHit: RU match highlights RU line, JA line shown unhighlighted", () => {
  const hit: SearchHit = {
    mediaId: "m",
    name: "ep",
    start: 1,
    text: "図書館へ行く",
    ru: "Иду в библиотеку",
    matchedLang: "ru",
  };
  const { ja, ru } = highlightHit(hit, "библиотек");
  expect(ja).toEqual([{ text: "図書館へ行く", match: false }]);
  expect(ru).toEqual([
    { text: "Иду в ", match: false },
    { text: "библиотек", match: true },
    { text: "у", match: false },
  ]);
});

test("highlightHit: legacy JA-only hit (no ru / matchedLang) still highlights JA", () => {
  const hit: SearchHit = { mediaId: "m", name: "ep", start: 1, text: "図書館" };
  const { ja, ru } = highlightHit(hit, "図書");
  expect(ja).toEqual([
    { text: "図書", match: true },
    { text: "館", match: false },
  ]);
  expect(ru).toBeNull();
});
