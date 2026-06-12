import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  api,
  ApiError,
  mediaUrl,
  type Cue,
  type LibraryEntry,
  type SubTrackInfo,
  type WordLookup,
  type ExplainResult,
} from "./api.ts";
import { activeCueIndex, contextAround } from "./cues.ts";
import { getTokenizer, type KToken } from "./tokenizer.ts";
import { buildWordIndex, type WordIndex } from "./progress.ts";
import { TokenLine, wordKey } from "./TokenLine.tsx";
import { Sidebar } from "./Sidebar.tsx";

interface Props {
  entry: LibraryEntry;
  toast: (msg: string) => void;
  settings: Record<string, unknown>;
}

interface PopupState {
  kind: "word" | "sentence";
  surface: string; // the word, or the whole JP sentence for kind="sentence"
  reading?: string;
  x: number; // horizontal center of the anchored word (viewport coords)
  y: number; // top edge of the anchored word
  anchorBottom: number; // bottom edge of the anchored word
  context: string;
  secondary?: string; // RU cue text shown at the same time (sentence panels)
  dictForm?: string; // basic_form when it differs from the surface (e.g. 食べる)
  timestamp: number;
}

interface QaItem {
  q: string;
  a: string | null; // null while loading
}

const STORAGE_PREFIX = "zr.tracks.";

// api.ts is owned by another agent — widen the call signatures locally to
// thread the new optional context fields without editing it.
const lookupApi = api.lookup as (p: {
  word: string;
  context: string;
  source: string;
  secondary?: string;
  mediaId?: string;
  timestamp?: number;
  withFrame?: boolean;
  noCache?: boolean;
}) => Promise<WordLookup>;
const explainApi = api.explain as (p: {
  sentence: string;
  secondary: string;
  source: string;
  context?: string;
}) => Promise<ExplainResult>;

/** prev/current/next cue texts with the current line marked, for Gemini. */
function markedContext(cues: Cue[], i: number): string {
  if (i < 0 || !cues[i]) return "";
  const lines: string[] = [];
  if (cues[i - 1]) lines.push(`(prev) ${cues[i - 1]!.text}`);
  lines.push(`(current) ${cues[i]!.text}`);
  if (cues[i + 1]) lines.push(`(next) ${cues[i + 1]!.text}`);
  return lines.join("\n");
}

// Module-level Q/A history cache so the ask… thread survives popup close/
// reopen, keyed by kind + word/sentence + context. FIFO-capped at ~100.
const qaCache = new Map<string, QaItem[]>();
const QA_CACHE_MAX = 100;
function qaCachePut(key: string, items: QaItem[]): void {
  if (!qaCache.has(key) && qaCache.size >= QA_CACHE_MAX) {
    const oldest = qaCache.keys().next().value;
    if (oldest !== undefined) qaCache.delete(oldest);
  }
  qaCache.set(key, items);
}

function readSavedTracks(
  mediaId: string,
): { primary?: string; secondary?: string } {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + mediaId);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveTracks(mediaId: string, primary: string, secondary: string): void {
  try {
    localStorage.setItem(
      STORAGE_PREFIX + mediaId,
      JSON.stringify({ primary, secondary }),
    );
  } catch {
    /* ignore quota / disabled storage */
  }
}

function langLabel(t: SubTrackInfo): string {
  // Prefer the backend-provided friendly label ("Japanese · Whisper").
  if (t.label && t.label.trim()) return t.label;
  // Fallback: plain lang code (+ title if present). No sidecar/embedded jargon.
  return t.title ? `${t.lang} · ${t.title}` : t.lang;
}

const HOVER_OPEN_MS = 200; // hover-intent: rest this long before opening/looking up
const HOVER_CLOSE_MS = 120; // grace after leaving the word before hiding

const fmtTime = (s: number): string => {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
};

const isJaLang = (l: string) => l === "ja" || l === "jpn" || l.startsWith("ja");
const isRuLang = (l: string) => l === "ru" || l === "rus" || l.startsWith("ru");

