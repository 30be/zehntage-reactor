// Typed client for the zehntage-reactor server API (same origin).

import {
  getAnkiWords,
  refreshAnkiWords,
  cacheAddWord,
  cacheDeleteWord,
} from "./ankicache.ts";

export interface LibraryEntry {
  id: string;
  name: string;
  relPath: string;
  size: number;
  subLangs: string[];
}

export interface Cue {
  start: number;
  end: number;
  text: string;
}

export interface SubTrackInfo {
  id: string; // "sidecar:ru" | "embedded:2"
  kind: "sidecar" | "embedded";
  lang: string;
  label?: string; // friendly "Japanese · Whisper" (from backend)
  origin?: "generated" | "external"; // sidecar provenance (subs/ dir vs user file)
  title?: string;
  codec?: string;
}

/** Error thrown by jpost with the parsed HTTP status + server-provided error. */
export class ApiError extends Error {
  status: number;
  serverError?: string;
  constructor(status: number, message: string, serverError?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.serverError = serverError;
  }
}

export interface WordLookup {
  reading: string;
  translation: string;
  notes: string;
  context: string;
}

export interface ExplainResult {
  breakdown: string;
  idioms: string;
  translation: string;
}

export interface AnkiWord {
  front: string;
  back: string;
  notes: string;
  context: string;
}

export interface ProgressEntry {
  interval: number;
  due: number;
  reps: number;
  lapses: number;
  ease: number;
  queue: number;
  type: number;
  /** Anki "is:due" right now (local AnkiConnect path; absent on remote). */
  isDue?: boolean;
  /**
   * Whole days a review card is overdue (>= 0), estimated from last-review
   * time + interval vs now. 0 when not overdue / not a review card / unknown.
   * Local AnkiConnect path only; absent on the remote anki-mcp path.
   */
  daysOverdue?: number;
}

export interface AnkiWordsResponse {
  words: AnkiWord[];
  progress: Record<string, ProgressEntry>;
}

export interface MediaInfo {
  chromeCompatible: boolean;
  [k: string]: unknown;
}

// One cross-episode transcript hit from GET /api/search. `text` is always the
// JA cue; the endpoint indexes each entry's best ja track AND its RU sidecar (so
// a JA cue can be found by its Russian meaning) and returns up to 100 hits.
//   - `ru`         the paired RU translation of this cue (when one exists)
//   - `matchedLang` which language the query matched ("ja" | "ru")
// Both are optional → fully backward-compatible with JA-only servers/responses.
export interface SearchHit {
  mediaId: string;
  name: string;
  start: number;
  text: string;
  ru?: string;
  matchedLang?: "ja" | "ru";
}

async function jget<T>(path: string): Promise<T> {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return (await r.json()) as T;
}

// localStorage key holding the optional write-back token. When present we send
// it on /api/review/* writes as the `X-Zehntage-Token` header the server's
// requireDbToken() reads (see src/server/index.ts presentedToken). When unset
// we send nothing — the server's gate is open while ZEHNTAGE_DB_TOKEN is unset.
const DB_TOKEN_KEY = "zr.dbToken";

function dbTokenHeaders(): Record<string, string> {
  try {
    const t = localStorage.getItem(DB_TOKEN_KEY);
    if (t && t.trim()) return { "X-Zehntage-Token": t.trim() };
  } catch {
    /* storage may be unavailable (private mode) — just send no token */
  }
  return {};
}

async function jpost<T>(
  path: string,
  body: unknown,
  extraHeaders?: Record<string, string>,
): Promise<T> {
  const r = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    let serverError: string | undefined;
    try {
      const j = (await r.json()) as { error?: string };
      serverError = j?.error;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(
      r.status,
      `${path} → ${r.status}${serverError ? ` (${serverError})` : ""}`,
      serverError,
    );
  }
  return (await r.json()) as T;
}

export interface BatchWhisperJob {
  jobId: string;
  entryId: string | null;
  lang: string;
  status: "queued" | "extracting" | "running" | "done" | "error" | "canceled";
  lastCue: number | null;
  error: string | null;
}

