// HUD (vbar + cursor) autohide for the Player. Fades the overlaid control bar
// after 2.5s of mouse inactivity while playing; reappears on mousemove/pause.
// Extracted from Player.tsx verbatim — no behavior changes. The interaction
// refs (scrubbing / bar-hover / cc-open) stay owned by Player and shared with
// the Vbar; they're passed in so autohide never fades while they're active.

import { useCallback, useEffect, useRef, useState } from "react";

export interface HudAutohide {
  hudHidden: boolean;
  /** Stage onMouseMove: pokes the timer, edge-hides in fullscreen. */
  onStageMouseMove: (e: React.MouseEvent) => void;
  /** Stage onMouseLeave: hide instantly (no 2.5s wait). */
  hideHudNow: () => void;
}

export function useHudAutohide(opts: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  scrubbingRef: React.RefObject<boolean>;
  barHoverRef: React.RefObject<boolean>;
  ccOpenRef: React.RefObject<boolean>;
  /** entry.id — re-binds the pause/play listeners per episode. */
  mediaKey: string;
}): HudAutohide {
  const { videoRef, scrubbingRef, barHoverRef, ccOpenRef, mediaKey } = opts;

  // Autohide: fade the bar (and the cursor) after 2.5s without mouse movement
  // while playing. Reappears on mousemove / pause. The bar OVERLAYS the video,
  // so the subtitle overlay never shifts when it hides.
  const [hudHidden, setHudHidden] = useState(false);
  const hudTimerRef = useRef<number | null>(null);
  const pokeHud = useCallback(() => {
    setHudHidden(false);
    if (hudTimerRef.current != null) window.clearTimeout(hudTimerRef.current);
    hudTimerRef.current = window.setTimeout(() => {
      hudTimerRef.current = null;
      const v = videoRef.current;
      if (
        v &&
        !v.paused &&
        !scrubbingRef.current &&
        !barHoverRef.current &&
        !ccOpenRef.current
      )
        setHudHidden(true);
    }, 2500);
  }, []);
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onPause = () => {
      if (hudTimerRef.current != null) window.clearTimeout(hudTimerRef.current);
      hudTimerRef.current = null;
      setHudHidden(false);
    };
    v.addEventListener("pause", onPause);
    v.addEventListener("play", pokeHud);
    return () => {
      v.removeEventListener("pause", onPause);
      v.removeEventListener("play", pokeHud);
      if (hudTimerRef.current != null) window.clearTimeout(hudTimerRef.current);
    };
  }, [mediaKey, pokeHud]);

  // Stage mouse handling: leaving the stage hides the HUD instantly (no 2.5s
  // wait); in fullscreen, hugging the top/side edges (~8px) also hides it.
  const hideHudNow = useCallback(() => {
    if (hudTimerRef.current != null) window.clearTimeout(hudTimerRef.current);
    hudTimerRef.current = null;
    const v = videoRef.current;
    if (
      v &&
      !v.paused &&
      !scrubbingRef.current &&
      !barHoverRef.current &&
      !ccOpenRef.current
    )
      setHudHidden(true);
  }, []);
  const onStageMouseMove = useCallback(
    (e: React.MouseEvent) => {
      // Edge-hide applies to the TOP and SIDE edges only. The bottom strip is
      // exempt: that's where the vbar lives — moving the mouse there is how
      // the user summons the controls (the hidden bar has pointer-events:
      // none, so a bottom-edge hide would make it unreachable in fullscreen).
      // Side edges are also exempt near the bottom corners (the fullscreen
      // button sits bottom-right).
      const EDGE = 8;
      const BAR_ZONE = 80; // px above the bottom reserved for the vbar
      const aboveBar = e.clientY < window.innerHeight - BAR_ZONE;
      if (
        document.fullscreenElement != null &&
        (e.clientY <= EDGE ||
          (aboveBar &&
            (e.clientX <= EDGE || e.clientX >= window.innerWidth - EDGE)))
      ) {
        hideHudNow();
        return;
      }
      pokeHud();
    },
    [pokeHud, hideHudNow],
  );

  return { hudHidden, onStageMouseMove, hideHudNow };
}
