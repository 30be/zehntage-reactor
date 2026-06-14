import { createHash } from "node:crypto";
import { readdir, stat, readFile, rename, mkdir } from "node:fs/promises";
import { join, relative, basename, extname, dirname } from "node:path";
import { listEmbeddedSubTracks } from "./subs.ts";

export const VIDEO_EXTENSIONS = new Set([".mkv", ".mp4", ".webm"]);
export const SUBTITLE_EXTENSIONS = new Set([".srt", ".vtt", ".ass", ".ssa"]);

export interface LibraryEntry {
  id: string;
  /** Path relative to the library root, POSIX separators. */
  relPath: string;
  /** Absolute path on disk. */
  absPath: string;
  name: string;
  size: number;
  /** Sidecar subtitle files: lang (or "" when unknown) → absolute path. */
  sidecarSubs: SidecarSub[];
}

export interface SidecarSub {
  lang: string;
  path: string;
  ext: string;
  /** "generated" for files under a subs/ dir (whisper/Gemini output), "external" otherwise. */
  origin: "generated" | "external";
}

/** Cache key for embedded-track probing: identity (path) + size + mtime. */
export function embeddedCacheKey(absPath: string, size: number, mtimeMs: number): string {
  return `${absPath}|${size}|${mtimeMs}`;
}

/**
 * Languages of EMBEDDED subtitle tracks for a video file. Returns raw lang
 * codes (e.g. "jpn"). On probe failure (or non-probeable file) returns [].
 *
 * Derived from `listEmbeddedSubTracks`, which itself caches the (expensive)
 * `ffprobe` result by path + size + mtime — so this no longer keeps a separate
 * `embeddedLangCache`/ffprobe path. There is now exactly one probe per
 * (file, size, mtime), shared with `subTracksFor`.
 */
export async function embeddedSubLangs(absPath: string): Promise<string[]> {
  try {
    const tracks = await listEmbeddedSubTracks(absPath);
    return tracks.map((t) => t.lang);
  } catch {
    return [];
  }
}

/** Sidecar + embedded sub languages for an entry (raw codes, deduped). */
export async function subLangsFor(entry: LibraryEntry): Promise<string[]> {
  const langs = new Set<string>();
  for (const s of entry.sidecarSubs) langs.add(s.lang || "und");
  for (const l of await embeddedSubLangs(entry.absPath)) langs.add(l);
  return [...langs];
}

// --- subtitle language sniffing (for sidecars without a lang tag) ---

/**
 * Guess the language of subtitle TEXT content (timestamps/numbers stripped):
 * >10% kana → "ja"; else if cyrillic dominates the remaining letters → "ru";
 * else "und".
 */
