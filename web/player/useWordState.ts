// Deck / known-word state machine (extracted from Player.tsx, Phase 4 — no
// behavior changes). Owns the cohesive sub-system that powers TokenLine's
// known-word coloring:
//
//   - the `wordIndex` (+ `wordIndexRef`) and `knownFronts` state derived from
//     the live Anki deck (web/ankicache.ts) plus the optimistic-front overlay.
//   - `deckCardsRef`: front -> full card, so a word already in the deck can be
//     filled from the existing card instead of calling Gemini (read by useLookup).
//   - the live revalidation effect: every `useAnkiWordsLive()` snapshot rebuilds
//     wordIndex/knownFronts/deckCardsRef, MERGING any still-pending optimistic
//     fronts so a background ETag revalidation that raced an add can't un-mark a
//     freshly-added word.
//   - markFrontOptimistic / unmarkFrontOptimistic: instant color flip into BOTH
//     knownFronts and wordIndex, tracked in pendingFrontsRef until the server
//     cache confirms (or the unmark drops them).
//   - refreshAnki: force a fresh fetch; the result lands via the useAnkiWordsLive
//     channel (single source of truth — no direct setState here).
//
// Deliberately LEFT in Player.tsx (separate sub-systems, not part of the deck
// state machine even though they also feed TokenLine coloring):
//   - the local `knownWords` set (zr.known, `k` hotkey) + its ref,
//   - the `blacklist` set (zr.blacklist, `x` hotkey) + its ref,
//   - the frequency-rank map (freqMap).
//
// Semantics preserved VERBATIM, including the subtle bits:
//   - optimistic marks survive a revalidate (pendingFrontsRef merge),
//   - mark/unmark write to knownFronts AND wordIndex in the same render,
//   - all useCallback dep arrays are [] (refs/setters only), the revalidation
//     effect dep array is [liveAnki], and refreshAnki deps are [].

import { useCallback, useEffect, useRef, useState } from "react";
import {
  buildWordIndex,
  withFront,
  withoutFront,
  type WordIndex,
} from "../progress.ts";
import { refreshAnkiWords, useAnkiWordsLive } from "../ankicache.ts";

export function useWordState(): {
  wordIndex: WordIndex;
  wordIndexRef: React.RefObject<WordIndex>;
  knownFronts: Set<string>;
  deckCardsRef: React.RefObject<
    Map<string, { front: string; back: string; notes: string }>
  >;
  markFrontOptimistic: (front: string) => void;
  unmarkFrontOptimistic: (front: string) => void;
  refreshAnki: () => Promise<void>;
} {
  const [wordIndex, setWordIndex] = useState<WordIndex>(() =>
    buildWordIndex([], {}),
  );
  const [knownFronts, setKnownFronts] = useState<Set<string>>(new Set());
  const wordIndexRef = useRef<WordIndex>(buildWordIndex([], {}));
  useEffect(() => {
    wordIndexRef.current = wordIndex;
  }, [wordIndex]);
  // front -> full card, so a popup for a word already in the deck can be
  // filled from the existing card instead of calling Gemini.
  const deckCardsRef = useRef<Map<string, { front: string; back: string; notes: string }>>(
    new Map(),
  );

  // Live deck (web/ankicache.ts): background ETag revalidations and optimistic
  // add/delete write-throughs re-render the known-word underlines without an
  // explicit refreshAnki() roundtrip.
  const liveAnki = useAnkiWordsLive();
  // Optimistic fronts not yet confirmed by the server cache: merged into every
  // liveAnki snapshot so a background revalidation that raced an add can't
  // un-mark a freshly-added word. Confirmed fronts drop out of the set.
  const pendingFrontsRef = useRef<Set<string>>(new Set());
  // Instant feedback: the optimistic front goes into the WORD INDEX too, so
  // TokenLine recolors the word in the same render — not seconds later when
  // the server roundtrip + cache refresh lands.
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
  useEffect(() => {
    if (!liveAnki) return;
    const fronts = new Set(liveAnki.words.map((w) => w.front));
    for (const f of pendingFrontsRef.current) {
      if (fronts.has(f)) pendingFrontsRef.current.delete(f); // confirmed
      else fronts.add(f); // still pending — keep the optimistic mark
    }
    // pending (not-yet-confirmed) optimistic fronts survive the rebuild
    let idx = buildWordIndex(liveAnki.words, liveAnki.progress);
    for (const f of pendingFrontsRef.current) idx = withFront(idx, f);
    setWordIndex(idx);
    setKnownFronts(fronts);
    deckCardsRef.current = new Map(liveAnki.words.map((w) => [w.front, w]));
  }, [liveAnki]);

  const refreshAnki = useCallback(async () => {
    // Force a fresh fetch; the result lands via the useAnkiWordsLive channel
    // (single source of truth — no direct setState here).
    await refreshAnkiWords().catch(() => {});
  }, []);

  return {
    wordIndex,
    wordIndexRef,
    knownFronts,
    deckCardsRef,
    markFrontOptimistic,
    unmarkFrontOptimistic,
    refreshAnki,
  };
}
