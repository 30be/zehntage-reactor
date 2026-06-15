// Regression test for the /api/library scaling bug (test-fleet M26-1).
//
// `listEmbeddedSubTracks` caches ffprobe results keyed by path+size+mtime. The
// cache used to be a 64-entry FIFO, which thrashed for libraries >64 episodes:
// every /api/library load probes every episode, so entries were evicted faster
// than they filled, re-ffprobing the whole library on every call. The cache is
// now an LRU sized well above realistic libraries, so each distinct file is
// probed at most once across repeated library reads — and a changed mtime/size
// still triggers a re-probe (correctness preserved).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listEmbeddedSubTracks } from "../src/lib/subs.ts";

// Count ffprobe spawns per file path by intercepting Bun.spawn. ffprobe is
// invoked as ["ffprobe", "-v", "error", ..., "-show_streams", <file>] — the
// file is the last argv element.
const realSpawn = Bun.spawn;
let probeCounts: Map<string, number>;

function fakeFfprobe(file: string) {
  // One Japanese subtitle stream, deterministic per file.
  const payload = JSON.stringify({
    streams: [
      { index: 2, codec_type: "subtitle", codec_name: "subrip", tags: { language: "jpn", title: "JP" } },
    ],
  });
  return {
    stdout: new Response(payload).body,
    stderr: new Response("").body,
    exited: Promise.resolve(0),
  } as unknown as ReturnType<typeof realSpawn>;
}

beforeEach(() => {
  probeCounts = new Map();
  // @ts-expect-error overriding the global for the duration of the test
  Bun.spawn = (argv: string[], ...rest: unknown[]) => {
    if (Array.isArray(argv) && argv[0] === "ffprobe") {
      const file = argv[argv.length - 1] as string;
      probeCounts.set(file, (probeCounts.get(file) ?? 0) + 1);
      return fakeFfprobe(file);
    }
    // pass-through for anything else
    return (realSpawn as (...a: unknown[]) => ReturnType<typeof realSpawn>)(argv, ...rest);
  };
});

afterEach(() => {
  Bun.spawn = realSpawn;
});

describe("embedded-tracks cache scaling (M26-1)", () => {
  test("100 distinct episodes are each probed at most once across repeated reads", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zr-cache-"));
    const N = 100; // well above the old 64-entry cap
    const files: string[] = [];
    for (let i = 0; i < N; i++) {
      const f = join(dir, `ep${i}.mkv`);
      await writeFile(f, `dummy-${i}`);
      files.push(f);
    }

    // Simulate three full library loads (each probes every episode).
    for (let pass = 0; pass < 3; pass++) {
      const results = await Promise.all(files.map((f) => listEmbeddedSubTracks(f)));
      for (const tracks of results) {
        expect(tracks).toHaveLength(1);
        expect(tracks[0]?.lang).toBe("jpn");
      }
    }

    // Every file must have been probed exactly once — no FIFO thrash.
    expect(probeCounts.size).toBe(N);
    for (const f of files) {
      expect(probeCounts.get(f)).toBe(1);
    }
  });

  test("a changed mtime triggers a re-probe (cache self-invalidates)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zr-cache-mt-"));
    const f = join(dir, "ep.mkv");
    await writeFile(f, "v1");

    await listEmbeddedSubTracks(f);
    await listEmbeddedSubTracks(f);
    expect(probeCounts.get(f)).toBe(1); // second call served from cache

    // Bump mtime into the future → new cache key → must re-probe.
    const future = new Date(Date.now() + 60_000);
    await utimes(f, future, future);

    await listEmbeddedSubTracks(f);
    expect(probeCounts.get(f)).toBe(2);
  });

  test("a changed size triggers a re-probe (cache self-invalidates)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zr-cache-sz-"));
    const f = join(dir, "ep.mkv");
    await writeFile(f, "small");

    await listEmbeddedSubTracks(f);
    expect(probeCounts.get(f)).toBe(1);

    // Rewrite with different content/size but keep same path; bump mtime too so
    // at least one component of the key definitely changes.
    await writeFile(f, "a-much-larger-payload-than-before");
    const future = new Date(Date.now() + 120_000);
    await utimes(f, future, future);

    await listEmbeddedSubTracks(f);
    expect(probeCounts.get(f)).toBe(2);
  });
});
