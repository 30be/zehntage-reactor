# Observability Wave Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Instrument server routes, expensive call-sites, and client interactions with timing/anomaly telemetry events; add a `/api/health/summary` endpoint and a `#/health` debug view.

**Architecture:** Thin wrappers at server call-sites log `perf.*` and `anomaly.*` JSONL events through the existing `logEvent` / `logEvents` API. A new `healthSummary()` pure function (in `src/lib/telemetry.ts`) aggregates p50/p95/slowest from those events. A new `/api/health/summary` route in the server returns the JSON. A new `HealthRoute.tsx` renders it. Client perf marks use `performance.mark`/`measure` and batch-post as `perf.client.*` events through the existing client telemetry queue.

**Tech Stack:** Bun/TypeScript, React, `performance.mark`/`measure` (browser), existing JSONL telemetry pipeline, Playwright for e2e.

---

## Chunk 1: Server-side perf/anomaly event helpers + unit tests

### Task 1: `healthSummary()` aggregation in `src/lib/telemetry.ts`

**Files:**
- Modify: `src/lib/telemetry.ts`
- Test: `tests/telemetry.test.ts`

The new function reads `perf.*` and `anomaly.*` events from the last 24 h and produces:
- p50 / p95 per event type (over the `ms` field)
- slowest 10 `perf.route` entries (path, ms, status, ts)
- anomaly counts by type
- whisper warnings list (from `anomaly.whisper_warning` events)

- [ ] **Step 1: Write the failing unit tests**

In `tests/telemetry.test.ts`, append:

```typescript
import { healthSummary, type HealthSummary } from "../src/lib/telemetry.ts";

const NOW = Date.now();
const H = 3600_000;

function perf(type: string, ms: number, extra: Record<string,unknown> = {}): TelemetryEvent {
  return { ts: NOW - H, type, ms, ...extra };
}

describe("healthSummary", () => {
  test("empty log", () => {
    const s = healthSummary([], NOW);
    expect(s.perfStats).toEqual([]);
    expect(s.slowestRoutes).toEqual([]);
    expect(s.anomalyCounts).toEqual([]);
    expect(s.whisperWarnings).toEqual([]);
  });

  test("p50/p95 computed correctly for a type", () => {
    const events: TelemetryEvent[] = Array.from({ length: 10 }, (_, i) =>
      perf("perf.gemini", (i + 1) * 100),
    );
    const s = healthSummary(events, NOW);
    const gem = s.perfStats.find((r) => r.type === "perf.gemini");
    expect(gem).toBeTruthy();
    expect(gem!.count).toBe(10);
    // p50 of [100..1000] = 500 or 600 (median of 10 values)
    expect(gem!.p50).toBeGreaterThanOrEqual(500);
    expect(gem!.p50).toBeLessThanOrEqual(600);
    expect(gem!.p95).toBeGreaterThanOrEqual(900);
  });

  test("events older than 24h are excluded", () => {
    const old: TelemetryEvent = { ts: NOW - 25 * H, type: "perf.gemini", ms: 9999 };
    const recent: TelemetryEvent = perf("perf.gemini", 100);
    const s = healthSummary([old, recent], NOW);
    const gem = s.perfStats.find((r) => r.type === "perf.gemini")!;
    expect(gem.count).toBe(1);
    expect(gem.p50).toBe(100);
  });

  test("slowest 10 routes returned in desc order", () => {
    const events: TelemetryEvent[] = Array.from({ length: 15 }, (_, i) =>
      ({ ts: NOW - H, type: "perf.route", ms: i * 100, path: "/api/x", status: 200 }),
    );
    const s = healthSummary(events, NOW);
    expect(s.slowestRoutes).toHaveLength(10);
    expect(s.slowestRoutes[0]!.ms).toBeGreaterThanOrEqual(s.slowestRoutes[1]!.ms);
  });

  test("anomaly counts aggregated", () => {
    const events: TelemetryEvent[] = [
      { ts: NOW - H, type: "anomaly.anki_slow", ms: 4000 },
      { ts: NOW - H, type: "anomaly.anki_slow", ms: 5000 },
      { ts: NOW - H, type: "anomaly.gemini_fail" },
    ];
    const s = healthSummary(events, NOW);
    const anki = s.anomalyCounts.find((a) => a.type === "anomaly.anki_slow");
    expect(anki!.count).toBe(2);
  });

  test("whisper warnings collected", () => {
    const events: TelemetryEvent[] = [
      { ts: NOW - H, type: "anomaly.whisper_warning", message: "coverage hole: 45s–60s", mediaId: "abc" },
    ];
    const s = healthSummary(events, NOW);
    expect(s.whisperWarnings[0]!.message).toBe("coverage hole: 45s–60s");
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL (function not exported)**

```
bun test tests/telemetry.test.ts
```
Expected: `TypeError: healthSummary is not a function` or similar.

- [ ] **Step 3: Implement `healthSummary` in `src/lib/telemetry.ts`**

Append to the end of `src/lib/telemetry.ts`:

```typescript
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
```

- [ ] **Step 4: Run tests — expect PASS**

```
bun test tests/telemetry.test.ts
```
Expected: all telemetry tests pass.

- [ ] **Step 5: TypeScript check**

```
bunx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 6: Commit**

