// Raw telemetry event log (JSONL) + summary aggregation.
//
// Events are appended to ~/.local/share/zehntage-reactor/events.jsonl
// (override with ZR_EVENTS_FILE — used by tests). One JSON object per line:
//   { ts: <epoch ms>, type: "heartbeat" | "anki_add" | ..., mediaId?, ... }
// The log is append-only and parsed on demand by summarizeEvents().

import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { mkdir, appendFile, readFile, stat } from "node:fs/promises";

export interface TelemetryEvent {
  ts: number;
  type: string;
  mediaId?: string;
  [key: string]: unknown;
}

export function eventsFilePath(): string {
  return (
    process.env.ZR_EVENTS_FILE ||
    join(homedir(), ".local", "share", "zehntage-reactor", "events.jsonl")
  );
}

/** Map get-or-create: returns the existing value or inserts and returns init(). */
function getOr<K, V>(map: Map<K, V>, key: K, init: () => V): V {
  let v = map.get(key);
  if (v === undefined) {
    v = init();
    map.set(key, v);
  }
  return v;
}

// Serialize appends so concurrent requests never interleave partial lines.
let writeChain: Promise<void> = Promise.resolve();

/** Append one event. ts defaults to now. Never throws (logging is best-effort). */
export function logEvent(
  type: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  return logEvents([{ ts: Date.now(), type, ...payload }]);
}

/** Append a batch of events (each must carry its own ts/type). */
export function logEvents(events: TelemetryEvent[]): Promise<void> {
  if (events.length === 0) return Promise.resolve();
  const lines = events
    .filter((e) => e && typeof e.type === "string" && Number.isFinite(e.ts) && e.ts > 0)
    .map((e) => JSON.stringify({ ...e, ts: e.ts }))
    .join("\n");
  if (!lines) return Promise.resolve();
  const file = eventsFilePath();
  writeChain = writeChain
    .then(async () => {
      await mkdir(dirname(file), { recursive: true });
      await appendFile(file, lines + "\n", "utf8");
    })
    .catch(() => {});
  return writeChain;
}

// In-process parse cache for the append-only events log. Keyed by the file's
// mtime+size: appends bump mtime (and size), so a stale cache can never be
// served. The cached array is treated as immutable by all readers (they only
// iterate/aggregate), so returning the same reference is safe. Keyed by path
// so a test pointing ZR_EVENTS_FILE elsewhere gets its own slot.
interface EventsCacheSlot {
  sig: string; // `${mtimeMs}:${size}`
  events: TelemetryEvent[];
}
const eventsCache = new Map<string, EventsCacheSlot>();

function parseEventLines(lines: string[], start = 0): TelemetryEvent[] {
  const out: TelemetryEvent[] = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as TelemetryEvent;
      if (e && typeof e.ts === "number" && typeof e.type === "string") out.push(e);
    } catch {
      // skip torn/garbage lines
    }
  }
  return out;
}

function parseEventsText(text: string): TelemetryEvent[] {
  return parseEventLines(text.split("\n"));
}

export async function readEvents(): Promise<TelemetryEvent[]> {
  const file = eventsFilePath();
  let sig: string;
  try {
    const st = await stat(file);
    sig = `${st.mtimeMs}:${st.size}`;
  } catch {
    eventsCache.delete(file);
    return [];
  }
  const hit = eventsCache.get(file);
  if (hit && hit.sig === sig) return hit.events;
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    eventsCache.delete(file);
    return [];
  }
  const events = parseEventsText(text);
  eventsCache.set(file, { sig, events });
  return events;
}

export interface DaySummary {
  date: string; // local "YYYY-MM-DD"
  playSec: number; // wall seconds with a playing heartbeat
  pauseSec: number; // wall seconds with a paused heartbeat
  mediaCount: number; // distinct media touched
  ankiAdds: number;
  lookups: number;
}

