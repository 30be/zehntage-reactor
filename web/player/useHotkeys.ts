// Global Player hotkeys: one capture-phase keydown handler that owns playback
// keys regardless of focus (except real text inputs). Extracted from
// Player.tsx; the handler reads the latest Player state through a ctx object
// refreshed every render (no behavior changes).

import { useEffect, useRef } from "react";
import { activeCueIndex } from "../cues.ts";
import { isModalOpen, isTextInput } from "../keys.ts";
import { tmEvent } from "../telemetry.ts";
import type { Cue } from "../api.ts";

export interface PlayerHotkeyCtx {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  stageRef: React.RefObject<HTMLDivElement | null>;
  // panel / popup state (refs so the handler never goes stale)
  preStudyOpenRef: React.RefObject<boolean>;
  quizOpenRef: React.RefObject<boolean>;
  popupOpenRef: React.RefObject<boolean>;
  popupKeyRef: React.RefObject<string | null>;
  hoveredKeyRef: React.RefObject<string | null>;
  pausedByHoverRef: React.RefObject<boolean>;
  askFocusedRef: React.RefObject<boolean>;
  // playback / cue state
  subOffsetRef: React.RefObject<number>;
  primaryCuesRef: React.RefObject<Cue[]>;
  loopRef: React.RefObject<{ idx: number; remaining: number } | null>;
  shadowRepeatsRef: React.RefObject<number>;
  // word sets
  knownWordsRef: React.RefObject<Set<string>>;
  blacklistRef: React.RefObject<Set<string>>;
  sessKnownRef: React.RefObject<number>;
  // `b` blur toggle state
  lastBDownRef: React.RefObject<number>;
  blurOffRef: React.RefObject<boolean>;
  setBlurOff: (on: boolean) => void;
  setSecHold: (on: boolean) => void;
  // popup hotkey targets (latest closures)
  ankiToggleRef: React.RefObject<() => void>;
  regenLookupRef: React.RefObject<() => void>;
  // actions
  closePanel: () => void;
  closePreStudy: () => void;
  adjustSubScale: (delta: number) => void;
  changeOffset: (delta: number | null) => void;
  toggleSidebar: () => void;
  toggleKnown: (key: string) => void;
  toggleBlacklist: (key: string) => void;
  gotoEpisode: (dir: 1 | -1) => Promise<void>;
  togglePreStudy: () => void;
  toggleQuiz: () => void;
  toggleAutopause: () => void;
  toggleHud: () => void;
  toggleEcho: () => void;
  seekIPlusOne: () => void;
  toast: (msg: string) => void;
}

const FRAME = 1 / 24; // ~one frame at 23.976/24 fps
const RATES = [0.5, 0.75, 1, 1.25, 1.5];
// Letter hotkeys bind to e.code (physical key) so they keep working on
// non-Latin layouts (Russian, German…). Symbols/arrows/Space/Tab stay on
// e.key, which is layout-correct for them.
const LETTERS: Record<string, string> = {
  KeyF: "f", KeyA: "a", KeyR: "r", KeyL: "l", KeyK: "k", KeyS: "s",
  KeyP: "p", KeyG: "g", KeyW: "w", KeyB: "b", KeyI: "i", KeyX: "x",
  KeyO: "o", KeyE: "e", KeyJ: "j", KeyQ: "q",
};
const HANDLED = new Set([
  " ",
  "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
  ",", "<", ".", ">",
  "-", "=", "[", "]", "\\",
  "Tab",
  ...Object.values(LETTERS),
]);
const REPEAT_TOGGLES = new Set([" ", "f", "l", "k", "s", "p", "g", "a", "w", "b", "i", "x", "o", "e", "j", "q"]);

