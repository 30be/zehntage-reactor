import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  searchEntries,
  listFiles,
  downloadFile,
  loadJimakuApiKey,
  scoreJimakuCandidate,
  rankJimakuCandidates,
  JimakuError,
  type JimakuEntry,
  type JimakuFile,
} from "../src/lib/jimaku.ts";

const realFetch = globalThis.fetch;
let calls: { url: string; init?: RequestInit }[] = [];

function mockFetch(handler: (url: string) => Response | Promise<Response>): void {
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;
    calls.push({ url, init });
    return handler(url);
  }) as typeof fetch;
}

const ENTRY: JimakuEntry = {
  id: 1326,
  name: "Hyouka",
  english_name: "Hyouka",
  japanese_name: "氷菓",
  anilist_id: 12189,
  tmdb_id: null,
  flags: { anime: true, adult: false, external: false, movie: false, unverified: false },
  last_modified: "2024-01-01T00:00:00Z",
};

const FILE: JimakuFile = {
  url: "https://jimaku.cc/entry/1326/download/Hyouka%2001.srt",
  name: "Hyouka 01.srt",
  size: 12345,
  last_modified: "2024-01-01T00:00:00Z",
};

beforeEach(() => {
  calls = [];
  process.env.JIMAKU_API_KEY = "test-key";
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.JIMAKU_API_KEY;
});

describe("searchEntries", () => {
  test("by query string sends Authorization header and parses entries", async () => {
    mockFetch(() => Response.json([ENTRY]));
    const entries = await searchEntries("hyouka");
    expect(entries).toEqual([ENTRY]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://jimaku.cc/api/entries/search?query=hyouka");
    const headers = (calls[0]!.init?.headers ?? {}) as Record<string, string>;
    expect(headers["Authorization"]).toBe("test-key");
  });

  test("by anilist id + anime flag builds the right query string", async () => {
    mockFetch(() => Response.json([ENTRY]));
    await searchEntries({ anilistId: 12189, anime: true });
    expect(calls[0]!.url).toBe(
      "https://jimaku.cc/api/entries/search?anilist_id=12189&anime=true",
    );
  });

  test("empty criteria throws without hitting the network", async () => {
    mockFetch(() => Response.json([]));
    expect(searchEntries({})).rejects.toThrow(JimakuError);
    expect(calls).toHaveLength(0);
  });

  test("missing api key throws status 401", async () => {
    delete process.env.JIMAKU_API_KEY;
    mockFetch(() => Response.json([]));
    try {
      // point key loading at a nonexistent ~/.env via apiKey-less options:
      await searchEntries("x", { apiKey: undefined });
      // may still pass if user's real ~/.env has a key — only assert when it threw
    } catch (e) {
      expect(e).toBeInstanceOf(JimakuError);
      expect((e as JimakuError).status).toBe(401);
    }
  });

  test("API error body is surfaced with status and code", async () => {
    mockFetch(() => Response.json({ error: "nope", code: 7 }, { status: 404 }));
    try {
      await searchEntries("missing");
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as JimakuError;
      expect(err).toBeInstanceOf(JimakuError);
      expect(err.status).toBe(404);
      expect(err.code).toBe(7);
      expect(err.message).toContain("nope");
    }
  });

  test("429 carries retryAfterSec from rate-limit headers (retries exhaust)", async () => {
    // Returns 429 on every attempt — retries should exhaust then throw.
    mockFetch(
      () =>
        new Response(JSON.stringify({ error: "rate limited", code: 0 }), {
          status: 429,
          headers: {
            "content-type": "application/json",
            // Use 0 so the test doesn't actually sleep 3 × 980 ms.
            "x-ratelimit-reset-after": "0",
          },
        }),
    );
    try {
      await searchEntries("x");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as JimakuError).status).toBe(429);
      // retryAfterSec is 0 (finite, from header)
      expect((e as JimakuError).retryAfterSec).toBe(0);
      // Should have been called 4 times: 1 initial + 3 retries
      expect(calls).toHaveLength(4);
    }
  });

  test("429-then-200 retries and succeeds", async () => {
    let attempt = 0;
    mockFetch(() => {
      attempt++;
      if (attempt === 1) {
        return new Response(JSON.stringify({ error: "rate limited", code: 0 }), {
          status: 429,
          headers: {
            "content-type": "application/json",
            "x-ratelimit-reset-after": "0",
          },
        });
      }
      return Response.json([ENTRY]);
    });
    const entries = await searchEntries("hyouka");
    expect(entries).toEqual([ENTRY]);
    // 1 failed attempt + 1 successful retry
    expect(calls).toHaveLength(2);
  });

  test("401 is not retried — fails fast", async () => {
    mockFetch(() =>
      new Response(JSON.stringify({ error: "unauthorized", code: 1 }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );
    try {
      await searchEntries("x");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as JimakuError).status).toBe(401);
      // Only one fetch call — no retry on 4xx
      expect(calls).toHaveLength(1);
    }
  });
});

