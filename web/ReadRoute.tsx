// #/read/<id> — reading mode: fetches the same ja + secondary cues as the
// Player, injects the tokenizer and a TokenLine-based renderer into <Read>
// with a simplified click-pinned word popup (deck card first, Gemini lookup
// otherwise). Jumping a timestamp navigates back to the player.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type Cue, type LibraryEntry, type WordLookup } from "./api.ts";
import { Read } from "./Read.tsx";
import { TokenLine, AccentReading } from "./TokenLine.tsx";
import { buildWordIndex, matchFront, type WordIndex } from "./progress.ts";
import { getTokenizer, type KToken } from "./tokenizer.ts";
import { accentOf, loadAccents } from "./accent.ts";
import { readBlacklist, writeBlacklist } from "./blacklist.ts";
import { tmEvent } from "./telemetry.ts";

const isJaLang = (l: string) => l === "ja" || l === "jpn" || l.startsWith("ja");

interface ReadPopup {
  x: number;
  y: number;
  surface: string;
  reading?: string;
  dictForm?: string;
  context: string;
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
  const [knownWords] = useState<Set<string>>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem("zr.known") ?? "[]");
      return new Set(Array.isArray(raw) ? raw.filter((w) => typeof w === "string") : []);
    } catch {
      return new Set();
    }
  });
  const [blacklist, setBlacklist] = useState<Set<string>>(() => readBlacklist());
  const [accents, setAccents] = useState<Map<string, number> | null>(null);
  const [popup, setPopup] = useState<ReadPopup | null>(null);
  const [lookup, setLookup] = useState<WordLookup | null>(null);
  const [lookupLoading, setLookupLoading] = useState(false);
  const deckCardsRef = useRef<Map<string, { front: string; back: string; notes: string }>>(
    new Map(),
  );
  const panelRef = useRef<HTMLDivElement>(null);

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
        setWordIndex(buildWordIndex(a.words, a.progress));
        deckCardsRef.current = new Map(a.words.map((w) => [w.front, w]));
      })
      .catch(() => {});
    void loadAccents()
      .then((m) => !cancelled && setAccents(m))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // close the popup on Esc / outside click
  useEffect(() => {
    if (!popup) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPopup(null);
      // x toggles blacklist for the popup word (mirrors the player hotkey);
      // e.code = physical key, so it works on non-Latin layouts too
      if (e.code === "KeyX" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const key = popup.dictForm ?? popup.surface;
        setBlacklist((prev) => {
          const next = new Set(prev);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          writeBlacklist(next);
          return next;
        });
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
  }, [popup]);

  // simplified lookup: deck card if present, else Gemini
  useEffect(() => {
    if (!popup) {
      setLookup(null);
      return;
    }
    const matched = matchFront(wordIndex, popup.surface, popup.reading, popup.dictForm);
    const deckCard = matched ? deckCardsRef.current.get(matched) : undefined;
    if (deckCard) {
      const m = deckCard.front.match(/^(.+?)\s*\[(.+?)\]\s*$/);
      setLookup({
        reading: m?.[2] ?? "",
        translation: deckCard.back,
        notes: deckCard.notes ?? "",
        context: "",
      });
      setLookupLoading(false);
      return;
    }
    let cancelled = false;
    setLookup(null);
    setLookupLoading(true);
    void api
      .lookup({
        word: popup.surface,
        context: popup.context,
        source: entry?.name ?? "",
      })
      .then((res) => !cancelled && setLookup(res))
      .catch(() => {})
      .finally(() => !cancelled && setLookupLoading(false));
    return () => {
      cancelled = true;
    };
  }, [popup?.surface, popup?.context]);

  const onWordClick = useCallback((tok: KToken, e: React.MouseEvent, ctx: string) => {
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setPopup({
      x: Math.min(rect.left, window.innerWidth - 340),
      y: rect.bottom + 6 + window.scrollY,
      surface: tok.surface_form,
      reading: tok.reading,
      dictForm:
        tok.basic_form && tok.basic_form !== "*" && tok.basic_form !== tok.surface_form
          ? tok.basic_form
          : undefined,
      context: ctx,
    });
  }, []);

  const renderTokenLine = useCallback(
    (tokens: KToken[] | null, fallback: string) => (
      <TokenLine
        tokens={tokens}
        fallbackText={fallback}
        wordIndex={wordIndex}
        knownWords={knownWords}
        blacklist={blacklist}
        furiganaOn={furiganaOn}
        accents={accents}
        pitchAccentOn={pitchOn}
        onWordClick={(tok, e) => onWordClick(tok, e, fallback)}
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
      <div className="empty">
        File not found. <a href="#/">Back to library</a>
      </div>
    );
  if (!entry || cues == null) return <div className="empty">Loading…</div>;
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
      />
      {popup && (
        <div
          ref={panelRef}
          className="lookup pinned read-popup"
          style={{ position: "absolute", left: popup.x, top: popup.y }}
        >
          <div>
            <span className="word">{popup.surface}</span>
            {readingNode && <span className="reading read-reading">{readingNode}</span>}
            {popupKey && blacklist.has(popupKey) && (
              <span className="known-flag" title="Blacklisted — press x to toggle">
                blacklisted
              </span>
            )}
            {popupKey && knownWords.has(popupKey) && (
              <span className="known-flag" title="Marked as known">
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
            <button className="btn" onClick={() => setPopup(null)}>
              Close
            </button>
          </div>
        </div>
      )}
    </>
  );
}

export default ReadRoute;
