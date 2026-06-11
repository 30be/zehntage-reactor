import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  mediaUrl,
  type Cue,
  type LibraryEntry,
  type SubTrackInfo,
  type WordLookup,
} from "./api.ts";
import { activeCueIndex, contextAround } from "./cues.ts";
import { getTokenizer, isLexical, type KToken } from "./tokenizer.ts";
import {
  buildWordIndex,
  matchFront,
  progressColor,
  type WordIndex,
} from "./progress.ts";

interface Props {
  entry: LibraryEntry;
  toast: (msg: string) => void;
  settings: Record<string, unknown>;
}

interface PopupState {
  surface: string;
  reading?: string;
  x: number;
  y: number;
  context: string;
}

function langLabel(t: SubTrackInfo): string {
  const title = t.title ? ` · ${t.title}` : "";
  return `${t.lang}${title} (${t.kind})`;
}

export function Player({ entry, toast, settings }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);

  const [tracks, setTracks] = useState<SubTrackInfo[]>([]);
  const [primaryId, setPrimaryId] = useState<string>("");
  const [secondaryId, setSecondaryId] = useState<string>("");
  const [primaryCues, setPrimaryCues] = useState<Cue[]>([]);
  const [secondaryCues, setSecondaryCues] = useState<Cue[]>([]);
  const [activeP, setActiveP] = useState(-1);
  const [activeS, setActiveS] = useState(-1);
  const [secShow, setSecShow] = useState(false);

  const [tokens, setTokens] = useState<KToken[] | null>(null);
  const tokenizerReady = useRef(false);

  const [wordIndex, setWordIndex] = useState<WordIndex>(() =>
    buildWordIndex([], {}),
  );
  const [knownFronts, setKnownFronts] = useState<Set<string>>(new Set());

  const [popup, setPopup] = useState<PopupState | null>(null);
  const [lookup, setLookup] = useState<WordLookup | null>(null);
  const [lookupLoading, setLookupLoading] = useState(false);
  const lookupCache = useRef<Map<string, WordLookup>>(new Map());

  const [whisperBusy, setWhisperBusy] = useState(false);
  const [whisperStatus, setWhisperStatus] = useState<string>("");
  const [translateBusy, setTranslateBusy] = useState(false);
  const whisperJobRef = useRef<string | null>(null);

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

      const primLang = (settings.primaryLang as string) || "ja";
      const secLang = (settings.secondaryLang as string) || "ru";
      const prim =
        ts.find((t) => t.lang === primLang) ??
        ts.find((t) => t.lang.startsWith("ja"));
      const sec =
        ts.find((t) => t.lang === secLang) ??
        ts.find((t) => t.id !== prim?.id && (t.lang === "ru" || t.lang === "en"));
      if (prim) setPrimaryId(prim.id);
      if (sec && sec.id !== prim?.id) setSecondaryId(sec.id);
    })();
    return () => {
      cancelled = true;
    };
  }, [entry.id]);

  // --- load cues when track ids change ---
  useEffect(() => {
    if (!primaryId) {
      setPrimaryCues([]);
      return;
    }
    let cancelled = false;
    void api
      .cues(entry.id, primaryId)
      .then((c) => !cancelled && setPrimaryCues(c))
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

  // --- active cue tracking via timeupdate ---
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onTime = () => {
      const t = v.currentTime;
      setActiveP(activeCueIndex(primaryCues, t));
      setActiveS(activeCueIndex(secondaryCues, t));
    };
    v.addEventListener("timeupdate", onTime);
    onTime();
    return () => v.removeEventListener("timeupdate", onTime);
  }, [primaryCues, secondaryCues]);

  const primaryText = activeP >= 0 ? primaryCues[activeP]!.text : "";
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

  // --- word hover -> popup + lookup ---
  const onWordEnter = useCallback(
    (tok: KToken, e: React.MouseEvent) => {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const ctx = contextAround(primaryCues, activeP) || primaryText;
      setPopup({
        surface: tok.surface_form,
        reading: tok.reading,
        x: Math.min(rect.left, window.innerWidth - 340),
        y: rect.top - 8,
        context: ctx,
      });
    },
    [primaryCues, activeP, primaryText],
  );

  // fetch lookup when popup target changes
  useEffect(() => {
    if (!popup) {
      setLookup(null);
      return;
    }
    const cached = lookupCache.current.get(popup.surface);
    if (cached) {
      setLookup(cached);
      setLookupLoading(false);
      return;
    }
    let cancelled = false;
    setLookup(null);
    setLookupLoading(true);
    void api
      .lookup(popup.surface, popup.context, entry.name)
      .then((res) => {
        if (cancelled) return;
        lookupCache.current.set(popup.surface, res);
        setLookup(res);
      })
      .catch(() => {})
      .finally(() => !cancelled && setLookupLoading(false));
    return () => {
      cancelled = true;
    };
  }, [popup?.surface]);

  const popupFront = useMemo(() => {
    if (!popup) return null;
    const reading = lookup?.reading || popup.reading;
    return reading ? `${popup.surface} [${reading}]` : popup.surface;
  }, [popup, lookup]);

  const popupSaved = popupFront ? knownFronts.has(popupFront) : false;

  const onAdd = useCallback(async () => {
    if (!popup || !lookup) return;
    const v = videoRef.current;
    try {
      await api.ankiAdd({
        word: popup.surface,
        reading: lookup.reading || popup.reading || "",
        translation: lookup.translation,
        notes: lookup.notes,
        context: primaryText,
        mediaId: entry.id,
        timestamp: v?.currentTime ?? 0,
      });
      toast("Added to Anki");
      await refreshAnki();
    } catch (e) {
      toast(`Add failed: ${e instanceof Error ? e.message : e}`);
    }
  }, [popup, lookup, primaryText, entry.id, refreshAnki, toast]);

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

  // --- whisper generate JP ---
  const onGenerateJa = useCallback(async () => {
    setWhisperBusy(true);
    setWhisperStatus("starting…");
    try {
      const { jobId } = await api.whisperStart(entry.id, "ja");
      whisperJobRef.current = jobId;
      const liveCues: Cue[] = [];
      const es = new EventSource(api.whisperEventsUrl(jobId));
      es.onmessage = (ev) => {
        const data = JSON.parse(ev.data) as
          | { type: "snapshot"; status: string; cues: Cue[] }
          | { type: "status"; status: string; error?: string }
          | { type: "cue"; cue: Cue };
        if (data.type === "snapshot") {
          liveCues.length = 0;
          liveCues.push(...data.cues);
          setPrimaryCues([...liveCues]);
          setWhisperStatus(data.status);
        } else if (data.type === "cue") {
          liveCues.push(data.cue);
          setPrimaryCues([...liveCues]);
        } else if (data.type === "status") {
          setWhisperStatus(data.status);
          if (
            data.status === "done" ||
            data.status === "error" ||
            data.status === "canceled"
          ) {
            es.close();
            setWhisperBusy(false);
            whisperJobRef.current = null;
            if (data.status === "done") {
              // refresh tracks and switch to the new sidecar
              void api.subs(entry.id).then((ts) => {
                setTracks(ts);
                const ja = ts.find((t) => t.id === "sidecar:ja");
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
        es.close();
        setWhisperBusy(false);
      };
    } catch (e) {
      setWhisperBusy(false);
      toast(`Whisper start failed: ${e instanceof Error ? e.message : e}`);
    }
  }, [entry.id, toast]);

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
      toast(`Translate failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setTranslateBusy(false);
    }
  }, [entry.id, primaryId, toast]);

  const hasJa = tracks.some((t) => t.lang.startsWith("ja"));

  return (
    <div className="player-wrap">
      <div className="video-stage">
        <video ref={videoRef} src={mediaUrl(entry.id)} controls />
        <div className="sub-overlay">
          <div className="sub-primary">
            {tokens
              ? tokens.map((tok, i) => {
                  if (!isLexical(tok))
                    return <span key={i}>{tok.surface_form}</span>;
                  const front = matchFront(
                    wordIndex,
                    tok.surface_form,
                    tok.reading,
                  );
                  const known = front != null;
                  const color = known
                    ? progressColor(wordIndex.progress[front!])
                    : undefined;
                  return (
                    <span
                      key={i}
                      className={`tok${known ? " known" : ""}`}
                      style={
                        color
                          ? ({ ["--tok-color"]: color } as React.CSSProperties)
                          : undefined
                      }
                      onMouseEnter={(e) => onWordEnter(tok, e)}
                    >
                      {tok.surface_form}
                    </span>
                  );
                })
              : primaryText}
          </div>
          {secondaryText && (
            <div
              className={`sub-secondary${secShow ? " show" : ""}`}
              onMouseEnter={() => setSecShow(true)}
              onMouseLeave={() => setSecShow(false)}
            >
              {secondaryText}
            </div>
          )}
        </div>
      </div>

      {popup && (
        <div
          className="lookup"
          style={{ left: popup.x, top: popup.y, transform: "translateY(-100%)" }}
          onMouseLeave={() => setPopup(null)}
        >
          <div>
            <span className="word">{popup.surface}</span>
            {(lookup?.reading || popup.reading) && (
              <span className="reading">{lookup?.reading || popup.reading}</span>
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
              <button className="btn danger" onClick={onDelete}>
                Delete
              </button>
            ) : (
              <button className="btn" disabled={!lookup} onClick={onAdd}>
                Add to Anki
              </button>
            )}
          </div>
        </div>
      )}

      <div className="controls">
        <div className="track-pick">
          <label>Primary</label>
          <select
            value={primaryId}
            onChange={(e) => setPrimaryId(e.target.value)}
          >
            <option value="">— none —</option>
            {tracks.map((t) => (
              <option key={t.id} value={t.id}>
                {langLabel(t)}
              </option>
            ))}
          </select>
        </div>
        <div className="track-pick">
          <label>Secondary</label>
          <select
            value={secondaryId}
            onChange={(e) => setSecondaryId(e.target.value)}
          >
            <option value="">— none —</option>
            {tracks.map((t) => (
              <option key={t.id} value={t.id}>
                {langLabel(t)}
              </option>
            ))}
          </select>
        </div>

        {!hasJa && !whisperBusy && (
          <button className="btn primary" onClick={onGenerateJa}>
            Generate Japanese subtitles
          </button>
        )}
        {whisperBusy && (
          <>
            <span className="spinner-line">Whisper: {whisperStatus}…</span>
            <button className="btn sm" onClick={onCancelWhisper}>
              Cancel
            </button>
          </>
        )}
        {primaryId && (
          <button className="btn" disabled={translateBusy} onClick={onTranslateRu}>
            {translateBusy ? "Translating…" : "Translate → RU"}
          </button>
        )}
      </div>
    </div>
  );
}
