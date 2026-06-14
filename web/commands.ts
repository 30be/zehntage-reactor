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
}

export const HOTKEYS: HotkeyRow[] = [
  { keys: "space", what: "play / pause", scope: "player" },
  { keys: "f", what: "fullscreen", scope: "player" },
  { keys: "← →", what: "seek −5s / +5s", scope: "player" },
  { keys: "↑ ↓", what: "volume", scope: "player" },
  { keys: "Tab / Shift+Tab", what: "next / previous cue", scope: "player" },
  { keys: "r", what: "replay current cue", scope: "player" },
  { keys: "a", what: "add/remove popup word in Anki", scope: "player" },
  { keys: "g", what: "regenerate popup explanation", scope: "player" },
  { keys: "s", what: "shadowing loop current cue", scope: "player" },
  { keys: ", / .", what: "frame step back / forward", scope: "player" },
  { keys: "- / =", what: "playback speed", scope: "player" },
  { keys: "Shift+- / Shift+=", what: "subtitle size", scope: "player" },
  { keys: "[ / ] / \\", what: "subtitle offset − / + / reset", scope: "player" },
  { keys: "Shift+← / Shift+→", what: "previous / next episode", scope: "player" },
  { keys: "p", what: "toggle autopause", scope: "player" },
  { keys: "l", what: "cue-list sidebar", scope: "player" },
  { keys: "w", what: "pre-study panel (upcoming words)", scope: "player" },
  { keys: "q", what: "comprehension quiz (watched cues)", scope: "player" },
  { keys: "b (hold)", what: "peek secondary line while held", scope: "player" },
  { keys: "b b", what: "toggle secondary blur for session", scope: "player" },
  { keys: "i", what: "picture-in-picture", scope: "player" },
  { keys: "k", what: "mark hovered word known", scope: "player" },
  { keys: "x", what: "blacklist hovered word", scope: "player" },
  { keys: "o", what: "session HUD overlay", scope: "player" },
  { keys: "e", what: "echo dictation mode", scope: "player" },
  { keys: "j", what: "jump to next i+1 cue", scope: "player" },
  { keys: "d", what: "jump to next due-word cue", scope: "player" },
  { keys: "j / ↓", what: "next line", scope: "read" },
  { keys: "k / ↑", what: "prev line", scope: "read" },
  { keys: "Enter", what: "open word popup on cursor line", scope: "read" },
  { keys: "t", what: "toggle translation lines", scope: "read" },
  { keys: "Esc", what: "close popups / panels", scope: "global" },
  { keys: "Ctrl+K", what: "command palette", scope: "global" },
  { keys: "Space", what: "show answer / next card", scope: "review" },
  { keys: "1", what: "didn't know", scope: "review" },
  { keys: "2", what: "hard", scope: "review" },
  { keys: "3", what: "knew it", scope: "review" },
  { keys: "4", what: "easy", scope: "review" },
  { keys: "r", what: "replay audio", scope: "review" },
  { keys: "?", what: "hotkey cheatsheet", scope: "global" },
];
