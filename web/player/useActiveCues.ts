// Active-cue tracking (extracted from Player.tsx, Phase 4 — no behavior
// changes). Owns the `timeupdate`-driven loop that derives the active PRIMARY
// cue index (subOffset-adjusted) and the active SECONDARY cue index from the
// video's currentTime, and the `seeking` handler that resets the autopause /
// loop guards.
//
// The same effect also drives the entangled playback behaviors that are gated
// on the active-cue transition — shadowing loop, smart/echo autopause, per-cue
// session telemetry and HUD ticks — because they are computed from the SAME
// idx/prev transition and cannot be split without recomputing the index twice
// (and risking divergent behavior). All of their state lives elsewhere
// (Player- or other-hook-owned) and is passed IN as the SAME ref/state
// instances — this hook owns ONLY the active-cue state + the prevActiveP /
// lastAutopausedIdx guards (passed in, but mutated only here).
//
// Returns activeP/activeS (the rendered active-cue indices) and their setters
// (setActiveS is also poked from the lookup/seek paths in Player).
//
// Dependency array preserved VERBATIM: [displayCues, secondaryCues, subOffset,
// toast]. The two cue-ref-sync effects keep their [displayCues] / (secondaryRef
// init) shape. Event listeners ("timeupdate", "seeking") and the onTime()
// initial call are unchanged.

import { useEffect, useRef, useState } from "react";
import type { Cue } from "../api.ts";
import { activeCueIndex } from "../cues.ts";
import { shouldSkipAutopause } from "./autopause.ts";

