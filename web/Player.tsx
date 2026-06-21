import {
  useCallback,
  useEffect,
  useLayoutEffect,
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
  type ExplainResult,
  type EncounterHit,
  type WordHistory,
} from "./api.ts";
import { activeCueIndex, contextAround } from "./cues.ts";
import { getTokenizer, isLexical, kataToHira, lemmaOf, type KToken } from "./tokenizer.ts";
import { matchFront } from "./progress.ts";
import { wordKey } from "./TokenLine.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { loadAccents } from "./accent.ts";
import { readBlacklist, markBlacklist } from "./blacklist.ts";
import { freqRank, loadFreq } from "./freq.ts";
import { tmHeartbeat, tmEvent, tmAnomaly } from "./telemetry.ts";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  BookOpenIcon,
} from "./icons.tsx";
import { useWordState } from "./player/useWordState.ts";
import { registerCommands } from "./commands.ts";
import { rankPreStudy } from "./prestudy.ts";
import { nextIPlusOne } from "./iplusone.ts";
import { isJaLang } from "./lang.ts";
import { readKnownWords, markKnown } from "./coverage.ts";
import { onVocabChanged } from "./sync.ts";
import {
  cueTokensGet,
  cueTokensPut,
  fmtTime,
  HOVER_CLOSE_MS,
  HOVER_OPEN_MS,
  markedContext,
  qaCacheGet,
  qaCachePut,
  readSavedTracks,
  saveTracks,
  tokenizeCue,
  type PopupState,
  type QaItem,
} from "./player/shared.ts";
import { useWhisperJob } from "./player/useWhisperJob.ts";
import { usePersistedToggle } from "./usePersisted.ts";
import { computeCueUnknowns } from "./player/cueUnknowns.ts";
import { pickDisplayCues } from "./player/displayCues.ts";
import { useResume } from "./player/useResume.ts";
import { useActiveCues } from "./player/useActiveCues.ts";
import { useSession } from "./player/useSession.ts";
import { useAutoNext } from "./player/useAutoNext.ts";
import { usePlayerHotkeys } from "./player/useHotkeys.ts";
import { useHudAutohide } from "./player/useHudAutohide.ts";
import { useSubControls } from "./player/useSubControls.ts";
import { useEcho } from "./player/useEcho.ts";
import { useHoverPause } from "./player/useHoverPause.ts";
import { useLookup } from "./player/useLookup.ts";
import { DOUBLE_TAP_MS } from "./player/touch.ts";
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
  // The `.sub-overlay` block; measured so the popup never overlaps the subs.
  const subOverlayRef = useRef<HTMLDivElement>(null);

  const [tracks, setTracks] = useState<SubTrackInfo[]>([]);
  const [primaryId, setPrimaryId] = useState<string>("");
  const [secondaryId, setSecondaryId] = useState<string>("");
  const [primaryCues, setPrimaryCues] = useState<Cue[]>([]);
  const [secondaryCues, setSecondaryCues] = useState<Cue[]>([]);
  // Translation tooltip (the dim "?" at the JP line's right edge) is open
  // because the cursor rests on the hint.
  const [secShow, setSecShow] = useState(false);
  // RU reveal: hold `b` = temporary tooltip; quick double-press `b` = session toggle.
  const [secHold, setSecHold] = useState(false);
  const [blurOff, setBlurOff] = useState(false);
  const blurOffRef = useRef(false);
  const lastBDownRef = useRef(0);
  // Autopause: no UI control — toggled with the `p` hotkey, persisted.
  const onAutopauseChange = useCallback(
    (next: boolean) => toast(next ? "autopause on" : "autopause off"),
    [toast],
  );
  const [autopause, , toggleAutopause] = usePersistedToggle(
    "zr.autopause",
    false,
    onAutopauseChange,
  );
  const autopauseRef = useRef(false);
  // "retard mode" (zr.twoLine): show two cue lines (current + previous) and
  // hold the last cue through gaps so the overlay is never blank. UI-only
  // toggle in the CC popover; consumed by pickDisplayCues + SubOverlay.
  const [twoLine, , toggleTwoLine] = usePersistedToggle("zr.twoLine", false);
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
  const secondaryCuesRef = useRef<Cue[]>([]);

  const [tokens, setTokens] = useState<KToken[] | null>(null);
  // Tokenized PREVIOUS cue line (twoLine / "retard mode"). Same lazy-tokenize +
  // cue-token cache as `tokens`; null while pending → TokenLine renders plain.
  const [prevTokens, setPrevTokens] = useState<KToken[] | null>(null);
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

  // Deck / known-word state machine (deck cards + known fronts + optimistic
  // marks + live Anki revalidation) — see web/player/useWordState.ts.
  const {
    wordIndex,
    wordIndexRef,
    knownFronts,
    deckCardsRef,
    markFrontOptimistic,
    unmarkFrontOptimistic,
    refreshAnki,
  } = useWordState();

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
      const wasKnown = next.has(key);
      if (wasKnown) next.delete(key);
      else next.add(key);
      // markKnown writes an OR-Set add/remove (tombstone-preserving) to storage
      // and notifies the vocab bus — never a whole-array overwrite (the data-
      // loss bug).
      markKnown(key, !wasKnown);
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
      const wasBl = next.has(key);
      if (wasBl) next.delete(key);
      else next.add(key);
      markBlacklist(key, !wasBl);
      return next;
    });
  }, []);

  // Re-read the vocab Sets from storage whenever they change underneath us —
  // a remote sync apply OR a write from another tab/route (Fix 3). Without
  // this the next local toggle would persist a stale set and drop those edits.
  useEffect(() => {
    const off = onVocabChanged((keys) => {
      if (keys.includes("zr.known")) setKnownWords(readKnownWords());
      if (keys.includes("zr.blacklist")) setBlacklist(readBlacklist());
    });
    return off;
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
  // default ON: a missing zr.prestudyFrames key yields true.
  const [preFrames, , togglePreFrames] = usePersistedToggle(
    "zr.prestudyFrames",
    true,
  );

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
      for (const tk of tokenizeCue(tok, cue.text)) {
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
            tk.pos,
          ) != null
        )
          continue;
        unknowns.push(key);
        if (seen.has(key)) continue;
        seen.set(key, {
          key,
          lemma: lemmaOf(tk),
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

  const togglePreItem = useCallback((key: string) => {
    setPreStudy((prev) =>
      prev
        ? {
            ...prev,
            items: prev.items.map((it) =>
              it.key === key ? { ...it, checked: !it.checked } : it,
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
        for (const tk of tokenizeCue(tok, c.text)) {
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
  const [sidebarOpen, , toggleSidebar] = usePersistedToggle("zr.sidebar", false);
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
  // --- encounter history (word popup): lazy "encounters: N" line ---
  const [encHits, setEncHits] = useState<EncounterHit[] | null>(null);
  const [encOpen, setEncOpen] = useState(false);
  const encCache = useRef<Map<string, EncounterHit[]>>(new Map());
  const [wordHist, setWordHist] = useState<WordHistory | null>(null);
  const wordHistCache = useRef<Map<string, WordHistory>>(new Map());

  // sentence-structure explain panel state (same panel chrome as word lookups)
  const [explain, setExplain] = useState<ExplainResult | null>(null);
  const [explainLoading, setExplainLoading] = useState(false);
  // wave15 #11: track /api/explain failures so the panel can show
  // "Explanation unavailable." + Retry instead of an empty box.
  const [explainErr, setExplainErr] = useState(false);
  // bumped by the Retry affordance to re-run the explain effect
  const [explainReload, setExplainReload] = useState(0);

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
        // Route through the module cue-token cache: a wordIndex change (k/x
        // mark, Anki revalidation) re-runs this effect but the per-cue tokens
        // are reused instead of re-running kuromoji over the whole episode.
        const { counts, lemmas } = computeCueUnknowns(
          displayCues.map((c) => c.text),
          { tokenize: (text) => tokenizeCue(tok, text) },
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

  // --- F4: "due here" — per-cue flag for cues containing a DUE deck word ---
  // A deck word is due when a cue token matches an existing Anki front
  // (matchFront) whose progress entry has isDue === true. Reuses the same
  // tokenization pass shape as cueUnknowns; client-side only (no server call —
  // wordIndex already carries the per-front progress/isDue from the deck cache).
  const dueCueIndicesRef = useRef<number[] | null>(null);
  const [dueCount, setDueCount] = useState(0);
  // F6: due-cue indices as state too, so the seekbar heatmap (Vbar) can render
  // markers at their timeline positions (refs alone don't trigger re-render).
  const [dueCueIndices, setDueCueIndices] = useState<number[]>([]);
  useEffect(() => {
    dueCueIndicesRef.current = null;
    setDueCount(0);
    setDueCueIndices([]);
    if (displayCues.length === 0) return;
    let cancelled = false;
    void getTokenizer()
      .then((tok) => {
        if (cancelled) return;
        const idx = wordIndex;
        const hits: number[] = [];
        for (let i = 0; i < displayCues.length; i++) {
          let due = false;
          for (const t of tokenizeCue(tok, displayCues[i]!.text)) {
            if (!isLexical(t)) continue;
            if (t.pos === "助詞" || t.pos === "助動詞") continue;
            const front = matchFront(
              idx,
              t.surface_form,
              t.reading,
              t.basic_form,
              t.pos,
            );
            if (front == null) continue;
            if (idx.progress[front]?.isDue === true) {
              due = true;
              break;
            }
          }
          if (due) hits.push(i);
        }
        if (!cancelled) {
          dueCueIndicesRef.current = hits;
          setDueCount(hits.length);
          setDueCueIndices(hits);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [displayCues, wordIndex]);

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

  // --- F4: seek to the next cue with a DUE deck word (wraps), mirror of `j` ---
  const seekNextDue = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    const hits = dueCueIndicesRef.current;
    if (!hits || hits.length === 0) {
      toast("no due cue");
      return;
    }
    const cues = displayCues;
    const cur = activeCueIndex(cues, v.currentTime - subOffsetRef.current);
    const target = hits.find((i) => i > cur) ?? hits[0]!;
    const cue = cues[target];
    if (!cue) return;
    v.currentTime = Math.max(0, cue.start + subOffsetRef.current);
    toast(`due cue ${target + 1}`);
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

  // --- active cue tracking via timeupdate (+ autopause at each cue end)
  // (extracted to useActiveCues). Derives the active primary/secondary cue
  // indices from currentTime; the same loop also drives the entangled
  // loop/autopause/echo/session-telemetry behaviors gated on the cue
  // transition. All of their state is owned elsewhere and passed in as the
  // SAME instances. ---
  const { activeP, activeS } = useActiveCues({
    videoRef,
    mediaId: entry.id,
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
  });

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
        ? popup.vocabKey ?? popup.dictForm ?? popup.surface
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

  // Held-last index: the last cue that was genuinely active. In twoLine mode we
  // hold it through gaps so the overlay never blanks (see pickDisplayCues).
  // Updated during render — an idempotent ref write that just mirrors activeP.
  const heldCueIdxRef = useRef(-1);
  if (activeP >= 0) heldCueIdxRef.current = activeP;
  const { curText: primaryText, prevText } = pickDisplayCues(
    displayCues,
    activeP,
    heldCueIdxRef.current,
    { twoLine },
  );
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

  // --- lazy tokenize the PREVIOUS cue line (twoLine mode), mirroring the
  // primary tokenizer. Cheap: repeat cues hit the same module-level cache. When
  // empty (single-line mode, or eff===0) we clear and TokenLine shows nothing.
  useEffect(() => {
    if (!prevText) {
      setPrevTokens(null);
      return;
    }
    const cached = cueTokensGet(prevText);
    if (cached) {
      setPrevTokens(cached);
      return;
    }
    setPrevTokens(null); // plain line until tokens arrive
    let cancelled = false;
    void getTokenizer()
      .then((tok) => {
        if (cancelled) return;
        const toks = tok.tokenize(prevText);
        cueTokensPut(prevText, toks);
        setPrevTokens(toks);
      })
      .catch(() => {
        if (!cancelled) setPrevTokens(null);
      });
    return () => {
      cancelled = true;
    };
  }, [prevText]);

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
                  p.key === it.key ? { ...p, added: true } : p,
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
        pos: tok.pos,
        vocabKey: wordKey(tok),
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

  // Open the word popup immediately and PIN it (no hover-out auto-close).
  // Shared by mouse click and by touch tap; both pause for reading and pin so
  // the panel stays until the user taps/clicks elsewhere.
  const openWordPinned = useCallback(
    (tok: KToken, el: HTMLElement, ctx?: string) => {
      clearOpenTimer();
      clearCloseTimer();
      pauseForHover();
      setPopup(buildWordPopup(tok, el, ctx));
      setPinned(true);
    },
    [buildWordPopup, clearOpenTimer, clearCloseTimer, pauseForHover],
  );

  // Click a word: open immediately and PIN — no hover-out auto-close. Clicking
  // another word retargets the pinned panel.
  const onWordClick = useCallback(
    (tok: KToken, e: React.MouseEvent, ctx?: string) => {
      e.stopPropagation();
      openWordPinned(tok, e.currentTarget as HTMLElement, ctx);
    },
    [openWordPinned],
  );

  // --- touch gestures (phones): single tap = open popup (like hover), double
  // tap = open popup + add the card. TokenLine owns the tap/double-tap timing
  // and feeds us the already-resolved token span element. ---
  const pendingAddKeyRef = useRef<string | null>(null);
  const onWordTap = useCallback(
    (tok: KToken, el: HTMLElement) => {
      pendingAddKeyRef.current = null; // a plain tap never queues an add
      openWordPinned(tok, el);
    },
    [openWordPinned],
  );
  const onWordDoubleTap = useCallback(
    (tok: KToken, el: HTMLElement) => {
      // Open + pin now, then arm the add: once the lookup for THIS word lands
      // (see the effect below) we fire the same toggle the `a` hotkey uses.
      openWordPinned(tok, el);
      pendingAddKeyRef.current = wordKey(tok);
    },
    [openWordPinned],
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

  // Safety: whenever the popup is gone, the pin is gone too — and a queued
  // double-tap add can't outlive the popup it targeted.
  useEffect(() => {
    if (!popup) {
      setPinned(false);
      pendingAddKeyRef.current = null;
    }
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
    seekNextDue,
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
      setExplainErr(false);
      return;
    }
    let cancelled = false;
    setExplain(null);
    setExplainErr(false);
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
      .catch(() => {
        if (!cancelled) setExplainErr(true);
      })
      .finally(() => !cancelled && setExplainLoading(false));
    return () => {
      cancelled = true;
    };
  }, [popup?.kind, popup?.surface, popup?.context, popup?.secondary, explainReload]);

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

  // Word-lookup popup sub-system (web/player/useLookup.ts): lookup fetch +
  // cache + de-dup, onReload, the reading-aware deck-front resolution
  // (popupFront/popupMatchedFront/popupSaved) and cueBoundsAt. The central
  // `popup` state, hover/pin/close handlers, explain/encounters/qa and
  // onAdd/onAddSentence/onDelete stay in Player and consume this return.
  const {
    lookup,
    lookupLoading,
    lookupErr,
    popupFront,
    popupMatchedFront,
    popupSaved,
    onReload,
    cueBoundsAt,
  } = useLookup({
    popup,
    wordIndex,
    wordIndexRef,
    knownFronts,
    deckCardsRef,
    primaryCuesRef,
    subOffsetRef,
    sessLookupsRef,
    entryName: entry.name,
    mediaId: entry.id,
    tmEvent,
    toast,
  });
  regenLookupRef.current = () => void onReload();

  // fetch per-word mining history when a word popup opens (lazy, cached).
  // Re-keyed on popupSaved so the line refreshes right after an add/delete.
  useEffect(() => {
    if (!popup || popup.kind !== "word") {
      setWordHist(null);
      return;
    }
    const lemma = popup.dictForm ?? popup.surface;
    const key = `${lemma} ${popup.surface}`;
    if (!popupSaved) {
      const cached = wordHistCache.current.get(key);
      if (cached) {
        setWordHist(cached);
        return;
      }
    }
    setWordHist(null);
    let cancelled = false;
    void api
      .wordHistory(lemma, popup.surface)
      .then((h) => {
        wordHistCache.current.set(key, h);
        if (!cancelled) setWordHist(h);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [popup?.kind, popup?.surface, popup?.dictForm, popupSaved]);

  // Position the lookup panel: prefer above the word, flip below when there
  // isn't room, and clamp horizontally so it can never be cut off-screen.
  useLayoutEffect(() => {
    if (!popup) {
      setPopupPos({ visibility: "hidden" });
      return;
    }
    const el = lookupRef.current;
    const stage = stageRef.current;
    if (!el || !stage) return;
    const margin = 8;
    const { width, height } = el.getBoundingClientRect();
    // Position RELATIVE TO THE STAGE (the popup's offset parent), so the panel
    // stays anchored in fullscreen too: a fullscreen element is promoted to the
    // top layer and becomes the containing block for position:fixed children,
    // which would otherwise collapse the panel to the stage's top-left over the
    // subtitle. The stage is position:relative in BOTH windowed & fullscreen,
    // so absolute offsets work in both. popup.{x,y,anchorBottom} are viewport
    // coords (captured via getBoundingClientRect); subtract the stage rect to
    // convert to stage-local coords.
    const s = stage.getBoundingClientRect();
    // Fence the popup above the ACTUAL subtitle block: measure the live
    // `.sub-overlay` top rather than guessing a fixed reserve, since the subs
    // grow with --sub-scale, furigana and multi-line wrapping and would
    // otherwise poke out above a fixed reserve and get covered. Fall back to a
    // 120px reserve (~64px sub bottom + ~46px vbar) if the ref isn't ready.
    const subRect = subOverlayRef.current?.getBoundingClientRect();
    const safeBottom =
      subRect && subRect.height > 0
        ? subRect.top - margin
        : s.bottom - 120;
    // Available room measured against the visible STAGE box (matches fullscreen
    // letterboxing as well as windowed layout).
    const spaceAbove = popup.y - s.top;
    const spaceBelow = safeBottom - popup.anchorBottom;
    const placeBelow = spaceAbove < height + margin && spaceBelow > spaceAbove;

    // The two fences the panel must stay inside, in stage-local coords.
    const topMin = margin;
    // `safeBottom` is the lower fence: the panel's bottom edge must never cross
    // it. Express it stage-local (distance from stage bottom up to safeBottom)
    // so we can pin via CSS `bottom` rather than `top`.
    const bottomMax = s.bottom - safeBottom; // stage-local gap below safeBottom

    let style: React.CSSProperties;
    if (placeBelow) {
      // Below the word: pin the TOP. Growth here is downward, but spaceBelow was
      // checked, and the maxHeight cap below prevents crossing safeBottom.
      const top = Math.max(topMin, popup.anchorBottom + margin - s.top);
      style = { top };
    } else {
      // Above the word: pin the BOTTOM at safeBottom (via CSS `bottom`). This is
      // the fix for the overlap bug: the panel's height keeps growing after this
      // effect runs (async notes / furigana reflow), and pinning `top` from a
      // stale measured height let the extra height spill DOWN over the subtitle.
      // Anchoring the bottom edge makes any later growth expand UPWARD instead,
      // so the panel can never cross into the subtitle block.
      style = { bottom: bottomMax };
    }

    // Always cap the panel to the room available between the top fence and
    // safeBottom, so even unbounded content growth scrolls internally rather
    // than overflowing either fence (covers tiny viewports AND late growth).
    const safeHeight = safeBottom - s.top - 2 * margin;
    const cappedMaxHeight = Math.max(80, safeHeight);

    let left = popup.x - width / 2;
    left = Math.max(s.left + margin, Math.min(left, s.right - width - margin)) - s.left;

    setPopupPos({
      position: "absolute",
      left,
      visibility: "visible",
      maxHeight: cappedMaxHeight,
      overflowY: "auto",
      ...style,
    });
  }, [popup, lookup, lookupLoading, explain, explainLoading, explainErr, qa]);

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

  // Double-tap-to-add (touch): onWordDoubleTap opened the popup and armed
  // pendingAddKeyRef with the word's key. The lookup fetch is async, so we wait
  // here until it lands for the SAME word still on screen, then fire the toggle
  // exactly once (mirrors pressing `a`). Guard on the key so a quick re-tap on
  // a different word can't add the wrong card.
  useEffect(() => {
    const want = pendingAddKeyRef.current;
    if (!want) return;
    if (!popup || popup.kind !== "word") return;
    if (popupKeyRef.current !== want) return;
    if (lookupLoading || !lookup) return; // wait for the lookup to resolve
    pendingAddKeyRef.current = null;
    onAnkiToggle();
  }, [lookup, lookupLoading, popup, popupSaved, onAnkiToggle]);

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

  // Seek by the same ±5s step the ArrowLeft/Right hotkeys use.
  const seekBy = useCallback((delta: number) => {
    const v = videoRef.current;
    if (!v) return;
    if (delta < 0) v.currentTime = Math.max(0, v.currentTime + delta);
    else v.currentTime = Math.min(v.duration || Infinity, v.currentTime + delta);
  }, []);
  const VIDEO_SEEK_STEP = 5;

  // --- video touch zones (phones): single tap toggles play, double-tap on the
  // LEFT half seeks back / RIGHT half seeks forward (YouTube/Netflix style).
  // Desktop mouse keeps the plain onClick={togglePlay} below — we only enter
  // this state machine on a real touch pointer, and swallow the synthetic click
  // it produces so play never double-toggles. ---
  const videoTap = useRef<{ t: number; timer: number } | null>(null);
  const swallowVideoClick = useRef(false);
  const onVideoPointerUp = useCallback(
    (e: React.PointerEvent<HTMLVideoElement>) => {
      if (e.pointerType !== "touch") return; // mouse/pen → onClick handles it
      swallowVideoClick.current = true; // kill the synthetic click that follows
      const now = Date.now();
      const rect = e.currentTarget.getBoundingClientRect();
      const left = e.clientX - rect.left < rect.width / 2;
      const prev = videoTap.current;
      if (prev && now - prev.t < DOUBLE_TAP_MS) {
        window.clearTimeout(prev.timer);
        videoTap.current = null;
        seekBy(left ? -VIDEO_SEEK_STEP : VIDEO_SEEK_STEP);
        return;
      }
      const timer = window.setTimeout(() => {
        videoTap.current = null;
        togglePlay();
      }, DOUBLE_TAP_MS);
      videoTap.current = { t: now, timer };
    },
    [seekBy, togglePlay],
  );
  const onVideoClick = useCallback(() => {
    // On touch the pointerup state machine owns play/seek; swallow the
    // browser's synthetic click so we don't toggle play twice. Mouse clicks
    // (no preceding touch flag) fall straight through to togglePlay.
    if (swallowVideoClick.current) {
      swallowVideoClick.current = false;
      return;
    }
    togglePlay();
  }, [togglePlay]);

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
    seekNextDue,
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
    seekNextDue,
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
      { id: "pl.duejump", title: "player: jump to next due-word cue", run: () => c().seekNextDue() },
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

  // G8: download the current frame, or (shift) the active cue's audio clip.
  // Reuses the server's captureFrame/cutAudio via /api/export/*; the browser
  // saves the file thanks to the endpoint's Content-Disposition header.
  const exportCurrent = useCallback(
    (kind: "frame" | "clip") => {
      const v = videoRef.current;
      if (!v) return;
      const t = Math.max(0, v.currentTime - subOffsetRef.current);
      let url: string;
      if (kind === "clip") {
        const idx = activeCueIndex(displayCues, t);
        const cue = idx >= 0 ? displayCues[idx] : undefined;
        if (!cue) {
          toast("no active cue to clip");
          return;
        }
        url = api.exportClipUrl(entry.id, cue.start, cue.end);
      } else {
        url = api.exportFrameUrl(entry.id, t);
      }
      const a = document.createElement("a");
      a.href = url;
      a.download = "";
      document.body.appendChild(a);
      a.click();
      a.remove();
      toast(kind === "clip" ? "exporting clip…" : "exporting frame…");
    },
    [entry.id, displayCues, toast],
  );

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
        {/* G8: export the current frame (subtitle is burned into the screenshot
            by the overlay only visually; the JPEG is the raw video frame). The
            browser downloads it via Content-Disposition on the endpoint. A
            right-click / shift offers the cue audio clip too. */}
        <button
          className="btn icon ep-nav export-frame"
          title="export frame (shift+click: export cue audio)"
          aria-label="Export current frame"
          onClick={(e) => exportCurrent(e.shiftKey ? "clip" : "frame")}
        >
          <CameraGlyph />
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
          onPointerUp={onVideoPointerUp}
          onClick={onVideoClick}
        />
        <SubOverlay
          subRef={subOverlayRef}
          subScale={subScale}
          cuesLoading={cuesLoading}
          primaryText={primaryText}
          prevText={prevText}
          twoLine={twoLine}
          secondaryText={secondaryText}
          echoCue={echoCue}
          tokens={tokens}
          prevTokens={prevTokens}
          wordIndex={wordIndex}
          knownWords={knownWords}
          blacklist={blacklist}
          furiganaOn={furiganaOn}
          accents={accents}
          pitchOn={pitchOn}
          onWordEnter={onWordEnter}
          onWordLeave={onWordLeave}
          onWordClick={onWordClick}
          onWordTap={onWordTap}
          onWordDoubleTap={onWordDoubleTap}
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
        {/* wave15 #10: dim, non-intrusive hint when this episode has no
            subtitle tracks at all and nothing is being generated. Suppressed
            while whisper runs or once any cues exist (live or primary). */}
        {tracks.length === 0 && !whisperBusy && displayCues.length === 0 && (
          <div className="no-subs-hint" aria-hidden="true">
            No subtitles — press G to generate, or pick a track via CC ▸
          </div>
        )}
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
          dueCueIndices={dueCueIndices}
          tracks={tracks}
          primaryId={primaryId}
          secondaryId={secondaryId}
          setPrimaryId={setPrimaryId}
          setSecondaryId={setSecondaryId}
          twoLine={twoLine}
          toggleTwoLine={toggleTwoLine}
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
        {/* F4: "N due" indicator — count of cues with a due deck word in this
            episode. Click jumps to the next such cue (mirror of `j`). Reuses the
            monochrome .skip-pill chrome; placed top-right via inline offset so it
            never clashes with the bottom-right Skip pill. */}
        {dueCount > 0 && !hudHidden && (
          <button
            className="skip-pill"
            data-testid="due-indicator"
            style={{ top: 14, bottom: "auto", right: 14 }}
            onClick={seekNextDue}
            title="Jump to the next cue with a due deck word"
          >
            {dueCount} due
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
          explainErr={explainErr}
          onExplainRetry={() => setExplainReload((n) => n + 1)}
          lookup={lookup}
          lookupLoading={lookupLoading}
          lookupErr={lookupErr}
          onLookupRetry={() => void onReload()}
          pitchOn={pitchOn}
          accents={accents}
          freqMap={freqMap}
          knownWords={knownWords}
          blacklist={blacklist}
          encHits={encHits}
          encOpen={encOpen}
          onToggleEncounters={() => setEncOpen((o) => !o)}
          wordHist={wordHist}
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

// Monochrome camera glyph for the frame-export button. Inline (not in icons.tsx,
// which this module doesn't own) but matches the app's currentColor / stroke style.
function CameraGlyph() {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M14.5 4h-5L8 6H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-4l-1.5-2Z" />
      <circle cx={12} cy={13} r={3.2} />
    </svg>
  );
}
