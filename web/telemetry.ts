// Client-side telemetry: in-memory queue, flushed to POST /api/events every
// 10s and on pagehide (sendBeacon so the final batch survives tab close).
//
// Usage:
//   tmEvent("route_change", { route: "library" })
//   tmHeartbeat(mediaId, position, paused)   // call every ~15s from the Player

interface QueuedEvent {
  ts: number;
  type: string;
  [key: string]: unknown;
}

const queue: QueuedEvent[] = [];
const FLUSH_MS = 10_000;
const QUEUE_CAP = 500; // drop oldest beyond this — telemetry must never OOM the tab

/** Enqueue a generic telemetry event. */
export function tmEvent(type: string, payload: Record<string, unknown> = {}): void {
  queue.push({ ts: Date.now(), type, ...payload });
  if (queue.length > QUEUE_CAP) queue.splice(0, queue.length - QUEUE_CAP);
}

/** Playback heartbeat — intended to be called every ~15s while a player is
 * mounted (playing OR paused; the server splits wall time by `paused`). */
export function tmHeartbeat(mediaId: string, position: number, paused: boolean): void {
  tmEvent("heartbeat", { mediaId, position, paused });
}

function flush(useBeacon = false): void {
  if (queue.length === 0) return;
  const events = queue.splice(0, queue.length);
  const body = JSON.stringify({ events });
  const nav = navigator as Navigator & {
    sendBeacon?: (url: string, data?: Blob) => boolean;
  };
  if (useBeacon && typeof navigator !== "undefined" && nav.sendBeacon) {
    const ok = nav.sendBeacon(
      "/api/events",
      new Blob([body], { type: "application/json" }),
    );
    if (ok) return;
    // beacon refused (size/limits) — fall through to fetch with keepalive
  }
  void fetch("/api/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    keepalive: useBeacon,
  }).catch(() => {
    // network hiccup: re-queue so the next flush retries (bounded by cap)
    queue.unshift(...events);
    if (queue.length > QUEUE_CAP) queue.length = QUEUE_CAP;
  });
}

let started = false;
/** Start the periodic flusher + pagehide hook. Idempotent; call once from App. */
export function tmStart(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  window.setInterval(() => flush(false), FLUSH_MS);
  window.addEventListener("pagehide", () => flush(true));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush(true);
  });
}

// ---------------------------------------------------------------------------
// Client perf marks — thin wrappers around performance.mark/measure.
// Results are posted via the existing queue (no extra flush, no spam).
// ---------------------------------------------------------------------------

/** Drop a named mark (no event posted yet — call tmMeasure later). */
export function tmMark(name: string): void {
  try { performance.mark(name); } catch { /* noop */ }
}

/**
 * Measure from `startMark` to now, post as a perf.client.* telemetry event.
 * The mark is cleared after measuring (avoids stale marks on re-renders).
 */
export function tmMeasure(
  eventType: string,
  startMark: string,
  payload: Record<string, unknown> = {},
): void {
  try {
    const entries = performance.getEntriesByName(startMark, "mark");
    if (entries.length === 0) return;
    const ms = performance.now() - entries[entries.length - 1]!.startTime;
    performance.clearMarks(startMark);
    tmEvent(eventType, { ms: Math.round(ms), ...payload });
  } catch { /* noop */ }
}

/** Post an anomaly event immediately into the telemetry queue. */
export function tmAnomaly(type: string, payload: Record<string, unknown> = {}): void {
  tmEvent(`anomaly.${type}`, payload);
}
