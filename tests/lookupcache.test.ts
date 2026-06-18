import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  cacheKey,
  getCachedLookup,
  putCachedLookup,
  cachedLookupCount,
  getAllCachedKeys,
  isUsableLookup,
} from "../src/lib/lookupcache.ts";
import type { WordLookup } from "../src/lib/gemini.ts";

// The db is a process-lifetime singleton, so the config dir must be set once,
// before the first db touch, and kept for the whole suite. Tests use distinct
// keys to stay independent.
let dir: string;
const prev = process.env.ZR_CONFIG_DIR;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "zr-lookupcache-"));
  process.env.ZR_CONFIG_DIR = dir;
});
afterAll(() => {
  if (prev === undefined) delete process.env.ZR_CONFIG_DIR;
  else process.env.ZR_CONFIG_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});

const sample: WordLookup = {
  reading: "ねこ",
  translation: "cat",
  notes: "n.",
  context: "猫が好き。",
};

describe("lookupcache", () => {
  test("put/get round-trip by vocabKey", () => {
    expect(getCachedLookup("猫[ねこ]")).toBeUndefined();
    const before = cachedLookupCount();
    putCachedLookup("猫[ねこ]", sample);
    expect(getCachedLookup("猫[ねこ]")).toEqual(sample);
    expect(cachedLookupCount()).toBe(before + 1);
  });

  // The /api/lookup cachedOnly branch is exactly: `const hit =
  // getCachedLookup(vk); if (!hit) return 204; return json(hit)`. This pins that
  // a populated cache yields the stored gloss (what an in-deck popup prefers
  // over the bare Anki card) and an absent key yields a miss (→ 204 → card
  // fallback). Lives here (stable per-suite dir) because a live-server HTTP HIT
  // races the process-global ZR_CONFIG_DIR mutated by concurrent test files.
  test("cachedOnly HIT path: getCachedLookup returns the stored gloss", () => {
    const vk = "特別[とくべつ]";
    const gloss: WordLookup = {
      reading: "とくべつ",
      translation: "special",
      notes: "special; exceptional — the gloss the popup must prefer.",
      context: "特別な日。",
    };
    expect(getCachedLookup(vk)).toBeUndefined(); // miss → handler returns 204
    putCachedLookup(vk, gloss);
    // hit → handler returns json(hit): the full stored WordLookup.
    expect(getCachedLookup(vk)).toEqual(gloss);
  });

  test("different vocabKeys (homographs) don't collide", () => {
    const nama: WordLookup = { ...sample, reading: "なま", translation: "raw" };
    putCachedLookup("生[せい]", sample);
    putCachedLookup("生[なま]", nama);
    expect(getCachedLookup("生[せい]")).toEqual(sample);
    expect(getCachedLookup("生[なま]")).toEqual(nama);
  });

  test("cacheKey trims the vocabKey", () => {
    expect(cacheKey("  猫[ねこ]  ")).toBe("猫[ねこ]");
  });

  test("context is irrelevant — same vocabKey hits regardless", () => {
    putCachedLookup("水[みず]", sample);
    // No context in the key: any later read by the same vocabKey is a hit.
    expect(getCachedLookup("水[みず]")).toEqual(sample);
  });

  // A result is "usable" only with both a gloss AND a note; a missing note is
  // exactly the "popup shows no description" bug (notes is hidden when empty).
  test("isUsableLookup truth table", () => {
    expect(isUsableLookup(sample)).toBe(true);
    expect(isUsableLookup({ ...sample, notes: "" })).toBe(false);
    expect(isUsableLookup({ ...sample, translation: "" })).toBe(false);
    expect(isUsableLookup({ ...sample, notes: "   " })).toBe(false);
  });

  // Write-guard: an empty-notes result is never persisted, so it self-heals
  // (refetches) next time instead of being a permanent no-description hit.
  test("putCachedLookup refuses to write an empty-notes result", () => {
    const empty: WordLookup = { ...sample, notes: "" };
    const before = cachedLookupCount();
    putCachedLookup("空[から]", empty);
    expect(getCachedLookup("空[から]")).toBeUndefined();
    expect(cachedLookupCount()).toBe(before);
  });

  // Serve-guard: a LEGACY row written before the fix (empty notes) is treated
  // as a MISS, so the next lookup refetches and overwrites it.
  test("getCachedLookup treats a legacy poisoned row as a miss", () => {
    const key = cacheKey("毒[どく]");
    const raw = new Database(join(dir, "lookup-cache.db"));
    // Same schema as lookupcache.ts, so the INSERT lands in the live table.
    raw.run(`CREATE TABLE IF NOT EXISTS lookups(
      k TEXT PRIMARY KEY,
      word TEXT,
      context TEXT,
      reading TEXT,
      translation TEXT,
      notes TEXT,
      ctx TEXT,
      created INTEGER
    )`);
    raw.run(
      `INSERT INTO lookups(k, word, context, reading, translation, notes, ctx, created)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [key, "", "", "どく", "poison", "", "", Date.now()],
    );
    raw.close();
    expect(getCachedLookup("毒[どく]")).toBeUndefined();
  });

  // Batch status: getAllCachedKeys hides poisoned keys (so the batch re-attempts
  // them) but still reports usable keys.
  test("getAllCachedKeys excludes poisoned keys, includes usable ones", () => {
    const goodKey = cacheKey("良[よ]");
    const badKey = cacheKey("悪[わる]");
    putCachedLookup("良[よ]", { ...sample, reading: "よ", translation: "good" });
    const raw = new Database(join(dir, "lookup-cache.db"));
    raw.run(`CREATE TABLE IF NOT EXISTS lookups(
      k TEXT PRIMARY KEY,
      word TEXT,
      context TEXT,
      reading TEXT,
      translation TEXT,
      notes TEXT,
      ctx TEXT,
      created INTEGER
    )`);
    raw.run(
      `INSERT INTO lookups(k, word, context, reading, translation, notes, ctx, created)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [badKey, "", "", "わる", "bad", "", "", Date.now()],
    );
    raw.close();
    const keys = getAllCachedKeys();
    expect(keys.has(goodKey)).toBe(true);
    expect(keys.has(badKey)).toBe(false);
  });

  // The db handle must follow ZR_CONFIG_DIR when it changes. bun runs every test
  // FILE in one process, so a prior file can bind the singleton to a dir it then
  // deletes in afterAll; a stale handle then throws "attempt to write a readonly
  // database" here. A separate dir is a separate db.
  test("the cache follows a changed ZR_CONFIG_DIR (no stale-handle writes)", () => {
    const dirB = mkdtempSync(join(tmpdir(), "zr-lookupcache-b-"));
    try {
      putCachedLookup("基準[きじゅん]", sample); // uses the current `dir`
      process.env.ZR_CONFIG_DIR = dirB; // switch to a different dir
      expect(getCachedLookup("基準[きじゅん]")).toBeUndefined(); // separate db
      putCachedLookup("再開[さいかい]", sample); // must write to live dirB
      expect(getCachedLookup("再開[さいかい]")).toEqual(sample);
    } finally {
      process.env.ZR_CONFIG_DIR = dir; // restore for the rest of the suite
      rmSync(dirB, { recursive: true, force: true });
    }
  });
});
