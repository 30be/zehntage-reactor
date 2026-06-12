// zehntage-reactor HTTP server (Bun.serve).

import { extname, join, dirname, basename } from "node:path";
import {
  Library,
  subLangsFor,
  embeddedSubLangs,
  migrateGeneratedSidecars,
  type LibraryEntry,
} from "../lib/library.ts";
import {
  serveFileWithRange,
  checkCodecs,
  remuxToFmp4,
  captureFrame,
  cutAudio,
} from "../lib/media.ts";
import {
  listEmbeddedSubTracks,
  extractEmbeddedTrack,
  parseSubtitleText,
  parseSrt,
  cuesToSrt,
  trackLabel,
  languageName,
  parseSidecarTrackId,
  type Cue,
  type SubTrack,
} from "../lib/subs.ts";
import { whisperQueue, type WhisperEvent } from "../lib/whisper.ts";
import {
  lookupWord,
  translateCues,
  explainSentence,
  askQuestion,
  DEFAULT_LOOKUP_PROMPT,
  type ExplainResult,
} from "../lib/gemini.ts";
import {
  listWords,
  getProgress,
  addCard,
  deleteCard,
  uploadImage,
  uploadMedia,
  resolveMediaName,
} from "../lib/anki.ts";
import { readSettings, writeSettings } from "../lib/settings.ts";

const PUBLIC_DIR = join(import.meta.dir, "..", "..", "public");

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function err(message: string, status = 500): Response {
  return json({ error: message }, status);
}

async function subTracksFor(entry: LibraryEntry): Promise<SubTrack[]> {
  // Count external sidecars per lang so duplicate-language files get
  // distinct labels ("Russian · file (.ass)").
  const externalPerLang = new Map<string, number>();
  for (const s of entry.sidecarSubs) {
    if (s.origin !== "generated") {
      const lang = s.lang || "und";
      externalPerLang.set(lang, (externalPerLang.get(lang) ?? 0) + 1);
    }
  }
  const tracks: SubTrack[] = entry.sidecarSubs.map((s) => {
    const lang = s.lang || "und";
    const t: SubTrack = {
      // Include the extension in external sidecar ids so two files of the
      // same language (e.g. .srt + .ass) get unique, unambiguous ids.
      id:
        s.origin === "generated"
          ? `sidecar:gen:${lang}`
          : `sidecar:${lang}${s.ext}`,
      kind: "sidecar",
      lang,
      path: s.path,
      origin: s.origin,
    };
    if (s.origin !== "generated" && (externalPerLang.get(lang) ?? 0) > 1) {
      t.label = `${languageName(lang)} · file (${s.ext})`;
    }
    return t;
  });
  try {
    tracks.push(...(await listEmbeddedSubTracks(entry.absPath)));
  } catch {
    // unprobeable file — sidecars only
  }
  return tracks;
}

async function cuesForTrack(entry: LibraryEntry, trackId: string): Promise<Cue[]> {
  const ref = parseSidecarTrackId(trackId);
  if (ref) {
    const matches = entry.sidecarSubs.filter(
      (s) =>
        (s.lang || "und") === ref.lang && (s.origin === "generated") === ref.generated,
    );
    // New ids carry the extension; legacy "sidecar:<lang>" ids fall back to
    // the first match for that language.
    const sub = ref.ext ? matches.find((s) => s.ext === `.${ref.ext}`) : matches[0];
    if (!sub) throw new Error(`no sidecar track ${ref.lang}`);
    return parseSubtitleText(await Bun.file(sub.path).text(), sub.ext);
  }
  if (trackId.startsWith("embedded:")) {
    const index = parseInt(trackId.slice("embedded:".length), 10);
    return parseSrt(await extractEmbeddedTrack(entry.absPath, index));
  }
  throw new Error(`bad track id: ${trackId}`);
}

/** Output path for AUTO-GENERATED sidecars: <videodir>/subs/<base>.<lang>.srt.
 * Bun.write creates the subs/ dir as needed. */
function sidecarPath(entry: LibraryEntry, lang: string): string {
  const base = basename(entry.absPath, extname(entry.absPath));
  return join(dirname(entry.absPath), "subs", `${base}.${lang}.srt`);
}

// --- batch jobs ---