```
git add src/lib/telemetry.ts tests/telemetry.test.ts
git commit -m "feat(telemetry): add healthSummary() for perf/anomaly aggregation over 24h"
```

---

### Task 2: Route timing middleware in `src/server/index.ts`

**Files:**
- Modify: `src/server/index.ts`

**Approach:** wrap `fetchHandler` with a thin timer that logs `perf.route`. Sample: log only if `ms > 50` OR a random 1-in-10 draw. Use a fast route-pattern extractor (collapse numeric/hex IDs and base64 segments to `:id`).

- [ ] **Step 1: Add route pattern normalizer + sampling wrapper before `fetchHandler` definition**

Locate the line:
```typescript
  const fetchHandler = async (req: Request): Promise<Response> => {
```

Insert just before it:

```typescript
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
```

- [ ] **Step 2: Wrap the handler body with timing**

Find:
```typescript
  const fetchHandler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;

    try {
```

Replace with:

```typescript
  const fetchHandler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    const _t0 = Date.now();

    const _respond = async (): Promise<Response> => {
    try {
```

Then find the closing brace of the main try/catch (the one that catches all errors before the `Bun.serve` call). It currently ends with:

```typescript
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  };
```

Replace that entire closing with:

```typescript
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
```

- [ ] **Step 3: TypeScript check**

```
bunx tsc --noEmit
```

- [ ] **Step 4: Commit**

```
git add src/server/index.ts
git commit -m "feat(server): per-request perf.route timing with path-pattern sampling"
```

---

### Task 3: Gemini call-site timing + anomaly flags

**Files:**
- Modify: `src/server/index.ts` (call sites for `lookupWord`, `translateCues`, `explainSentence`)

**Approach:** time each await at the call site; emit `perf.gemini` and `anomaly.gemini_fail` events. Do NOT rewrite `src/lib/gemini.ts` signatures.

- [ ] **Step 1: Wrap `lookupWord` in `/api/lookup`**

Find:
```typescript
        void logEvent("lookup", { word: body.word, mediaId: body.mediaId });
        return json(
          await lookupWord(
            body.word,
            body.context ?? "",
            body.source ?? "",
            image,
            body.secondary,
          ),
        );
```

Replace with:

```typescript
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
```

- [ ] **Step 2: Wrap `explainSentence` in `/api/explain`**

Find:
```typescript
        const res = await explainSentence(
          body.sentence,
          body.secondary ?? "",
          body.source ?? "",
          body.context ?? "",
        );
        explainCachePut(cacheKey, res);
```

Replace with:

```typescript
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
```

- [ ] **Step 3: Wrap `translateCues` in `pumpTranslateBatch`**

Find:
```typescript
        const cues = await cuesForTrack(entry, item.sourceTrack);
        const translated = await translateCues(cues, item.targetLang);
```

Replace with:

```typescript
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
```

- [ ] **Step 4: TypeScript check + tests**

```
bunx tsc --noEmit
bun test
```

- [ ] **Step 5: Commit**

```
git add src/server/index.ts
git commit -m "feat(server): perf.gemini timing + anomaly.gemini_fail at call sites"
```

---

### Task 4: Anki call-site timing + anomaly flags

**Files:**
- Modify: `src/server/index.ts` (the `POST /api/anki/add` handler and `refreshAnkiWordsCache`)

The `addCard` call is the one that can be slow. Flag `anomaly.anki_slow` when it exceeds 3 s.

- [ ] **Step 1: Time `ankiLocalAvailable` probe (perf.anki with op "probe") and `addCard`**

Find:
```typescript
        const useLocal = await ankiLocalAvailable();
```

Replace with:

```typescript
        const _ankiProbeT0 = Date.now();
        const useLocal = await ankiLocalAvailable();
        void logEvent("perf.anki", { op: "probe", ms: Date.now() - _ankiProbeT0, local: useLocal });
```

