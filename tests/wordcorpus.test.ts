import { describe, expect, test } from "bun:test";

import {
  buildFrontIndex,
  collectUnknownLookupTargets,
  countUnknownLookupTargets,
} from "../src/lib/wordcorpus.ts";
import type { KToken } from "../src/lib/jatok.ts";
import type { Cue } from "../src/lib/subs.ts";
import type { LibraryEntry } from "../src/lib/library.ts";
import type { Tokenize } from "../src/lib/tokenindex.ts";

// Hermetic: a stub tokenizer is injected via opts.tokenize, so kuromoji never
// loads and the tests are deterministic. No network, no real Anki db.

// --- tiny token builder ------------------------------------------------------
const tok = (o: Partial<KToken> & { surface_form: string }): KToken => ({
  pos: "名詞",
  ...o,
});

// A stub tokenizer driven by a surface->tokens map. Unknown surfaces tokenize
// to nothing.
function stubTokenizer(map: Record<string, KToken[]>): Tokenize {
  return (text: string) => map[text] ?? [];
}

const entry = (name: string): LibraryEntry => ({ name }) as unknown as LibraryEntry;
const cuesOf =
  (byName: Record<string, Cue[] | null>) =>
  async (e: LibraryEntry): Promise<Cue[] | null> =>
    byName[e.name] ?? null;

describe("buildFrontIndex", () => {
  test("indexes bare and bracketed fronts; normalizes reading to hiragana", () => {
    const idx = buildFrontIndex(["猫", "水 [みず]", "生 [ナマ]"]);
    expect(idx.byKey.has("猫")).toBe(true);
    expect(idx.byKey.has("水 [みず]")).toBe(true);
    // katakana reading folded to hiragana
    expect(idx.byKey.has("生 [なま]")).toBe(true);
    expect(idx.bare.get("水")).toEqual(["みず"]);
    expect(idx.bare.get("生")).toEqual(["なま"]);
  });

  test("skips empty/falsy fronts", () => {
    const idx = buildFrontIndex(["", "犬"]);
    expect(idx.byKey.has("犬")).toBe(true);
    expect(idx.byKey.has("")).toBe(false);
  });

  test("accumulates multiple readings for the same bare word", () => {
    const idx = buildFrontIndex(["生 [なま]", "生 [せい]"]);
    expect(idx.bare.get("生")?.sort()).toEqual(["せい", "なま"]);
  });
});

