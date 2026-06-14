// #/read/<id> — reading mode: fetches the same ja + secondary cues as the
// Player, injects the tokenizer and a TokenLine-based renderer into <Read>
// with a click-pinned word popup at parity with the player popup: deck-card
// or Gemini lookup, Add to Anki (sentence-context mining, no frame/audio),
// k mark-known, x blacklist, and the ask… follow-up field.
// Jumping a timestamp navigates back to the player.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  type Cue,
  type EncounterHit,
  type LibraryEntry,
  type WordLookup,
} from "./api.ts";
import { Encounters } from "./player/Encounters.tsx";
import { Read } from "./Read.tsx";
import { clampPopupPos } from "./readlayout.ts";
import { TokenLine, AccentReading } from "./TokenLine.tsx";
import {
  buildWordIndex,
  matchFront,
  withFront,
  withoutFront,
  type WordIndex,
} from "./progress.ts";
import { getTokenizer, type KToken } from "./tokenizer.ts";
import { accentOf, loadAccents } from "./accent.ts";
import { readBlacklist, writeBlacklist } from "./blacklist.ts";
import { isTextInput } from "./keys.ts";
import { tmEvent } from "./telemetry.ts";
import { isJaLang } from "./lang.ts";
import { CACHE_PREFIX, readKnownWords } from "./coverage.ts";
import { deckCardToLookup, type QaItem } from "./player/shared.ts";

interface ReadPopup {
  x: number;
  y: number;
  surface: string;
  reading?: string;
  dictForm?: string;
  context: string;
  /** RU translation of the paragraph (mining context), if present */
  secondary?: string;
}

