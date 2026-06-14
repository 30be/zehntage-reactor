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

async function jget<T>(path: string): Promise<T> {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return (await r.json()) as T;
}

async function jpost<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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

export const api = {
  library: () => jget<LibraryEntry[]>("/api/library"),
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
};

export function mediaUrl(id: string): string {
  return `/media/${id}`;
}
