// yt-dlp video downloader: fetch a YouTube video (best video+audio, merged to
// mp4) into the library root so it shows up as a normal episode, plus its own
// subtitles (the video's original language + the user's known language) as
// external sidecars (`<base>.<lang>.srt`) — exactly the shape scanLibrary()
// already discovers. Translation into the known language, when YouTube has no
// such track, is left to the app's existing on-demand Gemini pipeline.
//
// No shell is used: every yt-dlp invocation goes through Bun.spawn with an argv
// array, so the (host-validated) URL can never be interpreted as a command.

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep, extname } from "node:path";
import { readdir, rm, stat } from "node:fs/promises";
import { idForRelPath, VIDEO_EXTENSIONS } from "./library.ts";

const YT_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
]);

/** True for http(s) URLs whose host is a YouTube domain. Used as the SSRF guard
 * before the server hands the URL to yt-dlp. */
export function isYoutubeUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  return YT_HOSTS.has(u.hostname.toLowerCase());
}

/** Extract a 0..100 progress percentage from a yt-dlp output line (our
 * `--progress-template "download:NN.N%"`, or a raw `[download]  NN.N%` line).
 * Returns null when the line carries no percentage. */
export function parseYtdlpPercent(line: string): number | null {
  const m = line.match(/(\d{1,3}(?:\.\d+)?)\s*%/);
  if (!m) return null;
  const n = parseFloat(m[1]!);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, n));
}

// A short language code (e.g. "ja", "ru", "en", "pt-BR"); anything else is
// dropped before it becomes a yt-dlp --sub-langs token.
function isLangCode(lang: string): boolean {
  return /^[a-z]{2,3}(-[a-z]{2,4})?$/i.test(lang);
}

export type YtStatus =
  | "probing"
  | "downloading"
  | "merging"
  | "done"
  | "error";

export interface YtJob {
  id: string;
  url: string;
  status: YtStatus;
  /** 0..100; meaningful while status === "downloading". */
  percent: number;
  /** Resolved after the probe; null until then. */
  title: string | null;
  /** Set on status === "error". */
  error: string | null;
  /** LibraryEntry id of the finished file (status === "done"); else null. */
  entryId: string | null;
  /** Absolute path of the downloaded video (status === "done"); else null. */
  filePath: string | null;
  createdAt: number;
}

export interface StartYoutubeOpts {
  url: string;
  /** Directory yt-dlp downloads into (the current library root). */
  root: string;
  /** Extra subtitle languages to fetch besides the video's original (e.g. the
   * user's known language for a ready-made translation when YouTube has one). */
  subLangs: string[];
  /** Called once the file is on disk and entryId is known, so the server can
   * refresh its in-memory library before the client polls again. */
  onComplete?: (job: YtJob) => void | Promise<void>;
}

// Module-level registry so job status survives across requests. Single local
// user → a plain Map is plenty; trimmed so jobs don't accumulate.
const jobs = new Map<string, YtJob>();
const JOBS_MAX = 40; // keep at most this many FINISHED jobs
const JOBS_HARD_MAX = 200; // absolute cap incl. in-flight (runaway guard)

function trimJobs(): void {
  // Evict oldest finished jobs beyond JOBS_MAX.
  const finished = [...jobs.values()]
    .filter((j) => j.status === "done" || j.status === "error")
    .sort((a, b) => a.createdAt - b.createdAt);
  let dropFinished = finished.length - JOBS_MAX;
  for (const j of finished) {
    if (dropFinished <= 0) break;
    jobs.delete(j.id);
    dropFinished--;
  }
  // Absolute guard: even stuck (probing/downloading) jobs can't grow forever.
  if (jobs.size > JOBS_HARD_MAX) {
    const oldest = [...jobs.values()].sort((a, b) => a.createdAt - b.createdAt);
    let drop = jobs.size - JOBS_HARD_MAX;
    for (const j of oldest) {
      if (drop <= 0) break;
      jobs.delete(j.id);
      drop--;
    }
  }
}

/** Number of jobs that are still running (probing/downloading/merging). */
export function activeYoutubeJobCount(): number {
  let n = 0;
  for (const j of jobs.values()) {
    if (j.status !== "done" && j.status !== "error") n++;
  }
  return n;
}

/** Drop a job from the registry (used when the user dismisses a failed one so
 * it doesn't reappear on the next poll / reload). */
