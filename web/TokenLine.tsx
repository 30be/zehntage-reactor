// Shared token-line renderer: the SAME word rendering (hoverable/clickable
// tokens, learning-progress text color, furigana on unknown kanji) used by
// both the video overlay and the cue-list sidebar.
//
// Word coloring:
//   known / blacklisted  -> plain ambient text
//   unknown (not in deck)-> muted red (.tok.unk)
//   in deck (learning)   -> blue fading to ambient as the interval grows
//   in deck (mature)     -> plain ambient text

import { memo, useRef } from "react";
import { isLexical, kataToHira, vocabKey, type KToken } from "./tokenizer.ts";
import { DOUBLE_TAP_MS } from "./player/touch.ts";
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
  /** Touch single-tap on a word (phones): open the lookup popup, like hover.
   * `el` is the tapped token span (for popup positioning). */
  onWordTap?: (tok: KToken, el: HTMLElement) => void;
  /** Touch double-tap on a word: open the popup AND add the card. */
  onWordDoubleTap?: (tok: KToken, el: HTMLElement) => void;
}

// Memoized with the default shallow prop comparison: all coloring inputs are
// props (tokens, wordIndex, knownWords, blacklist, accents, the toggles, the
// handlers), so memo can never mask a genuine recolor — a deck/known change
// arrives as a new wordIndex/knownWords reference. On the overlay path
// (SubOverlay) the handlers are useCallback-stable, so memo skips re-renders
// from unrelated Player state; on the sidebar/read paths handlers are inline
// (memo is a harmless no-op there).
function TokenLineInner({
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
  onWordTap,
  onWordDoubleTap,
}: TokenLineProps) {
  // Touch tap / double-tap state machine (one per line). On a touch pointer we
  // own the gesture: a lone tap fires onWordTap after DOUBLE_TAP_MS, a second
  // tap on the SAME word inside that window cancels it and fires
  // onWordDoubleTap instead. We also swallow the synthetic mouse click the
  // browser emits after a touch, so onWordClick never double-fires on phones.
  const tap = useRef<{ key: string; t: number; timer: number } | null>(null);
  const handleWordPointerUp = (
    tok: KToken,
    key: string,
    e: React.PointerEvent,
  ) => {
    if (e.pointerType !== "touch") return; // mouse/pen keep the click path
    if (!onWordTap && !onWordDoubleTap) return;
    e.preventDefault(); // suppress the synthetic 300ms click → no double-fire
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement; // grab synchronously
    const now = Date.now();
    const prev = tap.current;
    if (prev && prev.key === key && now - prev.t < DOUBLE_TAP_MS) {
      window.clearTimeout(prev.timer);
      tap.current = null;
      onWordDoubleTap?.(tok, el);
      return;
    }
    if (prev) window.clearTimeout(prev.timer);
    const timer = window.setTimeout(() => {
      tap.current = null;
      onWordTap?.(tok, el);
    }, DOUBLE_TAP_MS);
    tap.current = { key, t: now, timer };
  };
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
          : matchFront(
              wordIndex,
              tok.surface_form,
              tok.reading,
              tok.basic_form,
              tok.pos,
            );
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
        const touchable = !!(onWordTap || onWordDoubleTap);
        return (
          <span
            key={i}
            className={`tok${inDeck ? " known" : ""}${due ? " due" : ""}${rot ? " rot" : ""}${unknown ? " unk" : ""}`}
            style={color ? { color } : undefined}
            role={isInteractive ? "button" : undefined}
            tabIndex={isInteractive ? 0 : undefined}
            onMouseEnter={onWordEnter ? (e) => onWordEnter(tok, e) : undefined}
            onMouseLeave={onWordLeave}
            onPointerUp={
              touchable ? (e) => handleWordPointerUp(tok, key, e) : undefined
            }
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

export const TokenLine = memo(TokenLineInner);
