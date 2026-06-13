// Session counters + summary state (extracted from Player.tsx, Phase 4 step 4
// — no behavior changes). Owns the 9 session counter refs and the session HUD
// state, returning ALL of them so the still-inline concerns (activeCues,
// autoNext, lookup, onAdd, bulkAdd, echo, hotkeys) keep mutating/reading the
// SAME ref instances via Player passing the destructured returns through.

import { useCallback, useEffect, useRef, useState } from "react";

export type SessionSummary = {
  min: number;
  cues: number;
  lookups: number;
  cards: number;
  known: number;
  echo: { tried: number; perfect: number };
  streak: number | null;
} | null;

export function useSession(): {
  sessionStartRef: React.RefObject<number>;
  sessCuesRef: React.RefObject<number>;
  sessLookupsRef: React.RefObject<number>;
  sessCardsRef: React.RefObject<number>;
  sessKnownRef: React.RefObject<number>;
  sessUnknownSetRef: React.RefObject<Set<string>>;
  sessPassedRef: React.RefObject<number>;
  sessClearRef: React.RefObject<number>;
  sessEchoRef: React.RefObject<{ tried: number; perfect: number }>;
  sessionSummary: SessionSummary;
  setSessionSummary: React.Dispatch<React.SetStateAction<SessionSummary>>;
  hudOpen: boolean;
  hudOpenRef: React.RefObject<boolean>;
  hudTick: number;
  setHudTick: React.Dispatch<React.SetStateAction<number>>;
  toggleHud: () => void;
} {
  // --- session counters (for the end-of-episode summary overlay) ---
  const sessionStartRef = useRef(Date.now());
  const sessCuesRef = useRef(0); // distinct cue entries during playback
  const sessLookupsRef = useRef(0); // word popups opened
  const sessCardsRef = useRef(0); // anki cards added (popup + sentence + bulk)
  const sessKnownRef = useRef(0); // words marked known via `k`
  const [sessionSummary, setSessionSummary] = useState<SessionSummary>(null);
  // unique unknown lemmas seen across passed cues this session (for the HUD)
  const sessUnknownSetRef = useRef<Set<string>>(new Set());
  // cues passed + cues passed with zero unknowns → comprehension % in the HUD
  const sessPassedRef = useRef(0);
  const sessClearRef = useRef(0);
  // echo dictation session tallies
  const sessEchoRef = useRef({ tried: 0, perfect: 0 });

  // --- Wave 13.A: session HUD (`o`) — a tiny absolute overlay in the stage.
  // Gated on hudOpenRef so a closed HUD costs zero per-cue setState churn. ---
  const [hudOpen, setHudOpen] = useState(false);
  const hudOpenRef = useRef(false);
  const [hudTick, setHudTick] = useState(0); // bump to re-render HUD on cue cross
  const toggleHud = useCallback(() => {
    setHudOpen((o) => {
      const next = !o;
      hudOpenRef.current = next;
      if (next) setHudTick((t) => t + 1);
      return next;
    });
  }, []);

  // The HUD counters live in refs (mined/cards/unique-unknowns) and only the
  // cue-cross path bumps hudTick. Lookups, card saves and elapsed-time tick
  // outside that path, so an open HUD would show stale numbers until the next
  // cue. While the HUD is open, a 1s tick keeps every value live; it's gated on
  // hudOpen so a closed HUD costs nothing (no timer, no per-cue setState churn).
  useEffect(() => {
    if (!hudOpen) return;
    const id = window.setInterval(() => setHudTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, [hudOpen]);

  return {
    sessionStartRef,
    sessCuesRef,
    sessLookupsRef,
    sessCardsRef,
    sessKnownRef,
    sessUnknownSetRef,
    sessPassedRef,
    sessClearRef,
    sessEchoRef,
    sessionSummary,
    setSessionSummary,
    hudOpen,
    hudOpenRef,
    hudTick,
    setHudTick,
    toggleHud,
  };
}