export interface MediaSummary {
  mediaId: string;
  wallSec: number; // wall seconds playing
  contentSec: number; // approx: sum of forward position deltas <= 60s
  ankiAdds: number;
  lookups: number;
}

export interface StatsSummary {
  days: DaySummary[];
  media: MediaSummary[];
}

// Heartbeats are emitted every ~15s; each one is credited this many wall
// seconds. Coarse but monotone — good enough for an activity calendar.
const HEARTBEAT_SEC = 15;

function localDate(ts: number): string {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Aggregate the raw log into per-day and per-media summaries. */
export function summarizeEvents(events: TelemetryEvent[]): StatsSummary {
  const days = new Map<string, DaySummary & { media: Set<string> }>();
  const media = new Map<string, MediaSummary>();
  // last seen heartbeat position per media (for content-time delta estimate)
  const lastPos = new Map<string, number>();

  const day = (ts: number) =>
    getOr(days, localDate(ts), () => ({
      date: localDate(ts),
      playSec: 0,
      pauseSec: 0,
      mediaCount: 0,
      ankiAdds: 0,
      lookups: 0,
      media: new Set<string>(),
    }));
  const med = (id: string) =>
    getOr(media, id, () => ({ mediaId: id, wallSec: 0, contentSec: 0, ankiAdds: 0, lookups: 0 }));

  for (const e of events) {
    if (!Number.isFinite(e.ts)) continue;
    const d = day(e.ts);
    const id = typeof e.mediaId === "string" ? e.mediaId : null;
    if (id) d.media.add(id);
    switch (e.type) {
      case "heartbeat": {
        const paused = e.paused === true;
        if (paused) d.pauseSec += HEARTBEAT_SEC;
        else d.playSec += HEARTBEAT_SEC;
        if (id) {
          const m = med(id);
          if (!paused) m.wallSec += HEARTBEAT_SEC;
          const pos = typeof e.position === "number" ? e.position : null;
          if (pos !== null) {
            const prev = lastPos.get(id);
            // Forward delta capped at 60s: seeks/jumps don't count as content.
            if (prev !== undefined && pos > prev && pos - prev <= 60)
              m.contentSec += pos - prev;
            lastPos.set(id, pos);
          }
        }
        break;
      }
      case "anki_add":
        d.ankiAdds += 1;
        if (id) med(id).ankiAdds += 1;
        break;
      case "lookup":
        d.lookups += 1;
        if (id) med(id).lookups += 1;
        break;
      default:
        break; // route_change, explain, translate_done, whisper_done, … kept raw
    }
  }

  const dayList = [...days.values()]
    .map(({ media: m, ...rest }) => ({ ...rest, mediaCount: m.size }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const mediaList = [...media.values()].sort((a, b) => b.wallSec - a.wallSec);
  return { days: dayList, media: mediaList };
}

export async function statsSummary(): Promise<StatsSummary> {
  return summarizeEvents(await readEvents());
}

// --- comprehension trend: quiz.result aggregation --------------------------
//
// Each quiz.result event carries { total, correct } from the comprehension
// quiz (web/player/QuizPanel.tsx). We surface a per-quiz score series (for a
// sparkline) plus simple aggregates, all derived from the raw event log — no
// extra storage.

export interface QuizPoint {
  ts: number; // epoch ms of the quiz
  date: string; // local "YYYY-MM-DD"
  total: number;
  correct: number;
  pct: number; // 0-100 comprehension score
}

export interface ComprehensionSummary {
  points: QuizPoint[]; // chronological
  quizzes: number; // count of quiz.result events
  avgPct: number; // mean comprehension %, 0-100 (0 when none)
  totalQuestions: number;
  totalCorrect: number;
}

/** Aggregate quiz.result events into a comprehension trend + averages. */
export function summarizeComprehension(
  events: TelemetryEvent[],
): ComprehensionSummary {
  const points: QuizPoint[] = [];
  let totalQuestions = 0;
  let totalCorrect = 0;
  let pctSum = 0;
  for (const e of events) {
    if (e.type !== "quiz.result") continue;
    const total = typeof e.total === "number" ? e.total : 0;
    const correct = typeof e.correct === "number" ? e.correct : 0;
    if (total <= 0) continue; // skip empty/torn quiz events
    const pct = Math.round((correct / total) * 100);
    points.push({ ts: e.ts, date: localDate(e.ts), total, correct, pct });
    totalQuestions += total;
    totalCorrect += correct;
    pctSum += pct;
  }
  points.sort((a, b) => a.ts - b.ts);
  return {
    points,
    quizzes: points.length,
    avgPct: points.length > 0 ? Math.round(pctSum / points.length) : 0,
    totalQuestions,
    totalCorrect,
  };
}

export async function comprehensionSummary(): Promise<ComprehensionSummary> {
  return summarizeComprehension(await readEvents());
}

// --- "today" panel: a single day's activity + daily streak -----------------
//
// The Home page surfaces a quiet summary of TODAY's study, derived live from
// the raw event log. All math is pure (testable) — only `now` is injected.

export interface TodayStats {
  date: string; // local "YYYY-MM-DD" for `now`
  cuesWatched: number; // distinct primary cues activated (cue_active events)
  wordsMined: number; // anki_add events today
  lookups: number; // lookup events today
  quizzes: number; // quiz.result events today
  minutes: number; // rounded minutes of PLAYING wall time today
  streak: number; // consecutive days (ending today) with any activity
  active: boolean; // any activity at all today
}

/**
 * Consecutive-day streak ending on `now`'s local date. A day "counts" when it
 * appears in `activeDates` (a set of local "YYYY-MM-DD" strings with activity).
 * The streak walks backwards one calendar day at a time; the first gap stops it.
 * If today itself has no activity the streak is 0 (the streak is "broken" until
 * you study again today).
 */
export function currentStreak(activeDates: Set<string>, now = Date.now()): number {
  const start = new Date(now);
  let streak = 0;
  for (let i = 0; ; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() - i);
    if (activeDates.has(localDate(d.getTime()))) streak++;
    else break;
  }
  return streak;
}

/** What counts as "activity" for the streak: any of these event types. */
function isActivityEvent(e: TelemetryEvent): boolean {
  return (
    e.type === "heartbeat" ||
    e.type === "anki_add" ||
    e.type === "lookup" ||
    e.type === "quiz.result" ||
    e.type === "cue_active"
  );
}

/** Today's activity tiles + the current daily streak, from the raw log. */
export function todayStats(events: TelemetryEvent[], now = Date.now()): TodayStats {
  const today = localDate(now);
  const activeDates = new Set<string>();
  let cueSet = new Set<string>();
  let wordsMined = 0;
  let lookups = 0;
  let quizzes = 0;
  let playSec = 0;

  for (const e of events) {
    if (!isActivityEvent(e)) continue;
    const date = localDate(e.ts);
    activeDates.add(date);
    if (date !== today) continue;
    switch (e.type) {
      case "heartbeat":
        if (e.paused !== true) playSec += HEARTBEAT_SEC;
        break;
      case "anki_add":
        wordsMined += 1;
        break;
      case "lookup":
        lookups += 1;
        break;
      case "quiz.result":
        quizzes += 1;
        break;
      case "cue_active": {
        // dedupe by (mediaId, cue index) so a replayed line isn't double-counted
        const id = typeof e.mediaId === "string" ? e.mediaId : "?";
        const idx = typeof e.idx === "number" ? e.idx : String(e.idx ?? "");
        cueSet.add(`${id}#${idx}`);
        break;
      }
    }
  }

  return {
    date: today,
    cuesWatched: cueSet.size,
    wordsMined,
    lookups,
    quizzes,
    minutes: Math.round(playSec / 60),
    streak: currentStreak(activeDates, now),
    active:
      activeDates.has(today) &&
      (cueSet.size > 0 ||
        wordsMined > 0 ||
        lookups > 0 ||
        quizzes > 0 ||
        playSec > 0),
  };
}

export async function todaySummary(now = Date.now()): Promise<TodayStats> {
  return todayStats(await readEvents(), now);
}

// --- analytics v2: per-(media, day) series + overview -----------------------

export interface EpisodeDayRow {
  mediaId: string;
  date: string; // local "YYYY-MM-DD"
  wallPlayingSec: number;
  wallPausedSec: number;
  /** Approx. content seconds: forward position deltas between consecutive
   * heartbeats of the same media, capped at 60s each. */
  contentSec: number;
  /** wall (playing+paused) / content. null when contentSec < 60 (too noisy). */
  coefficient: number | null;
  lookups: number;
  ankiAdds: number;
  /** ankiAdds per minute of playing wall time. null when no playing time. */
  cardsPerMin: number | null;
}

/** Per-(mediaId, day) analytics rows, sorted by date then mediaId. */
export function episodeSeries(events: TelemetryEvent[]): EpisodeDayRow[] {
  type Acc = Omit<EpisodeDayRow, "coefficient" | "cardsPerMin">;
  const rows = new Map<string, Acc>();
  const lastPos = new Map<string, number>(); // per media, across days

  const row = (mediaId: string, ts: number): Acc => {
    const date = localDate(ts);
    return getOr(rows, `${mediaId} ${date}`, () => ({
      mediaId,
      date,
      wallPlayingSec: 0,
      wallPausedSec: 0,
      contentSec: 0,
      lookups: 0,
      ankiAdds: 0,
    }));
  };

  for (const e of events) {
    const id = typeof e.mediaId === "string" ? e.mediaId : null;
    if (!id) continue;
    switch (e.type) {
      case "heartbeat": {
        const r = row(id, e.ts);
        if (e.paused === true) r.wallPausedSec += HEARTBEAT_SEC;
        else r.wallPlayingSec += HEARTBEAT_SEC;
        const pos = typeof e.position === "number" ? e.position : null;
        if (pos !== null) {
          const prev = lastPos.get(id);
          // Forward delta capped at 60s: seeks/jumps don't count as content.
          if (prev !== undefined && pos > prev && pos - prev <= 60)
            r.contentSec += pos - prev;
          lastPos.set(id, pos);
        }
        break;
      }
      case "lookup":
        row(id, e.ts).lookups += 1;
        break;
      case "anki_add":
        row(id, e.ts).ankiAdds += 1;
        break;
      default:
        break;
    }
  }

  return [...rows.values()]
    .map((r) => ({
      ...r,
      coefficient:
        r.contentSec >= 60
          ? (r.wallPlayingSec + r.wallPausedSec) / r.contentSec
          : null,
      cardsPerMin:
        r.wallPlayingSec > 0 ? r.ankiAdds / (r.wallPlayingSec / 60) : null,
    }))
    .sort((a, b) =>
      a.date !== b.date
        ? a.date < b.date
          ? -1
          : 1
        : a.mediaId.localeCompare(b.mediaId),
    );
}

export interface OverviewDay {
  date: string;
  wallPlayingSec: number;
  wallPausedSec: number;
  contentSec: number;
  lookups: number;
  ankiAdds: number;
}

export interface CumulativePoint {
  date: string;
  /** Total anki cards added up to and including this date. */
  total: number;
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
  /** Daily series for the last 30 calendar days (gaps zero-filled),
   * anchored on the newest event (or `now` for an empty log). */
  last30Days: OverviewDay[];
  /** Cumulative ankiAdds curve, one point per day with at least one add. */
  ankiCumulative: CumulativePoint[];
}

/** Totals + last-30-day daily series + cumulative anki curve. */
export function overview(events: TelemetryEvent[], now = Date.now()): Overview {
  const rows = episodeSeries(events);
  const totals = {
    wallPlayingSec: 0,
    wallPausedSec: 0,
    contentSec: 0,
    lookups: 0,
    ankiAdds: 0,
    mediaCount: new Set(rows.map((r) => r.mediaId)).size,
  };
  const byDay = new Map<string, OverviewDay>();
  for (const r of rows) {
    totals.wallPlayingSec += r.wallPlayingSec;
    totals.wallPausedSec += r.wallPausedSec;
    totals.contentSec += r.contentSec;
    totals.lookups += r.lookups;
    totals.ankiAdds += r.ankiAdds;
    const d = getOr(byDay, r.date, () => ({
      date: r.date,
      wallPlayingSec: 0,
      wallPausedSec: 0,
      contentSec: 0,
      lookups: 0,
      ankiAdds: 0,
    }));
    d.wallPlayingSec += r.wallPlayingSec;
    d.wallPausedSec += r.wallPausedSec;
    d.contentSec += r.contentSec;
    d.lookups += r.lookups;
    d.ankiAdds += r.ankiAdds;
  }

  // Anchor the 30-day window on the newest event so old logs still render.
  const lastTs = events.reduce((m, e) => Math.max(m, e.ts), 0) || now;
  const last30Days: OverviewDay[] = [];
  const anchor = new Date(lastTs);
  for (let i = 29; i >= 0; i--) {
    // Calendar-day stepping, not fixed 24h chunks: DST makes some local days
    // 23/25h long, which would skip or duplicate a date in the series.
    const d = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - i);
    const date = localDate(d.getTime());
    last30Days.push(
      byDay.get(date) ?? {
        date,
        wallPlayingSec: 0,
        wallPausedSec: 0,
        contentSec: 0,
        lookups: 0,
        ankiAdds: 0,
      },
    );
  }

  const ankiCumulative: CumulativePoint[] = [];
  let running = 0;
  for (const d of [...byDay.values()].sort((a, b) => (a.date < b.date ? -1 : 1))) {
    if (d.ankiAdds === 0) continue;
    running += d.ankiAdds;
    ankiCumulative.push({ date: d.date, total: running });
  }

  return { totals, last30Days, ankiCumulative };
}

// --- vocab growth: words-added-per-day + cumulative -------------------------
//
// G2: how the user's vocabulary has grown over time. Each anki_add event marks
// one card mined; we bucket them by local day and accumulate a running total.
// NOTE: only words mined SINCE telemetry began are counted — the event log is
// the sole source, so cards added before tracking existed won't appear.

export interface GrowthPoint {
  date: string; // local "YYYY-MM-DD"
  count: number; // anki_add events on this day
  cumulative: number; // running total of cards up to & including this day
}

/**
 * Words added per day (anki_add events) with a running cumulative total.
 * Returns one point per day that had at least one add, sorted chronologically.
 * Pure — testable on an in-memory array; tolerant of out-of-order events.
 */
export function wordsAddedPerDay(events: TelemetryEvent[]): GrowthPoint[] {
  const perDay = new Map<string, number>();
  for (const e of events) {
    if (e.type !== "anki_add") continue;
    if (!Number.isFinite(e.ts)) continue;
    const date = localDate(e.ts);
    perDay.set(date, (perDay.get(date) ?? 0) + 1);
  }
  const out: GrowthPoint[] = [];
  let running = 0;
  for (const date of [...perDay.keys()].sort()) {
    const count = perDay.get(date)!;
    running += count;
    out.push({ date, count, cumulative: running });
  }
  return out;
}

const CSV_HEADER = [
  "mediaId",
  "date",
  "wallPlayingSec",
  "wallPausedSec",
  "contentSec",
  "coefficient",
  "lookups",
  "ankiAdds",
  "cardsPerMin",
] as const;

function csvCell(v: string | number | null): string {
  if (v === null) return "";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(3);
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** Episode series rows as a CSV string (with header, \n line endings). */
export function toCsv(rows: EpisodeDayRow[]): string {
  const lines = [CSV_HEADER.join(",")];
  for (const r of rows) lines.push(CSV_HEADER.map((k) => csvCell(r[k])).join(","));
  return lines.join("\n") + "\n";
}

// --- health / perf summary (last 24h) ------------------------------------

export interface PerfStat {
  type: string;
  count: number;
  p50: number;
  p95: number;
  min: number;
  max: number;
}

export interface SlowRoute {
  ts: number;
  path: string;
  ms: number;
  status: number;
}

export interface AnomalyCount {
  type: string;
  count: number;
}

export interface WhisperWarning {
  ts: number;
  message: string;
  mediaId?: string;
}

export interface HealthSummary {
  perfStats: PerfStat[];
  slowestRoutes: SlowRoute[];
  anomalyCounts: AnomalyCount[];
  whisperWarnings: WhisperWarning[];
  windowMs: number; // always 24h
}

const HEALTH_WINDOW_MS = 24 * 60 * 60 * 1000;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.floor((p / 100) * (sorted.length - 1));
  return sorted[Math.min(idx, sorted.length - 1)]!;
}

export function healthSummary(
  events: TelemetryEvent[],
  now = Date.now(),
): HealthSummary {
  const cutoff = now - HEALTH_WINDOW_MS;
  const recent = events.filter((e) => e.ts >= cutoff);

  // perf.* → collect ms values per type
  const perfBuckets = new Map<string, number[]>();
  // anomaly.* → counts
  const anomalyMap = new Map<string, number>();
  // whisper warnings
  const whisperWarnings: WhisperWarning[] = [];
  // slowest routes (perf.route only)
  const routeEvents: SlowRoute[] = [];

  for (const e of recent) {
    if (e.type.startsWith("perf.")) {
      const ms = typeof e.ms === "number" ? e.ms : null;
      if (ms !== null) {
        let bucket = perfBuckets.get(e.type);
        if (!bucket) { bucket = []; perfBuckets.set(e.type, bucket); }
        bucket.push(ms);
      }
      if (e.type === "perf.route") {
        routeEvents.push({
          ts: e.ts,
          path: typeof e.path === "string" ? e.path : "?",
          ms: typeof e.ms === "number" ? e.ms : 0,
          status: typeof e.status === "number" ? e.status : 0,
        });
      }
    } else if (e.type.startsWith("anomaly.")) {
      anomalyMap.set(e.type, (anomalyMap.get(e.type) ?? 0) + 1);
      if (e.type === "anomaly.whisper_warning") {
        whisperWarnings.push({
          ts: e.ts,
          message: typeof e.message === "string" ? e.message : String(e.message ?? ""),
          ...(typeof e.mediaId === "string" ? { mediaId: e.mediaId } : {}),
        });
      }
    }
  }

  const perfStats: PerfStat[] = [...perfBuckets.entries()].map(([type, vals]) => {
    const sorted = [...vals].sort((a, b) => a - b);
    return {
      type,
      count: sorted.length,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      min: sorted[0]!,
      max: sorted[sorted.length - 1]!,
    };
  }).sort((a, b) => a.type.localeCompare(b.type));

  const slowestRoutes = [...routeEvents]
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 10);

  const anomalyCounts: AnomalyCount[] = [...anomalyMap.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count);

  return { perfStats, slowestRoutes, anomalyCounts, whisperWarnings, windowMs: HEALTH_WINDOW_MS };
}

