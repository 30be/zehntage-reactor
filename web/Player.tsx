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
  type EncounterHit,
} from "./api.ts";
import { activeCueIndex, contextAround } from "./cues.ts";
import { getTokenizer, isLexical, kataToHira, type KToken } from "./tokenizer.ts";
import { buildWordIndex, matchFront, type WordIndex } from "./progress.ts";
import { TokenLine, wordKey } from "./TokenLine.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { freqRank, freqRankOf, freqTier, loadFreq } from "./freq.ts";
import { tmHeartbeat, tmEvent } from "./telemetry.ts";
import {
  PlayIcon,
  PauseIcon,
  VolumeIcon,
  VolumeXIcon,
  MaximizeIcon,
  RotateCwIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
} from "./icons.tsx";

interface Props {
  entry: LibraryEntry;
  /** Initial seek (seconds) from a "#/play/<id>@t" deep link — wins over resume. */
  startAt?: number;
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

// One unknown word in the pre-study (`w`) panel.
interface PreStudyItem {
  lemma: string; // dictionary form (wordKey) — what gets added to Anki
  reading?: string; // hiragana
  rank: number | null; // frequency rank, null = not in the 30k list
  context: string; // cue text where the word first appears
  time: number; // first-occurrence cue midpoint in FILE time (for frame capture)
  checked: boolean;
  added: boolean;
}

interface PreStudyState {
  loading: boolean;
  items: PreStudyItem[];
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

export function Player({ entry, startAt, toast, settings }: Props) {
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
  // RU-blur: hold `b` = temporary unblur; quick double-press `b` = session toggle.
  const [secHold, setSecHold] = useState(false);
  const [blurOff, setBlurOff] = useState(false);
  const blurOffRef = useRef(false);
  const lastBDownRef = useRef(0);
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

  // Smart autopause (from Settings): "every" pauses on every cue end (legacy
  // behavior), "unknown" only when the cue contains >= N unknown lexical
  // tokens (no Anki match, not in zr.known). The checkbox stays the master
  // toggle; mode/threshold live in Settings.
  const apMode: "every" | "unknown" =
    settings.autopauseMode === "unknown" ? "unknown" : "every";
  const apMin = Math.max(1, Math.round(Number(settings.autopauseMinUnknown)) || 1);
  const apModeRef = useRef(apMode);
  const apMinRef = useRef(apMin);
  useEffect(() => {
    apModeRef.current = apMode;
    apMinRef.current = apMin;
  }, [apMode, apMin]);

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
  const wordIndexRef = useRef<WordIndex>(buildWordIndex([], {}));
  useEffect(() => {
    wordIndexRef.current = wordIndex;
  }, [wordIndex]);
  // front -> full card, so a popup for a word already in the deck can be
  // filled from the existing card instead of calling Gemini.
  const deckCardsRef = useRef<Map<string, { front: string; back: string; notes: string }>>(
    new Map(),
  );
  const [lookupFromDeck, setLookupFromDeck] = useState(false);

  // --- frequency ranks (lazy-loaded /freq.json) for the popup tag + pre-study ---
  const [freqMap, setFreqMap] = useState<Map<string, number> | null>(null);
  useEffect(() => {
    let cancelled = false;
    void loadFreq()
      .then((m) => !cancelled && setFreqMap(m))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

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

  // --- pre-study panel (`w`): unknown lemmas in the next 10 minutes ---
  const [preStudy, setPreStudy] = useState<PreStudyState | null>(null);
  const preStudyOpenRef = useRef(false);
  useEffect(() => {
    preStudyOpenRef.current = preStudy != null;
  }, [preStudy]);
  const [preBusy, setPreBusy] = useState(false);
  const [preProg, setPreProg] = useState(0);
  // synchronous reentrance guard: `preBusy` state can be stale for a second
  // click that lands before React re-renders the disabled button
  const preBusyRef = useRef(false);
  // lets the bulk-add loop stop firing requests after the Player unmounts
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // pre-study window length (minutes) — from the Settings page, default 10
  const prestudyMin = Math.max(
    1,
    Math.min(120, Math.round(Number(settings.prestudyMinutes)) || 10),
  );
  const prestudyMinRef = useRef(prestudyMin);
  useEffect(() => {
    prestudyMinRef.current = prestudyMin;
  }, [prestudyMin]);

  // "with frames" toggle in the pre-study header: bulk adds also pass
  // mediaId+timestamp so the server captures a frame per card (slower).
  const [preFrames, setPreFrames] = useState(() => {
    try {
      return localStorage.getItem("zr.prestudyFrames") !== "0"; // default ON
    } catch {
      return true;
    }
  });
  const togglePreFrames = useCallback(() => {
    setPreFrames((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("zr.prestudyFrames", next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  // --- telemetry: playback heartbeat every 15s while the Player is mounted ---
  useEffect(() => {
    const iv = window.setInterval(() => {
      const v = videoRef.current;
      if (v) tmHeartbeat(entry.id, v.currentTime, v.paused);
    }, 15000);
    return () => window.clearInterval(iv);
  }, [entry.id]);

  const buildPreStudy = useCallback(async () => {
    const v = videoRef.current;
    const t = v ? v.currentTime - subOffsetRef.current : 0;
    const cues = primaryCuesRef.current.filter(
      (c) => c.end >= t && c.start <= t + prestudyMinRef.current * 60,
    );
    const [tok, freq] = await Promise.all([
      getTokenizer(),
      loadFreq().catch(() => new Map<string, number>()),
    ]);
    const seen = new Map<string, PreStudyItem>();
    for (const cue of cues) {
      for (const tk of tok.tokenize(cue.text)) {
        if (!isLexical(tk)) continue;
        // particles/auxiliaries aren't study material
        if (tk.pos === "助詞" || tk.pos === "助動詞") continue;
        const key = wordKey(tk);
        if (seen.has(key)) continue;
        if (knownWordsRef.current.has(key)) continue;
        if (
          matchFront(
            wordIndexRef.current,
            tk.surface_form,
            tk.reading,
            tk.basic_form,
          ) != null
        )
          continue;
        seen.set(key, {
          lemma: key,
          reading: tk.reading ? kataToHira(tk.reading) : undefined,
          rank: freqRank(freq, tk),
          context: cue.text,
          time: (cue.start + cue.end) / 2 + subOffsetRef.current,
          checked: true,
          added: false,
        });
      }
    }
    const items = [...seen.values()].sort(
      (a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity),
    );
    // only fill in if the panel is still open
    setPreStudy((prev) => (prev ? { loading: false, items } : prev));
  }, []);

  const togglePreStudy = useCallback(() => {
    setPreStudy((prev) => {
      if (prev) return null;
      void buildPreStudy();
      return { loading: true, items: [] };
    });
  }, [buildPreStudy]);

  const togglePreItem = useCallback((lemma: string) => {
    setPreStudy((prev) =>
      prev
        ? {
            ...prev,
            items: prev.items.map((it) =>
              it.lemma === lemma ? { ...it, checked: !it.checked } : it,
            ),
          }
        : prev,
    );
  }, []);

  // --- shadowing loop (`s`): kept in refs to avoid re-renders on every cue ---
  // idx = primary-cue index being looped; remaining = repeats left.
  // Count comes from the Settings page ("Shadowing repeats", 0 = infinite).
  const loopRef = useRef<{ idx: number; remaining: number } | null>(null);
  const shadowRepeats = Math.max(0, Math.round(Number(settings.shadowRepeats)) || 0);
  const shadowRepeatsRef = useRef(shadowRepeats);
  useEffect(() => {
    shadowRepeatsRef.current = shadowRepeats;
  }, [shadowRepeats]);

  // --- hard mode (`h`): hide JP text while playing, reveal on pause/hover/tail ---
  const [hardMode, setHardMode] = useState(() => {
    try {
      return localStorage.getItem("zr.hardmode") === "1";
    } catch {
      return false;
    }
  });
  const hardModeRef = useRef(hardMode);
  const toggleHardMode = useCallback(() => {
    const next = !hardModeRef.current;
    hardModeRef.current = next;
    setHardMode(next);
    try {
      localStorage.setItem("zr.hardmode", next ? "1" : "0");
    } catch {
      /* ignore */
    }
    toast(next ? "hard mode on" : "hard mode off");
  }, [toast]);
  // delayed-reveal: true in the last 0.2s of the active cue (listen first,
  // read after); driven from the timeupdate handler below.
  const [revealTail, setRevealTail] = useState(false);
  const [isPaused, setIsPaused] = useState(true);
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const upd = () => setIsPaused(v.paused);
    v.addEventListener("play", upd);
    v.addEventListener("pause", upd);
    upd();
    return () => {
      v.removeEventListener("play", upd);
      v.removeEventListener("pause", upd);
    };
  }, [entry.id]);

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

  // --- encounter history (word popup): lazy "encounters: N" line ---
  const [encHits, setEncHits] = useState<EncounterHit[] | null>(null);
  const [encOpen, setEncOpen] = useState(false);
  const encCache = useRef<Map<string, EncounterHit[]>>(new Map());

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
    void videoRef.current?.play().catch(() => {});
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
  // The stage sizes itself to the video's native aspect ratio so there are
  // never letterbox bars (subs floating in black) in normal mode.
  const [videoAspect, setVideoAspect] = useState("16 / 9");
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onMeta = () => {
      setVideoDuration(v.duration || 0);
      if (v.videoWidth > 0 && v.videoHeight > 0)
        setVideoAspect(`${v.videoWidth} / ${v.videoHeight}`);
    };
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

  // --- smart autopause: per-cue unknown-lexical-token counts (memoized) ---
  // null while not computed (or mode "every") — the autopause branch treats
  // null as "pause" so the legacy behavior is the safe default.
  const cueUnknownsRef = useRef<number[] | null>(null);
  useEffect(() => {
    cueUnknownsRef.current = null;
    if (apMode !== "unknown" || displayCues.length === 0) return;
    let cancelled = false;
    void getTokenizer()
      .then((tok) => {
        if (cancelled) return;
        const counts = displayCues.map((c) => {
          let n = 0;
          for (const t of tok.tokenize(c.text)) {
            if (!isLexical(t)) continue;
            if (t.pos === "助詞" || t.pos === "助動詞") continue; // particles/aux
            if (knownWords.has(wordKey(t))) continue;
            if (matchFront(wordIndex, t.surface_form, t.reading, t.basic_form) != null)
              continue;
            n++;
          }
          return n;
        });
        if (!cancelled) cueUnknownsRef.current = counts;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [displayCues, wordIndex, knownWords, apMode]);

  // --- session counters (for the end-of-episode summary overlay) ---
  const sessionStartRef = useRef(Date.now());
  const sessCuesRef = useRef(0); // distinct cue entries during playback
  const sessLookupsRef = useRef(0); // word popups opened
  const sessCardsRef = useRef(0); // anki cards added (popup + sentence + bulk)
  const sessKnownRef = useRef(0); // words marked known via `k`
  const [sessionSummary, setSessionSummary] = useState<{
    min: number;
    cues: number;
    lookups: number;
    cards: number;
    known: number;
    streak: number | null;
  } | null>(null);

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
      deckCardsRef.current = new Map(anki.words.map((w) => [w.front, w]));

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
  // A deep-link start time (#/play/<id>@t) wins over the saved position, once.
  const startAtRef = useRef<number | null>(
    typeof startAt === "number" && Number.isFinite(startAt) && startAt >= 0
      ? startAt
      : null,
  );
  // Re-navigating to the same episode with a new "@t" doesn't remount the
  // Player (key={entry.id} is unchanged), so consume prop changes here too.
  useEffect(() => {
    if (!(typeof startAt === "number" && Number.isFinite(startAt) && startAt >= 0)) return;
    const v = videoRef.current;
    if (v && v.readyState >= 1) {
      v.currentTime = Math.min(v.duration || Infinity, startAt);
      startAtRef.current = null;
    } else {
      startAtRef.current = startAt; // metadata not loaded yet — onMeta seeks
    }
  }, [startAt]);
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
      if (startAtRef.current != null) {
        v.currentTime = Math.min(v.duration || Infinity, startAtRef.current);
        startAtRef.current = null;
        return;
      }
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
      // Hard-mode tail reveal: show the JP text in the last 0.2s of the cue.
      setRevealTail(
        hardModeRef.current &&
          idx >= 0 &&
          displayCues[idx] != null &&
          displayCues[idx]!.end - t <= 0.2,
      );
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
      if (autopauseRef.current && !wasFirst && !v.seeking && !v.paused) {
        const prevCue = prev >= 0 ? displayCues[prev] : undefined;
        const leftCue =
          prevCue != null && (idx !== prev || t >= prevCue.end);
        if (leftCue && lastAutopausedIdx.current !== prev) {
          // Smart mode: only pause when the finished cue had >= N unknown
          // lexical tokens. No data for THIS cue (counts not computed yet,
          // or a streaming whisper cue appended after the last compute) →
          // pause, the same safe default as a missing counts array.
          const cueCount = cueUnknownsRef.current?.[prev];
          const skip =
            apModeRef.current === "unknown" &&
            cueCount != null &&
            cueCount < apMinRef.current;
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
          return;
          }
        }
      }
      // Once playback naturally moves into a NEW cue, allow autopausing again.
      if (idx >= 0 && idx !== prev && idx !== lastAutopausedIdx.current) {
        lastAutopausedIdx.current = -1;
      }
      if (idx >= 0 && idx !== prev) sessCuesRef.current += 1;
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
  const secondaryCuesRef = useRef<Cue[]>([]);
  useEffect(() => {
    secondaryCuesRef.current = secondaryCues;
  }, [secondaryCues]);

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

  // --- episode navigation (`n`/`p`, auto-next on ended) ---
  // Next/previous library entry alphabetically by name; navigates the hash
  // router. If the target episode has no persisted track choice yet, carry the
  // current track LANGUAGES forward (pick its tracks with matching lang).
  const navBusyRef = useRef(false);
  const gotoEpisode = useCallback(
    async (dir: 1 | -1) => {
      if (navBusyRef.current) return;
      navBusyRef.current = true;
      try {
        const lib = await api.library();
        const sorted = lib.slice().sort((a, b) => a.name.localeCompare(b.name));
        const i = sorted.findIndex((e) => e.id === entry.id);
        const next = i >= 0 ? sorted[i + dir] : undefined;
        if (!next) {
          toast(dir > 0 ? "no next episode" : "no previous episode");
          return;
        }
        const saved = readSavedTracks(next.id);
        const curPLang = tracks.find((t) => t.id === primaryId)?.lang;
        const curSLang = tracks.find((t) => t.id === secondaryId)?.lang;
        if ((!saved.primary && curPLang) || (!saved.secondary && curSLang)) {
          try {
            const nts = await api.subs(next.id);
            const pick = (lang?: string, not?: string): string =>
              lang
                ? nts.find((t) => t.lang === lang && t.id !== not)?.id ??
                  nts.find(
                    (t) =>
                      t.lang.slice(0, 2) === lang.slice(0, 2) && t.id !== not,
                  )?.id ??
                  ""
                : "";
            const p = saved.primary ?? pick(curPLang);
            // never persist the same track for both slots
            const s = saved.secondary ?? pick(curSLang, p || undefined);
            if (p || s) saveTracks(next.id, p, s);
          } catch {
            /* best-effort — auto-selection will kick in */
          }
        }
        window.location.hash = `#/play/${next.id}`;
      } catch (e) {
        toast(`Navigation failed: ${e instanceof Error ? e.message : e}`);
      } finally {
        navBusyRef.current = false;
      }
    },
    [entry.id, tracks, primaryId, secondaryId, toast],
  );

  // Auto-next: on `ended`, count down 5s (any keypress/click cancels), then go.
  // gotoEpisode is reached through a ref so this effect never re-runs when
  // tracks/track-ids change — a re-run would silently kill a live countdown.
  const gotoEpisodeRef = useRef(gotoEpisode);
  useEffect(() => {
    gotoEpisodeRef.current = gotoEpisode;
  }, [gotoEpisode]);
  const cancelAutoNextRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onEnded = () => {
      tmEvent("episode_end", { mediaId: entry.id });
      cancelAutoNextRef.current?.();
      // Session summary overlay (any key/click dismisses it along with the
      // countdown; the countdown line is rendered inside the panel).
      setSessionSummary({
        min: Math.max(1, Math.round((Date.now() - sessionStartRef.current) / 60000)),
        cues: sessCuesRef.current,
        lookups: sessLookupsRef.current,
        cards: sessCardsRef.current,
        known: sessKnownRef.current,
        streak: null,
      });
      // streak line (cheap aggregate) — fill in async, best-effort
      void api
        .statsOverview()
        .then((ov) => {
          let streak = 0;
          for (let i = ov.last30Days.length - 1; i >= 0; i--) {
            if (ov.last30Days[i]!.wallPlayingSec > 0) streak++;
            else break;
          }
          setSessionSummary((s) => (s ? { ...s, streak } : s));
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
        // n/p navigate anyway (the hotkey handler runs first in capture
        // order) — only the timer needs killing, the toast would mislead.
        const k = (e as KeyboardEvent).key;
        if (k === "n" || k === "N" || k === "p" || k === "P") return;
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
  }, [entry.id, toast]);

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
      "Tab", "s", "S", "h", "H", "n", "N", "p", "P", "w", "W",
      "b", "B", "i", "I",
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
      // Browser-level combos (Ctrl+L, Cmd+R, Alt+…) are never ours.
      if (e.ctrlKey || e.metaKey || e.altKey) return;
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
        if (preStudyOpenRef.current) {
          e.preventDefault();
          e.stopPropagation();
          setPreStudy(null);
          return;
        }
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
      if (e.repeat && [" ", "f", "F", "l", "L", "k", "K", "s", "S", "h", "H", "n", "N", "p", "P", "w", "W", "b", "B", "i", "I"].includes(e.key)) {
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
          if (v.paused) void v.play().catch(() => {});
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
        case "Tab": {
          // Next/previous dialogue line. If a popup is open (incl. pinned),
          // Tab closes it first — mirror Escape — then seeks.
          if (popupOpenRef.current) {
            clearCloseTimer();
            askFocusedRef.current = false;
            setPinned(false);
            setPopup(null);
            resumeFromHover();
          }
          loopRef.current = null; // Tab releases the shadowing loop
          const off = subOffsetRef.current;
          const cues = primaryCuesRef.current;
          if (cues.length === 0) break;
          const tt = v.currentTime - off;
          const LEAD = 0.15; // small lead-in before the cue starts
          if (e.shiftKey) {
            // previous cue start — same walk-back as `a`
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
            if (i >= 0) v.currentTime = Math.max(0, cues[i]!.start + off - LEAD);
          } else {
            const next = cues.find((c) => c.start > tt + 0.01);
            if (next) v.currentTime = Math.max(0, next.start + off - LEAD);
          }
          break;
        }
        case "s":
        case "S": {
          // Shadowing loop on the current primary cue. Repeat count comes from
          // Settings ("Shadowing repeats", 0 = infinite). `s` again releases.
          if (loopRef.current) {
            loopRef.current = null;
            toast("loop off");
            break;
          }
          const off = subOffsetRef.current;
          const cues = primaryCuesRef.current;
          const i = activeCueIndex(cues, v.currentTime - off);
          if (i < 0) {
            toast("no cue to loop");
            break;
          }
          const n = shadowRepeatsRef.current;
          loopRef.current = { idx: i, remaining: n > 0 ? n : Infinity };
          toast(n > 0 ? `loop ×${n}` : "loop on");
          break;
        }
        case "h":
        case "H":
          toggleHardMode();
          break;
        case "w":
        case "W":
          togglePreStudy();
          break;
        case "n":
        case "N":
          void gotoEpisode(1);
          break;
        case "p":
        case "P":
          void gotoEpisode(-1);
          break;
        case "b":
        case "B": {
          // hold = temporary unblur; quick double-press toggles for the session
          const now = Date.now();
          if (now - lastBDownRef.current < 350) {
            const next = !blurOffRef.current;
            blurOffRef.current = next;
            setBlurOff(next);
            toast(next ? "blur off" : "blur on");
          }
          lastBDownRef.current = now;
          setSecHold(true);
          break;
        }
        case "i":
        case "I": {
          if (document.pictureInPictureElement) {
            void document.exitPictureInPicture().catch(() => {});
          } else if (typeof v.requestPictureInPicture === "function") {
            v.requestPictureInPicture().catch((err: unknown) =>
              toast(`PiP failed: ${err instanceof Error ? err.message : err}`),
            );
          } else {
            toast("PiP unsupported");
          }
          break;
        }
        case "k":
        case "K": {
          // toggle mark-as-known for the popup word or the hovered word
          const key = popupKeyRef.current ?? hoveredKeyRef.current;
          if (!key) break;
          const adding = !knownWordsRef.current.has(key);
          if (adding) sessKnownRef.current += 1;
          toggleKnown(key);
          tmEvent("mark_known", { word: key });
          toast(adding ? `known: ${key}` : `unknown: ${key}`);
          break;
        }
      }
    };
    // keyup re-blurs the secondary line after a `b` hold (harmless elsewhere)
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "b" || e.key === "B") setSecHold(false);
    };
    // alt-tab / focus loss while `b` is held: keyup never arrives — re-blur.
    const onWinBlur = () => setSecHold(false);
    // capture phase: run before any focused element's own key handling
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onWinBlur);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onWinBlur);
    };
  }, [changeOffset, toast, clearCloseTimer, resumeFromHover, toggleSidebar, toggleKnown, toggleHardMode, gotoEpisode, togglePreStudy]);

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
    deckCardsRef.current = new Map(anki.words.map((w) => [w.front, w]));
  }, []);

