// Generates the e2e fixture library with ffmpeg:
//   fixtures/lib/clip.mp4        30s 320x240 color+tone, h264+aac (chrome-compatible)
//   fixtures/lib/clip.ja.srt     external JP sidecar, 6 cues
//   fixtures/lib/subs/clip.ru.srt  generated-origin RU sidecar (tests labels)
//   fixtures/lib/bare.mp4        12s, no subtitle tracks (whisper-generate flow)
// The lib dir is recreated from scratch on every run so test-generated
// sidecars (subs/bare.ja.srt from the fake whisper) never leak between runs.

import { mkdir, rm, utimes } from "node:fs/promises";
import { join } from "node:path";

const LIB = join(import.meta.dirname, "fixtures", "lib");

function srt(cues: { start: number; end: number; text: string }[]): string {
  const ts = (t: number) => {
    const ms = Math.round(t * 1000);
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
  };
  return cues
    .map((c, i) => `${i + 1}\n${ts(c.start)} --> ${ts(c.end)}\n${c.text}\n`)
    .join("\n");
}

// gap.mp4: cues only at the very start and near the end — the >60s dialogue
// hole in between exercises the OP/ED "Skip →" pill.
export const GAP_CUES = [
  { start: 2, end: 5, text: "始まります。" },
  { start: 80, end: 83, text: "終わります。" },
];

export const JA_CUES = [
  { start: 2, end: 5, text: "勉強します。" },
  { start: 6, end: 9, text: "図書館へ行きます。" },
  { start: 10, end: 13, text: "気になります。" },
  { start: 14, end: 17, text: "本を読みました。" },
  { start: 18, end: 21, text: "友達と話します。" },
  { start: 22, end: 25, text: "明日も来ます。" },
];

const RU_CUES = JA_CUES.map((c, i) => ({
  ...c,
  text: [
    "Я учусь.",
    "Я иду в библиотеку.",
    "Меня это интересует.",
    "Я прочитал книгу.",
    "Я говорю с друзьями.",
    "Завтра тоже приду.",
  ][i]!,
}));

async function ffmpeg(args: string[]): Promise<void> {
  const proc = Bun.spawn(["ffmpeg", "-y", "-v", "error", ...args], {
    stdout: "ignore",
    stderr: "pipe",
  });
  if ((await proc.exited) !== 0) {
    throw new Error(`ffmpeg failed: ${await new Response(proc.stderr as ReadableStream).text()}`);
  }
}

async function makeVideo(path: string, seconds: number): Promise<void> {
  await ffmpeg([
    "-f", "lavfi", "-i", `testsrc2=size=320x240:rate=24:duration=${seconds}`,
    "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "ultrafast",
    "-c:a", "aac", "-shortest",
    path,
  ]);
}

if (import.meta.main) {
  await globalSetup();
}

export default async function globalSetup(): Promise<void> {
  await rm(LIB, { recursive: true, force: true });
  await mkdir(join(LIB, "subs"), { recursive: true });
  await Promise.all([
    makeVideo(join(LIB, "clip.mp4"), 30),
    makeVideo(join(LIB, "bare.mp4"), 12),
    makeVideo(join(LIB, "gap.mp4"), 90),
  ]);
  await Bun.write(join(LIB, "clip.ja.srt"), srt(JA_CUES));
  await Bun.write(join(LIB, "subs", "clip.ru.srt"), srt(RU_CUES));
  await Bun.write(join(LIB, "gap.ja.srt"), srt(GAP_CUES));
  // Backdate the external sidecar: the server's startup migration moves
  // recently-written <base>.<ja|ru>.srt files into subs/ (treating them as
  // generated). An old mtime keeps it an EXTERNAL track, as intended.
  const old = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  await utimes(join(LIB, "clip.ja.srt"), old, old);
  await utimes(join(LIB, "gap.ja.srt"), old, old);
}