export interface BatchTranslateItem {
  entryId: string;
  sourceTrack: string;
  targetLang: string;
  status: "queued" | "running" | "done" | "error";
  error: string | null;
}

export interface BatchStatus {
  active: boolean;
  whisper: BatchWhisperJob[];
  translate: BatchTranslateItem[];
}

export interface BatchStartResult {
  started: { entryId: string; name: string }[];
  skipped: string[];
}

export interface BatchAllResult {
  started: { entryId: string; name: string; phase: "whisper" | "translate" }[];
  skipped: string[];
}

export interface RootInfo {
  root: string;
  count: number;
}

export interface DaySummary {
  date: string; // "YYYY-MM-DD"
  playSec: number;
  pauseSec: number;
  mediaCount: number;
  ankiAdds: number;
  lookups: number;
}

export interface MediaSummary {
  mediaId: string;
  wallSec: number;
  contentSec: number;
  ankiAdds: number;
  lookups: number;
}

export interface StatsSummary {
  days: DaySummary[];
  media: MediaSummary[];
}

// --- analytics v2 ---

export interface EpisodeDayRow {
  mediaId: string;
  date: string;
  wallPlayingSec: number;
  wallPausedSec: number;
  contentSec: number;
  coefficient: number | null;
  lookups: number;
  ankiAdds: number;
  cardsPerMin: number | null;
}

export interface OverviewDay {
  date: string;
  wallPlayingSec: number;
  wallPausedSec: number;
  contentSec: number;
  lookups: number;
  ankiAdds: number;
}

export interface Overview {
  totals: {
    wallPlayingSec: number;
    wallPausedSec: number;
    contentSec: number;
    lookups: number;
    ankiAdds: number;
    mediaCount: number;
  };
  last30Days: OverviewDay[];
  ankiCumulative: { date: string; total: number }[];
}

// Comprehension trend (quiz.result aggregation) — mirrors
// src/lib/telemetry.ts ComprehensionSummary.
export interface QuizPoint {
  ts: number;
  date: string;
  total: number;
  correct: number;
  pct: number;
}
export interface ComprehensionSummary {
  points: QuizPoint[];
  quizzes: number;
  avgPct: number;
  totalQuestions: number;
  totalCorrect: number;
}

// Today's activity tiles + daily streak — mirrors src/lib/telemetry.ts
// TodayStats.
export interface TodayStats {
  date: string;
  cuesWatched: number;
  wordsMined: number;
  lookups: number;
  quizzes: number;
  minutes: number;
  streak: number;
  active: boolean;
}

// Per-word mining history — mirrors src/lib/telemetry.ts WordHistory plus a
// resolved firstSeenName from the server.
export interface WordHistory {
  addedAt?: number;
  lookups: number;
  firstSeenAt?: number;
  firstSeenMediaId?: string;
  firstSeenName?: string;
}

// --- lemma index queries ---

export interface EncounterCue {
  idx: number;
  start: number;
  text: string;
}

export interface EncounterHit {
  mediaId: string;
  name: string;
  count: number;
  cues: EncounterCue[];
}

export interface ComprehensibilityRow {
  mediaId: string;
  name: string;
  pctKnown: number | null;
  unknown: { lemma: string; count: number }[];
}

export interface DueRow {
  mediaId: string;
  name: string;
  count: number;
  lemmas: { lemma: string; count: number }[];
}

export interface ExportBundle {
  version: number;
  exportedAt: string;
  settings: Record<string, unknown>;
  state: Record<string, { v: string; ts: number }>;
  events: Array<Record<string, unknown>>;
  eventsTruncated: boolean;
}

export interface ImportResult {
  settingsImported: boolean;
  stateKeys: number;
  eventsImported: number;
  appVersion: string;
}

export interface SnapshotMeta {
  name: string;
  timestamp: string;
  size: number;
}

// One due card from GET /api/review/queue. `question`/`answer` are rendered
// Anki template HTML (media URLs already rewritten server-side to the
// /api/anki/media proxy); `front` is the plain card label (e.g. "言葉 [ことば]").
export type ReviewCard = {
  cardId: number;
  question: string;
  answer: string;
  front: string;
};

