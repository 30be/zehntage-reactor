// Word-lookup popup sub-system (extracted from Player.tsx, Phase 4 — no
// behavior changes). Owns the cleanly-separable LOOKUP core:
//
//   - lookup / lookupLoading state + the per-surface lookupCache and the
//     in-flight de-dup map.
//   - the popup-target effect that fills `lookup` from an existing deck card
//     (no Gemini call) or fetches it (cached, de-duped) when a WORD popup
//     opens/retargets.
//   - onReload (the `g` hotkey): force a fresh, cache-bypassing Gemini call.
//   - popupFront / popupMatchedFront / popupSaved: the reading-aware deck-front
//     resolution (matchFront over wordIndex) the panel + add/delete use.
//   - cueBoundsAt: FILE-time bounds of the primary cue at a timestamp, for
//     sentence-audio capture on add.
//
// Deliberately LEFT in Player.tsx (too cross-cutting to split cleanly):
//   - the central `popup`/`pinned` state + hover/pin/close handlers (driven by
//     the hover-pause engine, which already receives setPopup),
//   - the sentence `explain`, `encounters`, and follow-up `qa`/`ask` state,
//   - onAdd / onAddSentence / onDelete / onAnkiToggle (they dispatch across the
//     word- and sentence-popup paths and read cueUnknowns / session refs),
//   - the popup-position useLayoutEffect (reads explain/qa too).
// Those CONSUME this hook's return (lookup, popupFront, popupSaved,
// popupMatchedFront, cueBoundsAt) and the moved code is wired back verbatim.
//
// CACHE KEY: both the in-memory map and the server's persistent cache key now
// use the homograph-aware `popup.vocabKey` (== wordKey(tok)) ALONE — context-
// independent, so a word looked up once is reused in every sentence.
// Effect dependency array: [popup?.kind, popup?.surface, popup?.context,
// popup?.vocabKey, popup?.reading] — vocabKey/reading included so a homograph
// (same surface, different reading) re-fires the lookup instead of showing the
// previous homograph's cached entry.
// onReload deps: [popup, entry.name, toast]. cueBoundsAt deps:
// [] (refs only). popupFront deps: [popup, lookup]. popupMatchedFront deps:
// [popup, wordIndex, knownFronts, popupFront].

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type Cue, type WordLookup } from "../api.ts";
import { activeCueIndex } from "../cues.ts";
import { matchFront, type WordIndex } from "../progress.ts";
import { deckCardToLookup, type PopupState } from "./shared.ts";