  // Pre-study bulk add: text-only lookup then a LIGHT Anki add (no mediaId /
  // timestamp → server skips frame + audio capture), sequentially per word.
  const onBulkAdd = useCallback(async () => {
    if (preBusyRef.current) return;
    const todo = preStudy?.items.filter((it) => it.checked && !it.added) ?? [];
    if (todo.length === 0) return;
    preBusyRef.current = true;
    setPreBusy(true);
    setPreProg(0);
    let done = 0;
    let failed = 0;
    for (const it of todo) {
      // Abort the remaining sequence when the panel was closed (Esc/`w`/
      // Close) or the Player unmounted — don't keep firing lookups/adds
      // into the void. Words already added stay added.
      if (!mountedRef.current || !preStudyOpenRef.current) break;
      // OPTIMISTIC: mark the lemma known right away (underline flips
      // instantly); reverted below if the add fails.
      setKnownFronts((prev) => new Set(prev).add(it.lemma));
      // matching secondary (RU) cue at the word's first occurrence, if any
      const sIdx = activeCueIndex(
        secondaryCuesRef.current,
        it.time,
      );
      const sText = sIdx >= 0 ? secondaryCuesRef.current[sIdx]!.text : undefined;
      try {
        const lk = await lookupApi({
          word: it.lemma,
          context: it.context,
          source: entry.name,
          ...(preFrames
            ? { mediaId: entry.id, timestamp: it.time, withFrame: true }
            : {}),
        });
        await (api.ankiAdd as (p: Record<string, unknown>) => Promise<unknown>)({
          word: it.lemma,
          reading: lk.reading || it.reading || "",
          translation: lk.translation,
          notes: lk.notes,
          context: it.context,
          ...(sText ? { sentenceTranslation: sText } : {}),
          ...(preFrames ? { mediaId: entry.id, timestamp: it.time } : {}),
        });
        // optimistic known-marking (front format matches the server's card)
        const front = lk.reading ? `${it.lemma} [${lk.reading}]` : it.lemma;
        setKnownFronts((prev) => new Set(prev).add(front));
        setPreStudy((prev) =>
          prev
            ? {
                ...prev,
                items: prev.items.map((p) =>
                  p.lemma === it.lemma ? { ...p, added: true } : p,
                ),
              }
            : prev,
        );
      } catch {
        // revert the optimistic known-marking for this lemma
        setKnownFronts((prev) => {
          const next = new Set(prev);
          next.delete(it.lemma);
          return next;
        });
        failed++;
      }
      done++;
      setPreProg(done);
    }
    preBusyRef.current = false;
    sessCardsRef.current += done - failed;
    tmEvent("prestudy_add", { count: done - failed });
    if (!mountedRef.current) return;
    setPreBusy(false);
    if (failed > 0) toast(`added ${done - failed}/${todo.length} (${failed} failed)`);
    void refreshAnki();
  }, [preStudy, entry.id, entry.name, preFrames, toast, refreshAnki]);

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