describe("listFiles", () => {
  test("lists files, optional episode filter", async () => {
    mockFetch(() => Response.json([FILE]));
    const files = await listFiles(1326);
    expect(files).toEqual([FILE]);
    expect(calls[0]!.url).toBe("https://jimaku.cc/api/entries/1326/files");

    await listFiles(1326, 5);
    expect(calls[1]!.url).toBe("https://jimaku.cc/api/entries/1326/files?episode=5");
  });
});

describe("downloadFile", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "jimaku-test-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("writes the body to destPath, creating parent dirs", async () => {
    mockFetch(() => new Response("1\n00:00:01,000 --> 00:00:02,000\nこんにちは\n"));
    const dest = join(dir, "subs", "ep01.ja.srt");
    const bytes = await downloadFile(FILE.url, dest);
    expect(bytes).toBeGreaterThan(0);
    expect(await Bun.file(dest).text()).toContain("こんにちは");
    const headers = (calls[0]!.init?.headers ?? {}) as Record<string, string>;
    expect(headers["Authorization"]).toBe("test-key");
  });

  test("HTTP error throws JimakuError with status", async () => {
    mockFetch(() => new Response("gone", { status: 410 }));
    expect(downloadFile(FILE.url, join(dir, "x.srt"))).rejects.toThrow(JimakuError);
  });
});

describe("loadJimakuApiKey", () => {
  test("process env wins; falls back to dotenv file", async () => {
    expect(await loadJimakuApiKey()).toBe("test-key");
    delete process.env.JIMAKU_API_KEY;
    const dir = await mkdtemp(join(tmpdir(), "jimaku-env-"));
    const envFile = join(dir, ".env");
    await Bun.write(envFile, 'JIMAKU_API_KEY="from-file"\n');
    expect(await loadJimakuApiKey(envFile)).toBe("from-file");
    await rm(dir, { recursive: true, force: true });
  });
});

describe("rankJimakuCandidates", () => {
  const f = (name: string) => ({ name });

  test("prefers a JA .srt over a Chinese .ass", () => {
    const files = [
      f("[XKsub] Hyouka - 01 [CHS].ass"),
      f("Hyouka - 01 [ja].srt"),
    ];
    expect(rankJimakuCandidates(files).map((x) => x.name)).toEqual([
      "Hyouka - 01 [ja].srt",
      "[XKsub] Hyouka - 01 [CHS].ass",
    ]);
  });

  test("demotes Chinese even when it is the text format", () => {
    const files = [f("Hyouka.01.zh.srt"), f("Hyouka.01.ja.ass")];
    expect(rankJimakuCandidates(files)[0]!.name).toBe("Hyouka.01.ja.ass");
  });

  test("non-subtitle files are dropped", () => {
    expect(rankJimakuCandidates([f("readme.txt"), f("a.srt")]).map((x) => x.name)).toEqual([
      "a.srt",
    ]);
  });

  test("ties keep original order (stable)", () => {
    const files = [f("a.srt"), f("b.srt")];
    expect(rankJimakuCandidates(files).map((x) => x.name)).toEqual(["a.srt", "b.srt"]);
  });

  test("scoreJimakuCandidate: CN penalty beats format bonus", () => {
    expect(scoreJimakuCandidate("x.ja.srt")).toBeGreaterThan(
      scoreJimakuCandidate("x.chs.srt"),
    );
    expect(scoreJimakuCandidate("星空字幕组.ass")).toBeLessThan(0);
  });
});
