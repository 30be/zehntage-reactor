import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { join, relative, basename, extname } from "node:path";
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

// Cache of embedded subtitle-track langs, keyed by path+size+mtime so repeated
// /api/library calls don't re-probe 22 files on every request.
const embeddedLangCache = new Map<string, string[]>();

/**
 * Languages of EMBEDDED subtitle tracks for a video file, cached by
 * path + size + mtime. Returns raw lang codes (e.g. "jpn"). On probe failure
 * (or non-probeable file) returns [] and caches that.
 */
export async function embeddedSubLangs(absPath: string): Promise<string[]> {
  let key: string;
  try {
    const st = await stat(absPath);
    key = embeddedCacheKey(absPath, st.size, st.mtimeMs);
  } catch {
    return [];
  }
  const hit = embeddedLangCache.get(key);
  if (hit) return hit;
  let langs: string[] = [];
  try {
    const tracks = await listEmbeddedSubTracks(absPath);
    langs = tracks.map((t) => t.lang);
  } catch {
    langs = [];
  }
  embeddedLangCache.set(key, langs);
  return langs;
}

/** Sidecar + embedded sub languages for an entry (raw codes, deduped). */
export async function subLangsFor(entry: LibraryEntry): Promise<string[]> {
  const langs = new Set<string>();
  for (const s of entry.sidecarSubs) langs.add(s.lang || "und");
  for (const l of await embeddedSubLangs(entry.absPath)) langs.add(l);
  return [...langs];
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