export function usePlayerHotkeys(ctx: PlayerHotkeyCtx): void {
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const c = ctxRef.current;
      // A modal overlay (command palette / cheatsheet) owns the keyboard.
      if (isModalOpen()) return;
      // Browser-level combos (Ctrl+L, Cmd+R, Alt+…) are never ours.
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const v = c.videoRef.current;
      if (!v) return;
      const active = document.activeElement;
      // Real text inputs keep their native behavior entirely (incl. the cloze
      // answer field — so typing "q" there never closes the quiz).
      if (isTextInput(active) || isTextInput(e.target as Element | null)) return;
      // The quiz overlay owns the keyboard while open (its own capture handler
      // takes number/arrow/Enter/Esc); only `q` falls through here, to close.
      if (c.quizOpenRef.current && (LETTERS[e.code] ?? e.key) !== "q") return;
      // Layout-independent letter token: physical key for letters, e.key else.
      const kb = LETTERS[e.code] ?? e.key;
      // Focused <select>/<button>: letter hotkeys still work (no conflict),
      // but Space/Enter/arrows belong to the element — except Shift+←/→
      // (episode nav), which selects/buttons don't use. Tab is NOT passed:
      // the player owns cue navigation, and browsers focus buttons on CLICK
      // (even tabIndex={-1} ones), which used to break Tab until blur.
      const passEl = (el: Element | null) =>
        el?.tagName === "SELECT" || el?.tagName === "BUTTON";
      const episodeNav =
        e.shiftKey && (kb === "ArrowLeft" || kb === "ArrowRight");
      if (
        (passEl(active) || passEl(e.target as Element | null)) &&
        !episodeNav &&
        (kb === " " || kb === "Enter" || kb.startsWith("Arrow"))
      )
        return;
      // Escape closes the lookup panel; otherwise leave it to native handling
      // (exit fullscreen etc.) — never eat it for nothing.
      if (e.key === "Escape") {
        if (c.preStudyOpenRef.current) {
          e.preventDefault();
          e.stopPropagation();
          c.closePreStudy();
          return;
        }
        if (c.popupOpenRef.current) {
          e.preventDefault();
          e.stopPropagation();
          c.closePanel();
        }
        return;
      }
      // Shift+= / Shift+- : subtitle scale (e.code = physical key, so it is
      // layout-independent; plain -/= without shift stay playback speed).
      if (e.shiftKey && (e.code === "Equal" || e.code === "Minus")) {
        e.preventDefault();
        e.stopPropagation();
        c.adjustSubScale(e.code === "Equal" ? 0.1 : -0.1);
        return;
      }
      if (!HANDLED.has(kb)) return;
      // Avoid double-toggle on key auto-repeat for toggling keys.
      if (e.repeat && REPEAT_TOGGLES.has(kb)) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      // We fully own these keys: kill the native activation (Space on a
      // focused button/checkbox/video would otherwise ALSO toggle → double).
      e.preventDefault();
      e.stopPropagation();
      if (
        active instanceof HTMLElement &&
        active !== document.body &&
        !isTextInput(active)
      ) {
        active.blur();
      }
      switch (kb) {
        case " ":
          c.pausedByHoverRef.current = false; // user took control
          if (v.paused) void v.play().catch(() => {});
          else v.pause();
          break;
        case "f":
          if (document.fullscreenElement) void document.exitFullscreen();
          else void c.stageRef.current?.requestFullscreen?.();
          break;
        case "ArrowLeft":
          if (e.shiftKey) void c.gotoEpisode(-1); // prev episode
          else v.currentTime = Math.max(0, v.currentTime - 5);
          break;
        case "ArrowRight":
          if (e.shiftKey) void c.gotoEpisode(1); // next episode
          else v.currentTime = Math.min(v.duration || Infinity, v.currentTime + 5);
          break;
        case "ArrowUp":
          v.volume = Math.min(1, v.volume + 0.1);
          break;
        case "ArrowDown":
          v.volume = Math.max(0, v.volume - 0.1);
          break;
        case ",":
        case "<":
          v.pause();
          v.currentTime = Math.max(0, v.currentTime - FRAME);
          break;
        case ".":
        case ">":
          v.pause();
          v.currentTime = Math.min(v.duration || Infinity, v.currentTime + FRAME);
          break;
        case "a":
          // Anki toggle for the open popup word: add when new, delete when
          // the word is already in the deck. Color is the only state cue.
          c.ankiToggleRef.current();
          break;
        case "g":
          // Regenerate the popup explanation (fresh Gemini call, no cache).
          c.regenLookupRef.current();
          break;
        case "r": {
          // Replay: jump to the start of the current primary cue; if within
          // the first 0.3s (or between cues), step back to the previous one —
          // tapping `r` repeatedly walks backward cue by cue.
          const off = c.subOffsetRef.current;
          const cues = c.primaryCuesRef.current;
          if (cues.length === 0) break;
          const tt = v.currentTime - off;
          let i = activeCueIndex(cues, tt);
          if (i < 0) {
            for (let k = cues.length - 1; k >= 0; k--) {
              if (cues[k]!.start <= tt) {
                i = k;
                break;
              }
            }
          } else if (tt - cues[i]!.start < 0.3 && i > 0) {
            i -= 1;
          }
          if (i >= 0) v.currentTime = Math.max(0, cues[i]!.start + off);
          break;
        }
        case "-":
        case "=": {
          let i = RATES.indexOf(v.playbackRate);
          if (i === -1) i = RATES.indexOf(1);
          i =
            kb === "="
              ? (i + 1) % RATES.length
              : (i + RATES.length - 1) % RATES.length;
          v.playbackRate = RATES[i]!;
          c.toast(`speed ${RATES[i]}×`);
          break;
        }
        case "[":
          c.changeOffset(-0.1);
          break;
        case "]":
          c.changeOffset(+0.1);
          break;
        case "\\":
          c.changeOffset(null);
          break;
        case "l":
          c.toggleSidebar();
          break;
        case "Tab": {
          // Next/previous dialogue line. If a popup is open (incl. pinned),
          // Tab closes it first — mirror Escape — then seeks.
          if (c.popupOpenRef.current) c.closePanel();
          c.loopRef.current = null; // Tab releases the shadowing loop
          const off = c.subOffsetRef.current;
          const cues = c.primaryCuesRef.current;
          if (cues.length === 0) break;
          const tt = v.currentTime - off;
          const LEAD = 0.15; // small lead-in before the cue starts
          if (e.shiftKey) {
            // previous cue start — same walk-back as `r`
            let i = activeCueIndex(cues, tt);
            if (i < 0) {
              for (let k = cues.length - 1; k >= 0; k--) {
                if (cues[k]!.start <= tt) {
                  i = k;
                  break;
                }
              }
            } else if (tt - cues[i]!.start < 0.3 && i > 0) {
              i -= 1;
            }
            if (i >= 0) v.currentTime = Math.max(0, cues[i]!.start + off - LEAD);
          } else {
            const next = cues.find((cue) => cue.start > tt + 0.01);
            if (next) v.currentTime = Math.max(0, next.start + off - LEAD);
          }
          break;
        }
        case "s": {
          // Shadowing loop on the current primary cue. Repeat count comes from
          // Settings ("Shadowing repeats", 0 = infinite). `s` again releases.
          if (c.loopRef.current) {
            c.loopRef.current = null;
            c.toast("loop off");
            break;
          }
          const off = c.subOffsetRef.current;
          const cues = c.primaryCuesRef.current;
          const i = activeCueIndex(cues, v.currentTime - off);
          if (i < 0) {
            c.toast("no cue to loop");
            break;
          }
          const n = c.shadowRepeatsRef.current;
          c.loopRef.current = { idx: i, remaining: n > 0 ? n : Infinity };
          c.toast(n > 0 ? `loop ×${n}` : "loop on");
          break;
        }
        case "w":
          c.togglePreStudy();
          break;
        case "q":
          c.toggleQuiz();
          break;
        case "p":
          c.toggleAutopause();
          break;
        case "b": {
          // hold = temporary unblur; quick double-press toggles for the session
          const now = Date.now();
          if (now - c.lastBDownRef.current < 350) {
            const next = !c.blurOffRef.current;
            c.blurOffRef.current = next;
            c.setBlurOff(next);
            c.toast(next ? "blur off" : "blur on");
          }
          c.lastBDownRef.current = now;
          c.setSecHold(true);
          break;
        }
        case "i": {
          if (document.pictureInPictureElement) {
            void document.exitPictureInPicture().catch(() => {});
          } else if (typeof v.requestPictureInPicture === "function") {
            v.requestPictureInPicture().catch((err: unknown) =>
              c.toast(`PiP failed: ${err instanceof Error ? err.message : err}`),
            );
          } else {
            c.toast("PiP unsupported");
          }
          break;
        }
        case "k": {
          // toggle mark-as-known for the popup word or the hovered word
          const key = c.popupKeyRef.current ?? c.hoveredKeyRef.current;
          if (!key) break;
          const adding = !c.knownWordsRef.current.has(key);
          if (adding) c.sessKnownRef.current += 1;
          c.toggleKnown(key);
          tmEvent("mark_known", { word: key });
          c.toast(adding ? `known: ${key}` : `unknown: ${key}`);
          break;
        }
        case "x": {
          // toggle blacklist for the popup word or the hovered word
          const key = c.popupKeyRef.current ?? c.hoveredKeyRef.current;
          if (!key) break;
          const adding = !c.blacklistRef.current.has(key);
          c.toggleBlacklist(key);
          tmEvent("blacklist", { word: key, on: adding });
          c.toast(adding ? `blacklisted: ${key}` : `unblacklisted: ${key}`);
          break;
        }
        case "o":
          c.toggleHud();
          break;
        case "e":
          c.toggleEcho();
          break;
        case "j":
          c.seekIPlusOne();
          break;
      }
    };
    // keyup re-blurs the secondary line after a `b` hold (harmless elsewhere)
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "KeyB") ctxRef.current.setSecHold(false);
    };
    // alt-tab / focus loss while `b` is held: keyup never arrives — re-blur.
    const onWinBlur = () => ctxRef.current.setSecHold(false);
    // capture phase: run before any focused element's own key handling
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onWinBlur);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onWinBlur);
    };
  }, []);
}
