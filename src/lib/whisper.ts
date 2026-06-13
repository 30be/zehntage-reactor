// whisper-cli job queue: one job at a time, progressive segments, sidecar SRT.

import { homedir } from "node:os";
import { join } from "node:path";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { Cue } from "./subs.ts";
import { cleanCues, cuesToSrt, findCoverageHoles, parseTimestamp } from "./subs.ts";

const MODEL_PATH = join(homedir(), "models", "ggml-medium.bin");
const THREADS = 12;

export type WhisperJobStatus = "queued" | "extracting" | "running" | "done" | "error" | "canceled";

export interface WhisperJob {
  id: string;
  mediaPath: string;
  lang: string;
  outPath: string;
  status: WhisperJobStatus;
  cues: Cue[];
  /** Non-fatal problems (e.g. coverage holes that survived repair passes). */
  warnings: string[];
  error?: string;
  listeners: Set<(event: WhisperEvent) => void>;
  proc?: ReturnType<typeof Bun.spawn>;
  canceled: boolean;
}

export type WhisperEvent =
  | { type: "status"; status: WhisperJobStatus; error?: string }
  | { type: "cue"; cue: Cue }
  | { type: "warning"; message: string };

/** Parse whisper-cli progressive output lines:
 *  [00:00:00.000 --> 00:00:04.500]   text here
 */
export function parseWhisperLine(line: string): Cue | null {
  const m = line.match(/^\[(\d+:\d+:\d+[.,]\d+)\s*-->\s*(\d+:\d+:\d+[.,]\d+)\]\s*(.*)$/);
  if (!m) return null;
  const start = parseTimestamp(m[1]!);
  const end = parseTimestamp(m[2]!);
  const text = m[3]!.trim();
  if (Number.isNaN(start) || Number.isNaN(end) || !text) return null;
  return { start, end, text };
}

/**
 * Post-process a hole-repair whisper pass before merging it back.
 *
 * A repair runs with `-mc 0` to break loops, but it can still loop on its own —
 * and because each repair only sees a short window, a loop here re-emits the
 * SAME cycle of cues we were trying to escape. So we:
 *   1. clip to the hole window (with the repair's ±pad already applied upstream);
 *   2. dedup with the cycle-aware `cleanCues` so a looped repair can't emit
 *      duplicate cycles of its own;
 *   3. cap to roughly the hole's duration: if the deduped content still spans
 *      more than `loopFactor`× the hole length it is still looping, so keep only
 *      the first hole-length worth of cues. We never fabricate timings — kept
 *      cues retain their original timestamps and we just drop the overflow.
 */
export function repairHole(
  repair: Cue[],
  hole: { start: number; end: number },
  loopFactor = 1.5,
): Cue[] {
  const clipped = cleanCues(repair).filter((c) => c.end > hole.start && c.start < hole.end);
  if (clipped.length === 0) return clipped;
  const holeLen = hole.end - hole.start;
  const span = clipped[clipped.length - 1]!.end - clipped[0]!.start;
  if (holeLen <= 0 || span <= holeLen * loopFactor) return clipped;
  // Still looping: keep cues until we've covered one hole-length from the first
  // kept cue, then stop. This discards the duplicated overflow tail.
  const cutoff = clipped[0]!.start + holeLen;
  const capped = clipped.filter((c) => c.start < cutoff);
  return capped.length > 0 ? capped : [clipped[0]!];
}

class WhisperQueue {
  private jobs = new Map<string, WhisperJob>();
  private queue: WhisperJob[] = [];
  private running: WhisperJob | null = null;
  private counter = 0;

  get(id: string): WhisperJob | undefined {
    return this.jobs.get(id);
  }

  /** All jobs ever enqueued (insertion order), for status reporting. */
  list(): WhisperJob[] {
    return [...this.jobs.values()];
  }

  /** The active (queued/extracting/running) job for this media path, if any.
   * Optionally narrowed to a language. */
  activeFor(mediaPath: string, lang?: string): WhisperJob | undefined {
    for (const j of this.jobs.values()) {
      if (
        j.mediaPath === mediaPath &&
        (lang == null || j.lang === lang) &&
        (j.status === "queued" || j.status === "extracting" || j.status === "running")
      ) {
        return j;
      }
    }
    return undefined;
  }

  /** True if a non-finished job exists for this media path. */
  hasActiveFor(mediaPath: string): boolean {
    return this.activeFor(mediaPath) !== undefined;
  }