export async function healthSummaryFromFile(now = Date.now()): Promise<HealthSummary> {
  return healthSummary(await readEvents(), now);
}

// --- per-word mining history (lookup popup) --------------------------------
//
// The lookup/anki_add events each carry a `word` field (the SURFACE word the
// user clicked — not the lemma). To find a word's history we match that field
// against the set of forms we know for it (lemma + surface). Everything here is
// derived from the raw log — no extra storage:
//   - addedAt:    ts of the FIRST anki_add for the word (when it was mined)
//   - lookups:    count of lookup events for the word
//   - firstSeenAt / firstSeenMediaId: the EARLIEST event (lookup or add),
//     i.e. when/where the user first interacted with the word.
// We deliberately do NOT claim "first appeared in episode N" — the event log
// only records interactions, not passive on-screen appearances.

export interface WordHistory {
  /** epoch ms of the first anki_add for this word (undefined if never added). */
  addedAt?: number;
  /** number of lookup events for this word. */
  lookups: number;
  /** epoch ms of the earliest interaction (lookup or add) with this word. */
  firstSeenAt?: number;
  /** mediaId carried by that earliest interaction, when present. */
  firstSeenMediaId?: string;
}

/**
 * Aggregate a word's interaction history from the raw event log. `forms` is the
 * set of surface/lemma strings that count as "this word"; an event matches when
 * its `word` field equals any of them. Pure — testable on an in-memory array.
 */
