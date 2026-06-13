// Pure helpers for the Review / Cram mode (#/review). DOM-free + network-free
// so bun test covers them fully; ReviewRoute.tsx only renders what these emit.
//
// A "review card" is a DUE deck word turned into a cloze built from one of the
// user's OWN watched cues (the server joins the due deck with the encounter
// index). We reuse web/quiz.ts blankOut/checkCloze so the SAME cloze rules
// apply everywhere (never blank brackets/punctuation, tolerant scoring).

import { BLANK, blankOut, checkCloze } from "./quiz.ts";

/** One due deck word + (optionally) where it was last watched. Mirrors the
 *  /api/review/due item shape. */
export interface DueWord {
  /** Anki front: "word" or "word [reading]". */
  front: string;
  /** the surface to recall (front with any "[reading]" stripped). */
  word: string;
  /** reading inside the front's brackets, if any. */
  reading?: string;
  /** card back — the RU translation, shown as the recall hint. */
  back: string;
  /** SRS interval in days (0 / undefined for new or unknown). */
  interval: number;
  /** true when Anki reports the card is:due (best-effort). */
  isDue?: boolean;
  /** a watched cue containing the word, for the cloze + deep-link. */
  encounter?: {
    mediaId: string;
    /** episode display name. */
    name?: string;
    /** cue start (seconds) — drives the "watch in context" deep-link. */
    start: number;
    /** the JA cue text to blank the word out of. */
    text: string;
  };
}

/** A study card ready to render: a cloze prompt (or front-only fallback). */
export interface ReviewCard {
  front: string;
  /** the surface the user must type. */
  answer: string;
  /** the RU hint (card back). */
  hint: string;
  /** JA prompt with the word blanked, or just the word when no usable cue. */
  prompt: string;
  /** true when the prompt is a real watched cue (vs. front-only fallback). */
  hasCue: boolean;
  /** deep-link target (#/play/<id>@<t>) when an encounter exists. */
  deepLink?: string;
  /** source episode name for the "watch in context" label. */
  source?: string;
}

export { BLANK };

/** How "due" a word is: most-overdue first. Lower interval = more urgent; an
 *  explicit isDue flag outranks a merely-small interval. Stable by front. */
function dueRank(w: DueWord): number {
  // isDue cards come first (rank < 0), then by ascending interval.
  return (w.isDue ? -1_000_000 : 0) + (Number.isFinite(w.interval) ? w.interval : 0);
}

/** Order due words most-overdue first (deterministic; ties broken by front). */
export function orderDue(words: DueWord[]): DueWord[] {
  return words
    .slice()
    .sort((a, b) => dueRank(a) - dueRank(b) || a.front.localeCompare(b.front));
}

/** Build one review card from a due word. Uses the watched cue when present
 *  (cloze via blankOut); otherwise falls back to a front-only prompt so a word
 *  with no library encounter is still reviewable. */
export function buildCard(w: DueWord): ReviewCard {
  const base: ReviewCard = {
    front: w.front,
    answer: w.word,
    hint: w.back,
    prompt: w.word,
    hasCue: false,
  };
  const enc = w.encounter;
  if (enc && enc.text.trim()) {
    const prompt = blankOut(enc.text, w.word);
    // only treat it as a cloze if blankOut actually removed the word
    if (prompt !== enc.text && prompt.includes(BLANK)) {
      return {
        ...base,
        prompt,
        hasCue: true,
        deepLink: `#/play/${enc.mediaId}@${enc.start}`,
        source: enc.name ?? enc.mediaId,
      };
    }
  }
  return base;
}

/** Full ordered deck of review cards from the due-word list. */
export function buildDeck(words: DueWord[]): ReviewCard[] {
  return orderDue(words).map(buildCard);
}

/** Score a typed answer against a card (reuses quiz.ts tolerant compare). */
export function scoreAnswer(card: ReviewCard, typed: string): boolean {
  return checkCloze(typed, card.answer);
}
