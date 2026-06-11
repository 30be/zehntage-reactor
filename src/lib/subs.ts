// Subtitle parsing (SRT / VTT / ASS) and embedded track extraction via ffmpeg.

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
  /** stream index for embedded tracks */
  index?: number;
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

/** Extract an embedded subtitle stream as SRT text. */
export async function extractEmbeddedTrack(
  file: string,
  streamIndex: number,
): Promise<string> {
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
  return out;
}
