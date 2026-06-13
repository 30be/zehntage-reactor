// localStorage-backed cache for /api/anki/words with ETag revalidation.
//
// Goal: known-word underlines on the FIRST tokenized paint. The Anki payload
// is slow to build server-side (remote anki-mcp or AnkiConnect over the whole
// deck), so:
//   1. the last payload persists in localStorage (zr.ankiCache) — minus the
//      heavy `context` field, so 10k cards stay well under the quota;
//   2. getAnkiWords() resolves synchronously-fast from that cache and
//      revalidates in the background with If-None-Match (304 = free);
//   3. optimistic add/delete write through to the cache, so a reload right
//      after mining still underlines instantly.

import { useEffect, useState } from "react";
import type { AnkiWord, AnkiWordsResponse, ProgressEntry } from "./api.ts";
import { tmEvent } from "./telemetry.ts";

const KEY = "zr.ankiCache";
/** Stay below typical 5MB localStorage quotas; skip persisting if bigger. */
const MAX_BYTES = 4_000_000;

interface StoredCache {
  ts: number;
  etag: string | null;
  data: AnkiWordsResponse;
}

type Listener = (data: AnkiWordsResponse) => void;
const listeners = new Set<Listener>();

/** Subscribe to fresh payloads (network revalidation or optimistic writes). */
export function subscribeAnkiWords(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify(data: AnkiWordsResponse): void {
  for (const fn of listeners) fn(data);
}

export function readAnkiCache(): StoredCache | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredCache;
    if (!parsed || !Array.isArray(parsed.data?.words)) return null;
    if (!parsed.data.progress || typeof parsed.data.progress !== "object")
      parsed.data.progress = {};
    return parsed;
  } catch {
    return null;
  }
}

/** Drop the heavy per-card `context` (frames/audio HTML) before persisting.
 * front/back/notes are all the UI needs from the cached deck. */
function slim(data: AnkiWordsResponse): AnkiWordsResponse {
  return {
    words: data.words.map((w) => ({
      front: w.front,
      back: w.back ?? "",
      notes: w.notes ?? "",
      context: "",
    })),
    progress: data.progress ?? {},
  };
}

function writeAnkiCache(data: AnkiWordsResponse, etag: string | null): void {
  try {
    const stored: StoredCache = { ts: Date.now(), etag, data: slim(data) };
    const raw = JSON.stringify(stored);
    if (raw.length > MAX_BYTES) {
      // Too big to persist — drop any stale copy and fall back to network-only.
      localStorage.removeItem(KEY);
      return;
    }
    localStorage.setItem(KEY, raw);
  } catch {
    // Quota/serialization failure — cache is best-effort, network still works.
  }
}

let inflight: Promise<AnkiWordsResponse> | null = null;

/** Fetch /api/anki/words with If-None-Match; update cache + notify on change. */
function revalidate(): Promise<AnkiWordsResponse> {
  if (!inflight) {
    inflight = (async () => {
      const cached = readAnkiCache();
      const headers: Record<string, string> = {};
      if (cached?.etag) headers["If-None-Match"] = cached.etag;
      const _ankiT0 = Date.now();
      const r = await fetch("/api/anki/words", { headers });
      tmEvent("perf.client.anki_hydrate", { ms: Date.now() - _ankiT0, status: r.status });
      if (r.status === 304 && cached) {
        writeAnkiCache(cached.data, cached.etag); // bump ts
        return cached.data;
      }
      if (!r.ok) throw new Error(`/api/anki/words → ${r.status}`);
      const body = (await r.json()) as {
        words?: AnkiWord[];
        progress?: Record<string, ProgressEntry> | null;
      };
      const data: AnkiWordsResponse = {
        words: body.words ?? [],
        progress: body.progress ?? {},
      };
      writeAnkiCache(data, r.headers.get("ETag"));
      notify(data);
      return data;
    })().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

/**
 * Stale-while-revalidate entry point (used by api.ankiWords): resolves
 * immediately from localStorage when possible, refreshes in the background.
 */
export function getAnkiWords(): Promise<AnkiWordsResponse> {
  const cached = readAnkiCache();
  if (cached) {
    void revalidate().catch(() => {});
    return Promise.resolve(cached.data);
  }
  return revalidate();
}

/** Force a fresh fetch (after a server-side mutation busted the server cache). */
export function refreshAnkiWords(): Promise<AnkiWordsResponse> {
  return revalidate();
}

/** Optimistic write-through after a successful add: the word underlines
 * survive an immediate reload without waiting for the network. */
export function cacheAddWord(word: string, reading: string, back: string, notes = ""): void {
  // No persisted cache yet (first session / cleared storage / >quota deck):
  // start one from the optimistic word so the underline survives a reload and
  // the notify channel still fires. ETag null → next fetch is a full 200.
  const cached =
    readAnkiCache() ??
    ({ ts: 0, etag: null, data: { words: [], progress: {} } } as StoredCache);
  const front = reading ? `${word} [${reading}]` : word;
  if (!cached.data.words.some((w) => w.front === front)) {
    cached.data.words.push({ front, back, notes, context: "" });
  }
  // etag is now stale by construction — clear it so the next fetch gets a 200.
  writeAnkiCache(cached.data, null);
  notify(cached.data);
}

/** Optimistic write-through after a successful delete. */
export function cacheDeleteWord(front: string): void {
  const cached = readAnkiCache();
  if (!cached) return;
  cached.data.words = cached.data.words.filter((w) => w.front !== front);
  delete cached.data.progress[front];
  writeAnkiCache(cached.data, null);
  notify(cached.data);
}

// Live-updating deck hook: components re-render when a background
// revalidation or an optimistic write lands (Player.tsx is the main user).
export function useAnkiWordsLive(): AnkiWordsResponse | null {
  const [data, setData] = useState<AnkiWordsResponse | null>(() => readAnkiCache()?.data ?? null);
  useEffect(() => subscribeAnkiWords(setData), []);
  return data;
}
