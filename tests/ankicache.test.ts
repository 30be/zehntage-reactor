import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  getAnkiWords,
  refreshAnkiWords,
  readAnkiCache,
  cacheAddWord,
  cacheDeleteWord,
  subscribeAnkiWords,
} from "../web/ankicache.ts";
import type { AnkiWordsResponse } from "../web/api.ts";

// Minimal in-memory Storage (bun:test has no DOM localStorage).
function memStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
  } as Storage;
}

const realFetch = globalThis.fetch;
const g = globalThis as { localStorage?: Storage };

function payload(): AnkiWordsResponse {
  return {
    words: [
      { front: "猫 [ねこ]", back: "cat", notes: "", context: "<img src=x>" },
    ],
    progress: { "猫 [ねこ]": { interval: 5, due: 0, reps: 1, lapses: 0, ease: 2500, queue: 2, type: 2 } },
  };
}

function mockFetch(handler: (url: string, init?: RequestInit) => Response) {
  globalThis.fetch = (async (url: string, init?: RequestInit) =>
    handler(url, init)) as typeof fetch;
}

beforeEach(() => {
  g.localStorage = memStorage();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete g.localStorage;
});

describe("ankicache", () => {
  test("cold start fetches, persists slimmed payload + etag", async () => {
    mockFetch(() =>
      new Response(JSON.stringify(payload()), {
        status: 200,
        headers: { ETag: '"abc"' },
      }),
    );
    const data = await getAnkiWords();
    expect(data.words[0]!.front).toBe("猫 [ねこ]");
    const stored = readAnkiCache();
    expect(stored?.etag).toBe('"abc"');
    // context stripped before persisting
    expect(stored?.data.words[0]!.context).toBe("");
    expect(stored?.data.words[0]!.back).toBe("cat");
    expect(stored?.data.progress["猫 [ねこ]"]!.interval).toBe(5);
  });

  test("warm start resolves from cache, revalidates with If-None-Match (304)", async () => {
    mockFetch(() =>
      new Response(JSON.stringify(payload()), {
        status: 200,
        headers: { ETag: '"v1"' },
      }),
    );
    await getAnkiWords();

    let sentEtag: string | null = null;
    mockFetch((_url, init) => {
      sentEtag = (init?.headers as Record<string, string>)["If-None-Match"] ?? null;
      return new Response(null, { status: 304, headers: { ETag: '"v1"' } });
    });
    const data = await getAnkiWords(); // instant from cache
    expect(data.words).toHaveLength(1);
    await refreshAnkiWords(); // background revalidation path
    expect(sentEtag as string | null).toBe('"v1"');
  });

  test("changed payload notifies subscribers and updates cache", async () => {
    mockFetch(() =>
      new Response(JSON.stringify(payload()), { status: 200, headers: { ETag: '"v1"' } }),
    );
    await getAnkiWords();

    const fresh = payload();
    fresh.words.push({ front: "犬", back: "dog", notes: "", context: "" });
    mockFetch(() =>
      new Response(JSON.stringify(fresh), { status: 200, headers: { ETag: '"v2"' } }),
    );
    let seen: AnkiWordsResponse | null = null;
    const unsub = subscribeAnkiWords((d) => {
      seen = d;
    });
    await refreshAnkiWords();
    unsub();
    expect(seen!.words).toHaveLength(2);
    expect(readAnkiCache()?.etag).toBe('"v2"');
  });

  test("optimistic add/delete write through and clear the etag", async () => {
    mockFetch(() =>
      new Response(JSON.stringify(payload()), { status: 200, headers: { ETag: '"v1"' } }),
    );
    await getAnkiWords();

    cacheAddWord("犬", "いぬ", "dog");
    let stored = readAnkiCache()!;
    expect(stored.data.words.map((w) => w.front)).toContain("犬 [いぬ]");
    expect(stored.etag).toBeNull(); // stale by construction

    cacheDeleteWord("猫 [ねこ]");
    stored = readAnkiCache()!;
    expect(stored.data.words.map((w) => w.front)).toEqual(["犬 [いぬ]"]);
    expect(stored.data.progress["猫 [ねこ]"]).toBeUndefined();
  });

  test("oversized payload is not persisted (graceful fallback)", async () => {
    const big = payload();
    for (let i = 0; i < 20; i++) {
      big.words.push({ front: `w${i}`, back: "x".repeat(300_000), notes: "", context: "" });
    }
    mockFetch(() =>
      new Response(JSON.stringify(big), { status: 200, headers: { ETag: '"big"' } }),
    );
    const data = await getAnkiWords();
    expect(data.words.length).toBe(21); // network result still returned
    expect(readAnkiCache()).toBeNull(); // but not persisted
  });

  test("no localStorage at all degrades to plain fetch", async () => {
    delete g.localStorage;
    mockFetch(() =>
      new Response(JSON.stringify(payload()), { status: 200, headers: { ETag: '"v1"' } }),
    );
    const data = await getAnkiWords();
    expect(data.words).toHaveLength(1);
  });
});
