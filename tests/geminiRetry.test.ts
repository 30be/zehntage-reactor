import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { translateCues } from "../src/lib/gemini.ts";
import type { Cue } from "../src/lib/subs.ts";

// These tests exercise callGemini's retry/backoff via translateCues. We mock
// global fetch and set a real API key so the live path (not GEMINI_FAKE) runs.

const realFetch = globalThis.fetch;
let envPrev: string | undefined;
let fakePrev: string | undefined;

function jsonResp(translations: string[]): Response {
  const body = JSON.stringify({
    candidates: [{ content: { parts: [{ text: JSON.stringify({ translations }) }] } }],
  });
  return new Response(body, { status: 200 });
}

function errResp(status: number, retryAfter?: string): Response {
  const headers = new Headers();
  if (retryAfter !== undefined) headers.set("retry-after", retryAfter);
  return new Response(JSON.stringify({ error: { message: "boom" } }), { status, headers });
}

const cues: Cue[] = [{ start: 0, end: 1, text: "テスト" }];

beforeEach(() => {
  fakePrev = process.env.GEMINI_FAKE;
  delete process.env.GEMINI_FAKE; // ensure live path
  envPrev = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-key";
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (fakePrev === undefined) delete process.env.GEMINI_FAKE;
  else process.env.GEMINI_FAKE = fakePrev;
  if (envPrev === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = envPrev;
});

describe("callGemini retry/backoff", () => {
  test("retries on 429 then succeeds on 200", async () => {
    let calls = 0;
    // retry-after: "0" → near-zero delay, keeps the test fast
    globalThis.fetch = (async () => {
      calls++;
      return calls === 1 ? errResp(429, "0") : jsonResp(["перевод"]);
    }) as unknown as typeof fetch;

    const out = await translateCues(cues, "ru");
    expect(calls).toBe(2);
    expect(out[0]!.text).toBe("перевод");
  });

  test("does NOT retry on 400 (fatal)", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return errResp(400);
    }) as unknown as typeof fetch;

    await expect(translateCues(cues, "ru")).rejects.toThrow("Gemini API error 400");
    expect(calls).toBe(1);
  });

  test("retries on 500 then succeeds", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return calls === 1 ? errResp(500, "0") : jsonResp(["перевод"]);
    }) as unknown as typeof fetch;

    const out = await translateCues(cues, "ru");
    expect(calls).toBe(2);
    expect(out[0]!.text).toBe("перевод");
  });
});

describe("translateCues count-mismatch resilience", () => {
  const twoCues: Cue[] = [
    { start: 0, end: 1, text: "alpha" },
    { start: 1, end: 2, text: "beta" },
  ];

  test("recovers by retrying once when first batch returns wrong count", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      // first: wrong count (1 for 2 cues) → TranslationCountError → retry
      return calls === 1
        ? jsonResp(["only-one"])
        : jsonResp(["перевод-a", "перевод-b"]);
    }) as unknown as typeof fetch;

    const out = await translateCues(twoCues, "ru");
    expect(calls).toBe(2);
    expect(out.map((c) => c.text)).toEqual(["перевод-a", "перевод-b"]);
  });

  test("falls back to ORIGINAL text (not zero output) if count still wrong after retry", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return jsonResp(["always-one"]); // always wrong count
    }) as unknown as typeof fetch;

    const out = await translateCues(twoCues, "ru");
    expect(calls).toBe(2); // one initial + one retry, then give up
    expect(out).toHaveLength(2); // never zero output
    expect(out.map((c) => c.text)).toEqual(["alpha", "beta"]); // originals kept
    expect(out[0]!.start).toBe(0); // timings preserved
    expect(out[1]!.end).toBe(2);
  });
});
