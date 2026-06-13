// zehntage-reactor HTTP server (Bun.serve).

import { extname, join, dirname, basename, resolve } from "node:path";
import { stat, readdir, rm } from "node:fs/promises";
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
  mergeAudioSpans,
  condenseAudio,
  mediaDurationSec,
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
  collapseRepeatedCues,
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
  DEFAULT_EXPLAIN_PROMPT,
  correctNames,
  type ExplainResult,
} from "../lib/gemini.ts";
import { loadGlossary } from "../lib/glossary.ts";
import { guessEpisode } from "../lib/episode.ts";
import {
  listWords,
  getProgress,
  addCard,
  deleteCard,
  uploadImage,
  uploadMedia,
  resolveMediaName,
  ankiLocalAvailable,
  storeMedia,
  retrieveMedia,
  bustListWordsCache,
} from "../lib/anki.ts";
import { readSettings, writeSettings } from "../lib/settings.ts";
import {
  logEvent,
  logEvents,
  statsSummary,
  comprehensionSummary,
  readEvents,
  episodeSeries,
  overview,
  toCsv,
  todaySummary,
  healthSummaryFromFile,
  type TelemetryEvent,
} from "../lib/telemetry.ts";
import { readState, mergeIntoFile, type ZrState } from "../lib/state.ts";
import {
  buildExportBundle,
  exportFileName,
  importBundle,
} from "../lib/datatransfer.ts";
import {
  searchEntries,
  listFiles,
  downloadFile,
  pickConfidentEntry,
  fileMatchesEpisode,
  JimakuError,
} from "../lib/jimaku.ts";
import { showFrequency } from "../lib/mining.ts";
import { kataToHira } from "../lib/jatok.ts";
import {
  getIndex,
  clearIndexCache,
  encounters,
  comprehensibility,
  dueIntersection,
  type EntryIndex,
} from "../lib/tokenindex.ts";

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

/** Output path for the condensed-audio mp3: <videodir>/subs/<base>.condensed.mp3 */
function condensedPath(entry: LibraryEntry): string {
  const base = basename(entry.absPath, extname(entry.absPath));
  return join(dirname(entry.absPath), "subs", `${base}.condensed.mp3`);
}

// Per-media busy guard: condensing can take ~1 min; reject duplicates.
const condenseBusy = new Set<string>();

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
// --- /api/anki/words payload cache ---
// listWords()+getProgress() can take seconds (remote anki-mcp roundtrip or
// AnkiConnect over the whole deck), and the client fetches it on every Player
// mount. Cache the serialized payload with a TTL: serve stale immediately,
// refresh in the background; add/delete bust it and trigger an eager refresh.
const ANKI_WORDS_TTL_MS = 60_000;
interface AnkiWordsCacheEntry {
  body: string; // serialized { words, progress }
  etag: string; // strong ETag = hash of body
  ts: number; // when the payload was fetched
}
let ankiWordsCache: AnkiWordsCacheEntry | null = null;
let ankiWordsInflight: Promise<AnkiWordsCacheEntry> | null = null;
// Generation counter: a bust invalidates any refresh that STARTED before it,
// so an eager post-mutation refresh can never join a pre-mutation inflight
// and repopulate the cache with stale (pre-add/pre-delete) data.
let ankiWordsGen = 0;

function refreshAnkiWordsCache(): Promise<AnkiWordsCacheEntry> {
  if (!ankiWordsInflight) {
    const gen = ankiWordsGen;
    const p = (async () => {
      const _wordsT0 = Date.now();
      const [words, progress] = await Promise.all([listWords(), getProgress()]);
      void logEvent("perf.anki", { op: "words", ms: Date.now() - _wordsT0 });
      const body = JSON.stringify({ words, progress });
      const entry: AnkiWordsCacheEntry = {
        body,
        etag: `"${Bun.hash(body).toString(16)}"`,
        ts: Date.now(),
      };
      // A bust happened while we were fetching — this payload is stale.
      if (gen === ankiWordsGen) ankiWordsCache = entry;
      return entry;
    })().finally(() => {
      if (ankiWordsInflight === p) ankiWordsInflight = null;
    });
    ankiWordsInflight = p;
  }
  return ankiWordsInflight;
}

/** Bust the cache after a mutation and refresh eagerly so the next GET is hot. */
function bustAnkiWordsCache(): void {
  ankiWordsGen++;
  ankiWordsCache = null;
  ankiWordsInflight = null; // detach a stale inflight — start fresh
  ankiCardsGen++; // invalidate any cards refresh that started pre-mutation
  ankiCardsCache = null; // /api/anki/cards derives from listWords too
  ankiCardsInflight = null; // detach a stale cards inflight — start fresh
  bustListWordsCache(); // shared listWords cache must not serve pre-mutation data
  void refreshAnkiWordsCache().catch(() => {});
  void refreshAnkiCardsCache().catch(() => {});
}

// --- /api/anki/cards payload cache ---
// Mirrors the /api/anki/words pattern: stale-while-revalidate with a 60s TTL.
// Derives from the SAME shared listWords() cache, so a Cards-page mount that
// also fetches /api/anki/words pays at most one findNotes+notesInfo roundtrip.
const ANKI_CARDS_TTL_MS = 60_000;
interface AnkiCardsCacheEntry {
  body: string; // serialized card array
  ts: number;
}
let ankiCardsCache: AnkiCardsCacheEntry | null = null;
let ankiCardsInflight: Promise<AnkiCardsCacheEntry> | null = null;
// Generation guard (mirrors ankiWordsGen): a bust invalidates any refresh that
// STARTED before it, so a pre-mutation inflight can never repopulate the cache
// with stale (pre-add/pre-delete) data.
let ankiCardsGen = 0;