Find:
```typescript
        await addCard({
          front,
          back: body.translation,
          notes: body.notes ?? "",
          context,
          // Marks the card as ours for the Cards tab filter. Local AnkiConnect
          // sets it as a real note tag; the remote anki-mcp may ignore the
          // field, in which case the context source-line pattern still matches.
          tags: ["zehntage"],
          ...(image ? { image, image_field: "context" } : {}),
        });
        bustAnkiWordsCache();
        void logEvent("anki_add", { word: body.word, mediaId: body.mediaId });
```

Replace with:

```typescript
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
```

- [ ] **Step 2: Time `listWords`+`getProgress` in `refreshAnkiWordsCache` in `src/server/index.ts`**

Find:
```typescript
      const [words, progress] = await Promise.all([listWords(), getProgress()]);
      const body = JSON.stringify({ words, progress });
```

Replace with:

```typescript
      const _wordsT0 = Date.now();
      const [words, progress] = await Promise.all([listWords(), getProgress()]);
      void logEvent("perf.anki", { op: "words", ms: Date.now() - _wordsT0 });
      const body = JSON.stringify({ words, progress });
```

- [ ] **Step 3: TypeScript check**

```
bunx tsc --noEmit
```

- [ ] **Step 4: Commit**

```
git add src/server/index.ts
git commit -m "feat(server): perf.anki timing + anomaly.anki_slow threshold at call sites"
```

---

### Task 5: Whisper duration + anomaly flags

**Files:**
- Modify: `src/server/index.ts` (whisper start handler + listen for completion)
- Modify: `src/lib/whisper.ts` — ONLY to emit coverage-hole warnings through the existing `warning` event mechanism (no signature changes)

The whisper job already has a `warnings` array populated by `WhisperQueue`. We need to:
1. Time whisper jobs (start→done) by logging `perf.whisper` when the `done` status event fires.
2. Emit `anomaly.whisper_warning` for each warning already in `job.warnings` at job completion.

- [ ] **Step 1: Extend the `doneListener` in `/api/whisper/:id` POST handler**

Find:
```typescript
        const doneListener = (e: WhisperEvent) => {
          if (e.type !== "status") return;
          if (e.status === "done")
            void logEvent("whisper_done", { mediaId: entry.id, lang });
          if (e.status === "done" || e.status === "error" || e.status === "canceled")
            job.listeners.delete(doneListener);
        };
        job.listeners.add(doneListener);
```

Replace with:

```typescript
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
```

- [ ] **Step 2: TypeScript check**

```
bunx tsc --noEmit
```

- [ ] **Step 3: Commit**

```
git add src/server/index.ts
git commit -m "feat(server): perf.whisper duration + anomaly.whisper_warning on job completion"
```

---

### Task 6: Tokenize batch timing

**Files:**
- Modify: `src/server/index.ts` — wrap `collectIndexes` / `entryIndexFor` calls that do real work

The heaviest tokenize calls are in `collectIndexes` for comprehensibility and due-intersection. Wrap those call-sites.

- [ ] **Step 1: Add a helper to time collectIndexes results**

Find the first `collectIndexes` call site (in `/api/index/comprehensibility`):

```typescript
        const indexes = await collectIndexes(entries, 30); // budget: ≤30 new builds
```

Replace with:

```typescript
        const _tokT0 = Date.now();
        const indexes = await collectIndexes(entries, 30); // budget: ≤30 new builds
        const _newlyBuilt = indexes.size - builtIndexIds.size + (indexes.size > 0 ? 0 : 0);
        void logEvent("perf.tokenize", { op: "comprehensibility", ms: Date.now() - _tokT0, indexed: indexes.size });
```

Find the second `collectIndexes` call (in `/api/index/due`):

```typescript
        const indexes = await collectIndexes(entries, 30);
```

Replace (there are two — target the one inside `/api/index/due`):

```typescript
        const _tokDueT0 = Date.now();
        const indexes = await collectIndexes(entries, 30);
        void logEvent("perf.tokenize", { op: "due", ms: Date.now() - _tokDueT0, indexed: indexes.size });
```

Find the third call (in `/api/index/showfreq`):

```typescript
        const indexes = await collectIndexes(scope, Math.max(1, scope.length));
```

Replace with:

```typescript
        const _tokSfT0 = Date.now();
        const indexes = await collectIndexes(scope, Math.max(1, scope.length));
        void logEvent("perf.tokenize", { op: "showfreq", ms: Date.now() - _tokSfT0, indexed: indexes.size });
```

