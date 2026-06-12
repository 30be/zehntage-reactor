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
