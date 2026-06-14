// Language-Reactor-style subtitle list: a collapsible right-hand column with
// every primary cue (timestamp + tokenized JP + matching RU line). Current cue
// is highlighted and auto-scrolled into view; manual scrolling pauses the
// autoscroll for a few seconds. Cheap virtualization: only ±WINDOW cues around
// the active one are rendered, with spacer divs standing in for the rest.

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Cue } from "./api.ts";
import { activeCueIndex } from "./cues.ts";
import { getTokenizer, type KToken } from "./tokenizer.ts";
import { cueTokensGet, cueTokensPut } from "./player/shared.ts";
import type { WordIndex } from "./progress.ts";
import { TokenLine } from "./TokenLine.tsx";

const WINDOW = 40; // cues rendered on each side of the active one
const EST_ROW = 60; // estimated row height (px) for the spacers
const USER_SCROLL_PAUSE_MS = 5000;

const fmtTime = (s: number): string => {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
};

interface RowProps {
  cue: Cue;
  secondary: string;
  active: boolean;
  // Stable Player seek handler + the current offset; CueRow binds cue.start
  // once per cue so the click handler stays referentially stable.
  onSeek: (videoTime: number) => void;
  subOffset: number;
  wordIndex: WordIndex;
  knownWords: Set<string>;
  blacklist?: Set<string>;
  furiganaOn: boolean;
  accents?: Map<string, number> | null;
  pitchAccentOn?: boolean;
  // Stable (useCallback) handlers from the Player. The cue text is the lookup
  // context; CueRow binds it once per cue so the closures stay referentially
  // stable across re-renders and don't defeat TokenLine's memo.
  onWordEnter: (tok: KToken, e: React.MouseEvent, ctx: string) => void;
  onWordLeave: () => void;
  onWordClick: (tok: KToken, e: React.MouseEvent, ctx: string) => void;
  rowRef?: React.Ref<HTMLDivElement>;
}

