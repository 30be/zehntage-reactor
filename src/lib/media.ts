// Range-aware media serving + codec compatibility check via ffprobe.

import { probeStreams } from "./subs.ts";

const CONTENT_TYPES: Record<string, string> = {
  ".mkv": "video/x-matroska",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

export function contentTypeFor(path: string): string {
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
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

const codecCache = new Map<string, CodecInfo>();

export async function checkCodecs(file: string): Promise<CodecInfo> {
  const hit = codecCache.get(file);
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
  codecCache.set(file, info);
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
export function remuxToFmp4(file: string, startTime: number, info: CodecInfo): Response {
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
  return new Response(proc.stdout, {
    headers: { "Content-Type": "video/mp4" },
  });
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
