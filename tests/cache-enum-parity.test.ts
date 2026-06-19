import { describe, expect, test, beforeAll, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collectUnknownLookupTargets } from "../src/lib/wordcorpus.ts";
import {
  cacheKey,
  getCachedLookup,
  getAllCachedKeys,
  putCachedLookup,
} from "../src/lib/lookupcache.ts";
import type { KToken } from "../src/lib/jatok.ts";
import type { Cue } from "../src/lib/subs.ts";
import type { LibraryEntry } from "../src/lib/library.ts";
import type { Tokenize } from "../src/lib/tokenindex.ts";
import type { WordLookup } from "../src/lib/gemini.ts";

// The cache db is a process-lifetime singleton resolved from ZR_CONFIG_DIR; set
// it once before the first db touch (its own test process — no clash).
let dir: string;
const prev = process.env.ZR_CONFIG_DIR;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "zr-cache-parity-"));
  process.env.ZR_CONFIG_DIR = dir;
});
// Re-assert our dir before every test: `bun test` runs all files in one process,
// so another file's afterAll could clear/replace ZR_CONFIG_DIR between our tests
// and steer the cache-db singleton at the wrong dir. The db handle reopens on a
// dir change, so this keeps the suite hermetic in both isolated and full runs.
beforeEach(() => {
  process.env.ZR_CONFIG_DIR = dir;
});
afterAll(() => {
  if (prev === undefined) delete process.env.ZR_CONFIG_DIR;
  else process.env.ZR_CONFIG_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});

const tok = (o: Partial<KToken> & { surface_form: string }): KToken => ({
  pos: "名詞",
  ...o,
});
function stubTokenizer(map: Record<string, KToken[]>): Tokenize {
  return (text: string) => map[text] ?? [];
}
const entry = (name: string): LibraryEntry => ({ name }) as unknown as LibraryEntry;
const cuesOf =
  (byName: Record<string, Cue[] | null>) =>
  async (e: LibraryEntry): Promise<Cue[] | null> =>
    byName[e.name] ?? null;
const mk = (o: Partial<WordLookup> = {}): WordLookup => ({
  reading: "",
  translation: "x",
  notes: "n",
  context: "c",
  ...o,
});

// "～　" = U+FF5E (wave dash) + U+3000 (ideographic space). isLexical passes
// (surface.trim() = "～", non-empty, pos != 記号), but vocabKey/lemmaOf do NOT
// trim, so the enumerated key keeps the trailing U+3000. The cache, however,
// stores it trimmed ("～"). This is the exact bug the per-episode status hit.
const WAVE = "～　"; // 2 codepoints
const WAVE_TRIMMED = "～"; // 1 codepoint, what the cache stores

const tokenize = stubTokenizer({
  // an in-deck word (組), a normal unknown (水), the OOV trailing-space token
  "組織の水～　": [
    tok({ surface_form: "組", reading: "クミ" }),
    tok({ surface_form: "織", pos: "助詞", reading: "シキ" }), // marked known below
    tok({ surface_form: "の", pos: "助詞", reading: "ノ" }),
    tok({ surface_form: "水", reading: "ミズ" }),
    tok({ surface_form: WAVE, pos: "記号無し" }), // OOV: no reading, non-記号 pos
  ],
});

// Shared enumeration opts. The cache path uses includeDeck:true; coverage false.
const baseOpts = {
  entries: [entry("ep1")],
  cuesFor: cuesOf({ ep1: [{ text: "組織の水～　" } as Cue] }),
  deckFronts: ["組 [くみ]"], // 組 already mined
  known: new Set<string>(["の|の|助詞", "織|しき|助詞"]),
  tokenize,
};

describe("cache enumeration parity (FIX 2)", () => {
  test("cache-all and per-episode enumerate the SAME in-deck-inclusive keys", async () => {
    // cache-all whole-library enumeration (includeDeck:true).
    const all = await collectUnknownLookupTargets({ ...baseOpts, includeDeck: true });
    // per-episode enumeration: collectUnknownLookupTargets per single entry
    // (the server calls it once per entry). Same flag.
    const perEp = await collectUnknownLookupTargets({
      ...baseOpts,
      entries: [entry("ep1")],
      includeDeck: true,
    });
    const allKeys = new Set(all.map((t) => t.key));
    const epKeys = new Set(perEp.map((t) => t.key));
    expect([...epKeys].sort()).toEqual([...allKeys].sort());
    // the in-deck word 組 IS a target (includeDeck), 水 is, and the OOV wave is
    expect(allKeys.has("組|くみ|名詞")).toBe(true); // in-deck, kept by includeDeck
    expect(allKeys.has("水|みず|名詞")).toBe(true);
    expect(allKeys.has(WAVE)).toBe(true); // untrimmed enumeration key
  });

  test("cached-count agrees across both read paths despite the trim mismatch", async () => {
    const targets = await collectUnknownLookupTargets({ ...baseOpts, includeDeck: true });
    // Cache the wave-dash gloss. putCachedLookup TRIMS the key -> stored as "～".
    putCachedLookup(WAVE, mk());
    // sanity: the row is stored under the trimmed key
    expect(getAllCachedKeys().has(WAVE_TRIMMED)).toBe(true);
    expect(getAllCachedKeys().has(WAVE)).toBe(false); // raw untrimmed key NOT stored

    // cache-all read path: getCachedLookup(t.key) trims via cacheKey() -> HIT.
    const cacheAllCount = targets.filter((t) => !!getCachedLookup(t.key)).length;

    // per-episode read path: cachedKeys.has(cacheKey(t.key)) (the FIX) -> HIT.
    // (Before the fix this used the raw t.key and MISSED -> count disagreed.)
    const cachedKeys = getAllCachedKeys();
    const perEpCount = targets.filter((t) => cachedKeys.has(cacheKey(t.key))).length;

    expect(perEpCount).toBe(cacheAllCount);
    expect(cacheAllCount).toBe(1); // exactly the wave-dash word is cached

    // The pre-fix RAW per-episode check would MISS the trimmed row (regression pin).
    const rawPerEpCount = targets.filter((t) => cachedKeys.has(t.key)).length;
    expect(rawPerEpCount).toBe(0); // demonstrates the bug the fix closes
  });
});