export interface ReviewQueueResponse {
  // false ⇒ no grading backend (Anki offline / remote can't schedule).
  available: boolean;
  due: number;
  cards: ReviewCard[];
}

export const api = {
  library: () => jget<LibraryEntry[]>("/api/library"),
  // Cross-episode subtitle search; empty/whitespace query short-circuits to [].
  search: (q: string) =>
    q.trim()
      ? jget<SearchHit[]>(`/api/search?q=${encodeURIComponent(q.trim())}`)
      : Promise.resolve<SearchHit[]>([]),
  mediaInfo: (id: string) => jget<MediaInfo>(`/api/media/${id}/info`),
  subs: (id: string) => jget<SubTrackInfo[]>(`/api/subs/${id}`),
  cues: (id: string, trackId: string) =>
    jget<Cue[]>(`/api/subs/${id}/${encodeURIComponent(trackId)}`),
  lookup: (p: {
    word: string;
    context: string;
    source: string;
    /** matching known-language (RU) cue text, for disambiguation */
    secondary?: string;
    mediaId?: string;
    timestamp?: number;
    withFrame?: boolean;
    noCache?: boolean;
  }) => jpost<WordLookup>("/api/lookup", p),
  explain: (p: {
    sentence: string;
    secondary: string;
    source: string;
    /** prev/current/next cue lines, current line marked */
    context?: string;
  }) => jpost<ExplainResult>("/api/explain", p),
  ask: (p: {
    question: string;
    word?: string;
    sentence?: string;
    priorAnswer?: string;
    source?: string;
  }) => jpost<{ answer: string }>("/api/ask", p),
  // Stale-while-revalidate via localStorage (web/ankicache.ts): resolves
  // instantly from the persisted deck, refreshes with ETag in the background.
  ankiWords: () => getAnkiWords(),
  ankiAdd: async (p: {
    word: string;
    reading: string;
    translation: string;
    notes: string;
    context: string;
    /** omit mediaId/timestamp to skip server frame + audio capture */
    mediaId?: string;
    timestamp?: number;
    /** cue audio bounds in FILE time (offset-corrected), for [sound:] capture */
    cueStart?: number;
    cueEnd?: number;
    /** matching secondary (RU) cue text, shown as its own context line */
    sentenceTranslation?: string;
  }) => {
    const r = await jpost<{ ok: boolean }>("/api/anki/add", p);
    // Optimistic write-through: cached deck keeps instant underlines across
    // reloads; the server cache was busted, so refresh picks up real data.
    cacheAddWord(p.word, p.reading, p.translation, p.notes);
    void refreshAnkiWords().catch(() => {});
    return r;
  },
  ankiDelete: async (front: string) => {
    const r = await jpost<{ ok: boolean }>("/api/anki/delete", { front });
    cacheDeleteWord(front);
    void refreshAnkiWords().catch(() => {});
    return r;
  },
  whisperStart: (id: string, lang: string) =>
    jpost<{ jobId: string; status: string }>(`/api/whisper/${id}`, { lang }),
  whisperActive: (id: string) =>
    jget<{ jobId: string | null; status?: string; lang?: string }>(
      `/api/whisper/active?mediaId=${id}`,
    ),
  whisperCancel: (jobId: string) =>
    jpost<{ ok: boolean }>(`/api/whisper/job/${jobId}/cancel`, {}),
  whisperEventsUrl: (jobId: string) => `/api/whisper/job/${jobId}/events`,
  translate: (id: string, trackId: string, targetLang: string) =>
    jpost<{ ok: boolean; track: string; cueCount: number }>(
      `/api/translate/${id}/${encodeURIComponent(trackId)}`,
      { targetLang },
    ),
  batchAll: () => jpost<BatchAllResult>("/api/batch/all", {}),
  batchAllOne: (id: string) =>
    jpost<{ entryId: string; phase: "whisper" | "translate" | "skipped" }>(
      `/api/batch/all/${id}`,
      {},
    ),
  batchSubtitle: () => jpost<BatchStartResult>("/api/batch/subtitle", {}),
  batchTranslate: () => jpost<BatchStartResult>("/api/batch/translate", {}),
  batchStatus: () => jget<BatchStatus>("/api/batch/status"),
  condense: (id: string) =>
    jpost<{ ok: boolean; path: string; duration: number }>(
      `/api/condense/${id}`,
      {},
    ),
  // URLs for the browser to download directly (Content-Disposition: attachment).
  exportFrameUrl: (id: string, t: number) =>
    `/api/export/frame/${id}?t=${encodeURIComponent(String(Math.max(0, t)))}`,
  exportClipUrl: (id: string, start: number, end: number) =>
    `/api/export/clip/${id}?start=${encodeURIComponent(
      String(Math.max(0, start)),
    )}&end=${encodeURIComponent(String(end))}`,
  getRoot: () => jget<RootInfo>("/api/root"),
  setRoot: (path: string) => jpost<RootInfo>("/api/root", { path }),
  statsSummary: () => jget<StatsSummary>("/api/stats/summary"),
  statsEpisodes: () => jget<EpisodeDayRow[]>("/api/stats/episodes"),
  statsOverview: () => jget<Overview>("/api/stats/overview"),
  statsComprehension: () =>
    jget<ComprehensionSummary>("/api/stats/comprehension"),
  statsToday: () => jget<TodayStats>("/api/stats/today"),
  indexEncounters: (lemma: string, mediaIds?: string[]) =>
    jget<EncounterHit[]>(
      `/api/index/encounters?lemma=${encodeURIComponent(lemma)}${
        mediaIds && mediaIds.length
          ? `&mediaIds=${encodeURIComponent(mediaIds.join(","))}`
          : ""
      }`,
    ),
  wordHistory: (lemma: string, surface?: string) =>
    jget<WordHistory>(
      `/api/word/history?lemma=${encodeURIComponent(lemma)}${
        surface && surface !== lemma
          ? `&surface=${encodeURIComponent(surface)}`
          : ""
      }`,
    ),
  indexComprehensibility: (known: string[]) =>
    jpost<ComprehensibilityRow[]>("/api/index/comprehensibility", { known }),
  indexDue: (dueFronts: string[]) =>
    jpost<DueRow[]>("/api/index/due", { dueFronts }),
  getSettings: () => jget<Record<string, unknown>>("/api/settings"),
  saveSettings: (patch: Record<string, unknown>) =>
    jpost<Record<string, unknown>>("/api/settings", patch),
  // Fetch the full export bundle (parsed JSON; caller triggers the download).
  exportData: () => jget<ExportBundle>("/api/export"),
  // Apply a bundle. Events are skipped server-side by default.
  importData: (bundle: unknown) =>
    jpost<ImportResult>("/api/import", bundle),
  // List available auto-backup snapshots, newest first.
  listSnapshots: () =>
    jget<{ snapshots: SnapshotMeta[] }>("/api/snapshots"),
  // Roll back to a snapshot by name (overwrites current settings/state).
  restoreSnapshot: (name: string) =>
    jpost<ImportResult>("/api/snapshots/restore", { name }),
  // The next batch of cards Anki considers due (scope = zehntage tag or whole
  // deck). Anki's own scheduler decides what's due; we just render + grade.
  reviewQueue: (scope: "zehntage" | "all") =>
    jget<ReviewQueueResponse>(`/api/review/queue?scope=${scope}`),
  // Grade a card windowless (DB-direct). ease: 1=Again 2=Hard 3=Good 4=Easy.
  // Refused (ok:false, reason "anki-open"/"locked") while Anki holds the file.
  reviewAnswer: (cardId: number, ease: number) =>
    jpost<{ ok: boolean; error?: string; reason?: string }>(
      "/api/review/answer",
      { cardId, ease },
      dbTokenHeaders(),
    ),
  // Delete the note that owns cardId from Anki (DESTRUCTIVE — records graves
  // for sync). Windowless DB write; refused while Anki is open.
  reviewDelete: (cardId: number) =>
    jpost<{ ok: boolean; error?: string; reason?: string }>(
      "/api/review/delete",
      { cardId },
      dbTokenHeaders(),
    ),
};

export function mediaUrl(id: string): string {
  return `/media/${id}`;
}
