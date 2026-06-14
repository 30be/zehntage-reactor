# Architecture

## Overview

zehntage-reactor is a single-binary Bun server + React SPA for immersion-based
Japanese study. The server (port 8417 by default) streams video, manages sidecar
subtitles, proxies Anki, and runs Whisper transcription. The SPA is served as a
static bundle from `public/`.

---

## Server (`src/`)

### Entry points

- `src/cli.ts` — CLI: `zehntage-reactor [file|dir]`, `subtitle`, `backup`, `backups`.
- `src/server/index.ts` — `Bun.serve` handler; all routes live here.

### Route groups

| Prefix | Purpose |
|--------|---------|
| `/api/library` | list/scan episodes |
| `/api/subs/*` | list tracks, cue JSON |
| `/api/whisper/*` | start/cancel/SSE events |
| `/api/batch/*` | bulk sub+translate |
| `/api/translate`, `/api/lookup`, `/api/explain`, `/api/ask` | Gemini NLP |
| `/api/anki/*` | words, cards, add, delete, media proxy |
| `/api/state` GET/POST | zr.* localStorage sync |
| `/api/settings` GET/POST | settings.json CRUD |
| `/api/events` POST | telemetry ingest |
| `/api/stats/*` | summary, episodes, episodes.csv, overview, growth, comprehension, today |
| `/api/index/*` | token index: encounters, comprehensibility, due, showfreq |
| `/api/root` GET/POST | media root hot-swap |
| `/api/jimaku/*` | subtitle search/download |
| `/api/health/summary` | perf + anomaly data |

Static files (`public/`) are served for all non-`/api/` GET requests (SPA
fallback).

### Whisper queue (`src/lib/whisper.ts`)

One job at a time; spawns `whisper-cli`. Progressive `[hh:mm:ss --> hh:mm:ss]`
lines are parsed and streamed as SSE `WhisperEvent`s. Post-processing:

- Hallucination runs capped at 10 s.
- Repeating-cycle dedup.
- Coverage-hole detection + `-mc 0` re-pass (up to one repair loop).
- Warns via SSE on non-fatal problems.

Model path: `$WHISPER_MODEL` → `~/models/ggml-large-v3.bin` (primary) → `~/models/ggml-medium.bin` (fallback). Threads: 12.

### Anki layer (`src/lib/anki.ts`)

Prefers local AnkiConnect (`http://127.0.0.1:8765`). Probe TTL = 60 s,
timeout = 300 ms. Falls back to remote anki-mcp endpoint. Deck: `Mixed`,
model: `Back+Front+Usage`. Card format: JP front / RU back / screenshot image
/ `[sound:...]` audio field. `ANKI_FAKE=1` for e2e.

### Telemetry (`src/lib/telemetry.ts`)

Append-only JSONL at `~/.local/share/zehntage-reactor/events.jsonl`
(override: `ZR_EVENTS_FILE`). One JSON object per line:
`{ ts, type, mediaId?, ... }`. Client pushes via POST `/api/events`.
Summaries computed on demand (no background aggregation).

### State sync (`src/lib/state.ts` + `web/sync.ts`)

Last-write-wins per key. Shape:

```
{ "zr.known": { v: "[...]", ts: 1718000000000 }, ... }
```

- `GET /api/state` → full `ZrState`.
- `POST /api/state` ← partial changed keys → merged full state.
- Client (`web/sync.ts`) monkey-patches `localStorage.setItem/removeItem`;
  debounces pushes 2 s. Pull on startup applies newer remote keys locally.

---

## Storage layout

```
~/.config/zehntage-reactor/
  settings.json      # UI prefs (targetLang, knownLang, blurSecondary, …)
  state.json         # zr.* LWW sync store

~/.local/share/zehntage-reactor/
  events.jsonl       # telemetry log

<mediaDir>/
  Episode.mkv
  subs/
    Episode.ja.srt   # whisper sidecar
    Episode.ru.srt   # translation sidecar
```

`ZR_CONFIG_DIR` overrides the config dir (used by tests).
`ZR_EVENTS_FILE` overrides the events path.

---

## React SPA (`web/`)

### App shell (`web/App.tsx`)

Hash-based router. Routes: `library | player | read | settings | stats | cards |
home | health | review | search`. Holds global state: known words, blacklist, Anki word cache,
coverage, frequency list. Starts `sync.ts` on mount.

### Player (`web/Player.tsx` + `web/player/`)

Split into modules:

- `useHotkeys.ts` — capture-phase keydown handler (see hotkeys.md).
- `useWhisperJob.ts` — SSE subscription for live transcription.
- `LookupPanel.tsx` — word popup (Gemini lookup, Anki toggle).
- `PreStudyPanel.tsx` — upcoming-word pre-study panel (`w`).
- `QuizPanel.tsx` — comprehension quiz (`q`).
- `Vbar.tsx` — density seek bar with difficulty heat.
- `shared.ts` — shared player types.

### Other routes

- `web/ReadRoute.tsx` / `web/Read.tsx` — sentence-by-sentence read mode;
  cursor nav (`j`/`k`), word popup, Anki parity, resume affordance.
- `web/HealthRoute.tsx` — p50/p95 per route, slowest routes, anomaly counts.
- `web/Palette.tsx` — `Ctrl+K` command palette.
- `web/Sidebar.tsx` — cue-list sidebar with click-to-seek.

### Key frontend modules

- `web/commands.ts` — command registry + `HOTKEYS` cheatsheet (single source).
- `web/sync.ts` — localStorage ↔ server LWW sync.
- `web/telemetry.ts` — client-side event helpers + `performance.mark`.
- `web/tokenizer.ts` — kuromoji wrapper; `kataToHira`, token cache.
- `web/coverage.ts` — known-word coverage computation.
- `web/iplusone.ts` — i+1 cue finder (one unknown word).
- `web/heat.ts` — difficulty heat map data.
- `web/freq.ts` — 30k Leeds frequency list loader.

---

## Test / gate strategy

```
tsc (src/)       type-check server code
tsc (web/)       type-check SPA
bun test         unit tests in tests/*.test.ts
build:web        Bun bundler smoke-check
playwright e2e   tests/e2e/*.e2e.ts on port 8499
                 fake Gemini / Whisper / Anki (ANKI_FAKE=1, stub processes)
```

E2e fixtures live in `tests/e2e/fixtures/`. Global setup starts the server
once per run. Each wave has a dedicated e2e file.
