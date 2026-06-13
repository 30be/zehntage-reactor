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
import {
  buildWordIndex,
  matchFront,
  withFront,
  withoutFront,
  type WordIndex,
} from "./progress.ts";
import { wordKey } from "./TokenLine.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { loadAccents } from "./accent.ts";
import { readBlacklist, writeBlacklist } from "./blacklist.ts";
import { freqRank, loadFreq } from "./freq.ts";
import { tmHeartbeat, tmEvent, tmAnomaly } from "./telemetry.ts";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  BookOpenIcon,
} from "./icons.tsx";
import { refreshAnkiWords, useAnkiWordsLive } from "./ankicache.ts";
import { registerCommands } from "./commands.ts";
import { rankPreStudy } from "./prestudy.ts";
import { nextIPlusOne } from "./iplusone.ts";
import { isJaLang } from "./lang.ts";
import { readKnownWords } from "./coverage.ts";
import {
  cueTokensGet,
  cueTokensPut,
  deckCardToLookup,
  fmtTime,
  HOVER_CLOSE_MS,
  HOVER_OPEN_MS,
  markedContext,
  qaCacheGet,
  qaCachePut,
  readSavedTracks,
  saveTracks,
  type PopupState,
  type QaItem,
} from "./player/shared.ts";
import { useWhisperJob } from "./player/useWhisperJob.ts";
import { shouldSkipAutopause } from "./player/autopause.ts";
import { computeCueUnknowns } from "./player/cueUnknowns.ts";
import { useResume } from "./player/useResume.ts";
import { useSession } from "./player/useSession.ts";
import { useAutoNext } from "./player/useAutoNext.ts";
import { usePlayerHotkeys } from "./player/useHotkeys.ts";
import { useHudAutohide } from "./player/useHudAutohide.ts";
import { useSubControls } from "./player/useSubControls.ts";
import { useEcho } from "./player/useEcho.ts";
import { useHoverPause } from "./player/useHoverPause.ts";
import { LookupPanel } from "./player/LookupPanel.tsx";
import {
  PreStudyPanel,
  type PreStudyItem,
  type PreStudyState,
} from "./player/PreStudyPanel.tsx";
import { Vbar } from "./player/Vbar.tsx";
import { QuizPanel, type QuizResult } from "./player/QuizPanel.tsx";
import { SubOverlay } from "./player/SubOverlay.tsx";
import { EchoOverlay } from "./player/EchoOverlay.tsx";
import { SessionHud } from "./player/SessionHud.tsx";
import { SessionSummary } from "./player/SessionSummary.tsx";
import { JobProgressBar } from "./player/JobProgressBar.tsx";
import { buildQuiz, type QuizCue, type QuizItem } from "./quiz.ts";

