// Server HTTP load / concurrency / abuse test (goal #3: LOAD coverage).
//
// Boots a throwaway in-process server on a SPARE port (8488 preferred; falls
// back to ephemeral if taken) against the e2e fixture library, with the same
// fake backends the e2e webServer uses (GEMINI_FAKE/WHISPER_FAKE/ANKI_FAKE) and
// an ISOLATED config dir (ZR_CONFIG_DIR) + events file (ZR_EVENTS_FILE) under a
// fresh tmp dir, so nothing touches the user's real ~/.config or the running
// :8417 / e2e :8499 instances.
//
// We assert STABILITY, not latency: under concurrent + abusive load every
// request must resolve (no hang, no unhandled rejection), return an expected
// status (2xx / 4xx, never a crash-5xx), and the server must stay responsive
// afterward. A regression that adds a race, an unhandled rejection, or unbounded
// growth in a read path gets caught here.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FIXTURE_LIB = join(import.meta.dirname, "e2e", "fixtures", "lib");
const SPARE_PORT = 8488;

let base = "";
let stop: (() => void) | null = null;

// Set fakes + isolation BEFORE importing/booting the server. These env vars are
// read at call-time inside the app, so setting them here is enough.
async function setupEnv(): Promise<void> {
  const tmp = await mkdtemp(join(tmpdir(), "zr-load-"));
  const configDir = join(tmp, "config");
  await mkdir(configDir, { recursive: true });
  process.env.GEMINI_FAKE = "1";
  process.env.WHISPER_FAKE = "1";
  process.env.ANKI_FAKE = "1";
  process.env.ZR_NO_OPEN = "1";
  process.env.ZR_CONFIG_DIR = configDir;
  process.env.ZR_EVENTS_FILE = join(tmp, "events.jsonl");
}

beforeAll(async () => {
  await setupEnv();
  // Import after env is set so module-level reads (if any) see the fakes.
  const { startServer } = await import("../src/server/index.ts");
  const handle = await startServer(FIXTURE_LIB, SPARE_PORT);
  base = handle.url;
  stop = handle.stop;

  // Readiness: poll /api/library until it answers 200.
  let ok = false;
  for (let i = 0; i < 50; i++) {
    const r = await fetch(`${base}/api/library`).catch(() => null);
    if (r && r.status === 200) {
      ok = true;
      break;
    }
    await Bun.sleep(50);
  }
  expect(ok).toBe(true);
}, 30_000);

afterAll(() => {
  stop?.();
});

/** Fetch returning {status, ok} or marking a hard failure (reject/hang). */
async function probe(pathAndQuery: string): Promise<number> {
  const r = await fetch(`${base}${pathAndQuery}`);
  // Drain the body so the connection is freed (important under concurrency).
  await r.arrayBuffer().catch(() => {});
  return r.status;
}

/** Pull a real media id + ja track name from the fixture library. */
async function firstEntry(): Promise<{ id: string; track: string | null }> {
  const lib = (await (await fetch(`${base}/api/library`)).json()) as {
    id: string;
  }[];
  const id = lib[0]!.id;
  const tracks = (await (await fetch(`${base}/api/subs/${id}`)).json()) as {
    name?: string;
    id?: string;
    track?: string;
  }[];
  // track identifier is decodeURIComponent'd server-side; try common keys.
  const t = tracks[0] as Record<string, unknown> | undefined;
  const track =
    (t?.["id"] as string) ??
    (t?.["track"] as string) ??
    (t?.["name"] as string) ??
    null;
  return { id, track };
}

