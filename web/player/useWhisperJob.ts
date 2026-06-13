// Whisper job lifecycle for the Player: start, SSE attach with coalesced cue
// flushing, bounded re-attach on stream errors, and post-reload rediscovery
// of an already-running job. Extracted from Player.tsx (no behavior changes).

import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Cue, type SubTrackInfo } from "../api.ts";
import { isJaLang } from "../lang.ts";

export interface WhisperJob {
  whisperBusy: boolean;
  whisperStatus: string;
  whisperLastEnd: number;
  /** Live cues streamed by a running job (separate from track cues). */
  whisperCues: Cue[];
  /** id of the running job, null when idle — read by the cue-load effect. */
  whisperJobRef: React.RefObject<string | null>;
  /** Drop leftover live cues (stale once a real track loads). */
  clearWhisperCues: () => void;
  onGenerateJa: () => Promise<void>;
  onCancelWhisper: () => Promise<void>;
}

export function useWhisperJob(opts: {
  mediaId: string;
  toast: (msg: string) => void;
  setTracks: (ts: SubTrackInfo[]) => void;
  setPrimaryId: (id: string) => void;
  /** false once the Player unmounted — kills pending re-attach timers */
  mountedRef: React.RefObject<boolean>;
}): WhisperJob {
  const { mediaId, toast, setTracks, setPrimaryId, mountedRef } = opts;

  const [whisperBusy, setWhisperBusy] = useState(false);
  const [whisperStatus, setWhisperStatus] = useState<string>("");
  const [whisperLastEnd, setWhisperLastEnd] = useState(0);
  const [whisperCues, setWhisperCues] = useState<Cue[]>([]);
  const whisperJobRef = useRef<string | null>(null);
  const whisperEsRef = useRef<EventSource | null>(null);
  const whisperRetryRef = useRef(0);
  const attachWhisperRef = useRef<(jobId: string) => void>(() => {});
  const retryAttachRef = useRef<() => void>(() => {});

  // Attach the SSE stream of a whisper job (new or rediscovered after reload)
  // and drive the progress UI + live cues from it.
  const attachWhisper = useCallback(
    (jobId: string) => {
      whisperJobRef.current = jobId;
      const liveCues: Cue[] = [];
      // Coalesce the per-cue state updates: whisper streams hundreds of cues
      // over a long episode; a setState per cue floods React and can crash the
      // tab. Flush at most ~4×/sec, plus an immediate flush on terminal status.
      let flushTimer: number | null = null;
      let dirty = false;
      const flush = () => {
        flushTimer = null;
        if (!dirty) return;
        dirty = false;
        setWhisperCues(liveCues.slice());
        setWhisperLastEnd(liveCues.length ? liveCues[liveCues.length - 1]!.end : 0);
      };
      const scheduleFlush = () => {
        dirty = true;
        if (flushTimer == null) flushTimer = window.setTimeout(flush, 250);
      };
      // Never two live streams: a rediscovery attach racing a user-initiated
      // one would otherwise leak the previous EventSource (and flicker cues
      // between two competing liveCues arrays).
      whisperEsRef.current?.close();
      const es = new EventSource(api.whisperEventsUrl(jobId));
      whisperEsRef.current = es;
      es.onopen = () => {
        whisperRetryRef.current = 0; // healthy connection → reset retry budget
      };
      es.onmessage = (ev) => {
        let data:
          | { type: "snapshot"; status: string; cues: Cue[] }
          | { type: "status"; status: string; error?: string }
          | { type: "cue"; cue: Cue };
        try {
          data = JSON.parse(ev.data as string) as typeof data;
        } catch {
          return; // one malformed event must not kill the handler
        }
        if (data.type === "snapshot") {
          liveCues.length = 0;
          liveCues.push(...data.cues);
          scheduleFlush();
          setWhisperStatus(data.status);
        } else if (data.type === "cue") {
          liveCues.push(data.cue);
          scheduleFlush();
        } else if (data.type === "status") {
          setWhisperStatus(data.status);
          if (
            data.status === "done" ||
            data.status === "error" ||
            data.status === "canceled"
          ) {
            if (flushTimer != null) window.clearTimeout(flushTimer);
            flush();
            es.close();
            whisperEsRef.current = null;
            setWhisperBusy(false);
            whisperJobRef.current = null;
            if (data.status === "done") {
              // refresh tracks and switch to the freshly-generated JP track
              void api.subs(mediaId).then((ts) => {
                setTracks(ts);
                const ja =
                  ts.find((t) => t.id === "sidecar:gen:ja") ??
                  ts.find((t) => t.id === "sidecar:ja") ??
                  ts.find((t) => isJaLang(t.lang));
                if (ja) setPrimaryId(ja.id);
              });
              toast("Japanese subtitles generated");
            } else if (data.status === "error") {
              toast(`Whisper: ${data.error ?? "error"}`);
            }
          }
        }
      };
      es.onerror = () => {
        if (flushTimer != null) window.clearTimeout(flushTimer);
        flush();
        es.close();
        if (whisperEsRef.current === es) whisperEsRef.current = null;
        // The job keeps running server-side — retry the SSE attach (bounded)
        // via /api/whisper/active rediscovery instead of going idle.
        retryAttachRef.current();
      };
    },
    [mediaId, toast, setTracks, setPrimaryId],
  );
  useEffect(() => {
    attachWhisperRef.current = attachWhisper;
  }, [attachWhisper]);

  // Bounded SSE re-attach: up to 5 attempts ~2s apart; only then clear busy.
  const retryAttach = useCallback(() => {
    if (whisperRetryRef.current >= 5) {
      setWhisperBusy(false);
      whisperJobRef.current = null;
      return;
    }
    whisperRetryRef.current += 1;
    window.setTimeout(() => {
      if (!mountedRef.current) return; // Player unmounted — no orphan SSE
      if (whisperEsRef.current != null) return; // already reattached
      void api
        .whisperActive(mediaId)
        .then((r) => {
          if (r.jobId) attachWhisperRef.current(r.jobId);
          else {
            // job actually finished/disappeared while we were detached
            setWhisperBusy(false);
            whisperJobRef.current = null;
          }
        })
        .catch(() => retryAttachRef.current());
    }, 2000);
  }, [mediaId, mountedRef]);
  useEffect(() => {
    retryAttachRef.current = retryAttach;
  }, [retryAttach]);

  const onGenerateJa = useCallback(async () => {
    setWhisperBusy(true);
    setWhisperStatus("starting…");
    setWhisperLastEnd(0);
    setWhisperCues([]);
    whisperRetryRef.current = 0;
    try {
      // Server dedups: an already-active job for this file returns its id.
      const { jobId } = await api.whisperStart(mediaId, "ja");
      attachWhisper(jobId);
    } catch (e) {
      setWhisperBusy(false);
      toast(`Whisper start failed: ${e instanceof Error ? e.message : e}`);
    }
  }, [mediaId, toast, attachWhisper]);

  // Rediscover a running whisper job after a page reload and reattach its SSE
  // so the progress UI resumes instead of offering a duplicate Generate.
  useEffect(() => {
    let cancelled = false;
    void api
      .whisperActive(mediaId)
      .then((r) => {
        if (cancelled || !r.jobId) return;
        setWhisperBusy(true);
        setWhisperStatus(r.status ?? "running");
        setWhisperLastEnd(0);
        attachWhisper(r.jobId);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      whisperEsRef.current?.close();
      whisperEsRef.current = null;
    };
  }, [mediaId, attachWhisper]);

  const onCancelWhisper = useCallback(async () => {
    if (whisperJobRef.current) await api.whisperCancel(whisperJobRef.current);
  }, []);

  const clearWhisperCues = useCallback(() => {
    setWhisperCues((w) => (w.length ? [] : w));
  }, []);

  return {
    whisperBusy,
    whisperStatus,
    whisperLastEnd,
    whisperCues,
    whisperJobRef,
    clearWhisperCues,
    onGenerateJa,
    onCancelWhisper,
  };
}