  // fetch encounter history when a word popup opens (lazy, cached per lemma)
  useEffect(() => {
    if (!popup || popup.kind !== "word") {
      setEncHits(null);
      setEncOpen(false);
      return;
    }
    setEncOpen(false);
    const lemma = popup.dictForm ?? popup.surface;
    const cached = encCache.current.get(lemma);
    if (cached) {
      setEncHits(cached);
      return;
    }
    setEncHits(null);
    let cancelled = false;
    void api
      .indexEncounters(lemma, [entry.id])
      .then((hits) => {
        encCache.current.set(lemma, hits);
        if (!cancelled) setEncHits(hits);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [popup?.kind, popup?.surface, popup?.dictForm, entry.id]);

  // fetch lookup when popup target changes (default: NO frame — saves latency)
  useEffect(() => {
    if (!popup || popup.kind !== "word") {
      setLookup(null);
      return;
    }
    setFrameAdded(false);
    setFrameLoading(false);
    sessLookupsRef.current += 1; // session-summary counter
    // Word already in the deck? Fill the popup from the existing card —
    // no Gemini call. The Regenerate button still forces a fresh lookup.
    const matched = matchFront(
      wordIndexRef.current,
      popup.surface,
      popup.reading,
      popup.dictForm,
    );
    const deckCard = matched ? deckCardsRef.current.get(matched) : undefined;
    if (deckCard) {
      const m = deckCard.front.match(/^(.+?)\s*\[(.+?)\]\s*$/);
      setLookup({
        reading: m?.[2] ?? "",
        translation: deckCard.back,
        notes: deckCard.notes ?? "",
        context: "",
      });
      setLookupFromDeck(true);
      setLookupLoading(false);
      return;
    }
    setLookupFromDeck(false);
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
      setLookupFromDeck(false);
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
        ...(popup.secondary ? { sentenceTranslation: popup.secondary } : {}),
        mediaId: entry.id,
        timestamp: v?.currentTime ?? 0,
        ...cueBoundsAt(popup.timestamp),
      });
      sessCardsRef.current += 1;
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
        context: "",
        ...(popup.secondary ? { sentenceTranslation: popup.secondary } : {}),
        mediaId: entry.id,
        timestamp: v?.currentTime ?? popup.timestamp,
        ...cueBoundsAt(popup.timestamp),
      });
      sessCardsRef.current += 1;
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

  // --- condensed audio export (all ja dialogue spans → one mp3) ---
  const [condenseBusy, setCondenseBusy] = useState(false);
  const condenseBusyRef = useRef(false); // sync reentrance guard
  const onCondense = useCallback(async () => {
    if (condenseBusyRef.current) return;
    condenseBusyRef.current = true;
    setCondenseBusy(true);
    toast("condensing audio… (can take ~1 min)");
    try {
      const r = await api.condense(entry.id);
      toast(`condensed ${fmtTime(r.duration)} → ${r.path}`);
    } catch (e) {
      toast(`condense failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      condenseBusyRef.current = false;
      if (mountedRef.current) setCondenseBusy(false);
    }
  }, [entry.id, toast]);

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
      let target: number | null = null;
      if (v.currentTime > 10 && cues.length > 0) {
        const t = v.currentTime - subOffset;
        if (activeCueIndex(cues, t) < 0) {
          const nextIdx = cues.findIndex((c) => c.start > t);
          if (nextIdx >= 0) {
            const prevEnd = nextIdx > 0 ? cues[nextIdx - 1]!.end : 0;
            if (cues[nextIdx]!.start - prevEnd > 60) {
              target = Math.max(0, cues[nextIdx]!.start + subOffset - 1);
            }
          }
        }
      }
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

  // Furigana on unknown kanji (settings toggle, default on). Maturity-based
  // hiding lives in TokenLine (shared by the overlay and the sidebar).
  const furiganaOn = settings.furigana !== false;

  // --- dialogue-density strip: 2s bins, alpha = speech seconds per bin ---
  const densityCanvasRef = useRef<HTMLCanvasElement>(null);
  const densityMarkerRef = useRef<HTMLDivElement>(null);
  const hasDensity = displayCues.length > 0 && videoDuration > 0;
  useEffect(() => {
    const c = densityCanvasRef.current;
    if (!c || !hasDensity) return;
    const BIN = 2;
    const nBins = Math.max(1, Math.ceil(videoDuration / BIN));
    const speech = new Float32Array(nBins);
    for (const cue of displayCues) {
      const s = Math.max(0, cue.start);
      const e = Math.min(videoDuration, cue.end);
      for (let b = Math.max(0, Math.floor(s / BIN)); b < nBins && b * BIN < e; b++) {
        speech[b] =
          (speech[b] ?? 0) +
          Math.max(0, Math.min(e, (b + 1) * BIN) - Math.max(s, b * BIN));
      }
    }
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const cssW = c.clientWidth || 640;
      c.width = Math.max(1, Math.round(cssW * dpr));
      c.height = Math.max(1, Math.round(4 * dpr));
      const ctx = c.getContext("2d");
      if (!ctx) return;
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      ctx.fillRect(0, 0, c.width, c.height);
      const px = c.width / nBins;
      for (let b = 0; b < nBins; b++) {
        const a = Math.min(1, speech[b]! / BIN);
        if (a <= 0.01) continue;
        ctx.fillStyle = `rgba(255,255,255,${(0.4 * a).toFixed(3)})`;
        ctx.fillRect(b * px, 0, Math.ceil(px), c.height);
      }
    };
    draw();
    // redraw at the new CSS width on layout changes (fullscreen, resize) —
    // otherwise the bitmap keeps its old width and stretches blurry.
    const ro = new ResizeObserver(draw);
    ro.observe(c);
    return () => ro.disconnect();
  }, [displayCues, videoDuration, hasDensity]);
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
  }, [entry.id]);
  // --- custom controls bar (replaces the native <video controls>) ---
  const seekRef = useRef<HTMLDivElement>(null);
  const playedRef = useRef<HTMLDivElement>(null);
  const scrubbingRef = useRef(false);
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
  }, [entry.id]);

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
  }, [entry.id]);

  // Autohide: fade the bar (and the cursor) after 2.5s without mouse movement
  // while playing. Reappears on mousemove / pause. The bar OVERLAYS the video,
  // so the subtitle overlay never shifts when it hides.
  const [hudHidden, setHudHidden] = useState(false);
  const hudTimerRef = useRef<number | null>(null);
  const barHoverRef = useRef(false);
  const pokeHud = useCallback(() => {
    setHudHidden(false);
    if (hudTimerRef.current != null) window.clearTimeout(hudTimerRef.current);
    hudTimerRef.current = window.setTimeout(() => {
      hudTimerRef.current = null;
      const v = videoRef.current;
      if (v && !v.paused && !scrubbingRef.current && !barHoverRef.current)
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
  }, [entry.id, pokeHud]);

  // Stage mouse handling: leaving the stage hides the HUD instantly (no 2.5s
  // wait); in fullscreen, hugging the top/side edges (~8px) also hides it.
  const hideHudNow = useCallback(() => {
    if (hudTimerRef.current != null) window.clearTimeout(hudTimerRef.current);
    hudTimerRef.current = null;
    const v = videoRef.current;
    if (v && !v.paused && !scrubbingRef.current && !barHoverRef.current)
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

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    pausedByHoverRef.current = false; // user took control
    if (v.paused) void v.play().catch(() => {});
    else v.pause();
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void stageRef.current?.requestFullscreen?.();
  }, []);

  const seekToClientX = useCallback((clientX: number) => {
    const bar = seekRef.current;
    const v = videoRef.current;
    if (!bar || !v || !(v.duration > 0)) return;
    const r = bar.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    v.currentTime = frac * v.duration;
  }, []);
  const hoverTimeAt = useCallback((clientX: number): { x: number; t: number } | null => {
    const bar = seekRef.current;
    const v = videoRef.current;
    if (!bar || !v || !(v.duration > 0)) return null;
    const r = bar.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    return { x: frac * r.width, t: frac * v.duration };
  }, []);
  const onSeekDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      scrubbingRef.current = true;
      seekToClientX(e.clientX);
      setSeekHover(hoverTimeAt(e.clientX));
    },
    [seekToClientX, hoverTimeAt],
  );
  const onSeekMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      setSeekHover(hoverTimeAt(e.clientX));
      if (scrubbingRef.current) seekToClientX(e.clientX);
    },
    [seekToClientX, hoverTimeAt],
  );
  const onSeekUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    scrubbingRef.current = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  }, []);
  const onSeekLeave = useCallback(() => {
    if (!scrubbingRef.current) setSeekHover(null);
  }, []);

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
      <div className="episode-title-row">
        <button
          className="btn icon ep-nav"
          title="previous episode (p)"
          aria-label="Previous episode"
          onClick={() => void gotoEpisode(-1)}
        >
          <ChevronLeftIcon size={16} />
        </button>
        <div className="episode-title" title={entry.name}>
          {entry.name.replace(/\.[^.]+$/, "")}
        </div>
        <button
          className="btn icon ep-nav"
          title="next episode (n)"
          aria-label="Next episode"
          onClick={() => void gotoEpisode(1)}
        >
          <ChevronRightIcon size={16} />
        </button>
      </div>
      <div className="stage-row">
      <div
        className={`video-stage${hudHidden ? " hud-hidden" : ""}`}
        ref={stageRef}
        style={
          {
            aspectRatio: videoAspect,
            "--va": videoAspect,
          } as React.CSSProperties
        }
        onMouseMove={onStageMouseMove}
        onMouseLeave={hideHudNow}
      >
        {/* Custom controls (the .vbar below) replace the native ones: the
            native bar fought our density strip and its fullscreen button
            (which would hide the subtitle overlay) had to be disabled. */}
        <video
          ref={videoRef}
          src={mediaUrl(entry.id)}
          onClick={togglePlay}
        />
        <div
          className={`sub-overlay${hardMode ? " hardmode" : ""}${
            hardMode && (isPaused || revealTail) ? " reveal" : ""
          }`}
        >
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
              className={`sub-secondary${secShow || secHold || blurOff ? " show" : ""}`}
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
                title="Dialogue density — click to seek"
              />
            )}
            <div ref={playedRef} className="seek-played" />
            <div ref={densityMarkerRef} className="density-marker" />
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
        </div>
        {skipTarget != null && (
          <button
            className="skip-pill"
            onClick={onSkipGap}
            title="No dialogue here — jump to the next line"
          >
            Skip →
          </button>
        )}
        {sessionSummary && (
          <div className="session-summary">
            <div className="ss-title">session</div>
            <div className="ss-line">
              {sessionSummary.min} min · {sessionSummary.cues} cues
            </div>
            <div className="ss-line">
              {sessionSummary.lookups} lookups · {sessionSummary.cards} cards ·{" "}
              {sessionSummary.known} marked known
            </div>
            {sessionSummary.streak != null && (
              <div className="ss-line ss-dim">
                streak: {sessionSummary.streak} day
                {sessionSummary.streak === 1 ? "" : "s"}
              </div>
            )}
            <div className="ss-line ss-dim">
              next episode in 5s — any key cancels
            </div>
          </div>
        )}
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
            {freqMap && (
              <span
                className="freq-tag"
                title="How common this word is (rank in a 30k frequency list)"
              >
                {freqTier(freqRankOf(freqMap, popup.surface, popup.dictForm))}
              </span>
            )}
            {lookupFromDeck && (
              <span
                className="deck-tag"
                title="Filled from your existing Anki card — no AI call. Use ⟳ to regenerate."
              >
                from your deck
              </span>
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
              {reloadLoading ? "…" : <RotateCwIcon size={14} />}
            </button>
          </div>
          {encHits && encHits.length > 0 && (
            <div className="enc">
              <div
                className="enc-line"
                title="Where else this word appears in the library"
                onClick={() => setEncOpen((o) => !o)}
              >
                encounters: {encHits.reduce((s, h) => s + h.count, 0)}
              </div>
              {encOpen &&
                encHits
                  .flatMap((h) =>
                    h.cues.map((c) => ({
                      mediaId: h.mediaId,
                      name: h.name,
                      start: c.start,
                      text: c.text,
                    })),
                  )
                  .slice(0, 5)
                  .map((s, i) => (
                    <div
                      key={`${s.mediaId}:${s.start}:${i}`}
                      className="enc-hit"
                      onClick={() => {
                        window.location.hash = `#/play/${s.mediaId}@${s.start}`;
                      }}
                    >
                      <span className="enc-meta">
                        {s.name.replace(/\.[^.]+$/, "")} · {fmtTime(s.start)}
                      </span>{" "}
                      {s.text}
                    </div>
                  ))}
            </div>
          )}
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

      {preStudy && (
        <div className="lookup prestudy">
          <div className="prestudy-head">
            <span className="word">pre-study</span>
            <span
              className="prestudy-sub"
              title="Unknown words in the upcoming playback window, most common first"
            >
              next {prestudyMin} min
              {!preStudy.loading && ` · ${preStudy.items.length} new`}
            </span>
            <label
              className="prestudy-frames"
              title="Also capture a video frame for each card (slower)"
            >
              <input
                type="checkbox"
                checked={preFrames}
                disabled={preBusy}
                onChange={togglePreFrames}
              />
              with frames
            </label>
          </div>
          <div className="prestudy-list">
            {preStudy.loading && <div className="spin">scanning…</div>}
            {!preStudy.loading && preStudy.items.length === 0 && (
              <div className="spin">nothing new</div>
            )}
            {preStudy.items.map((it) => (
              <label
                key={it.lemma}
                className={`prestudy-row${it.added ? " added" : ""}`}
              >
                <input
                  type="checkbox"
                  checked={it.checked}
                  disabled={it.added || preBusy}
                  onChange={() => togglePreItem(it.lemma)}
                />
                <span className="ps-word">{it.lemma}</span>
                {it.reading && it.reading !== it.lemma && (
                  <span className="ps-reading">{it.reading}</span>
                )}
                <span
                  className="freq-tag"
                  title="How common this word is (rank in a 30k frequency list)"
                >
                  {freqTier(it.rank)}
                </span>
                {it.added && <span className="ps-added">✓</span>}
              </label>
            ))}
          </div>
          {(() => {
            const todo = preStudy.items.filter((i) => i.checked && !i.added);
            return (
              <div className="row">
                <button
                  className="btn"
                  disabled={preBusy || todo.length === 0}
                  title="Create one Anki card per checked word (sequentially)"
                  onClick={() => void onBulkAdd()}
                >
                  {preBusy
                    ? `Adding… ${preProg}`
                    : `Add ${todo.length} to Anki`}
                </button>
                <button className="btn" onClick={() => setPreStudy(null)}>
                  Close
                </button>
              </div>
            );
          })()}
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
              title="Primary subtitle track (the language you're learning)"
              value={primaryId}
              onChange={(e) => {
                if (e.target.value === "__generate") void onGenerateJa();
                else if (e.target.value === "__condense") void onCondense();
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
              {hasJa && !condenseBusy && !whisperBusy && (
                <option value="__condense">+ condensed audio…</option>
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
              title="Secondary subtitle track (translation, blurred until hovered)"
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
        {condenseBusy && <span className="spinner-line">Condensing audio…</span>}
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
