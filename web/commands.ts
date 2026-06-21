// Command-palette registry (pure, DOM-free — bun-testable) + the hotkey
// cheatsheet data (single source for the `?` overlay and the Home page grid).

export interface Command {
  id: string;
  title: string;
  /** hotkey label rendered as a kbd hint */
  hint?: string;
  /** context filter — command is hidden when it returns false */
  when?: () => boolean;
  run: () => void;
}

const dynamic = new Map<string, Command[]>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

/** Register a scope's commands; returns the unregister cleanup. */
export function registerCommands(scope: string, cmds: Command[]): () => void {
  dynamic.set(scope, cmds);
  notify();
  return () => {
    if (dynamic.get(scope) === cmds) {
      dynamic.delete(scope);
      notify();
    }
  };
}

/** All registered commands whose `when()` (if any) passes. */
export function allCommands(): Command[] {
  const out: Command[] = [];
  for (const cmds of dynamic.values()) {
    for (const c of cmds) {
      if (c.when && !c.when()) continue;
      out.push(c);
    }
  }
  return out;
}

/** Re-render hook for the palette (registration churn while it is open). */
export function onCommandsChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Case-insensitive substring filter over titles. */
export function filterCommands(cmds: Command[], query: string): Command[] {
  const q = query.trim().toLowerCase();
  if (!q) return cmds;
  return cmds.filter((c) => c.title.toLowerCase().includes(q));
}

// --- hotkey cheatsheet (single source: `?` overlay + Home page) ---

export interface HotkeyRow {
  keys: string;
  what: string;
  /** Which input mode owns the key. `player` and `read` can reuse the same
   *  physical key (e.g. j / k) with different meanings — the scope is what
   *  disambiguates them in the cheatsheet. */
  scope: "player" | "read" | "global" | "review";
  /** Optional fuller explanation, surfaced as the row's hover tooltip.
   *  Falls back to `what` when absent. */
  hint?: string;
}