export function useLookup(opts: {
  popup: PopupState | null;
  wordIndex: WordIndex;
  wordIndexRef: React.RefObject<WordIndex>;
  knownFronts: Set<string>;
  deckCardsRef: React.RefObject<
    Map<string, { front: string; back: string; notes: string }>
  >;
  primaryCuesRef: React.RefObject<Cue[]>;
  subOffsetRef: React.RefObject<number>;
  sessLookupsRef: React.RefObject<number>;
  entryName: string;
  mediaId: string;
  tmEvent: (name: string, props?: Record<string, unknown>) => void;
  toast: (m: string) => void;
}): {
  lookup: WordLookup | null;
  lookupLoading: boolean;
  lookupErr: boolean;
  popupFront: string | null;
  popupMatchedFront: string | null;
  popupSaved: boolean;
  onReload: () => Promise<void>;
  cueBoundsAt: (timestamp: number) => { cueStart?: number; cueEnd?: number };
} {
  const {
    popup,
    wordIndex,
    wordIndexRef,
    knownFronts,
    deckCardsRef,
    primaryCuesRef,
    subOffsetRef,
    sessLookupsRef,
    entryName,
    mediaId,
    tmEvent,
    toast,
  } = opts;

  const [lookup, setLookup] = useState<WordLookup | null>(null);
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupErr, setLookupErr] = useState(false);
  const lookupCache = useRef<Map<string, WordLookup>>(new Map());
  const inflight = useRef<Map<string, Promise<WordLookup>>>(new Map());

  // fetch lookup when popup target changes (default: NO frame — saves latency)
  useEffect(() => {
    if (!popup || popup.kind !== "word") {
      setLookup(null);
      return;
    }
    setLookupErr(false);
    sessLookupsRef.current += 1; // session-summary counter
    // Word already in the deck? Fill the popup from the existing card —
    // no Gemini call. The Regenerate button still forces a fresh lookup.
    const matched = matchFront(
      wordIndexRef.current,
      popup.surface,
      popup.reading,
      popup.dictForm,
      popup.pos,
    );
    const deckCard = matched ? deckCardsRef.current.get(matched) : undefined;
    if (deckCard) {
      // In-deck word: PREFER a cached Gemini gloss (richer than the bare card —
      // the card's "back" is often just the kana reading). Never call Gemini
      // here — cachedOnly returns null on a miss, and we fall back to the card.
      let cancelled = false;
      const card = deckCard;
      const fallback = () => {
        if (!cancelled) {
          setLookup(deckCardToLookup(card));
          setLookupLoading(false);
        }
      };
      setLookupLoading(true);
      void api
        .lookupCached({
          word: popup.surface,
          vocabKey: popup.vocabKey,
          context: popup.context,
          source: entryName,
        })
        .then((cached) => {
          if (cancelled) return;
          if (cached) {
            setLookup(cached);
            setLookupLoading(false);
          } else {
            fallback();
          }
        })
        .catch(fallback);
      return () => {
        cancelled = true;
      };
    }
    // In-memory cache key = the homograph-aware vocabKey (matches the server's
    // persistent cache identity), so the same word dedups across ALL contexts.
    // Fall back to surface when vocabKey is somehow absent.
    const cacheKey = popup.vocabKey ?? popup.surface;
    const cached = lookupCache.current.get(cacheKey);
    if (cached) {
      setLookup(cached);
      setLookupLoading(false);
      return;
    }
    let cancelled = false;
    setLookup(null);
    setLookupLoading(true);
    // De-dup concurrent/repeat requests for the same word: share one in-flight
    // promise so sliding away and back never fires a second Gemini call.
    const surface = popup.surface;
    // Give Gemini the dictionary form when the token is conjugated.
    const ctx = popup.dictForm
      ? `${popup.context}\n(dictionary form: ${popup.dictForm})`
      : popup.context;
    let p = inflight.current.get(cacheKey);
    if (!p) {
      const _lookupT0 = Date.now();
      p = api.lookup({
        word: surface,
        vocabKey: popup.vocabKey,
        context: ctx,
        source: entryName,
        mediaId,
        secondary: popup.secondary,
      })
        .then((res) => {
          tmEvent("perf.client.lookup", { ms: Date.now() - _lookupT0, word: surface });
          lookupCache.current.set(cacheKey, res);
          return res;
        })
        .finally(() => inflight.current.delete(cacheKey));
      inflight.current.set(cacheKey, p);
    }
    void p
      .then((res) => {
        if (!cancelled) setLookup(res);
      })
      .catch(() => {
        if (!cancelled) setLookupErr(true);
      })
      .finally(() => !cancelled && setLookupLoading(false));
    return () => {
      cancelled = true;
    };
  }, [popup?.kind, popup?.surface, popup?.context, popup?.vocabKey, popup?.reading]);

  // Regenerate the lookup text for the same word, BYPASSING the cache (force a
  // fresh Gemini call). Replaces the panel content and updates the cache.
  // Bound to the `g` hotkey (no button — laconic popup).
  const onReload = useCallback(async () => {
    if (!popup || popup.kind !== "word") return;
    setLookupLoading(true);
    setLookupErr(false);
    try {
      const res = await api.lookup({
        word: popup.surface,
        vocabKey: popup.vocabKey,
        context: popup.context,
        secondary: popup.secondary,
        source: entryName,
        mediaId,
        noCache: true,
      });
      lookupCache.current.set(popup.vocabKey ?? popup.surface, res);
      setLookup(res);
    } catch (e) {
      setLookupErr(true);
      toast(`Regenerate failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setLookupLoading(false);
    }
  }, [popup, entryName, toast]);

  const popupFront = useMemo(() => {
    if (!popup) return null;
    // Front uses the dictionary (lemma) form so all conjugations match (the
    // lookup reading is the dict-form reading — it's looked up on the lemma).
    const word = popup.dictForm ?? popup.surface;
    const reading = lookup?.reading || popup.reading;
    return reading ? `${word} [${reading}]` : word;
  }, [popup, lookup]);

  // The deck front this popup actually refers to: reading-aware match for
  // word popups (conjugated surfaces resolve to the dictionary-form card),
  // exact front for sentence panels. null = not in the deck.
  const popupMatchedFront = useMemo(() => {
    if (!popup) return null;
    if (popup.kind === "sentence")
      return knownFronts.has(popup.surface) ? popup.surface : null;
    return (
      matchFront(
        wordIndex,
        popup.surface,
        popup.reading,
        popup.dictForm,
        popup.pos,
      ) ??
      (popupFront && knownFronts.has(popupFront) ? popupFront : null)
    );
  }, [popup, wordIndex, knownFronts, popupFront]);
  const popupSaved = popupMatchedFront != null;

  // Bounds of the primary cue at `timestamp` in FILE time (cue times are
  // track-time, so re-add the user's sync offset) for sentence-audio capture.
  const cueBoundsAt = useCallback((timestamp: number) => {
    const cues = primaryCuesRef.current;
    const idx = activeCueIndex(cues, timestamp - subOffsetRef.current);
    const cue = idx >= 0 ? cues[idx] : undefined;
    if (!cue) return {};
    return {
      cueStart: cue.start + subOffsetRef.current,
      cueEnd: cue.end + subOffsetRef.current,
    };
  }, []);

  return {
    lookup,
    lookupLoading,
    lookupErr,
    popupFront,
    popupMatchedFront,
    popupSaved,
    onReload,
    cueBoundsAt,
  };
}