export function sniffSubtitleLang(content: string): "ja" | "ru" | "und" {
  const text = content
    .split(/\r?\n/)
    .filter((l) => !/-->/.test(l) && !/^\s*\d+\s*$/.test(l) && !/^\s*\d+:\d+/.test(l))
    .join("\n")
    // drop remaining digits, timestamps inside ASS event lines, tags
    .replace(/\{[^}]*\}/g, "")
    .replace(/[0-9.,:;()\[\]{}<>/\\|_+=~*&^%$#@!?"'-]/g, "");
  let kana = 0;
  let cyr = 0;
  let letters = 0;
  for (const ch of text) {
    if (/\s/.test(ch)) continue;
    letters++;
    if (/[ぁ-ゟァ-ヶ]/.test(ch)) kana++;
    else if (/[Ѐ-ӿ]/.test(ch)) cyr++;
  }
  if (letters === 0) return "und";
  if (kana / letters > 0.1) return "ja";
  if (cyr / letters > 0.5) return "ru";
  return "und";
}

// Cache of sniffed langs for untagged sidecar files, keyed by path+size+mtime
// (same scheme as the embedded-track cache) so refreshes don't re-read files.
const sniffedLangCache = new Map<string, string>();

/** Sniffed language for an untagged sidecar file, cached by path+size+mtime. */
export async function sniffedSidecarLang(absPath: string): Promise<string> {
  let key: string;
  try {
    const st = await stat(absPath);
    key = embeddedCacheKey(absPath, st.size, st.mtimeMs);
  } catch {
    return "und";
  }
  const hit = sniffedLangCache.get(key);
  if (hit !== undefined) return hit;
  let lang = "und";
  try {
    lang = sniffSubtitleLang(await readFile(absPath, "utf-8"));
  } catch {
    // unreadable → und
  }
  sniffedLangCache.set(key, lang);
  return lang;
}

/** Stable id: first 12 hex chars of sha1 of the relative path. */
export function idForRelPath(relPath: string): string {
  return createHash("sha1").update(relPath).digest("hex").slice(0, 12);
}

/** "Show.S01E01.ja.srt" relative to base "Show.S01E01" → lang "ja". */
export function sidecarLang(videoBase: string, subFile: string): string | null {
  const ext = extname(subFile).toLowerCase();
  if (!SUBTITLE_EXTENSIONS.has(ext)) return null;
  const stem = subFile.slice(0, -ext.length);
  if (stem === videoBase) return ""; // no language tag
  if (!stem.startsWith(videoBase + ".")) return null;
  const tag = stem.slice(videoBase.length + 1);
  // language tags like "ja", "en", "ru", "ja-JP", "rus"
  if (/^[A-Za-z]{2,3}(-[A-Za-z]{2,4})?$/.test(tag)) return tag.toLowerCase();
  return null;
}

export async function scanLibrary(root: string): Promise<LibraryEntry[]> {
  const entries: LibraryEntry[] = [];
  await walk(root, root, entries);
  entries.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return entries;
}

async function walk(root: string, dir: string, out: LibraryEntry[]): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  names.sort();
  const videos: string[] = [];
  const subs: string[] = [];
  // Subtitle files inside a "subs/" subdir — auto-generated sidecars for
  // videos in THIS dir; never scanned for videos.
  const generatedSubs: string[] = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const full = join(dir, name);
    let st;
    try {
      st = await stat(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (name.toLowerCase() === "subs") {
        let subNames: string[] = [];
        try {
          subNames = await readdir(full);
        } catch {
          // unreadable subs dir — ignore
        }
        for (const s of subNames.sort()) {
          if (!s.startsWith(".") && SUBTITLE_EXTENSIONS.has(extname(s).toLowerCase())) {
            generatedSubs.push(s);
          }
        }
      } else {
        await walk(root, full, out);
      }
    } else if (VIDEO_EXTENSIONS.has(extname(name).toLowerCase())) {
      videos.push(name);
    } else if (SUBTITLE_EXTENSIONS.has(extname(name).toLowerCase())) {
      subs.push(name);
    }
  }
  for (const v of videos) {
    const abs = join(dir, v);
    const st = await stat(abs);
    const base = v.slice(0, -extname(v).length);
    const toSidecar = (s: string, subDir: string, origin: SidecarSub["origin"]) => {
      const lang = sidecarLang(base, s);
      return lang === null
        ? null
        : { lang, path: join(subDir, s), ext: extname(s).toLowerCase(), origin };
    };
    const sidecarSubs = [
      ...subs.map((s) => toSidecar(s, dir, "external")),
      ...generatedSubs.map((s) => toSidecar(s, join(dir, "subs"), "generated")),
    ].filter((x): x is SidecarSub => x !== null);
    // Untagged sidecars ("" lang): sniff the content instead of showing "und".
    for (const s of sidecarSubs) {
      if (s.lang === "") {
        const sniffed = await sniffedSidecarLang(s.path);
        if (sniffed !== "und") s.lang = sniffed;
      }
    }
    const relPath = relative(root, abs).split("\\").join("/");
    out.push({
      id: idForRelPath(relPath),
      relPath,
      absPath: abs,
      name: basename(v),
      size: st.size,
      sidecarSubs,
    });
  }
}

// --- one-time data migration for legacy generated sidecars ---

