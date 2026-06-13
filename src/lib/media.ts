// Range-aware media serving + codec compatibility check via ffprobe.

import { stat, mkdir, mkdtemp, rm, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { probeStreams } from "./subs.ts";

const CONTENT_TYPES: Record<string, string> = {
  ".mkv": "video/x-matroska",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
};

/**
 * Duration of any media file (mkv, mp4, etc.) in seconds via ffprobe.
 * Returns 0 if ffprobe cannot determine the duration.
 * Used by the jimaku quality/sync gate: coverage = lastCueEnd / mediaDuration.
 * Rejects on ffprobe spawn failure; callers should catch and fall back to whisper.
 */
export async function mediaDurationSec(path: string): Promise<number> {
  const proc = Bun.spawn(
    ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
    { stdout: "pipe", stderr: "ignore" },
  );
  // Drain stdout fully to avoid pipe deadlock before awaiting exit.
  const out = await new Response(proc.stdout as ReadableStream).text();
  await proc.exited;
  const sec = Number.parseFloat(out.trim());
  return Number.isFinite(sec) ? sec : 0;
}

export function contentTypeFor(path: string): string {
  const dotIdx = path.lastIndexOf(".");
  if (dotIdx === -1) return "application/octet-stream";
  const ext = path.slice(dotIdx).toLowerCase();
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

// Codecs Chrome plays natively from a Matroska/MP4 container.
const CHROME_VIDEO = new Set(["h264", "vp8", "vp9", "av1"]);
const CHROME_AUDIO = new Set(["aac", "mp3", "opus", "vorbis", "flac", "pcm_s16le"]);

export interface CodecInfo {
  video: string | null;
  audio: string | null;
  videoProfile: string | null;
  pixFmt: string | null;
  chromeCompatible: boolean;
  reason: string | null;
}

// Keyed by path + size + mtime (like embeddedLangCache) so a replaced file
// with the same name doesn't serve stale codec info.
const codecCache = new Map<string, CodecInfo>();

export async function checkCodecs(file: string): Promise<CodecInfo> {
  let key = file;
  try {
    const st = await stat(file);
    key = `${file}:${st.size}:${st.mtimeMs}`;
  } catch {
    // unstatable — fall through, probe will throw a useful error
  }
  const hit = codecCache.get(key);
  if (hit) return hit;

  const streams = (await probeStreams(file)) as Array<{
    codec_type: string;
    codec_name?: string;
    profile?: string;
    pix_fmt?: string;
  }>;
  const v = streams.find((s) => s.codec_type === "video");
  const a = streams.find((s) => s.codec_type === "audio");

  let compatible = true;
  let reason: string | null = null;
  if (!v || !CHROME_VIDEO.has(v.codec_name ?? "")) {
    compatible = false;
    reason = `unsupported video codec: ${v?.codec_name ?? "none"}`;
  } else if (v.codec_name === "h264" && v.pix_fmt && /10le|10be|p10/.test(v.pix_fmt)) {
    compatible = false; // Hi10P
    reason = `10-bit h264 (${v.pix_fmt}) not supported by Chrome`;
  } else if (a && !CHROME_AUDIO.has(a.codec_name ?? "")) {
    compatible = false;
    reason = `unsupported audio codec: ${a.codec_name}`;
  }

  const info: CodecInfo = {
    video: v?.codec_name ?? null,
    audio: a?.codec_name ?? null,
    videoProfile: v?.profile ?? null,
    pixFmt: v?.pix_fmt ?? null,
    chromeCompatible: compatible,
    reason,
  };
  codecCache.set(key, info);
  return info;
}

/** Serve a file honoring a single-range Range header via Bun.file slicing. */
export async function serveFileWithRange(
  path: string,
  rangeHeader: string | null,
): Promise<Response> {
  const file = Bun.file(path);
  const size = file.size;
  const type = contentTypeFor(path);

  if (!rangeHeader) {
    return new Response(file, {
      headers: {
        "Content-Type": type,
        "Content-Length": String(size),
        "Accept-Ranges": "bytes",
      },
    });
  }

  const m = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
  if (!m || (m[1] === "" && m[2] === "")) {
    return new Response("Invalid Range", { status: 416 });
  }
  let start: number;
  let end: number;
  if (m[1] === "") {
    // suffix range: last N bytes
    const n = parseInt(m[2]!, 10);
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = parseInt(m[1]!, 10);
    end = m[2] === "" ? size - 1 : Math.min(parseInt(m[2]!, 10), size - 1);
  }
  if (start > end || start >= size) {
    return new Response("Range Not Satisfiable", {
      status: 416,
      headers: { "Content-Range": `bytes */${size}` },
    });
  }

  return new Response(file.slice(start, end + 1), {
    status: 206,
    headers: {
      "Content-Type": type,
      "Content-Length": String(end - start + 1),
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Accept-Ranges": "bytes",
    },
  });
}

/**
 * On-the-fly remux/transcode to fMP4 for Chrome-incompatible files.
 * Seek via startTime (seconds) — server-side `-ss`, Jellyfin-style.
 */
export function remuxToFmp4(
  file: string,
  startTime: number,
  info: CodecInfo,
  signal?: AbortSignal,
): Response {
  const videoArgs =
    info.video === "h264" && !info.reason?.includes("10-bit")
      ? ["-c:v", "copy"]
      : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p"];
  const audioArgs =
    info.audio && ["aac", "mp3"].includes(info.audio)
      ? ["-c:a", "copy"]
      : ["-c:a", "aac", "-b:a", "160k"];

  const args = [
    "ffmpeg",
    "-v",
    "error",
    ...(startTime > 0 ? ["-ss", String(startTime)] : []),
    "-i",
    file,
    ...videoArgs,
    ...audioArgs,
    "-movflags",
    "frag_keyframe+empty_moov+default_base_moof",
    "-f",
    "mp4",
    "-",
  ];
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "ignore" });
  if (signal) {
    signal.addEventListener("abort", () => { try { proc.kill(); } catch {} }, { once: true });
  }
  return new Response(proc.stdout, {
    headers: { "Content-Type": "video/mp4" },
  });
}

