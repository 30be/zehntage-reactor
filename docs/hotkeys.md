# Hotkeys

Source of truth: `web/commands.ts` (`HOTKEYS` array) and
`web/player/useHotkeys.ts`.

## Layout independence

Letter keys (`a`, `b`, `e`, `f`, `g`, `i`, `j`, `k`, `l`, `o`, `p`, `q`,
`r`, `s`, `w`, `x`) are bound to `e.code` (physical key position), not
`e.key`. This means they work unchanged on Russian, German, and other
non-Latin keyboard layouts. Symbol keys, arrows, Space, and Tab are bound to
`e.key` (layout-correct for those characters).

## Player hotkeys

| Keys | Action |
|------|--------|
| `Space` | play / pause |
| `f` | fullscreen |
| `← →` | seek −5 s / +5 s |
| `↑ ↓` | volume up / down |
| `Tab` / `Shift+Tab` | next / previous cue |
| `r` | replay current cue |
| `s` | shadowing loop on/off |
| `, / .` | frame step back / forward |
| `- / =` | playback speed (cycles 0.5–1.5×) |
| `Shift+- / Shift+=` | subtitle size |
| `[ / ] / \` | subtitle offset − / + / reset |
| `Shift+← / Shift+→` | previous / next episode |
| `p` | toggle autopause |
| `l` | cue-list sidebar |
| `w` | pre-study panel (upcoming words) |
| `q` | comprehension quiz (watched cues) |
| `b` | hold = peek translation; double-press = toggle blur |
| `i` | picture-in-picture |
| `k` | mark hovered/popup word known |
| `x` | blacklist hovered/popup word |
| `a` | add/remove popup word in Anki |
| `g` | regenerate popup explanation |
| `o` | session HUD overlay |
| `e` | echo dictation mode |
| `j` | jump to next i+1 cue |
| `z` | accept resume affordance |

### Notes

- `r` tapped within 0.3 s of a cue start steps back to the previous cue;
  repeated presses walk backward cue by cue.
- `s` a second time releases the shadowing loop. Shadowing repeat count is
  set in Settings; 0 = infinite.
- `b` hold shows secondary translation while held; keyup re-blurs. Window
  blur (alt-tab) also re-blurs. Double-press within 350 ms toggles blur
  permanently for the session.
- `Tab` closes an open popup before navigating cues; it also releases a
  shadowing loop.
- `Shift+←/→` (episode nav) works even when a `<select>` or `<button>` is
  focused — unlike plain arrows, which are passed to the element.

## Global hotkeys (all routes)

| Keys | Action |
|------|--------|
| `j / ↓` | next line (read mode) |
| `k / ↑` | prev line (read mode) |
| `Enter` | open word popup on cursor line |
| `Esc` | close popups / panels |
| `Ctrl+K` | command palette |
| `?` | hotkey cheatsheet overlay |

## Guards

Hotkeys are suppressed when:

- A modal overlay (palette / cheatsheet) is open — it owns the keyboard.
- `e.ctrlKey`, `e.metaKey`, or `e.altKey` is set (browser combos).
- The active element or event target is a real text input (native behavior
  preserved; the cloze answer field in the quiz is protected this way).
- The quiz overlay is open — its own capture handler handles number/arrow/
  Enter/Esc; only `q` falls through (to close the quiz).