/** "ja", "jpn", "ja-JP", … */
function isJapaneseLang(lang: string): boolean {
  return /^(ja|jpn)(-|$)/i.test(lang);
}

/** Sidecar/embedded/generated — does this entry have ANY Japanese track? */
async function hasJapaneseTrack(entry: LibraryEntry): Promise<boolean> {
  if (entry.sidecarSubs.some((s) => isJapaneseLang(s.lang))) return true;
  return (await embeddedSubLangs(entry.absPath)).some(isJapaneseLang);
}

export type TranslateBatchStatus = "queued" | "running" | "done" | "error";

interface TranslateBatchItem {
  entryId: string;
  sourceTrack: string;
  targetLang: string;
  status: TranslateBatchStatus;
  error?: string;
}

// Module-level so status survives across requests; processed sequentially to
// avoid hammering Gemini.
const translateBatch: TranslateBatchItem[] = [];

// In-memory cache for /api/explain, keyed by sentence + secondary + source.
// FIFO-capped so a long session can't grow it without bound.
const explainCache = new Map<string, ExplainResult>();
const EXPLAIN_CACHE_MAX = 200;
function explainCachePut(key: string, value: ExplainResult): void {
  if (explainCache.size >= EXPLAIN_CACHE_MAX) {
    const oldest = explainCache.keys().next().value;
    if (oldest !== undefined) explainCache.delete(oldest);
  }
  explainCache.set(key, value);
}
let translatePumpRunning = false;

async function pumpTranslateBatch(library: Library): Promise<void> {
  if (translatePumpRunning) return;
  translatePumpRunning = true;
  try {
    for (;;) {
      const item = translateBatch.find((i) => i.status === "queued");
      if (!item) break;
      item.status = "running";
      try {
        const entry = library.get(item.entryId);
        if (!entry) throw new Error("entry no longer in library");
        const cues = await cuesForTrack(entry, item.sourceTrack);
        const translated = await translateCues(cues, item.targetLang);
        await Bun.write(sidecarPath(entry, item.targetLang), cuesToSrt(translated));
        await library.refresh();
        item.status = "done";
      } catch (e) {
        item.status = "error";
        item.error = e instanceof Error ? e.message : String(e);
      }
    }
  } finally {
    translatePumpRunning = false;
  }
}

/** Best Japanese source track id: generated sidecar → external sidecar → embedded. */
async function bestJapaneseTrackId(entry: LibraryEntry): Promise<string | null> {
  const gen = entry.sidecarSubs.find(
    (s) => s.origin === "generated" && isJapaneseLang(s.lang),
  );
  if (gen) return `sidecar:gen:${gen.lang}`;
  const ext = entry.sidecarSubs.find(
    (s) => s.origin === "external" && isJapaneseLang(s.lang),
  );
  if (ext) return `sidecar:${ext.lang}${ext.ext}`;
  try {
    const embedded = await listEmbeddedSubTracks(entry.absPath);
    const ja = embedded.find((t) => isJapaneseLang(t.lang));
    if (ja) return ja.id;
  } catch {
    // unprobeable
  }
  return null;
}

/** Does the entry already have a GENERATED Russian sidecar? */
function hasGeneratedRu(entry: LibraryEntry): boolean {
  return entry.sidecarSubs.some(
    (s) => s.origin === "generated" && /^(ru|rus)(-|$)/i.test(s.lang),
  );
}

function translateQueuedFor(entryId: string): boolean {
  return translateBatch.some(
    (i) => i.entryId === entryId && (i.status === "queued" || i.status === "running"),
  );
}

function enqueueTranslate(library: Library, entryId: string, sourceTrack: string): void {
  translateBatch.push({ entryId, sourceTrack, targetLang: "ru", status: "queued" });
  void pumpTranslateBatch(library);
}

/**
 * Full ja+ru chain for one entry:
 *  - no ja track → whisper; when the job finishes, auto-enqueue ru translation
 *    of the freshly generated ja sidecar;
 *  - ja exists but no generated ru → straight to the translate queue;
 *  - everything present → skipped.
 */
