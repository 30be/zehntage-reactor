// whisper-cli job queue: one job at a time, progressive segments, sidecar SRT.

import { homedir } from "node:os";
import { join } from "node:path";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { Cue } from "./subs.ts";
import { cuesToSrt, parseTimestamp } from "./subs.ts";

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
  error?: string;
  listeners: Set<(event: WhisperEvent) => void>;
  proc?: ReturnType<typeof Bun.spawn>;
  canceled: boolean;
}

export type WhisperEvent =
  | { type: "status"; status: WhisperJobStatus; error?: string }
  | { type: "cue"; cue: Cue };

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
    await Bun.write(job.outPath, cuesToSrt(job.cues));
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

      // 2. Run whisper-cli, streaming segments from stdout.
      this.setStatus(job, "running");
      const proc = Bun.spawn(
        ["whisper-cli", "-m", MODEL_PATH, "-t", String(THREADS), "-l", job.lang, "-f", wavPath],
        { stdout: "pipe", stderr: "pipe" },
      );
      job.proc = proc;

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
            job.cues.push(cue);
            this.emit(job, { type: "cue", cue });
          }
        }
      }
      const code = await proc.exited;
      if (job.canceled) return;
      if (code !== 0) {
        throw new Error(`whisper-cli exited with ${code}: ${(await new Response(proc.stderr as ReadableStream).text()).slice(0, 300)}`);
      }

      // 3. Save sidecar SRT.
      await Bun.write(job.outPath, cuesToSrt(job.cues));
      this.setStatus(job, "done");
    } finally {
      await unlink(wavPath).catch(() => {});
    }
  }
}

export const whisperQueue = new WhisperQueue();