export const HOTKEYS: HotkeyRow[] = [
  { keys: "space", what: "play / pause", scope: "player" },
  { keys: "f", what: "fullscreen", scope: "player", hint: "Toggle fullscreen video." },
  {
    keys: "← →",
    what: "seek −5s / +5s",
    scope: "player",
    hint: "Jump the playhead back or forward five seconds.",
  },
  { keys: "↑ ↓", what: "volume", scope: "player", hint: "Raise or lower the volume." },
  {
    keys: "Tab / Shift+Tab",
    what: "next / previous cue",
    scope: "player",
    hint: "Skip to the start of the next or previous subtitle cue.",
  },
  {
    keys: "r",
    what: "replay current cue",
    scope: "player",
    hint: "Seek back to the start of the current cue and play it again.",
  },
  {
    keys: "a",
    what: "add/remove popup word in Anki",
    scope: "player",
    hint: "Toggle the word in the open popup as an Anki card.",
  },
  {
    keys: "g",
    what: "regenerate popup explanation",
    scope: "player",
    hint: "Ask the model for a fresh explanation of the popup word.",
  },
  {
    keys: "s",
    what: "shadowing loop current cue",
    scope: "player",
    hint: "Loop the current cue on repeat for speaking practice.",
  },
  {
    keys: ", / .",
    what: "frame step back / forward",
    scope: "player",
    hint: "Nudge the paused video one frame at a time.",
  },
  {
    keys: "- / =",
    what: "playback speed",
    scope: "player",
    hint: "Slow down or speed up playback.",
  },
  {
    keys: "Shift+- / Shift+=",
    what: "subtitle size",
    scope: "player",
    hint: "Shrink or enlarge the on-screen subtitle text.",
  },
  {
    keys: "[ / ] / \\",
    what: "subtitle offset − / + / reset",
    scope: "player",
    hint: "Shift subtitle timing earlier or later; backslash resets it.",
  },
  {
    keys: "Shift+← / Shift+→",
    what: "previous / next episode",
    scope: "player",
    hint: "Load the previous or next episode in the series.",
  },
  {
    keys: "p",
    what: "toggle autopause",
    scope: "player",
    hint: "Auto-pause at the end of each cue (or only on unknown words).",
  },
  {
    keys: "l",
    what: "cue-list sidebar",
    scope: "player",
    hint: "Open the scrollable list of every subtitle cue.",
  },
  {
    keys: "w",
    what: "pre-study panel (upcoming words)",
    scope: "player",
    hint: "Preview new words coming up in the next cues.",
  },
  {
    keys: "q",
    what: "comprehension quiz (watched cues)",
    scope: "player",
    hint: "Quiz yourself on the cues you have already watched.",
  },
  {
    keys: "b (hold)",
    what: "peek secondary line while held",
    scope: "player",
    hint: "Hold to reveal the blurred secondary subtitle line; release to hide.",
  },
  {
    keys: "b b",
    what: "toggle secondary blur for session",
    scope: "player",
    hint: "Double-tap to keep the secondary line blurred or shown all session.",
  },
  {
    keys: "i",
    what: "picture-in-picture",
    scope: "player",
    hint: "Pop the video out into a floating picture-in-picture window.",
  },
  {
    keys: "k",
    what: "mark hovered word known",
    scope: "player",
    hint: "Mark the word under the cursor as already known.",
  },
  {
    keys: "x",
    what: "blacklist hovered word",
    scope: "player",
    hint: "Blacklist the hovered word so it is never suggested again.",
  },
  {
    keys: "o",
    what: "session HUD overlay",
    scope: "player",
    hint: "Toggle the heads-up overlay with this session's stats.",
  },
  {
    keys: "e",
    what: "echo dictation mode",
    scope: "player",
    hint: "Hide subtitles and type what you hear, cue by cue.",
  },
  {
    keys: "j",
    what: "jump to next i+1 cue",
    scope: "player",
    hint: "Skip to the next cue with exactly one unknown word.",
  },
  {
    keys: "d",
    what: "jump to next due-word cue",
    scope: "player",
    hint: "Skip to the next cue containing a word due for review.",
  },
  {
    keys: "j / ↓",
    what: "next line",
    scope: "read",
    hint: "Move the reading cursor to the next line.",
  },
  {
    keys: "k / ↑",
    what: "prev line",
    scope: "read",
    hint: "Move the reading cursor to the previous line.",
  },
  {
    keys: "Enter",
    what: "open word popup on cursor line",
    scope: "read",
    hint: "Open the lookup popup for the word on the cursor line.",
  },
  {
    keys: "t",
    what: "toggle translation lines",
    scope: "read",
    hint: "Show or hide the translated lines while reading.",
  },
  {
    keys: "Esc",
    what: "close popups / panels",
    scope: "global",
    hint: "Dismiss any open popup, panel, or overlay.",
  },
  {
    keys: "Ctrl+K",
    what: "command palette",
    scope: "global",
    hint: "Open the fuzzy command palette to jump anywhere.",
  },
  {
    keys: "Space",
    what: "show answer / next card",
    scope: "review",
    hint: "Reveal the card's answer, then advance to the next one.",
  },
  { keys: "1", what: "didn't know", scope: "review", hint: "Grade the card: again." },
  { keys: "2", what: "hard", scope: "review", hint: "Grade the card: hard." },
  { keys: "3", what: "knew it", scope: "review", hint: "Grade the card: good." },
  { keys: "4", what: "easy", scope: "review", hint: "Grade the card: easy." },
  {
    keys: "r",
    what: "replay audio",
    scope: "review",
    hint: "Replay the card's audio clip.",
  },
  {
    keys: "?",
    what: "hotkey cheatsheet",
    scope: "global",
    hint: "Open this hotkey reference (also F1).",
  },
];
