// Shared token-line renderer: the SAME word rendering (hoverable/clickable
// tokens, learning-progress text color, furigana on unknown kanji) used by
// both the video overlay and the cue-list sidebar.
//
// Word coloring:
//   known / blacklisted  -> plain ambient text
//   unknown (not in deck)-> muted red (.tok.unk)
//   in deck (learning)   -> blue fading to ambient as the interval grows
//   in deck (mature)     -> plain ambient text

import { isLexical, kataToHira, type KToken } from "./tokenizer.ts";
import {
  matchFront,
  progressBucket,
  learningColor,
  type WordIndex,
} from "./progress.ts";
import { accentOf, accentPattern, morae } from "./accent.ts";

const HAS_KANJI = /[一-龯々]/;
const MATURE_BUCKET = 4;

/** Stable identity for the local known-set: dictionary form when available. */
export function wordKey(tok: KToken): string {
  return tok.basic_form && tok.basic_form !== "*"
    ? tok.basic_form
    : tok.surface_form;
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
        const localKnown = knownWords.has(key) || blacklisted;
        const front = localKnown
          ? null
          : matchFront(wordIndex, tok.surface_form, tok.reading, tok.basic_form);
        const inDeck = front != null;
        const color = inDeck ? learningColor(wordIndex.progress[front!]) : null;
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
        return (
          <span
            key={i}
            className={`tok${inDeck ? " known" : ""}${unknown ? " unk" : ""}`}
            style={color ? { color } : undefined}
            onMouseEnter={onWordEnter ? (e) => onWordEnter(tok, e) : undefined}
            onMouseLeave={onWordLeave}
            onClick={onWordClick ? (e) => onWordClick(tok, e) : undefined}
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
