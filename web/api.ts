// Typed client for the zehntage-reactor server API (same origin).

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
    mediaId?: string;
    timestamp?: number;
    withFrame?: boolean;
    noCache?: boolean;
  }) => jpost<WordLookup>("/api/lookup", p),
  ankiWords: () => jget<AnkiWordsResponse>("/api/anki/words"),
  ankiAdd: (p: {
    word: string;
    reading: string;
    translation: string;
    notes: string;
    context: string;
    mediaId: string;
    timestamp: number;
  }) => jpost<{ ok: boolean }>("/api/anki/add", p),
  ankiDelete: (front: string) => jpost<{ ok: boolean }>("/api/anki/delete", { front }),
  whisperStart: (id: string, lang: string) =>
    jpost<{ jobId: string; status: string }>(`/api/whisper/${id}`, { lang }),
  whisperCancel: (jobId: string) =>
    jpost<{ ok: boolean }>(`/api/whisper/job/${jobId}/cancel`, {}),
  whisperEventsUrl: (jobId: string) => `/api/whisper/job/${jobId}/events`,
  translate: (id: string, trackId: string, targetLang: string) =>
    jpost<{ ok: boolean; track: string; cueCount: number }>(
      `/api/translate/${id}/${encodeURIComponent(trackId)}`,
      { targetLang },
    ),
  getSettings: () => jget<Record<string, unknown>>("/api/settings"),
  saveSettings: (patch: Record<string, unknown>) =>
    jpost<Record<string, unknown>>("/api/settings", patch),
};

export function mediaUrl(id: string): string {
  return `/media/${id}`;
}
