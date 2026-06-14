# Architecture

`zehntage-reactor` is a local "Language Reactor for anime" for learning
Japanese: it serves your media library in the browser, plays episodes with
dual-language subtitles, colors every word by how well you know it (from your
Anki deck), and lets you mine cards in-flow. Everything runs on your own
machine against a local media directory; no hosted backend.

## Overview / stack

- Runtime: **Bun** (server, build, tests). Language: **TypeScript** throughout.
- Frontend: **React 19** (`web/`), bundled to a static `public/` bundle.
- Tokenizer: **@sglkc/kuromoji** (IPADIC) — used server-side
  (`src/lib/tokenindex.ts`) and in the browser (`web/tokenizer.ts`).
- Icons: `lucide-react`.
- How it runs: `src/cli.ts` is the entrypoint.
  - `zehntage-reactor [<file|dir>]` — starts the player server (default port
    `8417`, override with `PORT`) and opens the browser via `xdg-open`
    (skip with `ZR_NO_OPEN=1`). With no arg the root falls back to
    `settings.mediaRoot`, then cwd.
  - `subtitle <lang> [<lang2>] <file>` — headless whisper transcription
    (+ optional Gemini translation) writing sidecars.
  - `backup [<dir>]` / `backups` — create / list backup archives.
- Web bundle: `scripts/build-web.ts` runs `Bun.build` over `web/main.tsx` →
  `public/app.js` + `public/app.css`, and copies the kuromoji dict into
  `public/dict/` (gzipped `.dat.gz`, gunzipped by the browser loader). Run via
  `bun run build:web`. `scripts/check-web.ts` validates the bundle.

## Server

`src/server/index.ts` exports `startServer(root, port)` and contains a single
`Bun.serve` request handler — a long if/else chain matching method + path. It
serves the `public/` static bundle for non-`/api/` GETs (`/app.js` and
`/app.css` are sent no-cache), and `index.html` at `/`.

### Route groups (verified against the source)

- **library**: `GET /api/library`, `GET /api/browse`, `GET|POST /api/root`.
- **media / export**: `GET <media>` (range-aware), `GET <mediaInfo>`,
  `GET <exportFrame>`, `GET <exportClip>`, and condensed-audio
  (`POST <condenseStart>`, `GET <condensedGet>`).
- **subs**: `GET <subsList>`, `GET <subsCues>`.
- **whisper**: `POST <whisperStart>`, `GET /api/whisper/active`,
  `GET <whisperEvents>` (SSE stream), `POST <whisperCancel>`.
- **batch**: `POST /api/batch/all`, `POST <batchAllOne>`,
  `POST /api/batch/subtitle`, `POST /api/batch/translate`,
  `GET /api/batch/status`.
- **translate / gemini**: `POST <retranslate>`, `POST <translate>`,
  `POST /api/explain`, `POST /api/ask`, `POST /api/lookup`.
- **anki**: `GET /api/anki/words`, `GET /api/anki/cards`, `GET <ankiMedia>`,
  `POST /api/anki/add`, `POST /api/anki/delete`.
- **stats**: `/api/stats/summary`, `/episodes`, `/episodes.csv`, `/overview`,
  `/growth`, `/comprehension`, `/today` (all GET).
- **word / index (mining)**: `GET /api/word/history`,
  `GET /api/index/encounters`, `GET|POST /api/index/comprehensibility`,
  `POST /api/index/due`, `GET /api/index/showfreq`.
- **review**: `GET /api/review/due`.
- **state**: `GET|POST /api/state` (localStorage sync).
- **jimaku**: `GET /api/jimaku/search`, `GET /api/jimaku/files`,
  `POST /api/jimaku/download`.
- **export / import / snapshots**: `GET /api/export`, `POST /api/import`,
  `GET /api/snapshots`, `POST /api/snapshots/restore`.
- **settings**: `GET|POST /api/settings`.
- **telemetry**: `POST /api/events`.
- **health**: `GET /api/health/summary`.

### lib modules (`src/lib/*`)

- **subs.ts** — subtitle parse (SRT/VTT/ASS) + embedded-track extraction via
  ffmpeg. `parseAss` strips ASS styling; a dual-language detector keeps only
  the JP-styled lines when an `.ass` mixes JP with another language
  (e.g. JP+CN). `Cue` = `{ start, end, text }`; `SubTrack` describes embedded
  vs sidecar tracks with `origin` (generated vs external).
