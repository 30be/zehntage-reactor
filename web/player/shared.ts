// Shared Player plumbing: module-level caches, popup/QA types, small pure
// helpers. Extracted from Player.tsx (no behavior changes).

import type { Cue, SubTrackInfo, WordLookup } from "../api.ts";
import type { KToken } from "../tokenizer.ts";

export interface PopupState {
  kind: "word" | "sentence";
  surface: string; // the word, or the whole JP sentence for kind="sentence"
  reading?: string;
  x: number; // horizontal center of the anchored word (viewport coords)
  y: number; // top edge of the anchored word
  anchorBottom: number; // bottom edge of the anchored word
  context: string;
  secondary?: string; // RU cue text shown at the same time (sentence panels)
  dictForm?: string; // basic_form when it differs from the surface (e.g. 食べる)
  pos?: string; // the token's 品詞 (KToken.pos) — POS-aware matchFront veto, so
  // the popup's deck-match AGREES with the subtitle token coloring (a 名詞
  // mis-read on/kun like 色 inside バラ色 matches its single いろ card in both).
  timestamp: number;
  // The plain cue text at popup-open time: card context + frame/audio capture
  // stay coherent with what the user looked at, even if playback moved on
  // while the (pinned) popup stayed open.
  cueText: string;
}

export interface QaItem {
  q: string;
  a: string | null; // null while loading
}

export const HOVER_OPEN_MS = 200; // hover-intent: rest this long before opening/looking up
export const HOVER_CLOSE_MS = 120; // grace after leaving the word before hiding

// Module-level cue-token cache: tokenization results survive popup churn AND
// episode changes (the kuromoji instance already does — getTokenizer() memos
// its promise). Keyed by cue text; FIFO-capped.
const cueTokenCache = new Map<string, KToken[]>();
const CUE_TOKEN_CACHE_MAX = 2000;

export function cueTokensGet(text: string): KToken[] | undefined {
  return cueTokenCache.get(text);
}

export function cueTokensPut(text: string, toks: KToken[]): void {
  if (!cueTokenCache.has(text) && cueTokenCache.size >= CUE_TOKEN_CACHE_MAX) {
    const oldest = cueTokenCache.keys().next().value;
    if (oldest !== undefined) cueTokenCache.delete(oldest);
  }
  cueTokenCache.set(text, toks);
}

/**
 * Tokenize a cue text via the module-level cache: returns the cached tokens for
 * a repeated cue text, else tokenizes once and stores. Same FIFO cache the
 * visible-overlay path uses — episode-wide passes (cueUnknowns / dueCue /
 * coverage) reuse it instead of re-running kuromoji on every deck change.
 */
export function tokenizeCue(
  tok: { tokenize: (text: string) => KToken[] },
  text: string,
): KToken[] {
  const cached = cueTokensGet(text);
  if (cached) return cached;
  const toks = tok.tokenize(text);
  cueTokensPut(text, toks);
  return toks;
}

// Module-level Q/A history cache so the ask… thread survives popup close/
// reopen, keyed by kind + word/sentence + context. FIFO-capped at ~100.
const qaCache = new Map<string, QaItem[]>();
const QA_CACHE_MAX = 100;

export function qaCacheGet(key: string): QaItem[] | undefined {
  return qaCache.get(key);
}

export function qaCachePut(key: string, items: QaItem[]): void {
  if (!qaCache.has(key) && qaCache.size >= QA_CACHE_MAX) {
    const oldest = qaCache.keys().next().value;
    if (oldest !== undefined) qaCache.delete(oldest);
  }
  qaCache.set(key, items);
}

/** prev/current/next cue texts with the current line marked, for Gemini. */
export function markedContext(cues: Cue[], i: number): string {
  if (i < 0 || !cues[i]) return "";
  const lines: string[] = [];
  if (cues[i - 1]) lines.push(`(prev) ${cues[i - 1]!.text}`);
  lines.push(`(current) ${cues[i]!.text}`);
  if (cues[i + 1]) lines.push(`(next) ${cues[i + 1]!.text}`);
  return lines.join("\n");
}

// --- per-media primary/secondary track persistence (localStorage) ---

const STORAGE_PREFIX = "zr.tracks.";

export function readSavedTracks(
  mediaId: string,
): { primary?: string; secondary?: string } {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + mediaId);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function saveTracks(
  mediaId: string,
  primary: string,
  secondary: string,
): void {
  try {
    localStorage.setItem(
      STORAGE_PREFIX + mediaId,
      JSON.stringify({ primary, secondary }),
    );
  } catch {
    /* ignore quota / disabled storage */
  }
}

export function langLabel(t: SubTrackInfo): string {
  // Prefer the backend-provided friendly label ("Japanese · Whisper").
  if (t.label && t.label.trim()) return t.label;
  // Fallback: plain lang code (+ title if present). No sidecar/embedded jargon.
  return t.title ? `${t.lang} · ${t.title}` : t.lang;
}

export const fmtTime = (s: number): string => {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
};

/** Fill a popup lookup from an existing Anki card ("word [reading]" front). */
export function deckCardToLookup(card: {
  front: string;
  back: string;
  notes: string;
}): WordLookup {
  const m = card.front.match(/^(.+?)\s*\[(.+?)\]\s*$/);
  return {
    reading: m?.[2] ?? "",
    translation: card.back,
    notes: card.notes ?? "",
    context: "",
  };
}
