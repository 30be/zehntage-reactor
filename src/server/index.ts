// zehntage-reactor HTTP server (Bun.serve).

import { extname, join, dirname } from "node:path";
import { Library, type LibraryEntry } from "../lib/library.ts";
import {
  serveFileWithRange,
  checkCodecs,
  remuxToFmp4,
  captureFrame,
} from "../lib/media.ts";
import {
  listEmbeddedSubTracks,
  extractEmbeddedTrack,
  parseSubtitleText,
  parseSrt,
  cuesToSrt,
  type Cue,
  type SubTrack,
} from "../lib/subs.ts";
import { whisperQueue, type WhisperEvent } from "../lib/whisper.ts";
import { lookupWord, translateCues, DEFAULT_LOOKUP_PROMPT } from "../lib/gemini.ts";
import { listWords, getProgress, addCard, deleteCard, uploadImage } from "../lib/anki.ts";
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
  const tracks: SubTrack[] = entry.sidecarSubs.map((s) => ({
    id: `sidecar:${s.lang || "und"}`,
    kind: "sidecar",
    lang: s.lang || "und",
    path: s.path,
  }));
  try {
    tracks.push(...(await listEmbeddedSubTracks(entry.absPath)));
  } catch {
    // unprobeable file — sidecars only
  }
  return tracks;
}

async function cuesForTrack(entry: LibraryEntry, trackId: string): Promise<Cue[]> {
  if (trackId.startsWith("sidecar:")) {
    const lang = trackId.slice("sidecar:".length);
    const sub = entry.sidecarSubs.find((s) => (s.lang || "und") === lang);
    if (!sub) throw new Error(`no sidecar track ${lang}`);
    return parseSubtitleText(await Bun.file(sub.path).text(), sub.ext);
  }
  if (trackId.startsWith("embedded:")) {
    const index = parseInt(trackId.slice("embedded:".length), 10);
    return parseSrt(await extractEmbeddedTrack(entry.absPath, index));
  }
  throw new Error(`bad track id: ${trackId}`);
}

function sidecarPath(entry: LibraryEntry, lang: string): string {
  const base = entry.absPath.slice(0, -extname(entry.absPath).length);
  return `${base}.${lang}.srt`;
}

export interface ServerHandle {
  port: number;
  url: string;
  stop: () => void;
}

export async function startServer(root: string, preferredPort = 8417): Promise<ServerHandle> {
  const library = new Library(root);
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
          entries.map((e) => ({
            id: e.id,
            name: e.name,
            relPath: e.relPath,
            size: e.size,
            subLangs: e.sidecarSubs.map((s) => s.lang || "und"),
          })),
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
        return json(tracks.map(({ path: _p, ...rest }) => rest));
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
        const job = whisperQueue.enqueue(entry.absPath, lang, sidecarPath(entry, lang));
        return json({ jobId: job.id, status: job.status });
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

      // --- translate track ---
      const translate = path.match(/^\/api\/translate\/([a-f0-9]+)\/([^/]+)$/);
      if (req.method === "POST" && translate) {
        const entry = library.get(translate[1]!);
        if (!entry) return err("not found", 404);
        const body = (await req.json().catch(() => ({}))) as { targetLang?: string };
        const targetLang = body.targetLang ?? "ru";
        const cues = await cuesForTrack(entry, decodeURIComponent(translate[2]!));
        const translated = await translateCues(cues, targetLang);
        const out = sidecarPath(entry, targetLang);
        await Bun.write(out, cuesToSrt(translated));
        await library.refresh();
        return json({ ok: true, track: `sidecar:${targetLang}`, cueCount: translated.length });
      }

      // --- Gemini word lookup ---
      if (req.method === "POST" && path === "/api/lookup") {
        const body = (await req.json()) as {
          word?: string;
          context?: string;
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

        return json(await lookupWord(body.word, body.context ?? "", body.source ?? "", image));
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