/** Cut [start, end] seconds (with small lead-in/out padding) as MP3 bytes. */
export async function cutAudio(
  file: string,
  start: number,
  end: number,
): Promise<Uint8Array> {
  const from = Math.max(0, start - 0.15);
  const dur = Math.max(0.2, end + 0.25 - from);
  const proc = Bun.spawn(
    [
      "ffmpeg",
      "-v",
      "error",
      "-ss",
      String(from),
      "-i",
      file,
      "-t",
      String(dur),
      "-vn",
      "-acodec",
      "libmp3lame",
      "-q:a",
      "4",
      "-f",
      "mp3",
      "-",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const buf = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
  if ((await proc.exited) !== 0 || buf.length === 0) {
    throw new Error(`audio cut failed at ${start}-${end}`);
  }
  return buf;
}

// ---- condensed audio (all dialogue spans concatenated into one mp3) ----

export interface AudioSpan {
  start: number;
  end: number;
}

/** Pad each span by `pad`s on both sides, then merge overlapping spans and
 * spans whose gap is < `gap`s. Returns sorted, disjoint spans. */
export function mergeAudioSpans(
  spans: AudioSpan[],
  pad = 0.2,
  gap = 0.4,
): AudioSpan[] {
  const sorted = spans
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
    .map((s) => ({ start: Math.max(0, s.start - pad), end: s.end + pad }))
    .sort((a, b) => a.start - b.start);
  const out: AudioSpan[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.start - last.end < gap) {
      if (s.end > last.end) last.end = s.end;
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

/** One ffmpeg run: atrim each span + concat filter → mp3 at outPath. */
async function concatSpansToMp3(
  file: string,
  spans: AudioSpan[],
  outPath: string,
): Promise<void> {
  const trims = spans.map(
    (s, i) =>
      `[0:a]atrim=start=${s.start.toFixed(3)}:end=${s.end.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`,
  );
  const fc =
    trims.join(";") +
    ";" +
    spans.map((_, i) => `[a${i}]`).join("") +
    `concat=n=${spans.length}:v=0:a=1[out]`;
  const proc = Bun.spawn(
    [
      "ffmpeg", "-y", "-v", "error",
      "-i", file,
      "-filter_complex", fc,
      "-map", "[out]",
      "-vn", "-acodec", "libmp3lame", "-q:a", "4",
      outPath,
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  const errText = await new Response(proc.stderr).text();
  if ((await proc.exited) !== 0) {
    throw new Error(`condense ffmpeg failed: ${errText.slice(0, 400)}`);
  }
}

// Keep each filter_complex argument well under the per-arg limit; long
// episodes are processed in chunks then joined with the concat demuxer.
const CONDENSE_CHUNK = 150;

/**
 * Concatenate the given (already merged) audio spans of `file` into a single
 * MP3 written to `outPath`. Returns the total duration in seconds.
 */
export async function condenseAudio(
  file: string,
  spans: AudioSpan[],
  outPath: string,
): Promise<number> {
  if (spans.length === 0) throw new Error("no audio spans to condense");
  await mkdir(dirname(outPath), { recursive: true });
  // Build into a temp name and rename at the end: a failed/killed ffmpeg must
  // not leave a partial mp3 at outPath (the GET endpoint only checks existence).
  const work = `${outPath}.tmp-${process.pid}.mp3`;
  try {
    if (spans.length <= CONDENSE_CHUNK) {
      await concatSpansToMp3(file, spans, work);
    } else {
      const tmp = await mkdtemp(join(tmpdir(), "zr-condense-"));
      try {
        const parts: string[] = [];
        for (let i = 0; i < spans.length; i += CONDENSE_CHUNK) {
          const part = join(tmp, `part${parts.length}.mp3`);
          await concatSpansToMp3(file, spans.slice(i, i + CONDENSE_CHUNK), part);
          parts.push(part);
        }
        const list = join(tmp, "list.txt");
        await Bun.write(
          list,
          parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"),
        );
        const proc = Bun.spawn(
          ["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", work],
          { stdout: "ignore", stderr: "pipe" },
        );
        const errText = await new Response(proc.stderr).text();
        if ((await proc.exited) !== 0) {
          throw new Error(`condense concat failed: ${errText.slice(0, 400)}`);
        }
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    }
    await rename(work, outPath);
  } catch (e) {
    await rm(work, { force: true });
    throw e;
  }
  return spans.reduce((acc, s) => acc + (s.end - s.start), 0);
}

/** Grab one frame at `t` seconds, scaled to `width`, as JPEG bytes. */
export async function captureFrame(
  file: string,
  t: number,
  width = 320,
): Promise<Uint8Array> {
  const proc = Bun.spawn(
    [
      "ffmpeg",
      "-v",
      "error",
      "-ss",
      String(t),
      "-i",
      file,
      "-frames:v",
      "1",
      "-vf",
      `scale=${width}:-1`,
      "-f",
      "image2",
      "-c:v",
      "mjpeg",
      "-q:v",
      "4",
      "-",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const buf = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
  if ((await proc.exited) !== 0 || buf.length === 0) {
    throw new Error(`frame capture failed at t=${t}`);
  }
  return buf;
}
