import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  scanLibrary,
  idForRelPath,
  sidecarLang,
  embeddedCacheKey,
  subLangsFor,
  sniffSubtitleLang,
  migrateGeneratedSidecars,
  type LibraryEntry,
} from "../src/lib/library.ts";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "zehntage-test-"));
  await mkdir(join(root, "season1"));
  await Bun.write(join(root, "season1", "ep01.mkv"), "fakevideo");
  await Bun.write(join(root, "season1", "ep01.ja.srt"), "1\n00:00:00,000 --> 00:00:01,000\nx\n");
  await Bun.write(join(root, "season1", "ep01.srt"), "");
  await mkdir(join(root, "season1", "subs"));
  await Bun.write(
    join(root, "season1", "subs", "ep01.ru.srt"),
    "1\n00:00:00,000 --> 00:00:01,000\ny\n",
  );
  await Bun.write(join(root, "season1", "subs", "stray.mkv"), "not a library video");
  await Bun.write(join(root, "movie.mp4"), "fake");
  await Bun.write(join(root, "notes.txt"), "ignored");
  await Bun.write(join(root, ".hidden.mkv"), "ignored");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("scanLibrary", () => {
  test("finds videos recursively, skips non-video and hidden", async () => {
    const entries = await scanLibrary(root);
    expect(entries.map((e) => e.relPath)).toEqual(["movie.mp4", "season1/ep01.mkv"]);
  });

  test("ids are stable hashes of relPath", async () => {
    const entries = await scanLibrary(root);
    for (const e of entries) {
      expect(e.id).toBe(idForRelPath(e.relPath));
      expect(e.id).toMatch(/^[a-f0-9]{12}$/);
    }
    expect(idForRelPath("a")).not.toBe(idForRelPath("b"));
  });

  test("collects sidecar subs with language tags", async () => {
    const entries = await scanLibrary(root);
    const ep = entries.find((e) => e.name === "ep01.mkv")!;
    const langs = ep.sidecarSubs.map((s) => s.lang).sort();
    expect(langs).toEqual(["", "ja", "ru"]);
  });

  test("subs/ dir: subtitles are generated sidecars, videos in it are ignored", async () => {
    const entries = await scanLibrary(root);
    expect(entries.some((e) => e.name === "stray.mkv")).toBe(false);
    const ep = entries.find((e) => e.name === "ep01.mkv")!;
    const ru = ep.sidecarSubs.find((s) => s.lang === "ru")!;
    expect(ru.origin).toBe("generated");
    expect(ru.path).toBe(join(root, "season1", "subs", "ep01.ru.srt"));
    expect(ep.sidecarSubs.find((s) => s.lang === "ja")!.origin).toBe("external");
  });
});

describe("embeddedCacheKey", () => {
  test("combines path, size, mtime", () => {
    expect(embeddedCacheKey("/a/b.mkv", 100, 123)).toBe("/a/b.mkv|100|123");
  });
  test("differs when size or mtime changes", () => {
    const base = embeddedCacheKey("/a/b.mkv", 100, 123);
    expect(embeddedCacheKey("/a/b.mkv", 101, 123)).not.toBe(base);
    expect(embeddedCacheKey("/a/b.mkv", 100, 124)).not.toBe(base);
    expect(embeddedCacheKey("/a/c.mkv", 100, 123)).not.toBe(base);
  });
});

describe("subLangsFor", () => {
  test("includes sidecar langs; embedded probe of fake file yields none", async () => {
    const entries = await scanLibrary(root);
    const ep = entries.find((e) => e.name === "ep01.mkv")!;
    const langs = (await subLangsFor(ep)).sort();
    // fake mkv isn't probeable -> only sidecars ("" -> "und", "ja", generated "ru")
    expect(langs).toEqual(["ja", "ru", "und"]);
  });
  test("dedupes a sidecar+embedded same lang via Set semantics", async () => {
    const entry = {
      id: "x",
      relPath: "x.mkv",
      absPath: "/nonexistent/x.mkv",
      name: "x.mkv",
      size: 0,
      sidecarSubs: [
        { lang: "ja", path: "/a.ja.srt", ext: ".srt" },
        { lang: "ja", path: "/b.ja.srt", ext: ".srt" },
      ],
    } as LibraryEntry;
    expect(await subLangsFor(entry)).toEqual(["ja"]);
  });
});

describe("sidecarLang", () => {
  test("matches language-tagged sidecars", () => {
    expect(sidecarLang("ep01", "ep01.ja.srt")).toBe("ja");
    expect(sidecarLang("ep01", "ep01.ja-JP.ass")).toBe("ja-jp");
    expect(sidecarLang("ep01", "ep01.srt")).toBe("");
    expect(sidecarLang("ep01", "ep02.ja.srt")).toBeNull();
    expect(sidecarLang("ep01", "ep01.whatever.srt")).toBeNull();
  });
});

describe("sniffSubtitleLang", () => {
  test("detects kana-heavy content as ja", () => {
    expect(
      sniffSubtitleLang("1\n00:00:00,000 --> 00:00:01,000\nこんにちは、世界です\n"),
    ).toBe("ja");
  });
  test("detects cyrillic content as ru", () => {
    expect(
      sniffSubtitleLang("1\n00:00:00,000 --> 00:00:01,000\nПривет, как дела?\n"),
    ).toBe("ru");
  });
  test("latin or empty content is und", () => {
    expect(sniffSubtitleLang("1\n00:00:00,000 --> 00:00:01,000\nHello world\n")).toBe("und");
    expect(sniffSubtitleLang("")).toBe("und");
  });
});

describe("migrateGeneratedSidecars", () => {
  test("moves recent legacy sidecars into subs/ and renames untagged subs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zehntage-mig-"));
    try {
      await Bun.write(join(dir, "ep01.mkv"), "fake");
      // recent generated sidecar next to video → should move
      await Bun.write(
        join(dir, "ep01.ja.srt"),
        "1\n00:00:00,000 --> 00:00:01,000\nこんにちは\n",
      );
      // untagged subs/<base>.srt → should get sniffed+renamed
      await mkdir(join(dir, "subs"), { recursive: true });
      await Bun.write(
        join(dir, "subs", "ep01.srt"),
        "1\n00:00:00,000 --> 00:00:01,000\nПривет мир\n",
      );
      const actions = await migrateGeneratedSidecars(dir);
      const kinds = actions.map((a) => `${a.kind}:${a.to.split("/").pop()}`).sort();
      expect(kinds).toEqual(["moved:ep01.ja.srt", "renamed:ep01.ru.srt"]);
      expect(await Bun.file(join(dir, "subs", "ep01.ja.srt")).exists()).toBe(true);
      expect(await Bun.file(join(dir, "subs", "ep01.ru.srt")).exists()).toBe(true);
      expect(await Bun.file(join(dir, "ep01.ja.srt")).exists()).toBe(false);
      // idempotent: second run does nothing
      expect(await migrateGeneratedSidecars(dir)).toEqual([]);
      // collision safety: a new legacy file with an existing target is skipped
      await Bun.write(join(dir, "ep01.ja.srt"), "other content");
      const again = await migrateGeneratedSidecars(dir);
      expect(again).toEqual([
        {
          from: join(dir, "ep01.ja.srt"),
          to: join(dir, "subs", "ep01.ja.srt"),
          kind: "skipped-collision",
        },
      ]);
      expect(await Bun.file(join(dir, "ep01.ja.srt")).text()).toBe("other content");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