function refreshAnkiCardsCache(): Promise<AnkiCardsCacheEntry> {
  if (!ankiCardsInflight) {
    const gen = ankiCardsGen;
    const p = (async () => {
      const cards = (await listWords()).filter(
        (c) =>
          (Array.isArray(c.tags) && c.tags.includes("zehntage")) ||
          /\.(mkv|mp4)\s*@\s*\d+:\d{2}/i.test(c.context ?? ""),
      );
      const body = JSON.stringify(
        cards.map((c) => ({
          front: c.front ?? "",
          back: c.back ?? "",
          notes: c.notes ?? "",
          context: c.context ?? "",
          ...(typeof c.noteId === "number" ? { noteId: c.noteId } : {}),
        })),
      );
      const entry: AnkiCardsCacheEntry = { body, ts: Date.now() };
      // A bust happened while we were fetching — this payload is stale.
      if (gen === ankiCardsGen) ankiCardsCache = entry;
      return entry;
    })().finally(() => {
      if (ankiCardsInflight === p) ankiCardsInflight = null;
    });
    ankiCardsInflight = p;
  }
  return ankiCardsInflight;
}

// --- Anki media bytes cache ---
// Media is immutable per filename, so cache decoded bytes in-process and serve
// hits directly (saves an AnkiConnect retrieveMediaFile roundtrip per <img>).
// Bounded LRU: evict least-recently-used until under both the entry cap and
// the total-byte cap. Misses/errors are not cached.
const ANKI_MEDIA_MAX_ENTRIES = 512;
const ANKI_MEDIA_MAX_BYTES = 128 * 1024 * 1024; // 128 MiB
const ankiMediaCache = new Map<string, Uint8Array>(); // insertion order = LRU
let ankiMediaBytes = 0;

function ankiMediaGet(name: string): Uint8Array | undefined {
  const v = ankiMediaCache.get(name);
  if (v !== undefined) {
    // Touch: move to most-recently-used end.
    ankiMediaCache.delete(name);
    ankiMediaCache.set(name, v);
  }
  return v;
}

