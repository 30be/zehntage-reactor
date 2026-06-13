// Hover-to-pause engine for the Player. Extracted from Player.tsx verbatim — no
// behavior changes. Pauses while a word popup / secondary subtitle line is
// being read, and resumes only if WE were the ones who paused (not the user).
//
// Owns (moved IN): openTimer, closeTimer, pausedByHoverRef, secondaryHoveredRef.
// These last two are SHARED reads — returned so JSX (SubOverlay), useActiveCues,
// togglePlay and hotkeys all use the SAME ref instances.
//
// SHARED state stays owned by Player and passed IN: pinnedRef + setPinned +
// setPopup (lookup owns pin/popup state). The play-takeover effect reads them
// via closure with `[]` deps (subscribe once) — pass them so they're stable.
// openTimer/closeTimer are returned so useLookup schedules opens/closes on the
// same timer cells.

import { useCallback, useEffect, useRef } from "react";

export function useHoverPause(opts: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  pinnedRef: React.RefObject<boolean>;
  setPinned: (v: boolean) => void;
  setPopup: (v: null) => void;
}) {
  const { videoRef, pinnedRef, setPinned, setPopup } = opts;

  // True when the video was paused by a hover (word or secondary subtitle),
  // so closing the popup / leaving the line auto-resumes playback.
  const pausedByHoverRef = useRef(false);
  // True while the cursor is over the secondary (RU) line: it holds the hover
  // pause, so a word-popup close timer must NOT resume playback under it.
  const secondaryHoveredRef = useRef(false);

  // hover-intent: open the popup only once the cursor RESTS on a word ~200ms;
  // a separate grace timer hides it after the cursor leaves to empty space.
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  const clearOpenTimer = useCallback(() => {
    if (openTimer.current != null) {
      window.clearTimeout(openTimer.current);
      openTimer.current = null;
    }
  }, []);
  const clearCloseTimer = useCallback(() => {
    if (closeTimer.current != null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  // --- hover-pause: pause while a popup / secondary line is being read, and
  // resume only if WE were the ones who paused (not the user). ---
  const pauseForHover = useCallback(() => {
    const v = videoRef.current;
    if (v && !v.paused) {
      pausedByHoverRef.current = true;
      v.pause();
    }
  }, []);
  const resumeFromHover = useCallback(() => {
    if (!pausedByHoverRef.current) return;
    // The secondary line still holds the pause (user is reading the RU text);
    // keep the flag so ITS mouseleave performs the resume.
    if (secondaryHoveredRef.current) return;
    pausedByHoverRef.current = false;
    void videoRef.current?.play().catch(() => {});
  }, []);
  // Any play not initiated by us (user clicks the video, presses its controls)
  // means the user took over — never auto-resume on top of that.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onPlay = () => {
      pausedByHoverRef.current = false;
      // Playback resuming closes a pinned panel (space, video controls, …).
      if (pinnedRef.current) {
        setPinned(false);
        setPopup(null);
      }
    };
    v.addEventListener("play", onPlay);
    return () => v.removeEventListener("play", onPlay);
  }, []);

  return {
    pauseForHover,
    resumeFromHover,
    clearOpenTimer,
    clearCloseTimer,
    openTimer,
    closeTimer,
    pausedByHoverRef,
    secondaryHoveredRef,
  };
}
