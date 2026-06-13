// Raw telemetry event log (JSONL) + summary aggregation.
//
// Events are appended to ~/.local/share/zehntage-reactor/events.jsonl
// (override with ZR_EVENTS_FILE — used by tests). One JSON object per line:
//   { ts: <epoch ms>, type: "heartbeat" | "anki_add" | ..., mediaId?, ... }
// The log is append-only and parsed on demand by summarizeEvents().

import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { mkdir, appendFile, readFile } from "node:fs/promises";

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
    .filter((e) => e && typeof e.type === "string")
    .map((e) => JSON.stringify({ ...e, ts: typeof e.ts === "number" ? e.ts : Date.now() }))
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

export async function readEvents(): Promise<TelemetryEvent[]> {
  let text: string;
  try {
    text = await readFile(eventsFilePath(), "utf8");
  } catch {
    return [];
  }
  const out: TelemetryEvent[] = [];
  for (const line of text.split("\n")) {
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

  const day = (ts: number) => {
    const key = localDate(ts);
    let d = days.get(key);
    if (!d) {
      d = { date: key, playSec: 0, pauseSec: 0, mediaCount: 0, ankiAdds: 0, lookups: 0, media: new Set() };
      days.set(key, d);
    }
    return d;
  };
  const med = (id: string) => {
    let m = media.get(id);
    if (!m) {
      m = { mediaId: id, wallSec: 0, contentSec: 0, ankiAdds: 0, lookups: 0 };
      media.set(id, m);
    }
    return m;
  };

  for (const e of events) {
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
    const key = `${mediaId} ${date}`;
    let r = rows.get(key);
    if (!r) {
      r = {
        mediaId,
        date,
        wallPlayingSec: 0,
        wallPausedSec: 0,
        contentSec: 0,
        lookups: 0,
        ankiAdds: 0,
      };
      rows.set(key, r);
    }
    return r;
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
    let d = byDay.get(r.date);
    if (!d) {
      d = {
        date: r.date,
        wallPlayingSec: 0,
        wallPausedSec: 0,
        contentSec: 0,
        lookups: 0,
        ankiAdds: 0,
      };
      byDay.set(r.date, d);
    }
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
