// Subtitle parsing (SRT / VTT / ASS) and embedded track extraction via ffmpeg.

import { stat } from "node:fs/promises";

export interface Cue {
  /** seconds */
  start: number;
  /** seconds */
  end: number;
  text: string;
}

export interface SubTrack {
  /** "embedded:<index>" or "sidecar:<lang>" */
  id: string;
  kind: "embedded" | "sidecar";
  lang: string;
  title?: string;
  codec?: string;
  path?: string;
  /** sidecar provenance: auto-generated (subs/ dir) vs user-provided file */
  origin?: "generated" | "external";
  /** stream index for embedded tracks */
  index?: number;
  /** friendly UI label, e.g. "Japanese · Whisper" */
  label?: string;
}

/** Map a raw language code to a friendly display name. */
export function languageName(code: string): string {
  switch (code.toLowerCase()) {
    case "ja":
    case "jpn":
      return "Japanese";
    case "ru":
    case "rus":
      return "Russian";
    case "en":
    case "eng":
      return "English";
    case "de":
    case "ger":
      return "German";
    default:
      return code.toUpperCase();
  }
}

/** Build the friendly "${LanguageName} · ${source}" label for a track. */
export function trackLabel(track: SubTrack): string {
  let source: string;
  if (track.kind === "embedded") {
    const title = track.title ?? "";
    source = /whisper/i.test(title) ? "Whisper" : "embedded";
  } else {
    source = track.origin === "generated" ? "generated" : "file";
  }
  return `${languageName(track.lang)} · ${source}`;
}

// --- sidecar track ids ---

export interface SidecarTrackRef {
  generated: boolean;
  lang: string;
  /** extension without dot, e.g. "srt"; undefined for legacy ids like "sidecar:ru" */
  ext?: string;
}

/**
 * Parse a sidecar track id.
 *   "sidecar:ru.srt"  → { generated: false, lang: "ru", ext: "srt" }
 *   "sidecar:ru"      → { generated: false, lang: "ru" }   (legacy, pre-ext ids)
 *   "sidecar:gen:ja"  → { generated: true, lang: "ja" }
 */
export function parseSidecarTrackId(id: string): SidecarTrackRef | null {
  if (!id.startsWith("sidecar:")) return null;
  const generated = id.startsWith("sidecar:gen:");
  const rest = id.slice(generated ? "sidecar:gen:".length : "sidecar:".length);
  const m = rest.match(/^(.+)\.(srt|vtt|ass|ssa)$/i);
  if (m) return { generated, lang: m[1]!, ext: m[2]!.toLowerCase() };
  return { generated, lang: rest };
}

// --- timestamp helpers ---

export function parseTimestamp(ts: string): number {
  // "HH:MM:SS,mmm" (srt) | "HH:MM:SS.mmm" (vtt/ass, hours optional in vtt, cs in ass)
  const m = ts.trim().match(/^(?:(\d+):)?(\d+):(\d+)[.,](\d+)$/);
  if (!m) return NaN;
  const h = m[1] ? parseInt(m[1], 10) : 0;
  const min = parseInt(m[2]!, 10);
  const s = parseInt(m[3]!, 10);
  const fracStr = m[4]!;
  const frac = parseInt(fracStr, 10) / 10 ** fracStr.length;
  return h * 3600 + min * 60 + s + frac;
}

export function formatSrtTimestamp(t: number): string {
  const ms = Math.round(t * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const rem = ms % 1000;
  const p = (n: number, w: number) => String(n).padStart(w, "0");
  return `${p(h, 2)}:${p(m, 2)}:${p(s, 2)},${p(rem, 3)}`;
}

// --- parsers ---

function stripHtmlishTags(text: string): string {
  return text.replace(/<\/?(?:b|i|u|font|ruby|rt|c)[^>]*>/gi, "").trim();
}

export function parseSrt(text: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = text.replace(/^﻿/, "").replace(/\r/g, "").split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.length > 0);
    if (lines.length < 2) continue;
    let i = 0;
    if (/^\d+$/.test(lines[0]!.trim())) i = 1;
    const timing = lines[i]?.match(/(\S+)\s*-->\s*(\S+)/);
    if (!timing) continue;
    const start = parseTimestamp(timing[1]!);
    const end = parseTimestamp(timing[2]!);
    if (Number.isNaN(start) || Number.isNaN(end)) continue;
    const body = lines.slice(i + 1).join("\n");
    const cleaned = stripHtmlishTags(body);
    if (cleaned) cues.push({ start, end, text: cleaned });
  }
  return cues;
}

