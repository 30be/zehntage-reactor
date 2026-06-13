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
import { guessEpisode } from "./episode.ts";

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

/** Backoff delays (ms) for retries when no Retry-After header is present. */
const BACKOFF_MS = [2_000, 5_000, 15_000] as const;
const MAX_RETRY_AFTER_MS = 60_000;

function isRetryable(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

async function apiGet(path: string, opts: JimakuClientOptions = {}): Promise<unknown> {
  const apiKey = opts.apiKey ?? (await loadJimakuApiKey());
  if (!apiKey) {
    throw new JimakuError("JIMAKU_API_KEY not set (env or ~/.env)", 401);
  }

  let lastError: JimakuError | undefined;

  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
    const res = await fetch((opts.baseUrl ?? BASE_URL) + path, {
      headers: { Authorization: apiKey, Accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });

    if (res.ok) {
      return res.json();
    }

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
    const retryAfterSec =
      res.status === 429 && Number.isFinite(resetAfter) ? resetAfter : undefined;

    lastError = new JimakuError(message, res.status, code, retryAfterSec);

    // Non-retryable 4xx (e.g. 401, 403, 404) — fail fast, no retry.
    if (!isRetryable(res.status)) {
      throw lastError;
    }

    // Exhausted retries — throw to let caller fall back to whisper.
    if (attempt === BACKOFF_MS.length) {
      throw lastError;
    }

    // Wait before next attempt: honour Retry-After (capped), else use backoff table.
    const waitMs =
      retryAfterSec !== undefined
        ? Math.min(retryAfterSec * 1_000, MAX_RETRY_AFTER_MS)
        : BACKOFF_MS[attempt]!;

    await new Promise((r) => setTimeout(r, waitMs));
  }

  // Unreachable, but TypeScript needs a return path.
  throw lastError!;
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

// --- Confident-match helpers (pure; no network) -----------------------------
// Used to decide whether an auto-fetched human JA sub from jimaku TRULY matches
// a local video. Only confident matches are accepted; whisper stays the
// fallback. The caller already holds `entries` from searchEntries.

/**
 * Normalize a title for fuzzy comparison: lowercase, drop non-alphanumerics,
 * collapse whitespace. Latin + kana/kanji survive.
 */
export function normTitle(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Token containment overlap of two normalized titles, 0..1. */
function tokenOverlap(a: string, b: string): number {
  const ta = new Set(normTitle(a).split(" ").filter(Boolean));
  const tb = new Set(normTitle(b).split(" ").filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / Math.min(ta.size, tb.size); // containment, not symmetric Jaccard
}

export interface ConfidentMatch {
  entry: JimakuEntry;
  /** best name overlap, 0..1 */
  score: number;
  /** 2nd-best score (dominance check) */
  runnerUp: number;
  /** human-readable why-accepted, for logging */
  reason: string;
}

/**
 * Pick a CONFIDENT jimaku entry for a local video, or null.
 * Heuristic (all must hold):
 *  - name overlap: query vs the best of {name, english_name, japanese_name}
 *    >= NAME_OVERLAP_MIN (0.8);
 *  - dominant candidate: best - runnerUp >= DOMINANCE_MIN (0.34), OR only one
 *    candidate scored >= NAME_OVERLAP_MIN;
 *  - not adult.
 *
 * Thresholds rationale: 0.8 containment tolerates a missing season word; 0.34
 * dominance ~= "best beats runner-up by a third of its tokens", which separates
 * a real hit from a same-franchise sibling. Tune via the logged `reason`.
 *
 * Episode pinning (the "pinned-both-sides" rule) is enforced LATER, in the
 * caller, by listing files with `episode=` AND confirming the chosen file name
 * also carries that episode number (see `fileMatchesEpisode`).
 *
 * @param query a normalized local filename (e.g. from `jimakuQueryFromName`).
 */
export function pickConfidentEntry(
  query: string,
  entries: JimakuEntry[],
): ConfidentMatch | null {
  const NAME_OVERLAP_MIN = 0.8;
  const DOMINANCE_MIN = 0.34;
  const candidates = entries.filter((e) => !e.flags.adult);

  // Exact-name preference: if exactly ONE candidate has a normalized name
  // (name/english_name/japanese_name) equal to the normalized query, pick it
  // outright. This breaks containment-dominance ties between an exact series
  // and a longer franchise sibling (e.g. "Hyouka" vs "Hyouka: Motsubeki...").
  const nq = normTitle(query);
  const exact = candidates.filter((e) =>
    [e.name, e.english_name, e.japanese_name]
      .filter((n): n is string => !!n)
      .some((n) => normTitle(n) === nq),
  );
  if (exact.length === 1) {
    return {
      entry: exact[0]!,
      score: 1,
      runnerUp: 0,
      reason: `exact-name match "${nq}"`,
    };
  }

  const scored = candidates
    .map((e) => {
      const score = Math.max(
        tokenOverlap(query, e.name),
        e.english_name ? tokenOverlap(query, e.english_name) : 0,
        e.japanese_name ? tokenOverlap(query, e.japanese_name) : 0,
      );
      return { entry: e, score };
    })
    .sort((a, b) => b.score - a.score);
  if (scored.length === 0) return null;
  const best = scored[0]!;
  const runnerUp = scored[1]?.score ?? 0;
  if (best.score < NAME_OVERLAP_MIN) return null;
  const dominant =
    best.score - runnerUp >= DOMINANCE_MIN ||
    scored.filter((s) => s.score >= NAME_OVERLAP_MIN).length === 1;
  if (!dominant) return null;
  return {
    entry: best.entry,
    score: best.score,
    runnerUp,
    reason: `name=${best.score.toFixed(2)} runnerUp=${runnerUp.toFixed(2)}`,
  };
}

/** True if the jimaku file name plausibly carries this episode number. */
export function fileMatchesEpisode(fileName: string, episode: number): boolean {
  return guessEpisode(fileName) === episode;
}

// --- candidate ordering (Japanese-track selection) --------------------------
// jimaku entries frequently carry Chinese fansub uploads (星空字幕组 / XKsub:
// Chinese text + ASS vector typesetting) alongside or instead of real JA subs.
// Order candidates best-first so the language guard downstream rarely has to
// reject; if the best truly is Chinese, the kana guard is the hard backstop.

/** Signals (in the filename) that a sub is Japanese — boosts rank. */
const JA_HINT = /(?:^|[._\-\s\[(])(?:ja|jp|jpn)(?:[._\-\s\])]|$)|日本語/i;
/** Signals that a sub is Chinese (or otherwise non-JA) — demotes rank. */
const CN_HINT =
  /(?:^|[._\-\s\[(])(?:chs|cht|sc|tc|zh|zh-?(?:cn|hk|tw)|gb|big5)(?:[._\-\s\])]|$)|中文|简体|繁體|简|繁|星空|xksub/i;

/**
 * Score a single jimaku filename for "likely Japanese dialogue", higher = better.
 *  +format: text formats (srt/vtt) over styled (ass/ssa) — less typesetting noise;
 *  +language: explicit JA hint boosts, CN hint penalizes (penalty dominates a
 *   format bonus so a CN .srt never outranks a JA .ass).
 */
export function scoreJimakuCandidate(fileName: string): number {
  let score = 0;
  if (/\.(srt|vtt)$/i.test(fileName)) score += 2;
  else if (/\.(ass|ssa)$/i.test(fileName)) score += 0;
  if (JA_HINT.test(fileName)) score += 10;
  if (CN_HINT.test(fileName)) score -= 20;
  return score;
}

/**
 * Order subtitle files best-first for JA selection. Pure & stable: ties keep the
 * original (server) order. Only `.srt/.vtt/.ass/.ssa` are considered subs.
 */
export function rankJimakuCandidates<T extends { name: string }>(files: T[]): T[] {
  return files
    .filter((f) => /\.(srt|ass|ssa|vtt)$/i.test(f.name))
    .map((f, i) => ({ f, i, s: scoreJimakuCandidate(f.name) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.f);
}
