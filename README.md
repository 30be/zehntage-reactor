# 十日 zehntage-reactor

The minimalist local player that turns anime into your Anki deck.

![screenshot placeholder](docs/screenshot.png)

## Features

- Whisper subtitle generation for raw video, streamed live while transcribing,
  with anti-hallucination cleanup (repeated-cue runs on music/silence collapsed)
- Gemini word and sentence lookups: hover/click a word for reading + notes,
  sentence explanations, AI translation into a synced secondary (blurred) line
- Anki integration: local AnkiConnect when reachable, remote fallback otherwise;
  one-click cards with video frame and sentence audio
- Word coloring by Anki interval: new words highlighted, learning words fade
  from blue to ambient as the SRS interval grows; furigana on unknown kanji
- Pre-study mode: bulk-add the unknown words of the upcoming minutes
- Shadowing loops, per-cue replay, smart autopause on lines with unknown words
- Comprehension quiz (`q`) over the cues you just watched; at the end of an
  episode a quiet "comprehension check? (q)" prompt appears (toggle in
  Settings → Player behavior → "End-of-episode comprehension prompt")
- Difficulty heat strip on the seek bar
- Read mode: full transcripts with the same lookups and hotkeys
- Stats: activity grid, watch time, mining pace, per-episode coverage
- Home "Today" panel: words mined, cues watched, minutes, quizzes, daily streak
- jimaku.cc subtitle search
- Deep links: `#/play/<id>@<seconds>` jumps straight into an episode

## Quickstart

```sh
bun install
bun run src/cli.ts /path/to/media/dir   # serves http://localhost:8417
```

Keys go in `~/.env` (names only — never commit values):

- `GEMINI_API_KEY` — lookups, explanations, translation
- `ZEHNTAGE_ANKI_URL` / `ZEHNTAGE_ANKI_KEY` — remote Anki fallback
- `JIMAKU_API_KEY` — jimaku.cc subtitle search
- `ANKICONNECT_URL` — optional, defaults to local AnkiConnect

Subtitle generation needs `ffmpeg` and `whisper-cli`. Other CLI modes:
`subtitle <lang> [<lang2>] <file>`, `backup [<dir>]`, `backups`.

## Hotkeys

Bindings match physical keys (`e.code`), so they work on any layout.
`?` in the app shows the full cheatsheet, grouped by scope
(player / read / global) so dual-scope keys like `j` and `k` stay unambiguous.

Player scope:

| keys | action |
| --- | --- |
| space / f | play–pause / fullscreen |
| ← → / ↑ ↓ | seek ±5s / volume |
| Tab / Shift+Tab | next / previous cue |
| r / s | replay cue / shadowing loop |
| a / g | Anki add–remove popup word / regenerate |
| , . | frame step back / forward |
| - = / Shift+- = | speed / subtitle size |
| [ ] \\ | subtitle offset − / + / reset |
| Shift+← → | previous / next episode |
| p | autopause |
| l / w | cue sidebar / pre-study panel |
| q | comprehension quiz (watched cues) |
| b / bb | peek translation / toggle blur |
| i | picture-in-picture |
| k / x | mark word known / blacklist |
| o | session HUD overlay |
| e | echo dictation mode |
| j | jump to next i+1 cue |
| z | accept resume affordance |

Read scope:

| keys | action |
| --- | --- |
| j / ↓ | next line |
| k / ↑ | prev line |
| Enter | open word popup on cursor line |

Global scope:

| keys | action |
| --- | --- |
| Ctrl+K / ? / Esc | palette / cheatsheet / close |

## Architecture

- Bun server (`src/server/index.ts`) + React SPA (`web/`), hash routing
- Sidecar subtitles: `subs/<base>.<lang>.srt` next to each video
- Config + synced `zr.*` state: `~/.config/zehntage-reactor`
  (override with `ZR_CONFIG_DIR`)
- Telemetry and backups: `~/.local/share/zehntage-reactor`
- Pure logic lives in `src/lib/` and `web/*.ts`, bun-testable without DOM

## Data export & import

Settings → `~/.config/zehntage-reactor/settings.json`. Synced state
(known words, blacklist, resume/reading positions) →
`~/.config/zehntage-reactor/state.json`. Telemetry →
`~/.local/share/zehntage-reactor/events.jsonl`.

The Settings page has **Export data (JSON)** (downloads a
`{ version, exportedAt, settings, state, events }` bundle) and
**Import data (JSON)** (merges settings + state via last-write-wins;
events are skipped by default). Endpoints: `GET /api/export`,
`POST /api/import`.

## Development

Gates before shipping:

```sh
bunx tsc --noEmit
bun test
bun run build:web
bun run test:e2e
```

E2E (Playwright) runs against port 8499 with `GEMINI_FAKE=1`,
`WHISPER_FAKE=1`, `ANKI_FAKE=1` — no real keys or Anki needed.

## Attribution

- Pitch accent data: [Kanjium](https://github.com/mifunetoshiro/kanjium) (Uros O.), CC BY-SA 4.0
- Word frequency list: Leeds corpus, CC BY
- Icons: [Lucide](https://lucide.dev), ISC
