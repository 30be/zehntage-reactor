// The `.sub-overlay` subtitle block: loading line, primary TokenLine + the
// explain `?` button, and the secondary (translation) line. Pure presentation —
// cue state, hover-pause engine and popup state live in Player.tsx; this just
// renders the prepared values and wires the supplied callbacks/refs. Extracted
// from Player.tsx.

import { memo } from "react";
import { TokenLine } from "../TokenLine.tsx";
import type { KToken } from "../tokenizer.ts";
import type { WordIndex } from "../progress.ts";

// Memoized: all callbacks/refs passed by Player are useCallback-wrapped or
// stable refs, and the data props (tokens, wordIndex, knownWords, blacklist,
// accents, the texts, the toggles) change identity only on a real change. So
// memo skips re-renders driven purely by unrelated Player state (popup/HUD/
// per-tick) without ever masking a genuine update.
export const SubOverlay = memo(function SubOverlay({
  subScale,
  cuesLoading,
  primaryText,
  secondaryText,
  echoCue,
  tokens,
  wordIndex,
  knownWords,
  blacklist,
  furiganaOn,
  accents,
  pitchOn,
  onWordEnter,
  onWordLeave,
  onWordClick,
  onExplainClick,
  clearCloseTimer,
  pauseForHover,
  resumeFromHover,
  popupOpenRef,
  secondaryHoveredRef,
  setSecShow,
  secShow,
  secHold,
  blurOff,
}: {
  subScale: number;
  cuesLoading: boolean;
  primaryText: string;
  secondaryText: string;
  echoCue: unknown;
  tokens: KToken[] | null;
  wordIndex: WordIndex;
  knownWords: Set<string>;
  blacklist: Set<string>;
  furiganaOn: boolean;
  accents: Map<string, number> | null;
  pitchOn: boolean;
  onWordEnter: (tok: KToken, e: React.MouseEvent) => void;
  onWordLeave: () => void;
  onWordClick: (tok: KToken, e: React.MouseEvent) => void;
  onExplainClick: (e: React.MouseEvent) => void;
  clearCloseTimer: () => void;
  pauseForHover: () => void;
  resumeFromHover: () => void;
  popupOpenRef: React.RefObject<boolean>;
  secondaryHoveredRef: React.RefObject<boolean>;
  setSecShow: (v: boolean) => void;
  secShow: boolean;
  secHold: boolean;
  blurOff: boolean;
}) {
  return (
    <div
      className="sub-overlay"
      style={{ "--sub-scale": subScale } as React.CSSProperties}
    >
      {cuesLoading && !primaryText && (
        <div className="sub-loading">loading subtitles…</div>
      )}
      {/* echo dictation hides the JP line (the diff overlay shows it on reveal) */}
      {echoCue ? null : (
      <div className="sub-primary">
        <TokenLine
          tokens={tokens}
          fallbackText={primaryText}
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
        {primaryText && (
          <button
            type="button"
            className="explain-q"
            aria-label="Explain sentence structure"
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
          </button>
        )}
      </div>
      )}
      {secondaryText && (
        <div
          className={`sub-secondary${secShow || secHold || blurOff ? " show" : ""}`}
          onMouseEnter={() => {
            secondaryHoveredRef.current = true;
            clearCloseTimer();
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
  );
});