function ankiMediaPut(name: string, bytes: Uint8Array): void {
  const existing = ankiMediaCache.get(name);
  if (existing) {
    ankiMediaBytes -= existing.byteLength;
    ankiMediaCache.delete(name); // re-insert so an overwrite moves it to MRU
  }
  ankiMediaCache.set(name, bytes);
  ankiMediaBytes += bytes.byteLength;
  while (
    ankiMediaCache.size > ANKI_MEDIA_MAX_ENTRIES ||
    ankiMediaBytes > ANKI_MEDIA_MAX_BYTES
  ) {
    const oldest = ankiMediaCache.keys().next().value;
    if (oldest === undefined) break;
    const evicted = ankiMediaCache.get(oldest);
    ankiMediaCache.delete(oldest);
    if (evicted) ankiMediaBytes -= evicted.byteLength;
  }
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
        const _trT0 = Date.now();
        let translated: Awaited<ReturnType<typeof translateCues>>;
        try {
          translated = await translateCues(cues, item.targetLang);
        } catch (e) {
          void logEvent("anomaly.gemini_fail", { op: "translate", error: String(e), mediaId: item.entryId });
          throw e;
        }
        void logEvent("perf.gemini", { op: "translate", ms: Date.now() - _trT0, mediaId: item.entryId, cues: cues.length });
        await Bun.write(sidecarPath(entry, item.targetLang), cuesToSrt(translated));
        await library.refresh();
        item.status = "done";
        void logEvent("translate_done", { mediaId: item.entryId, lang: item.targetLang });
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

/** Reject a downloaded human sub that is desynced/truncated/sparse. */
function subPassesQuality(
  cues: Cue[],
  mediaDurSec: number,
): { ok: true } | { ok: false; reason: string } {
  if (cues.length < 20) return { ok: false, reason: `too few cues (${cues.length})` };
  const last = cues[cues.length - 1]!.end;
  const first = cues[0]!.start;
  // Coverage: subtitle span vs media duration. Tolerate trailing ED with a
  // generous floor; reject obviously-truncated files.
  if (mediaDurSec > 0) {
    const coverage = (last - first) / mediaDurSec;
    if (coverage < 0.6) return { ok: false, reason: `coverage ${coverage.toFixed(2)}` };
    // Last cue should not end far past the media (wrong-episode / wrong-fps).
    if (last > mediaDurSec * 1.1)
      return { ok: false, reason: `overruns media (${last.toFixed(0)}>${mediaDurSec.toFixed(0)})` };
    // First cue absurdly late => likely offset/desync.
    if (first > mediaDurSec * 0.25) return { ok: false, reason: `late start ${first.toFixed(0)}s` };
  }
  // Cue density: dialogue anime ~ >= 4 cues/min over the covered span.
  const spanMin = Math.max(1 / 60, (last - first) / 60);
  const density = cues.length / spanMin;
  if (density < 4) return { ok: false, reason: `density ${density.toFixed(1)}/min` };
  return { ok: true };
}

/** Attempt a confident, quality human JA sub from jimaku. Returns true if one
 *  was downloaded + accepted (external sidecar written + library refreshed). */
async function tryJimakuJa(library: Library, entry: LibraryEntry): Promise<boolean> {
  // Soft-skip if no API key (searchEntries throws JimakuError 401) — caller's
  // try/catch turns that into a whisper fallback.
  const query = jimakuQueryFromName(entry.name);
  if (!query) return false;
  const entries = await searchEntries(query);
  const match = pickConfidentEntry(query, entries);
  if (!match) {
    void logEvent("jimaku_no_match", { mediaId: entry.id, query, candidates: entries.length });
    return false;
  }

  // Episode-pinned-both-sides: require a local episode number AND a remote file
  // name carrying it. If we can't pin the episode locally, bail (whisper safer).
  const episode = guessEpisode(entry.name);
  if (episode == null) {
    void logEvent("jimaku_no_episode", { mediaId: entry.id, entryId: match.entry.id });
    return false;
  }
  const files = await listFiles(match.entry.id, episode);
  const subFiles = files.filter((f) => /\.(srt|ass|ssa|vtt)$/i.test(f.name));
  const candidate = subFiles.find((f) => fileMatchesEpisode(f.name, episode));
  if (!candidate) {
    void logEvent("jimaku_no_file", { mediaId: entry.id, entryId: match.entry.id, episode });
    return false;
  }

  const ext = extname(candidate.name).toLowerCase() || ".srt";
  const lang = jimakuLang(candidate.name); // "ja" unless suffixed
  if (!isJapaneseLang(lang)) return false; // only fetch JA here
  // Same external-sidecar convention as /api/jimaku/download: next to the
  // video, NOT under subs/ — so origin=external (distinguishable from whisper).
  const base = basename(entry.absPath, extname(entry.absPath));
  const dest = join(dirname(entry.absPath), `${base}.${lang}${ext}`);

  await downloadFile(candidate.url, dest);

  // Quality / sync gate.
  let cues: Cue[];
  try {
    cues = parseSubtitleText(await Bun.file(dest).text(), ext);
  } catch {
    await rm(dest).catch(() => {});
    void logEvent("anomaly.jimaku_reject", { mediaId: entry.id, reason: "unparseable" });
    return false;
  }
  const dur = await mediaDurationSec(entry.absPath);
  const q = subPassesQuality(cues, dur);
  if (!q.ok) {
    await rm(dest).catch(() => {});
    void logEvent("anomaly.jimaku_reject", {
      mediaId: entry.id,
      reason: q.reason,
      file: candidate.name,
    });
    return false;
  }

  await library.refresh();
  void logEvent("jimaku_auto", {
    mediaId: entry.id,
    entryId: match.entry.id,
    file: candidate.name,
    score: match.score,
    reason: match.reason,
  });
  return true;
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

    // --- jimaku-first: try a confident, quality human JA sub before whisper ---
    // ANY failure (no key/401, 429, parse, network, reject) → whisper fallback.
    try {
      const got = await tryJimakuJa(library, entry);
      if (got) {
        // Human sub accepted (external sidecar written). Translate straight to
        // ru from it — NO correctNames pass (that's whisper-only).
        const fresh = library.get(entry.id) ?? entry;
        const sourceTrack = await bestJapaneseTrackId(fresh);
        if (sourceTrack && !hasGeneratedRu(fresh) && !translateQueuedFor(fresh.id)) {
          enqueueTranslate(library, fresh.id, sourceTrack);
        }
        return "translate";
      }
    } catch (e) {
      void logEvent("anomaly.jimaku_fail", { mediaId: entry.id, error: String(e) });
      // fall through to whisper
    }

    // --- whisper fallback ---
    const job = whisperQueue.enqueue(entry.absPath, "ja", sidecarPath(entry, "ja"));
    const listener = (e: WhisperEvent) => {
      if (e.type !== "status") return;
      if (e.status === "done") {
        job.listeners.delete(listener);
        void (async () => {
          await library.refresh();
          const fresh = library.get(entry.id);
          if (!fresh) return;

          // --- name-correction pass on the WHISPER-generated ja sidecar ---
          // Only for generated whisper output; jimaku/external never reaches
          // this listener. Fail-safe: any error leaves the original sidecar.
          try {
            const jaPath = sidecarPath(fresh, "ja"); // subs/<base>.ja.srt
            const cues = parseSrt(await Bun.file(jaPath).text());
            const glossary = loadGlossary(dirname(fresh.absPath));
            const corrected = await correctNames(cues, glossary);
            const changed = corrected.some((c, i) => c.text !== cues[i]?.text);
            if (changed) {
              await Bun.write(jaPath, cuesToSrt(corrected));
              await library.refresh();
              void logEvent("correct_names", { mediaId: fresh.id, cues: cues.length });
            }
          } catch (err) {
            void logEvent("anomaly.correct_fail", { mediaId: fresh.id, error: String(err) });
            // non-fatal: translate the uncorrected ja sub
          }

          const f2 = library.get(entry.id);
          if (f2 && !hasGeneratedRu(f2) && !translateQueuedFor(f2.id)) {
            enqueueTranslate(library, f2.id, "sidecar:gen:ja");
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

// --- transcript search (lazy per-entry index over the best ja track) ---

function searchNorm(s: string): string {
  return kataToHira(s.toLowerCase());
}

interface SearchIndexEntry {
  key: string; // trackId|mtime — invalidates when the ja track changes
  lines: { start: number; text: string; norm: string }[];
}

const searchIndex = new Map<string, SearchIndexEntry>();
const SEARCH_INDEX_MAX = 64; // ~entries cached; a 25-min episode ≈ a few hundred KB

/** Latest mtime among the video and its ja sidecars (cache invalidation). */
async function jaMtime(entry: LibraryEntry): Promise<number> {
  let mt = (await stat(entry.absPath).catch(() => null))?.mtimeMs ?? 0;
  for (const s of entry.sidecarSubs) {
    if (!isJapaneseLang(s.lang)) continue;
    const st = await stat(s.path).catch(() => null);
    if (st && st.mtimeMs > mt) mt = st.mtimeMs;
  }
  return mt;
}

// Dedup concurrent first-searches: while one request is building an entry's
// index, others await the same promise instead of re-parsing the track.
const searchIndexBuilding = new Map<string, Promise<SearchIndexEntry | null>>();

function searchIndexFor(entry: LibraryEntry): Promise<SearchIndexEntry | null> {
  const inflight = searchIndexBuilding.get(entry.id);
  if (inflight) return inflight;
  const p = buildSearchIndex(entry).finally(() => searchIndexBuilding.delete(entry.id));
  searchIndexBuilding.set(entry.id, p);
  return p;
}

async function buildSearchIndex(entry: LibraryEntry): Promise<SearchIndexEntry | null> {
  const trackId = await bestJapaneseTrackId(entry);
  if (!trackId) return null;
  const key = `${trackId}|${await jaMtime(entry)}`;
  const hit = searchIndex.get(entry.id);
  if (hit && hit.key === key) return hit;
  const cues = await cuesForTrack(entry, trackId).catch(() => null);
  if (!cues) return null;
  const idx: SearchIndexEntry = {
    key,
    lines: cues.map((c) => ({ start: c.start, text: c.text, norm: searchNorm(c.text) })),
  };
  if (!searchIndex.has(entry.id) && searchIndex.size >= SEARCH_INDEX_MAX) {
    const oldest = searchIndex.keys().next().value;
    if (oldest !== undefined) searchIndex.delete(oldest);
  }
  searchIndex.set(entry.id, idx);
  return idx;
}

// --- lemma index (tokenindex.ts) lazy per-entry building -------------------
//
// getIndex() caches per entry (mtime-keyed); this set tracks which entries
// have EVER been built in this process so cross-library queries (encounters)
// can restrict themselves to "already indexed + explicitly requested" instead
// of tokenizing the whole library on the first popup.
const builtIndexIds = new Set<string>();

/** Build (or fetch the cached) lemma index for an entry's best ja track. */
async function entryIndexFor(entry: LibraryEntry): Promise<EntryIndex | null> {
  const trackId = await bestJapaneseTrackId(entry);
  if (!trackId) return null;
  try {
    const ix = await getIndex(entry, () => cuesForTrack(entry, trackId));
    builtIndexIds.add(entry.id);
    return ix;
  } catch {
    return null;
  }
}

/**
 * Collect indexes across the library with a build budget: entries already
 * indexed are free; at most `buildBudget` NEW entries get tokenized per call.
 */
async function collectIndexes(
  entries: LibraryEntry[],
  buildBudget: number,
): Promise<Map<string, EntryIndex>> {
  const out = new Map<string, EntryIndex>();
  let budget = buildBudget;
  for (const entry of entries) {
    const isNew = !builtIndexIds.has(entry.id);
    if (isNew) {
      if (budget <= 0) continue;
      budget--;
    }
    const ix = await entryIndexFor(entry);
    if (ix) out.set(entry.id, ix);
  }
  return out;
}

// --- jimaku.cc subtitle search helpers ---

/** Default jimaku search query from a video filename: strip the extension,
 * bracketed release tags, resolution/codec noise and a trailing episode no. */
export function jimakuQueryFromName(name: string): string {
  return name
    .replace(/\.[^.]+$/, "")
    .replace(/\[[^\]]*\]|\([^)]*\)/g, " ")
    .replace(
      /\b(\d{3,4}p|[48]k|x26[45]|h\.?26[45]|hevc|av1|aac|flac|opus|10.?bit|hi10p?|bd(rip)?|bluray|blu-ray|web-?(dl|rip)|hdtv|dual.?audio|multi.?sub)\b/gi,
      " ",
    )
    .replace(/[._]/g, " ")
    .replace(/\s*-\s*(s\d{1,2}e)?\d{1,3}(v\d)?\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function jimakuErr(e: unknown): Response {
  if (e instanceof JimakuError) {
    const msg =
      e.status === 401
        ? "JIMAKU_API_KEY not set (env or ~/.env)"
        : e.message;
    return err(msg, e.status);
  }
  return err(e instanceof Error ? e.message : String(e));
}

/** Sidecar language for a downloaded jimaku file: ".<lang>.<ext>" suffix in
 * the filename, else "ja" (jimaku hosts Japanese subs). */
function jimakuLang(name: string): string {
  const m = name.match(/\.([a-z]{2,3})(?:-[a-z]{2,4})?\.(?:srt|ass|ssa|vtt)$/i);
  return m ? m[1]!.toLowerCase() : "ja";
}

/**
 * One-time idempotent startup cleanup: collapse hallucinated repeat-runs in
 * existing generated subs/*.ja.srt sidecars. Rewrites only when changed.
 */
async function cleanupHallucinatedSidecars(library: Library): Promise<void> {
  let fixed = 0;
  for (const entry of library.list()) {
    for (const s of entry.sidecarSubs) {
      if (s.origin !== "generated" || !isJapaneseLang(s.lang) || s.ext !== ".srt")
        continue;
      try {
        const cues = parseSrt(await Bun.file(s.path).text());
        const collapsed = collapseRepeatedCues(cues);
        if (collapsed.length < cues.length) {
          await Bun.write(s.path, cuesToSrt(collapsed));
          fixed++;
          console.log(
            `[subs-cleanup] ${s.path}: ${cues.length} → ${collapsed.length} cues`,
          );
        }
      } catch {
        // unreadable sidecar — leave it alone
      }
    }
  }
  if (fixed > 0) console.log(`[subs-cleanup] rewrote ${fixed} file(s)`);
}

export interface ServerHandle {
  port: number;
  url: string;
  root: string;
  stop: () => void;
}

/** Root resolution: explicit arg > settings.mediaRoot (if it's a dir) > cwd. */
async function resolveRoot(explicit?: string): Promise<string> {
  if (explicit) return explicit;
  const settings = await readSettings();
  const saved = typeof settings.mediaRoot === "string" ? settings.mediaRoot : "";
  if (saved && (await stat(saved).catch(() => null))?.isDirectory()) return saved;
  return process.cwd();
}

export async function startServer(rootArg?: string, preferredPort = 8417): Promise<ServerHandle> {
  const root = await resolveRoot(rootArg);
  // Re-assignable: POST /api/root swaps in a new Library instance.
  let library = new Library(root);
  let currentRoot = root;
  // Idempotent: relocate legacy generated sidecars (renames are atomic, so
  // this is safe even while the previous instance is still serving).
  await migrateGeneratedSidecars(root).catch((e) =>
    console.warn(`[migrate] failed: ${e}`),
  );
  await library.refresh();
  await cleanupHallucinatedSidecars(library).catch((e) =>
    console.warn(`[subs-cleanup] failed: ${e}`),
  );

  /** Collapse variable path segments (hex ids, numeric ids) to ":id" for grouping. */
  function routePattern(pathname: string): string {
    return pathname
      .replace(/\/[a-f0-9]{8,}\b/g, "/:id")   // hex mediaId
      .replace(/\/\d+(?=\/|$)/g, "/:n")         // numeric id
      .replace(/\/[A-Za-z0-9+/=]{20,}(?=\/|$)/g, "/:b64"); // base64 segments
  }

  let _routeSampleN = 0;
  function shouldLogRoute(ms: number): boolean {
    if (ms > 50) return true;
    _routeSampleN++;
    return _routeSampleN % 10 === 0;
  }

  const fetchHandler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    const _t0 = Date.now();

    const _respond = async (): Promise<Response> => {
    try {
      // --- static / SPA ---
      if (req.method === "GET" && (path === "/" || path === "/index.html")) {
        return new Response(Bun.file(join(PUBLIC_DIR, "index.html")), {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-cache",
          },
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

      // --- transcript search across all entries' best ja tracks ---
      if (req.method === "GET" && path === "/api/search") {
        const q = (url.searchParams.get("q") ?? "").trim();
        if (!q) return json([]);
        const nq = searchNorm(q);
        const entries = await library.refresh();
        const hits: { mediaId: string; name: string; start: number; text: string }[] = [];
        for (const entry of entries) {
          if (hits.length >= 100) break;
          const idx = await searchIndexFor(entry);
          if (!idx) continue;
          for (const line of idx.lines) {
            if (!line.norm.includes(nq)) continue;
            hits.push({
              mediaId: entry.id,
              name: entry.name,
              start: line.start,
              text: line.text,
            });
            if (hits.length >= 100) break;
          }
        }
        return json(hits);
      }

      // --- media ---
      const media = path.match(/^\/media\/([a-f0-9]+)$/);
      if (req.method === "GET" && media) {
        const entry = library.get(media[1]!);
        if (!entry) return err("not found", 404);
        const info = await checkCodecs(entry.absPath).catch(() => null);
        if (info && !info.chromeCompatible) {
          const t = parseFloat(url.searchParams.get("t") ?? "0") || 0;
          return remuxToFmp4(entry.absPath, t, info, req.signal);
        }
        return serveFileWithRange(entry.absPath, req.headers.get("Range"));
      }

      // --- condensed audio: concat all primary-ja dialogue spans to one mp3 ---
      const condenseStart = path.match(/^\/api\/condense\/([a-f0-9]+)$/);
      if (req.method === "POST" && condenseStart) {
        const entry = library.get(condenseStart[1]!);
        if (!entry) return err("not found", 404);
        if (condenseBusy.has(entry.id)) return err("condense already running", 409);
        condenseBusy.add(entry.id);
        try {
          const trackId = await bestJapaneseTrackId(entry);
          if (!trackId) return err("no Japanese track", 400);
          const cues = await cuesForTrack(entry, trackId);
          const spans = mergeAudioSpans(
            cues.map((c) => ({ start: c.start, end: c.end })),
          );
          if (spans.length === 0) return err("no dialogue cues", 400);
          const out = condensedPath(entry);
          const duration = await condenseAudio(entry.absPath, spans, out);
          return json({ ok: true, path: out, duration });
        } finally {
          condenseBusy.delete(entry.id);
        }
      }

      const condensedGet = path.match(/^\/media\/condensed\/([a-f0-9]+)$/);
      if (req.method === "GET" && condensedGet) {
        const entry = library.get(condensedGet[1]!);
        if (!entry) return err("not found", 404);
        const out = condensedPath(entry);
        if (!(await stat(out).catch(() => null))) return err("not condensed yet", 404);
        return serveFileWithRange(out, req.headers.get("Range"));
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
        // Refresh so sidecars written since the last scan (e.g. a whisper job
        // that just finished) show up without requiring a /api/library hit.
        await library.refresh();
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
        const _whisperT0 = Date.now();
        const doneListener = (e: WhisperEvent) => {
          if (e.type !== "status") return;
          if (e.status === "done") {
            const _wMs = Date.now() - _whisperT0;
            void logEvent("whisper_done", { mediaId: entry.id, lang });
            void logEvent("perf.whisper", { ms: _wMs, mediaId: entry.id, lang, cues: job.cues.length });
            // Emit anomaly for each coverage warning the job accumulated.
            for (const w of job.warnings) {
              void logEvent("anomaly.whisper_warning", { message: w, mediaId: entry.id, lang });
            }
          }
          if (e.status === "done" || e.status === "error" || e.status === "canceled")
            job.listeners.delete(doneListener);
        };
        job.listeners.add(doneListener);
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
        const _exT0 = Date.now();
        let res: Awaited<ReturnType<typeof explainSentence>>;
        try {
          res = await explainSentence(
            body.sentence,
            body.secondary ?? "",
            body.source ?? "",
            body.context ?? "",
          );
        } catch (e) {
          void logEvent("anomaly.gemini_fail", { op: "explain", error: String(e) });
          throw e;
        }
        void logEvent("perf.gemini", { op: "explain", ms: Date.now() - _exT0 });
        explainCachePut(cacheKey, res);
        void logEvent("explain", { len: body.sentence.length });
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

        void logEvent("lookup", { word: body.word, mediaId: body.mediaId });
        const _gT0 = Date.now();
        let _lookupResult: Awaited<ReturnType<typeof lookupWord>>;
        try {
          _lookupResult = await lookupWord(
            body.word,
            body.context ?? "",
            body.source ?? "",
            image,
            body.secondary,
          );
        } catch (e) {
          void logEvent("anomaly.gemini_fail", { op: "lookup", error: String(e) });
          throw e;
        }
        void logEvent("perf.gemini", { op: "lookup", ms: Date.now() - _gT0 });
        return json(_lookupResult);
      }

      // --- directory browser (root navigator in the Library view) ---
      if (req.method === "GET" && path === "/api/browse") {
        const raw = (url.searchParams.get("path") ?? "").trim() || currentRoot;
        if (!raw.startsWith("/")) return err("path must be absolute", 400);
        const p = resolve(raw); // normalize ".." segments / trailing slashes
        const st = await stat(p).catch(() => null);
        if (!st?.isDirectory()) return err(`not a directory: ${p}`, 400);
        const entries = await readdir(p, { withFileTypes: true }).catch(() => []);
        const dirs = entries
          .filter((d) => d.isDirectory() && !d.name.startsWith("."))
          .map((d) => d.name)
          .sort((a, b) => a.localeCompare(b));
        const parent = dirname(p);
        return json({ path: p, parent: parent === p ? null : parent, dirs });
      }

      // --- Anki ---
      // Cached: serve the last payload immediately (stale-while-revalidate
      // with a 60s TTL) and revalidate via ETag/If-None-Match.
      if (req.method === "GET" && path === "/api/anki/words") {
        let c = ankiWordsCache;
        if (!c) {
          c = await refreshAnkiWordsCache();
        } else if (Date.now() - c.ts > ANKI_WORDS_TTL_MS) {
          // Stale: serve immediately, refresh in the background.
          void refreshAnkiWordsCache().catch(() => {});
        }
        const headers = {
          "Content-Type": "application/json",
          ETag: c.etag,
          "Cache-Control": "no-cache",
        };
        if (req.headers.get("if-none-match") === c.etag) {
          return new Response(null, { status: 304, headers });
        }
        return new Response(c.body, { headers });
      }

      // Fuller card info for the Cards browser tab (front/back/notes/context).
      // OURS ONLY: the deck may also hold unrelated cards (chemistry, German…)
      // — keep a card when it carries our "zehntage" tag (local AnkiConnect)
      // or its context contains our source line ("<episode>.mkv @ mm:ss").
      if (req.method === "GET" && path === "/api/anki/cards") {
        let c = ankiCardsCache;
        if (!c) {
          c = await refreshAnkiCardsCache();
        } else if (Date.now() - c.ts > ANKI_CARDS_TTL_MS) {
          // Stale: serve immediately, refresh in the background.
          void refreshAnkiCardsCache().catch(() => {});
        }
        return new Response(c.body, {
          headers: { "Content-Type": "application/json" },
        });
      }

      // Media proxy: serve files from the LOCAL Anki collection (AnkiConnect
      // retrieveMediaFile, base64 → bytes). Lets the Cards tab render card
      // images whose <img> srcs are bare Anki media filenames.
      const ankiMedia = path.match(/^\/api\/anki\/media\/([^/]+)$/);
      if (req.method === "GET" && ankiMedia) {
        const name = decodeURIComponent(ankiMedia[1]!);
        if (name.includes("/") || name.includes("..")) return err("bad name", 400);
        let bytes = ankiMediaGet(name);
        if (!bytes) {
          const fetched = await retrieveMedia(name);
          if (!fetched) return err("media not found", 404); // don't cache misses
          ankiMediaPut(name, fetched);
          bytes = fetched;
        }
        const types: Record<string, string> = {
          ".jpg": "image/jpeg",
          ".jpeg": "image/jpeg",
          ".png": "image/png",
          ".gif": "image/gif",
          ".webp": "image/webp",
          ".svg": "image/svg+xml",
          ".mp3": "audio/mpeg",
          ".ogg": "audio/ogg",
          ".wav": "audio/wav",
          ".m4a": "audio/mp4",
          ".webm": "video/webm",
        };
        return new Response(bytes, {
          headers: {
            "Content-Type": types[extname(name).toLowerCase()] ?? "application/octet-stream",
            "Cache-Control": "public, max-age=31536000, immutable",
          },
        });
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
          /** RU translation of the sentence (matching secondary cue), optional. */
          sentenceTranslation?: string;
        };
        if (!body.word || !body.translation) return err("word and translation required", 400);

        // Context format (lines joined with <br>):
        //   (1) JP sentence  (2) image  (3) RU sentence translation
        //   (4) [sound:...]  (5) source "file @ mm:ss" LAST.
        // On the remote anki-mcp path the image travels via the `image`
        // param instead (the remote server controls its placement).
        const _ankiProbeT0 = Date.now();
        const useLocal = await ankiLocalAvailable();
        void logEvent("perf.anki", { op: "probe", ms: Date.now() - _ankiProbeT0, local: useLocal });
        let imgLine: string | undefined;
        let soundLine: string | undefined;
        let sourceLine: string | undefined;
        let image: string | undefined;
        if (body.mediaId !== undefined && body.timestamp !== undefined) {
          const entry = library.get(body.mediaId);
          if (entry) {
            const ts = Math.max(0, body.timestamp);
            const mm = Math.floor(ts / 60);
            const ss = Math.floor(ts % 60);
            sourceLine = `${entry.name} @ ${mm}:${String(ss).padStart(2, "0")}`;
            const stamp = `${mm}m${String(ss).padStart(2, "0")}s`;
            const slug = basename(entry.name, extname(entry.name))
              .replace(/[^\w.-]+/g, "_")
              .slice(0, 60);
            try {
              const frame = await captureFrame(entry.absPath, ts, 320);
              if (useLocal) {
                // Real filename straight into the local collection.
                const name = await storeMedia(frame, `zr-${slug}-${stamp}.jpg`);
                imgLine = `<img src="${name}">`;
              } else {
                // Upload the frame as a real Anki media file instead of
                // inlining a base64 JPEG into context.
                image = await uploadImage(frame, "image/jpeg");
              }
            } catch {
              // no frame — card still goes through
            }
            // Sentence audio: cut the cue's audio and reference it via
            // [sound:...]. Any failure along the way is non-fatal.
            if (
              typeof body.cueStart === "number" &&
              typeof body.cueEnd === "number" &&
              body.cueEnd > body.cueStart
            ) {
              try {
                const audio = await cutAudio(entry.absPath, body.cueStart, body.cueEnd);
                if (useLocal) {
                  const name = await storeMedia(audio, `zr-${slug}-${stamp}.mp3`);
                  soundLine = `[sound:${name}]`;
                } else {
                  const path = await uploadMedia(audio, "audio/mpeg", "sentence.mp3");
                  const mediaName = await resolveMediaName(path);
                  if (mediaName) soundLine = `[sound:${mediaName}]`;
                }
              } catch {
                // no audio — card still goes through
              }
            }
          }
        }
        const context = [
          body.context ?? "",
          imgLine,
          body.sentenceTranslation,
          soundLine,
          sourceLine,
        ]
          .filter((s): s is string => Boolean(s && s.trim()))
          .join("<br>");

        const front = body.reading ? `${body.word} [${body.reading}]` : body.word;
        const _addT0 = Date.now();
        await addCard({
          front,
          back: body.translation,
          notes: body.notes ?? "",
          context,
          tags: ["zehntage"],
          ...(image ? { image, image_field: "context" } : {}),
        });
        const _addMs = Date.now() - _addT0;
        bustAnkiWordsCache();
        void logEvent("perf.anki", { op: "add", ms: _addMs });
        void logEvent("anki_add", { word: body.word, mediaId: body.mediaId });
        if (_addMs > 3000) {
          void logEvent("anomaly.anki_slow", { op: "add", ms: _addMs });
        }
        return json({ ok: true });
      }

      if (req.method === "POST" && path === "/api/anki/delete") {
        const body = (await req.json()) as { front?: string };
        if (!body.front) return err("front required", 400);
        await deleteCard(body.front);
        bustAnkiWordsCache();
        return json({ ok: true });
      }

      // --- library root (current root + re-root) ---
      if (path === "/api/root") {
        if (req.method === "GET") {
          return json({ root: currentRoot, count: library.list().length });
        }
        if (req.method === "POST") {
          const body = (await req.json().catch(() => ({}))) as { path?: string };
          const p = (body.path ?? "").trim();
          if (!p) return err("path required", 400);
          const st = await stat(p).catch(() => null);
          if (!st?.isDirectory()) return err(`not a directory: ${p}`, 400);
          library = new Library(p);
          currentRoot = p;
          await migrateGeneratedSidecars(p).catch(() => {});
          await library.refresh();
          searchIndex.clear();
          clearIndexCache();
          builtIndexIds.clear();
          // Persist so the next argument-less CLI start reuses this root.
          await writeSettings({ mediaRoot: p });
          return json({ root: currentRoot, count: library.list().length });
        }
      }

      // --- telemetry: client event batches + summary ---
      if (req.method === "POST" && path === "/api/events") {
        const body = (await req.json().catch(() => ({}))) as {
          events?: TelemetryEvent[];
        };
        if (!Array.isArray(body.events)) return err("events array required", 400);
        await logEvents(body.events);
        return json({ ok: true, count: body.events.length });
      }

      if (req.method === "GET" && path === "/api/stats/summary") {
        return json(await statsSummary());
      }

      // --- analytics v2: per-(media,day) series, overview, CSV export ---
      if (req.method === "GET" && path === "/api/stats/episodes") {
        return json(episodeSeries(await readEvents()));
      }
      if (req.method === "GET" && path === "/api/stats/episodes.csv") {
        return new Response(toCsv(episodeSeries(await readEvents())), {
          headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": 'attachment; filename="episodes.csv"',
          },
        });
      }
      if (req.method === "GET" && path === "/api/stats/overview") {
        return json(overview(await readEvents()));
      }
      if (req.method === "GET" && path === "/api/stats/comprehension") {
        return json(await comprehensionSummary());
      }
      if (req.method === "GET" && path === "/api/stats/today") {
        return json(await todaySummary());
      }

      // --- lemma index queries (lazy per-entry indexes, ja track) ---
      if (req.method === "GET" && path === "/api/index/encounters") {
        const lemma = (url.searchParams.get("lemma") ?? "").trim();
        if (!lemma) return err("lemma required", 400);
        const wanted = new Set(
          (url.searchParams.get("mediaIds") ?? "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        );
        const entries = library.list();
        // Only entries already indexed + explicitly requested ones get built;
        // a popup hover must never trigger a full-library tokenize.
        const scope = entries.filter(
          (e) => wanted.has(e.id) || builtIndexIds.has(e.id),
        );
        const indexes = await collectIndexes(scope, wanted.size || 1);
        const names = new Map(entries.map((e) => [e.id, e.name]));
        return json(
          encounters(lemma, indexes.values()).map((h) => ({
            ...h,
            name: names.get(h.mediaId) ?? h.mediaId,
          })),
        );
      }

      if (
        path === "/api/index/comprehensibility" &&
        (req.method === "GET" || req.method === "POST")
      ) {
        let known: string[] = [];
        if (req.method === "POST") {
          const body = (await req.json().catch(() => ({}))) as { known?: unknown };
          if (Array.isArray(body.known))
            known = body.known.filter((k): k is string => typeof k === "string");
        } else {
          known = (url.searchParams.get("known") ?? "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        }
        const knownSet = new Set(known);
        const entries = library.list();
        const _tokT0 = Date.now();
        const indexes = await collectIndexes(entries, 30); // budget: ≤30 new builds
        void logEvent("perf.tokenize", { op: "comprehensibility", ms: Date.now() - _tokT0, indexed: indexes.size });
        const out: {
          mediaId: string;
          name: string;
          pctKnown: number | null;
          unknown: { lemma: string; count: number }[];
        }[] = [];
        for (const entry of entries) {
          const ix = indexes.get(entry.id);
          if (!ix) continue;
          const c = comprehensibility(ix, knownSet, 10);
          out.push({
            mediaId: entry.id,
            name: entry.name,
            pctKnown: c.pctKnown,
            unknown: c.unknownLemmas,
          });
        }
        return json(out);
      }

      if (req.method === "POST" && path === "/api/index/due") {
        const body = (await req.json().catch(() => ({}))) as {
          dueFronts?: unknown;
        };
        if (!Array.isArray(body.dueFronts))
          return err("dueFronts array required", 400);
        // Anki fronts are "word" or "word [reading]" — the index keys on lemmas.
        const dueSet = new Set(
          body.dueFronts
            .filter((f): f is string => typeof f === "string")
            .map((f) => f.replace(/\s*\[.*$/, "").trim())
            .filter(Boolean),
        );
        const entries = library.list();
        const _tokDueT0 = Date.now();
        const indexes = await collectIndexes(entries, 30);
        void logEvent("perf.tokenize", { op: "due", ms: Date.now() - _tokDueT0, indexed: indexes.size });
        const out: {
          mediaId: string;
          name: string;
          count: number;
          lemmas: { lemma: string; count: number }[];
        }[] = [];
        for (const entry of entries) {
          const ix = indexes.get(entry.id);
          if (!ix) continue;
          const di = dueIntersection(ix, dueSet);
          out.push({
            mediaId: entry.id,
            name: entry.name,
            count: di.count,
            lemmas: di.lemmas
              .slice(0, 10)
              .map(({ lemma, count }) => ({ lemma, count })),
          });
        }
        return json(out);
      }

      // --- show-local lemma frequency (pre-study ordering) ---
      if (req.method === "GET" && path === "/api/index/showfreq") {
        const ids = (url.searchParams.get("mediaIds") ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        const wanted = new Set(ids);
        const scope = library.list().filter((e) => wanted.has(e.id));
        const _tokSfT0 = Date.now();
        const indexes = await collectIndexes(scope, Math.max(1, scope.length));
        void logEvent("perf.tokenize", { op: "showfreq", ms: Date.now() - _tokSfT0, indexed: indexes.size });
        return json(Object.fromEntries(showFrequency(indexes.values())));
      }

      // --- zr.* localStorage state sync (web/sync.ts <-> src/lib/state.ts) ---
      if (path === "/api/state") {
        if (req.method === "GET") return json(await readState());
        if (req.method === "POST") {
          const body = (await req.json().catch(() => ({}))) as ZrState;
          return json(await mergeIntoFile(body));
        }
      }

      // --- jimaku.cc subtitle directory ---
      if (req.method === "GET" && path === "/api/jimaku/search") {
        let query = (url.searchParams.get("query") ?? "").trim();
        const mediaId = url.searchParams.get("mediaId") ?? "";
        if (!query && mediaId) {
          const entry = library.get(mediaId);
          if (entry) query = jimakuQueryFromName(entry.name);
        }
        if (!query) return err("query or mediaId required", 400);
        try {
          return json({ query, entries: await searchEntries(query) });
        } catch (e) {
          return jimakuErr(e);
        }
      }

      if (req.method === "GET" && path === "/api/jimaku/files") {
        const entryId = parseInt(url.searchParams.get("entryId") ?? "", 10);
        if (!Number.isFinite(entryId)) return err("entryId required", 400);
        const epRaw = url.searchParams.get("episode");
        const episode = epRaw != null && epRaw !== "" ? parseInt(epRaw, 10) : undefined;
        try {
          return json(
            await listFiles(
              entryId,
              episode != null && Number.isFinite(episode) ? episode : undefined,
            ),
          );
        } catch (e) {
          return jimakuErr(e);
        }
      }

      if (req.method === "POST" && path === "/api/jimaku/download") {
        const body = (await req.json().catch(() => ({}))) as {
          mediaId?: string;
          url?: string;
          name?: string;
        };
        if (!body.mediaId || !body.url || !body.name)
          return err("mediaId, url and name required", 400);
        const entry = library.get(body.mediaId);
        if (!entry) return err("not found", 404);
        const ext = extname(body.name).toLowerCase() || ".srt";
        const lang = jimakuLang(body.name);
        // External-origin sidecar: next to the video as <base>.<lang>.<ext>
        // (files under subs/ would be classified as generated).
        const base = basename(entry.absPath, extname(entry.absPath));
        const dest = join(dirname(entry.absPath), `${base}.${lang}${ext}`);
        try {
          const bytes = await downloadFile(body.url, dest);
          await library.refresh();
          void logEvent("jimaku_download", { mediaId: entry.id, name: body.name });
          return json({ ok: true, path: dest, lang, bytes });
        } catch (e) {
          return jimakuErr(e);
        }
      }

      // --- data export / import (portable JSON bundle, see lib/datatransfer.ts) ---
      if (req.method === "GET" && path === "/api/export") {
        const bundle = await buildExportBundle();
        return new Response(JSON.stringify(bundle, null, 2), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Content-Disposition": `attachment; filename="${exportFileName()}"`,
          },
        });
      }

      if (req.method === "POST" && path === "/api/import") {
        let raw: unknown;
        try {
          raw = await req.json();
        } catch {
          return err("invalid JSON body", 400);
        }
        // Events are skipped by default; ?importEvents=1 opts in.
        const importEvents = url.searchParams.get("importEvents") === "1";
        try {
          return json(await importBundle(raw, { importEvents }));
        } catch (e) {
          return err(e instanceof Error ? e.message : "import failed", 400);
        }
      }

      // --- settings ---
      if (path === "/api/settings") {
        if (req.method === "GET") {
          const settings = await readSettings();
          return json({
            ...settings,
            lookupPromptDefault: DEFAULT_LOOKUP_PROMPT,
            explainPromptDefault: DEFAULT_EXPLAIN_PROMPT,
          });
        }
        if (req.method === "POST") {
          const patch = (await req.json()) as Record<string, unknown>;
          return json(await writeSettings(patch));
        }
      }

      // --- health / perf summary (last 24h) ---
      if (req.method === "GET" && path === "/api/health/summary") {
        return json(await healthSummaryFromFile());
      }

      // --- other static assets in public/ ---
      if (req.method === "GET" && !path.startsWith("/api/")) {
        const file = Bun.file(join(PUBLIC_DIR, path.slice(1)));
        if (await file.exists()) {
          // App bundle must never be served stale; dict/freq keep defaults.
          const noCache = path === "/app.js" || path === "/app.css";
          return new Response(
            file,
            noCache ? { headers: { "Cache-Control": "no-cache" } } : undefined,
          );
        }
      }

      return err("not found", 404);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
    }; // end _respond

    const _res = await _respond();
    const _ms = Date.now() - _t0;
    if (shouldLogRoute(_ms)) {
      void logEvent("perf.route", {
        path: routePattern(path),
        ms: _ms,
        status: _res.status,
        method: req.method,
      });
    }
    return _res;
  };

  // Try preferred port, fall back to an ephemeral one.
  let server: ReturnType<typeof Bun.serve>;
  // cap request bodies (8 MiB) so POST /api/import can't be used to OOM the server
  const MAX_BODY = 8 * 1024 * 1024;
  try {
    server = Bun.serve({ port: preferredPort, idleTimeout: 0, maxRequestBodySize: MAX_BODY, fetch: fetchHandler });
  } catch {
    server = Bun.serve({ port: 0, idleTimeout: 0, maxRequestBodySize: MAX_BODY, fetch: fetchHandler });
  }

  return {
    port: server.port ?? preferredPort,
    url: `http://localhost:${server.port}`,
    root,
    stop: () => server.stop(true),
  };
}
