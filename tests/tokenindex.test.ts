import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Cue } from "../src/lib/subs.ts";
import type { LibraryEntry } from "../src/lib/library.ts";
import {
  buildEntryIndex,
  clearIndexCache,
  comprehensibility,
  defaultDicPath,
  dueIntersection,
  encounters,
  getIndex,
  getServerTokenizer,
  type EntryIndex,
} from "../src/lib/tokenindex.ts";

const dicPath = defaultDicPath();
// Skip tokenizer-dependent tests gracefully when the dict isn't installed.
const withDict = dicPath ? test : test.skip;

function cue(start: number, text: string): Cue {
  return { start, end: start + 2, text };
}

describe("tokenindex (real kuromoji dict)", () => {
  withDict("dict resolves from node_modules", () => {
    expect(dicPath).toContain("@sglkc/kuromoji");
  });

  withDict("buildEntryIndex lemmatizes and counts JP sentences", async () => {
    const cues = [
      cue(0, "日本語を勉強します"),
      cue(5, "日本語が好きだ"),
      cue(10, "猫を食べた。猫だ!"),
    ];
    const ix = await buildEntryIndex({ id: "ep1" }, cues);
    expect(ix.mediaId).toBe("ep1");
    expect(ix.totalLexical).toBeGreaterThan(5);
    // 日本語 appears in two cues
    const nihongo = ix.lemmas.get("日本語")!;
    expect(nihongo.count).toBe(2);
    expect(nihongo.cues.map((c) => c.idx)).toEqual([0, 1]);
    expect(nihongo.cues[0]!.start).toBe(0);
    // verbs are lemmatized: 食べた → 食べる
    expect(ix.lemmas.has("食べる")).toBe(true);
    // 猫 counted twice within one cue, one example cue
    const neko = ix.lemmas.get("猫")!;
    expect(neko.count).toBe(2);
    expect(neko.cues).toHaveLength(1);
    // punctuation (。!) is not indexed
    expect(ix.lemmas.has("。")).toBe(false);
  });

  withDict("cue examples are capped at 20 per lemma", async () => {
    const cues = Array.from({ length: 30 }, (_, i) => cue(i, "猫がいる"));
    const ix = await buildEntryIndex({ id: "ep" }, cues);
    const neko = ix.lemmas.get("猫")!;
    expect(neko.count).toBe(30);
    expect(neko.cues).toHaveLength(20);
  });

  withDict("getServerTokenizer caches and merges tokens", async () => {
    const a = await getServerTokenizer();
    const b = await getServerTokenizer();
    expect(a).toBe(b);
    expect(a("学生です").map((t) => t.surface_form)).toContain("学生");
  });
});

// Query helpers are pure — test them with a stub tokenizer (no dict needed).
const stubTokenize = (text: string) =>
  text.split(/\s+/).filter(Boolean).map((w) => ({ surface_form: w, pos: "名詞" }));

/** Stub that marks tokens as 記号 (punctuation) so isLexical rejects them. */
const punctTokenize = (text: string) =>
  text.split(/\s+/).filter(Boolean).map((w) => ({ surface_form: w, pos: "記号" }));

async function stubIndex(id: string, lines: string[]): Promise<EntryIndex> {
  return buildEntryIndex({ id }, lines.map((l, i) => cue(i * 5, l)), stubTokenize);
}