- [ ] **Step 2: TypeScript check + full test suite**

```
bunx tsc --noEmit
bun test
```

- [ ] **Step 3: Commit**

```
git add src/server/index.ts
git commit -m "feat(server): perf.tokenize timing at collectIndexes call sites"
```

---

### Task 7: `/api/health/summary` route

**Files:**
- Modify: `src/server/index.ts`

Add the endpoint just before the "static assets" fallback block.

- [ ] **Step 1: Add route**

Find:
```typescript
      // --- other static assets in public/ ---
      if (req.method === "GET" && !path.startsWith("/api/")) {
```

Insert before it:

```typescript
      // --- health / perf summary (last 24h) ---
      if (req.method === "GET" && path === "/api/health/summary") {
        const { healthSummaryFromFile } = await import("../lib/telemetry.ts");
        return json(await healthSummaryFromFile());
      }
```

Note: `healthSummaryFromFile` is already exported from `src/lib/telemetry.ts`. The dynamic import avoids adding to the top-level import list which a CLI batch job also uses; alternatively add it to the static import (either way is fine — prefer static import since it's already imported):

Actually, since `telemetry.ts` is already statically imported, just add `healthSummaryFromFile` to the existing import destructure. Locate:

```typescript
import {
  logEvent,
  logEvents,
  statsSummary,
  readEvents,
  episodeSeries,
  overview,
  toCsv,
  type TelemetryEvent,
} from "../lib/telemetry.ts";
```

Replace with:

```typescript
import {
  logEvent,
  logEvents,
  statsSummary,
  readEvents,
  episodeSeries,
  overview,
  toCsv,
  healthSummaryFromFile,
  type TelemetryEvent,
} from "../lib/telemetry.ts";
```

And use a straightforward handler (not dynamic import):

```typescript
      if (req.method === "GET" && path === "/api/health/summary") {
        return json(await healthSummaryFromFile());
      }
```

- [ ] **Step 2: TypeScript check**

```
bunx tsc --noEmit
```

- [ ] **Step 3: Commit**

```
git add src/server/index.ts src/lib/telemetry.ts
git commit -m "feat(server): /api/health/summary endpoint"
```

---

## Chunk 2: Client perf marks + anomaly flags

### Task 8: Client perf mark helpers in `web/telemetry.ts`

**Files:**
- Modify: `web/telemetry.ts`

Add two thin wrappers around `performance.mark`/`measure` that post results as telemetry events. These are batched through the existing queue — no extra flush.

- [ ] **Step 1: Add `tmMark` and `tmMeasure` to `web/telemetry.ts`**

Append to `web/telemetry.ts`:

```typescript
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
```

- [ ] **Step 2: TypeScript check (web)**

```
bunx tsc -p web --noEmit
```

- [ ] **Step 3: Commit**

```
git add web/telemetry.ts
git commit -m "feat(client): tmMark/tmMeasure/tmAnomaly helpers in web telemetry"
```

---

### Task 9: Cue fetch→first-render mark in `web/Player.tsx`

**Files:**
- Modify: `web/Player.tsx`

Measure: from when subs fetch starts to when `primaryCues` is set (cue fetch latency) and from cue set to when tokenized swap is triggered (tokenizer render latency). Flag `anomaly.cue_fetch_slow` if > 1 s.

- [ ] **Step 1: Add imports at top of `web/Player.tsx`**

Find the import line:
```typescript
import { tmHeartbeat, tmEvent } from "./telemetry.ts";
```

Replace with:
```typescript
import { tmHeartbeat, tmEvent, tmMark, tmMeasure, tmAnomaly } from "./telemetry.ts";
```

- [ ] **Step 2: Wrap the cue-fetch effect at lines ~738–762 of `web/Player.tsx`**

Find this block (the primary cue-loading `useEffect`):

```typescript
    let cancelled = false;
    setCuesLoading(true);
    void api
      .cues(entry.id, primaryId)
      .then((c) => {
        if (cancelled) return;
        // cues are in — NOW start the (main-thread-heavy) dict init so the
        // plain-text line renders first and tokens swap in when ready
        warmTokenizer();
        setPrimaryCues(c);
        // No whisper job running → any leftover live cues are stale now.
        if (whisperJobRef.current == null) clearWhisperCues();
      })
      .catch(() => !cancelled && setPrimaryCues([]))
      .finally(() => !cancelled && setCuesLoading(false));
```

Replace with:

```typescript
    let cancelled = false;
    setCuesLoading(true);
    const _cueFetchT0 = Date.now();
    void api
      .cues(entry.id, primaryId)
      .then((c) => {
        if (cancelled) return;
        const _ms = Date.now() - _cueFetchT0;
        tmEvent("perf.client.cue_fetch", { ms: _ms, trackId: primaryId });
        if (_ms > 1000) tmAnomaly("cue_fetch_slow", { ms: _ms, trackId: primaryId });
        // cues are in — NOW start the (main-thread-heavy) dict init so the
        // plain-text line renders first and tokens swap in when ready
        warmTokenizer();
        setPrimaryCues(c);
        // No whisper job running → any leftover live cues are stale now.
        if (whisperJobRef.current == null) clearWhisperCues();
      })
      .catch(() => !cancelled && setPrimaryCues([]))
      .finally(() => !cancelled && setCuesLoading(false));
```

- [ ] **Step 3: TypeScript check**

```
bunx tsc -p web --noEmit
```

- [ ] **Step 4: Commit**

```
git add web/Player.tsx
git commit -m "feat(client): cue_fetch timing + anomaly.cue_fetch_slow >1s"
```

---

### Task 10: Popup open→lookup result mark in `web/Player.tsx`

**Files:**
- Modify: `web/Player.tsx`

Measure: from popup open (hover threshold crossed + word selected) to when the `lookupWord` result arrives. Also measure tokenized swap latency (when `primaryId` changes to when the `.tok` elements first appear — approximated as time from setTokens to next paint).

- [ ] **Step 1: Time the popup `api.lookup` call (lines ~1582–1596 of `web/Player.tsx`)**

Find:

```typescript
    let p = inflight.current.get(cacheKey);
    if (!p) {
      p = api.lookup({
        word: surface,
        context: ctx,
        source: entry.name,
        secondary: popup.secondary,
      })
        .then((res) => {
          lookupCache.current.set(cacheKey, res);
          return res;
        })
        .finally(() => inflight.current.delete(cacheKey));
      inflight.current.set(cacheKey, p);
    }
```

Replace with:

```typescript
    let p = inflight.current.get(cacheKey);
    if (!p) {
      const _lookupT0 = Date.now();
      p = api.lookup({
        word: surface,
        context: ctx,
        source: entry.name,
        secondary: popup.secondary,
      })
        .then((res) => {
          tmEvent("perf.client.lookup", { ms: Date.now() - _lookupT0, word: surface });
          lookupCache.current.set(cacheKey, res);
          return res;
        })
        .finally(() => inflight.current.delete(cacheKey));
      inflight.current.set(cacheKey, p);
    }
```

- [ ] **Step 2: Time anki cache hydration in `web/ankicache.ts`**

Add import at the top of `web/ankicache.ts`:

```typescript
import { tmEvent } from "./telemetry.ts";
```

Find (in the `revalidate` function, lines ~84–108):

```typescript
      const cached = readAnkiCache();
      const headers: Record<string, string> = {};
      if (cached?.etag) headers["If-None-Match"] = cached.etag;
      const r = await fetch("/api/anki/words", { headers });
      if (r.status === 304 && cached) {
```

Replace with:

```typescript
      const cached = readAnkiCache();
      const headers: Record<string, string> = {};
      if (cached?.etag) headers["If-None-Match"] = cached.etag;
      const _ankiT0 = Date.now();
      const r = await fetch("/api/anki/words", { headers });
      tmEvent("perf.client.anki_hydrate", { ms: Date.now() - _ankiT0, status: r.status });
      if (r.status === 304 && cached) {
```

- [ ] **Step 3: TypeScript check**

```
bunx tsc -p web --noEmit
```

- [ ] **Step 4: Commit**

```
git add web/Player.tsx web/ankicache.ts
git commit -m "feat(client): lookup latency + anki cache hydrate timing"
```

---

### Task 11: SSE reconnect anomaly + whisper warning anomaly in client

**Files:**
- Modify: `web/player/useWhisperJob.ts`

When the EventSource for the whisper SSE closes unexpectedly (not on terminal status), it retries. Flag `anomaly.sse_reconnect` on each retry.

- [ ] **Step 1: Locate retry logic in `useWhisperJob.ts`**

The hook has `whisperRetryRef.current` incremented on error. Find the `es.onerror` handler (or the retry-attach timer). Emit anomaly:

```typescript
tmAnomaly("sse_reconnect", { jobId, attempt: whisperRetryRef.current });
```

Import at top:
```typescript
import { tmAnomaly } from "../telemetry.ts";
```

- [ ] **Step 2: Emit `anomaly.whisper_warning` when whisper status includes warnings (client side)**

The client receives the `snapshot` and `status` events. When the terminal `done` status arrives and `job.warnings` are present on the server, the client has no direct access to them. Skip client-side whisper warning anomaly — it's covered server-side in Task 5.

- [ ] **Step 3: TypeScript check**

```
bunx tsc -p web --noEmit
```

- [ ] **Step 4: Commit**

```
git add web/player/useWhisperJob.ts
git commit -m "feat(client): anomaly.sse_reconnect on whisper stream re-attach"
```

---

## Chunk 3: Health debug view

### Task 12: `HealthRoute.tsx` component

**Files:**
- Create: `web/HealthRoute.tsx`

Render `/api/health/summary` as a laconic monochrome table. Sections:
1. Perf stats table (type | count | p50 ms | p95 ms | min | max) — with a tiny ASCII bar for p95 scaled to max across rows.
2. Slowest 10 routes (path | ms | status | time).
3. Anomaly counts (type | count).
4. Whisper warnings (time | media | message).

No external deps, no colors beyond the monochrome CSS already in `styles.css`.

- [ ] **Step 1: Write `web/HealthRoute.tsx`**

```tsx
import { useEffect, useState } from "react";

interface PerfStat {
  type: string; count: number; p50: number; p95: number; min: number; max: number;
}
interface SlowRoute {
  ts: number; path: string; ms: number; status: number;
}
interface AnomalyCount { type: string; count: number; }
interface WhisperWarning { ts: number; message: string; mediaId?: string; }
interface HealthSummary {
  perfStats: PerfStat[];
  slowestRoutes: SlowRoute[];
  anomalyCounts: AnomalyCount[];
  whisperWarnings: WhisperWarning[];
  windowMs: number;
}

function bar(val: number, max: number, width = 10): string {
  if (max === 0) return " ".repeat(width);
  const filled = Math.round((val / max) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function fmt(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function fmtTs(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}:${String(d.getSeconds()).padStart(2,"0")}`;
}

