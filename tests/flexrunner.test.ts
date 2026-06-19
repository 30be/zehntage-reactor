import { describe, expect, test, beforeEach } from "bun:test";
import type { WordLookup } from "../src/lib/gemini.ts";
import { runFlexLookups } from "../src/lib/flexrunner.ts";

// DI stubs (NO module mocking): runFlexLookups exposes `lookup` and `putCache`
// seams, so we inject deterministic, sandbox-safe (no network, no sqlite)
// collaborators WITHOUT a global mock.module — which would leak the stubs into
// every other test file loaded before this one's teardown (it poisoned
// cache-enum-parity's real putCachedLookup). We control each lookup's outcome
// and record every cache write.
const calls: string[] = [];
const written: Array<{ vocabKey: string; word: string }> = [];
// word -> behavior: "ok" | "fail"
let behavior: (word: string) => "ok" | "fail" = () => "ok";
let inFlight = 0;
let maxInFlight = 0;

const lookupStub = async (
  word: string,
  _ctx: string,
  _src: string,
): Promise<WordLookup> => {
  inFlight++;
  maxInFlight = Math.max(maxInFlight, inFlight);
  calls.push(word);
  await new Promise((r) => setTimeout(r, 5));
  inFlight--;
  if (behavior(word) === "fail") throw new Error(`boom ${word}`);
  return { reading: "r", translation: "t", notes: "n", context: "c" };
};
const putStub = (vocabKey: string, _result: WordLookup, word = ""): void => {
  written.push({ vocabKey, word });
};
// Inject both seams into every run.
const di = { lookup: lookupStub, putCache: putStub };

function mkTargets(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    word: `w${i}`,
    context: `ctx${i}`,
    source: "src",
    vocabKey: `vk${i}`,
  }));
}

beforeEach(() => {
  calls.length = 0;
  written.length = 0;
  behavior = () => "ok";
  inFlight = 0;
  maxInFlight = 0;
});

describe("runFlexLookups", () => {
  test("writes every successful result to the cache and reports counts", async () => {
    const progress: Array<[number, number]> = [];
    const res = await runFlexLookups(mkTargets(7), {
      ...di,
      concurrency: 3,
      onProgress: (d, t) => progress.push([d, t]),
    });
    expect(res).toEqual({ total: 7, succeeded: 7, failed: 0, stopped: false });
    expect(written.length).toBe(7);
    expect(written.map((w) => w.vocabKey).sort()).toEqual(
      ["vk0", "vk1", "vk2", "vk3", "vk4", "vk5", "vk6"],
    );
    // done advances monotonically 1..7, total constant.
    expect(progress.map((p) => p[0])).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(progress.every((p) => p[1] === 7)).toBe(true);
  });

  test("respects the concurrency cap (pool size)", async () => {
    await runFlexLookups(mkTargets(20), { ...di, concurrency: 4 });
    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(maxInFlight).toBeGreaterThan(1); // actually ran in parallel
  });

  test("tolerates per-item failures without aborting", async () => {
    behavior = (w) => (w === "w2" || w === "w5" ? "fail" : "ok");
    const res = await runFlexLookups(mkTargets(6), { ...di, concurrency: 2 });
    expect(res.total).toBe(6);
    expect(res.failed).toBe(2);
    expect(res.succeeded).toBe(4);
    // failed items are NOT written to the cache.
    expect(written.length).toBe(4);
    expect(written.some((w) => w.word === "w2")).toBe(false);
  });

  test("stops starting new work when shouldStop() flips", async () => {
    let stop = false;
    const res = await runFlexLookups(mkTargets(50), {
      ...di,
      concurrency: 2,
      shouldStop: () => stop,
      onProgress: (d) => {
        if (d >= 4) stop = true;
      },
    });
    expect(res.stopped).toBe(true);
    // Far fewer than 50 started once stop tripped (pool drains, no new claims).
    expect(calls.length).toBeLessThan(50);
    expect(res.succeeded).toBeLessThan(50);
  });

  test("empty target list is a no-op", async () => {
    const progress: Array<[number, number]> = [];
    const res = await runFlexLookups([], {
      ...di,
      onProgress: (d, t) => progress.push([d, t]),
    });
    expect(res).toEqual({ total: 0, succeeded: 0, failed: 0, stopped: false });
    expect(calls.length).toBe(0);
    expect(progress).toEqual([[0, 0]]);
  });
});
