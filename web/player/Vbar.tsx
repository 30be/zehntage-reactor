// Custom video controls bar (replaces the native <video controls>): seekbar
// with difficulty-heat density strip + hover time tip, play/pause, time
// readout, CC popover (track selection + contextual actions), volume and
// fullscreen. Extracted from Player.tsx (no behavior changes).
//
// Shared-with-parent refs: scrubbingRef / barHoverRef / ccOpenRef keep the
// HUD autohide logic in Player.tsx aware of the bar's interaction state.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Cue, SubTrackInfo } from "../api.ts";
import { heatBins, heatAlpha } from "../heat.ts";
import { isJaLang, isRuLang } from "../lang.ts";
import {
  PlayIcon,
  PauseIcon,
  VolumeIcon,
  VolumeXIcon,
  MaximizeIcon,
  CaptionsIcon,
} from "../icons.tsx";
import { fmtTime, langLabel } from "./shared.ts";
import { activeCueIndex } from "../cues.ts";
import { iPlusOneIndices } from "../iplusone.ts";

export function Vbar({
  videoRef,
  mediaKey,
  videoDuration,
  isPaused,
  togglePlay,
  toggleFullscreen,
  displayCues,
  secondaryCues,
  cueUnknowns,
  dueCueIndices,
  tracks,
  primaryId,
  secondaryId,
  setPrimaryId,
  setSecondaryId,
  whisperBusy,
  translateBusy,
  condenseBusy,
  onGenerateJa,
  onTranslateRu,
  onCondense,
  scrubbingRef,
  barHoverRef,
  ccOpenRef,
}: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  /** entry id — re-binds the <video> listeners when the episode changes */
  mediaKey: string;
  videoDuration: number;
  isPaused: boolean;
  togglePlay: () => void;
  toggleFullscreen: () => void;
  displayCues: Cue[];
  secondaryCues?: Cue[];
  cueUnknowns: number[] | null;
  /** F6: indices (into displayCues) of cues holding a due deck word. */
  dueCueIndices: number[];
  tracks: SubTrackInfo[];
  primaryId: string;
  secondaryId: string;
  setPrimaryId: (id: string) => void;
  setSecondaryId: (id: string) => void;
  whisperBusy: boolean;
  translateBusy: boolean;
  condenseBusy: boolean;
  onGenerateJa: () => void;
  onTranslateRu: () => void;
  onCondense: () => void;
  scrubbingRef: React.RefObject<boolean>;
  barHoverRef: React.RefObject<boolean>;
  ccOpenRef: React.RefObject<boolean>;
}) {
  // --- dialogue-density strip: 2s bins, alpha = speech seconds per bin ---
  const densityCanvasRef = useRef<HTMLCanvasElement>(null);
  const densityMarkerRef = useRef<HTMLDivElement>(null);
  const hasDensity = displayCues.length > 0 && videoDuration > 0;
  useEffect(() => {
    const c = densityCanvasRef.current;
    if (!c || !hasDensity) return;
    // Difficulty heat (web/heat.ts): 2s bins; brightness encodes the unknown-
    // word ratio per cue (heatAlpha), empty bins stay transparent. Degrades to
    // plain density while the per-cue unknown counts are still computing.
    const bins = heatBins(displayCues, cueUnknowns ?? [], 2, videoDuration);
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const cssW = c.clientWidth || 640;
      c.width = Math.max(1, Math.round(cssW * dpr));
      c.height = Math.max(1, Math.round(4 * dpr));
      const ctx = c.getContext("2d");
      if (!ctx) return;
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      ctx.fillRect(0, 0, c.width, c.height);
      const px = c.width / Math.max(1, bins.length);
      for (let b = 0; b < bins.length; b++) {
        const a = heatAlpha(bins[b]!);
        if (a <= 0.01) continue;
        ctx.fillStyle = `rgba(255,255,255,${a.toFixed(3)})`;
        ctx.fillRect(b * px, 0, Math.ceil(px), c.height);
      }
    };
    draw();
    // redraw at the new CSS width on layout changes (fullscreen, resize) —
    // otherwise the bitmap keeps its old width and stretches blurry.
    const ro = new ResizeObserver(draw);
    ro.observe(c);
    return () => ro.disconnect();
  }, [displayCues, videoDuration, hasDensity, cueUnknowns]);

  // current-position marker: cheap direct-DOM left% update, no React re-render
  useEffect(() => {
    const v = videoRef.current;
    const m = densityMarkerRef.current;
    if (!v || !m) return;
    const upd = () => {
      if (!(v.duration > 0)) return;
      const pct = (v.currentTime / v.duration) * 100;
      m.style.left = `${pct}%`;
      if (playedRef.current) playedRef.current.style.width = `${pct}%`;
    };
    v.addEventListener("timeupdate", upd);
    v.addEventListener("seeking", upd);
    upd();
    return () => {
      v.removeEventListener("timeupdate", upd);
      v.removeEventListener("seeking", upd);
    };
  }, [mediaKey]);

  const seekRef = useRef<HTMLDivElement>(null);
  const playedRef = useRef<HTMLDivElement>(null);
  const [seekHover, setSeekHover] = useState<{ x: number; t: number } | null>(
    null,
  );

  // mm:ss readout — timeupdate fires ~4×/s, cheap enough for a state update
  const [curTime, setCurTime] = useState(0);
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const upd = () => setCurTime(v.currentTime);
    v.addEventListener("timeupdate", upd);
    v.addEventListener("seeked", upd);
    upd();
    return () => {
      v.removeEventListener("timeupdate", upd);
      v.removeEventListener("seeked", upd);
    };
  }, [mediaKey]);

  // volume / mute mirrors (ArrowUp/Down hotkeys change v.volume directly)
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const upd = () => {
      setVolume(v.volume);
      setMuted(v.muted);
    };
    v.addEventListener("volumechange", upd);
    upd();
    return () => v.removeEventListener("volumechange", upd);
  }, [mediaKey]);

  // --- CC popover (track selection + contextual actions), anchored above the
  // vbar. Esc / click-away closes; opening pins the HUD visible. ---
  const [ccOpen, setCcOpen] = useState(false);
  useEffect(() => {
    ccOpenRef.current = ccOpen;
  }, [ccOpen, ccOpenRef]);
  const ccRef = useRef<HTMLDivElement>(null);
  const ccBtnRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!ccOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (t && (ccRef.current?.contains(t) || ccBtnRef.current?.contains(t)))
        return;
      setCcOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setCcOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [ccOpen]);

  const seekToClientX = useCallback(
    (clientX: number) => {
      const bar = seekRef.current;
      const v = videoRef.current;
      if (!bar || !v || !(v.duration > 0)) return;
      const r = bar.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
      v.currentTime = frac * v.duration;
    },
    [videoRef],
  );
  const hoverTimeAt = useCallback(
    (clientX: number): { x: number; t: number } | null => {
      const bar = seekRef.current;
      const v = videoRef.current;
      if (!bar || !v || !(v.duration > 0)) return null;
      const r = bar.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
      return { x: frac * r.width, t: frac * v.duration };
    },
    [videoRef],
  );
  const onSeekDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      scrubbingRef.current = true;
      seekToClientX(e.clientX);
      setSeekHover(hoverTimeAt(e.clientX));
    },
    [seekToClientX, hoverTimeAt, scrubbingRef],
  );
  const onSeekMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      setSeekHover(hoverTimeAt(e.clientX));
      if (scrubbingRef.current) seekToClientX(e.clientX);
    },
    [seekToClientX, hoverTimeAt, scrubbingRef],
  );
  const onSeekUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      scrubbingRef.current = false;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    },
    [scrubbingRef],
  );
  const onSeekLeave = useCallback(() => {
    if (!scrubbingRef.current) setSeekHover(null);
  }, [scrubbingRef]);

  // --- F6: seekbar cue heatmap. Thin ticks at the timeline positions of
  // study-worthy cues: i+1 cues (exactly one unknown — neutral ink) and
  // due-word cues (content-red, since it encodes word state). Positioned by
  // cue.start / duration; pointer-events:none so scrubbing/tooltip stay intact.
  const iPlusOneMarks = useMemo(() => {
    if (!(videoDuration > 0)) return [];
    return iPlusOneIndices(cueUnknowns)
      .map((i) => displayCues[i]?.start)
      .filter((t): t is number => t != null)
      .map((t) => (t / videoDuration) * 100);
  }, [cueUnknowns, displayCues, videoDuration]);
  const dueMarks = useMemo(() => {
    if (!(videoDuration > 0)) return [];
    return dueCueIndices
      .map((i) => displayCues[i]?.start)
      .filter((t): t is number => t != null)
      .map((t) => (t / videoDuration) * 100);
  }, [dueCueIndices, displayCues, videoDuration]);

  const hasJa = tracks.some((t) => isJaLang(t.lang));
  // Only a GENERATED (synced) RU track hides the Translate button; external or
  // embedded RU tracks are often out of sync with the JA track.
  const hasGeneratedRu = tracks.some(
    (t) => isRuLang(t.lang) && t.origin === "generated",
  );
  const primaryTrackLang = tracks.find((t) => t.id === primaryId)?.lang ?? "";

  return (
    <div className="vbar">
      <div
        ref={seekRef}
        className="seekbar"
        onPointerDown={onSeekDown}
        onPointerMove={onSeekMove}
        onPointerUp={onSeekUp}
        onPointerCancel={onSeekUp}
        onPointerLeave={onSeekLeave}
      >
        {hasDensity && (
          <canvas
            ref={densityCanvasRef}
            className="density-strip"
            title="Dialogue density — brighter = more unknown words; click to seek"
          />
        )}
        <div ref={playedRef} className="seek-played" />
        {iPlusOneMarks.map((pct, i) => (
          <div
            key={`ip-${i}`}
            className="seek-marker seek-marker-iplus"
            style={{ left: `${pct}%` }}
          />
        ))}
        {dueMarks.map((pct, i) => (
          <div
            key={`due-${i}`}
            className="seek-marker seek-marker-due"
            data-testid="seek-marker-due"
            style={{ left: `${pct}%` }}
          />
        ))}
        <div ref={densityMarkerRef} className="density-marker" />
        {seekHover && (() => {
          const idx = activeCueIndex(displayCues, seekHover.t);
          const jaText = idx >= 0 ? displayCues[idx]!.text : null;
          const ruIdx = secondaryCues
            ? activeCueIndex(secondaryCues, seekHover.t)
            : -1;
          const ruText = ruIdx >= 0 ? secondaryCues![ruIdx]!.text : null;
          return jaText ? (
            <div className="seek-cue-tip" style={{ left: seekHover.x }}>
              <span className="seek-cue-ja">{jaText}</span>
              {ruText && (
                <span className="seek-cue-ru" style={{ opacity: 0.7 }}>
                  {ruText}
                </span>
              )}
            </div>
          ) : null;
        })()}
        {seekHover && (
          <div className="seek-tip" style={{ left: seekHover.x }}>
            {fmtTime(seekHover.t)}
          </div>
        )}
      </div>
      <div
        className="vbar-row"
        onMouseEnter={() => {
          barHoverRef.current = true;
        }}
        onMouseLeave={() => {
          barHoverRef.current = false;
        }}
      >
        <button
          className="vbar-btn vbar-play"
          tabIndex={-1}
          onClick={togglePlay}
          title={isPaused ? "Play (space)" : "Pause (space)"}
          aria-label={isPaused ? "Play" : "Pause"}
        >
          {isPaused ? <PlayIcon /> : <PauseIcon />}
        </button>
        <span className="vbar-time">
          {fmtTime(curTime)} / {fmtTime(videoDuration)}
        </span>
        <span className="vbar-spacer" />
        <button
          ref={ccBtnRef}
          className={`vbar-btn vbar-cc${ccOpen ? " on" : ""}`}
          tabIndex={-1}
          onClick={() => setCcOpen((o) => !o)}
          title="Subtitle tracks"
          aria-label="Subtitle tracks"
        >
          <CaptionsIcon />
        </button>
        <button
          className="vbar-btn vbar-mute"
          tabIndex={-1}
          onClick={() => {
            const v = videoRef.current;
            if (v) v.muted = !v.muted;
          }}
          title={muted ? "Unmute" : "Mute"}
          aria-label={muted ? "Unmute" : "Mute"}
        >
          {muted || volume === 0 ? <VolumeXIcon /> : <VolumeIcon />}
        </button>
        <input
          className="vbar-vol"
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={muted ? 0 : volume}
          tabIndex={-1}
          aria-label="Volume"
          title="Volume (↑/↓)"
          onChange={(e) => {
            const v = videoRef.current;
            if (!v) return;
            v.volume = parseFloat(e.target.value);
            v.muted = false;
          }}
        />
        <button
          className="vbar-btn vbar-fs"
          tabIndex={-1}
          onClick={toggleFullscreen}
          title="Fullscreen (f)"
          aria-label="Fullscreen"
        >
          <MaximizeIcon size={20} />
        </button>
      </div>
      {ccOpen && (
        <div className="cc-pop" ref={ccRef} role="dialog" aria-label="Subtitle tracks">
          <div className="cc-group" role="radiogroup" aria-label="Subtitles">
            <div className="cc-title">Subtitles</div>
            <label className="cc-row">
              <input
                type="radio"
                name="cc-primary"
                value=""
                checked={primaryId === ""}
                onChange={() => setPrimaryId("")}
              />
              <span className="cc-label">off</span>
            </label>
            {tracks.map((t) => (
              <label key={t.id} className="cc-row">
                <input
                  type="radio"
                  name="cc-primary"
                  value={t.id}
                  checked={primaryId === t.id}
                  onChange={() => setPrimaryId(t.id)}
                />
                <span className="cc-label">{langLabel(t)}</span>
              </label>
            ))}
          </div>
          <div className="cc-group" role="radiogroup" aria-label="Translation">
            <div className="cc-title">Translation</div>
            <label className="cc-row">
              <input
                type="radio"
                name="cc-secondary"
                value=""
                checked={secondaryId === ""}
                onChange={() => setSecondaryId("")}
              />
              <span className="cc-label">off</span>
            </label>
            {tracks.map((t) => (
              <label key={t.id} className="cc-row">
                <input
                  type="radio"
                  name="cc-secondary"
                  value={t.id}
                  checked={secondaryId === t.id}
                  onChange={() => setSecondaryId(t.id)}
                />
                <span className="cc-label">{langLabel(t)}</span>
              </label>
            ))}
          </div>
          {((!hasJa && !whisperBusy) ||
            (primaryId &&
              isJaLang(primaryTrackLang) &&
              !hasGeneratedRu &&
              !translateBusy) ||
            (hasJa && !condenseBusy && !whisperBusy)) && (
            <div className="cc-actions">
              {!hasJa && !whisperBusy && (
                <button
                  className="cc-action"
                  title="Transcribe the audio to Japanese subtitles with Whisper"
                  onClick={() => {
                    setCcOpen(false);
                    onGenerateJa();
                  }}
                >
                  + generate ja…
                </button>
              )}
              {primaryId &&
                isJaLang(primaryTrackLang) &&
                !hasGeneratedRu &&
                !translateBusy && (
                  <button
                    className="cc-action"
                    title="Translate the primary track to Russian (saved as a track)"
                    onClick={() => {
                      setCcOpen(false);
                      onTranslateRu();
                    }}
                  >
                    + translate → ru…
                  </button>
                )}
              {hasJa && !condenseBusy && !whisperBusy && (
                <button
                  className="cc-action"
                  title="Concatenate all dialogue audio into one mp3"
                  onClick={() => {
                    setCcOpen(false);
                    onCondense();
                  }}
                >
                  + condensed audio…
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
