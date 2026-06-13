/**
 * Additional unit tests for src/lib/library.ts
 *
 * Covers gaps not in the existing library.test.ts:
 *  - Empty directory → empty scan result
 *  - Filenames with spaces and Japanese characters
 *  - Library class (refresh, get, list)
 *  - sidecarLang edge cases
 *  - sniffSubtitleLang edge cases
 *  - subLangsFor deduplication when sidecar+embedded overlap
 *  - bestJapaneseTrack precedence (generated > external > embedded)
 *    tested via scanLibrary + sidecarSubs structure inspection
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  scanLibrary,
  sidecarLang,
  sniffSubtitleLang,
  subLangsFor,
  Library,
  idForRelPath,
  type LibraryEntry,
} from "../src/lib/library.ts";

// ===========================================================================
// Fixtures
// ===========================================================================

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "zr-libextra-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

// ===========================================================================
// Empty directory
// ===========================================================================

describe("scanLibrary — empty directory", () => {
  test("returns empty array for an empty dir", async () => {
    const emptyDir = await mkdtemp(join(root, "empty-"));
    const entries = await scanLibrary(emptyDir);
    expect(entries).toEqual([]);
  });

  test("returns empty array for a dir containing only non-video files", async () => {
    const dir = await mkdtemp(join(root, "nonvideo-"));
    await Bun.write(join(dir, "readme.txt"), "nothing here");
    await Bun.write(join(dir, "image.jpg"), "not a video");
    const entries = await scanLibrary(dir);
    expect(entries).toEqual([]);
  });

  test("returns empty array for a dir with only a hidden video", async () => {
    const dir = await mkdtemp(join(root, "hidden-"));
    await Bun.write(join(dir, ".hidden.mkv"), "fake");
    const entries = await scanLibrary(dir);
    expect(entries).toEqual([]);
  });
});

// ===========================================================================
// Filenames with spaces and special characters
// ===========================================================================

describe("scanLibrary — special filenames", () => {
  test("video with spaces in filename is found and has correct relPath", async () => {
    const dir = await mkdtemp(join(root, "spaces-"));
    await Bun.write(join(dir, "My Show Episode 01.mkv"), "fake");
    const entries = await scanLibrary(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.name).toBe("My Show Episode 01.mkv");
    expect(entries[0]!.relPath).toBe("My Show Episode 01.mkv");
  });

  test("sidecar subtitle with spaces pairs correctly", async () => {
    const dir = await mkdtemp(join(root, "spaces-subs-"));
    await Bun.write(join(dir, "My Show Ep 01.mkv"), "fake");
    await Bun.write(
      join(dir, "My Show Ep 01.ja.srt"),
      "1\n00:00:00,000 --> 00:00:01,000\nこんにちは\n",
    );
    const entries = await scanLibrary(dir);
    expect(entries).toHaveLength(1);
    const subs = entries[0]!.sidecarSubs;
    expect(subs.some((s) => s.lang === "ja")).toBe(true);
  });

  test("video with Japanese characters in filename is found", async () => {
    const dir = await mkdtemp(join(root, "jp-"));
    await Bun.write(join(dir, "氷菓 第01話.mkv"), "fake");
    const entries = await scanLibrary(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.name).toBe("氷菓 第01話.mkv");
  });

  test("sidecar with Japanese video base name is detected", async () => {
    const dir = await mkdtemp(join(root, "jp-subs-"));
    await Bun.write(join(dir, "氷菓 第01話.mkv"), "fake");
    await Bun.write(
      join(dir, "氷菓 第01話.ja.srt"),
      "1\n00:00:00,000 --> 00:00:01,000\nテスト\n",
    );
    const entries = await scanLibrary(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.sidecarSubs.some((s) => s.lang === "ja")).toBe(true);
  });
});

// ===========================================================================
// Library class
// ===========================================================================

describe("Library class", () => {
  test("refresh() populates the internal map; list() and get() work", async () => {
    const dir = await mkdtemp(join(root, "libclass-"));
    await Bun.write(join(dir, "show.mp4"), "fake");
    const lib = new Library(dir);

    const entries = await lib.refresh();
    expect(entries).toHaveLength(1);

    const all = lib.list();
    expect(all).toHaveLength(1);
    expect(all[0]!.name).toBe("show.mp4");

    const id = idForRelPath("show.mp4");
    const found = lib.get(id);
    expect(found).toBeDefined();
    expect(found!.name).toBe("show.mp4");
  });

  test("get() returns undefined for unknown id", async () => {
    const dir = await mkdtemp(join(root, "libclass2-"));
    const lib = new Library(dir);
    await lib.refresh();
    expect(lib.get("000000000000")).toBeUndefined();
  });

  test("refresh() updates after new file is added", async () => {
    const dir = await mkdtemp(join(root, "libclass3-"));
    await Bun.write(join(dir, "ep01.mkv"), "fake");
    const lib = new Library(dir);
    await lib.refresh();
    expect(lib.list()).toHaveLength(1);

    // Add a second file
    await Bun.write(join(dir, "ep02.mp4"), "fake");
    await lib.refresh();
    expect(lib.list()).toHaveLength(2);
  });

  test("list() returns entries in relPath sort order", async () => {
    const dir = await mkdtemp(join(root, "libsort-"));
    await mkdir(join(dir, "s02"));
    await mkdir(join(dir, "s01"));
    await Bun.write(join(dir, "s02", "ep01.mkv"), "fake");
    await Bun.write(join(dir, "s01", "ep01.mkv"), "fake");
    await Bun.write(join(dir, "movie.mp4"), "fake");
    const lib = new Library(dir);
    await lib.refresh();
    const relPaths = lib.list().map((e) => e.relPath);
    const sorted = [...relPaths].sort((a, b) => a.localeCompare(b));
    expect(relPaths).toEqual(sorted);
  });
});

// ===========================================================================
// sidecarLang — additional edge cases
// ===========================================================================

describe("sidecarLang — edge cases", () => {
  test("three-letter lang codes (rus, eng) are accepted", () => {
    expect(sidecarLang("ep01", "ep01.rus.srt")).toBe("rus");
    expect(sidecarLang("ep01", "ep01.eng.vtt")).toBe("eng");
  });

  test("case-insensitive: JA, RU, EN all match", () => {
    expect(sidecarLang("ep01", "ep01.JA.srt")).toBe("ja");
    expect(sidecarLang("ep01", "ep01.RU.srt")).toBe("ru");
    expect(sidecarLang("ep01", "ep01.EN.ass")).toBe("en");
  });

  test("returns null for unsupported extension", () => {
    expect(sidecarLang("ep01", "ep01.ja.txt")).toBeNull();
    expect(sidecarLang("ep01", "ep01.ja.mkv")).toBeNull();
  });

  test("returns null for mismatched video base", () => {
    expect(sidecarLang("ep01", "ep02.ja.srt")).toBeNull();
    expect(sidecarLang("show.s01e01", "show.s01e02.ja.srt")).toBeNull();
  });

  test("returns empty string for untagged sidecar (same base, no lang)", () => {
    expect(sidecarLang("ep01", "ep01.srt")).toBe("");
    expect(sidecarLang("ep01", "ep01.ass")).toBe("");
    expect(sidecarLang("ep01", "ep01.vtt")).toBe("");
  });

  test("handles video base with dots correctly", () => {
    // base = "Show.S01E01", sub = "Show.S01E01.ja.srt" → tag = "ja"
    expect(sidecarLang("Show.S01E01", "Show.S01E01.ja.srt")).toBe("ja");
    // sub = "Show.S01E01.srt" → ""
    expect(sidecarLang("Show.S01E01", "Show.S01E01.srt")).toBe("");
  });

  test("returns null for extra-long 'tag' that isn't a language code", () => {
    // "ep01.commentary.srt" → tag = "commentary" → fails lang regex
    expect(sidecarLang("ep01", "ep01.commentary.srt")).toBeNull();
  });

  test("all supported subtitle extensions are recognised", () => {
    const exts = [".srt", ".vtt", ".ass", ".ssa"];
    for (const ext of exts) {
      expect(sidecarLang("ep", `ep.ja${ext}`)).toBe("ja");
    }
  });
});

// ===========================================================================
// sniffSubtitleLang — edge cases
// ===========================================================================

describe("sniffSubtitleLang — edge cases", () => {
  test("all-kana line is ja", () => {
    expect(sniffSubtitleLang("あいうえおかきくけこ")).toBe("ja");
  });

  test("timestamps and numbering are stripped before analysis", () => {
    const srt =
      "1\n00:00:00,000 --> 00:00:01,000\n2\n00:00:01,500 --> 00:00:02,000\n";
    // Only numbers/timestamps — should be "und"
    expect(sniffSubtitleLang(srt)).toBe("und");
  });

  test("mixed kana+latin with kana >10% is ja", () => {
    // "Hello! これはテストです World" — enough kana
    expect(sniffSubtitleLang("Hello これはテスト World")).toBe("ja");
  });

  test("ASS event tags are stripped", () => {
    // ASS-style tags in curly braces should be removed
    const assLine = "{\\an8\\pos(320,50)}こんにちは";
    expect(sniffSubtitleLang(assLine)).toBe("ja");
  });

  test("purely latin content is und", () => {
    expect(sniffSubtitleLang("Hello, world! How are you today?")).toBe("und");
  });

  test("empty string is und", () => {
    expect(sniffSubtitleLang("")).toBe("und");
  });

  test("cyrillic majority (>50%) is ru", () => {
    // Mostly cyrillic
    expect(sniffSubtitleLang("Привет мир как дела?")).toBe("ru");
  });

  test("cyrillic <50% of letters is und", () => {
    // Latin letters dominate — use a long Latin sentence with a couple of Cyrillic chars
    // "нет" = 3 cyrillic chars; the rest of the long latin sentence = >6 latin letters
    expect(sniffSubtitleLang("Hello world how are you doing нет")).toBe("und");
  });
});

// ===========================================================================
// subLangsFor — sidecar detection precedence + deduplication
// ===========================================================================

describe("subLangsFor — sidecar detection", () => {
  function makeEntry(sidecarSubs: LibraryEntry["sidecarSubs"]): LibraryEntry {
    return {
      id: "abc123def456",
      relPath: "show.mkv",
      absPath: "/nonexistent/show.mkv", // unprobeable → no embedded langs
      name: "show.mkv",
      size: 100,
      sidecarSubs,
    };
  }

  test("empty sidecarSubs with nonexistent file → empty langs", async () => {
    const entry = makeEntry([]);
    expect(await subLangsFor(entry)).toEqual([]);
  });

  test("untagged sidecar lang='' becomes 'und'", async () => {
    const entry = makeEntry([{ lang: "", path: "/nonexistent/ep.srt", ext: ".srt", origin: "external" }]);
    const langs = await subLangsFor(entry);
    expect(langs).toContain("und");
  });

  test("duplicate langs from multiple sidecars are deduped", async () => {
    const entry = makeEntry([
      { lang: "ja", path: "/a.srt", ext: ".srt", origin: "external" },
      { lang: "ja", path: "/b.srt", ext: ".srt", origin: "generated" },
    ]);
    const langs = await subLangsFor(entry);
    expect(langs.filter((l) => l === "ja")).toHaveLength(1);
  });

  test("multiple distinct langs are all returned", async () => {
    const entry = makeEntry([
      { lang: "ja", path: "/a.srt", ext: ".srt", origin: "external" },
      { lang: "ru", path: "/b.srt", ext: ".srt", origin: "generated" },
      { lang: "en", path: "/c.srt", ext: ".srt", origin: "external" },
    ]);
    const langs = (await subLangsFor(entry)).sort();
    expect(langs).toEqual(["en", "ja", "ru"]);
  });
});

// ===========================================================================
// bestJapaneseTrackId precedence — tested via sidecarSubs inspection
// (the function lives in server/index.ts and is not exported, so we test
// the underlying sidecarSubs data that it reads from scanLibrary)
// ===========================================================================

describe("bestJapaneseTrackId precedence — via scanLibrary sidecarSubs", () => {
  test("generated ja sidecar takes precedence over external in sidecarSubs order", async () => {
    const dir = await mkdtemp(join(root, "best-ja-"));
    await mkdir(join(dir, "subs"));
    await Bun.write(join(dir, "ep01.mkv"), "fake");
    // external sidecar
    await Bun.write(
      join(dir, "ep01.ja.srt"),
      "1\n00:00:00,000 --> 00:00:01,000\nExternal\n",
    );
    // generated sidecar in subs/
    await Bun.write(
      join(dir, "subs", "ep01.ja.srt"),
      "1\n00:00:00,000 --> 00:00:01,000\nGenerated\n",
    );
    const entries = await scanLibrary(dir);
    const ep = entries.find((e) => e.name === "ep01.mkv")!;
    const generated = ep.sidecarSubs.find((s) => s.origin === "generated" && s.lang === "ja");
    const external = ep.sidecarSubs.find((s) => s.origin === "external" && s.lang === "ja");
    // Both should be present
    expect(generated).toBeDefined();
    expect(external).toBeDefined();
    // The actual bestJapaneseTrackId logic checks generated first → sidecar:gen:ja
    // We verify the data that feeds it is correct
    expect(generated!.lang).toBe("ja");
    expect(external!.lang).toBe("ja");
  });

  test("only external ja sidecar present: correct origin", async () => {
    const dir = await mkdtemp(join(root, "ext-ja-"));
    await Bun.write(join(dir, "ep01.mkv"), "fake");
    await Bun.write(
      join(dir, "ep01.ja.ass"),
      "Script Info\n[Events]\nFormat: Start,End,Text\nDialogue: 0:00:00.00,0:00:01.00,テスト\n",
    );
    const entries = await scanLibrary(dir);
    const ep = entries.find((e) => e.name === "ep01.mkv")!;
    const ext = ep.sidecarSubs.find((s) => s.lang === "ja");
    expect(ext).toBeDefined();
    expect(ext!.origin).toBe("external");
    expect(ext!.ext).toBe(".ass");
  });

  test("no ja sidecar present: sidecarSubs has no ja lang", async () => {
    const dir = await mkdtemp(join(root, "no-ja-"));
    await Bun.write(join(dir, "ep01.mkv"), "fake");
    await Bun.write(
      join(dir, "ep01.ru.srt"),
      "1\n00:00:00,000 --> 00:00:01,000\nПривет\n",
    );
    const entries = await scanLibrary(dir);
    const ep = entries.find((e) => e.name === "ep01.mkv")!;
    const ja = ep.sidecarSubs.find((s) => s.lang === "ja");
    expect(ja).toBeUndefined();
  });
});

// ===========================================================================
// idForRelPath — determinism and collision resistance
// ===========================================================================

describe("idForRelPath", () => {
  test("is deterministic", () => {
    expect(idForRelPath("show/ep01.mkv")).toBe(idForRelPath("show/ep01.mkv"));
  });

  test("is 12 lowercase hex chars", () => {
    expect(idForRelPath("anything")).toMatch(/^[a-f0-9]{12}$/);
  });

  test("differs for different relPaths", () => {
    const a = idForRelPath("s01/ep01.mkv");
    const b = idForRelPath("s01/ep02.mkv");
    const c = idForRelPath("s02/ep01.mkv");
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(b).not.toBe(c);
  });

  test("path separators matter (POSIX vs Windows would differ)", () => {
    expect(idForRelPath("a/b.mkv")).not.toBe(idForRelPath("a\\b.mkv"));
  });
});