async function chainGenerateAll(
  library: Library,
  entry: LibraryEntry,
): Promise<"whisper" | "translate" | "skipped"> {
  if (!(await hasJapaneseTrack(entry))) {
    if (whisperQueue.hasActiveFor(entry.absPath)) return "skipped";
    const job = whisperQueue.enqueue(entry.absPath, "ja", sidecarPath(entry, "ja"));
    const listener = (e: WhisperEvent) => {
      if (e.type !== "status") return;
      if (e.status === "done") {
        job.listeners.delete(listener);
        void (async () => {
          await library.refresh();
          const fresh = library.get(entry.id);
          if (fresh && !hasGeneratedRu(fresh) && !translateQueuedFor(fresh.id)) {
            enqueueTranslate(library, fresh.id, "sidecar:gen:ja");
          }
        })();
      } else if (e.status === "error" || e.status === "canceled") {
        job.listeners.delete(listener);
      }
    };
    job.listeners.add(listener);
    return "whisper";
  }
  if (hasGeneratedRu(entry) || translateQueuedFor(entry.id)) return "skipped";
  const sourceTrack = await bestJapaneseTrackId(entry);
  if (!sourceTrack) return "skipped";
  enqueueTranslate(library, entry.id, sourceTrack);
  return "translate";
}

export interface ServerHandle {
  port: number;
  url: string;
  stop: () => void;
}

