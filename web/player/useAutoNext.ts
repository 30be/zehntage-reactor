// End-of-episode auto-advance + session summary (extracted from Player.tsx,
// Phase 4 step 5 — no behavior changes).
//
// On `ended`: optionally fire the comprehension quiz, show the session-summary
// overlay (with server-computed streak), and start a 5s countdown to the next
// episode. Any keypress/click cancels the countdown (capture-phase listeners so
// the hotkey handler runs first: Shift+Arrow nav and `q`-quiz both suppress the
// "auto-next canceled" toast).
//
// gotoEpisode is reached through a ref so the `ended` effect's deps stay minimal
// (`[mediaId, toast]`) — a re-run would silently kill a live countdown.
//
// SHARED refs (session refs from useSession, autoQuizRef/toggleQuizRef owned by
// Player, setSessionSummary from useSession) are passed IN as the SAME
// instances — do NOT duplicate them. The hook owns only gotoEpisodeRef,
// cancelAutoNextRef, and autoQuizFiredRef (only autoNext uses them).

import { useEffect, useRef } from "react";
import { api } from "../api.ts";
import { tmEvent } from "../telemetry.ts";
import type { SessionSummary } from "./useSession.ts";

export function useAutoNext(opts: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  mediaId: string;
  gotoEpisode: (d: 1 | -1) => Promise<void>;
  autoQuizRef: React.RefObject<boolean>;
  toggleQuizRef: React.RefObject<() => void>;
  sessionStartRef: React.RefObject<number>;
  sessCuesRef: React.RefObject<number>;
  sessLookupsRef: React.RefObject<number>;
  sessCardsRef: React.RefObject<number>;
  sessKnownRef: React.RefObject<number>;
  sessEchoRef: React.RefObject<{ tried: number; perfect: number }>;
  setSessionSummary: React.Dispatch<React.SetStateAction<SessionSummary>>;
  toast: (m: string) => void;
}): void {
  const {
    videoRef,
    mediaId,
    gotoEpisode,
    autoQuizRef,
    toggleQuizRef,
    sessionStartRef,
    sessCuesRef,
    sessLookupsRef,
    sessCardsRef,
    sessKnownRef,
    sessEchoRef,
    setSessionSummary,
    toast,
  } = opts;

  // Auto-next: on `ended`, count down 5s (any keypress/click cancels), then go.
  // gotoEpisode is reached through a ref so this effect never re-runs when
  // tracks/track-ids change — a re-run would silently kill a live countdown.
  const gotoEpisodeRef = useRef(gotoEpisode);
  useEffect(() => {
    gotoEpisodeRef.current = gotoEpisode;
  }, [gotoEpisode]);
  const cancelAutoNextRef = useRef<(() => void) | null>(null);
  const autoQuizFiredRef = useRef(false);
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    autoQuizFiredRef.current = false;
    const onEnded = () => {
      tmEvent("episode_end", { mediaId });
      cancelAutoNextRef.current?.();
      // Auto comprehension quiz: when enabled, launch the same quiz `q` builds
      // directly (no "press q" prompt). Guarded so it fires once per end.
      if (autoQuizRef.current && !autoQuizFiredRef.current) {
        autoQuizFiredRef.current = true;
        toggleQuizRef.current();
      }
      // Session summary overlay (any key/click dismisses it along with the
      // countdown; the countdown line is rendered inside the panel).
      setSessionSummary({
        min: Math.max(1, Math.round((Date.now() - sessionStartRef.current) / 60000)),
        cues: sessCuesRef.current,
        lookups: sessLookupsRef.current,
        cards: sessCardsRef.current,
        known: sessKnownRef.current,
        echo: { ...sessEchoRef.current },
        streak: null,
      });
      // streak line — use the server-computed streak (same source as the Home
      // "today" panel) so the two surfaces never disagree; best-effort async
      void api
        .statsToday()
        .then((t) => {
          setSessionSummary((s) => (s ? { ...s, streak: t.streak } : s));
        })
        .catch(() => {});
      toast("Next episode in 5s…");
      const cleanup = () => {
        window.clearTimeout(timer);
        window.removeEventListener("keydown", cancel, true);
        window.removeEventListener("pointerdown", cancel, true);
        cancelAutoNextRef.current = null;
      };
      const cancel = (e: Event) => {
        cleanup();
        setSessionSummary(null);
        // Shift+arrows navigate anyway (the hotkey handler runs first in
        // capture order) — only the timer needs killing, the toast would
        // mislead.
        const ke = e as KeyboardEvent;
        if (ke.shiftKey && (ke.key === "ArrowRight" || ke.key === "ArrowLeft"))
          return;
        // `q` manually starts the comprehension quiz — the hotkey handler
        // already ran in capture order, so suppress the auto-next-cancel toast.
        if (ke.key === "q" || ke.key === "Q") return;
        toast("auto-next canceled");
      };
      const timer = window.setTimeout(() => {
        cleanup();
        void gotoEpisodeRef.current(1);
      }, 5000);
      window.addEventListener("keydown", cancel, true);
      window.addEventListener("pointerdown", cancel, true);
      cancelAutoNextRef.current = cleanup;
    };
    v.addEventListener("ended", onEnded);
    return () => {
      v.removeEventListener("ended", onEnded);
      cancelAutoNextRef.current?.();
    };
  }, [mediaId, toast]);
}