// Memoized: only the row whose props actually change (e.g. its active flag
// flips on a cue transition, or its coloring inputs change) re-renders. All the
// handler props are stable (Player useCallbacks; per-cue binders below are
// useCallback-keyed on cue.text), so a plain shallow compare is safe.
function CueRowInner({
  cue,
  secondary,
  active,
  onSeek,
  subOffset,
  wordIndex,
  knownWords,
  blacklist,
  furiganaOn,
  accents,
  pitchAccentOn,
  onWordEnter,
  onWordLeave,
  onWordClick,
  rowRef,
}: RowProps) {
  const [tokens, setTokens] = useState<KToken[] | null>(
    () => cueTokensGet(cue.text) ?? null,
  );
  // RU translation: hidden by default. A small (?) shows up while the row is
  // hovered; the translation text renders ONLY while the (?) itself is
  // hovered — inline, reserving no vertical space otherwise.
  const [secShown, setSecShown] = useState(false);
  useEffect(() => {
    const cached = cueTokensGet(cue.text);
    if (cached) {
      setTokens(cached);
      return;
    }
    let cancelled = false;
    void getTokenizer()
      .then((tok) => {
        if (cancelled) return;
        const ts = tok.tokenize(cue.text);
        cueTokensPut(cue.text, ts);
        setTokens(ts);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [cue.text]);

  // Per-cue handler binders: stable as long as the underlying Player handler
  // and this cue's text are stable, so TokenLine's memo isn't defeated.
  const handleWordEnter = useCallback(
    (tok: KToken, e: React.MouseEvent) => onWordEnter(tok, e, cue.text),
    [onWordEnter, cue.text],
  );
  const handleWordClick = useCallback(
    (tok: KToken, e: React.MouseEvent) => onWordClick(tok, e, cue.text),
    [onWordClick, cue.text],
  );
  const handleSeek = useCallback(
    () => onSeek(Math.max(0, cue.start + subOffset)),
    [onSeek, cue.start, subOffset],
  );

  return (
    <div ref={rowRef} className={`cue-row${active ? " active" : ""}`}>
      <button
        type="button"
        className="cue-time"
        aria-label={`Jump to ${fmtTime(cue.start)}`}
        onClick={handleSeek}
      >
        {fmtTime(cue.start)}
      </button>
      <div className="cue-body">
        <div className="cue-text">
          <TokenLine
            tokens={tokens}
            fallbackText={cue.text}
            wordIndex={wordIndex}
            knownWords={knownWords}
            blacklist={blacklist}
            furiganaOn={furiganaOn}
            accents={accents}
            pitchAccentOn={pitchAccentOn}
            onWordEnter={handleWordEnter}
            onWordLeave={onWordLeave}
            onWordClick={handleWordClick}
          />
          {secondary && (
            <button
              type="button"
              className="cue-sec-q"
              aria-label="Show translation"
              aria-expanded={secShown}
              onMouseEnter={() => setSecShown(true)}
              onMouseLeave={() => setSecShown(false)}
              onFocus={() => setSecShown(true)}
              onBlur={() => setSecShown(false)}
            >
              ?{secShown && <span className="cue-sec">{secondary}</span>}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

const CueRow = memo(CueRowInner);

export interface SidebarProps {
  cues: Cue[];
  secondaryCues: Cue[];
  activeIdx: number;
  subOffset: number;
  onSeek: (videoTime: number) => void;
  wordIndex: WordIndex;
  knownWords: Set<string>;
  blacklist?: Set<string>;
  furiganaOn: boolean;
  accents?: Map<string, number> | null;
  pitchAccentOn?: boolean;
  onWordEnter: (tok: KToken, e: React.MouseEvent, ctx: string) => void;
  onWordLeave: () => void;
  onWordClick: (tok: KToken, e: React.MouseEvent, ctx: string) => void;
}

export function Sidebar({
  cues,
  secondaryCues,
  activeIdx,
  subOffset,
  onSeek,
  wordIndex,
  knownWords,
  blacklist,
  furiganaOn,
  accents,
  pitchAccentOn,
  onWordEnter,
  onWordLeave,
  onWordClick,
}: SidebarProps) {
  const activeRowRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // last position we centered the window on, kept while between cues
  const lastCenterRef = useRef(0);
  // autoscroll guard: ignore programmatic scrolls, pause after user scrolls
  const programmaticRef = useRef(false);
  const userScrollUntilRef = useRef(0);
  // measured row height (refined from a real rendered row)
  const estRowRef = useRef(EST_ROW);
  // window of estimated indices currently visible in the scroll viewport
  const [scrollWin, setScrollWin] = useState<{ first: number; last: number } | null>(
    null,
  );

  if (activeIdx >= 0) lastCenterRef.current = activeIdx;
  const center = activeIdx >= 0 ? activeIdx : lastCenterRef.current;
  const aStart = Math.max(0, center - WINDOW);
  const aEnd = Math.min(cues.length, center + WINDOW + 1);

  // The render window is the UNION of the active-index window and the
  // scroll-position window, so manual scrollback never shows blank spacers.
  const ranges: Array<[number, number]> = [[aStart, aEnd]];
  if (scrollWin) {
    const sStart = Math.max(0, Math.min(scrollWin.first, cues.length));
    const sEnd = Math.max(sStart, Math.min(scrollWin.last, cues.length));
    if (sEnd > sStart) ranges.push([sStart, sEnd]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }

  // Precompute the secondary-cue index for every primary cue we're about to
  // render, ONCE per render. Previously each CueRow ran activeCueIndex() (a
  // binary search) per render — ~80×/cue change. Memoized on the inputs that
  // actually change the mapping (the cue/secondary lists, the offset, and which
  // window slices are visible) so cue transitions don't recompute it.
  const secByIndex = useMemo(() => {
    const map = new Map<number, string>();
    for (const [s, e] of merged) {
      for (let i = s; i < e; i++) {
        const cue = cues[i]!;
        // RU line shown at the cue's midpoint; secondary cues live in raw
        // video time, primary cues in track time (hence + subOffset).
        const mid = (cue.start + cue.end) / 2 + subOffset;
        const si = activeCueIndex(secondaryCues, mid);
        map.set(i, si >= 0 ? secondaryCues[si]!.text : "");
      }
    }
    return map;
    // merged is rebuilt each render; key on its serialized bounds instead so we
    // only recompute when the visible window or inputs truly change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cues, secondaryCues, subOffset, JSON.stringify(merged)]);

  const updateScrollWindow = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const est = estRowRef.current;
    const first = Math.max(0, Math.floor(el.scrollTop / est) - 20);
    const last = Math.ceil((el.scrollTop + el.clientHeight) / est) + 20;
    setScrollWin((p) =>
      p && p.first === first && p.last === last ? p : { first, last },
    );
  }, []);

  // Measure a real row to refine the row-height estimate. Done in a layout
  // effect (after commit) and only written when the measurement actually
  // changes, so it never forces a synchronous layout read on every render.
  useLayoutEffect(() => {
    const row = containerRef.current?.querySelector<HTMLElement>(".cue-row");
    if (row) {
      const h = row.offsetHeight;
      if (h > 0 && h !== estRowRef.current) estRowRef.current = h;
    }
  }, [cues.length, activeIdx]);

  // keep the scroll window in sync on mount / cue list changes
  useEffect(() => {
    updateScrollWindow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cues.length]);

  // auto-scroll the active row into view on natural cue changes
  useEffect(() => {
    if (activeIdx < 0) return;
    if (Date.now() < userScrollUntilRef.current) return;
    const el = activeRowRef.current;
    if (!el) return;
    programmaticRef.current = true;
    el.scrollIntoView({ block: "nearest" });
    updateScrollWindow();
    const t = window.setTimeout(() => {
      programmaticRef.current = false;
    }, 250);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIdx]);

  const onScroll = useCallback(() => {
    if (!programmaticRef.current) {
      userScrollUntilRef.current = Date.now() + USER_SCROLL_PAUSE_MS;
    }
    updateScrollWindow();
  }, [updateScrollWindow]);

  if (cues.length === 0) {
    return (
      <div className="cue-sidebar empty-list">
        <span className="muted">No subtitles loaded</span>
        <span className="muted hint">Pick a subtitle track to see the cue list.</span>
      </div>
    );
  }

  const renderRow = (cue: Cue, i: number) => (
    <CueRow
      key={`${i}:${cue.start}`}
      cue={cue}
      secondary={secByIndex.get(i) ?? ""}
      active={i === activeIdx}
      onSeek={onSeek}
      subOffset={subOffset}
      wordIndex={wordIndex}
      knownWords={knownWords}
      blacklist={blacklist}
      furiganaOn={furiganaOn}
      accents={accents}
      pitchAccentOn={pitchAccentOn}
      onWordEnter={onWordEnter}
      onWordLeave={onWordLeave}
      onWordClick={onWordClick}
      rowRef={i === activeIdx ? activeRowRef : undefined}
    />
  );

  const est = estRowRef.current;
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  for (const [s, e] of merged) {
    if (s > cursor) {
      parts.push(<div key={`sp:${cursor}`} style={{ height: (s - cursor) * est }} />);
    }
    for (let i = s; i < e; i++) parts.push(renderRow(cues[i]!, i));
    cursor = e;
  }
  if (cursor < cues.length) {
    parts.push(
      <div key={`sp:${cursor}`} style={{ height: (cues.length - cursor) * est }} />,
    );
  }

  return (
    <div className="cue-sidebar" ref={containerRef} onScroll={onScroll}>
      {parts}
    </div>
  );
}
