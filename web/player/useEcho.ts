// Echo dictation mode (`e`) for the Player. Extracted from Player.tsx verbatim
// — no behavior changes. Owns the echo state/refs (echoRef, echoCue+ref,
// echoInput, echoResult, echoInputRef) and the toggle / keydown callbacks.
//
// SHARED refs stay owned by Player and are passed IN as opts:
//  - internalSeekRef is written here (Tab replay) AND by useActiveCues — same
//    Player-owned instance, never forked.
//  - sessEchoRef belongs to useSession (mutated here on check/reveal); until
//    that hook exists it's a Player-owned ref, still passed in.
// activeCues calls the returned setEchoCue/setEchoInput/setEchoResult and
// focuses echoInputRef; echoRef is read by activeCues + hotkeys — all returned.

import { useCallback, useEffect, useRef, useState } from "react";
import { type Cue } from "../api.ts";
import { scoreDictation } from "../dictation.ts";

export function useEcho(opts: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  displayCues: Cue[];
  subOffsetRef: React.RefObject<number>;
  internalSeekRef: React.RefObject<boolean>;
  sessEchoRef: React.RefObject<{ tried: number; perfect: number }>;
  toast: (m: string) => void;
}) {
  const { videoRef, displayCues, subOffsetRef, internalSeekRef, sessEchoRef, toast } = opts;

  const echoRef = useRef(false);
  // when paused at a cue end in echo mode, this holds the cue being dictated
  const [echoCue, setEchoCue] = useState<{ idx: number; text: string } | null>(null);
  const echoCueRef = useRef<typeof echoCue>(null);
  useEffect(() => {
    echoCueRef.current = echoCue;
  }, [echoCue]);
  const [echoInput, setEchoInput] = useState("");
  const [echoResult, setEchoResult] = useState<ReturnType<typeof scoreDictation> | null>(null);
  const echoInputRef = useRef<HTMLInputElement | null>(null);
  const toggleEcho = useCallback(() => {
    const next = !echoRef.current;
    echoRef.current = next;
    if (!next) {
      setEchoCue(null);
      setEchoInput("");
      setEchoResult(null);
    }
    toast(next ? "echo on" : "echo off");
  }, [toast]);

  // Echo input keys: Enter = check (then resume on a 2nd Enter), Esc = reveal,
  // Tab = replay the cue audio. All intercepted so global hotkeys stay dead.
  const onEchoKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      const cue = echoCueRef.current;
      const v = videoRef.current;
      if (!cue || !v) return;
      if (e.key === "Enter") {
        if (e.nativeEvent.isComposing) return; // IME selection, not submit
        e.preventDefault();
        if (echoResult == null) {
          const res = scoreDictation(cue.text, echoInput);
          setEchoResult(res);
          sessEchoRef.current.tried += 1;
          if (res.total > 0 && res.correct === res.total)
            sessEchoRef.current.perfect += 1;
        } else {
          // already revealed → resume playback into the next cue
          setEchoCue(null);
          setEchoInput("");
          setEchoResult(null);
          void v.play().catch(() => {});
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        // give up → reveal the answer (score against empty input)
        if (echoResult == null) {
          setEchoResult(scoreDictation(cue.text, echoInput));
          sessEchoRef.current.tried += 1;
        }
      } else if (e.key === "Tab") {
        e.preventDefault();
        // replay the cue audio from its start, then keep the input focused
        const c = displayCues[cue.idx];
        if (c) {
          internalSeekRef.current = true;
          v.currentTime = Math.max(0, c.start + subOffsetRef.current);
          void v.play().catch(() => {});
        }
      }
    },
    [echoInput, echoResult, displayCues],
  );

  return {
    echoRef,
    echoCue,
    setEchoCue,
    echoInput,
    setEchoInput,
    echoResult,
    setEchoResult,
    echoInputRef,
    toggleEcho,
    onEchoKeyDown,
  };
}
