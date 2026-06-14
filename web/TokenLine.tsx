// Shared token-line renderer: the SAME word rendering (hoverable/clickable
// tokens, learning-progress text color, furigana on unknown kanji) used by
// both the video overlay and the cue-list sidebar.
//
// Word coloring:
//   known / blacklisted  -> plain ambient text
//   unknown (not in deck)-> muted red (.tok.unk)
//   in deck (learning)   -> blue fading to ambient as the interval grows
//   in deck (mature)     -> plain ambient text

import { isLexical, kataToHira, vocabKey, type KToken } from "./tokenizer.ts";
import {
  matchFront,
  progressBucket,
  learningColor,
  decayFactor,
  type WordIndex,
} from "./progress.ts";
import { accentOf, accentPattern, morae } from "./accent.ts";

const HAS_KANJI = /[一-龯々]/;
const MATURE_BUCKET = 4;

/** Stable identity for the local known-set / blacklist / coverage: the
 * homograph-aware vocabKey, so 生(なま) and 生(せい) are tracked separately
 * while a verb's conjugations still collapse to one key. */
export function wordKey(tok: KToken): string {
  return vocabKey(tok);
}

/**
 * Kana reading rendered as per-mora spans: overline (border-top) on high
 * morae, ꜜ marker where the pitch drops (after mora `accent` for accent>=1).
 * accent == null → plain text (no pitch info available).
 */
export function AccentReading({
  reading,
  accent,
}: {
  reading: string;
  accent: number | null;
}) {
  const kana = kataToHira(reading);
  if (accent == null) return <>{kana}</>;
  const ms = morae(kana);
  const pattern = accentPattern(kana, accent);
  return (
    <>
      {ms.map((m, i) => (
        <span key={i} className={`mora${pattern[i] ? " hi" : ""}`}>
          {m}
          {accent >= 1 && i === accent - 1 ? (
            <span className="acc-drop" aria-hidden>
              ꜜ
            </span>
          ) : null}
        </span>
      ))}
    </>
  );
}

export interface TokenLineProps {
  tokens: KToken[] | null;
  fallbackText: string;
  wordIndex: WordIndex;
  /** local mark-as-known set (zr.known): plain text, no furigana */
  knownWords: Set<string>;
  furiganaOn: boolean;
  /** zr.blacklist lemmas: rendered plain (no coloring/furigana/counting) */
  blacklist?: Set<string>;
  /** pitch-accent map (loadAccents()); null/undefined = plain furigana */
  accents?: Map<string, number> | null;
  /** settings toggle (default on) for pitch-accent marks in furigana */
  pitchAccentOn?: boolean;
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
  blacklist,
  accents,
  pitchAccentOn,
  onWordEnter,
  onWordLeave,
  onWordClick,
}: TokenLineProps) {
  if (!tokens) return <>{fallbackText}</>;
  return (
    <>
      {tokens.map((tok, i) => {
        if (!isLexical(tok)) return <span key={i}>{tok.surface_form}</span>;
        const key = wordKey(tok);
        const blacklisted = blacklist?.has(key) ?? false;
        // Deck membership wins over the local known-set: a word that is an
        // active deck card must show its learning color even if it was once
        // marked known. Blacklist still forces plain.
        const front = blacklisted
          ? null
          : matchFront(wordIndex, tok.surface_form, tok.reading, tok.basic_form);
        const inDeck = front != null;
        const localKnown = !inDeck && (knownWords.has(key) || blacklisted);
        const color = inDeck ? learningColor(wordIndex.progress[front!]) : null;
        // due for review right now → subtle dotted underline (SRS hint)
        const due = inDeck && wordIndex.progress[front!]?.isDue === true;
        // overdue → retention-decay: learningColor() already tints the text
        // toward unknown-red; .rot is a styling hook for the rotting state.
        const rot = inDeck && decayFactor(wordIndex.progress[front!]) > 0;
        const unknown = !localKnown && !inDeck;
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
        const isInteractive = !!onWordClick;
        return (
          <span
            key={i}
            className={`tok${inDeck ? " known" : ""}${due ? " due" : ""}${rot ? " rot" : ""}${unknown ? " unk" : ""}`}
            style={color ? { color } : undefined}
            role={isInteractive ? "button" : undefined}
            tabIndex={isInteractive ? 0 : undefined}
            onMouseEnter={onWordEnter ? (e) => onWordEnter(tok, e) : undefined}
            onMouseLeave={onWordLeave}
            onClick={onWordClick ? (e) => onWordClick(tok, e) : undefined}
            onKeyDown={onWordClick ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onWordClick(tok, e as unknown as React.MouseEvent);
              }
            } : undefined}
          >
            {showFuri ? (
              <ruby>
                {tok.surface_form}
                <rt>
                  {pitchAccentOn !== false && accents ? (
                    <AccentReading
                      reading={tok.reading!}
                      accent={accentOf(
                        accents,
                        tok.surface_form,
                        tok.reading!,
                        tok.basic_form,
                      )}
                    />
                  ) : (
                    kataToHira(tok.reading!)
                  )}
                </rt>
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