describe("server load / concurrency / abuse", () => {
  test("library is non-empty (fixture booted correctly)", async () => {
    const lib = (await (await fetch(`${base}/api/library`)).json()) as unknown[];
    expect(Array.isArray(lib)).toBe(true);
    expect(lib.length).toBeGreaterThan(0);
  });

  test("100 concurrent mixed read requests all resolve with valid status", async () => {
    const { id, track } = await firstEntry();
    const reads: string[] = [
      "/api/library",
      `/api/subs/${id}`,
      "/api/search?q=" + encodeURIComponent("勉強"),
      "/api/review/due",
      "/api/anki/words",
      "/api/stats/summary",
      "/api/stats/growth",
      "/api/index/encounters?lemma=" + encodeURIComponent("勉強"),
      "/api/snapshots",
      "/api/word/history?lemma=" + encodeURIComponent("勉強"),
    ];
    if (track) {
      reads.push(`/api/subs/${id}/${encodeURIComponent(track)}`);
    }

    // 100 requests across the mix.
    const jobs: Promise<number>[] = [];
    for (let i = 0; i < 100; i++) {
      jobs.push(probe(reads[i % reads.length]!));
    }
    const results = await Promise.allSettled(jobs);

    // None may reject (a reject == hang/connection-reset/unhandled error).
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(0);

    // Every status is an expected 2xx/4xx — never a 5xx crash.
    for (const r of results) {
      if (r.status !== "fulfilled") continue;
      const code = r.value;
      expect(code).toBeGreaterThanOrEqual(200);
      expect(code).toBeLessThan(500);
    }

    // Server still responsive afterward.
    expect(await probe("/api/library")).toBe(200);
  }, 30_000);

  test("repeated tight-loop hits on cached endpoints stay consistent + error-free", async () => {
    // anki/words and stats both use stale-while-revalidate caches; hammering
    // them surfaces cache races / unbounded growth (would manifest as a throw
    // -> 500 or a divergent payload).
    const endpoints = ["/api/anki/words", "/api/stats/summary"];
    for (const ep of endpoints) {
      const first = await fetch(`${base}${ep}`);
      expect(first.status).toBe(200);
      const baselineKeys = Object.keys(
        (await first.json()) as Record<string, unknown>,
      ).sort();

      // 60 sequential + a concurrent burst.
      for (let i = 0; i < 60; i++) {
        expect(await probe(ep)).toBe(200);
      }
      const burst = await Promise.allSettled(
        Array.from({ length: 40 }, () => probe(ep)),
      );
      expect(burst.every((r) => r.status === "fulfilled" && r.value === 200)).toBe(
        true,
      );

      // Shape is stable (top-level keys unchanged across the storm).
      const after = await fetch(`${base}${ep}`);
      const afterKeys = Object.keys(
        (await after.json()) as Record<string, unknown>,
      ).sort();
      expect(afterKeys).toEqual(baselineKeys);
    }
  }, 30_000);

  test("abusive/malformed input at scale -> graceful 4xx/empty, never crash", async () => {
    const huge = "あ".repeat(50_000);
    const abusive: string[] = [
      // huge query strings
      "/api/search?q=" + encodeURIComponent(huge),
      "/api/index/encounters?lemma=" + encodeURIComponent(huge),
      "/api/word/history?lemma=" + encodeURIComponent(huge),
      // missing required params
      "/api/search",
      "/api/index/encounters",
      "/api/word/history",
      // bad / non-existent ids
      "/api/subs/deadbeef",
      "/api/subs/notahexid!!",
      "/api/subs/0000000000/doesnotexist",
      // junk query keys
      "/api/library?" + "x=1&".repeat(2000),
      "/api/stats/summary?garbage=" + encodeURIComponent(huge),
    ];

    const jobs: Promise<number>[] = [];
    for (let i = 0; i < 60; i++) {
      jobs.push(probe(abusive[i % abusive.length]!));
    }
    const results = await Promise.allSettled(jobs);

    expect(results.filter((r) => r.status === "rejected")).toHaveLength(0);
    for (const r of results) {
      if (r.status !== "fulfilled") continue;
      // Must be a handled status, never a 5xx crash.
      expect(r.value).toBeLessThan(500);
    }

    // Still alive after the abuse storm.
    expect(await probe("/api/library")).toBe(200);
  }, 30_000);
});
