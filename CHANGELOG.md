# Changelog

Newest first. Grouped by shipped wave or named work batch.

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
