// jimaku.cc API client — subtitle directory for anime (AniList/TMDB-backed).
//
// API shape (from https://jimaku.cc/api/openapi.json, version "beta"):
//   GET /api/entries/search?query=&anilist_id=&tmdb_id=&anime=  → Entry[]
//   GET /api/entries/{id}                                       → Entry
//   GET /api/entries/{id}/files?episode=                        → FileEntry[]
// Auth: raw API key in the `Authorization` header (no "Bearer" prefix).
// Rate limits: 429 + x-ratelimit-* headers.
//
// API key comes from JIMAKU_API_KEY — process env first, then ~/.env
// (same dotenv format/loader as the Gemini key, see env.ts).

import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { parseEnvText } from "./env.ts";

const BASE_URL = "https://jimaku.cc";

export interface JimakuEntryFlags {
  adult?: boolean;
  anime?: boolean;
  external?: boolean;
  movie?: boolean;
  unverified?: boolean;
}

export interface JimakuEntry {
  id: number;
  /** Romaji name. */
  name: string;
  english_name: string | null;
  japanese_name: string | null;
  anilist_id: number | null;
  /** "tv:1234" or "movie:1234". */
  tmdb_id: string | null;
  flags: JimakuEntryFlags;
  /** RFC3339 timestamp of the newest uploaded file. */
  last_modified: string;
  notes?: string | null;
}

export interface JimakuFile {
  /** Download URL. */
  url: string;
  name: string;
  /** Bytes. */
  size: number;
  /** RFC3339, UTC. */
  last_modified: string;
}

export class JimakuError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    /** jimaku ApiError.code when the body was parseable, else undefined. */
    public readonly code?: number,
    /** seconds to wait, from x-ratelimit-reset-after on 429s. */
    public readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = "JimakuError";
  }
}

/**
 * Resolve the jimaku API key: process.env.JIMAKU_API_KEY, then ~/.env.
 * Not cached so tests (and key rotation) behave predictably.
 */
export async function loadJimakuApiKey(envPath?: string): Promise<string | undefined> {
  if (process.env.JIMAKU_API_KEY) return process.env.JIMAKU_API_KEY;
  try {
    const text = await Bun.file(envPath ?? join(homedir(), ".env")).text();
    return parseEnvText(text)["JIMAKU_API_KEY"];
  } catch {
    return undefined;
  }
}

export interface JimakuClientOptions {
  apiKey?: string;
  baseUrl?: string;
}

async function apiGet(path: string, opts: JimakuClientOptions = {}): Promise<unknown> {
  const apiKey = opts.apiKey ?? (await loadJimakuApiKey());
  if (!apiKey) {
    throw new JimakuError("JIMAKU_API_KEY not set (env or ~/.env)", 401);
  }
  const res = await fetch((opts.baseUrl ?? BASE_URL) + path, {
    headers: { Authorization: apiKey, Accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    let message = `jimaku ${path} failed: HTTP ${res.status}`;
    let code: number | undefined;
    try {
      const body = (await res.json()) as { error?: string; code?: number };
      if (body.error) message = `jimaku ${path} failed: ${body.error}`;
      code = body.code;
    } catch {
      // non-JSON error body — keep the HTTP status message
    }
    const resetAfter = Number(res.headers.get("x-ratelimit-reset-after"));
    throw new JimakuError(
      message,
      res.status,
      code,
      res.status === 429 && Number.isFinite(resetAfter) ? resetAfter : undefined,
    );
  }
  return res.json();
}

export interface SearchOptions {
  /** Fuzzy name search. */
  query?: string;
  anilistId?: number;
  /** "tv:1234" / "movie:1234". */
  tmdbId?: string;
  /** Restrict to anime entries (server default: true). */
  anime?: boolean;
}

/**
 * GET /api/entries/search — by fuzzy name and/or AniList/TMDB id.
 * Accepts a plain string as shorthand for { query }.
 */
export async function searchEntries(
  search: string | SearchOptions,
  opts: JimakuClientOptions = {},
): Promise<JimakuEntry[]> {
  const s: SearchOptions = typeof search === "string" ? { query: search } : search;
  const params = new URLSearchParams();
  if (s.query !== undefined) params.set("query", s.query);
  if (s.anilistId !== undefined) params.set("anilist_id", String(s.anilistId));
  if (s.tmdbId !== undefined) params.set("tmdb_id", s.tmdbId);
  if (s.anime !== undefined) params.set("anime", String(s.anime));
  if ([...params.keys()].length === 0) {
    throw new JimakuError("searchEntries needs query, anilistId or tmdbId", 400);
  }
  return (await apiGet(`/api/entries/search?${params}`, opts)) as JimakuEntry[];
}

/** GET /api/entries/{id}/files — optionally filtered by episode number. */
export async function listFiles(
  entryId: number,
  episode?: number,
  opts: JimakuClientOptions = {},
): Promise<JimakuFile[]> {
  const qs = episode !== undefined ? `?episode=${episode}` : "";
  return (await apiGet(`/api/entries/${entryId}/files${qs}`, opts)) as JimakuFile[];
}

/**
 * Download a file (FileEntry.url) to destPath, creating parent dirs.
 * Sends the Authorization header. Returns bytes written.
 */
export async function downloadFile(
  url: string,
  destPath: string,
  opts: JimakuClientOptions = {},
): Promise<number> {
  const apiKey = opts.apiKey ?? (await loadJimakuApiKey());
  const res = await fetch(url, {
    headers: apiKey ? { Authorization: apiKey } : {},
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    throw new JimakuError(`jimaku download failed: HTTP ${res.status}`, res.status);
  }
  await mkdir(dirname(destPath), { recursive: true });
  const bytes = new Uint8Array(await res.arrayBuffer());
  await Bun.write(destPath, bytes);
  return bytes.byteLength;
}
