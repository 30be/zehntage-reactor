// Command palette (Ctrl+K) + hotkey cheatsheet (`?` / F1) overlays.
// Monochrome, laconic; mounted once at app level. While either overlay is
// open the keys.ts modal flag silences the Player's global hotkeys.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "./api.ts";
import {
  allCommands,
  filterCommands,
  onCommandsChange,
  HOTKEYS,
  type Command,
} from "./commands.ts";
import { isTextInput, setModalOpen } from "./keys.ts";

interface Props {
  go: (hash: string) => void;
  toast: (msg: string) => void;
  settings: Record<string, unknown>;
  setSettings: (s: Record<string, unknown>) => void;
}

function readLastMedia(): string | null {
  try {
    return localStorage.getItem("zr.lastMedia");
  } catch {
    return null;
  }
}

export function Palette({ go, toast, settings, setSettings }: Props) {
  const [open, setOpen] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const prevFocusRef = useRef<HTMLElement | null>(null);
  const paletteRef = useRef<HTMLDivElement>(null);
  const sheetDialogRef = useRef<HTMLDivElement>(null);
  // bump to re-read the registry when scopes register/unregister while open
  const [, setTick] = useState(0);
  useEffect(() => onCommandsChange(() => setTick((t) => t + 1)), []);

  // modal flag: Player's hotkey handler goes quiet while we own the keyboard
  useEffect(() => {
    if (!open) return;
    setModalOpen(true);
    return () => setModalOpen(false);
  }, [open]);
  useEffect(() => {
    if (!sheet) return;
    setModalOpen(true);
    return () => setModalOpen(false);
  }, [sheet]);

  const close = useCallback(() => {
    setOpen(false);
    setQ("");
    setSel(0);
    prevFocusRef.current?.focus();
    prevFocusRef.current = null;
  }, []);

  const closeSheet = useCallback(() => {
    setSheet(false);
    prevFocusRef.current?.focus();
    prevFocusRef.current = null;
  }, []);

  // settings quickies write through the same saveSettings + setSettings pair
  // as the Settings page, so the form stays in sync.
  const patchSettings = useCallback(
    (patch: Record<string, unknown>, msg: string) => {
      void api
        .saveSettings(patch)
        .then((next) => {
          setSettings(next);
          toast(msg);
        })
        .catch((e) => toast(`Save failed: ${e instanceof Error ? e.message : e}`));
    },
    [setSettings, toast],
  );

  // Theme toggle reachable from the palette: mirror App.applyTheme — flip the
  // <html data-theme>, persist to zr.theme, and round-trip via patchSettings so
  // the Settings <select> stays in sync. No new wiring from App needed.
  const toggleTheme = useCallback(() => {
    const cur = (settings.theme as string) || "light";
    const next = cur === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("zr.theme", next);
    } catch {
      /* ignore storage errors */
    }
    patchSettings({ theme: next }, `theme: ${next}`);
  }, [settings, patchSettings]);

  const copyDeepLink = useCallback(() => {
    const url = window.location.href;
    void (async () => {
      try {
        await navigator.clipboard?.writeText(url);
        toast("deep-link copied");
      } catch {
        toast(url);
      }
    })();
  }, [toast]);

  const staticCommands = useMemo<Command[]>(() => {
    const last = readLastMedia();
    const furiganaOn = settings.furigana !== false;
    const pitchOn = settings.pitchAccent !== false;
    const apUnknown = settings.autopauseMode === "unknown";
    const theme = (settings.theme as string) || "light";
    return [
      { id: "nav.home", title: "go: home", run: () => go("#/home") },
      { id: "nav.library", title: "go: library", run: () => go("#/") },
      {
        id: "nav.player",
        title: "go: player (last episode)",
        when: () => readLastMedia() != null,
        run: () => go(`#/play/${last}`),
      },
      {
        id: "nav.episode",
        title: "go: jump to episode (library)",
        run: () => go("#/"),
      },
      {
        id: "nav.search",
        title: "search subtitles (jump to any line)",
        run: () => go("#/search"),
      },
      { id: "nav.cards", title: "go: cards", run: () => go("#/cards") },
      { id: "nav.review", title: "go: review due words", run: () => go("#/review") },
      { id: "nav.stats", title: "go: stats", run: () => go("#/stats") },
      { id: "nav.health", title: "go: health", run: () => go("#/health") },
      { id: "nav.settings", title: "go: settings", run: () => go("#/settings") },
      {
        id: "set.theme",
        title: `setting: theme → ${theme === "dark" ? "light" : "dark"}`,
        run: toggleTheme,
      },
      {
        id: "action.copylink",
        title: "action: copy deep-link",
        run: copyDeepLink,
      },
      {
        id: "set.furigana",
        title: `setting: furigana ${furiganaOn ? "off" : "on"}`,
        run: () =>
          patchSettings(
            { furigana: !furiganaOn },
            furiganaOn ? "furigana off" : "furigana on",
          ),
      },
      {
        id: "set.pitch",
        title: `setting: pitch accent ${pitchOn ? "off" : "on"}`,
        run: () =>
          patchSettings(
            { pitchAccent: !pitchOn },
            pitchOn ? "pitch accent off" : "pitch accent on",
          ),
      },
      {
        id: "set.apmode",
        title: `setting: autopause mode → ${apUnknown ? "every cue" : "unknown words"}`,
        run: () =>
          patchSettings(
            { autopauseMode: apUnknown ? "every" : "unknown" },
            apUnknown ? "autopause: every cue" : "autopause: unknown words",
          ),
      },
      {
        id: "help.hotkeys",
        title: "help: hotkeys",
        hint: "?",
        run: () => setSheet(true),
      },
    ];
  }, [go, patchSettings, settings, toggleTheme, copyDeepLink]);

  const commands = useMemo(() => {
    const all = [...allCommands(), ...staticCommands];
    return filterCommands(all, q).slice(0, 16);
  }, [staticCommands, q, open]);

  useEffect(() => {
    setSel((s) => Math.min(s, Math.max(0, commands.length - 1)));
  }, [commands.length]);

  const run = useCallback(
    (cmd: Command | undefined) => {
      if (!cmd) return;
      close(); // close FIRST so video.play() etc. aren't under a modal
      cmd.run();
    },
    [close],
  );

  // global capture listener: Ctrl/Cmd+K palette, ? / F1 cheatsheet, Esc close
  const openRef = useRef(open);
  const sheetRef = useRef(sheet);
  openRef.current = open;
  sheetRef.current = sheet;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.code === "KeyK") {
        e.preventDefault();
        e.stopPropagation();
        setSheet(false);
        setOpen((o) => {
          if (o) {
            setQ("");
            setSel(0);
          }
          return !o;
        });
        return;
      }
      if (e.key === "Escape") {
        if (sheetRef.current) {
          e.preventDefault();
          e.stopPropagation();
          closeSheet();
        } else if (openRef.current) {
          e.preventDefault();
          e.stopPropagation();
          close();
        }
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (openRef.current || sheetRef.current) return;
      // `?` is a character hotkey (layout-dependent by nature); F1 as backup
      if (
        (e.key === "?" || e.key === "F1") &&
        !isTextInput(document.activeElement) &&
        !isTextInput(e.target as Element | null)
      ) {
        e.preventDefault();
        e.stopPropagation();
        setSheet(true);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [close, closeSheet]);

  useEffect(() => {
    if (open) {
      prevFocusRef.current = document.activeElement as HTMLElement;
      inputRef.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    if (sheet) {
      prevFocusRef.current = document.activeElement as HTMLElement;
      sheetDialogRef.current?.querySelector<HTMLElement>("button")?.focus();
    }
  }, [sheet]);

  if (!open && !sheet) return null;

  // In fullscreen only the fullscreened element renders — portal into it.
  const host = (document.fullscreenElement as HTMLElement | null) ?? document.body;

  return createPortal(
    <>
      {open && (
        <div className="palette-backdrop" onMouseDown={close}>
          <div
            ref={paletteRef}
            className="palette"
            role="dialog"
            aria-label="Command palette"
            aria-modal="true"
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Escape") { close(); return; }
              if (e.key === "Tab") {
                const focusable = paletteRef.current
                  ? Array.from(paletteRef.current.querySelectorAll<HTMLElement>(
                      'button,input,[tabindex]:not([tabindex="-1"])'
                    ))
                  : [];
                if (focusable.length === 0) { e.preventDefault(); return; }
                const first = focusable[0]!;
                const last = focusable[focusable.length - 1]!;
                if (e.shiftKey && document.activeElement === first) {
                  e.preventDefault(); last.focus();
                } else if (!e.shiftKey && document.activeElement === last) {
                  e.preventDefault(); first.focus();
                }
              }
            }}
          >
            <input
              ref={inputRef}
              type="text"
              placeholder="command…"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setSel(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setSel((s) => Math.min(commands.length - 1, s + 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setSel((s) => Math.max(0, s - 1));
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  run(commands[sel]);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  close();
                }
              }}
            />
            <div className="palette-list">
              {commands.length === 0 && (
                <div className="palette-row none">no commands</div>
              )}
              {commands.map((c, i) => (
                <div
                  key={c.id}
                  className={`palette-row${i === sel ? " sel" : ""}`}
                  onMouseEnter={() => setSel(i)}
                  onClick={() => run(c)}
                >
                  <span className="palette-title">{c.title}</span>
                  {c.hint && <kbd className="palette-kbd">{c.hint}</kbd>}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      {sheet && (
        <div className="palette-backdrop" onMouseDown={closeSheet}>
          <div
            ref={sheetDialogRef}
            className="cheatsheet"
            role="dialog"
            aria-label="Hotkeys"
            aria-modal="true"
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => { if (e.key === "Escape") closeSheet(); }}
          >
            <div className="cheat-title">
              hotkeys
              <button
                type="button"
                className="cheat-close"
                aria-label="Close hotkey reference"
                onClick={closeSheet}
              >
                ✕
              </button>
            </div>
            <div className="cheat-cols">
              {(["player", "read", "global", "review"] as const).map((scope) => (
                <div key={scope} className="cheat-col">
                  <div className="cheat-scope">{scope}</div>
                  {HOTKEYS.filter((h) => h.scope === scope).map((h) => (
                    <div key={h.keys} className="cheat-row">
                      <kbd className="palette-kbd">{h.keys}</kbd>
                      <span className="cheat-what">{h.what}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </>,
    host,
  );
}
