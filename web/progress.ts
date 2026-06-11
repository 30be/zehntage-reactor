// Map Anki learning progress to a RED -> GREEN underline color.

import type { AnkiWord, ProgressEntry } from "./api.ts";
import { kataToHira } from "./tokenizer.ts";

export interface WordIndex {
  // normalized surface (and "surface [reading]") -> front
  byKey: Map<string, string>;
  progress: Record<string, ProgressEntry>;
}

export function buildWordIndex(
  words: AnkiWord[],
  progress: Record<string, ProgressEntry>,
): WordIndex {
  const byKey = new Map<string, string>();
  for (const w of words) {
    const front = w.front;
    byKey.set(front, front);
    // front is "word" or "word [reading]" — index both the bare word and full.
    const m = front.match(/^(.+?)\s*\[(.+?)\]\s*$/);
    if (m) {
      byKey.set(m[1]!.trim(), front);
    }
  }
  return { byKey, progress };
}

/** Find the matching Anki front for a surface form (+ optional reading). */
export function matchFront(
  idx: WordIndex,
  surface: string,
  reading?: string,
): string | null {
  if (idx.byKey.has(surface)) return idx.byKey.get(surface)!;
  if (reading) {
    const hira = kataToHira(reading);
    const withReading = `${surface} [${hira}]`;
    if (idx.byKey.has(withReading)) return idx.byKey.get(withReading)!;
    if (idx.byKey.has(`${surface} [${reading}]`))
      return idx.byKey.get(`${surface} [${reading}]`)!;
  }
  return null;
}

/**
 * Color for a known word. No progress entry => "learning" red.
 * Maturity derived from interval (days) primarily, reps as fallback.
 * 0 => red (#ef4444), mature (>=21d) => green (#22c55e).
 */
export function progressColor(p?: ProgressEntry): string {
  if (!p) return "#ef4444"; // learning, no SRS data
  // queue/type: new(0)/learning -> red end. Use interval as the main signal.
  const days = Math.max(0, p.interval || 0);
  // Reps give a little nudge when interval is still tiny.
  const repNudge = Math.min(1, (p.reps || 0) / 8) * 5;
  const effective = days + repNudge;
  const t = Math.max(0, Math.min(1, effective / 21)); // 0..1 over ~3 weeks
  return lerpColor("#ef4444", "#22c55e", t);
}

function lerpColor(a: string, b: string, t: number): string {
  const pa = hexToRgb(a);
  const pb = hexToRgb(b);
  const r = Math.round(pa[0] + (pb[0] - pa[0]) * t);
  const g = Math.round(pa[1] + (pb[1] - pa[1]) * t);
  const bl = Math.round(pa[2] + (pb[2] - pa[2]) * t);
  return `rgb(${r}, ${g}, ${bl})`;
}

function hexToRgb(h: string): [number, number, number] {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