export function Player({ entry, toast, settings }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  // The stage wraps the video + subtitle overlay + lookup popup; fullscreen
  // targets THIS element so the overlays stay visible in fullscreen.
  const stageRef = useRef<HTMLDivElement>(null);

  const [tracks, setTracks] = useState<SubTrackInfo[]>([]);
  const [primaryId, setPrimaryId] = useState<string>("");
  const [secondaryId, setSecondaryId] = useState<string>("");
  const [primaryCues, setPrimaryCues] = useState<Cue[]>([]);
  const [secondaryCues, setSecondaryCues] = useState<Cue[]>([]);
  const [activeP, setActiveP] = useState(-1);
  const [activeS, setActiveS] = useState(-1);
  const [secShow, setSecShow] = useState(false);
  const [autopause, setAutopause] = useState(false);
  const autopauseRef = useRef(false);
  const prevActiveP = useRef(-1);
  // Autopause loop-guard: index of the cue we already autopaused on. We don't
  // pause again for that cue until playback naturally enters the next one.
  const lastAutopausedIdx = useRef(-1);
  // True while WE are performing the autopause seek-back, so the user-seek
  // detector below doesn't treat it as a manual seek.
  const internalSeekRef = useRef(false);
  // True when the video was paused by a hover (word or secondary subtitle),
  // so closing the popup / leaving the line auto-resumes playback.
  const pausedByHoverRef = useRef(false);
  // True while the cursor is over the secondary (RU) line: it holds the hover
  // pause, so a word-popup close timer must NOT resume playback under it.
  const secondaryHoveredRef = useRef(false);
  useEffect(() => {
    autopauseRef.current = autopause;
  }, [autopause]);

  // Primary-subtitle timing offset (seconds). Positive = subs appear later.
  // Persisted per media+track; applied client-side when computing active cues.
  const [subOffset, setSubOffset] = useState(0);
  const subOffsetRef = useRef(0);
  const primaryCuesRef = useRef<Cue[]>([]);

  const [tokens, setTokens] = useState<KToken[] | null>(null);
  const tokenizerReady = useRef(false);
  const tracksLoaded = useRef(false);

  const [wordIndex, setWordIndex] = useState<WordIndex>(() =>
    buildWordIndex([], {}),
  );
  const [knownFronts, setKnownFronts] = useState<Set<string>>(new Set());

  // --- local mark-as-known set (no Anki): zr.known, toggled with `k` ---
  const [knownWords, setKnownWords] = useState<Set<string>>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem("zr.known") ?? "[]");
      return new Set(Array.isArray(raw) ? raw.filter((w) => typeof w === "string") : []);
    } catch {
      return new Set();
    }
  });
  const knownWordsRef = useRef(knownWords);
  useEffect(() => {
    knownWordsRef.current = knownWords;
  }, [knownWords]);
  const toggleKnown = useCallback((key: string) => {
    setKnownWords((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      try {
        localStorage.setItem("zr.known", JSON.stringify([...next]));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);
  // word the cursor currently rests on (for the `k` hotkey before any popup)
  const hoveredKeyRef = useRef<string | null>(null);

  // --- cue-list sidebar (toggled with `l`, persisted) ---
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    try {
      return localStorage.getItem("zr.sidebar") === "1";
    } catch {
      return false;
    }
  });
  const toggleSidebar = useCallback(() => {
    setSidebarOpen((o) => {
      const next = !o;
      try {
        localStorage.setItem("zr.sidebar", next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    const onFs = () => setIsFullscreen(document.fullscreenElement != null);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  const [popup, setPopup] = useState<PopupState | null>(null);
  // Click-to-pin: a pinned panel ignores all hover-out close paths and only
  // closes via Esc, clicking another word, clicking outside, or playback
  // resuming (space / video controls).
  const [pinned, setPinned] = useState(false);
  const pinnedRef = useRef(false);
  useEffect(() => {
    pinnedRef.current = pinned;
  }, [pinned]);
  const lookupRef = useRef<HTMLDivElement>(null);
  const [popupPos, setPopupPos] = useState<React.CSSProperties>({
    visibility: "hidden",
  });
  const [lookup, setLookup] = useState<WordLookup | null>(null);
  const [lookupLoading, setLookupLoading] = useState(false);
  const [frameLoading, setFrameLoading] = useState(false);
  const [frameAdded, setFrameAdded] = useState(false);
  const [reloadLoading, setReloadLoading] = useState(false);
  const lookupCache = useRef<Map<string, WordLookup>>(new Map());
  const inflight = useRef<Map<string, Promise<WordLookup>>>(new Map());

  // sentence-structure explain panel state (same panel chrome as word lookups)
  const [explain, setExplain] = useState<ExplainResult | null>(null);
  const [explainLoading, setExplainLoading] = useState(false);

  // follow-up Q/A inside the panel (cleared when the panel closes)
  const [qa, setQa] = useState<QaItem[]>([]);
  const [askText, setAskText] = useState("");
  const [askBusy, setAskBusy] = useState(false);
  const askInputRef = useRef<HTMLInputElement>(null);
  // While the ask input is focused, the panel must not auto-close on hover-out.
  const askFocusedRef = useRef(false);

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
    void videoRef.current?.play();
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

  const [whisperBusy, setWhisperBusy] = useState(false);
  const [whisperStatus, setWhisperStatus] = useState<string>("");
  const [whisperLastEnd, setWhisperLastEnd] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onMeta = () => setVideoDuration(v.duration || 0);
    v.addEventListener("loadedmetadata", onMeta);
    onMeta();
    return () => v.removeEventListener("loadedmetadata", onMeta);
  }, [entry.id]);
  const [translateBusy, setTranslateBusy] = useState(false);
  const whisperJobRef = useRef<string | null>(null);
  const whisperEsRef = useRef<EventSource | null>(null);
  const whisperRetryRef = useRef(0);
  const attachWhisperRef = useRef<(jobId: string) => void>(() => {});
  const retryAttachRef = useRef<() => void>(() => {});

  // Live cues streamed by a running whisper job. Kept SEPARATE from the
  // user-selected primary track's cues so a batch job can't clobber them;
  // they drive the overlay/sidebar only when no primary track is selected or
  // the selected primary is the whisper-generated ja track-to-be.
  const [whisperCues, setWhisperCues] = useState<Cue[]>([]);
  const whisperLive =
    whisperCues.length > 0 && (!primaryId || primaryId === "sidecar:gen:ja");
  const displayCues = whisperLive ? whisperCues : primaryCues;

  // --- load tracks + anki words ---
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [ts, anki] = await Promise.all([
        api.subs(entry.id).catch(() => []),
        api.ankiWords().catch(() => ({ words: [], progress: {} })),
      ]);
      if (cancelled) return;
      setTracks(ts);
      setWordIndex(buildWordIndex(anki.words, anki.progress));
      setKnownFronts(new Set(anki.words.map((w) => w.front)));

      // Auto-select sensible defaults: prefer a Japanese primary, ru/en secondary.
      const primLang = (settings.targetLang as string) || "ja";
      const secLang = (settings.knownLang as string) || "ru";
      const isJa = (l: string) => l === "jpn" || l === "ja" || l.startsWith("ja");
      const autoPrim =
        ts.find((t) => t.kind === "embedded" && isJa(t.lang)) ??
        ts.find((t) => isJa(t.lang)) ??
        ts.find((t) => t.lang === primLang) ??
        ts.find((t) => t.lang === "ja");
      const autoSec =
        // Prefer a generated (synced) secondary over external/embedded ones.
        ts.find(
          (t) =>
            t.id !== autoPrim?.id && t.origin === "generated" && t.lang === secLang,
        ) ??
        ts.find(
          (t) =>
            t.id !== autoPrim?.id &&
            t.origin === "generated" &&
            t.lang.startsWith("ru"),
        ) ??
        ts.find((t) => t.id !== autoPrim?.id && t.lang === secLang) ??
        ts.find((t) => t.id !== autoPrim?.id && (t.lang === "ru" || t.lang === "ru".slice(0, 2))) ??
        ts.find((t) => t.id !== autoPrim?.id && t.lang.startsWith("ru")) ??
        ts.find((t) => t.id !== autoPrim?.id && (t.lang === "en" || t.lang.startsWith("en")));

      // Restored selection (from localStorage) wins over the auto default.
      const saved = readSavedTracks(entry.id);
      const exists = (id?: string) =>
        id != null && ts.some((t) => t.id === id) ? id : undefined;
      const primId = exists(saved.primary) ?? autoPrim?.id ?? "";
      const secId = exists(saved.secondary) ?? autoSec?.id ?? "";
      setPrimaryId(primId);
      if (secId !== primId) setSecondaryId(secId);
      tracksLoaded.current = true;
    })();
    return () => {
      cancelled = true;
    };
  }, [entry.id]);

  // persist track choices per media id (after initial load completes)
  useEffect(() => {
    if (!tracksLoaded.current) return;
    saveTracks(entry.id, primaryId, secondaryId);
  }, [entry.id, primaryId, secondaryId]);

  // --- load cues when track ids change ---
  useEffect(() => {
    if (!primaryId) {
      setPrimaryCues([]);
      return;
    }
    let cancelled = false;
    void api
      .cues(entry.id, primaryId)
      .then((c) => {
        if (cancelled) return;
        setPrimaryCues(c);
        // No whisper job running → any leftover live cues are stale now.
        if (whisperJobRef.current == null)
          setWhisperCues((w) => (w.length ? [] : w));
      })
      .catch(() => !cancelled && setPrimaryCues([]));
    return () => {
      cancelled = true;
    };
  }, [entry.id, primaryId]);

  useEffect(() => {
    if (!secondaryId) {
      setSecondaryCues([]);
      return;
    }
    let cancelled = false;
    void api
      .cues(entry.id, secondaryId)
      .then((c) => !cancelled && setSecondaryCues(c))
      .catch(() => !cancelled && setSecondaryCues([]));
    return () => {
      cancelled = true;
    };
  }, [entry.id, secondaryId]);

  // --- subtitle offset: restore per media+track; adjust via [ / ] / \ ---
  useEffect(() => {
    let v = 0;
    try {
      v =
        parseFloat(
          localStorage.getItem(`zr.offset.${entry.id}.${primaryId}`) ?? "0",
        ) || 0;
    } catch {
      /* ignore */
    }
    subOffsetRef.current = v;
    setSubOffset(v);
  }, [entry.id, primaryId]);

  const changeOffset = useCallback(
    (delta: number | null) => {
      const next =
        delta == null ? 0 : Math.round((subOffsetRef.current + delta) * 10) / 10;
      subOffsetRef.current = next;
      setSubOffset(next);
      try {
        const key = `zr.offset.${entry.id}.${primaryId}`;
        if (next === 0) localStorage.removeItem(key);
        else localStorage.setItem(key, String(next));
      } catch {
        /* ignore */
      }
      toast(`subs ${next >= 0 ? "+" : ""}${next.toFixed(1)}s`);
    },
    [entry.id, primaryId, toast],
  );

  // --- resume position: save throttled while playing, restore on metadata ---
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const posKey = `zr.pos.${entry.id}`;
    let lastSave = 0;
    const onTime = () => {
      if (v.paused) return;
      const now = Date.now();
      if (now - lastSave < 5000) return;
      lastSave = now;
      try {
        localStorage.setItem(posKey, String(v.currentTime));
      } catch {
        /* ignore */
      }
    };
    const onMeta = () => {
      try {
        const saved = parseFloat(localStorage.getItem(posKey) ?? "");
        if (
          Number.isFinite(saved) &&
          saved > 15 &&
          v.duration > 0 &&
          saved < v.duration - 30
        ) {
          v.currentTime = saved;
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
  }, [entry.id]);

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
      // Autopause: pause exactly at the END of the cue the user just heard.
      // By the time `idx` changes the next subtitle would already be shown, so
      // we seek back to just before the finished cue's end — it stays rendered
      // while paused. lastAutopausedIdx prevents re-triggering in a loop.
      const prev = prevActiveP.current;
      if (autopauseRef.current && !wasFirst && !v.seeking && !v.paused) {
        const prevCue = prev >= 0 ? displayCues[prev] : undefined;
        const leftCue =
          prevCue != null && (idx !== prev || t >= prevCue.end);
        if (leftCue && lastAutopausedIdx.current !== prev) {
          lastAutopausedIdx.current = prev;
          v.pause();
          internalSeekRef.current = true;
          v.currentTime = Math.max(prevCue!.start, prevCue!.end - 0.08) + subOffset;
          // keep the finished cue active/rendered
          prevActiveP.current = prev;
          setActiveP(prev);
          setActiveS(activeCueIndex(secondaryCues, v.currentTime));
          return;
        }
      }
      // Once playback naturally moves into a NEW cue, allow autopausing again.
      if (idx >= 0 && idx !== prev && idx !== lastAutopausedIdx.current) {
        lastAutopausedIdx.current = -1;
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
      prevActiveP.current = activeCueIndex(displayCues, v.currentTime - subOffset);
    };
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("seeking", onSeeking);
    onTime();
    return () => {
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("seeking", onSeeking);
    };
  }, [displayCues, secondaryCues, subOffset]);

  // keep refs in sync for the (deps-stable) hotkey handler
  useEffect(() => {
    primaryCuesRef.current = displayCues;
  }, [displayCues]);

  // popup-open flag for the hotkey handler (Escape closes the lookup panel)
  const popupOpenRef = useRef(false);
  // known-set key of the word popup currently open (for the `k` hotkey)
  const popupKeyRef = useRef<string | null>(null);
  useEffect(() => {
    popupOpenRef.current = popup != null;
    popupKeyRef.current =
      popup && popup.kind === "word"
        ? popup.dictForm ?? popup.surface
        : null;
  }, [popup]);

  // --- global hotkeys: work regardless of focus (except real text inputs) ---
  useEffect(() => {
    const FRAME = 1 / 24; // ~one frame at 23.976/24 fps
    const RATES = [0.5, 0.75, 1, 1.25, 1.5];
    const HANDLED = new Set([
      " ", "f", "F",
      "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
      ",", "<", ".", ">",
      "a", "A", "-", "=", "[", "]", "\\",
      "l", "L", "k", "K",
    ]);
    const isTextInput = (el: Element | null): boolean => {
      if (!el) return false;
      if (el.tagName === "TEXTAREA") return true;
      if ((el as HTMLElement).isContentEditable) return true;
      if (el.tagName === "INPUT") {
        const type = (el as HTMLInputElement).type;
        // checkboxes etc. are not text inputs — hotkeys still apply
        return !["checkbox", "radio", "button", "range", "submit"].includes(type);
      }
      return false;
    };
    const onKey = (e: KeyboardEvent) => {
      const v = videoRef.current;
      if (!v) return;
      const active = document.activeElement;
      // Real text inputs keep their native behavior entirely. SELECTs too:
      // arrow keys / typing must keep working for keyboard track selection.
      const isSelect = (el: Element | null) => el?.tagName === "SELECT";
      if (isTextInput(active) || isTextInput(e.target as Element | null)) return;
      if (isSelect(active) || isSelect(e.target as Element | null)) return;
      // Escape closes the lookup panel; otherwise leave it to native handling
      // (exit fullscreen etc.) — never eat it for nothing.
      if (e.key === "Escape") {
        if (popupOpenRef.current) {
          e.preventDefault();
          e.stopPropagation();
          clearCloseTimer();
          askFocusedRef.current = false;
          setPinned(false);
          setPopup(null);
          resumeFromHover();
        }
        return;
      }
      if (!HANDLED.has(e.key)) return;
      // Avoid double-toggle on key auto-repeat for toggling keys.
      if (e.repeat && [" ", "f", "F", "l", "L", "k", "K"].includes(e.key)) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      // We fully own these keys: kill the native activation (Space on a
      // focused button/checkbox/video would otherwise ALSO toggle → double).
      e.preventDefault();
      e.stopPropagation();
      if (
        active instanceof HTMLElement &&
        active !== document.body &&
        !isTextInput(active)
      ) {
        active.blur();
      }
      switch (e.key) {
        case " ":
          pausedByHoverRef.current = false; // user took control
          if (v.paused) void v.play();
          else v.pause();
          break;
        case "f":
        case "F":
          if (document.fullscreenElement) void document.exitFullscreen();
          else void stageRef.current?.requestFullscreen?.();
          break;
        case "ArrowLeft":
          v.currentTime = Math.max(0, v.currentTime - 5);
          break;
        case "ArrowRight":
          v.currentTime = Math.min(v.duration || Infinity, v.currentTime + 5);
          break;
        case "ArrowUp":
          v.volume = Math.min(1, v.volume + 0.1);
          break;
        case "ArrowDown":
          v.volume = Math.max(0, v.volume - 0.1);
          break;
        case ",":
        case "<":
          v.pause();
          v.currentTime = Math.max(0, v.currentTime - FRAME);
          break;
        case ".":
        case ">":
          v.pause();
          v.currentTime = Math.min(v.duration || Infinity, v.currentTime + FRAME);
          break;
        case "a":
        case "A": {
          // Replay: jump to the start of the current primary cue; if within
          // the first 0.3s (or between cues), step back to the previous one —
          // tapping `a` repeatedly walks backward cue by cue.
          const off = subOffsetRef.current;
          const cues = primaryCuesRef.current;
          if (cues.length === 0) break;
          const tt = v.currentTime - off;
          let i = activeCueIndex(cues, tt);
          if (i < 0) {
            for (let k = cues.length - 1; k >= 0; k--) {
              if (cues[k]!.start <= tt) {
                i = k;
                break;
              }
            }
          } else if (tt - cues[i]!.start < 0.3 && i > 0) {
            i -= 1;
          }
          if (i >= 0) v.currentTime = Math.max(0, cues[i]!.start + off);
          break;
        }
        case "-":
        case "=": {
          let i = RATES.indexOf(v.playbackRate);
          if (i === -1) i = RATES.indexOf(1);
          i =
            e.key === "="
              ? (i + 1) % RATES.length
              : (i + RATES.length - 1) % RATES.length;
          v.playbackRate = RATES[i]!;
          toast(`speed ${RATES[i]}×`);
          break;
        }
        case "[":
          changeOffset(-0.1);
          break;
        case "]":
          changeOffset(+0.1);
          break;
        case "\\":
          changeOffset(null);
          break;
        case "l":
        case "L":
          toggleSidebar();
          break;
        case "k":
        case "K": {
          // toggle mark-as-known for the popup word or the hovered word
          const key = popupKeyRef.current ?? hoveredKeyRef.current;
          if (!key) break;
          const adding = !knownWordsRef.current.has(key);
          toggleKnown(key);
          toast(adding ? `known: ${key}` : `unknown: ${key}`);
          break;
        }
      }
    };
    // capture phase: run before any focused element's own key handling
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [changeOffset, toast, clearCloseTimer, resumeFromHover, toggleSidebar, toggleKnown]);

  const primaryText = activeP >= 0 && activeP < displayCues.length ? displayCues[activeP]!.text : "";
  const secondaryText = activeS >= 0 ? secondaryCues[activeS]!.text : "";

  // --- lazy tokenize the active primary cue ---
  useEffect(() => {
    if (!primaryText) {
      setTokens(null);
      return;
    }
    let cancelled = false;
    void getTokenizer()
      .then((tok) => {
        if (cancelled) return;
        tokenizerReady.current = true;
        setTokens(tok.tokenize(primaryText));
      })
      .catch(() => {
        if (!cancelled) setTokens(null);
      });
    return () => {
      cancelled = true;
    };
  }, [primaryText]);

  const refreshAnki = useCallback(async () => {
    const anki = await api.ankiWords().catch(() => null);
    if (!anki) return;
    setWordIndex(buildWordIndex(anki.words, anki.progress));
    setKnownFronts(new Set(anki.words.map((w) => w.front)));
  }, []);

  // --- word hover -> popup + lookup (with ~200ms hover-intent debounce) ---
  // We only OPEN the popup (and fire the lookup) once the cursor RESTS on a
  // word for HOVER_OPEN_MS. Sliding across a sentence cancels pending opens,
  // so no lookup storm. The per-surface lookupCache keeps revisits instant.
  const buildWordPopup = useCallback(
    (tok: KToken, el: HTMLElement, ctxOverride?: string): PopupState => {
      const surface = tok.surface_form;
      const rect = el.getBoundingClientRect();
      const ctx =
        ctxOverride ||
        markedContext(displayCues, activeP) ||
        contextAround(displayCues, activeP) ||
        primaryText;
      return {
        kind: "word",
        surface,
        reading: tok.reading,
        x: rect.left + rect.width / 2,
        y: rect.top,
        anchorBottom: rect.bottom,
        context: ctx,
        // matching known-language (RU) line, for disambiguation in lookups
        secondary: secondaryText || undefined,
        dictForm:
          tok.basic_form && tok.basic_form !== "*" && tok.basic_form !== surface
            ? tok.basic_form
            : undefined,
        timestamp: videoRef.current?.currentTime ?? 0,
      };
    },
    [displayCues, activeP, primaryText, secondaryText],
  );

  const onWordEnter = useCallback(
    (tok: KToken, e: React.MouseEvent, ctx?: string) => {
      hoveredKeyRef.current = wordKey(tok); // `k` targets the hovered word
      if (pinnedRef.current) return; // pinned panel owns the screen
      clearCloseTimer();
      clearOpenTimer();
      const el = e.currentTarget as HTMLElement;
      openTimer.current = window.setTimeout(() => {
        openTimer.current = null;
        // Pause on hover so the learner can read at leisure; remember that WE
        // paused so closing the popup resumes playback.
        pauseForHover();
        setPopup(buildWordPopup(tok, el, ctx));
      }, HOVER_OPEN_MS);
    },
    [buildWordPopup, clearOpenTimer, clearCloseTimer, pauseForHover],
  );

  // Click a word: open immediately and PIN — no hover-out auto-close. Clicking
  // another word retargets the pinned panel.
  const onWordClick = useCallback(
    (tok: KToken, e: React.MouseEvent, ctx?: string) => {
      e.stopPropagation();
      clearOpenTimer();
      clearCloseTimer();
      pauseForHover();
      setPopup(buildWordPopup(tok, e.currentTarget as HTMLElement, ctx));
      setPinned(true);
    },
    [buildWordPopup, clearOpenTimer, clearCloseTimer, pauseForHover],
  );

  // Pinned panel: clicking anywhere outside the panel (and not on a word,
  // which retargets instead) closes it and resumes if we paused.
  useEffect(() => {
    if (!pinned) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (t && lookupRef.current?.contains(t)) return;
      if (t instanceof Element && t.closest(".tok")) return;
      setPinned(false);
      setPopup(null);
      resumeFromHover();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [pinned, resumeFromHover]);

  // Safety: whenever the popup is gone, the pin is gone too.
  useEffect(() => {
    if (!popup) setPinned(false);
  }, [popup]);

  // Leaving a word to empty space: cancel a pending open, and if a popup is
  // showing, schedule a hide with a short grace so the cursor can reach the
  // panel. Entering the panel cancels the hide; leaving the panel hides it.
  const onWordLeave = useCallback(() => {
    hoveredKeyRef.current = null;
    clearOpenTimer();
    if (pinnedRef.current) return; // pinned: never auto-close on hover-out
    clearCloseTimer();
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      if (askFocusedRef.current) return; // typing a follow-up — keep the panel
      setPopup(null);
      resumeFromHover();
    }, HOVER_CLOSE_MS);
  }, [clearOpenTimer, clearCloseTimer, resumeFromHover]);

  const onPanelEnter = useCallback(() => {
    clearCloseTimer();
  }, [clearCloseTimer]);
  const onPanelLeave = useCallback(() => {
    clearCloseTimer();
    if (pinnedRef.current) return; // pinned: never auto-close on hover-out
    if (askFocusedRef.current) return; // typing a follow-up — keep the panel
    setPopup(null);
    resumeFromHover();
  }, [clearCloseTimer, resumeFromHover]);

  const closePanel = useCallback(() => {
    clearCloseTimer();
    askFocusedRef.current = false;
    setPinned(false);
    setPopup(null);
    resumeFromHover();
  }, [clearCloseTimer, resumeFromHover]);

  // "(?)" after the last token: explain the whole sentence in the same panel.
  const onExplainClick = useCallback(
    (e: React.MouseEvent) => {
      clearOpenTimer();
      clearCloseTimer();
      pauseForHover();
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      setPopup({
        kind: "sentence",
        surface: primaryText,
        x: rect.left + rect.width / 2,
        y: rect.top,
        anchorBottom: rect.bottom,
        context: markedContext(displayCues, activeP) || primaryText,
        secondary: secondaryText,
        timestamp: videoRef.current?.currentTime ?? 0,
      });
    },
    [primaryText, secondaryText, displayCues, activeP, clearOpenTimer, clearCloseTimer, pauseForHover],
  );

  // Restore (or clear) the follow-up Q/A session whenever the panel opens,
  // closes or retargets. History is cached module-level so reopening the same
  // popup brings the thread back; unanswered trailing items are dropped.
  const qaKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const key = popup ? `${popup.kind}|${popup.surface}|${popup.context}` : null;
    qaKeyRef.current = key;
    const cached = key ? qaCache.get(key) : undefined;
    setQa(cached ? cached.filter((i) => i.a != null) : []);
    setAskText("");
    setAskBusy(false);
    if (!popup) askFocusedRef.current = false;
  }, [popup?.kind, popup?.surface, popup?.context]);

  // persist the Q/A thread for the currently-open popup
  useEffect(() => {
    if (qaKeyRef.current && qa.length > 0) qaCachePut(qaKeyRef.current, qa);
  }, [qa]);

  // fetch the sentence explanation when a sentence panel opens (cached server-side)
  useEffect(() => {
    if (!popup || popup.kind !== "sentence") {
      setExplain(null);
      return;
    }
    let cancelled = false;
    setExplain(null);
    setExplainLoading(true);
    void explainApi({
      sentence: popup.surface,
      secondary: popup.secondary ?? "",
      source: entry.name,
      context: popup.context,
    })
      .then((res) => {
        if (!cancelled) setExplain(res);
      })
      .catch(() => {})
      .finally(() => !cancelled && setExplainLoading(false));
    return () => {
      cancelled = true;
    };
  }, [popup?.kind, popup?.surface, popup?.context, popup?.secondary]);

  // fetch lookup when popup target changes (default: NO frame — saves latency)
  useEffect(() => {
    if (!popup || popup.kind !== "word") {
      setLookup(null);
      return;
    }
    setFrameAdded(false);
    setFrameLoading(false);
    // Cache key includes the cue context so the same word in a NEW sentence
    // gets a fresh, context-correct answer instead of a stale cached one.
    const cacheKey = `${popup.surface} ${popup.context}`;
    const cached = lookupCache.current.get(cacheKey);
    if (cached) {
      setLookup(cached);
      setLookupLoading(false);
      return;
    }
    let cancelled = false;
    setLookup(null);
    setLookupLoading(true);
    // De-dup concurrent/repeat requests for the same word: share one in-flight
    // promise so sliding away and back never fires a second Gemini call.
    const surface = popup.surface;
    // Give Gemini the dictionary form when the token is conjugated.
    const ctx = popup.dictForm
      ? `${popup.context}\n(dictionary form: ${popup.dictForm})`
      : popup.context;
    let p = inflight.current.get(cacheKey);
    if (!p) {
      p = lookupApi({
        word: surface,
        context: ctx,
        source: entry.name,
        secondary: popup.secondary,
      })
        .then((res) => {
          lookupCache.current.set(cacheKey, res);
          return res;
        })
        .finally(() => inflight.current.delete(cacheKey));
      inflight.current.set(cacheKey, p);
    }
    void p
      .then((res) => {
        if (!cancelled) setLookup(res);
      })
      .catch(() => {})
      .finally(() => !cancelled && setLookupLoading(false));
    return () => {
      cancelled = true;
    };
  }, [popup?.kind, popup?.surface, popup?.context]);

  // re-run the current lookup WITH a video frame, replacing the panel content.
  const onAddFrame = useCallback(async () => {
    if (!popup) return;
    setFrameLoading(true);
    try {
      const res = await lookupApi({
        word: popup.surface,
        context: popup.context,
        secondary: popup.secondary,
        source: entry.name,
        mediaId: entry.id,
        timestamp: popup.timestamp,
        withFrame: true,
      });
      lookupCache.current.set(`${popup.surface} ${popup.context}`, res);
      setLookup(res);
      setFrameAdded(true);
    } catch (e) {
      toast(`Frame lookup failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setFrameLoading(false);
    }
  }, [popup, entry.id, entry.name, toast]);

  // Regenerate the lookup text for the same word, BYPASSING the cache (force a
  // fresh Gemini call). Replaces the panel content and updates the cache.
  const onReload = useCallback(async () => {
    if (!popup) return;
    setReloadLoading(true);
    setLookupLoading(true);
    try {
      const res = await lookupApi({
        word: popup.surface,
        context: popup.context,
        secondary: popup.secondary,
        source: entry.name,
        noCache: true,
      });
      lookupCache.current.set(`${popup.surface} ${popup.context}`, res);
      setLookup(res);
    } catch (e) {
      toast(`Regenerate failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setReloadLoading(false);
      setLookupLoading(false);
    }
  }, [popup, entry.name, toast]);

  // Position the lookup panel: prefer above the word, flip below when there
  // isn't room, and clamp horizontally so it can never be cut off-screen.
  useLayoutEffect(() => {
    if (!popup) {
      setPopupPos({ visibility: "hidden" });
      return;
    }
    const el = lookupRef.current;
    if (!el) return;
    const margin = 8;
    const { width, height } = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const spaceAbove = popup.y;
    const spaceBelow = vh - popup.anchorBottom;
    const placeBelow = spaceAbove < height + margin && spaceBelow > spaceAbove;

    let top = placeBelow ? popup.anchorBottom + margin : popup.y - height - margin;
    top = Math.max(margin, Math.min(top, vh - height - margin));

    let left = popup.x - width / 2;
    left = Math.max(margin, Math.min(left, vw - width - margin));

    setPopupPos({ left, top, visibility: "visible" });
  }, [popup, lookup, lookupLoading, frameLoading, frameAdded, explain, explainLoading, qa]);

  const popupFront = useMemo(() => {
    if (!popup) return null;
    const reading = lookup?.reading || popup.reading;
    return reading ? `${popup.surface} [${reading}]` : popup.surface;
  }, [popup, lookup]);

  const popupSaved = popupFront ? knownFronts.has(popupFront) : false;

  // Bounds of the primary cue at `timestamp` in FILE time (cue times are
  // track-time, so re-add the user's sync offset) for sentence-audio capture.
  const cueBoundsAt = useCallback((timestamp: number) => {
    const cues = primaryCuesRef.current;
    const idx = activeCueIndex(cues, timestamp - subOffsetRef.current);
    const cue = idx >= 0 ? cues[idx] : undefined;
    if (!cue) return {};
    return {
      cueStart: cue.start + subOffsetRef.current,
      cueEnd: cue.end + subOffsetRef.current,
    };
  }, []);

  const onAdd = useCallback(async () => {
    if (!popup || !lookup || !popupFront) return;
    const v = videoRef.current;
    const front = popupFront;
    // OPTIMISTIC: immediately flip the button to the saved/Delete state by
    // marking the word known; POST in the background and revert on failure.
    setKnownFronts((prev) => {
      const next = new Set(prev);
      next.add(front);
      return next;
    });
    try {
      await api.ankiAdd({
        word: popup.surface,
        reading: lookup.reading || popup.reading || "",
        translation: lookup.translation,
        notes: lookup.notes,
        context: primaryText,
        mediaId: entry.id,
        timestamp: v?.currentTime ?? 0,
        ...cueBoundsAt(popup.timestamp),
      });
      // sync real progress data (color etc.) in the background
      void refreshAnki();
    } catch (e) {
      // revert the optimistic state
      setKnownFronts((prev) => {
        const next = new Set(prev);
        next.delete(front);
        return next;
      });
      toast(`Add failed: ${e instanceof Error ? e.message : e}`);
    }
  }, [popup, lookup, popupFront, primaryText, entry.id, refreshAnki, toast, cueBoundsAt]);

  // Add the whole sentence as an Anki card (front = JP sentence, back =
  // translation, notes = breakdown + idioms). Same optimistic flow as words.
  const onAddSentence = useCallback(async () => {
    if (!popup || popup.kind !== "sentence" || !explain) return;
    const v = videoRef.current;
    const front = popup.surface;
    setKnownFronts((prev) => {
      const next = new Set(prev);
      next.add(front);
      return next;
    });
    try {
      await api.ankiAdd({
        word: popup.surface,
        reading: "",
        translation: explain.translation,
        notes: [explain.breakdown, explain.idioms].filter(Boolean).join("\n\n"),
        context: popup.secondary ?? "",
        mediaId: entry.id,
        timestamp: v?.currentTime ?? popup.timestamp,
        ...cueBoundsAt(popup.timestamp),
      });
      void refreshAnki();
    } catch (e) {
      setKnownFronts((prev) => {
        const next = new Set(prev);
        next.delete(front);
        return next;
      });
      toast(`Add failed: ${e instanceof Error ? e.message : e}`);
    }
  }, [popup, explain, entry.id, refreshAnki, toast, cueBoundsAt]);

  // --- follow-up question (both panel kinds) ---
  const onAsk = useCallback(async () => {
    if (!popup || askBusy) return;
    const q = askText.trim();
    if (!q) return;
    setAskText("");
    setAskBusy(true);
    setQa((prev) => [...prev, { q, a: null }]);
    const priorAnswer =
      popup.kind === "word"
        ? [lookup?.reading, lookup?.translation, lookup?.notes]
            .filter(Boolean)
            .join("\n")
        : [explain?.breakdown, explain?.idioms, explain?.translation]
            .filter(Boolean)
            .join("\n");
    try {
      const res = await api.ask({
        question: q,
        ...(popup.kind === "word" ? { word: popup.surface } : {}),
        sentence: popup.context,
        priorAnswer,
        source: entry.name,
      });
      setQa((prev) =>
        prev.map((item, i) => (i === prev.length - 1 ? { ...item, a: res.answer } : item)),
      );
    } catch (e) {
      setQa((prev) =>
        prev.map((item, i) =>
          i === prev.length - 1
            ? { ...item, a: `error: ${e instanceof Error ? e.message : e}` }
            : item,
        ),
      );
    } finally {
      setAskBusy(false);
      askInputRef.current?.focus(); // keep typing flow
    }
  }, [popup, askText, askBusy, lookup, explain, entry.name]);

  const onDelete = useCallback(async () => {
    if (!popupFront) return;
    try {
      await api.ankiDelete(popupFront);
      toast("Removed from Anki");
      await refreshAnki();
    } catch (e) {
      toast(`Delete failed: ${e instanceof Error ? e.message : e}`);
    }
  }, [popupFront, refreshAnki, toast]);

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
      const es = new EventSource(api.whisperEventsUrl(jobId));
      whisperEsRef.current = es;
      es.onopen = () => {
        whisperRetryRef.current = 0; // healthy connection → reset retry budget
      };
      es.onmessage = (ev) => {
        const data = JSON.parse(ev.data) as
          | { type: "snapshot"; status: string; cues: Cue[] }
          | { type: "status"; status: string; error?: string }
          | { type: "cue"; cue: Cue };
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
              void api.subs(entry.id).then((ts) => {
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
    [entry.id, toast],
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
      if (whisperEsRef.current != null) return; // already reattached
      void api
        .whisperActive(entry.id)
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
  }, [entry.id]);
  useEffect(() => {
    retryAttachRef.current = retryAttach;
  }, [retryAttach]);

  // --- whisper generate JP ---
  const onGenerateJa = useCallback(async () => {
    setWhisperBusy(true);
    setWhisperStatus("starting…");
    setWhisperLastEnd(0);
    setWhisperCues([]);
    whisperRetryRef.current = 0;
    try {
      // Server dedups: an already-active job for this file returns its id.
      const { jobId } = await api.whisperStart(entry.id, "ja");
      attachWhisper(jobId);
    } catch (e) {
      setWhisperBusy(false);
      toast(`Whisper start failed: ${e instanceof Error ? e.message : e}`);
    }
  }, [entry.id, toast, attachWhisper]);

  // Rediscover a running whisper job after a page reload and reattach its SSE
  // so the progress UI resumes instead of offering a duplicate Generate.
  useEffect(() => {
    let cancelled = false;
    void api
      .whisperActive(entry.id)
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
  }, [entry.id, attachWhisper]);

  const onCancelWhisper = useCallback(async () => {
    if (whisperJobRef.current) await api.whisperCancel(whisperJobRef.current);
  }, []);

  // --- translate primary -> RU ---
  const onTranslateRu = useCallback(async () => {
    if (!primaryId) return;
    setTranslateBusy(true);
    try {
      const res = await api.translate(entry.id, primaryId, "ru");
      toast(`Translated ${res.cueCount} lines → RU`);
      const ts = await api.subs(entry.id);
      setTracks(ts);
      const ru = ts.find((t) => t.id === res.track);
      if (ru) setSecondaryId(ru.id);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        toast("A Russian track already exists for this video.");
      } else {
        toast(`Translate failed: ${e instanceof Error ? e.message : e}`);
      }
    } finally {
      setTranslateBusy(false);
    }
  }, [entry.id, primaryId, toast]);

  // Furigana on unknown kanji (settings toggle, default on). Maturity-based
  // hiding lives in TokenLine (shared by the overlay and the sidebar).
  const furiganaOn = settings.furigana !== false;

  const sidebarSeek = useCallback((t: number) => {
    const v = videoRef.current;
    if (v) v.currentTime = Math.min(v.duration || Infinity, Math.max(0, t));
  }, []);

  const hasJa = tracks.some((t) => isJaLang(t.lang));
  // Only a GENERATED (synced) RU track hides the Translate button; external or
  // embedded RU tracks are often out of sync with the JA track.
  const hasGeneratedRu = tracks.some((t) => isRuLang(t.lang) && t.origin === "generated");
  const primaryTrackLang = tracks.find((t) => t.id === primaryId)?.lang ?? "";

  return (
    <div className="player-wrap">
      <div className="episode-title" title={entry.name}>
        {entry.name.replace(/\.[^.]+$/, "")}
      </div>
      <div className="stage-row">
      <div className="video-stage" ref={stageRef}>
        {/* nofullscreen: the native button would fullscreen the bare <video>,
            hiding our subtitle overlay — users press `f` instead. */}
        <video
          ref={videoRef}
          src={mediaUrl(entry.id)}
          controls
          controlsList="nofullscreen"
        />
        <div className="sub-overlay">
          <div className="sub-primary">
            <TokenLine
              tokens={tokens}
              fallbackText={primaryText}
              wordIndex={wordIndex}
              knownWords={knownWords}
              furiganaOn={furiganaOn}
              onWordEnter={onWordEnter}
              onWordLeave={onWordLeave}
              onWordClick={onWordClick}
            />
            {primaryText && (
              <span
                className="explain-q"
                title="Explain sentence structure"
                onClick={onExplainClick}
                onMouseEnter={() => {
                  // same hover-pause as words, so the line stays readable
                  clearCloseTimer();
                  pauseForHover();
                }}
                onMouseLeave={() => {
                  // only resume if the panel didn't open (no click happened)
                  if (!popupOpenRef.current) resumeFromHover();
                }}
              >
                ?
              </span>
            )}
          </div>
          {secondaryText && (
            <div
              className={`sub-secondary${secShow ? " show" : ""}`}
              onMouseEnter={() => {
                secondaryHoveredRef.current = true;
                setSecShow(true);
                pauseForHover();
              }}
              onMouseLeave={() => {
                secondaryHoveredRef.current = false;
                setSecShow(false);
                resumeFromHover();
              }}
            >
              {secondaryText}
            </div>
          )}
        </div>
      {popup && (
        <div
          ref={lookupRef}
          className={`lookup${pinned ? " pinned" : ""}`}
          style={popupPos}
          onMouseEnter={onPanelEnter}
          onMouseLeave={onPanelLeave}
        >
          {popup.kind === "sentence" ? (
            <>
              <div className="sentence">{popup.surface}</div>
              {explainLoading && <div className="spin">Explaining…</div>}
              {explain && (
                <>
                  <div className="translation">{explain.translation}</div>
                  <div className="notes breakdown">{explain.breakdown}</div>
                  {explain.idioms && (
                    <div className="notes breakdown">{explain.idioms}</div>
                  )}
                </>
              )}
              <div className="row">
                {popupSaved ? (
                  <button
                    className="btn danger"
                    onClick={onDelete}
                    title="Remove this sentence card from Anki"
                  >
                    Delete
                  </button>
                ) : (
                  <button
                    className="btn"
                    disabled={!explain}
                    onClick={onAddSentence}
                    title="Add this sentence to Anki with the current video frame"
                  >
                    Add to Anki
                  </button>
                )}
              </div>
            </>
          ) : (
            <>
          <div>
            <span className="word">{popup.surface}</span>
            {(lookup?.reading || popup.reading) && (
              <span className="reading">{lookup?.reading || popup.reading}</span>
            )}
            {knownWords.has(popup.dictForm ?? popup.surface) && (
              <span
                className="known-flag"
                title="Marked as known — press k to toggle"
              >
                known
              </span>
            )}
          </div>
          {lookupLoading && <div className="spin">Looking up…</div>}
          {lookup && (
            <>
              <div className="translation">{lookup.translation}</div>
              {lookup.notes && <div className="notes">{lookup.notes}</div>}
            </>
          )}
          <div className="row">
            {popupSaved ? (
              <button className="btn danger" onClick={onDelete} title="Remove this word from Anki">
                Delete
              </button>
            ) : (
              <button
                className="btn"
                disabled={!lookup}
                onClick={onAdd}
                title="Add this word to Anki with the current video frame"
              >
                Add to Anki
              </button>
            )}
            <button
              className="btn"
              disabled={!lookup || frameLoading || frameAdded}
              onClick={onAddFrame}
              title="Re-run the lookup using the current video frame as visual context"
            >
              {frameLoading ? "Adding frame…" : frameAdded ? "Frame added" : "Add frame"}
            </button>
            <button
              className="btn icon"
              disabled={!lookup || reloadLoading}
              onClick={onReload}
              title="Regenerate the explanation from scratch (when Gemini's answer is off)"
              aria-label="Regenerate explanation"
            >
              {reloadLoading ? "…" : "↻"}
            </button>
          </div>
            </>
          )}

          {qa.length > 0 && (
            <div className="qa">
              {qa.map((item, i) => (
                <div key={i} className="qa-item">
                  <div className="qa-q">{item.q}</div>
                  <div className="qa-a">{item.a ?? "…"}</div>
                </div>
              ))}
            </div>
          )}
          <input
            ref={askInputRef}
            className="ask-input"
            type="text"
            placeholder="ask…"
            value={askText}
            onChange={(e) => setAskText(e.target.value)}
            onFocus={() => {
              askFocusedRef.current = true;
              clearCloseTimer();
            }}
            onBlur={() => {
              askFocusedRef.current = false;
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") void onAsk();
              else if (e.key === "Escape") closePanel();
            }}
          />
        </div>
      )}
      </div>

      {sidebarOpen && !isFullscreen && (
        <Sidebar
          cues={displayCues}
          secondaryCues={secondaryCues}
          activeIdx={activeP}
          subOffset={subOffset}
          onSeek={sidebarSeek}
          wordIndex={wordIndex}
          knownWords={knownWords}
          furiganaOn={furiganaOn}
          onWordEnter={onWordEnter}
          onWordLeave={onWordLeave}
          onWordClick={onWordClick}
        />
      )}
      </div>

      <div className="controls">
        {/* Primary slot: a select when tracks exist (with "+ generate…" folded
            in as the last option), otherwise the single relevant action. */}
        {tracks.length > 0 ? (
          <div className="track-pick">
            <label>Primary</label>
            <select
              value={primaryId}
              onChange={(e) => {
                if (e.target.value === "__generate") void onGenerateJa();
                else setPrimaryId(e.target.value);
              }}
            >
              <option value="">— none —</option>
              {tracks.map((t) => (
                <option key={t.id} value={t.id}>
                  {langLabel(t)}
                </option>
              ))}
              {!hasJa && !whisperBusy && (
                <option value="__generate">+ generate ja…</option>
              )}
            </select>
          </div>
        ) : (
          !whisperBusy && (
            <button
              className="btn"
              onClick={onGenerateJa}
              title="Transcribe the audio to Japanese subtitles with Whisper (saved as a track)"
            >
              Generate ja
            </button>
          )
        )}
        {/* Secondary slot: same pattern, "+ translate…" folded in. */}
        {tracks.length > 0 && (
          <div className="track-pick">
            <label>Secondary</label>
            <select
              value={secondaryId}
              onChange={(e) => {
                if (e.target.value === "__translate") void onTranslateRu();
                else setSecondaryId(e.target.value);
              }}
            >
              <option value="">— none —</option>
              {tracks.map((t) => (
                <option key={t.id} value={t.id}>
                  {langLabel(t)}
                </option>
              ))}
              {primaryId &&
                isJaLang(primaryTrackLang) &&
                !hasGeneratedRu &&
                !translateBusy && (
                  <option value="__translate">+ translate → ru…</option>
                )}
            </select>
          </div>
        )}
        <label
          className="switch inline"
          title="Pause automatically at the end of every subtitle (learning aid)"
        >
          <input
            type="checkbox"
            checked={autopause}
            onChange={(e) => setAutopause(e.target.checked)}
          />
          Autopause
        </label>

        {translateBusy && <span className="spinner-line">Translating…</span>}
        {whisperBusy && (
          <>
            <div className="whisper-progress" title="Whisper transcription progress">
              <span className="spinner-line">
                Generating ja subs… {fmtTime(whisperLastEnd)}
                {videoDuration > 0 ? ` / ${fmtTime(videoDuration)}` : ""}
                {whisperStatus && whisperStatus !== "running" ? ` (${whisperStatus})` : ""}
              </span>
              <div className="progress-track">
                <div
                  className="progress-fill"
                  style={{
                    width: `${
                      videoDuration > 0
                        ? Math.min(100, (whisperLastEnd / videoDuration) * 100)
                        : 0
                    }%`,
                  }}
                />
              </div>
            </div>
            <button className="btn sm" onClick={onCancelWhisper} title="Stop transcription">
              Cancel
            </button>
          </>
        )}
      </div>
    </div>
  );
}