interface Props {
  entry: LibraryEntry;
  /** Initial seek (seconds) from a "#/play/<id>@t" deep link — wins over resume. */
  startAt?: number;
  toast: (msg: string) => void;
  settings: Record<string, unknown>;
}

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
  // Translation tooltip (the dim "?" at the JP line's right edge) is open
  // because the cursor rests on the hint.
  const [secShow, setSecShow] = useState(false);
  // RU reveal: hold `b` = temporary tooltip; quick double-press `b` = session toggle.
  const [secHold, setSecHold] = useState(false);
  const [blurOff, setBlurOff] = useState(false);
  const blurOffRef = useRef(false);
  const lastBDownRef = useRef(0);
  // Autopause: no UI control — toggled with the `p` hotkey, persisted.
  const [autopause, setAutopause] = useState(() => {
    try {
      return localStorage.getItem("zr.autopause") === "1";
    } catch {
      return false;
    }
  });
  const autopauseRef = useRef(false);
  const toggleAutopause = useCallback(() => {
    setAutopause((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("zr.autopause", next ? "1" : "0");
      } catch {
        /* ignore */
      }
      toast(next ? "autopause on" : "autopause off");
      return next;
    });
  }, [toast]);
  const prevActiveP = useRef(-1);
  // Autopause loop-guard: index of the cue we already autopaused on. We don't
  // pause again for that cue until playback naturally enters the next one.
  const lastAutopausedIdx = useRef(-1);
  // True while WE are performing the autopause seek-back, so the user-seek
  // detector below doesn't treat it as a manual seek.
  const internalSeekRef = useRef(false);
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
  const subOffsetRef = useRef(0);
  const primaryCuesRef = useRef<Cue[]>([]);

  const [tokens, setTokens] = useState<KToken[] | null>(null);
  const tracksLoaded = useRef(false);
  // True while the selected primary track's cues are still being fetched —
  // drives a dim "loading subtitles…" line in the overlay.
  const [cuesLoading, setCuesLoading] = useState(false);

  // Warm the tokenizer as soon as a primary track is selected, in parallel
  // with its cue fetch: kuromoji's dictionary load takes seconds and used to
  // start only after the first cue text appeared (serializing the delays).
  // NOT at mount: the dict parse blocks the main thread and would delay the
  // (milliseconds-fast) cue fetch + first plain-text subtitle render.
  const warmTokenizer = useCallback(() => {
    void getTokenizer().catch(() => {});
  }, []);

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

  // Live deck (web/ankicache.ts): background ETag revalidations and optimistic
  // add/delete write-throughs re-render the known-word underlines without an
  // explicit refreshAnki() roundtrip.
  const liveAnki = useAnkiWordsLive();
  // Optimistic fronts not yet confirmed by the server cache: merged into every
  // liveAnki snapshot so a background revalidation that raced an add can't
  // un-mark a freshly-added word. Confirmed fronts drop out of the set.
  const pendingFrontsRef = useRef<Set<string>>(new Set());
  // Instant feedback: the optimistic front goes into the WORD INDEX too, so
  // TokenLine recolors the word in the same render — not seconds later when
  // the server roundtrip + cache refresh lands.
  const markFrontOptimistic = useCallback((front: string) => {
    pendingFrontsRef.current.add(front);
    setKnownFronts((prev) => new Set(prev).add(front));
    setWordIndex((prev) => withFront(prev, front));
  }, []);
  const unmarkFrontOptimistic = useCallback((front: string) => {
    pendingFrontsRef.current.delete(front);
    setKnownFronts((prev) => {
      const next = new Set(prev);
      next.delete(front);
      return next;
    });
    setWordIndex((prev) => withoutFront(prev, front));
  }, []);
  useEffect(() => {
    if (!liveAnki) return;
    const fronts = new Set(liveAnki.words.map((w) => w.front));
    for (const f of pendingFrontsRef.current) {
      if (fronts.has(f)) pendingFrontsRef.current.delete(f); // confirmed
      else fronts.add(f); // still pending — keep the optimistic mark
    }
    // pending (not-yet-confirmed) optimistic fronts survive the rebuild
    let idx = buildWordIndex(liveAnki.words, liveAnki.progress);
    for (const f of pendingFrontsRef.current) idx = withFront(idx, f);
    setWordIndex(idx);
    setKnownFronts(fronts);
    deckCardsRef.current = new Map(liveAnki.words.map((w) => [w.front, w]));
  }, [liveAnki]);

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
  const [knownWords, setKnownWords] = useState<Set<string>>(() =>
    readKnownWords(),
  );
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

  // --- blacklist (zr.blacklist, toggled with `x`): no underline/furigana,
  // excluded from unknown counts (smart autopause + heat) and pre-study ---
  const [blacklist, setBlacklist] = useState<Set<string>>(() => readBlacklist());
  const blacklistRef = useRef(blacklist);
  useEffect(() => {
    blacklistRef.current = blacklist;
  }, [blacklist]);
  const toggleBlacklist = useCallback((key: string) => {
    setBlacklist((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      writeBlacklist(next);
      return next;
    });
  }, []);

  // --- pitch accent: lazy Kanjium map; settings toggle (default on) ---
  const pitchOn = settings.pitchAccent !== false;
  const [accents, setAccents] = useState<Map<string, number> | null>(null);
  useEffect(() => {
    if (!pitchOn) return;
    let cancelled = false;
    void loadAccents()
      .then((m) => !cancelled && setAccents(m))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [pitchOn]);

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
    const [tok, freq, showFreq] = await Promise.all([
      getTokenizer(),
      loadFreq().catch(() => new Map<string, number>()),
      // show-local lemma counts (server lemma index) for prestudy ordering;
      // null on failure → fall back to pure global-frequency order.
      fetch(`/api/index/showfreq?mediaIds=${entry.id}`)
        .then((r) => (r.ok ? (r.json() as Promise<Record<string, number>>) : null))
        .catch(() => null),
    ]);
    const seen = new Map<string, PreStudyItem>();
    // per-cue unknown lemma lists, reusing this same tokenization pass —
    // feeds the i+1 / muddy ranking (web/prestudy.ts)
    const cueUnknownLemmas: string[][] = [];
    for (const cue of cues) {
      const unknowns: string[] = [];
      for (const tk of tok.tokenize(cue.text)) {
        if (!isLexical(tk)) continue;
        // particles/auxiliaries aren't study material
        if (tk.pos === "助詞" || tk.pos === "助動詞") continue;
        const key = wordKey(tk);
        if (knownWordsRef.current.has(key)) continue;
        if (blacklistRef.current.has(key)) continue;
        if (
          matchFront(
            wordIndexRef.current,
            tk.surface_form,
            tk.reading,
            tk.basic_form,
          ) != null
        )
          continue;
        unknowns.push(key);
        if (seen.has(key)) continue;
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
      cueUnknownLemmas.push(unknowns);
    }
    // mining.prestudyRank order: show-local count desc, global rank asc tiebreak
    const base = [...seen.values()].sort((a, b) => {
      if (showFreq) {
        const ca = showFreq[a.lemma] ?? 0;
        const cb = showFreq[b.lemma] ?? 0;
        if (ca !== cb) return cb - ca;
      }
      return (a.rank ?? Infinity) - (b.rank ?? Infinity);
    });
    // retention-aware re-rank: i+1 candidates first, muddy ones demoted
    // (and unchecked by default, top 5 stay checked)
    const items: PreStudyItem[] = rankPreStudy(base, cueUnknownLemmas);
    // only fill in if the panel is still open
    setPreStudy((prev) => (prev ? { loading: false, items } : prev));
  }, [entry.id]);

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

  // --- comprehension quiz (`q`): short check built from watched cues ---
  const [quiz, setQuiz] = useState<QuizItem[] | null>(null);
  const quizOpenRef = useRef(false);
  useEffect(() => {
    quizOpenRef.current = quiz != null;
  }, [quiz]);

  const buildQuizFromWatched = useCallback(async (): Promise<QuizItem[]> => {
    const v = videoRef.current;
    const t = v ? v.currentTime - subOffsetRef.current : Infinity;
    // cues the user has already watched (start has passed); fall back to all.
    const ja = primaryCuesRef.current.filter((c) => c.start <= t);
    const cues = (ja.length > 0 ? ja : primaryCuesRef.current).slice(-40);
    const sec = secondaryCuesRef.current;
    const tok = await getTokenizer().catch(() => null);
    const quizCues: QuizCue[] = cues.map((c) => {
      // align translation by cue overlap (same approach as the active-cue map)
      const mid = (c.start + c.end) / 2;
      const s = sec.find((x) => x.start <= mid && x.end >= mid);
      const words: { surface: string; lemma: string }[] = [];
      if (tok) {
        for (const tk of tok.tokenize(c.text)) {
          if (!isLexical(tk)) continue;
          if (tk.pos === "助詞" || tk.pos === "助動詞") continue;
          words.push({ surface: tk.surface_form, lemma: wordKey(tk) });
        }
      }
      return { text: c.text, translation: s?.text, words };
    });
    // deck = lemmas already mined (preferred cloze blanks)
    const deck = new Set<string>();
    for (const it of quizCues) {
      for (const w of it.words ?? []) {
        if (
          matchFront(
            wordIndexRef.current,
            w.surface,
            undefined,
            w.lemma,
          ) != null
        )
          deck.add(w.lemma);
      }
    }
    return buildQuiz(quizCues, { deck, known: knownWordsRef.current, count: 6 });
  }, []);

  const quizBuildingRef = useRef(false);
  // Bumped on every successful quiz build so the panel remounts with a clean
  // slate (idx/correct/reported) — used as QuizPanel's React key. Needed for
  // Retry: setQuiz(newItems) alone keeps the same instance and stale state.
  const quizRunRef = useRef(0);
  const toggleQuiz = useCallback(() => {
    setQuiz((prev) => {
      if (prev) {
        quizBuildingRef.current = false;
        return null;
      }
      // guard against a second `q` press during the async build window spawning
      // a concurrent build that could clobber the first
      if (quizBuildingRef.current) return prev;
      quizBuildingRef.current = true;
      void buildQuizFromWatched().then((items) => {
        quizBuildingRef.current = false;
        if (!mountedRef.current) return;
        if (items.length === 0) {
          toast("not enough watched cues for a quiz");
          setQuiz(null);
          return;
        }
        quizRunRef.current += 1;
        setQuiz(items);
      });
      return prev; // open only once items are ready (avoids an empty flash)
    });
  }, [buildQuizFromWatched, toast]);

  // Kept in a ref so the `ended` handler (whose effect deps stay minimal) can
  // auto-launch the same quiz `q` builds without re-subscribing every render.
  const toggleQuizRef = useRef(toggleQuiz);
  useEffect(() => {
    toggleQuizRef.current = toggleQuiz;
  }, [toggleQuiz]);
  // Latest auto-quiz setting; the per-episode-end double-fire guard now lives
  // in useAutoNext (autoQuizFiredRef).
  const autoQuizRef = useRef(settings.autoQuizPrompt !== false);
  useEffect(() => {
    autoQuizRef.current = settings.autoQuizPrompt !== false;
  }, [settings.autoQuizPrompt]);

  const onQuizDone = useCallback(
    (r: QuizResult) => {
      tmEvent("quiz.result", {
        mediaId: entry.id,
        total: r.total,
        correct: r.correct,
      });
    },
    [entry.id],
  );

  // Retry from the quiz done-screen: rebuild a fresh quiz over the same watched
  // cues. Reuses the same async build + double-fire guard as toggleQuiz so a
  // concurrent build can't clobber. QuizPanel remounts on the new items array.
  const onQuizRetry = useCallback(() => {
    if (quizBuildingRef.current) return;
    quizBuildingRef.current = true;
    void buildQuizFromWatched().then((items) => {
      quizBuildingRef.current = false;
      if (!mountedRef.current) return;
      if (items.length === 0) {
        toast("not enough watched cues for a quiz");
        setQuiz(null);
        return;
      }
      quizRunRef.current += 1;
      setQuiz(items);
    });
  }, [buildQuizFromWatched, toast]);

  // --- shadowing loop (`s`): kept in refs to avoid re-renders on every cue ---
  // idx = primary-cue index being looped; remaining = repeats left.
  // Count comes from the Settings page ("Shadowing repeats", 0 = infinite).
  const loopRef = useRef<{ idx: number; remaining: number } | null>(null);
  const shadowRepeats = Math.max(0, Math.round(Number(settings.shadowRepeats)) || 0);
  const shadowRepeatsRef = useRef(shadowRepeats);
  useEffect(() => {
    shadowRepeatsRef.current = shadowRepeats;
  }, [shadowRepeats]);

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
  // a11y: remember focus before the lookup panel opens, restore on close
  const prevLookupFocusRef = useRef<HTMLElement | null>(null);
  const [popupPos, setPopupPos] = useState<React.CSSProperties>({
    visibility: "hidden",
  });
  const [lookup, setLookup] = useState<WordLookup | null>(null);
  const [lookupLoading, setLookupLoading] = useState(false);
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

  // hover-to-pause engine (extracted). Owns openTimer/closeTimer +
  // pausedByHoverRef/secondaryHoveredRef; pin/popup state stays in Player and
  // is passed in so the play-takeover effect closes the pinned panel.
  const {
    pauseForHover,
    resumeFromHover,
    clearOpenTimer,
    clearCloseTimer,
    openTimer,
    closeTimer,
    pausedByHoverRef,
    secondaryHoveredRef,
  } = useHoverPause({ videoRef, pinnedRef, setPinned, setPopup });

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

  // Whisper job lifecycle (web/player/useWhisperJob.ts): start/cancel, SSE
  // attach + bounded re-attach, post-reload rediscovery, live streamed cues.
  // Live cues are kept SEPARATE from the user-selected primary track's cues
  // so a batch job can't clobber them; they drive the overlay/sidebar only
  // when no primary track is selected or the selected primary is the
  // whisper-generated ja track-to-be.
  const {
    whisperBusy,
    whisperStatus,
    whisperLastEnd,
    whisperCues,
    whisperJobRef,
    clearWhisperCues,
    onGenerateJa,
    onCancelWhisper,
  } = useWhisperJob({
    mediaId: entry.id,
    toast,
    setTracks,
    setPrimaryId,
    mountedRef,
  });
  const whisperLive =
    whisperCues.length > 0 && (!primaryId || primaryId === "sidecar:gen:ja");
  const displayCues = whisperLive ? whisperCues : primaryCues;

  // Subtitle offset + scale controls + the OP/ED skip-gap pill. subOffsetRef is
  // owned here (shared infra) and threaded into the hook to stay in sync.
  const {
    subOffset,
    changeOffset,
    subScale,
    adjustSubScale,
    skipTarget,
    onSkipGap,
  } = useSubControls({
    videoRef,
    subOffsetRef,
    mediaId: entry.id,
    primaryId,
    displayCues,
    settings,
    toast,
  });

  // --- smart autopause: per-cue unknown-lexical-token counts (memoized) ---
  // null while not computed (or mode "every") — the autopause branch treats
  // null as "pause" so the legacy behavior is the safe default.
  // Always computed (not only in "unknown" autopause mode) — the difficulty
  // heat strip reuses these counts. State drives the heat redraw; the ref
  // feeds the autopause branch without re-running its effect.
  const cueUnknownsRef = useRef<number[] | null>(null);
  // per-cue unknown lemma lists (parallel to cueUnknowns) — HUD unique counter
  const cueUnknownLemmasRef = useRef<string[][] | null>(null);
  const [cueUnknowns, setCueUnknowns] = useState<number[] | null>(null);
  useEffect(() => {
    cueUnknownsRef.current = null;
    cueUnknownLemmasRef.current = null;
    setCueUnknowns(null);
    if (displayCues.length === 0) return;
    let cancelled = false;
    void getTokenizer()
      .then((tok) => {
        if (cancelled) return;
        const { counts, lemmas } = computeCueUnknowns(
          displayCues.map((c) => c.text),
          tok,
          { wordIndex, knownWords, blacklist },
        );
        if (!cancelled) {
          cueUnknownsRef.current = counts;
          cueUnknownLemmasRef.current = lemmas;
          setCueUnknowns(counts);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [displayCues, wordIndex, knownWords, blacklist]);

  // --- session counters + HUD (extracted to useSession). All 9 session refs +
  // summary/HUD state are owned by the hook and returned so the still-inline
  // concerns (activeCues, autoNext, lookup, onAdd, bulkAdd, echo, hotkeys) keep
  // mutating/reading the SAME ref instances. ---
  const {
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
  } = useSession();

  // --- Wave 13.A: smart-resume — now AUTO-resumes on load (see onMeta below).
  // The old "resume at MM:SS? press z" affordance + `z` hotkey were removed.

  // --- Wave 13.B: echo dictation mode (`e`) --- (extracted to useEcho)
  // internalSeekRef + sessEchoRef stay Player-owned and are passed in.
  const {
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
  } = useEcho({
    videoRef,
    displayCues,
    subOffsetRef,
    internalSeekRef,
    sessEchoRef,
    toast,
  });

  // --- Wave 13.C: seek to the next i+1 cue (exactly one unknown token) ---
  const seekIPlusOne = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    const cues = displayCues;
    const cur = activeCueIndex(cues, v.currentTime - subOffsetRef.current);
    const target = nextIPlusOne(cueUnknownsRef.current, cur);
    if (target == null) {
      toast("no i+1 cue");
      return;
    }
    const cue = cues[target];
    if (!cue) return;
    v.currentTime = Math.max(0, cue.start + subOffsetRef.current);
    toast(`i+1 cue ${target + 1}`);
  }, [displayCues, toast]);

  // --- load tracks + anki words ---
  // The Anki word list is NOT awaited before track selection: cue fetching
  // starts as soon as the subs list arrives, the deck index fills in async.
  useEffect(() => {
    let cancelled = false;
    // Kick the deck fetch; useAnkiWordsLive is the SINGLE consumer of the
    // result (cached snapshot renders immediately, fresh data arrives via the
    // ankicache notify channel). No second setState path racing it here.
    void api.ankiWords().catch(() => {});
    void (async () => {
      const ts = await api.subs(entry.id).catch(() => [] as SubTrackInfo[]);
      if (cancelled) return;
      setTracks(ts);

      // Auto-select sensible defaults: prefer a Japanese primary, ru/en secondary.
      const primLang = (settings.targetLang as string) || "ja";
      const secLang = (settings.knownLang as string) || "ru";
      const autoPrim =
        ts.find((t) => t.kind === "embedded" && isJaLang(t.lang)) ??
        ts.find((t) => isJaLang(t.lang)) ??
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
        ts.find((t) => t.id !== autoPrim?.id && t.lang === "ru") ??
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
      setCuesLoading(false);
      return;
    }
    let cancelled = false;
    setCuesLoading(true);
    const _cueFetchT0 = Date.now();
    void api
      .cues(entry.id, primaryId)
      .then((c) => {
        if (cancelled) return;
        const _ms = Date.now() - _cueFetchT0;
        tmEvent("perf.client.cue_fetch", { ms: _ms, trackId: primaryId });
        if (_ms > 1000) tmAnomaly("cue_fetch_slow", { ms: _ms, trackId: primaryId });
        // cues are in — NOW start the (main-thread-heavy) dict init so the
        // plain-text line renders first and tokens swap in when ready
        warmTokenizer();
        setPrimaryCues(c);
        // No whisper job running → any leftover live cues are stale now.
        if (whisperJobRef.current == null) clearWhisperCues();
      })
      .catch(() => !cancelled && setPrimaryCues([]))
      .finally(() => !cancelled && setCuesLoading(false));
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

  // --- resume position (extracted to useResume): save throttled while playing,
  // restore on metadata. A deep-link start time (#/play/<id>@t) wins over the
  // saved position, once — see the three-flag handshake inside the hook. ---
  useResume({ videoRef, mediaId: entry.id, startAt });

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
        if (!v.paused) tmEvent("cue_active", { mediaId: entry.id, idx });
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
  const secondaryCuesRef = useRef<Cue[]>([]);
  useEffect(() => {
    secondaryCuesRef.current = secondaryCues;
  }, [secondaryCues]);

  // popup-open flag for the hotkey handler (Escape closes the lookup panel)
  const popupOpenRef = useRef(false);
  // `a` (Anki toggle) and `g` (regenerate) reach their latest closures via
  // refs — they're defined far below, after the lookup state they need.
  const ankiToggleRef = useRef<() => void>(() => {});
  const regenLookupRef = useRef<() => void>(() => {});
  // known-set key of the word popup currently open (for the `k` hotkey)
  const popupKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (popup != null && !popupOpenRef.current) {
      prevLookupFocusRef.current = document.activeElement as HTMLElement;
    }
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
        const sorted = lib
          .slice()
          .sort((a, b) =>
            a.name.localeCompare(b.name, undefined, {
              numeric: true,
              sensitivity: "base",
            }),
          );
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

  // Auto-next: end-of-episode auto-advance + session summary (extracted to
  // useAutoNext). Owns gotoEpisodeRef/cancelAutoNextRef/autoQuizFiredRef; the
  // session refs + autoQuizRef/toggleQuizRef/setSessionSummary are passed IN as
  // the SAME instances so nothing forks. Deps stay minimal ([entry.id, toast]).
  useAutoNext({
    videoRef,
    mediaId: entry.id,
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
  });

  const primaryText = activeP >= 0 && activeP < displayCues.length ? displayCues[activeP]!.text : "";
  // Bounds-checked: activeS can be stale for one render after the secondary
  // track switches (off / another track) — secondaryCues shrinks before the
  // timeupdate effect recomputes activeS.
  const secondaryText =
    activeS >= 0 && activeS < secondaryCues.length
      ? secondaryCues[activeS]!.text
      : "";

  // --- lazy tokenize the active primary cue ---
  // While the tokenizer is still initializing, TokenLine renders the cue text
  // PLAIN (fallbackText) immediately — no blank overlay — and swaps to the
  // tokenized line when ready. Repeat cues hit the module-level cache.
  useEffect(() => {
    if (!primaryText) {
      setTokens(null);
      return;
    }
    const cached = cueTokensGet(primaryText);
    if (cached) {
      setTokens(cached);
      return;
    }
    setTokens(null); // show the plain line until tokens arrive
    let cancelled = false;
    void getTokenizer()
      .then((tok) => {
        if (cancelled) return;
        const toks = tok.tokenize(primaryText);
        cueTokensPut(primaryText, toks);
        setTokens(toks);
      })
      .catch(() => {
        if (!cancelled) setTokens(null);
      });
    return () => {
      cancelled = true;
    };
  }, [primaryText]);

  const refreshAnki = useCallback(async () => {
    // Force a fresh fetch; the result lands via the useAnkiWordsLive channel
    // (single source of truth — no direct setState here).
    await refreshAnkiWords().catch(() => {});
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
      markFrontOptimistic(it.lemma);
      // matching secondary (RU) cue at the word's first occurrence, if any
      const sIdx = activeCueIndex(
        secondaryCuesRef.current,
        it.time,
      );
      const sText = sIdx >= 0 ? secondaryCuesRef.current[sIdx]!.text : undefined;
      try {
        const lk = await api.lookup({
          word: it.lemma,
          context: it.context,
          source: entry.name,
          ...(preFrames
            ? { mediaId: entry.id, timestamp: it.time, withFrame: true }
            : {}),
        });
        await api.ankiAdd({
          word: it.lemma,
          reading: lk.reading || it.reading || "",
          translation: lk.translation,
          notes: lk.notes,
          context: it.context,
          ...(sText ? { sentenceTranslation: sText } : {}),
          ...(preFrames ? { mediaId: entry.id, timestamp: it.time } : {}),
        });
        // optimistic known-marking (front format matches the server's card);
        // the placeholder lemma mark is swapped for the real front so it
        // can't linger in pendingFronts forever (it never gets confirmed).
        const front = lk.reading ? `${it.lemma} [${lk.reading}]` : it.lemma;
        if (front !== it.lemma) unmarkFrontOptimistic(it.lemma);
        markFrontOptimistic(front);
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
        unmarkFrontOptimistic(it.lemma);
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
  }, [preStudy, entry.id, entry.name, preFrames, toast, refreshAnki, markFrontOptimistic, unmarkFrontOptimistic]);

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
        cueText: ctxOverride || primaryText,
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
    prevLookupFocusRef.current?.focus();
    prevLookupFocusRef.current = null;
  }, [clearCloseTimer, resumeFromHover]);

  // --- global hotkeys (web/player/useHotkeys.ts): work regardless of focus
  // (except real text inputs); handlers read the latest state via this ctx ---
  usePlayerHotkeys({
    videoRef,
    stageRef,
    preStudyOpenRef,
    quizOpenRef,
    popupOpenRef,
    popupKeyRef,
    hoveredKeyRef,
    pausedByHoverRef,
    askFocusedRef,
    subOffsetRef,
    primaryCuesRef,
    loopRef,
    shadowRepeatsRef,
    knownWordsRef,
    blacklistRef,
    sessKnownRef,
    lastBDownRef,
    blurOffRef,
    setBlurOff,
    setSecHold,
    ankiToggleRef,
    regenLookupRef,
    closePanel,
    closePreStudy: () => setPreStudy(null),
    adjustSubScale,
    changeOffset,
    toggleSidebar,
    toggleKnown,
    toggleBlacklist,
    gotoEpisode,
    togglePreStudy,
    toggleQuiz,
    toggleAutopause,
    toggleHud,
    toggleEcho,
    seekIPlusOne,
    toast,
  });

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
        cueText: primaryText,
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
    const cached = key ? qaCacheGet(key) : undefined;
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
    void api.explain({
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
      setLookup(deckCardToLookup(deckCard));
      setLookupLoading(false);
      return;
    }
    // Cache key includes the cue context so the same word in a NEW sentence
    // gets a fresh, context-correct answer instead of a stale cached one.
    const cacheKey = `${popup.surface} ${popup.context} :: ${popup.secondary ?? ""}`;
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
      const _lookupT0 = Date.now();
      p = api.lookup({
        word: surface,
        context: ctx,
        source: entry.name,
        secondary: popup.secondary,
      })
        .then((res) => {
          tmEvent("perf.client.lookup", { ms: Date.now() - _lookupT0, word: surface });
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

  // Regenerate the lookup text for the same word, BYPASSING the cache (force a
  // fresh Gemini call). Replaces the panel content and updates the cache.
  // Bound to the `g` hotkey (no button — laconic popup).
  const onReload = useCallback(async () => {
    if (!popup || popup.kind !== "word") return;
    setLookupLoading(true);
    try {
      const res = await api.lookup({
        word: popup.surface,
        context: popup.context,
        secondary: popup.secondary,
        source: entry.name,
        noCache: true,
      });
      lookupCache.current.set(`${popup.surface} ${popup.context} :: ${popup.secondary ?? ""}`, res);
      setLookup(res);
    } catch (e) {
      toast(`Regenerate failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setLookupLoading(false);
    }
  }, [popup, entry.name, toast]);
  regenLookupRef.current = () => void onReload();

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
  }, [popup, lookup, lookupLoading, explain, explainLoading, qa]);

  const popupFront = useMemo(() => {
    if (!popup) return null;
    // Front uses the dictionary (lemma) form so all conjugations match (the
    // lookup reading is the dict-form reading — it's looked up on the lemma).
    const word = popup.dictForm ?? popup.surface;
    const reading = lookup?.reading || popup.reading;
    return reading ? `${word} [${reading}]` : word;
  }, [popup, lookup]);

  // The deck front this popup actually refers to: reading-aware match for
  // word popups (conjugated surfaces resolve to the dictionary-form card),
  // exact front for sentence panels. null = not in the deck.
  const popupMatchedFront = useMemo(() => {
    if (!popup) return null;
    if (popup.kind === "sentence")
      return knownFronts.has(popup.surface) ? popup.surface : null;
    return (
      matchFront(wordIndex, popup.surface, popup.reading, popup.dictForm) ??
      (popupFront && knownFronts.has(popupFront) ? popupFront : null)
    );
  }, [popup, wordIndex, knownFronts, popupFront]);
  const popupSaved = popupMatchedFront != null;

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
    const front = popupFront;
    // OPTIMISTIC: immediately flip the button to the saved/Delete state by
    // marking the word known; POST in the background and revert on failure.
    markFrontOptimistic(front);
    // i+1 example (client-side, mining.ts spirit): among the loaded cues find
    // one that contains the word and has exactly ONE unknown lexical token
    // (the word itself) — appended to notes when it differs from the context.
    let iPlusOne: string | undefined;
    {
      const counts = cueUnknownsRef.current;
      const cues = primaryCuesRef.current;
      if (counts) {
        const target = popup.dictForm ?? popup.surface;
        for (let i = 0; i < cues.length; i++) {
          const text = cues[i]!.text;
          if (counts[i] !== 1) continue;
          if (!text.includes(popup.surface) && !text.includes(target)) continue;
          if (text.trim() === popup.cueText.trim()) continue;
          iPlusOne = text.trim();
          break;
        }
      }
    }
    try {
      await api.ankiAdd({
        word: popup.dictForm ?? popup.surface,
        reading: lookup.reading || popup.reading || "",
        translation: lookup.translation,
        notes: iPlusOne
          ? `${lookup.notes ? `${lookup.notes}\n` : ""}例: ${iPlusOne}`
          : lookup.notes,
        // popup-open time data — NOT the current playhead: with a pinned
        // popup the video may have moved on; frame, audio and context must
        // all describe the cue the user looked up.
        context: popup.cueText,
        ...(popup.secondary ? { sentenceTranslation: popup.secondary } : {}),
        mediaId: entry.id,
        timestamp: popup.timestamp,
        ...cueBoundsAt(popup.timestamp),
      });
      sessCardsRef.current += 1;
      // sync real progress data (color etc.) in the background
      void refreshAnki();
    } catch (e) {
      // revert the optimistic state
      unmarkFrontOptimistic(front);
      toast(`Add failed: ${e instanceof Error ? e.message : e}`);
    }
  }, [popup, lookup, popupFront, entry.id, refreshAnki, toast, cueBoundsAt, markFrontOptimistic, unmarkFrontOptimistic]);

  // Add the whole sentence as an Anki card (front = JP sentence, back =
  // translation, notes = breakdown + idioms). Same optimistic flow as words.
  const onAddSentence = useCallback(async () => {
    if (!popup || popup.kind !== "sentence" || !explain) return;
    const front = popup.surface;
    markFrontOptimistic(front);
    try {
      await api.ankiAdd({
        word: popup.surface,
        reading: "",
        translation: explain.translation,
        notes: [explain.breakdown, explain.idioms].filter(Boolean).join("\n\n"),
        context: "",
        ...(popup.secondary ? { sentenceTranslation: popup.secondary } : {}),
        mediaId: entry.id,
        timestamp: popup.timestamp,
        ...cueBoundsAt(popup.timestamp),
      });
      sessCardsRef.current += 1;
      void refreshAnki();
    } catch (e) {
      unmarkFrontOptimistic(front);
      toast(`Add failed: ${e instanceof Error ? e.message : e}`);
    }
  }, [popup, explain, entry.id, refreshAnki, toast, cueBoundsAt, markFrontOptimistic, unmarkFrontOptimistic]);

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
    // Delete the card that actually MATCHED (e.g. the 食べる card for a
    // 食べた popup) — deleting the token-built front would silently no-op.
    const front = popupMatchedFront;
    if (!front) return;
    unmarkFrontOptimistic(front); // instant color flip back to unknown
    try {
      await api.ankiDelete(front);
      toast("Removed from Anki");
      await refreshAnki();
    } catch (e) {
      markFrontOptimistic(front); // revert — the card is still there
      toast(`Delete failed: ${e instanceof Error ? e.message : e}`);
    }
  }, [popupMatchedFront, refreshAnki, toast, markFrontOptimistic, unmarkFrontOptimistic]);

  // `a` hotkey: toggle the popup word/sentence in Anki. Color (and the small
  // "from your deck" badge when the card was matched) is the only state cue.
  const onAnkiToggle = useCallback(() => {
    if (!popup) return;
    if (popupSaved) {
      void onDelete();
      return;
    }
    if (popup.kind === "sentence") {
      if (explain) void onAddSentence();
      return;
    }
    if (lookup) void onAdd();
  }, [popup, popupSaved, lookup, explain, onAdd, onAddSentence, onDelete]);
  ankiToggleRef.current = onAnkiToggle;

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


  // Furigana on unknown kanji (settings toggle, default on). Maturity-based
  // hiding lives in TokenLine (shared by the overlay and the sidebar).
  const furiganaOn = settings.furigana !== false;

  // Interaction state shared with the Vbar (which owns the seek/CC/volume
  // internals): the HUD autohide below must stay visible while scrubbing,
  // hovering the bar row, or with the CC popover open.
  const scrubbingRef = useRef(false);
  const barHoverRef = useRef(false);
  const ccOpenRef = useRef(false);

  // HUD (vbar + cursor) autohide: fade after 2.5s of mouse inactivity while
  // playing; reappears on mousemove / pause. The interaction refs above stay
  // owned here and shared with the Vbar.
  const { hudHidden, onStageMouseMove, hideHudNow } = useHudAutohide({
    videoRef,
    scrubbingRef,
    barHoverRef,
    ccOpenRef,
    mediaKey: entry.id,
  });

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

  const sidebarSeek = useCallback(
    (t: number) => {
      const v = videoRef.current;
      if (!v) return;
      // The sidebar passes a cue's start (already + subOffset). Seeking to the
      // exact boundary often lands the playhead just before the cue actually
      // renders (decoder keyframe snap / boundary rounding), so the clicked
      // subtitle doesn't show. Nudge forward by a small epsilon, clamped to
      // stay inside the cue, so the clicked cue becomes active immediately.
      const cues = displayCues;
      const off = subOffsetRef.current;
      const idx = activeCueIndex(cues, t - off);
      let target = t;
      if (idx >= 0) {
        const cue = cues[idx]!;
        const startV = cue.start + off;
        const endV = cue.end + off;
        target = Math.min(startV + 0.05, endV - 0.01);
        if (target < startV) target = startV;
      }
      v.currentTime = Math.min(v.duration || Infinity, Math.max(0, target));
    },
    [displayCues],
  );

  // --- command palette: expose player actions (web/commands.ts registry).
  // Registered once per episode; closures read the latest callbacks via a ref
  // so the registration never churns with re-renders.
  const cmdCtxRef = useRef({
    toggleAutopause,
    toggleSidebar,
    togglePreStudy,
    toggleQuiz,
    toggleFullscreen,
    changeOffset,
    gotoEpisode,
    onGenerateJa,
    onTranslateRu,
    onCondense,
    toggleHud,
    toggleEcho,
    seekIPlusOne,
    primaryText,
    toast,
  });
  cmdCtxRef.current = {
    toggleAutopause,
    toggleSidebar,
    togglePreStudy,
    toggleQuiz,
    toggleFullscreen,
    changeOffset,
    gotoEpisode,
    onGenerateJa,
    onTranslateRu,
    onCondense,
    toggleHud,
    toggleEcho,
    seekIPlusOne,
    primaryText,
    toast,
  };
  useEffect(() => {
    const c = () => cmdCtxRef.current;
    return registerCommands("player", [
      { id: "pl.autopause", title: "player: toggle autopause", hint: "p", run: () => c().toggleAutopause() },
      { id: "pl.sidebar", title: "player: toggle cue sidebar", hint: "l", run: () => c().toggleSidebar() },
      { id: "pl.prestudy", title: "player: pre-study panel", hint: "w", run: () => c().togglePreStudy() },
      { id: "pl.quiz", title: "player: comprehension quiz", hint: "q", run: () => c().toggleQuiz() },
      { id: "pl.hud", title: "player: toggle session HUD", hint: "o", run: () => c().toggleHud() },
      { id: "pl.echo", title: "player: toggle echo dictation", hint: "e", run: () => c().toggleEcho() },
      { id: "pl.iplus1", title: "player: jump to next i+1 cue", hint: "j", run: () => c().seekIPlusOne() },
      { id: "pl.fs", title: "player: fullscreen", hint: "f", run: () => c().toggleFullscreen() },
      { id: "pl.offset0", title: "player: reset subtitle offset", hint: "\\", run: () => c().changeOffset(null) },
      { id: "pl.next", title: "player: next episode", hint: "⇧→", run: () => void c().gotoEpisode(1) },
      { id: "pl.prev", title: "player: previous episode", hint: "⇧←", run: () => void c().gotoEpisode(-1) },
      {
        id: "pl.read",
        title: "player: open in read mode",
        run: () => {
          window.location.hash = `#/read/${entry.id}`;
        },
      },
      {
        id: "pl.copy",
        title: "player: copy current cue",
        run: () => {
          const text = c().primaryText;
          if (!text) {
            c().toast("no cue");
            return;
          }
          void navigator.clipboard
            .writeText(text)
            .then(() => c().toast("copied"))
            .catch(() => c().toast("copy failed"));
        },
      },
      { id: "pl.genja", title: "player: generate ja subtitles (whisper)", run: () => void c().onGenerateJa() },
      { id: "pl.ru", title: "player: translate → ru", run: () => void c().onTranslateRu() },
      { id: "pl.condense", title: "player: condensed audio", run: () => void c().onCondense() },
    ]);
  }, [entry.id]);

  return (
    <div className="player-wrap">
      <div className="episode-title-row">
        <button
          className="btn icon ep-nav"
          title="previous episode (shift+←)"
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
          title="next episode (shift+→)"
          aria-label="Next episode"
          onClick={() => void gotoEpisode(1)}
        >
          <ChevronRightIcon size={16} />
        </button>
        <a
          className="btn icon ep-nav read-link"
          title="reading mode"
          aria-label="Reading mode"
          href={`#/read/${entry.id}`}
        >
          <BookOpenIcon size={16} />
        </a>
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
        <SubOverlay
          subScale={subScale}
          cuesLoading={cuesLoading}
          primaryText={primaryText}
          secondaryText={secondaryText}
          echoCue={echoCue}
          tokens={tokens}
          wordIndex={wordIndex}
          knownWords={knownWords}
          blacklist={blacklist}
          furiganaOn={furiganaOn}
          accents={accents}
          pitchOn={pitchOn}
          onWordEnter={onWordEnter}
          onWordLeave={onWordLeave}
          onWordClick={onWordClick}
          onExplainClick={onExplainClick}
          clearCloseTimer={clearCloseTimer}
          pauseForHover={pauseForHover}
          resumeFromHover={resumeFromHover}
          popupOpenRef={popupOpenRef}
          secondaryHoveredRef={secondaryHoveredRef}
          setSecShow={setSecShow}
          secShow={secShow}
          secHold={secHold}
          blurOff={blurOff}
        />
        <Vbar
          videoRef={videoRef}
          mediaKey={entry.id}
          videoDuration={videoDuration}
          isPaused={isPaused}
          togglePlay={togglePlay}
          toggleFullscreen={toggleFullscreen}
          displayCues={displayCues}
          secondaryCues={secondaryCues}
          cueUnknowns={cueUnknowns}
          tracks={tracks}
          primaryId={primaryId}
          secondaryId={secondaryId}
          setPrimaryId={setPrimaryId}
          setSecondaryId={setSecondaryId}
          whisperBusy={whisperBusy}
          translateBusy={translateBusy}
          condenseBusy={condenseBusy}
          onGenerateJa={() => void onGenerateJa()}
          onTranslateRu={() => void onTranslateRu()}
          onCondense={() => void onCondense()}
          scrubbingRef={scrubbingRef}
          barHoverRef={barHoverRef}
          ccOpenRef={ccOpenRef}
        />
        {skipTarget != null && (
          <button
            className="skip-pill"
            onClick={onSkipGap}
            title="No dialogue here — jump to the next line"
          >
            Skip →
          </button>
        )}
        {/* Wave 13.A: smart-resume is now automatic — no affordance UI. */}
        {/* Wave 13.A: session HUD (toggle with `o`) */}
        {hudOpen &&
          (() => {
            void hudTick; // re-render trigger
            const mins = Math.round((Date.now() - sessionStartRef.current) / 60000);
            const passed = sessPassedRef.current;
            const pct = passed > 0 ? Math.round((sessClearRef.current / passed) * 100) : 100;
            return (
              <SessionHud
                mins={mins}
                cues={sessCuesRef.current}
                pct={pct}
                mined={sessLookupsRef.current}
                cards={sessCardsRef.current}
                unk={sessUnknownSetRef.current.size}
              />
            );
          })()}
        {/* Wave 13.B: echo dictation input / reveal overlay */}
        {echoCue && (
          <EchoOverlay
            echoResult={echoResult}
            echoInput={echoInput}
            setEchoInput={setEchoInput}
            echoInputRef={echoInputRef}
            onEchoKeyDown={onEchoKeyDown}
          />
        )}
        {sessionSummary && <SessionSummary summary={sessionSummary} />}
      {popup && (
        <LookupPanel
          popup={popup}
          popupPos={popupPos}
          pinned={pinned}
          popupSaved={popupSaved}
          lookupRef={lookupRef}
          onPanelEnter={onPanelEnter}
          onPanelLeave={onPanelLeave}
          explain={explain}
          explainLoading={explainLoading}
          lookup={lookup}
          lookupLoading={lookupLoading}
          pitchOn={pitchOn}
          accents={accents}
          freqMap={freqMap}
          knownWords={knownWords}
          blacklist={blacklist}
          encHits={encHits}
          encOpen={encOpen}
          onToggleEncounters={() => setEncOpen((o) => !o)}
          qa={qa}
          askText={askText}
          setAskText={setAskText}
          askInputRef={askInputRef}
          onAskFocus={() => {
            askFocusedRef.current = true;
            clearCloseTimer();
          }}
          onAskBlur={() => {
            askFocusedRef.current = false;
          }}
          onAsk={() => void onAsk()}
          onClose={closePanel}
        />
      )}

      {preStudy && (
        <PreStudyPanel
          preStudy={preStudy}
          prestudyMin={prestudyMin}
          preFrames={preFrames}
          preBusy={preBusy}
          preProg={preProg}
          onToggleFrames={togglePreFrames}
          onToggleItem={togglePreItem}
          onBulkAdd={() => void onBulkAdd()}
          onClose={() => setPreStudy(null)}
        />
      )}

      {quiz && (
        <QuizPanel
          key={quizRunRef.current}
          items={quiz}
          onClose={() => setQuiz(null)}
          onDone={onQuizDone}
          onRetry={onQuizRetry}
        />
      )}

      {/* `l` in fullscreen: same cue list as a translucent overlay INSIDE the
          stage (the fullscreened element is the stage, so a sibling sidebar
          would be invisible). */}
      {sidebarOpen && isFullscreen && (
        <div className="fs-sidebar">
          <Sidebar
            cues={displayCues}
            secondaryCues={secondaryCues}
            activeIdx={activeP}
            subOffset={subOffset}
            onSeek={sidebarSeek}
            wordIndex={wordIndex}
            knownWords={knownWords}
            blacklist={blacklist}
            furiganaOn={furiganaOn}
            accents={accents}
            pitchAccentOn={pitchOn}
            onWordEnter={onWordEnter}
            onWordLeave={onWordLeave}
            onWordClick={onWordClick}
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
          blacklist={blacklist}
          furiganaOn={furiganaOn}
          accents={accents}
          pitchAccentOn={pitchOn}
          onWordEnter={onWordEnter}
          onWordLeave={onWordLeave}
          onWordClick={onWordClick}
        />
      )}
      </div>

      {/* Track selection lives in the CC popover (vbar). This row only
          surfaces long-running job progress — absent otherwise. */}
      {(translateBusy || condenseBusy || whisperBusy) && (
        <JobProgressBar
          translateBusy={translateBusy}
          condenseBusy={condenseBusy}
          whisperBusy={whisperBusy}
          whisperLastEnd={whisperLastEnd}
          whisperStatus={whisperStatus}
          videoDuration={videoDuration}
          onCancelWhisper={onCancelWhisper}
        />
      )}
    </div>
  );
}