describe("collectUnknownLookupTargets", () => {
  const tokenize = stubTokenizer({
    "猫が水を飲む": [
      tok({ surface_form: "猫", reading: "ネコ" }),
      tok({ surface_form: "が", pos: "助詞", reading: "ガ" }),
      tok({ surface_form: "水", reading: "ミズ" }),
      tok({ surface_form: "を", pos: "助詞", reading: "ヲ" }),
      tok({ surface_form: "飲む", pos: "動詞", basic_form: "飲む", reading: "ノム" }),
    ],
    "猫がいる": [
      tok({ surface_form: "猫", reading: "ネコ" }),
      tok({ surface_form: "が", pos: "助詞", reading: "ガ" }),
      tok({ surface_form: "いる", pos: "動詞", basic_form: "いる", reading: "イル" }),
    ],
    "。。。": [tok({ surface_form: "。", pos: "記号" })],
  });

  test("collects unknown lexical words, skips known set and punctuation", async () => {
    const targets = await collectUnknownLookupTargets({
      entries: [entry("ep1")],
      cuesFor: cuesOf({ ep1: [{ text: "猫が水を飲む" } as Cue] }),
      deckFronts: [],
      known: new Set(["が|が|助詞", "を|を|助詞"]), // particles marked known
      tokenize,
    });
    const words = targets.map((t) => t.word);
    expect(words).toContain("猫");
    expect(words).toContain("水");
    expect(words).toContain("飲む");
    expect(words).not.toContain("が");
    expect(words).not.toContain("を");
    expect(words).not.toContain("。");
  });

  test("dedups by vocabKey across cues and entries — first occurrence wins", async () => {
    const targets = await collectUnknownLookupTargets({
      entries: [entry("ep1"), entry("ep2")],
      cuesFor: cuesOf({
        ep1: [{ text: "猫が水を飲む" } as Cue],
        ep2: [{ text: "猫がいる" } as Cue], // 猫 repeats
      }),
      deckFronts: [],
      known: new Set(["が|が|助詞", "を|を|助詞"]),
      tokenize,
    });
    const neko = targets.filter((t) => t.word === "猫");
    expect(neko).toHaveLength(1); // deduped
    expect(neko[0]!.source).toBe("ep1"); // first occurrence kept
    expect(neko[0]!.context).toBe("猫が水を飲む");
  });

  test("a deck card front filters out the matching word (reading-aware)", async () => {
    const targets = await collectUnknownLookupTargets({
      entries: [entry("ep1")],
      cuesFor: cuesOf({ ep1: [{ text: "猫が水を飲む" } as Cue] }),
      deckFronts: ["猫 [ねこ]"], // already mined
      known: new Set(["が|が|助詞", "を|を|助詞"]),
      tokenize,
    });
    const words = targets.map((t) => t.word);
    expect(words).not.toContain("猫"); // matched by deck card
    expect(words).toContain("水");
  });

  test("includeDeck keeps in-deck words as cache targets (FIX 1)", async () => {
    // Same input as the deck-filter test, but includeDeck:true (the cache path).
    // The in-deck word 猫 is now a target so it gets a full Gemini gloss; known
    // words and punctuation are STILL excluded.
    const opts = {
      entries: [entry("ep1")],
      cuesFor: cuesOf({ ep1: [{ text: "猫が水を飲む" } as Cue] }),
      deckFronts: ["猫 [ねこ]"], // already mined
      known: new Set(["が|が|助詞", "を|を|助詞"]),
      tokenize,
    };
    const cover = await collectUnknownLookupTargets(opts); // coverage: drops 猫
    const cache = await collectUnknownLookupTargets({ ...opts, includeDeck: true });
    const coverWords = cover.map((t) => t.word);
    const cacheWords = cache.map((t) => t.word);
    // coverage semantics unchanged: 猫 dropped
    expect(coverWords).not.toContain("猫");
    // cache semantics: 猫 INCLUDED, plus everything coverage had
    expect(cacheWords).toContain("猫");
    expect(cacheWords).toContain("水");
    expect(cacheWords).toContain("飲む");
    // still excludes known particles + punctuation
    expect(cacheWords).not.toContain("が");
    expect(cacheWords).not.toContain("を");
    // includeDeck is a strict superset of coverage here (only added the in-deck word)
    for (const w of coverWords) expect(cacheWords).toContain(w);
    expect(cacheWords.length).toBe(coverWords.length + 1);
  });

  test("verb lookup word uses dictionary (basic) form", async () => {
    const targets = await collectUnknownLookupTargets({
      entries: [entry("ep1")],
      cuesFor: cuesOf({ ep1: [{ text: "猫が水を飲む" } as Cue] }),
      deckFronts: [],
      known: new Set(),
      tokenize,
    });
    const verb = targets.find((t) => t.key.startsWith("飲む"));
    expect(verb?.word).toBe("飲む");
  });

  test("entries with no ja cues are skipped", async () => {
    const targets = await collectUnknownLookupTargets({
      entries: [entry("noja"), entry("ep1")],
      cuesFor: cuesOf({ noja: null, ep1: [{ text: "猫が水を飲む" } as Cue] }),
      deckFronts: [],
      known: new Set(["が|が|助詞", "を|を|助詞"]),
      tokenize,
    });
    expect(targets.map((t) => t.source).every((s) => s === "ep1")).toBe(true);
  });

  test("a throwing cuesFor skips just that entry", async () => {
    const targets = await collectUnknownLookupTargets({
      entries: [entry("boom"), entry("ep1")],
      cuesFor: async (e) => {
        if (e.name === "boom") throw new Error("track hiccup");
        return [{ text: "猫が水を飲む" } as Cue];
      },
      deckFronts: [],
      known: new Set(["が|が|助詞", "を|を|助詞"]),
      tokenize,
    });
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.every((t) => t.source === "ep1")).toBe(true);
  });

  test("countUnknownLookupTargets equals collect length", async () => {
    const opts = {
      entries: [entry("ep1")],
      cuesFor: cuesOf({ ep1: [{ text: "猫が水を飲む" } as Cue] }),
      deckFronts: [],
      known: new Set<string>(["が|が|助詞", "を|を|助詞"]),
      tokenize,
    };
    const n = await countUnknownLookupTargets(opts);
    const list = await collectUnknownLookupTargets(opts);
    expect(n).toBe(list.length);
  });
});