export function parseVtt(text: string): Cue[] {
  // VTT is close enough to SRT after dropping the header and cue settings.
  const body = text
    .replace(/^﻿/, "")
    .replace(/\r/g, "")
    .replace(/^WEBVTT[^\n]*\n/, "")
    .replace(/-->\s*([\d:.]+)[^\n]*/g, "--> $1");
  return parseSrt(body);
}

export function parseAss(text: string): Cue[] {
  const cues: Cue[] = [];
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  let format: string[] | null = null;
  for (const line of lines) {
    if (line.startsWith("Format:")) {
      format = line
        .slice("Format:".length)
        .split(",")
        .map((f) => f.trim());
    } else if (line.startsWith("Dialogue:") && format) {
      const parts = line.slice("Dialogue:".length).split(",");
      const textIdx = format.indexOf("Text");
      if (textIdx === -1 || parts.length <= textIdx) continue;
      const get = (field: string) => {
        const i = format!.indexOf(field);
        return i >= 0 ? parts[i]?.trim() ?? "" : "";
      };
      const start = parseTimestamp(get("Start"));
      const end = parseTimestamp(get("End"));
      if (Number.isNaN(start) || Number.isNaN(end)) continue;
      // Text is everything from textIdx on (it may itself contain commas).
      let body = parts.slice(textIdx).join(",");
      body = body
        .replace(/\{[^}]*\}/g, "") // override tags
        .replace(/\\N|\\n/g, "\n")
        .replace(/\\h/g, " ")
        .trim();
      if (body) cues.push({ start, end, text: body });
    }
  }
  cues.sort((a, b) => a.start - b.start);
  return cues;
}

export function parseSubtitleText(text: string, ext: string): Cue[] {
  switch (ext.replace(/^\./, "").toLowerCase()) {
    case "vtt":
      return parseVtt(text);
    case "ass":
    case "ssa":
      return parseAss(text);
    default:
      return parseSrt(text);
  }
}

// --- whisper anti-hallucination: collapse repeated-cue runs ---