- **jimaku.ts** — jimaku.cc API client (subtitle directory for anime). Searches
  by AniList/TMDB/anime name, lists files, downloads. Auth: raw
  `JIMAKU_API_KEY` in the `Authorization` header. Key read from env then
  `~/.env` (same loader as Gemini, `env.ts`).
- **whisper.ts** — single-at-a-time `whisper-cli` job queue with progressive
  segment events, writes sidecar SRT. Model resolution: `$WHISPER_MODEL` →
  `~/models/ggml-large-v3.bin` → `~/models/ggml-medium.bin`.
- **gemini.ts** — translation, sentence-explain, word-lookup, and
  whisper-name-correction prompts. `GEMINI_FAKE=1` returns canned fixtures with
  REAL readings from the server tokenizer (so deck matching behaves in e2e).
- **tokenindex.ts** — per-library-entry lemma index built with kuromoji on the
  server. In-memory mtime-keyed cache; `INDEX_VERSION` ("v2-homograph") folds
  into the cache key so a key-shape change invalidates stale entries across a
  hot reload.
- **coverage.ts** / **mining.ts** — mining queries over the per-entry indexes.
  `showFrequency()` sums lemma occurrences across entries (backs
  `/api/index/showfreq`); the client-side i+1/prestudy ranking lives in
  `web/prestudy.ts`.
- **anki.ts** — proxy to the anki-mcp `/zehntage/*` endpoints, with a preferred
  local AnkiConnect path. `ANKI_FAKE=1` uses an in-memory card map. `tags`
  includes `zehntage` to mark mined cards; `image` accepts data URI / URL /
  upload-dir path.
- **telemetry.ts** — append-only JSONL event log at
  `~/.local/share/zehntage-reactor/events.jsonl` (override `ZR_EVENTS_FILE`),
  parsed on demand by `summarizeEvents()`.
- **backup.ts** — tar.gz of `manifest.json` + `events.jsonl` + `config/` +
  every `subs/` dir. Restore puts back ONLY events + config (subs are
  deliberately not auto-restored). Rotation keeps newest N. `configDirPath()`
  resolves `ZR_CONFIG_DIR` → `~/.config/zehntage-reactor`.
- **media.ts** — range-aware media serving + ffprobe codec/duration checks
  (`mediaDurationSec` backs the jimaku coverage/sync gate).
- **episode.ts** — pure best-effort episode-number parsing from a filename;
  shared by the web JimakuFind UI and the server's jimaku auto-fetch.
- **jatok.ts** — pure server-side JP token helpers: `mergeTokens`, `isLexical`,
  `lemmaOf`, `kataToHira`, `vocabKey`.
- Supporting: **library.ts** (scan/`LibraryEntry`/sidecar discovery),
  **state.ts** (localStorage sync persistence), **settings.ts**,
  **datatransfer.ts** (portable JSON export/import bundle), **glossary.ts**
  (Hyouka proper-noun glossary + per-folder `names.txt` for name correction),
  **env.ts** (`~/.env` secret loader), **accent.ts** (pitch-accent data).

### Key invariants

- **vocabKey** (`src/lib/jatok.ts` `vocabKey`) MUST stay byte-identical in logic
  with `web/tokenizer.ts`'s copy — server index keys and browser keys would
  diverge otherwise. Shape:
  - inflecting POS (動詞/形容詞/助動詞): `${lemma}|${pos}` (reading dropped so
    conjugations collapse);
  - else reading present: `${lemma}|${hira(reading)}|${pos}` (homograph
    discriminator, e.g. 生 なま vs せい);
  - else (OOV / no reading): bare `${lemma}`.
- **SWR caches + generation guards**: tokenindex uses an mtime-keyed cache with
  a version-stamped key; whisper jobs and SSE streams are guarded so stale
  generations cannot serve into a newer load.
- **Secrets only in `~/.env`** (Gemini, jimaku keys), never committed; loaded by
  `env.ts`. `*_FAKE` env vars replace each external service in e2e.

## Client (`web/`)