export function useActiveCues(opts: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  mediaId: string;
  displayCues: Cue[];
  secondaryCues: Cue[];
  subOffset: number;
  subOffsetRef: React.RefObject<number>;
  primaryCuesRef: React.RefObject<Cue[]>;
  secondaryCuesRef: React.RefObject<Cue[]>;
  loopRef: React.RefObject<{ idx: number; remaining: number } | null>;
  internalSeekRef: React.RefObject<boolean>;
  autopauseRef: React.RefObject<boolean>;
  echoRef: React.RefObject<boolean>;
  apModeRef: React.RefObject<"every" | "unknown">;
  apMinRef: React.RefObject<number>;
  cueUnknownsRef: React.RefObject<number[] | null>;
  cueUnknownLemmasRef: React.RefObject<string[][] | null>;
  hudOpenRef: React.RefObject<boolean>;
  setHudTick: React.Dispatch<React.SetStateAction<number>>;
  sessCuesRef: React.RefObject<number>;
  sessPassedRef: React.RefObject<number>;
  sessClearRef: React.RefObject<number>;
  sessUnknownSetRef: React.RefObject<Set<string>>;
  setEchoCue: React.Dispatch<
    React.SetStateAction<{ idx: number; text: string } | null>
  >;
  setEchoInput: React.Dispatch<React.SetStateAction<string>>;
  setEchoResult: (v: null) => void;
  echoInputRef: React.RefObject<HTMLInputElement | null>;
  tmEvent: (name: string, props?: Record<string, unknown>) => void;
  toast: (m: string) => void;
}): {
  activeP: number;
  activeS: number;
  setActiveP: React.Dispatch<React.SetStateAction<number>>;
  setActiveS: React.Dispatch<React.SetStateAction<number>>;
} {
  const {
    videoRef,
    mediaId,
    displayCues,
    secondaryCues,
    subOffset,
    subOffsetRef,
    primaryCuesRef,
    secondaryCuesRef,
    loopRef,
    internalSeekRef,
    autopauseRef,
    echoRef,
    apModeRef,
    apMinRef,
    cueUnknownsRef,
    cueUnknownLemmasRef,
    hudOpenRef,
    setHudTick,
    sessCuesRef,
    sessPassedRef,
    sessClearRef,
    sessUnknownSetRef,
    setEchoCue,
    setEchoInput,
    setEchoResult,
    echoInputRef,
    tmEvent,
    toast,
  } = opts;

  const [activeP, setActiveP] = useState(-1);
  const [activeS, setActiveS] = useState(-1);
  const prevActiveP = useRef(-1);
  const lastAutopausedIdx = useRef(-1);

  // --- active cue tracking via timeupdate (+ autopause at each cue end) ---
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    // This effect re-runs when subOffset or the cue arrays change (e.g. [/]
    // nudges, streaming whisper cues shifting indices) — NOT just on playback.
    // Resync the previous-active index to the CURRENT position and skip the
    // autopause branch on the first onTime call so re-setup can't spuriously
    // pause the video.
    prevActiveP.current = activeCueIndex(displayCues, v.currentTime - subOffset);
    let firstRun = true;
    const onTime = () => {
      const wasFirst = firstRun;
      firstRun = false;
      // Track-time for the PRIMARY track: subtract the user's sync offset.
      const t = v.currentTime - subOffset;
      const idx = activeCueIndex(displayCues, t);
      // Shadowing loop: on reaching the looped cue's end, seek back to its
      // start and keep playing. Takes precedence over autopause (the early
      // return below skips the autopause branch entirely while looping).
      const loop = loopRef.current;
      if (loop && !wasFirst && !v.seeking && !v.paused) {
        const cue = displayCues[loop.idx];
        if (!cue) {
          loopRef.current = null; // cue list changed under us — release
        } else if (t >= cue.end) {
          if (loop.remaining !== Infinity && --loop.remaining <= 0) {
            loopRef.current = null; // count exhausted → release and continue
            toast("loop done");
          } else {
            internalSeekRef.current = true;
            v.currentTime = Math.max(0, cue.start + subOffset);
            prevActiveP.current = loop.idx;
            setActiveP(loop.idx);
            setActiveS(activeCueIndex(secondaryCues, v.currentTime));
            return;
          }
        }
      }
      // Autopause: pause exactly at the END of the cue the user just heard.
      // By the time `idx` changes the next subtitle would already be shown, so
      // we seek back to just before the finished cue's end — it stays rendered
      // while paused. lastAutopausedIdx prevents re-triggering in a loop.
      const prev = prevActiveP.current;
      // Echo mode forces a pause at EVERY cue end (regardless of autopause),
      // except cues too short to dictate; otherwise normal (smart) autopause.
      const echo = echoRef.current;
      if ((autopauseRef.current || echo) && !wasFirst && !v.seeking && !v.paused) {
        const prevCue = prev >= 0 ? displayCues[prev] : undefined;
        const leftCue =
          prevCue != null && (idx !== prev || t >= prevCue.end);
        if (leftCue && lastAutopausedIdx.current !== prev) {
          // Smart mode: only pause when the finished cue had >= N unknown
          // lexical tokens. No data for THIS cue (counts not computed yet,
          // or a streaming whisper cue appended after the last compute) →
          // pause, the same safe default as a missing counts array.
          const cueCount = cueUnknownsRef.current?.[prev];
          const skip = shouldSkipAutopause({
            echo,
            mode: apModeRef.current,
            min: apMinRef.current,
            cueText: prevCue!.text,
            unknownCount: cueCount ?? null,
          });
          if (skip) {
            lastAutopausedIdx.current = prev; // don't re-check this cue
          } else {
          lastAutopausedIdx.current = prev;
          v.pause();
          internalSeekRef.current = true;
          v.currentTime = Math.max(prevCue!.start, prevCue!.end - 0.08) + subOffset;
          // keep the finished cue active/rendered
          prevActiveP.current = prev;
          setActiveP(prev);
          setActiveS(activeCueIndex(secondaryCues, v.currentTime));
          if (echo) {
            // open the dictation input over the (hidden) line, focus it
            setEchoCue({ idx: prev, text: prevCue!.text });
            setEchoInput("");
            setEchoResult(null);
            setTimeout(() => echoInputRef.current?.focus(), 0);
          }
          return;
          }
        }
      }
      // Once playback naturally moves into a NEW cue, allow autopausing again.
      if (idx >= 0 && idx !== prev && idx !== lastAutopausedIdx.current) {
        lastAutopausedIdx.current = -1;
      }
      if (idx >= 0 && idx !== prev) {
        sessCuesRef.current += 1;
        // Telemetry: one event per distinct cue entered during playback (not
        // on seeks — onSeeking resets prevActiveP). Low-frequency by nature
        // (fires only on cue change); feeds the Home "today" cues-watched tile.
        if (!v.paused) tmEvent("cue_active", { mediaId, idx });
        // HUD comprehension + unique-unknown tracking on each cue we pass
        const counts = cueUnknownsRef.current;
        if (counts && prev >= 0 && prev < counts.length) {
          sessPassedRef.current += 1;
          if (counts[prev] === 0) sessClearRef.current += 1;
        }
        const lemmas = cueUnknownLemmasRef.current?.[prev];
        if (lemmas) for (const w of lemmas) sessUnknownSetRef.current.add(w);
        if (hudOpenRef.current) setHudTick((tk) => tk + 1);
      }
      prevActiveP.current = idx;
      setActiveP(idx);
      setActiveS(activeCueIndex(secondaryCues, v.currentTime));
    };
    // Manual seeks reset the autopause guard and must not trigger a pause.
    const onSeeking = () => {
      if (internalSeekRef.current) {
        internalSeekRef.current = false;
        return;
      }
      lastAutopausedIdx.current = -1;
      loopRef.current = null; // manual seek releases the shadowing loop
      prevActiveP.current = activeCueIndex(displayCues, v.currentTime - subOffset);
    };
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("seeking", onSeeking);
    onTime();
    return () => {
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("seeking", onSeeking);
    };
  }, [displayCues, secondaryCues, subOffset, toast]);

  // keep refs in sync for the (deps-stable) hotkey handler
  useEffect(() => {
    primaryCuesRef.current = displayCues;
  }, [displayCues]);
  useEffect(() => {
    secondaryCuesRef.current = secondaryCues;
  }, [secondaryCues]);

  return { activeP, activeS, setActiveP, setActiveS };
}