export function dismissYoutubeJob(id: string): boolean {
  return jobs.delete(id);
}

/** All known jobs, newest first. */
export function listYoutubeJobs(): YtJob[] {
  return [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
}

/** Kick off a download. Returns the job synchronously (status "probing"); the
 * actual work runs in the background and mutates the job in place. */
export function startYoutubeDownload(opts: StartYoutubeOpts): YtJob {
  const job: YtJob = {
    id: randomUUID(),
    url: opts.url,
    status: "probing",
    percent: 0,
    title: null,
    error: null,
    entryId: null,
    filePath: null,
    createdAt: Date.now(),
  };
  jobs.set(job.id, job);
  trimJobs();
  void runDownload(job, opts).catch((e) => {
    // Never clobber a successful download — e.g. if onComplete (library
    // refresh) throws after the file already landed.
    if (job.status === "done") return;
    job.status = "error";
    job.error = e instanceof Error ? e.message : String(e);
  });
  return job;
}

async function runDownload(job: YtJob, opts: StartYoutubeOpts): Promise<void> {
  // 1. Probe: title, video id, original language.
  const meta = await probe(opts.url);
  job.title = meta.title;
  job.status = "downloading";

  // 2. Subtitle languages to fetch: the video's OWN subs (human-authored if any,
  // otherwise its native auto-captions — the plain-coded ones; "xx-yy" entries
  // are YouTube machine translations we skip, since the app's Gemini pipeline
  // does translation into the known language). Plus the known language itself,
  // in case the video genuinely ships it.
  const native =
    meta.manualSubs.length > 0
      ? meta.manualSubs
      : meta.autoSubs.filter((l) => !l.includes("-"));
  const subLangs = [
    ...new Set(
      [...native, ...opts.subLangs, meta.language ?? ""].filter(isLangCode),
    ),
  ];

  // 3. Download into the library root. `--print-to-file after_move:filepath`
  // writes the final path (post-merge, post-move) so we don't have to guess
  // yt-dlp's filename sanitization.
  const pathFile = join(tmpdir(), `zr-ytdlp-${job.id}.path`);
  const argv = [
    "yt-dlp",
    "--no-playlist",
    "--no-warnings",
    "--newline",
    "--progress-template",
    "download:%(progress._percent_str)s",
    "-f",
    "bv*+ba/b",
    "--merge-output-format",
    "mp4",
    "-o",
    join(opts.root, "%(title)s [%(id)s].%(ext)s"),
    "--print-to-file",
    "after_move:filepath",
    pathFile,
  ];
  if (subLangs.length > 0) {
    argv.push(
      "--write-subs",
      "--write-auto-subs",
      "--sub-langs",
      subLangs.join(","),
      "--convert-subs",
      "srt",
    );
  }
  argv.push(opts.url);

  const { code, errTail } = await spawnStreaming(argv, (line) => {
    if (/\bMerging\b|\[Merger\]/.test(line)) {
      job.status = "merging";
      return;
    }
    if (job.status === "merging") return; // post-merge lines must not regress it
    const pct = parseYtdlpPercent(line);
    if (pct != null) {
      if (job.status === "probing") job.status = "downloading";
      // yt-dlp fetches video then audio as two separate 0–100% passes; keep the
      // bar monotonic so it never visibly jumps backwards.
      if (pct > job.percent) job.percent = pct;
    }
  });
  if (code !== 0) {
    await rm(pathFile, { force: true }).catch(() => {});
    throw new Error(`yt-dlp exited ${code}${errTail ? `: ${errTail}` : ""}`);
  }

  // 4. Resolve the final file path → entry id.
  const filePath = await resolveDownloadedPath(pathFile, opts.root, meta.id);
  await rm(pathFile, { force: true }).catch(() => {});
  if (!filePath) {
    throw new Error("download finished but the output file could not be located");
  }
  // Defense-in-depth: the path must live under the library root (yt-dlp
  // sanitizes %(title)s, but never trust a path we then hand back as an entry).
  const rootAbs = resolve(opts.root);
  const fileAbs = resolve(filePath);
  if (fileAbs !== rootAbs && !fileAbs.startsWith(rootAbs + sep)) {
    throw new Error("downloaded file resolved outside the library root");
  }
  const relPath = relative(rootAbs, fileAbs).split("\\").join("/");
  job.filePath = fileAbs;
  job.entryId = idForRelPath(relPath);
  job.percent = 100;
  // Mark done BEFORE the post-completion hook so a throwing onComplete can't be
  // mistaken for a failed download.
  job.status = "done";

  await opts.onComplete?.(job);
}

async function probe(url: string): Promise<{
  title: string | null;
  id: string | null;
  language: string | null;
  /** Languages with human-authored subtitles (the video's real languages). */
  manualSubs: string[];
  /** Languages with auto-captions (incl. machine translations like "ru-en"). */
  autoSubs: string[];
}> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(["yt-dlp", "-J", "--no-warnings", "--no-playlist", url], {
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (e) {
    throw new Error(
      `could not launch yt-dlp (is it installed and on PATH?): ${
        e instanceof Error ? e.message : e
      }`,
    );
  }
  const [out, errText] = await Promise.all([
    new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
    new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
  ]);
  const code = await proc.exited;
  if (code !== 0) {
    const tail = errText.split("\n").filter(Boolean).slice(-4).join(" ").trim();
    throw new Error(`yt-dlp could not read the video${tail ? `: ${tail}` : ""}`);
  }
  let j: {
    title?: unknown;
    id?: unknown;
    language?: unknown;
    subtitles?: unknown;
    automatic_captions?: unknown;
  };
  try {
    j = JSON.parse(out);
  } catch {
    throw new Error("yt-dlp returned malformed metadata");
  }
  const keysOf = (v: unknown): string[] =>
    v && typeof v === "object" ? Object.keys(v as Record<string, unknown>) : [];
  return {
    title: typeof j.title === "string" ? j.title : null,
    id: typeof j.id === "string" ? j.id : null,
    language: typeof j.language === "string" ? j.language : null,
    manualSubs: keysOf(j.subtitles),
    autoSubs: keysOf(j.automatic_captions),
  };
}

/** Run argv, streaming stdout line-by-line to `onLine`; capture stderr tail. */
async function spawnStreaming(
  argv: string[],
  onLine: (line: string) => void,
): Promise<{ code: number; errTail: string }> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  } catch (e) {
    throw new Error(
      `could not launch yt-dlp (is it installed and on PATH?): ${
        e instanceof Error ? e.message : e
      }`,
    );
  }
  // Read stderr concurrently so its pipe never fills and deadlocks.
  const errTextPromise = new Response(
    proc.stderr as ReadableStream<Uint8Array>,
  ).text();
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      onLine(buf.slice(0, nl).replace(/\r$/, ""));
      buf = buf.slice(nl + 1);
    }
  }
  if (buf.trim()) onLine(buf.replace(/\r$/, ""));
  const code = await proc.exited;
  const errText = await errTextPromise;
  const errTail = errText.split("\n").filter(Boolean).slice(-6).join(" ").trim();
  return { code, errTail };
}

