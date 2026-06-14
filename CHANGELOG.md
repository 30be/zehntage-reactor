# Changelog

Newest first. Grouped by shipped wave or named work batch.

---

## 2026-06-14 — Lemma vocab, Review mode, retention-decay, SRS heatmap

### Added

**Subtitles**
- Dual-language jimaku extraction: all 22 Hyouka episodes now have both JA (human) and RU sidecar subtitles sourced from jimaku.cc in one pass.
- `parseAss` strips interleaved Russian lines to yield clean Japanese-only tracks.

**Vocabulary**
- Lemma-based keying: clicking a conjugated form stores the dictionary lemma (`basic_form`), so all inflections (食べた, 食べる, 食べて…) highlight once a card exists.
- Homograph disambiguation: cards with a reading bracket (辛い[からい] vs 辛い[つらい]) are keyed and matched separately — a token's kuromoji reading vetos wrong-homograph matches.
- Retention-decay coloring: overdue deck words are tinted toward red, ramping with true days-overdue decoded server-side, saturating ~2 weeks past due. Non-overdue words are unaffected.
- Due-word jump (`d`): skips to the next cue containing a currently-due Anki word. "N due" HUD indicator.

**Seekbar SRS heatmap**
- Tick marks on the seekbar: neutral ticks for i+1 cues, accent-colored ticks for due-word cues, positioned by cue start / duration. Pointer-events-none; scrubbing unaffected.

**Review / Cram mode** (`#/review`)
- New sidebar route. Drills due Anki words as cloze prompts from your own watched cues — blank the target word, type the answer, Enter to check, Space/→ for next.
- Optional Russian hint per card; "watch in context" deep-link to source episode+timestamp.
- Falls back to interval order (most overdue first) when `is:due` is unavailable.

**Command palette deep actions**
- Player commands via Ctrl+K: autopause, cue sidebar, pre-study, quiz, HUD, echo, fullscreen; i+1/due-word jump; next/prev episode; open read mode; copy cue text; copy deep-link; generate JA subs; translate → RU; condensed audio.
- Global commands: navigate any route; toggle theme, furigana, pitch accent, autopause mode.

**Auto-backup snapshots**
- Server takes a portable JSON snapshot on startup (throttled: skipped if the most recent is < 6 hours old). Stored in `~/.local/share/zehntage-reactor/snapshots/`.
- `GET /api/snapshots` lists available snapshots; `POST /api/snapshots/restore` restores one; Settings page exposes a picker UI.

**Read mode**
- Word-lookup popup now shows the same "encounters: N" collapsible block as the player popup, with deep-links to each occurrence (player↔read parity).

**Global subtitle search** (`#/search`) — G1
- New sidebar route + Ctrl+K palette command ("search subtitles (jump to any line)").
- Queries `GET /api/search?q=…`; results grouped by episode.
- Keyboard nav: ↑/↓ move, Enter opens, Esc clears.
- Click or Enter deep-links into `#/play/<id>@<start>`.

**Known-words growth chart on Stats** — G2
- `GET /api/stats/growth` returns cumulative words-added-per-day.
- Rendered as a bar chart in `#/stats` ("Vocabulary growth" section).
- Each bar = total deck size on a day cards were added; tooltip shows `+N` for that day.

**SRS due-forecast histogram in Review mode** — G3
- Bar chart at the top of `#/review` showing upcoming review load for the next 14 days.
- Bucket 0 = due now/overdue (accented); buckets 1–14 = earliest-possible next-due by interval.
- Pure logic in `web/forecast.ts` (`FORECAST_WINDOW = 14`); reads `GET /api/anki/words` progress data.

**Immersion timer + daily minutes goal** — G4
- Session HUD (`o`) now shows focused watch time this session vs the daily minutes goal.
- Configure in Settings → "Daily immersion goal (minutes)" (default 30 min).
- Persisted to `localStorage` under key `zr.goal.minutesPerDay` (see `web/timer.ts`).
- Pure math helpers in `web/timer.ts`: `formatElapsed`, `minutesFraction`, `minutesGoalMet`.

### Fixed

- Homograph identity fix: `vocabKey` is distinct from the bare display lemma so conjugated-form clicks don't create a wrong-keyed card.
- Mega-sweep: Anki audio attachment, whisper snapshot handling, batch-add leak, `addNote` timeout.
- `contentTypeFor` returns a safe default for extensionless paths.
- Flaky timing-dependent e2e specs hardened with explicit waits.

### Internal