export function HealthRoute() {
  const [data, setData] = useState<HealthSummary | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/health/summary")
      .then((r) => r.ok ? r.json() : Promise.reject(r.status))
      .then((d) => setData(d as HealthSummary))
      .catch((e) => setErr(String(e)));
  }, []);

  if (err) return <div className="health-page"><span className="health-err">error: {err}</span></div>;
  if (!data) return <div className="health-page"><span className="health-loading">loading…</span></div>;

  const maxP95 = Math.max(1, ...data.perfStats.map((s) => s.p95));

  return (
    <div className="health-page">
      <h2 className="health-title">health · last 24h</h2>

      <section className="health-section">
        <h3 className="health-section-title">perf stats</h3>
        {data.perfStats.length === 0
          ? <div className="health-empty">no data</div>
          : (
          <table className="health-table">
            <thead><tr>
              <th>type</th><th>n</th><th>p50</th><th>p95</th><th>min</th><th>max</th><th>p95 bar</th>
            </tr></thead>
            <tbody>
              {data.perfStats.map((s) => (
                <tr key={s.type}>
                  <td className="health-type">{s.type}</td>
                  <td>{s.count}</td>
                  <td>{fmt(s.p50)}</td>
                  <td>{fmt(s.p95)}</td>
                  <td>{fmt(s.min)}</td>
                  <td>{fmt(s.max)}</td>
                  <td className="health-bar">{bar(s.p95, maxP95)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="health-section">
        <h3 className="health-section-title">slowest routes</h3>
        {data.slowestRoutes.length === 0
          ? <div className="health-empty">no data</div>
          : (
          <table className="health-table">
            <thead><tr><th>path</th><th>ms</th><th>status</th><th>time</th></tr></thead>
            <tbody>
              {data.slowestRoutes.map((r, i) => (
                <tr key={i}>
                  <td className="health-type">{r.path}</td>
                  <td className={r.ms > 1000 ? "health-warn" : ""}>{fmt(r.ms)}</td>
                  <td className={r.status >= 500 ? "health-err" : ""}>{r.status}</td>
                  <td>{fmtTs(r.ts)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="health-section">
        <h3 className="health-section-title">anomalies</h3>
        {data.anomalyCounts.length === 0
          ? <div className="health-empty">none</div>
          : (
          <table className="health-table">
            <thead><tr><th>type</th><th>count</th></tr></thead>
            <tbody>
              {data.anomalyCounts.map((a) => (
                <tr key={a.type}>
                  <td className="health-type">{a.type}</td>
                  <td className="health-warn">{a.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="health-section">
        <h3 className="health-section-title">whisper warnings</h3>
        {data.whisperWarnings.length === 0
          ? <div className="health-empty">none</div>
          : (
          <table className="health-table">
            <thead><tr><th>time</th><th>media</th><th>message</th></tr></thead>
            <tbody>
              {data.whisperWarnings.map((w, i) => (
                <tr key={i}>
                  <td>{fmtTs(w.ts)}</td>
                  <td>{w.mediaId ?? "—"}</td>
                  <td className="health-type">{w.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
```

- [ ] **Step 2: TypeScript check (web)**

```
bunx tsc -p web --noEmit
```

- [ ] **Step 3: Commit**

```
git add web/HealthRoute.tsx
git commit -m "feat(client): HealthRoute component for /health debug view"
```

---

### Task 13: Wire `#/health` route in `web/App.tsx`

**Files:**
- Modify: `web/App.tsx`

- [ ] **Step 1: Add `health` to the `Route` union and `parseHash`**

Find:
```typescript
type Route =
  | { name: "library" }
  | { name: "player"; id: string; t?: number }
  | { name: "read"; id: string }
  | { name: "settings" }
  | { name: "stats" }
  | { name: "cards" }
  | { name: "home" };
```

Add `| { name: "health" }` at the end.

Find:
```typescript
  if (h === "home") return { name: "home" };
  return { name: "library" };
```

Insert before the fallback:
```typescript
  if (h === "health") return { name: "health" };
```

- [ ] **Step 2: Import `HealthRoute` and render it**

Add import:
```typescript
import { HealthRoute } from "./HealthRoute.tsx";
```

Find the JSX where routes are rendered (look for `{route.name === "stats" && ...}` pattern) and add:
```tsx
{route.name === "health" && <HealthRoute />}
```

- [ ] **Step 3: Add "Health" sidebar entry**

Find the sequence of `navItem(...)` calls in the JSX (they all use `<ViewIcon>`, `<HomeIcon>`, etc.). Look for the last `navItem(...)` call before `</nav>` or the sidebar close. Append:

```tsx
{navItem("Health", <span className="side-icon">⬡</span>, "#/health", route.name === "health")}
```

Check the `navItem` helper signature by reading its definition near line 130. If `icon` is typed as `React.ReactNode`, any valid node (including a `<span>`) works.

- [ ] **Step 4: Add monochrome CSS for health page in `web/styles.css`**

Append to `web/styles.css`:

```css
/* health debug view */
.health-page { padding: 1.5rem; max-width: 900px; }
.health-title { font-size: 1rem; font-weight: 600; margin-bottom: 1rem; letter-spacing: .04em; text-transform: uppercase; }
.health-section { margin-bottom: 2rem; }
.health-section-title { font-size: .75rem; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; opacity: .55; margin-bottom: .5rem; }
.health-table { border-collapse: collapse; font-size: .8rem; font-family: monospace; width: 100%; }
.health-table th { text-align: left; padding: .2rem .6rem; border-bottom: 1px solid currentColor; opacity: .5; font-weight: 400; }
.health-table td { padding: .2rem .6rem; vertical-align: top; }
.health-table tr:hover td { background: rgba(128,128,128,.08); }
.health-type { opacity: .85; }
.health-bar { font-family: monospace; letter-spacing: -.05em; opacity: .6; }
.health-warn { color: var(--c-warn, #c80); }
.health-err { color: var(--c-err, #c00); }
.health-empty { font-size: .75rem; opacity: .4; padding: .3rem .6rem; }
.health-loading, .health-err { font-size: .8rem; opacity: .6; }
```

- [ ] **Step 5: TypeScript checks + build**

```
bunx tsc -p web --noEmit
bun run build:web
```

- [ ] **Step 6: Commit**

```
git add web/App.tsx web/HealthRoute.tsx web/styles.css
git commit -m "feat(client): wire #/health route with sidebar nav item"
```

---

## Chunk 4: Gates — tests + e2e

### Task 14: Full unit test suite gate

- [ ] **Step 1: Run full unit tests**

```
bun test
```

Expected: all pass including new `healthSummary` tests.

- [ ] **Step 2: TypeScript checks (both)**

```
bunx tsc --noEmit
bunx tsc -p web --noEmit
```

---

### Task 15: e2e spec for `#/health`

**Files:**
- Create: `tests/e2e/health.e2e.ts`

The e2e server uses `ZR_EVENTS_FILE=tests/e2e/fixtures/lib/.zr/events.jsonl`. Seed it with some `perf.*` and `anomaly.*` events before navigating to `#/health`, then assert the table rows appear.

- [ ] **Step 1: Write the spec**

```typescript
// tests/e2e/health.e2e.ts
import { test, expect } from "./helpers.ts";

test("health page loads and shows perf table", async ({ page }) => {
  // Seed some perf events via POST /api/events
  const now = Date.now();
  await page.request.post("/api/events", {
    data: {
      events: [
        { ts: now - 1000, type: "perf.route", ms: 120, path: "/api/lookup", status: 200 },
        { ts: now - 2000, type: "perf.route", ms: 800, path: "/api/lookup", status: 200 },
        { ts: now - 3000, type: "perf.gemini", ms: 600, op: "lookup" },
        { ts: now - 4000, type: "anomaly.anki_slow", ms: 4500 },
        { ts: now - 5000, type: "anomaly.whisper_warning", message: "coverage hole: 30s–60s", mediaId: "abc" },
      ],
    },
  });

  await page.goto("/#/health");

  // Perf stats table should have at least one row
  const table = page.locator(".health-table").first();
  await expect(table).toBeVisible();
  await expect(table.locator("tbody tr").first()).toBeVisible();

  // Should show perf.route or perf.gemini type
  const types = await page.locator(".health-table .health-type").allTextContents();
  const hasPerfType = types.some((t) => t.startsWith("perf."));
  expect(hasPerfType).toBe(true);
});

test("health page shows anomaly counts", async ({ page }) => {
  const now = Date.now();
  await page.request.post("/api/events", {
    data: {
      events: [
        { ts: now - 1000, type: "anomaly.anki_slow", ms: 5000 },
        { ts: now - 2000, type: "anomaly.anki_slow", ms: 6000 },
      ],
    },
  });

  await page.goto("/#/health");

  // Anomaly section should list anki_slow
  const sections = page.locator(".health-section");
  const anomalySection = sections.filter({ hasText: "anomalies" });
  await expect(anomalySection).toBeVisible();
  await expect(anomalySection.locator("tbody tr").first()).toBeVisible();
});

test("health page shows whisper warnings", async ({ page }) => {
  const now = Date.now();
  await page.request.post("/api/events", {
    data: {
      events: [
        { ts: now - 500, type: "anomaly.whisper_warning", message: "coverage hole: 45s–90s", mediaId: "xyz" },
      ],
    },
  });

  await page.goto("/#/health");

  const sections = page.locator(".health-section");
  const warnSection = sections.filter({ hasText: "whisper warnings" });
  await expect(warnSection).toBeVisible();
  await expect(warnSection.locator("td", { hasText: "coverage hole" })).toBeVisible();
});

test("health page shown in sidebar nav", async ({ page }) => {
  await page.goto("/#/");
  const healthNav = page.locator(".side-item", { hasText: "Health" });
  await expect(healthNav).toBeVisible();
  await healthNav.click();
  await expect(page).toHaveURL(/#\/health/);
});
```

- [ ] **Step 2: Run e2e tests**

```
bun run test:e2e
```

Expected: all existing tests pass + new `health.e2e.ts` passes.

- [ ] **Step 3: Final web build**

```
bun run build:web
```

- [ ] **Step 4: Commit**

```
git add tests/e2e/health.e2e.ts
git commit -m "test(e2e): #/health page spec with seeded perf/anomaly events"
```

---

## Gate Summary

Run these in order after all tasks are done:

```
bunx tsc --noEmit
bunx tsc -p web --noEmit
bun test
bun run build:web
bun run test:e2e
```

All should exit 0.

---

## Files Changed

| File | Change |
|---|---|
| `src/lib/telemetry.ts` | + `healthSummary`, `healthSummaryFromFile`, types |
| `src/server/index.ts` | + route timer wrapper, Gemini/Anki/Whisper/tokenize timings, `/api/health/summary` route |
| `web/telemetry.ts` | + `tmMark`, `tmMeasure`, `tmAnomaly` |
| `web/Player.tsx` | + cue fetch timing, lookup timing |
| `web/ankicache.ts` | + anki hydrate timing |
| `web/player/useWhisperJob.ts` | + SSE reconnect anomaly |
| `web/HealthRoute.tsx` | new — health debug view |
| `web/App.tsx` | + `health` route + sidebar item |
| `web/styles.css` | + `.health-*` styles |
| `tests/telemetry.test.ts` | + `healthSummary` unit tests |
| `tests/e2e/health.e2e.ts` | new — e2e spec |
