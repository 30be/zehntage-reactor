import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  cacheKey,
  getCachedLookup,
  putCachedLookup,
  putManyCachedLookups,
  cachedLookupCount,
  getAllCachedKeys,
} from "../src/lib/lookupcache.ts";
import type { WordLookup } from "../src/lib/gemini.ts";

// The db is a process-lifetime singleton resolved from ZR_CONFIG_DIR, so the
// dir must be set once before the first db touch and kept for the whole suite.
// This is a SEPARATE file from lookupcache.test.ts (each bun test file is its
// own process, so the two singletons don't clash). Tests use distinct keys.
let dir: string;
const prev = process.env.ZR_CONFIG_DIR;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "zr-lookupcache-vk-"));
  process.env.ZR_CONFIG_DIR = dir;
});
afterAll(() => {
  if (prev === undefined) delete process.env.ZR_CONFIG_DIR;
  else process.env.ZR_CONFIG_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});

const mk = (o: Partial<WordLookup> = {}): WordLookup => ({
  reading: "ねこ",
  translation: "cat",
  notes: "n.",
  context: "猫が好き。",
  ...o,
});

describe("cacheKey", () => {
  test("trims surrounding whitespace", () => {
    expect(cacheKey("  生|なま|名詞  ")).toBe("生|なま|名詞");
  });

  test("null/undefined coerce to empty string", () => {
    expect(cacheKey(undefined as unknown as string)).toBe("");
    expect(cacheKey(null as unknown as string)).toBe("");
  });

  test("internal whitespace is preserved", () => {
    expect(cacheKey("a b")).toBe("a b");
  });
});

describe("putCachedLookup upsert", () => {
  test("re-putting the same key overwrites, not inserts a row", () => {
    const before = cachedLookupCount();
    putCachedLookup("更新|こうしん|名詞", mk({ translation: "first" }));
    expect(cachedLookupCount()).toBe(before + 1);
    putCachedLookup("更新|こうしん|名詞", mk({ translation: "second" }));
    expect(cachedLookupCount()).toBe(before + 1); // upsert, no new row
    expect(getCachedLookup("更新|こうしん|名詞")?.translation).toBe("second");
  });

  test("get reads back exactly the WordLookup fields (context from ctx col)", () => {
    const v = mk({ reading: "みず", translation: "water", notes: "ノート", context: "例文" });
    putCachedLookup("水|みず|名詞", v);
    expect(getCachedLookup("水|みず|名詞")).toEqual(v);
  });

  test("optional word/context debug args don't affect the key or result", () => {
    putCachedLookup("犬|いぬ|名詞", mk({ translation: "dog" }), "犬", "犬を見た");
    // Same vocabKey, different debug args → still a hit, value reflects last put.
    putCachedLookup("犬|いぬ|名詞", mk({ translation: "dog2" }), "different", "other");
    expect(getCachedLookup("犬|いぬ|名詞")?.translation).toBe("dog2");
  });

  test("key is trimmed on write and read symmetrically", () => {
    putCachedLookup("  鳥|とり|名詞  ", mk({ translation: "bird" }));
    expect(getCachedLookup("鳥|とり|名詞")?.translation).toBe("bird");
    expect(getCachedLookup("  鳥|とり|名詞  ")?.translation).toBe("bird");
  });
});

describe("putManyCachedLookups", () => {
  test("bulk upsert inserts all rows in one txn", () => {
    const before = cachedLookupCount();
    const rows = [
      { vocabKey: "一|いち|名詞", result: mk({ translation: "one" }) },
      { vocabKey: "二|に|名詞", result: mk({ translation: "two" }) },
      { vocabKey: "三|さん|名詞", result: mk({ translation: "three" }) },
    ];
    putManyCachedLookups(rows);
    expect(cachedLookupCount()).toBe(before + 3);
    expect(getCachedLookup("一|いち|名詞")?.translation).toBe("one");
    expect(getCachedLookup("二|に|名詞")?.translation).toBe("two");
    expect(getCachedLookup("三|さん|名詞")?.translation).toBe("three");
  });

  test("bulk upsert overwrites existing keys without duplicating", () => {
    putManyCachedLookups([{ vocabKey: "一|いち|名詞", result: mk({ translation: "ichi" }) }]);
    const after = cachedLookupCount();
    putManyCachedLookups([{ vocabKey: "一|いち|名詞", result: mk({ translation: "ichi2" }) }]);
    expect(cachedLookupCount()).toBe(after); // no new row
    expect(getCachedLookup("一|いち|名詞")?.translation).toBe("ichi2");
  });

  test("empty bulk is a no-op", () => {
    const before = cachedLookupCount();
    putManyCachedLookups([]);
    expect(cachedLookupCount()).toBe(before);
  });
});

describe("getAllCachedKeys", () => {
  test("returns a Set containing every cached (trimmed) key", () => {
    putCachedLookup("星|ほし|名詞", mk());
    const keys = getAllCachedKeys();
    expect(keys).toBeInstanceOf(Set);
    expect(keys.has("星|ほし|名詞")).toBe(true);
    expect(keys.size).toBe(cachedLookupCount());
  });

  test("stores the trimmed form (not the raw whitespace key)", () => {
    putCachedLookup("  月|つき|名詞  ", mk());
    const keys = getAllCachedKeys();
    expect(keys.has("月|つき|名詞")).toBe(true);
    expect(keys.has("  月|つき|名詞  ")).toBe(false);
  });
});

describe("miss", () => {
  test("unknown key returns undefined", () => {
    expect(getCachedLookup("存在しない|x|名詞")).toBeUndefined();
  });
});