/** Normalization for repeat detection: trim + strip JP/ASCII punctuation. */
function repeatNorm(text: string): string {
  const norm = text
    .replace(/[。、．，！？!?…‥・「」『』（）()\[\]【】《》〈〉“”"'’〜~ー―\-—♪♫♬♩〽\s]/g, "")
    .trim();
  // Pure punctuation/music cues (♪~) normalize to "": fall back to the trimmed
  // text so note-spam loops are still detected as runs.
  return norm !== "" ? norm : text.trim();
}

/** Near-duplicate check for hallucination runs: identical after punctuation
 * stripping, or one is a substring of the other (whisper loops often drift by
 * a trailing particle / honorific, e.g. おれきほうたろお vs おれきほうたろお殿). */
function repeatNear(a: string, b: string): boolean {
  if (a === "" || b === "") return a === b;
  return a === b || a.includes(b) || b.includes(a);
}

/** Cap for the single cue kept from a collapsed hallucination run. The old
 * behavior merged the whole run into one cue spanning minutes, which papered
 * over the fact that the underlying audio was never really transcribed. */
const COLLAPSED_CUE_MAX_SEC = 10;

/**
 * Whisper hallucinates on music/silence by repeating the same phrase as many
 * consecutive cues. Collapse a run of consecutive identically-normalized cues
 * into ONE cue spanning the whole run — but only when the run looks like a
 * hallucination: length >= `minRun` (default 4), or a 3-run stretching over
 * `spanSec` (default 20s) of wall time. Short 3-runs are kept, because real
 * dialogue legitimately repeats (待って！待って！待って！).
 */
export function collapseRepeatedCues(cues: Cue[], minRun = 4, spanSec = 20): Cue[] {
  const out: Cue[] = [];
  let i = 0;
  while (i < cues.length) {
    const norm = repeatNorm(cues[i]!.text);
    let j = i + 1;
    while (j < cues.length && norm !== "" && repeatNear(repeatNorm(cues[j]!.text), norm)) j++;
    const run = j - i;
    const span = cues[j - 1]!.end - cues[i]!.start;
    if (run >= minRun || (run >= 3 && span > spanSec)) {
      // Keep only the first occurrence, duration-capped. Do NOT stretch it over
      // the whole run: a loop spanning minutes means whisper never transcribed
      // that audio — leave a visible gap so findCoverageHoles() can trigger a
      // repair pass instead of hiding an 11-minute hole inside one mega-cue.
      const first = cues[i]!;
      out.push({
        start: first.start,
        end: Math.min(first.end, first.start + COLLAPSED_CUE_MAX_SEC),
        text: first.text,
      });
    } else {
      for (let k = i; k < j; k++) out.push(cues[k]!);
    }
    i = j;
  }
  return out;
}

export interface CoverageHole {
  start: number;
  end: number;
}

/**
 * Find stretches of `minGapSec`+ seconds with no cues, including a hole at the
 * head and (minus `tailSlackSec` for credits/ED) at the tail. Input cues must
 * be in start order (whisper output is).
 */
export function findCoverageHoles(
  cues: Cue[],
  durationSec: number,
  minGapSec = 45,
  tailSlackSec = 30,
): CoverageHole[] {
  const holes: CoverageHole[] = [];
  let covered = 0;
  for (const c of cues) {
    if (c.start - covered >= minGapSec) holes.push({ start: covered, end: c.start });
    covered = Math.max(covered, c.end);
  }
  const tail = durationSec - tailSlackSec;
  if (tail - covered >= minGapSec) holes.push({ start: covered, end: durationSec });
  return holes;
}

export function cuesToSrt(cues: Cue[]): string {
  return (
    cues
      .map(
        (c, i) =>
          `${i + 1}\n${formatSrtTimestamp(c.start)} --> ${formatSrtTimestamp(c.end)}\n${c.text}`,
      )
      .join("\n\n") + "\n"
  );
}

// --- embedded tracks via ffmpeg/ffprobe ---

interface FfprobeStream {
  index: number;
  codec_type: string;
  codec_name?: string;
  tags?: Record<string, string>;
}

export async function probeStreams(file: string): Promise<FfprobeStream[]> {
  const proc = Bun.spawn(
    ["ffprobe", "-v", "error", "-print_format", "json", "-show_streams", file],
    { stdout: "pipe", stderr: "pipe" },
  );
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) throw new Error(`ffprobe failed for ${file}`);
  const data = JSON.parse(out) as { streams?: FfprobeStream[] };
  return data.streams ?? [];
}

export async function listEmbeddedSubTracks(file: string): Promise<SubTrack[]> {
  const streams = await probeStreams(file);
  return streams
    .filter((s) => s.codec_type === "subtitle")
    .map((s) => {
      const lang = (s.tags?.language ?? s.tags?.LANGUAGE ?? "und").toLowerCase();
      const t: SubTrack = {
        id: `embedded:${s.index}`,
        kind: "embedded",
        lang,
        index: s.index,
      };
      const title = s.tags?.title ?? s.tags?.TITLE;
      if (title !== undefined) t.title = title;
      if (s.codec_name !== undefined) t.codec = s.codec_name;
      return t;
    });
}

// In-memory cache of extracted embedded tracks, keyed by path+index+size+mtime
// — demuxing the whole MKV on every track switch is slow. Small FIFO cap.
const extractCache = new Map<string, string>();
const EXTRACT_CACHE_MAX = 20;

/** Extract an embedded subtitle stream as SRT text (cached). */
export async function extractEmbeddedTrack(
  file: string,
  streamIndex: number,
): Promise<string> {
  let key: string | null = null;
  try {
    const st = await stat(file);
    key = `${file}:${streamIndex}:${st.size}:${st.mtimeMs}`;
    const hit = extractCache.get(key);
    if (hit !== undefined) return hit;
  } catch {
    // unstatable — extract uncached (ffmpeg will report the real error)
  }
  const proc = Bun.spawn(
    [
      "ffmpeg",
      "-v",
      "error",
      "-i",
      file,
      "-map",
      `0:${streamIndex}`,
      "-f",
      "srt",
      "-",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`ffmpeg subtitle extraction failed: ${err.slice(0, 300)}`);
  }
  if (key != null) {
    while (extractCache.size >= EXTRACT_CACHE_MAX) {
      const oldest = extractCache.keys().next().value;
      if (oldest === undefined) break;
      extractCache.delete(oldest);
    }
    extractCache.set(key, out);
  }
  return out;
}
