// Shared token-line renderer: the SAME word rendering (hoverable/clickable
// tokens, Anki progress gradient underline, furigana on unknown kanji) used by
// both the video overlay and the cue-list sidebar.

import { isLexical, kataToHira, type KToken } from "./tokenizer.ts";
import {
  matchFront,
  progressBucket,
  progressColor,
  type WordIndex,
} from "./progress.ts";

const HAS_KANJI = /[一-龯々]/;
const MATURE_BUCKET = 4;

/** Stable identity for the local known-set: dictionary form when available. */
export function wordKey(tok: KToken): string {
  return tok.basic_form && tok.basic_form !== "*"
    ? tok.basic_form
    : tok.surface_form;
}

export interface TokenLineProps {
  tokens: KToken[] | null;
  fallbackText: string;
  wordIndex: WordIndex;
  /** local mark-as-known set (zr.known): no underline, no furigana */
  knownWords: Set<string>;
  furiganaOn: boolean;
  onWordEnter?: (tok: KToken, e: React.MouseEvent) => void;
  onWordLeave?: () => void;
  onWordClick?: (tok: KToken, e: React.MouseEvent) => void;
}

export function TokenLine({
  tokens,
  fallbackText,
  wordIndex,
  knownWords,
  furiganaOn,
  onWordEnter,
  onWordLeave,
  onWordClick,
}: TokenLineProps) {
  if (!tokens) return <>{fallbackText}</>;
  return (
    <>
      {tokens.map((tok, i) => {
        if (!isLexical(tok)) return <span key={i}>{tok.surface_form}</span>;
        const localKnown = knownWords.has(wordKey(tok));
        const front = localKnown
          ? null
          : matchFront(wordIndex, tok.surface_form, tok.reading, tok.basic_form);
        const inDeck = front != null;
        const color = inDeck ? progressColor(wordIndex.progress[front!]) : undefined;
        const mature =
          inDeck &&
          progressBucket(wordIndex.progress[front!]?.interval ?? 0) >=
            MATURE_BUCKET;
        const showFuri =
          furiganaOn &&
          !localKnown &&
          !mature &&
          !!tok.reading &&
          HAS_KANJI.test(tok.surface_form);
        return (
          <span
            key={i}
            className={`tok${inDeck ? " known" : ""}`}
            style={
              color
                ? ({ ["--tok-color"]: color } as React.CSSProperties)
                : undefined
            }
            onMouseEnter={onWordEnter ? (e) => onWordEnter(tok, e) : undefined}
            onMouseLeave={onWordLeave}
            onClick={onWordClick ? (e) => onWordClick(tok, e) : undefined}
          >
            {showFuri ? (
              <ruby>
                {tok.surface_form}
                <rt>{kataToHira(tok.reading!)}</rt>
              </ruby>
            ) : (
              tok.surface_form
            )}
          </span>
        );
      })}
    </>
  );
}
