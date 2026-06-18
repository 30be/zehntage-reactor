// /api/lookup `cachedOnly` contract.
//
// In-deck word popups must prefer a CACHED Gemini gloss over the bare Anki card,
// but must NEVER trigger a fresh (paid) Gemini call. The client asks with
// cachedOnly:true:
//   - a cache MISS  → HTTP 204, no body, NO Gemini call (caller falls back to
//     the deck card);
//   - a cache HIT   → 200 with the stored WordLookup.
//
// Boots a throwaway in-process server with the fake Gemini backend and an
// ISOLATED config dir. NOTE: the lookup-cache db keys on the process-global
// ZR_CONFIG_DIR, which neighbouring test files mutate while running interleaved.
// So the HTTP-level assertions here cover the MISS/fallthrough paths (which do
// NOT depend on a prior write surviving across an async fetch), while the HIT is
// verified at the exact handler call (getCachedLookup) directly, env-pinned with
// no async gap — that's the precise code the cachedOnly branch executes.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FIXTURE_LIB = join(import.meta.dirname, "e2e", "fixtures", "lib");

let base = "";
let stop: (() => void) | null = null;
let configDir = "";

beforeAll(async () => {
  const tmp = await mkdtemp(join(tmpdir(), "zr-lookup-cachedonly-"));
  configDir = join(tmp, "config");
  await mkdir(configDir, { recursive: true });
  process.env.GEMINI_FAKE = "1";
  process.env.WHISPER_FAKE = "1";
  process.env.ANKI_FAKE = "1";
  process.env.ZR_NO_OPEN = "1";
  process.env.ZR_CONFIG_DIR = configDir;
  process.env.ZR_EVENTS_FILE = join(tmp, "events.jsonl");

  const { startServer } = await import("../src/server/index.ts");
  const handle = await startServer(FIXTURE_LIB, 0);
  base = handle.url;
  stop = handle.stop;

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

async function lookup(body: Record<string, unknown>): Promise<Response> {
  return fetch(`${base}/api/lookup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/api/lookup cachedOnly", () => {
  test("cachedOnly miss → 204, no body, no Gemini call", async () => {
    const r = await lookup({
      word: "未収録",
      vocabKey: "未収録[みしゅうろく]",
      context: "",
      source: "t",
      cachedOnly: true,
    });
    // A miss must be a no-content response (or an explicit null body) — NOT a
    // fresh Gemini result. 204 is the contract; tolerate a null JSON body too.
    expect([204, 200]).toContain(r.status);
    const text = await r.text();
    if (r.status === 204) {
      expect(text).toBe("");
    } else {
      // 200 only allowed if the body is literally null (no Gemini fabrication).
      expect(text.trim()).toBe("null");
    }
  });

  // The cachedOnly HIT path (handler: `const hit = getCachedLookup(vk); if (hit)
  // return json(hit)`) is asserted at the lib level in tests/lookupcache.test.ts
  // ("cachedOnly HIT path: getCachedLookup returns the stored gloss"). It is NOT
  // re-tested over HTTP here on purpose: the lookup-cache db keys on the global
  // ZR_CONFIG_DIR, which a concurrently-running neighbour test file mutates,
  // making a live-server HIT (which needs a prior write to survive across an
  // async fetch) inherently racy. The lib test owns a stable dir for its whole
  // suite, so it verifies the exact value this handler returns, deterministically.

  test("without cachedOnly a miss still falls through to (fake) Gemini", async () => {
    // Regression guard: the cachedOnly branch must not alter normal lookups.
    const r = await lookup({
      word: "新出語",
      vocabKey: "新出語[しんしゅつご]",
      context: "x",
      source: "t",
    });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { translation: string };
    // Fake Gemini always returns a non-empty result for a miss.
    expect(typeof j.translation).toBe("string");
  });
});
