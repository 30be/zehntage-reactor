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
  if (useBeacon && typeof navigator !== "undefined" && navigator.sendBeacon) {
    const ok = navigator.sendBeacon(
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

/** Force an immediate flush (tests / explicit checkpoints). */
export function tmFlush(): void {
  flush(false);
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