export function wordHistory(
  events: TelemetryEvent[],
  forms: string[],
): WordHistory {
  const wanted = new Set(forms.map((f) => f.trim()).filter(Boolean));
  let addedAt: number | undefined;
  let lookups = 0;
  let firstSeenAt: number | undefined;
  let firstSeenMediaId: string | undefined;

  for (const e of events) {
    if (e.type !== "anki_add" && e.type !== "lookup") continue;
    if (typeof e.word !== "string" || !wanted.has(e.word)) continue;
    if (!Number.isFinite(e.ts)) continue;

    if (firstSeenAt === undefined || e.ts < firstSeenAt) {
      firstSeenAt = e.ts;
      firstSeenMediaId = typeof e.mediaId === "string" ? e.mediaId : undefined;
    }
    if (e.type === "anki_add") {
      if (addedAt === undefined || e.ts < addedAt) addedAt = e.ts;
    } else {
      lookups += 1;
    }
  }

  return {
    ...(addedAt !== undefined ? { addedAt } : {}),
    lookups,
    ...(firstSeenAt !== undefined ? { firstSeenAt } : {}),
    ...(firstSeenMediaId !== undefined ? { firstSeenMediaId } : {}),
  };
}

// Bound for the word-history read: events.jsonl grows unbounded over months,
// but word history only needs recent-ish events ("first added" is monotonic and,
// for any realistically-used word, lands well within the most recent slice).
// We cap to the last N PARSED events so a cold cache miss stays O(N) instead of
// O(file size). Trade-off: a word whose ONLY interactions predate the last N
// events would report no history — acceptable for a lookup-popup convenience.
export const WORD_HISTORY_MAX_EVENTS = 50_000;

/**
 * Read at most the last `max` events from the log. Reads the whole file then
 * slices the tail of the parsed array — bounding the EXPENSIVE parse/aggregate
 * cost (the file read itself is cheap relative to JSON.parse per line) and
 * keeping correctness for the common recent-word case. Documented bound:
 * WORD_HISTORY_MAX_EVENTS.
 */
export async function readRecentEvents(
  max = WORD_HISTORY_MAX_EVENTS,
): Promise<TelemetryEvent[]> {
  let text: string;
  try {
    text = await readFile(eventsFilePath(), "utf8");
  } catch {
    return [];
  }
  // Slice the last ~max non-empty lines before parsing, so the parse cost is
  // bounded even as events.jsonl grows to many MB.
  const lines = text.split("\n");
  const start = Math.max(0, lines.length - max - 1); // -1 for trailing newline
  return parseEventLines(lines, start);
}

export async function wordHistoryFromFile(forms: string[]): Promise<WordHistory> {
  return wordHistory(await readRecentEvents(), forms);
}
