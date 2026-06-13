// Auto-resume lifecycle (extracted from Player.tsx, Phase 4 step 3 — no
// behavior changes). Owns the three-flag handshake that makes the auto-resume
// vs deep-link decision handler-order independent:
//
//   - startAtRef    : the pending deep-link "@t" seek; nulled once consumed.
//   - hasDeepLinkRef: sticky for the current episode load — once a deep-link
//                     was provided it stays true so auto-resume can never
//                     override the deep-link seek regardless of loadedmetadata
//                     handler ordering.
//   - autoResumedRef: fires auto-resume at most once per episode load.
//
// The FOUR effects are kept separate with their exact dependency arrays
// (`[mediaId]`, `[startAt]`, `[mediaId]`, `[mediaId]`) — do NOT merge them.

import { useEffect, useRef } from "react";
import { pickResumeTime } from "./resume.ts";

export function useResume(opts: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  mediaId: string;
  startAt?: number;
}): void {
  const { videoRef, mediaId, startAt } = opts;

  // --- resume position: save throttled while playing, restore on metadata ---
  // A deep-link start time (#/play/<id>@t) wins over the saved position, once.
  const startAtRef = useRef<number | null>(
    typeof startAt === "number" && Number.isFinite(startAt) && startAt >= 0
      ? startAt
      : null,
  );
  // Sticky flag: an explicit deep-link "@t" was provided for the CURRENT
  // episode load. Unlike startAtRef (which is nulled once consumed), this stays
  // true so the auto-resume path can never override the deep-link seek
  // regardless of loadedmetadata handler ordering.
  const hasDeepLinkRef = useRef(startAtRef.current != null);
  useEffect(() => {
    hasDeepLinkRef.current = false;
  }, [mediaId]);
  // Re-navigating to the same episode with a new "@t" doesn't remount the
  // Player (key={entry.id} is unchanged), so consume prop changes here too.
  useEffect(() => {
    if (!(typeof startAt === "number" && Number.isFinite(startAt) && startAt >= 0)) return;
    const v = videoRef.current;
    hasDeepLinkRef.current = true;
    if (v && v.readyState >= 1) {
      v.currentTime = Math.min(v.duration || Infinity, startAt);
      startAtRef.current = null;
    } else {
      startAtRef.current = startAt; // metadata not loaded yet — onMeta seeks
    }
  }, [startAt]);
  // Guard: auto-resume fires at most once per episode load (per onMeta run).
  const autoResumedRef = useRef(false);
  useEffect(() => {
    autoResumedRef.current = false;
  }, [mediaId]);
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const posKey = `zr.pos.${mediaId}`;
    let lastSave = 0;
    const onTime = () => {
      if (v.paused) return;
      const now = Date.now();
      if (now - lastSave < 5000) return;
      lastSave = now;
      try {
        localStorage.setItem(posKey, String(v.currentTime));
        // recency stamp powers the Home "continue watching" affordance
        localStorage.setItem(`zr.posAt.${mediaId}`, String(now));
      } catch {
        /* ignore */
      }
    };
    const onMeta = () => {
      if (startAtRef.current != null) {
        v.currentTime = Math.min(v.duration || Infinity, startAtRef.current);
        startAtRef.current = null;
        return;
      }
      // Auto-resume: no explicit deep-link, so jump to the saved position
      // once. Skips near-start (<15s) / near-end (within 10s of duration).
      // An explicit deep-link "@t" ALWAYS wins: bail even if startAtRef was
      // already consumed by the deep-link effect (handler-order independent).
      if (hasDeepLinkRef.current) return;
      if (autoResumedRef.current) return;
      try {
        const saved = parseFloat(localStorage.getItem(posKey) ?? "");
        const target = pickResumeTime({ saved, duration: v.duration });
        if (target != null) {
          autoResumedRef.current = true;
          v.currentTime = target;
        }
      } catch {
        /* ignore */
      }
    };
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("loadedmetadata", onMeta);
    if (v.readyState >= 1) onMeta();
    return () => {
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("loadedmetadata", onMeta);
    };
  }, [mediaId]);
}
