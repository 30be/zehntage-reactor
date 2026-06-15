// zehntage-reactor HTTP server (Bun.serve).

import { extname, join, dirname, basename, resolve } from "node:path";
import { stat, readdir, rm, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { timingSafeEqual } from "node:crypto";
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
  exportMediaFileName,
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
  looksJapanese,
  JAPANESE_KANA_MIN,
  type Cue,
  type SubTrack,
} from "../lib/subs.ts";
import { whisperQueue, atomicWrite, type WhisperEvent } from "../lib/whisper.ts";
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
  bustListWordsCache,
  fakeResetQueue,
} from "../lib/anki.ts";
import {
  reviewQueueAuto,
  answerCardAuto,
  deleteNoteAuto,
  deleteNoteByFrontAuto,
  deckCountsAuto,
  reviewStatus,
  addNoteAuto,
  listCardsAuto,
  progressAuto,
  mediaAuto,
} from "../lib/review.ts";
import { dbStoreMedia, collectionPath } from "../lib/ankidb.ts";
import { readSettings, writeSettings } from "../lib/settings.ts";
import { parseEnvText } from "../lib/env.ts";
import {
  logEvent,
  logEvents,
  statsSummary,
  comprehensionSummary,
  readEvents,
  episodeSeries,
  overview,
  wordsAddedPerDay,
  toCsv,
  todaySummary,
  wordHistoryFromFile,
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
  listSnapshots,
  readSnapshot,
  maybeSnapshotOnStartup,
} from "../lib/backup.ts";
import {
  searchEntries,
  listFiles,
  downloadFile,
  pickConfidentEntry,
  fileMatchesEpisode,
  rankJimakuCandidates,
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

// --- ZEHNTAGE_DB_TOKEN auth gate (for write-back endpoints) -----------------
// Read once from ~/.env (parsed via env.ts) with a process-env fallback. When
// the var is UNSET the gate is OPEN (returns null from requireDbToken) so we
// never lock the user out before they opt in. When SET, requests must present
// the token (Authorization: Bearer <t> or X-Zehntage-Token: <t>), compared in
// constant time.
let _dbToken: string | null | undefined; // undefined = not yet loaded
async function dbToken(): Promise<string | null> {
  if (_dbToken !== undefined) return _dbToken;
  let fromFile: string | undefined;
  try {
    const vars = parseEnvText(await Bun.file(join(homedir(), ".env")).text());
    fromFile = vars["ZEHNTAGE_DB_TOKEN"];
  } catch {
    // missing ~/.env is fine — fall back to process env
  }
  const tok = (fromFile ?? process.env.ZEHNTAGE_DB_TOKEN ?? "").trim();
  _dbToken = tok.length > 0 ? tok : null;
  return _dbToken;
}

/** Constant-time string compare that doesn't leak length via early return. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    // Still run a compare against a same-length buffer to keep timing flat.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/** Extract the presented token from Authorization: Bearer / X-Zehntage-Token. */
function presentedToken(req: Request): string {
  const auth = req.headers.get("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1]!.trim();
  return (req.headers.get("x-zehntage-token") ?? "").trim();
}

/**
 * Auth gate for write-back endpoints. Returns a 401 Response to short-circuit
 * when a token IS configured but the request doesn't match; returns null (allow)
 * when the gate is open (token unset) or the presented token is valid.
 */
async function requireDbToken(req: Request): Promise<Response | null> {
  const want = await dbToken();
  if (!want) return null; // gate open — don't lock the user out
  if (safeEqual(presentedToken(req), want)) return null;
  return err("unauthorized", 401);
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

// Parsed-cue cache keyed by (entry id + track id) and fingerprinted by the
// SOURCE file's mtime+size. The translation batch rewrites .ru.srt sidecars in
// place, so keying on mtime is essential: a regenerated track changes mtime and
// invalidates the slot, never serving a stale parse. Sidecars key on the sub
// file; embedded tracks key on the media container (and so also avoid re-running
// ffmpeg extraction on every request). Parsed cues are treated as immutable by
// callers, so returning a shared reference is safe.
interface CueCacheSlot {
  sig: string; // `${mtimeMs}:${size}` of the source file
  cues: Cue[];
}
const cueCache = new Map<string, CueCacheSlot>();

async function fileSig(path: string): Promise<string> {
  try {
    const st = await stat(path);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "gone";
  }
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
    const cacheKey = `${entry.id}|${trackId}`;
    const sig = await fileSig(sub.path);
    const hit = cueCache.get(cacheKey);
    if (hit && hit.sig === sig) return hit.cues;
    const cues = parseSubtitleText(await Bun.file(sub.path).text(), sub.ext);
    cueCache.set(cacheKey, { sig, cues });
    return cues;
  }
  if (trackId.startsWith("embedded:")) {
    const index = parseInt(trackId.slice("embedded:".length), 10);
    const cacheKey = `${entry.id}|${trackId}`;
    const sig = await fileSig(entry.absPath);
    const hit = cueCache.get(cacheKey);
    if (hit && hit.sig === sig) return hit.cues;
    const cues = parseSrt(await extractEmbeddedTrack(entry.absPath, index));
    cueCache.set(cacheKey, { sig, cues });
    return cues;
  }
  throw new Error(`bad track id: ${trackId}`);
}

// BCP-47-ish language tag (e.g. "ja", "jpn", "ru", "ja-JP"). `lang`/`targetLang`
// flow into sidecarPath() as a filename component; validate before use so a value
// like "../../evil" can't escape the subs/ directory (path injection).
const LANG_RE = /^[a-z]{2,3}(-[a-z]{2,4})?$/i;
function isValidLang(lang: string): boolean {
  return LANG_RE.test(lang);
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

// translateBatch only ever grows via push; finished (done/error) items would
// otherwise accumulate forever (memory leak + ever-slower find/some/filter
// scans). Cap retained finished items at the most recent N; never touch
// queued/running entries (the active run reported by /api/batch/status).
const TRANSLATE_BATCH_FINISHED_MAX = 200;
function trimTranslateBatch(): void {
  let finished = 0;
  for (const i of translateBatch) {
    if (i.status === "done" || i.status === "error") finished++;
  }
  let toDrop = finished - TRANSLATE_BATCH_FINISHED_MAX;
  if (toDrop <= 0) return;
  for (let k = 0; k < translateBatch.length && toDrop > 0; ) {
    const s = translateBatch[k]!.status;
    if (s === "done" || s === "error") {
      translateBatch.splice(k, 1);
      toDrop--;
    } else {
      k++;
    }
  }
}

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
      const [words, progress] = await Promise.all([listCardsAuto(), progressAuto()]);
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
      const cards = (await listCardsAuto()).filter(
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
      trimTranslateBatch();
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
        await atomicWrite(sidecarPath(entry, item.targetLang), cuesToSrt(translated));
        await library.refresh();
        item.status = "done";
        void logEvent("translate_done", { mediaId: item.entryId, lang: item.targetLang });
      } catch (e) {
        item.status = "error";
        item.error = e instanceof Error ? e.message : String(e);
        // Surface translate failures so a bulk run doesn't silently leave
        // missing ru sidecars — also countable via /api/batch/status.
        void logEvent("anomaly.translate_error", {
          mediaId: item.entryId,
          name: library.get(item.entryId)?.name ?? null,
          lang: item.targetLang,
          reason: item.error,
        });
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

/** "ru", "rus", "ru-RU", … */
function isRussianLang(lang: string): boolean {
  return /^(ru|rus)(-|$)/i.test(lang);
}

/** Best Russian track id (prefer generated, then external sidecar). RU is not
 * extracted from embedded tracks here — the RU translation we care about is the
 * generated/external sidecar paired with the ja track. Returns null if none. */
function bestRussianTrackId(entry: LibraryEntry): string | null {
  const gen = entry.sidecarSubs.find(
    (s) => s.origin === "generated" && isRussianLang(s.lang),
  );
  if (gen) return `sidecar:gen:${gen.lang}`;
  const ext = entry.sidecarSubs.find(
    (s) => s.origin === "external" && isRussianLang(s.lang),
  );
  if (ext) return `sidecar:${ext.lang}${ext.ext}`;
  return null;
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
export function subPassesQuality(
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
    // First cue absurdly late => likely offset/desync. Absolute floor so a long
    // cold open / OP (2-3 min) isn't rejected on slow episodes.
    const lateFloor = Math.max(120, mediaDurSec * 0.15);
    if (first > lateFloor)
      return { ok: false, reason: `late start ${first.toFixed(0)}s (>${lateFloor.toFixed(0)})` };
  }
  // Cue density: dialogue anime ~ >= 2.5 cues/min over the covered span
  // (slow/quiet episodes legitimately have fewer cues).
  const spanMin = Math.max(1 / 60, (last - first) / 60);
  const density = cues.length / spanMin;
  if (density < 2.5) return { ok: false, reason: `density ${density.toFixed(1)}/min` };
  return { ok: true };
}

/** Attempt a confident, quality human JA sub from jimaku. Returns true if one
 *  was downloaded + accepted (external sidecar written + library refreshed). */
// Space out jimaku API hits across episodes during a bulk run so the
// back-to-back search+list+download bursts don't trip rate limits. Whisper is
// already serialized and translation runs through its own pump — neither is
// affected by this gate.
const JIMAKU_MIN_GAP_MS = 750;
let jimakuLastCallAt = 0;
async function jimakuThrottle(): Promise<void> {
  const wait = jimakuLastCallAt + JIMAKU_MIN_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  jimakuLastCallAt = Date.now();
}

async function tryJimakuJa(library: Library, entry: LibraryEntry): Promise<boolean> {
  // Soft-skip if no API key (searchEntries throws JimakuError 401) — caller's
  // try/catch turns that into a whisper fallback.
  const query = jimakuQueryFromName(entry.name);
  if (!query) return false;
  await jimakuThrottle();
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
  // Build an ORDERED, best-first candidate list (prefer text formats + JA hints,
  // demote Chinese fansubs) and require the episode to be pinned on the filename.
  const candidates = rankJimakuCandidates(files).filter((f) =>
    fileMatchesEpisode(f.name, episode),
  );
  if (candidates.length === 0) {
    void logEvent("jimaku_no_file", { mediaId: entry.id, entryId: match.entry.id, episode });
    return false;
  }

  const dur = await mediaDurationSec(entry.absPath);
  if (dur <= 0) {
    // ffprobe couldn't determine duration => coverage/overrun/late-start checks
    // are skipped (only cue-count + density apply). Surface it so a toothless
    // gate is visible, but don't hard-fail regen on an ffprobe hiccup.
    void logEvent("anomaly.jimaku_no_duration", { mediaId: entry.id });
  }

  // Try candidates best-first. The first that passes ALL gates — episode pin
  // (already filtered), quality/sync, AND the Japanese language guard — wins and
  // is atomically published. Each rejection deletes its temp and falls through
  // to the next; if none pass we return false → whisper fallback.
  for (const candidate of candidates) {
    const ext = extname(candidate.name).toLowerCase() || ".srt";
    const lang = jimakuLang(candidate.name); // "ja" unless suffixed
    if (!isJapaneseLang(lang)) continue; // only fetch JA-tagged tracks here
    // Same external-sidecar convention as /api/jimaku/download: next to the
    // video, NOT under subs/ — so origin=external (distinguishable from whisper).
    const base = basename(entry.absPath, extname(entry.absPath));
    const dest = join(dirname(entry.absPath), `${base}.${lang}${ext}`);
    // Download to a temp path and only rename to the real sidecar AFTER every
    // gate passes. A crash/failure must never leave an unvetted sidecar at
    // `dest` (hasJapaneseTrack would then trust it forever).
    const tmp = `${dest}.tmp-${process.pid}`;

    await downloadFile(candidate.url, tmp);

    let cues: Cue[];
    try {
      cues = parseSubtitleText(await Bun.file(tmp).text(), ext);
    } catch {
      await rm(tmp).catch(() => {});
      void logEvent("anomaly.jimaku_reject", {
        mediaId: entry.id,
        reason: "unparseable",
        file: candidate.name,
      });
      continue;
    }

    // Language guard (PRIMARY defense against Chinese fansubs): a real JA track
    // is kana-heavy; Chinese hanzi-only subs score ~0. Reject below threshold.
    if (!looksJapanese(cues)) {
      await rm(tmp).catch(() => {});
      void logEvent("anomaly.jimaku_reject", {
        mediaId: entry.id,
        reason: `not-japanese (kana<${JAPANESE_KANA_MIN})`,
        file: candidate.name,
      });
      continue;
    }

    const q = subPassesQuality(cues, dur);
    if (!q.ok) {
      await rm(tmp).catch(() => {});
      void logEvent("anomaly.jimaku_reject", {
        mediaId: entry.id,
        reason: q.reason,
        file: candidate.name,
      });
      continue;
    }

    // Passed — atomically publish the vetted sub to its final sidecar path.
    try {
      await rename(tmp, dest);
    } catch (e) {
      await rm(tmp).catch(() => {});
      void logEvent("anomaly.jimaku_reject", {
        mediaId: entry.id,
        reason: `rename failed: ${String(e)}`,
        file: candidate.name,
      });
      continue;
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

  return false;
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
              await atomicWrite(jaPath, cuesToSrt(corrected));
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

/** RU normalization: kana-folding is JA-specific, so RU only lowercases/trims. */
function searchNormRu(s: string): string {
  return s.toLowerCase().trim();
}

interface SearchIndexEntry {
  key: string; // jaTrackId|ruTrackId|mtime — invalidates when either track changes
  lines: {
    start: number;
    text: string; // JA cue text
    norm: string; // JA normalized
    ru?: string; // paired RU cue text (when an RU track exists)
    ruNorm?: string; // RU normalized
  }[];
}

const searchIndex = new Map<string, SearchIndexEntry>();
const SEARCH_INDEX_MAX = 64; // ~entries cached; a 25-min episode ≈ a few hundred KB

/** Latest mtime among the video and its ja/ru sidecars (cache invalidation). */
async function jaMtime(entry: LibraryEntry): Promise<number> {
  let mt = (await stat(entry.absPath).catch(() => null))?.mtimeMs ?? 0;
  for (const s of entry.sidecarSubs) {
    if (!isJapaneseLang(s.lang) && !isRussianLang(s.lang)) continue;
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

/**
 * Pair JA cues with their RU counterparts into search lines. RU sidecars are
 * generated per-JA-cue, so indices line up 1:1; when counts diverge (external
 * RU files) we fall back to nearest-start matching within a small tolerance.
 * Pure + unit-testable.
 */
export function buildSearchLines(
  jaCues: { start: number; text: string }[],
  ruCues: { start: number; text: string }[] | null,
): SearchIndexEntry["lines"] {
  const sameCount = ruCues != null && ruCues.length === jaCues.length;
  // Sorted-by-start copy for nearest-timestamp fallback.
  const ruByStart =
    ruCues && !sameCount ? [...ruCues].sort((a, b) => a.start - b.start) : null;
  return jaCues.map((c, i) => {
    let ru: string | undefined;
    if (ruCues) {
      if (sameCount) {
        ru = ruCues[i]!.text;
      } else if (ruByStart && ruByStart.length) {
        // nearest RU cue within 0.5s of the JA start
        let best = ruByStart[0]!;
        let bestD = Math.abs(best.start - c.start);
        for (const r of ruByStart) {
          const d = Math.abs(r.start - c.start);
          if (d < bestD) {
            bestD = d;
            best = r;
          }
        }
        if (bestD <= 0.5) ru = best.text;
      }
    }
    const line: SearchIndexEntry["lines"][number] = {
      start: c.start,
      text: c.text,
      norm: searchNorm(c.text),
    };
    if (ru != null && ru !== "") {
      line.ru = ru;
      line.ruNorm = searchNormRu(ru);
    }
    return line;
  });
}

async function buildSearchIndex(entry: LibraryEntry): Promise<SearchIndexEntry | null> {
  const trackId = await bestJapaneseTrackId(entry);
  if (!trackId) return null;
  const ruTrackId = bestRussianTrackId(entry);
  const key = `${trackId}|${ruTrackId ?? ""}|${await jaMtime(entry)}`;
  const hit = searchIndex.get(entry.id);
  if (hit && hit.key === key) return hit;
  const cues = await cuesForTrack(entry, trackId).catch(() => null);
  if (!cues) return null;
  const ruCues = ruTrackId
    ? await cuesForTrack(entry, ruTrackId).catch(() => null)
    : null;
  const idx: SearchIndexEntry = {
    key,
    lines: buildSearchLines(cues, ruCues),
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
  const base = name
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
  // Also strip a trailing SPACE-separated episode number (e.g. "Hyouka 02").
  // Episode numbers here are short (1-2 digits) or zero-padded ("02", "012");
  // a bare 3-digit non-padded number ("100") is treated as part of the title.
  // Guard: only strip if the remaining title still has a non-digit word, so we
  // don't reduce titles like "86" or "Mob Psycho 100" to empty/garbage.
  const stripped = base
    .replace(/\s+(\d{1,2}|0\d{2})(v\d)?\s*$/i, "")
    .trim();
  if (stripped && stripped !== base && /[^\d\s]/.test(stripped)) {
    return stripped;
  }
  return base;
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
          await atomicWrite(s.path, cuesToSrt(collapsed));
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
        const nq = searchNorm(q); // JA-normalized query
        const nqRu = searchNormRu(q); // RU-normalized query
        const entries = await library.refresh();
        const hits: {
          mediaId: string;
          name: string;
          start: number;
          text: string;
          ru?: string;
          matchedLang?: "ja" | "ru";
        }[] = [];
        for (const entry of entries) {
          if (hits.length >= 100) break;
          const idx = await searchIndexFor(entry);
          if (!idx) continue;
          for (const line of idx.lines) {
            const jaHit = line.norm.includes(nq);
            const ruHit = line.ruNorm != null && line.ruNorm.includes(nqRu);
            if (!jaHit && !ruHit) continue;
            // A cue matched in both languages is one hit; prefer the JA tag.
            const hit: (typeof hits)[number] = {
              mediaId: entry.id,
              name: entry.name,
              start: line.start,
              text: line.text,
              matchedLang: jaHit ? "ja" : "ru",
            };
            if (line.ru != null) hit.ru = line.ru;
            hits.push(hit);
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

      // --- export: a frame (jpg) or a cue audio clip (mp3) for download ---
      // Security: media is resolved via library.get(id) only — never a raw path —
      // so there is no path-traversal surface (the id is a hex content hash).
      const exportFrame = path.match(/^\/api\/export\/frame\/([a-f0-9]+)$/);
      if (req.method === "GET" && exportFrame) {
        const entry = library.get(exportFrame[1]!);
        if (!entry) return err("not found", 404);
        const t = Math.max(0, parseFloat(url.searchParams.get("t") ?? "0") || 0);
        try {
          const bytes = await captureFrame(entry.absPath, t, 1280);
          void logEvent("export_frame", { mediaId: entry.id, t });
          return new Response(bytes, {
            headers: {
              "Content-Type": "image/jpeg",
              "Content-Disposition": `attachment; filename="${exportMediaFileName(entry.name, t, "jpg")}"`,
            },
          });
        } catch (e) {
          return err(`frame export failed: ${String(e)}`, 500);
        }
      }

      const exportClip = path.match(/^\/api\/export\/clip\/([a-f0-9]+)$/);
      if (req.method === "GET" && exportClip) {
        const entry = library.get(exportClip[1]!);
        if (!entry) return err("not found", 404);
        const start = Math.max(0, parseFloat(url.searchParams.get("start") ?? "") || 0);
        const end = parseFloat(url.searchParams.get("end") ?? "") || 0;
        if (!(end > start)) return err("end must be greater than start", 400);
        try {
          const bytes = await cutAudio(entry.absPath, start, end);
          void logEvent("export_clip", { mediaId: entry.id, start, end });
          return new Response(bytes, {
            headers: {
              "Content-Type": "audio/mpeg",
              "Content-Disposition": `attachment; filename="${exportMediaFileName(entry.name, start, "mp3")}"`,
            },
          });
        } catch (e) {
          return err(`clip export failed: ${String(e)}`, 500);
        }
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
        // `lang` becomes a filename component in sidecarPath — reject anything
        // that isn't a plain BCP-47 tag to prevent path injection.
        if (!isValidLang(lang)) return err("invalid lang", 400);
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
        // Hoisted so cancel() (client disconnect) can detach the listener and
        // not leak a closure holding `controller` in job.listeners (P5).
        let streamListener: ((e: WhisperEvent) => void) | null = null;
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
            streamListener = listener;
            job.listeners.add(listener);
          },
          cancel() {
            // Client disconnected — remove our listener so it doesn't linger in
            // job.listeners for the lifetime of a long whisper job.
            if (streamListener) job.listeners.delete(streamListener);
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
      // On-demand RU re-translation (feature LL): re-run translation on the
      // entry's CURRENT best ja track (jimaku human OR whisper) and OVERWRITE
      // the ru sidecar. Same path the auto-chain uses (bestJapaneseTrackId +
      // enqueueTranslate). Idempotent: a dup call while one is queued/running is
      // a no-op (returns already-queued).
      const retranslate = path.match(/^\/api\/translate\/([a-f0-9]+)$/);
      if (req.method === "POST" && retranslate) {
        const entry = library.get(retranslate[1]!);
        if (!entry) return err("not found", 404);
        if (translateQueuedFor(entry.id)) {
          return json({ ok: true, queued: false, reason: "already queued" });
        }
        const sourceTrack = await bestJapaneseTrackId(entry);
        if (!sourceTrack) return err("no japanese track", 409);
        enqueueTranslate(library, entry.id, sourceTrack);
        void logEvent("translate_requested", { mediaId: entry.id, sourceTrack });
        return json({ ok: true, queued: true, sourceTrack, targetLang: "ru" });
      }

      const translate = path.match(/^\/api\/translate\/([a-f0-9]+)\/([^/]+)$/);
      if (req.method === "POST" && translate) {
        const entry = library.get(translate[1]!);
        if (!entry) return err("not found", 404);
        const body = (await req.json().catch(() => ({}))) as { targetLang?: string };
        const targetLang = body.targetLang ?? "ru";
        // `targetLang` becomes a filename component in sidecarPath — reject
        // anything that isn't a plain BCP-47 tag to prevent path injection.
        if (!isValidLang(targetLang)) return err("invalid targetLang", 400);
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
        await atomicWrite(out, cuesToSrt(translated));
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
        // Restrict browsing to the current media root subtree so a rogue request
        // can't enumerate arbitrary filesystem directories.
        if (p !== currentRoot && !p.startsWith(currentRoot + "/")) {
          return err("forbidden", 403);
        }
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
        if (
          name.includes("/") || name.includes("\\") || name.includes("..") ||
          name.includes("\0")
        ) return err("bad name", 400);
        // Positive extension allowlist (defense-in-depth, matches the client
        // media regex). Covers every image/audio extension Anki/this app can
        // actually produce. Case-insensitive. Notably excludes .svg — SVG is
        // script-capable and must never be served same-origin from
        // attacker-named media. 404 otherwise.
        if (
          !/\.(jpe?g|png|gif|webp|avif|mp3|ogg|oga|wav|m4a|flac|opus|webm)$/i.test(
            name,
          )
        ) {
          return err("media not found", 404);
        }
        let bytes = ankiMediaGet(name);
        if (!bytes) {
          const fetched = await mediaAuto(name);
          if (!fetched) return err("media not found", 404); // don't cache misses
          ankiMediaPut(name, fetched.bytes);
          bytes = fetched.bytes;
        }
        const types: Record<string, string> = {
          ".jpg": "image/jpeg",
          ".jpeg": "image/jpeg",
          ".png": "image/png",
          ".gif": "image/gif",
          ".webp": "image/webp",
          ".avif": "image/avif",
          // NOTE: .svg intentionally NOT mapped — it is script-capable and is
          // also rejected by the extension allowlist above.
          ".mp3": "audio/mpeg",
          ".ogg": "audio/ogg",
          ".oga": "audio/ogg",
          ".opus": "audio/ogg",
          ".wav": "audio/wav",
          ".m4a": "audio/mp4",
          ".flac": "audio/flac",
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
        // Same safety gate as the review write endpoints: constant-time token
        // check when ZEHNTAGE_DB_TOKEN is set, open when unset. Mining is now a
        // real (windowless-capable) write path, so it gets the same gating.
        const denied = await requireDbToken(req);
        if (denied) return denied;
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
        //   (1) JP sentence  (2) RU sentence translation  (3) image
        //   (4) [sound:...]  (5) source "file @ mm:ss" LAST.
        //
        // Media is handled FULLY WINDOWLESSLY — AnkiConnect is gone:
        //   - image → inlined as a self-contained data: URI (renders regardless
        //     of which media file exists; matches the older inline-image cards).
        //   - audio → written straight into the on-disk collection.media/ +
        //     media.db2 via dbStoreMedia (windowless writer), referenced by
        //     [sound:filename].
        // Both are non-fatal: the card still goes through if media fails.
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
              const b64 = Buffer.from(frame).toString("base64");
              imgLine = `<img src="data:image/jpeg;base64,${b64}">`;
            } catch {
              // no frame — card still goes through
            }
            // Sentence audio: cut the cue's audio and write it into the local
            // collection.media/ + media.db2 (windowless). Reference via
            // [sound:...]. Any failure along the way is non-fatal.
            if (
              typeof body.cueStart === "number" &&
              typeof body.cueEnd === "number" &&
              body.cueEnd > body.cueStart
            ) {
              try {
                const audio = await cutAudio(entry.absPath, body.cueStart, body.cueEnd);
                const stored = await dbStoreMedia(
                  audio,
                  `zr-${slug}-${stamp}.mp3`,
                  { path: collectionPath() },
                );
                if (stored.ok && stored.filename) {
                  soundLine = `[sound:${stored.filename}]`;
                }
              } catch {
                // no audio — card still goes through
              }
            }
          }
        }
        const context = [
          body.context ?? "",
          body.sentenceTranslation,
          imgLine,
          soundLine,
          sourceLine,
        ]
          .filter((s): s is string => Boolean(s && s.trim()))
          .join("<br>");

        const front = body.reading ? `${body.word} [${body.reading}]` : body.word;
        const _addT0 = Date.now();
        // Windowless-capable add: AnkiConnect when Anki is open, direct DB write
        // (dbAddNote) when Anki is closed, fake add under ANKI_FAKE. Media is
        // already inlined into `context` (data:URI image / [sound:] from
        // dbStoreMedia) above, so the card carries final field text.
        const addRes = await addNoteAuto({
          front,
          back: body.translation,
          notes: body.notes ?? "",
          context,
          tags: ["zehntage"],
          ...(image ? { image, image_field: "context" } : {}),
        });
        const _addMs = Date.now() - _addT0;
        if (addRes.ok) bustAnkiWordsCache();
        void logEvent("perf.anki", { op: "add", ms: _addMs });
        void logEvent("anki_add", {
          word: body.word,
          mediaId: body.mediaId,
          ok: addRes.ok,
        });
        if (_addMs > 3000) {
          void logEvent("anomaly.anki_slow", { op: "add", ms: _addMs });
        }
        return json({ ok: addRes.ok, error: addRes.error, reason: addRes.reason });
      }

      if (req.method === "POST" && path === "/api/anki/delete") {
        // Same safety gate as the other Anki write endpoints.
        const denied = await requireDbToken(req);
        if (denied) return denied;
        const body = (await req.json()) as { front?: string };
        if (!body.front) return err("front required", 400);
        // Windowless un-mine: AnkiConnect is gone. ANKI_FAKE → fake by-front
        // delete; real → dbDeleteNoteByFront (fail-closed when Anki is open).
        // A front that's already absent (reason "not-found") is treated as a
        // successful no-op so the client's optimistic delete stays consistent.
        const delRes = await deleteNoteByFrontAuto(body.front);
        const ok = delRes.ok || delRes.reason === "not-found";
        if (ok) bustAnkiWordsCache();
        void logEvent("anki_delete", { front: body.front, ok });
        return json({ ok, error: ok ? undefined : delRes.error, reason: delRes.reason });
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
      if (req.method === "GET" && path === "/api/stats/growth") {
        return json(wordsAddedPerDay(await readEvents()));
      }
      if (req.method === "GET" && path === "/api/stats/comprehension") {
        return json(await comprehensionSummary());
      }
      if (req.method === "GET" && path === "/api/stats/today") {
        return json(await todaySummary());
      }

      // Per-word mining history for the lookup popup, derived from the raw
      // event log (anki_add / lookup). Cheap: one events.jsonl read; the popup
      // fetches it lazily on open. Pass the lemma plus the surface form so we
      // match however the click was originally logged (events store `word`).
      if (req.method === "GET" && path === "/api/word/history") {
        const lemma = (url.searchParams.get("lemma") ?? "").trim();
        const surface = (url.searchParams.get("surface") ?? "").trim();
        const forms = [lemma, surface].filter(Boolean);
        if (forms.length === 0) return err("lemma required", 400);
        const h = await wordHistoryFromFile(forms);
        const firstSeenName =
          h.firstSeenMediaId !== undefined
            ? (library.get(h.firstSeenMediaId)?.name ?? h.firstSeenMediaId)
            : undefined;
        return json({
          ...h,
          ...(firstSeenName !== undefined ? { firstSeenName } : {}),
        });
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

      // --- Review / Cram mode: due deck words joined with watched cues ---
      // Returns the user's DUE deck words (front/back/reading + interval), each
      // joined with one watched cue from the encounter index so the client can
      // build a cloze from a real cue and deep-link "watch in context".
      // Prefers Anki is:due (acProgress.isDue); when no card carries that flag
      // (remote anki-mcp or fake mode), falls back to interval-based dueness
      // (smallest/most-overdue first) and reports source:"interval".
      // --- Review client (Wave 14): due queue, scheduled by Anki itself ---
      if (req.method === "GET" && path === "/api/review/queue") {
        const raw = url.searchParams.get("scope") ?? "zehntage";
        if (raw !== "zehntage" && raw !== "all") {
          return err("scope must be 'zehntage' or 'all'", 400);
        }
        const scope = raw as "zehntage" | "all";
        // Selector: DB-direct read (works with Anki closed) → AnkiConnect.
        // `backend` is informational and stripped from the wire response.
        const { available, due, cards } = await reviewQueueAuto(scope);
        return json({ scope, available, due, cards });
      }

      // Due counts {new, learning, review}. Additive; DB-direct preferred.
      if (req.method === "GET" && path === "/api/review/counts") {
        const raw = url.searchParams.get("scope") ?? "zehntage";
        if (raw !== "zehntage" && raw !== "all") {
          return err("scope must be 'zehntage' or 'all'", 400);
        }
        const scope = raw as "zehntage" | "all";
        const counts = await deckCountsAuto(scope);
        return json(counts);
      }

      // Engine capability snapshot. Additive; not consumed by current UI.
      if (req.method === "GET" && path === "/api/review/status") {
        const status = await reviewStatus();
        return json(status);
      }

      if (req.method === "POST" && path === "/api/review/answer") {
        // Safety gate for the upcoming windowless write-back. Open when
        // ZEHNTAGE_DB_TOKEN is unset; constant-time check when set.
        const denied = await requireDbToken(req);
        if (denied) return denied;
        const body = (await req.json().catch(() => ({}))) as {
          cardId?: unknown;
          ease?: unknown;
        };
        const cardId = body.cardId;
        const ease = body.ease;
        if (typeof cardId !== "number" || !Number.isFinite(cardId)) {
          return err("cardId must be a number", 400);
        }
        if (ease !== 1 && ease !== 2 && ease !== 3 && ease !== 4) {
          return err("ease must be 1, 2, 3 or 4", 400);
        }
        // Write-back is DB-direct (windowless) only — AnkiConnect is never
        // called. When Anki is open the DB write fails-closed and `reason`
        // (e.g. "anki-open"/"locked") is passed through so the UI can message it.
        const res = await answerCardAuto(cardId, ease);
        // A recorded grade changes due state — refresh words/cards caches.
        if (res.ok) bustAnkiWordsCache();
        return json({ ok: res.ok, error: res.error, reason: res.reason });
      }

      // --- TEST-ONLY: reset fake review queue (ANKI_FAKE=1 only) ---
      // This endpoint exists ONLY in fake mode and is a no-op / 404 otherwise.
      // It reseeds the in-memory review queue so each e2e spec starts from a
      // known 2-card deck regardless of run order.
      if (req.method === "POST" && path === "/api/test/reset-review-queue") {
        if (process.env.ANKI_FAKE !== "1") {
          return new Response("Not Found", { status: 404 });
        }
        fakeResetQueue();
        return json({ ok: true });
      }

      if (req.method === "POST" && path === "/api/review/delete") {
        // Same safety gate as /api/review/answer: constant-time token check
        // when ZEHNTAGE_DB_TOKEN is set, open when unset.
        const denied = await requireDbToken(req);
        if (denied) return denied;
        const body = (await req.json().catch(() => ({}))) as {
          cardId?: unknown;
        };
        const cardId = body.cardId;
        if (typeof cardId !== "number" || !Number.isFinite(cardId)) {
          return err("cardId must be a number", 400);
        }
        // DESTRUCTIVE: deletes the note from Anki and records graves for sync.
        const res = await deleteNoteAuto(cardId);
        // A deleted note changes due state — refresh words/cards caches.
        if (res.ok) bustAnkiWordsCache();
        // Strip the internal `backend` field before sending to the client.
        return json({ ok: res.ok, error: res.error, reason: res.reason });
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
        // SSRF guard: the server fetches body.url, so restrict it to jimaku.cc
        // (its real download host) — never an arbitrary attacker-chosen URL.
        let dlHost: string;
        try {
          dlHost = new URL(body.url).hostname;
        } catch {
          return err("invalid url", 400);
        }
        if (dlHost !== "jimaku.cc" && !dlHost.endsWith(".jimaku.cc")) {
          return err("forbidden url host", 403);
        }
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

      // --- auto-backup snapshots (see lib/backup.ts) ---
      if (req.method === "GET" && path === "/api/snapshots") {
        const snaps = await listSnapshots();
        return json({
          snapshots: snaps.map((s) => ({
            name: s.name,
            timestamp: new Date(s.mtimeMs).toISOString(),
            size: s.size,
          })),
        });
      }

      if (req.method === "POST" && path === "/api/snapshots/restore") {
        const body = (await req.json().catch(() => ({}))) as { name?: unknown };
        if (typeof body.name !== "string" || !body.name) {
          return err("missing snapshot `name`", 400);
        }
        let bundle: unknown;
        try {
          bundle = await readSnapshot(body.name);
        } catch (e) {
          return err(e instanceof Error ? e.message : "no such snapshot", 404);
        }
        // Restore through the SAME validated/rollback import path as /api/import.
        // Snapshots are full self-exports, so restore their events too.
        try {
          return json(await importBundle(bundle, { importEvents: true }));
        } catch (e) {
          return err(e instanceof Error ? e.message : "restore failed", 400);
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
        const filePath = join(PUBLIC_DIR, path.slice(1));
        // join() does not canonicalize, so a "../" in the URL could escape
        // PUBLIC_DIR — refuse anything resolving outside the public root.
        if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + "/")) {
          return err("not found", 404);
        }
        const file = Bun.file(filePath);
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

  // Take a throttled auto-backup snapshot on startup (skipped if the most
  // recent one is < 6h old, so frequent restarts don't spam snapshots). Rotation
  // happens inside; failures are non-fatal — never block server startup.
  void maybeSnapshotOnStartup().catch((e) => {
    console.warn(`[snapshot] startup snapshot failed: ${e instanceof Error ? e.message : e}`);
  });

  return {
    port: server.port ?? preferredPort,
    url: `http://localhost:${server.port}`,
    root,
    stop: () => server.stop(true),
  };
}