const MIGRATION_MAX_AGE_MS = 14 * 24 * 3600 * 1000;

export interface MigrationAction {
  from: string;
  to: string;
  kind: "moved" | "renamed" | "skipped-collision";
}

/**
 * Idempotent migration, safe to run on every server start:
 *  1. `<base>.<ja|ru>.srt` NEXT to a video, mtime < 14 days old (i.e. written
 *     by an earlier app version, not by the torrent) → move into `subs/`.
 *  2. `subs/<base>.srt` without a lang suffix → rename to `subs/<base>.<lang>.srt`
 *     using content sniffing.
 * Never overwrites: on collision the file stays put (logged as skipped).
 */
export async function migrateGeneratedSidecars(root: string): Promise<MigrationAction[]> {
  const actions: MigrationAction[] = [];
  await migrateDir(root, actions);
  for (const a of actions) {
    console.log(`[migrate] ${a.kind}: ${a.from} → ${a.to}`);
  }
  return actions;
}

async function migrateDir(dir: string, actions: MigrationAction[]): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  names.sort();
  const videoBases: string[] = [];
  const subdirs: string[] = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const full = join(dir, name);
    let st;
    try {
      st = await stat(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (name.toLowerCase() !== "subs") subdirs.push(full);
    } else if (VIDEO_EXTENSIONS.has(extname(name).toLowerCase())) {
      videoBases.push(name.slice(0, -extname(name).length));
    }
  }

  const now = Date.now();
  const subsDir = join(dir, "subs");

  const moveNoClobber = async (
    from: string,
    to: string,
    kind: "moved" | "renamed",
  ): Promise<void> => {
    try {
      await stat(to);
      actions.push({ from, to, kind: "skipped-collision" });
      return; // target exists — never overwrite
    } catch {
      // target free
    }
    try {
      await mkdir(dirname(to), { recursive: true });
      await rename(from, to);
      actions.push({ from, to, kind });
    } catch (e) {
      console.warn(`[migrate] failed ${from} → ${to}: ${e}`);
    }
  };

  // 1. <base>.<ja|ru>.srt next to a video, recently written → subs/
  for (const base of videoBases) {
    for (const lang of ["ja", "ru"]) {
      const from = join(dir, `${base}.${lang}.srt`);
      let st;
      try {
        st = await stat(from);
      } catch {
        continue;
      }
      if (now - st.mtimeMs > MIGRATION_MAX_AGE_MS) continue;
      await moveNoClobber(from, join(subsDir, `${base}.${lang}.srt`), "moved");
    }
  }

  // 2. subs/<base>.srt without lang suffix → sniff + rename
  let subNames: string[] = [];
  try {
    subNames = await readdir(subsDir);
  } catch {
    subNames = [];
  }
  for (const s of subNames.sort()) {
    if (s.startsWith(".") || extname(s).toLowerCase() !== ".srt") continue;
    const stem = s.slice(0, -4);
    // already has a lang tag?
    if (/\.[A-Za-z]{2,3}(-[A-Za-z]{2,4})?$/.test(stem)) continue;
    // only files that pair with a video in this dir
    if (!videoBases.includes(stem)) continue;
    const from = join(subsDir, s);
    const lang = await sniffedSidecarLang(from);
    if (lang === "und") continue;
    await moveNoClobber(from, join(subsDir, `${stem}.${lang}.srt`), "renamed");
  }

  for (const sub of subdirs) await migrateDir(sub, actions);
}

/** In-memory library index, refreshable. */
export class Library {
  private byId = new Map<string, LibraryEntry>();
  constructor(public readonly root: string) {}

  async refresh(): Promise<LibraryEntry[]> {
    const entries = await scanLibrary(this.root);
    this.byId = new Map(entries.map((e) => [e.id, e]));
    return entries;
  }

  get(id: string): LibraryEntry | undefined {
    return this.byId.get(id);
  }

  list(): LibraryEntry[] {
    return [...this.byId.values()];
  }
}