describe("tokenindex queries (stub tokenizer)", () => {
  test("encounters across entries, most hits first", async () => {
    const a = await stubIndex("a", ["猫 犬", "猫"]);
    const b = await stubIndex("b", ["猫 猫 猫"]);
    const enc = encounters("猫", [a, b]);
    expect(enc.map((e) => e.mediaId)).toEqual(["b", "a"]);
    expect(enc[0]!.count).toBe(3);
    expect(encounters("象", [a, b])).toEqual([]);
  });

  test("comprehensibility: pctKnown over occurrences + top unknowns", async () => {
    const ix = await stubIndex("a", ["猫 猫 猫 犬 鳥 鳥"]); // 6 tokens
    const c = comprehensibility(ix, new Set(["猫"]));
    expect(c.pctKnown).toBeCloseTo(3 / 6, 5);
    expect(c.unknownLemmas).toEqual([
      { lemma: "鳥", count: 2 },
      { lemma: "犬", count: 1 },
    ]);
    const empty = comprehensibility(await stubIndex("e", []), new Set());
    expect(empty.pctKnown).toBeNull();
  });

  test("dueIntersection lists due lemmas present in the entry", async () => {
    const ix = await stubIndex("a", ["猫 犬 犬", "鳥"]);
    const due = dueIntersection(ix, new Set(["犬", "鳥", "象"]));
    expect(due.count).toBe(2);
    expect(due.lemmas.map((l) => l.lemma)).toEqual(["犬", "鳥"]);
    expect(due.lemmas[0]!.cues[0]!.idx).toBe(0);
  });

  test("getIndex caches by mtime and rebuilds on change", async () => {
    clearIndexCache();
    const dir = await mkdtemp(join(tmpdir(), "zr-tokidx-"));
    const abs = join(dir, "ep.mkv");
    await writeFile(abs, "v1");
    const entry = {
      id: "cached",
      relPath: "ep.mkv",
      absPath: abs,
      name: "ep.mkv",
      size: 2,
      sidecarSubs: [],
    } satisfies LibraryEntry;
    let calls = 0;
    const provider = async () => {
      calls++;
      return [cue(0, "猫")];
    };
    const i1 = await getIndex(entry, provider, stubTokenize);
    const i2 = await getIndex(entry, provider, stubTokenize);
    expect(calls).toBe(1);
    expect(i2).toBe(i1);
    // touch the file with different size → invalidate
    await writeFile(abs, "v2 longer");
    const i3 = await getIndex(entry, provider, stubTokenize);
    expect(calls).toBe(2);
    expect(i3).not.toBe(i1);
  });

  test("buildEntryIndex: empty cue list produces zero counts", async () => {
    const ix = await buildEntryIndex({ id: "empty" }, [], stubTokenize);
    expect(ix.totalLexical).toBe(0);
    expect(ix.lemmas.size).toBe(0);
    expect(ix.mediaId).toBe("empty");
  });

  test("buildEntryIndex: punctuation-only cues (記号) are not indexed", async () => {
    const ix = await buildEntryIndex(
      { id: "punct" },
      [cue(0, "。 ！ ？")],
      punctTokenize,
    );
    expect(ix.totalLexical).toBe(0);
    expect(ix.lemmas.size).toBe(0);
  });

  test("buildEntryIndex: empty-string cue contributes nothing", async () => {
    const ix = await buildEntryIndex(
      { id: "blank" },
      [cue(0, ""), cue(5, "猫")],
      stubTokenize,
    );
    // only the 猫 token
    expect(ix.totalLexical).toBe(1);
    expect(ix.lemmas.has("猫")).toBe(true);
  });

  test("comprehensibility: all lemmas known → pctKnown = 1", async () => {
    const ix = await stubIndex("a", ["猫 犬"]);
    const c = comprehensibility(ix, new Set(["猫", "犬"]));
    expect(c.pctKnown).toBe(1);
    expect(c.unknownLemmas).toHaveLength(0);
  });

  test("comprehensibility: topN caps the unknownLemmas list", async () => {
    // 5 distinct unknowns, ask for top 3
    const ix = await stubIndex("a", ["猫 犬 鳥 魚 虎"]);
    const c = comprehensibility(ix, new Set(), 3);
    expect(c.unknownLemmas).toHaveLength(3);
  });

  test("comprehensibility: tie-break by localeCompare when counts equal", async () => {
    // each word appears once — tie; alphabetical order should be stable
    const ix = await stubIndex("a", ["猫 犬"]);
    const c = comprehensibility(ix, new Set());
    const lemmas = c.unknownLemmas.map((u) => u.lemma);
    expect([...lemmas].sort((a, b) => a.localeCompare(b))).toEqual(lemmas);
  });

  test("dueIntersection: empty due set returns count 0", async () => {
    const ix = await stubIndex("a", ["猫 犬"]);
    const di = dueIntersection(ix, new Set());
    expect(di.count).toBe(0);
    expect(di.lemmas).toHaveLength(0);
  });

  test("dueIntersection: due lemma not in entry is ignored", async () => {
    const ix = await stubIndex("a", ["猫"]);
    const di = dueIntersection(ix, new Set(["象"]));
    expect(di.count).toBe(0);
  });

  test("encounters: no indexes returns empty array", () => {
    expect(encounters("猫", [])).toEqual([]);
  });

  test("getIndex: concurrent callers do not double-build (stampede guard)", async () => {
    clearIndexCache();
    const dir = await mkdtemp(join(tmpdir(), "zr-tokidx-stamp-"));
    const abs = join(dir, "ep.mkv");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(abs, "v1");
    const entry = {
      id: "stamp",
      relPath: "ep.mkv",
      absPath: abs,
      name: "ep.mkv",
      size: 2,
      sidecarSubs: [],
    } satisfies LibraryEntry;
    let calls = 0;
    const provider = async () => {
      calls++;
      return [cue(0, "猫")];
    };
    // Fire two concurrent getIndex calls
    const [i1, i2] = await Promise.all([
      getIndex(entry, provider, stubTokenize),
      getIndex(entry, provider, stubTokenize),
    ]);
    expect(calls).toBe(1);
    expect(i1).toBe(i2);
  });

  test("getIndex invalidates when a sidecar sub changes (media untouched)", async () => {
    clearIndexCache();
    const dir = await mkdtemp(join(tmpdir(), "zr-tokidx-sc-"));
    const abs = join(dir, "ep.mkv");
    const srt = join(dir, "ep.ja.srt");
    await writeFile(abs, "media");
    await writeFile(srt, "1\n00:00:00,000 --> 00:00:01,000\n猫\n");
    const entry = {
      id: "sc",
      relPath: "ep.mkv",
      absPath: abs,
      name: "ep.mkv",
      size: 5,
      sidecarSubs: [{ lang: "ja", path: srt, ext: ".srt", origin: "generated" as const }],
    } satisfies LibraryEntry;
    let calls = 0;
    const provider = async () => {
      calls++;
      return [cue(0, "猫")];
    };
    await getIndex(entry, provider, stubTokenize);
    await getIndex(entry, provider, stubTokenize);
    expect(calls).toBe(1);
    // rewrite the sidecar only (e.g. whisper regenerated it) → rebuild
    await writeFile(srt, "1\n00:00:00,000 --> 00:00:01,000\n犬がいる\n");
    await getIndex(entry, provider, stubTokenize);
    expect(calls).toBe(2);
  });
});