/** Final video path: prefer the path yt-dlp printed, else find a video in the
 * root whose name carries the `[<id>]` tag we asked for. */
async function resolveDownloadedPath(
  pathFile: string,
  root: string,
  videoId: string | null,
): Promise<string | null> {
  try {
    const printed = (await Bun.file(pathFile).text())
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const last = printed[printed.length - 1];
    if (last && VIDEO_EXTENSIONS.has(extname(last).toLowerCase())) return last;
  } catch {
    // no print file — fall through to the id glob
  }
  if (!videoId) return null;
  console.warn(
    `[youtube] --print-to-file gave no usable path; falling back to [${videoId}] glob in ${root}`,
  );
  try {
    const names = await readdir(root);
    const tag = `[${videoId}]`;
    const matches = names.filter(
      (n) => n.includes(tag) && VIDEO_EXTENSIONS.has(extname(n).toLowerCase()),
    );
    if (matches.length === 0) return null;
    if (matches.length === 1) return join(root, matches[0]!);
    // Multiple files carry this id (e.g. a leftover from a prior run): take the
    // most recently modified one.
    const withMtime = await Promise.all(
      matches.map(async (n) => {
        const p = join(root, n);
        const mtime = await stat(p)
          .then((s) => s.mtimeMs)
          .catch(() => 0);
        return { p, mtime };
      }),
    );
    withMtime.sort((a, b) => b.mtime - a.mtime);
    return withMtime[0]!.p;
  } catch {
    return null;
  }
}
