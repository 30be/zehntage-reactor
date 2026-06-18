import { describe, expect, test, mock, beforeEach, afterAll } from "bun:test";

// Capture the GENUINE modules before the stubs below replace them in the global
// registry. Needed to restore them in afterAll (see the note there).
import * as realGemini from "../src/lib/gemini.ts";
import * as realLookupcache from "../src/lib/lookupcache.ts";

// Stub the two collaborators so the runner test is sandbox-safe (no network, no
// sqlite write) and deterministic. We control lookupWordFlex's per-call outcome
// and record every cache write.
const calls: string[] = [];
const written: Array<{ vocabKey: string; word: string }> = [];
// vocabKey -> behavior: "ok" | "fail" | a delay in ms (still ok)
let behavior: (vocabKey: string) => "ok" | "fail" = () => "ok";
let inFlight = 0;
let maxInFlight = 0;

mock.module("../src/lib/gemini.ts", () => ({
  lookupWordFlex: async (word: string, _ctx: string, _src: string) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    calls.push(word);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    const b = behavior(word);
    if (b === "fail") throw new Error(`boom ${word}`);
    return { reading: "r", translation: "t", notes: "n", context: "c" };
  },
}));
mock.module("../src/lib/lookupcache.ts", () => ({
  putCachedLookup: (vocabKey: string, _result: unknown, word: string) => {
    written.push({ vocabKey, word });
  },
}));

const { runFlexLookups } = await import("../src/lib/flexrunner.ts");

// mock.module is GLOBAL and leaks across test files (bun runs them in one
// process). mock.restore() does NOT undo mock.module() (it only resets
// spies/mock fns), so the gemini/lookupcache stubs above would poison every
// later file that imports the real modules (e.g. lookupcache.test.ts loses
// getAllCachedKeys and getCachedLookup). Re-mock each module back to its REAL
// implementation so the registry is whole again for the rest of the suite.
afterAll(() => {
  mock.module("../src/lib/gemini.ts", () => realGemini);
  mock.module("../src/lib/lookupcache.ts", () => realLookupcache);
  mock.restore();
});

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
    await runFlexLookups(mkTargets(20), { concurrency: 4 });
    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(maxInFlight).toBeGreaterThan(1); // actually ran in parallel
  });

  test("tolerates per-item failures without aborting", async () => {
    behavior = (vk) => (vk === "w2" || vk === "w5" ? "fail" : "ok");
    const res = await runFlexLookups(mkTargets(6), { concurrency: 2 });
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
    const res = await runFlexLookups([], { onProgress: (d, t) => progress.push([d, t]) });
    expect(res).toEqual({ total: 0, succeeded: 0, failed: 0, stopped: false });
    expect(calls.length).toBe(0);
    expect(progress).toEqual([[0, 0]]);
  });
});