export async function startServer(root: string, preferredPort = 8417): Promise<ServerHandle> {
  const library = new Library(root);
  // Idempotent: relocate legacy generated sidecars (renames are atomic, so
  // this is safe even while the previous instance is still serving).
  await migrateGeneratedSidecars(root).catch((e) =>
    console.warn(`[migrate] failed: ${e}`),
  );
  await library.refresh();

  const fetchHandler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;

    try {
      // --- static / SPA ---
      if (req.method === "GET" && (path === "/" || path === "/index.html")) {
        return new Response(Bun.file(join(PUBLIC_DIR, "index.html")), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      // --- library ---
      if (req.method === "GET" && path === "/api/library") {
        const entries = await library.refresh();
        return json(
          await Promise.all(
            entries.map(async (e) => ({
              id: e.id,
              name: e.name,
              relPath: e.relPath,
              size: e.size,
              subLangs: await subLangsFor(e),
            })),
          ),
        );
      }

      // --- media ---
      const media = path.match(/^\/media\/([a-f0-9]+)$/);
      if (req.method === "GET" && media) {
        const entry = library.get(media[1]!);
        if (!entry) return err("not found", 404);
        const info = await checkCodecs(entry.absPath).catch(() => null);
        if (info && !info.chromeCompatible) {
          const t = parseFloat(url.searchParams.get("t") ?? "0") || 0;
          return remuxToFmp4(entry.absPath, t, info);
        }
        return serveFileWithRange(entry.absPath, req.headers.get("Range"));
      }

      const mediaInfo = path.match(/^\/api\/media\/([a-f0-9]+)\/info$/);
      if (req.method === "GET" && mediaInfo) {
        const entry = library.get(mediaInfo[1]!);
        if (!entry) return err("not found", 404);
        return json(await checkCodecs(entry.absPath));
      }

      // --- subtitles ---
      const subsList = path.match(/^\/api\/subs\/([a-f0-9]+)$/);
      if (req.method === "GET" && subsList) {
        const entry = library.get(subsList[1]!);
        if (!entry) return err("not found", 404);
        const tracks = await subTracksFor(entry);
        return json(
          tracks.map(({ path: _p, ...rest }) => ({
            ...rest,
            label: rest.label ?? trackLabel(rest),
          })),
        );
      }

      const subsCues = path.match(/^\/api\/subs\/([a-f0-9]+)\/([^/]+)$/);
      if (req.method === "GET" && subsCues) {
        const entry = library.get(subsCues[1]!);
        if (!entry) return err("not found", 404);
        return json(await cuesForTrack(entry, decodeURIComponent(subsCues[2]!)));
      }

      // --- whisper ---
      const whisperStart = path.match(/^\/api\/whisper\/([a-f0-9]+)$/);
      if (req.method === "POST" && whisperStart) {
        const entry = library.get(whisperStart[1]!);
        if (!entry) return err("not found", 404);
        const body = (await req.json().catch(() => ({}))) as { lang?: string };
        const lang = body.lang ?? "ja";
        // Dedup: an active/queued job for the same file+lang is returned as-is
        // instead of enqueuing a duplicate 20-minute transcription.
        const existing = whisperQueue.activeFor(entry.absPath, lang);
        if (existing) return json({ jobId: existing.id, status: existing.status });
        const job = whisperQueue.enqueue(entry.absPath, lang, sidecarPath(entry, lang));
        return json({ jobId: job.id, status: job.status });
      }

      // Active whisper job for a media id, so the UI can reattach after reload.
      if (req.method === "GET" && path === "/api/whisper/active") {
        const mediaId = url.searchParams.get("mediaId") ?? "";
        const entry = library.get(mediaId);
        if (!entry) return err("not found", 404);
        const job = whisperQueue.activeFor(entry.absPath);
        return json(
          job ? { jobId: job.id, status: job.status, lang: job.lang } : { jobId: null },
        );
      }

      const whisperEvents = path.match(/^\/api\/whisper\/job\/([\w-]+)\/events$/);
      if (req.method === "GET" && whisperEvents) {
        const job = whisperQueue.get(whisperEvents[1]!);
        if (!job) return err("job not found", 404);
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const enc = new TextEncoder();
            const send = (event: WhisperEvent | { type: "snapshot"; status: string; cues: Cue[] }) => {
              controller.enqueue(enc.encode(`data: ${JSON.stringify(event)}\n\n`));
            };
            // snapshot of what already happened
            send({ type: "snapshot", status: job.status, cues: job.cues });
            if (job.status === "done" || job.status === "error" || job.status === "canceled") {
              controller.close();
              return;
            }
            const listener = (e: WhisperEvent) => {
              try {
                send(e);
                if (
                  e.type === "status" &&
                  (e.status === "done" || e.status === "error" || e.status === "canceled")
                ) {
                  job.listeners.delete(listener);
                  controller.close();
                }
              } catch {
                job.listeners.delete(listener);
              }
            };
            job.listeners.add(listener);
          },
        });
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      }

      const whisperCancel = path.match(/^\/api\/whisper\/job\/([\w-]+)\/cancel$/);
      if (req.method === "POST" && whisperCancel) {
        return whisperQueue.cancel(whisperCancel[1]!)
          ? json({ ok: true })
          : err("job not found", 404);
      }

      // --- batch jobs ---
      // One-button chain: whisper ja where missing (then auto-translate to ru),
      // translate-only where ja already exists.
      if (req.method === "POST" && path === "/api/batch/all") {
        const entries = await library.refresh();
        const started: { entryId: string; name: string; phase: string }[] = [];
        const skipped: string[] = [];
        for (const entry of entries) {
          const phase = await chainGenerateAll(library, entry);
          if (phase === "skipped") skipped.push(entry.id);
          else started.push({ entryId: entry.id, name: entry.name, phase });
        }
        return json({ started, skipped });
      }

      // Same chain for a single entry (used by the player screen).
      const batchAllOne = path.match(/^\/api\/batch\/all\/([a-f0-9]+)$/);
      if (req.method === "POST" && batchAllOne) {
        await library.refresh();
        const entry = library.get(batchAllOne[1]!);
        if (!entry) return err("not found", 404);
        const phase = await chainGenerateAll(library, entry);
        return json({ entryId: entry.id, phase });
      }

      if (req.method === "POST" && path === "/api/batch/subtitle") {
        const entries = await library.refresh();
        const started: { entryId: string; name: string; jobId: string }[] = [];
        const skipped: string[] = [];
        for (const entry of entries) {
          if ((await hasJapaneseTrack(entry)) || whisperQueue.hasActiveFor(entry.absPath)) {
            skipped.push(entry.id);
            continue;
          }
          const job = whisperQueue.enqueue(entry.absPath, "ja", sidecarPath(entry, "ja"));
          started.push({ entryId: entry.id, name: entry.name, jobId: job.id });
        }
        return json({ started, skipped });
      }

      if (req.method === "POST" && path === "/api/batch/translate") {
        const entries = await library.refresh();
        const started: { entryId: string; name: string; sourceTrack: string }[] = [];
        const skipped: string[] = [];
        for (const entry of entries) {
          const hasGenRu = entry.sidecarSubs.some(
            (s) => s.origin === "generated" && /^(ru|rus)(-|$)/i.test(s.lang),
          );
          const alreadyQueued = translateBatch.some(
            (i) =>
              i.entryId === entry.id &&
              (i.status === "queued" || i.status === "running"),
          );
          if (hasGenRu || alreadyQueued) {
            skipped.push(entry.id);
            continue;
          }
          const sourceTrack = await bestJapaneseTrackId(entry);
          if (!sourceTrack) {
            skipped.push(entry.id);
            continue;
          }
          translateBatch.push({
            entryId: entry.id,
            sourceTrack,
            targetLang: "ru",
            status: "queued",
          });
          started.push({ entryId: entry.id, name: entry.name, sourceTrack });
        }
        void pumpTranslateBatch(library);
        return json({ started, skipped });
      }

      if (req.method === "GET" && path === "/api/batch/status") {
        const byPath = new Map(library.list().map((e) => [e.absPath, e.id]));
        const whisper = whisperQueue.list().map((j) => ({
          jobId: j.id,
          entryId: byPath.get(j.mediaPath) ?? null,
          lang: j.lang,
          status: j.status,
          lastCue: j.cues.length > 0 ? j.cues[j.cues.length - 1]!.end : null,
          error: j.error ?? null,
        }));
        const translate = translateBatch.map((i) => ({
          entryId: i.entryId,
          sourceTrack: i.sourceTrack,
          targetLang: i.targetLang,
          status: i.status,
          error: i.error ?? null,
        }));
        const active =
          whisper.some(
            (j) => j.status === "queued" || j.status === "extracting" || j.status === "running",
          ) || translate.some((i) => i.status === "queued" || i.status === "running");
        return json({ active, whisper, translate });
      }

      // --- translate track ---
      const translate = path.match(/^\/api\/translate\/([a-f0-9]+)\/([^/]+)$/);
      if (req.method === "POST" && translate) {
        const entry = library.get(translate[1]!);
        if (!entry) return err("not found", 404);
        const body = (await req.json().catch(() => ({}))) as { targetLang?: string };
        const targetLang = body.targetLang ?? "ru";
        // Safety net: refuse to overwrite an existing GENERATED sidecar for the
        // target language. External/embedded tracks (often out of sync) don't
        // block translation — a synced generated track is preferred.
        const generatedExists = entry.sidecarSubs.some(
          (s) =>
            s.origin === "generated" &&
            s.lang.toLowerCase() === targetLang.toLowerCase(),
        );
        if (generatedExists) return err("track exists", 409);
        const cues = await cuesForTrack(entry, decodeURIComponent(translate[2]!));
        const translated = await translateCues(cues, targetLang);
        const out = sidecarPath(entry, targetLang);
        await Bun.write(out, cuesToSrt(translated));
        await library.refresh();
        return json({
          ok: true,
          track: `sidecar:gen:${targetLang}`,
          cueCount: translated.length,
        });
      }

      // --- Gemini sentence-structure explain (cached by sentence) ---
      if (req.method === "POST" && path === "/api/explain") {
        const body = (await req.json()) as {
          sentence?: string;
          secondary?: string;
          source?: string;
          context?: string;
        };
        if (!body.sentence) return err("sentence required", 400);
        const cacheKey = `${body.sentence} ${body.secondary ?? ""} ${body.source ?? ""} ${body.context ?? ""}`;
        const cached = explainCache.get(cacheKey);
        if (cached) return json(cached);
        const res = await explainSentence(
          body.sentence,
          body.secondary ?? "",
          body.source ?? "",
          body.context ?? "",
        );
        explainCachePut(cacheKey, res);
        return json(res);
      }

      // --- Gemini free-form follow-up question ---
      if (req.method === "POST" && path === "/api/ask") {
        const body = (await req.json()) as {
          question?: string;
          word?: string;
          sentence?: string;
          priorAnswer?: string;
          source?: string;
        };
        if (!body.question) return err("question required", 400);
        return json(
          await askQuestion({
            question: body.question,
            word: body.word,
            sentence: body.sentence,
            priorAnswer: body.priorAnswer,
            source: body.source,
          }),
        );
      }

      // --- Gemini word lookup ---
      if (req.method === "POST" && path === "/api/lookup") {
        const body = (await req.json()) as {
          word?: string;
          context?: string;
          secondary?: string;
          source?: string;
          mediaId?: string;
          timestamp?: number;
          withFrame?: boolean;
        };
        if (!body.word) return err("word required", 400);

        let image: { bytes: Uint8Array; mimeType: string } | undefined;
        if (body.withFrame && body.mediaId !== undefined && body.timestamp !== undefined) {
          const entry = library.get(body.mediaId);
          if (entry) {
            try {
              const frame = await captureFrame(entry.absPath, Math.max(0, body.timestamp), 480);
              image = { bytes: frame, mimeType: "image/jpeg" };
            } catch {
              // no frame — fall back to text-only lookup
            }
          }
        }

        return json(
          await lookupWord(
            body.word,
            body.context ?? "",
            body.source ?? "",
            image,
            body.secondary,
          ),
        );
      }

      // --- Anki ---
      if (req.method === "GET" && path === "/api/anki/words") {
        const [words, progress] = await Promise.all([listWords(), getProgress()]);
        return json({ words, progress });
      }

      if (req.method === "POST" && path === "/api/anki/add") {
        const body = (await req.json()) as {
          word?: string;
          reading?: string;
          translation?: string;
          notes?: string;
          context?: string;
          mediaId?: string;
          timestamp?: number;
          cueStart?: number;
          cueEnd?: number;
        };
        if (!body.word || !body.translation) return err("word and translation required", 400);

        let context = body.context ?? "";
        const extras: string[] = [];
        let image: string | undefined;
        if (body.mediaId !== undefined && body.timestamp !== undefined) {
          const entry = library.get(body.mediaId);
          if (entry) {
            const ts = Math.max(0, body.timestamp);
            const mm = Math.floor(ts / 60);
            const ss = Math.floor(ts % 60);
            extras.push(`${entry.name} @ ${mm}:${String(ss).padStart(2, "0")}`);
            try {
              const frame = await captureFrame(entry.absPath, ts, 320);
              // Upload the frame as a real Anki media file instead of inlining
              // a base64 JPEG into context (which bloated /zehntage/list).
              image = await uploadImage(frame, "image/jpeg");
            } catch {
              // no frame — card still goes through
            }
            // Sentence audio: cut the cue's audio, upload it, resolve its
            // Anki media name, and reference it via [sound:...] in context.
            // Any failure along the way is non-fatal — the card still goes
            // through without audio.
            if (
              typeof body.cueStart === "number" &&
              typeof body.cueEnd === "number" &&
              body.cueEnd > body.cueStart
            ) {
              try {
                const audio = await cutAudio(entry.absPath, body.cueStart, body.cueEnd);
                const path = await uploadMedia(audio, "audio/mpeg", "sentence.mp3");
                const mediaName = await resolveMediaName(path);
                if (mediaName) extras.push(`[sound:${mediaName}]`);
              } catch {
                // no audio — card still goes through
              }
            }
          }
        }
        if (extras.length) context = [context, ...extras].filter(Boolean).join("<br>");

        const front = body.reading ? `${body.word} [${body.reading}]` : body.word;
        await addCard({
          front,
          back: body.translation,
          notes: body.notes ?? "",
          context,
          ...(image ? { image, image_field: "context" } : {}),
        });
        return json({ ok: true });
      }

      if (req.method === "POST" && path === "/api/anki/delete") {
        const body = (await req.json()) as { front?: string };
        if (!body.front) return err("front required", 400);
        await deleteCard(body.front);
        return json({ ok: true });
      }

      // --- settings ---
      if (path === "/api/settings") {
        if (req.method === "GET") {
          const settings = await readSettings();
          return json({ ...settings, lookupPromptDefault: DEFAULT_LOOKUP_PROMPT });
        }
        if (req.method === "POST") {
          const patch = (await req.json()) as Record<string, unknown>;
          return json(await writeSettings(patch));
        }
      }

      // --- other static assets in public/ ---
      if (req.method === "GET" && !path.startsWith("/api/")) {
        const file = Bun.file(join(PUBLIC_DIR, path.slice(1)));
        if (await file.exists()) return new Response(file);
      }

      return err("not found", 404);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  };

  // Try preferred port, fall back to an ephemeral one.
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({ port: preferredPort, idleTimeout: 0, fetch: fetchHandler });
  } catch {
    server = Bun.serve({ port: 0, idleTimeout: 0, fetch: fetchHandler });
  }

  return {
    port: server.port ?? preferredPort,
    url: `http://localhost:${server.port}`,
    stop: () => server.stop(true),
  };
}