  enqueue(mediaPath: string, lang: string, outPath: string): WhisperJob {
    const job: WhisperJob = {
      id: `w${++this.counter}-${Date.now().toString(36)}`,
      mediaPath,
      lang,
      outPath,
      status: "queued",
      cues: [],
      warnings: [],
      listeners: new Set(),
      canceled: false,
    };
    this.jobs.set(job.id, job);
    this.queue.push(job);
    void this.pump();
    return job;
  }

  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    job.canceled = true;
    this.queue = this.queue.filter((j) => j !== job);
    if (job.proc) job.proc.kill();
    if (job.status !== "done" && job.status !== "error") {
      this.setStatus(job, "canceled");
    }
    return true;
  }

  private emit(job: WhisperJob, event: WhisperEvent): void {
    for (const fn of job.listeners) fn(event);
  }

  private setStatus(job: WhisperJob, status: WhisperJobStatus, error?: string): void {
    job.status = status;
    if (error !== undefined) job.error = error;
    this.emit(job, error !== undefined ? { type: "status", status, error } : { type: "status", status });
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    const job = this.queue.shift();
    if (!job) return;
    this.running = job;
    try {
      await this.run(job);
    } catch (e) {
      if (!job.canceled) {
        this.setStatus(job, "error", e instanceof Error ? e.message : String(e));
      }
    } finally {
      this.running = null;
      void this.pump();
    }
  }

  // e2e fake mode: WHISPER_FAKE=1 streams scripted cues over ~2s, no ffmpeg/whisper.
  private async runFake(job: WhisperJob): Promise<void> {
    const FAKE_CUES: Cue[] = [
      { start: 0.5, end: 2.0, text: "勉強します。" },
      { start: 2.5, end: 4.0, text: "図書館へ行きます。" },
      { start: 4.5, end: 6.0, text: "気になります。" },
      { start: 6.5, end: 8.0, text: "本を読みました。" },
      { start: 8.5, end: 10.0, text: "友達と話します。" },
      { start: 10.5, end: 12.0, text: "明日も来ます。" },
    ];
    this.setStatus(job, "extracting");
    await new Promise((r) => setTimeout(r, 150));
    if (job.canceled) return;
    this.setStatus(job, "running");
    for (const cue of FAKE_CUES) {
      await new Promise((r) => setTimeout(r, 300));
      if (job.canceled) return;
      job.cues.push(cue);
      this.emit(job, { type: "cue", cue });
    }
    await Bun.write(job.outPath, cuesToSrt(cleanCues(job.cues)));
    this.setStatus(job, "done");
  }

  private async run(job: WhisperJob): Promise<void> {
    if (job.canceled) return;
    if (process.env.WHISPER_FAKE === "1") return this.runFake(job);
    // 1. Extract 16 kHz mono wav (whisper-cli wants wav input).
    this.setStatus(job, "extracting");
    const wavPath = join(tmpdir(), `zehntage-${job.id}.wav`);
    const ff = Bun.spawn(
      ["ffmpeg", "-y", "-v", "error", "-i", job.mediaPath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wavPath],
      { stdout: "ignore", stderr: "pipe" },
    );
    job.proc = ff;
    // The temp wav is removed in `finally` on EVERY exit path (cancel during
    // extraction, ffmpeg/whisper errors, success) — no leaked wavs in tmpdir.
    try {
      if ((await ff.exited) !== 0) {
        if (job.canceled) return;
        throw new Error(`ffmpeg audio extraction failed: ${await new Response(ff.stderr as ReadableStream).text()}`);
      }
      if (job.canceled) return;

      // 2. Run whisper-cli over the whole file, streaming segments from stdout.
      this.setStatus(job, "running");
      await this.whisperPass(job, wavPath, []);
      if (job.canceled) return;

      // 3. Collapse hallucinated repeat-runs. Collapsing keeps only the first
      // cue of a loop, so a loop that ate minutes of audio now shows up as a
      // coverage hole — re-run whisper on just those ranges with context
      // conditioning disabled (-mc 0), which is what breaks repeat loops.
      let cues = cleanCues(job.cues);
      const durationSec = await wavDurationSec(wavPath);
      const holes = findCoverageHoles(cues, durationSec);
      for (const hole of holes.slice(0, 4)) {
        if (job.canceled) return;
        const pad = 1;
        const offsetMs = Math.max(0, Math.round((hole.start - pad) * 1000));
        const durMs = Math.round((hole.end - hole.start + 2 * pad) * 1000);
        const repair = await this.whisperPass(job, wavPath, [
          "-ot", String(offsetMs),
          "-d", String(durMs),
          "-mc", "0", // no past-text conditioning: the anti-loop knob
        ]);
        if (job.canceled) return;
        const fixed = repairHole(repair, hole);
        cues = [...cues, ...fixed].sort((a, b) => a.start - b.start);
      }

      // 4. Anything still uncovered is a real problem — surface it.
      for (const hole of findCoverageHoles(cues, durationSec)) {
        const msg = `no subtitles between ${fmtMin(hole.start)} and ${fmtMin(hole.end)} (whisper produced no usable output there)`;
        job.warnings.push(msg);
        console.warn(`[whisper] ${job.mediaPath}: ${msg}`);
        this.emit(job, { type: "warning", message: msg });
      }

      // 5. Save sidecar SRT.
      await Bun.write(job.outPath, cuesToSrt(cues));
      this.setStatus(job, "done");
    } finally {
      await unlink(wavPath).catch(() => {});
    }
  }

  /** One whisper-cli invocation. Streams cues (pushed to job.cues + emitted)
   * and returns just this pass's cues. */
  private async whisperPass(job: WhisperJob, wavPath: string, extraArgs: string[]): Promise<Cue[]> {
    const proc = Bun.spawn(
      ["whisper-cli", "-m", MODEL_PATH, "-t", String(THREADS), "-l", job.lang, ...extraArgs, "-f", wavPath],
      { stdout: "pipe", stderr: "pipe" },
    );
    job.proc = proc;
    const passCues: Cue[] = [];
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        const cue = parseWhisperLine(line);
        if (cue) {
          passCues.push(cue);
          job.cues.push(cue);
          this.emit(job, { type: "cue", cue });
        }
      }
    }
    const code = await proc.exited;
    if (!job.canceled && code !== 0) {
      throw new Error(
        `whisper-cli exited with ${code}: ${(await new Response(proc.stderr as ReadableStream).text()).slice(0, 300)}`,
      );
    }
    return passCues;
  }
}

async function wavDurationSec(wavPath: string): Promise<number> {
  const proc = Bun.spawn(
    ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", wavPath],
    { stdout: "pipe", stderr: "ignore" },
  );
  const out = await new Response(proc.stdout as ReadableStream).text();
  const sec = Number.parseFloat(out.trim());
  return Number.isFinite(sec) ? sec : 0;
}

function fmtMin(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export const whisperQueue = new WhisperQueue();