export function ReadRoute({
  id,
  settings,
}: {
  id: string;
  settings: Record<string, unknown>;
}) {
  const [entry, setEntry] = useState<LibraryEntry | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [cues, setCues] = useState<Cue[] | null>(null);
  const [secondaryCues, setSecondaryCues] = useState<Cue[] | null>(null);
  const [tokenize, setTokenize] = useState<((t: string) => KToken[]) | null>(null);
  const [wordIndex, setWordIndex] = useState<WordIndex>(() => buildWordIndex([], {}));
  const [knownWords, setKnownWords] = useState<Set<string>>(() =>
    readKnownWords(),
  );
  const [blacklist, setBlacklist] = useState<Set<string>>(() => readBlacklist());
  const [accents, setAccents] = useState<Map<string, number> | null>(null);
  const [popup, setPopup] = useState<ReadPopup | null>(null);
  const [lookup, setLookup] = useState<WordLookup | null>(null);
  const [lookupLoading, setLookupLoading] = useState(false);
  // encounter history (word popup): "encounters: N" line, lazy + cached per
  // lemma, scoped to this episode — same as the player popup.
  const [encHits, setEncHits] = useState<EncounterHit[] | null>(null);
  const [encOpen, setEncOpen] = useState(false);
  const encCache = useRef<Map<string, EncounterHit[]>>(new Map());
  // deck fronts (drives the popup saved-state color), optimistically updated
  const [knownFronts, setKnownFronts] = useState<Set<string>>(new Set());
  // optimistic fronts not yet confirmed by the server payload
  const pendingFrontsRef = useRef<Set<string>>(new Set());
  const deckCardsRef = useRef<Map<string, { front: string; back: string; notes: string }>>(
    new Map(),
  );
  const panelRef = useRef<HTMLDivElement>(null);
  // `a` (Anki toggle) / `g` (regenerate) hotkeys reach the latest closures
  const ankiToggleRef = useRef<() => void>(() => {});
  const regenRef = useRef<() => void>(() => {});

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

  // ask… follow-up thread (cleared when the popup retargets/closes)
  const [qa, setQa] = useState<QaItem[]>([]);
  const [askText, setAskText] = useState("");
  const [askBusy, setAskBusy] = useState(false);
  const askInputRef = useRef<HTMLInputElement>(null);

  const furiganaOn = settings.furigana !== false;
  const pitchOn = settings.pitchAccent !== false;

  useEffect(() => {
    tmEvent("read_open", { mediaId: id });
  }, [id]);

  // entry + tracks + cues (same selection logic as the Player, simplified)
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const lib = await api.library();
        const e = lib.find((x) => x.id === id);
        if (!e) {
          if (!cancelled) setNotFound(true);
          return;
        }
        if (cancelled) return;
        setEntry(e);
        const ts = await api.subs(id).catch(() => []);
        if (cancelled) return;
        const prim =
          ts.find((t) => t.kind === "embedded" && isJaLang(t.lang)) ??
          ts.find((t) => isJaLang(t.lang));
        const secLang = (settings.knownLang as string) || "ru";
        const sec =
          ts.find(
            (t) => t.id !== prim?.id && t.origin === "generated" && t.lang.startsWith(secLang),
          ) ?? ts.find((t) => t.id !== prim?.id && t.lang.startsWith(secLang));
        if (prim) {
          const c = await api.cues(id, prim.id).catch(() => []);
          if (!cancelled) setCues(c);
        } else if (!cancelled) setCues([]);
        if (sec) {
          const c = await api.cues(id, sec.id).catch(() => []);
          if (!cancelled) setSecondaryCues(c);
        }
      } catch {
        if (!cancelled) setNotFound(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    void getTokenizer()
      .then((tok) => !cancelled && setTokenize(() => (t: string) => tok.tokenize(t)))
      .catch(() => {});
    void api
      .ankiWords()
      .then((a) => {
        if (cancelled) return;
        const fronts = new Set(a.words.map((w) => w.front));
        for (const f of pendingFrontsRef.current) {
          if (fronts.has(f)) pendingFrontsRef.current.delete(f); // confirmed
          else fronts.add(f); // still pending — keep the optimistic mark
        }
        let idx = buildWordIndex(a.words, a.progress);
        for (const f of pendingFrontsRef.current) idx = withFront(idx, f);
        setWordIndex(idx);
        deckCardsRef.current = new Map(a.words.map((w) => [w.front, w]));
        setKnownFronts(fronts);
      })
      .catch(() => {});
    void loadAccents()
      .then((m) => !cancelled && setAccents(m))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

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

  const toggleBlacklist = useCallback((key: string) => {
    setBlacklist((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      writeBlacklist(next);
      return next;
    });
  }, []);

  // close on Esc / outside click; k/x toggle known/blacklist for the popup
  // word (mirrors the player hotkeys; e.code = physical key, layout-proof)
  useEffect(() => {
    if (!popup) return;
    const key = popup.dictForm ?? popup.surface;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPopup(null);
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // typing in the ask… field keeps its native behavior
      if (isTextInput(e.target as Element | null)) return;
      if (e.code === "KeyX") {
        toggleBlacklist(key);
        tmEvent("blacklist", { word: key });
      } else if (e.code === "KeyK") {
        toggleKnown(key);
        tmEvent("mark_known", { word: key });
      } else if (e.code === "KeyA") {
        ankiToggleRef.current();
      } else if (e.code === "KeyG") {
        regenRef.current();
      }
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (t && panelRef.current?.contains(t)) return;
      if (t instanceof Element && t.closest(".tok")) return;
      setPopup(null);
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [popup, toggleKnown, toggleBlacklist]);

  // simplified lookup: deck card if present, else Gemini. Depends on
  // wordIndex too: deck data arriving AFTER the popup opened (slow
  // /api/anki/words) must still fill from the card instead of Gemini.
  const lookupArrivedRef = useRef(false);
  useEffect(() => {
    if (!popup) {
      setLookup(null);
      return;
    }
    const matched = matchFront(wordIndex, popup.surface, popup.reading, popup.dictForm);
    const deckCard = matched ? deckCardsRef.current.get(matched) : undefined;
    if (deckCard) {
      setLookup(deckCardToLookup(deckCard));
      setLookupLoading(false);
      return;
    }
    // a Gemini answer already on screen for this popup target stays — the
    // wordIndex dep must not refire the network call on every deck refresh
    if (lookupArrivedRef.current) return;
    let cancelled = false;
    setLookup(null);
    setLookupLoading(true);
    void api
      .lookup({
        word: popup.surface,
        context: popup.context,
        source: entry?.name ?? "",
      })
      .then((res) => {
        if (cancelled) return;
        lookupArrivedRef.current = true;
        setLookup(res);
      })
      .catch(() => {})
      .finally(() => !cancelled && setLookupLoading(false));
    return () => {
      cancelled = true;
    };
  }, [popup?.surface, popup?.context, wordIndex]);
  useEffect(() => {
    lookupArrivedRef.current = false;
  }, [popup?.surface, popup?.context]);

  // fetch encounter history when a word popup opens (lazy, cached per lemma,
  // scoped to this episode) — mirrors the player popup.
  useEffect(() => {
    if (!popup) {
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
      .indexEncounters(lemma, [id])
      .then((hits) => {
        encCache.current.set(lemma, hits);
        if (!cancelled) setEncHits(hits);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [popup?.surface, popup?.dictForm, id]);

  // `g`: regenerate the explanation (bypass any deck-card fill)
  const onRegen = useCallback(() => {
    if (!popup) return;
    let cancelled = false;
    setLookup(null);
    setLookupLoading(true);
    void api.lookup({
      word: popup.surface,
      context: popup.context,
      source: entry?.name ?? "",
      noCache: true,
    })
      .then((res) => {
        if (cancelled) return;
        lookupArrivedRef.current = true;
        setLookup(res);
      })
      .catch(() => {})
      .finally(() => !cancelled && setLookupLoading(false));
  }, [popup, entry]);

  // reset the ask… thread when the popup retargets or closes
  useEffect(() => {
    setQa([]);
    setAskText("");
    setAskBusy(false);
  }, [popup?.surface, popup?.context]);

  const onWordClick = useCallback(
    (tok: KToken, e: React.MouseEvent, ctx: string, secondary?: string) => {
      e.stopPropagation();
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      // Y-clamp: flip the popup above the word when a below-word popup would
      // spill past the viewport bottom (e.g. words in a last/low paragraph).
      const pos = clampPopupPos(rect, window.innerWidth, window.innerHeight);
      setPopup({
        x: pos.x,
        y: pos.y + window.scrollY,
        surface: tok.surface_form,
        reading: tok.reading,
        dictForm:
          tok.basic_form && tok.basic_form !== "*" && tok.basic_form !== tok.surface_form
            ? tok.basic_form
            : undefined,
        context: ctx,
        secondary,
      });
    },
    [],
  );

  const renderTokenLine = useCallback(
    (tokens: KToken[] | null, fallback: string, secondary?: string) => (
      <TokenLine
        tokens={tokens}
        fallbackText={fallback}
        wordIndex={wordIndex}
        knownWords={knownWords}
        blacklist={blacklist}
        furiganaOn={furiganaOn}
        accents={accents}
        pitchAccentOn={pitchOn}
        onWordClick={(tok, e) => onWordClick(tok, e, fallback, secondary)}
      />
    ),
    [wordIndex, knownWords, blacklist, furiganaOn, accents, pitchOn, onWordClick],
  );

  const onJump = useCallback(
    (t: number) => {
      window.location.hash = `#/play/${id}@${Math.max(0, Math.floor(t))}`;
    },
    [id],
  );

  // When the user presses Enter on a cursor line, click the first token in
  // that paragraph to open the word popup.
  const onCursorActivate = useCallback((paraIndex: number) => {
    const para = document.querySelector<HTMLElement>(
      `.read-mode [data-para-index="${paraIndex}"]`,
    );
    const tok = para?.querySelector<HTMLElement>(".tok");
    tok?.click();
  }, []);

  // Best-effort % known from the coverage cache (no strict key validation —
  // we just want an approximate number for the header display).
  const knownPct = useMemo<number | null>(() => {
    try {
      const raw = localStorage.getItem(CACHE_PREFIX + id);
      if (!raw) return null;
      const v = JSON.parse(raw) as { pct?: number };
      return typeof v.pct === "number" ? v.pct : null;
    } catch {
      return null;
    }
  }, [id]);

  // Same front format as the player popup ("word [reading]").
  const popupFront = useMemo(() => {
    if (!popup) return null;
    // Front uses the dictionary (lemma) form so all conjugations match (the
    // lookup reading is the dict-form reading — it's looked up on the lemma).
    const word = popup.dictForm ?? popup.surface;
    const reading = lookup?.reading || popup.reading;
    return reading ? `${word} [${reading}]` : word;
  }, [popup, lookup]);
  const popupMatchedFront = useMemo(() => {
    if (!popup) return null;
    return (
      matchFront(wordIndex, popup.surface, popup.reading, popup.dictForm) ??
      (popupFront && knownFronts.has(popupFront) ? popupFront : null)
    );
  }, [popup, wordIndex, knownFronts, popupFront]);
  const popupSaved = popupMatchedFront != null;

  // Add to Anki: mining flow with the paragraph as context — no video frame/
  // audio (no mediaId/timestamp → the server skips capture). Context format:
  // "JP sentence<br>RU translation<br>source: <doc name>".
  const onAdd = useCallback(async () => {
    if (!popup || !lookup || !popupFront || !entry) return;
    const front = popupFront;
    markFrontOptimistic(front); // instant color flip
    const docName = entry.name.replace(/\.[^.]+$/, "");
    try {
      await api.ankiAdd({
        word: popup.dictForm ?? popup.surface,
        reading: lookup.reading || popup.reading || "",
        translation: lookup.translation,
        notes: lookup.notes,
        context: [popup.context, popup.secondary, `source: ${docName}`]
          .filter((s): s is string => Boolean(s && s.trim()))
          .join("<br>"),
      });
      tmEvent("anki_add_read", { word: popup.surface, mediaId: id });
    } catch {
      unmarkFrontOptimistic(front); // revert the optimistic state
    }
  }, [popup, lookup, popupFront, entry, id, markFrontOptimistic, unmarkFrontOptimistic]);

  const onDelete = useCallback(async () => {
    const front = popupMatchedFront; // the card that actually matched
    if (!front) return;
    unmarkFrontOptimistic(front); // instant color flip
    try {
      await api.ankiDelete(front);
      deckCardsRef.current.delete(front);
    } catch {
      markFrontOptimistic(front); // delete failed — card is still there
    }
  }, [popupMatchedFront, markFrontOptimistic, unmarkFrontOptimistic]);

  // `a`: toggle the popup word in Anki (no buttons — color is the state cue)
  const onAnkiToggle = useCallback(() => {
    if (!popup) return;
    if (popupSaved) void onDelete();
    else if (lookup) void onAdd();
  }, [popup, popupSaved, lookup, onAdd, onDelete]);
  ankiToggleRef.current = onAnkiToggle;
  regenRef.current = onRegen;

  // ask… follow-up (same contract as the player popup)
  const onAsk = useCallback(async () => {
    if (!popup || askBusy) return;
    const q = askText.trim();
    if (!q) return;
    setAskText("");
    setAskBusy(true);
    setQa((prev) => [...prev, { q, a: null }]);
    const priorAnswer = [lookup?.reading, lookup?.translation, lookup?.notes]
      .filter(Boolean)
      .join("\n");
    try {
      const res = await api.ask({
        question: q,
        word: popup.surface,
        sentence: popup.context,
        priorAnswer,
        source: entry?.name ?? "",
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
      askInputRef.current?.focus();
    }
  }, [popup, askText, askBusy, lookup, entry]);

  const popupKey = popup ? popup.dictForm ?? popup.surface : null;
  const readingNode = useMemo(() => {
    if (!popup) return null;
    const reading = lookup?.reading || popup.reading;
    if (!reading) return null;
    if (pitchOn && accents)
      return (
        <AccentReading
          reading={reading}
          accent={accentOf(accents, popup.surface, reading, popup.dictForm)}
        />
      );
    return <>{reading}</>;
  }, [popup, lookup, accents, pitchOn]);

  if (notFound)
    return (
      <div className="state error" role="alert">
        File not found. <a href="#/">Back to library</a>
      </div>
    );
  if (!entry || cues == null)
    return (
      <div className="state" role="status">
        <span className="spinner" aria-hidden /> Loading…
      </div>
    );
  if (cues.length === 0)
    return (
      <div className="empty">
        No Japanese subtitles for this episode —{" "}
        <a href={`#/play/${id}`}>open the player</a> to generate them.
      </div>
    );

  return (
    <>
      <Read
        cues={cues}
        secondaryCues={secondaryCues}
        entryName={entry.name.replace(/\.[^.]+$/, "")}
        mediaId={id}
        tokenize={tokenize}
        renderTokenLine={renderTokenLine}
        onJump={onJump}
        onCursorActivate={onCursorActivate}
        knownPct={knownPct}
      />
      {popup && (
        <div
          ref={panelRef}
          className="lookup pinned read-popup"
          style={{ position: "absolute", left: popup.x, top: popup.y }}
        >
          <div>
            <span className={`word${popupSaved ? " saved" : ""}`}>
              {popup.surface}
            </span>
            {readingNode && <span className="reading read-reading">{readingNode}</span>}
            {popupKey && blacklist.has(popupKey) && (
              <span className="known-flag" title="Blacklisted — press x to toggle">
                blacklisted
              </span>
            )}
            {popupKey && knownWords.has(popupKey) && (
              <span className="known-flag" title="Marked as known — press k to toggle">
                known
              </span>
            )}
          </div>
          {lookupLoading && (
            <div className="spinner-line">
              <span className="spinner" aria-hidden /> Looking up…
            </div>
          )}
          {lookup && (
            <>
              <div className="translation">{lookup.translation}</div>
              {lookup.notes && <div className="notes">{lookup.notes}</div>}
            </>
          )}
          <Encounters
            hits={encHits}
            open={encOpen}
            onToggle={() => setEncOpen((o) => !o)}
          />
          <div className="row">
            <button className="btn" onClick={() => setPopup(null)}>
              Close
            </button>
          </div>
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
            onKeyDown={(e) => {
              if (e.key === "Enter") void onAsk();
              else if (e.key === "Escape") setPopup(null);
            }}
          />
        </div>
      )}
    </>
  );
}

export default ReadRoute;