`web/main.tsx` mounts `App`. **App.tsx** is the shell + hash router
(`#/`, `#/play/<id>[@t]`, `#/read/<id>`, `#/settings`, `#/stats`, `#/search`,
`#/cards`, `#/review`, `#/home`, `#/health`) and renders one route component:

- **HomeRoute.tsx** (`Home`) — dashboard: continue-watching, daily goal ring,
  word-of-the-day.
- **LibraryRoute.tsx** (`Library`) — library grid, jimaku find, batch ops.
- **Player.tsx** (`PlayerRoute` → `Player`) — the video player; composed of the
  hooks below.
- **ReadRoute.tsx** — text/transcript reading mode (`Read.tsx`).
- **CardsRoute.tsx** (`Cards`) — Anki deck browser/filter.
- **StatsRoute.tsx** (`Stats`) — analytics.
- **SettingsRoute.tsx** (`Settings`), **HealthRoute.tsx**,
  **ReviewRoute.tsx** (`Review`), **SearchRoute.tsx** (`Search`).

### Player hook decomposition (`web/player/`)

Player.tsx was decomposed into focused hooks (extracted verbatim, no behavior
change). Several refs stay owned by Player and are passed in/out so all
collaborators mutate the SAME instances.

- **useActiveCues** — `timeupdate` loop deriving active primary (subOffset-
  adjusted) + secondary cue indices; also drives entangled per-cue behaviors
  (shadowing loop, smart/echo autopause).
- **useWordState** — deck/known-word state machine: builds `wordIndex` +
  `knownFronts` from the live deck plus an optimistic-front overlay; powers
  TokenLine coloring. Holds `deckCardsRef` (front → card) so existing cards
  fill without a Gemini call.
- **useLookup** — word-lookup popup: state, per-surface cache, in-flight de-dup;
  fills from an existing deck card or fetches (cached) on a word popup.
- **useSession** — session counters (refs) + session HUD state.
- **useAutoNext** — end-of-episode auto-advance: optional comprehension quiz,
  session summary, 5s countdown to next episode (cancel on any input).
- **useResume** — auto-resume vs deep-link `@t` three-flag handshake
  (`startAtRef`, `hasDeepLinkRef`, …) so the decision is handler-order
  independent.
- **useEcho** — echo dictation mode (`e`): owns echo state/refs and Tab replay.
- **useHoverPause** — pause while a word popup / secondary subtitle is being
  read; resumes only if WE paused.
- Others in the dir: `useHotkeys`, `useSubControls`, `useWhisperJob`,
  `useHudAutohide`, plus overlay components (`SubOverlay`, `LookupPanel`,
  `QuizPanel`, `PreStudyPanel`, `EchoOverlay`, `Encounters`, `SessionHud`,
  `SessionSummary`, `JobProgressBar`, `Vbar`) and pure helpers (`shared.ts`,
  `autopause.ts`, `resume.ts`, `cueUnknowns.ts`, `skipGap.ts`).

### Pure modules

DOM-free, network-free, fully unit-tested:
`progress` (deck→color), `tokenizer` (kuromoji wrapper + the mirrored
`vocabKey`/`mergeTokens`/`lemmaOf`/`isLexical`/`kataToHira`), `coverage`,
`quiz`, `forecast`, `goal`, `timer`, `searchquery`, `wordday`, `cardfilter`,
`iplusone`, `prestudy`, `review`. Plus `freq`, `accent`, `heat`, `dictation`,
`curriculum`, `readProgress`, `readlayout`, `statsfmt`, `ankicache`,
`continueWatching`, `sync`, `blacklist`, `vocabreset`, `commands`, `lang`,
`keys`, `cues`, `telemetry`.

### Coloring pipeline

1. **tokenize** the cue text with kuromoji (`web/tokenizer.ts`).
2. compute each lexical token's **vocabKey** (homograph-aware; identical logic
   to `src/lib/jatok.ts`); `TokenLine.wordKey` wraps it for the local
   known-set / blacklist / coverage.
3. look up the key in the **wordIndex** (built by `web/progress.ts`
   `buildWordIndex` from the live Anki deck; `matchFront` is reading-aware).
4. **TokenLine** colors: known/blacklisted → plain ambient text; unknown
   (not in deck) → muted red `.tok.unk`; in-deck → blue fading toward ambient
   as the SRS interval grows (OKLCH interpolation, ambient at ≥21d).