- Web decomposed: `App.tsx` → route files (`HomeRoute`, `LibraryRoute`, `CardsRoute`, `StatsRoute`, `SettingsRoute`, `ReviewRoute`, `ReadRoute`); `Player.tsx` → 8 focused hooks (`useWordState`, `useLookup`, `useActiveCues`, `useAutoNext`, `useEcho`, `useHotkeys`, `useSession`, `useSubControls`, …).
- Test suite: 1109 unit tests + ~160 Playwright e2e specs; all pass without real API keys.
- Dead CSS and unused `loadState` pruned.

---

## Wave 18 — Auto-quiz prompt + Home "today" panel

- End-of-episode auto-quiz affordance (`autoQuizPrompt` setting).
- Home panel: daily streak, words learned, minutes watched.
- Fix monochrome quiz/echo colors.
- Fix real `quiz.result` assertion in e2e.
- Guard `toggleQuiz` against double-fire.
- Fix Read resume/progress clamp off-by-one.
- Whisper: repeating-cycle dedup + `repairHole` loop cap (code only).

## Waves 16–17 — Curriculum planner + Read-mode cursor nav

- Home "study next" planner from curriculum module.
- Stats: comprehension trend chart.
- Read mode: cursor nav via `j`/`k`/arrows.
- Read mode: reading progress bar + resume affordance.
- Fix first-press cursor off-by-one.
- Multi-paragraph read fixture; e2e isolation improvements.

## Wave 15 — Comprehension quiz

- `q` key opens cloze/MC quiz from watched cues.
- Zero-Gemini: quiz generated locally, no API call.
- Quiz events logged to telemetry.
- Fix e2e seek setup; fix cross-test `zr.known` state leak.

## Wave 14 — Page polish

- System-wide `focus-visible` ring.
- Unified loading / empty / error state separation.
- Spinner utility component; `aria-label` pass.
- Health route: Activity icon.

## Wave 13 — Smart resume, session HUD, echo dictation

- `z` accepts smart-resume affordance.
- `o` toggles session HUD overlay (words/minutes).
- `e` toggles echo dictation mode.
- `j` jumps to next i+1 cue + command palette entry.

## Observability wave

- Per-route latency timings (p50/p95, slowest routes).
- Gemini / Anki / Whisper / tokenize timings.
- Client `performance.mark` breadcrumbs.
- Anomaly events; `#/health` debug view with anomaly counts.

## Refactor — Player split

- `Player.tsx` split into `web/player/` modules (3 520 → 2 395 lines).
- Deduplicate `kataToHira`, `isTextInput`, coverage loop.
- Prune dead mining routes and stale API contracts.

## Feedback wave

- `a` toggles Anki add/remove for popup word.
- `g` regenerates popup explanation (fresh Gemini call).
- Minimal popup UI — no buttons/frame.
- `p` toggles autopause.
- Remove hard mode.
- Tab fix: blur focused button before cue nav.
- Instant optimistic word coloring.
- Reading-aware deck matching.
- Stale-cache race fix.
- Sidebar `?` reveals translation blur.
- Literal-translation prompt variant.

## Whisper hardening

- Cap hallucination runs at 10 s.
- Detect + repair coverage holes with `-mc 0` re-pass.
- Fix CLI sidecar path to `subs/`.
- Warning SSE events for non-fatal issues.

## Wave 12 — Palette, cheatsheet, Read-mode Anki parity

- `Ctrl+K` command palette.
- `?` hotkey cheatsheet overlay.
- Read-mode Anki card parity with player.
- Sub-scale hotkeys (`Shift+-` / `Shift+=`).
- Retention-aware pre-study (i+1 / muddy words).
- Due-word highlighting in cue list.

## Hotfix

- Fix translation-off crash.
- Revert `?` to blurred captions + blur sidebar translations.
- Fix deck-load race, optimistic marks.
- Read e2e stability; contrast/shadow/scrollbar polish.

## Wave 11 — Layout-independent hotkeys + OKLCH word colors

- All letter hotkeys use `e.code` (physical key); works on non-Latin layouts.
- Relaxed `<select>`/`<button>` hotkey guard.
- OKLCH word coloring replaces underlines.

## Wave 10 — CC popover, Anki zehntage-only, hover translation

- Closed-caption popover.
- Anki filter: zehntage-only cards.
- Hover-translation tooltip.
- Fullscreen sidebar.
- `r` replays current cue.
- `explain` prompt setting.
- Anki cache stitch.

---

*Waves 1–9 established the core player, library, whisper queue, Anki integration,
frequency list, Read mode, stats, pre-study, pitch accent, and the Playwright
e2e harness. See git log for full detail.*
