// Subtitle offset + scale controls for the Player, plus the OP/ED skip-gap
// pill. Extracted from Player.tsx verbatim — no behavior changes.
//
// - Offset (`[` / `]` / `\`): per-(episode,track) persisted in localStorage.
//   `subOffsetRef` is shared infrastructure OWNED BY Player (read by hotkeys,
//   the active-cue effect, lookup) — it is passed in and kept in sync here, not
//   created here.
// - Scale (Shift+= / Shift+-): persisted in settings.subScale (debounced save).
// - Skip-gap: a transient "Skip →" target while playback sits in a >60s hole
//   in the primary cues; uses the pure findSkipTarget from skipGap.ts.

import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Cue } from "../api.ts";
import { findSkipTarget } from "./skipGap.ts";

export interface SubControls {
  subOffset: number;
  changeOffset: (delta: number | null) => void;
  subScale: number;
  adjustSubScale: (delta: number) => void;
  skipTarget: number | null;
  onSkipGap: () => void;
}

const clampSubScale = (v: number) =>
  Math.min(2, Math.max(0.6, Math.round(v * 10) / 10));

export function useSubControls(opts: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  /** Shared infra ref owned by Player; kept in sync with subOffset state. */
  subOffsetRef: React.RefObject<number>;
  /** entry.id */
  mediaId: string;
  primaryId: string;
  displayCues: Cue[];
  settings: Record<string, unknown>;
  toast: (msg: string) => void;
}): SubControls {
  const { videoRef, subOffsetRef, mediaId, primaryId, displayCues, settings, toast } =
    opts;

  // --- subtitle offset (per episode + track), restored from localStorage ---
  const [subOffset, setSubOffset] = useState(0);
  useEffect(() => {
    let v = 0;
    try {
      v =
        parseFloat(
          localStorage.getItem(`zr.offset.${mediaId}.${primaryId}`) ?? "0",
        ) || 0;
    } catch {
      /* ignore */
    }
    subOffsetRef.current = v;
    setSubOffset(v);
  }, [mediaId, primaryId]);

  const changeOffset = useCallback(
    (delta: number | null) => {
      const next =
        delta == null ? 0 : Math.round((subOffsetRef.current + delta) * 10) / 10;
      subOffsetRef.current = next;
      setSubOffset(next);
      try {
        const key = `zr.offset.${mediaId}.${primaryId}`;
        if (next === 0) localStorage.removeItem(key);
        else localStorage.setItem(key, String(next));
      } catch {
        /* ignore */
      }
      toast(`subs ${next >= 0 ? "+" : ""}${next.toFixed(1)}s`);
    },
    [mediaId, primaryId, toast],
  );

  // --- subtitle scale (Shift+= / Shift+-): multiplies the overlay's clamp()
  // font sizes via the --sub-scale CSS var; persisted in settings.subScale ---
  const [subScale, setSubScale] = useState(() => {
    const v = Number(settings.subScale);
    return Number.isFinite(v) && v > 0 ? clampSubScale(v) : 1;
  });
  // settings load async — adopt the saved value once it arrives, unless the
  // user already adjusted the scale this session
  const subScaleTouchedRef = useRef(false);
  useEffect(() => {
    if (subScaleTouchedRef.current) return;
    const v = Number(settings.subScale);
    if (Number.isFinite(v) && v > 0) setSubScale(clampSubScale(v));
  }, [settings.subScale]);
  const subScaleSaveTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (subScaleSaveTimer.current != null)
        window.clearTimeout(subScaleSaveTimer.current);
    },
    [],
  );
  const adjustSubScale = useCallback(
    (delta: number) => {
      subScaleTouchedRef.current = true;
      setSubScale((prev) => {
        const next = clampSubScale(prev + delta);
        toast(`subs ×${next.toFixed(1)}`);
        // debounce the autosave (same settings store the Settings page uses)
        if (subScaleSaveTimer.current != null)
          window.clearTimeout(subScaleSaveTimer.current);
        subScaleSaveTimer.current = window.setTimeout(() => {
          subScaleSaveTimer.current = null;
          void api.saveSettings({ subScale: next }).catch(() => {});
        }, 600);
        return next;
      });
    },
    [toast],
  );

  // --- OP/ED skip heuristic: a >60s hole in the primary cues means no
  // dialogue (opening/ending/silence). While playback sits inside such a hole
  // (and past the first 10s of the file) offer a transient "Skip →" pill that
  // jumps to 1s before the next cue. No auto-skip — the user decides.
  const [skipTarget, setSkipTarget] = useState<number | null>(null);
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const cues = displayCues;
    const upd = () => {
      const target = findSkipTarget(cues, v.currentTime, subOffset);
      setSkipTarget((prev) => (prev === target ? prev : target));
    };
    v.addEventListener("timeupdate", upd);
    v.addEventListener("seeked", upd);
    upd();
    return () => {
      v.removeEventListener("timeupdate", upd);
      v.removeEventListener("seeked", upd);
    };
  }, [displayCues, subOffset]);
  const onSkipGap = useCallback(() => {
    const v = videoRef.current;
    if (v && skipTarget != null) v.currentTime = skipTarget;
  }, [skipTarget]);

  return { subOffset, changeOffset, subScale, adjustSubScale, skipTarget, onSkipGap };
}
