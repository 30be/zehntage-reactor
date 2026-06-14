import { expect, test, describe, afterEach } from "bun:test";
import {
  parseRetryAfter,
  acceptCorrection,
  translateCues,
} from "../src/lib/gemini.ts";
import type { Cue } from "../src/lib/subs.ts";

// wave-13 coverage items #1, #3, #10

// --- #1: parseRetryAfter (delta-seconds / HTTP-date / body retryDelay) ---

describe("parseRetryAfter", () => {
  test("delta-seconds integer header → ms", () => {
    expect(parseRetryAfter("30", "")).toBe(30_000);
  });

  test("delta-seconds zero → 0", () => {
    expect(parseRetryAfter("0", "")).toBe(0);
  });

  test("future HTTP-date header → positive ms delta", () => {
    const realNow = Date.now;
    const fixed = Date.parse("2026-01-01T00:00:00Z");
    try {
      Date.now = () => fixed;
      // 30s in the future
      const future = new Date(fixed + 30_000).toUTCString();
      const ms = parseRetryAfter(future, "");
      expect(ms).toBe(30_000);
    } finally {
      Date.now = realNow;
    }
  });

  test("past HTTP-date header → clamped to 0", () => {
    const realNow = Date.now;
    const fixed = Date.parse("2026-01-01T00:00:00Z");
    try {
      Date.now = () => fixed;
      const past = new Date(fixed - 60_000).toUTCString();
      expect(parseRetryAfter(past, "")).toBe(0);
    } finally {
      Date.now = realNow;
    }
  });

  test("body retryDelay integer seconds → ms", () => {
    const body = '{"error":{"details":[{"retryDelay":"12s"}]}}';
    expect(parseRetryAfter(null, body)).toBe(12_000);
  });

  test("body retryDelay fractional seconds → ms (rounded)", () => {
    const body = '{"retryDelay": "0.5s"}';
    expect(parseRetryAfter(null, body)).toBe(500);
  });

  test("header takes precedence over body retryDelay", () => {
    expect(parseRetryAfter("5", '{"retryDelay":"99s"}')).toBe(5_000);
  });

  test("neither usable header nor body → undefined", () => {
    expect(parseRetryAfter(null, "")).toBeUndefined();
    expect(parseRetryAfter(null, "no hint here")).toBeUndefined();
  });

  test("non-numeric, non-date header with no body hint → undefined", () => {
    expect(parseRetryAfter("garbage-not-a-date", "")).toBeUndefined();
  });
});

// --- #3: acceptCorrection len=6 boundary (rule: len<=6 → limit 1) ---

describe("acceptCorrection len boundary", () => {
  // len uses code-point count of the ORIGINAL. Use ASCII so length == char count.
  test("len=6 dist=1 → accept", () => {
    // "abcdef" → "abcdeX": one substitution
    expect(acceptCorrection("abcdef", "abcdeX")).toBe(true);
  });

  test("len=6 dist=2 → reject (limit 1 under strict short-line rule)", () => {
    // "abcdef" → "abcdXY": two substitutions
    expect(acceptCorrection("abcdef", "abcdXY")).toBe(false);
  });

  test("len=7 dist=2 → accept (floor(7*0.4)=2)", () => {
    // "abcdefg" → "abcdeXY": two substitutions
    expect(acceptCorrection("abcdefg", "abcdeXY")).toBe(true);
  });

  test("len=7 dist=3 → reject", () => {
    // "abcdefg" → "abcdXYZ": three substitutions
    expect(acceptCorrection("abcdefg", "abcdXYZ")).toBe(false);
  });

  test("len=1 dist=1 → accept (minimum limit floor of 1)", () => {
    expect(acceptCorrection("a", "b")).toBe(true);
  });
});

// --- #10: translateCues GEMINI_FAKE mode contract ---

describe("translateCues GEMINI_FAKE contract", () => {
  let prev: string | undefined;
  afterEach(() => {
    if (prev === undefined) delete process.env.GEMINI_FAKE;
    else process.env.GEMINI_FAKE = prev;
  });

  test("N cues → N outputs, even with multiline text; onProgress fires (N,N)", async () => {
    prev = process.env.GEMINI_FAKE;
    process.env.GEMINI_FAKE = "1";

    const cues: Cue[] = [
      { start: 0, end: 1, text: "plain" },
      { start: 1, end: 2, text: "ass\\Nhard\\Nbreak" },
      { start: 2, end: 3, text: "real\nnewline\ntext" },
      { start: 3, end: 4, text: "another" },
    ];

    const progress: Array<[number, number]> = [];
    const out = await translateCues(cues, "ru", (done, total) =>
      progress.push([done, total]),
    );

    // N inputs → N outputs contract
    expect(out).toHaveLength(cues.length);
    // timings preserved 1:1
    expect(out.map((c) => [c.start, c.end])).toEqual(
      cues.map((c) => [c.start, c.end]),
    );
    // fake prefix applied per cue
    expect(out[0]!.text).toBe("[ru] plain");
    expect(out[1]!.text).toBe("[ru] ass\\Nhard\\Nbreak");

    // onProgress fired exactly once at (N, N)
    expect(progress).toEqual([[cues.length, cues.length]]);
  });

  test("empty input → empty output, progress (0,0)", async () => {
    prev = process.env.GEMINI_FAKE;
    process.env.GEMINI_FAKE = "1";
    const progress: Array<[number, number]> = [];
    const out = await translateCues([], "en", (d, t) => progress.push([d, t]));
    expect(out).toEqual([]);
    expect(progress).toEqual([[0, 0]]);
  });
});