5. **retention decay** (`progress.ts` `decayFactor`/color): an overdue card's
   color is dragged back toward "unknown" by how far overdue it is
   (last-review + interval vs now); non-overdue / no-progress words never decay.

### Mining flow

Word popup → `useLookup` fills from the existing deck card or calls
`POST /api/lookup` (Gemini, cached/de-duped). Adding a card hits
`POST /api/anki/add` (tagged `zehntage`); `useWordState` applies an optimistic
front overlay so the token recolors instantly before the deck cache refreshes.
The encounter/comprehensibility indexes (`/api/index/*`) and `web/prestudy.ts`
rank i+1 sentences for pre-study.

## Data & storage

### Browser localStorage (`zr.*`)

- `zr.known` — local known-word set (vocabKeys).
- `zr.blacklist` — words to leave uncolored.
- `zr.cov.*` / `zr.cov.v4.*` — per-episode coverage cache.
- `zr.theme`, `zr.sidebar`, `zr.autopause`, `zr.read.secondary`.
- `zr.goal.cardsPerDay`, `zr.goal.minutesPerDay`.
- `zr.lastMedia`, `zr.ankiCache`, `zr.wordday.pick`, `zr.prestudyFrames`,
  `zr.vocabKeyVersion`.
- Per-id/template keys: `zr.tracks.<id>`, `zr.read.pos.*`, `zr.pos.<id>`,
  `zr.posAt.<id>`, `zr.offset.<id>.<...>`.

These sync to the server via `web/sync.ts` → `POST /api/state` (only changed
keys; server does last-write-wins merge per key, ties favor remote).

### Server files

- Config: `~/.config/zehntage-reactor/` (`settings.json`, `state.json`) —
  override with `ZR_CONFIG_DIR`.
- Telemetry: `~/.local/share/zehntage-reactor/events.jsonl` — override
  `ZR_EVENTS_FILE`.
- Backups: `~/.local/share/zehntage-reactor/backups/`.

### Subtitle sidecar layout

Auto-generated sidecars live under a `subs/` dir next to the video:
`subs/<base>.ja.srt` (whisper), `subs/<base>.ja.ass` (styled, when present),
`subs/<base>.ru.srt` (Gemini translation), and `subs/<base>.condensed.mp3`
(condensed audio). Files under `subs/` are `origin=generated`; sidecars
elsewhere are `origin=external`. (Note: `.ru` is the user's configured known
language; the translation lang comes from settings, not hard-coded to Russian.)

## Testing

- **Unit** (`bun test`): the `tests/*.test.ts` suite covers lib modules and the
  pure web modules directly (DOM-free). Run `bun test`.
- **E2E** (`bun run test:e2e`, Playwright): `playwright.config.ts` boots the
  real server on port **8499** against `tests/e2e/fixtures/lib`, with all
  external services faked: `GEMINI_FAKE=1`, `WHISPER_FAKE=1`, `ANKI_FAKE=1`,
  plus `ZR_NO_OPEN=1` and isolated `ZR_EVENTS_FILE` / `ZR_CONFIG_DIR` under the
  fixtures dir (recreated by `tests/e2e/global-setup.ts` each run). Specs live
  in `tests/e2e/*.e2e.ts`.

## Directory map

- `src/cli.ts` — CLI entrypoint (server / subtitle / backup).
- `src/server/index.ts` — single Bun.serve handler, all routes.
- `src/lib/` — server logic (subs, jimaku, whisper, gemini, tokenindex,
  coverage, mining, anki, telemetry, backup, media, episode, jatok, library,
  state, settings, datatransfer, glossary, env, accent).
- `web/` — React frontend: `main.tsx`, `App.tsx`, `*Route.tsx`, `Player.tsx`,
  `web/player/` (hooks + overlays), and the pure modules.
- `public/` — built bundle (`app.js`, `app.css`, `dict/`).
- `scripts/` — `build-web.ts`, `check-web.ts`, `smoke.ts`, `gen-freq.ts`,
  `gen-accent.ts`, `screenshots.ts`.
- `tests/` — `*.test.ts` (bun) and `tests/e2e/` (Playwright).
