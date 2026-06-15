// In-memory FAKE Anki double used ONLY under ANKI_FAKE=1 by the e2e suite. All
// real read/write paths are windowless (src/lib/ankidb.ts), routed by review.ts.
// AnkiConnect (localhost:8765) and the remote anki-mcp backend have been removed.

export interface AnkiCard {
  front: string;
  back: string;
  notes?: string;
  context?: string;
  /** data: URI <img> source inlined into a field (windowless media path). */
  image?: string;
  /** Field the image renders into on the card (default "notes" server-side). */
  image_field?: string;
  /** Anki note id (= creation timestamp ms); fake double only. */
  noteId?: number;
  /** Note tags ("zehntage" marks cards mined by this app); fake double only. */
  tags?: string[];
  [key: string]: unknown;
}

// e2e fake mode: ANKI_FAKE=1 operates on an in-memory map, no network.
const ankiFake = () => process.env.ANKI_FAKE === "1";
const fakeCards = new Map<string, AnkiCard>();

// --- ANKI_FAKE review queue (e2e only) -------------------------------------
//
// In fake mode the real review flow (queue → reveal → grade) has no AnkiConnect
// to talk to, so we model a tiny in-memory FSRS-like queue. reviewQueue() serves
// it (available:true) and answerCard() records the grade + drops the card. This
// is ENTIRELY gated on ankiFake() — when ANKI_FAKE is unset every fake branch is
// skipped and the real AnkiConnect paths run unchanged.
//
// The queue is seeded lazily (first reviewQueue() call) from the fake-Anki note
// map if it carries any cards, else from a fixed couple of cards — so an e2e can
// either seed via addCard()/POST /api/anki/add first, or just hit #/review cold.

let fakeQueue: ReviewCard[] | null = null;
// cardId → ease, kept for test inspection after grading.
const fakeAnswers = new Map<number, number>();

/** Build a ReviewCard from a fake-Anki note. A stable cardId is derived from
 *  the note's noteId when present, else the front string's char codes. */
function fakeCardFromNote(card: AnkiCard, idx: number): ReviewCard {
  const front = typeof card.front === "string" ? card.front : `card-${idx}`;
  const back = typeof card.back === "string" ? card.back : "";
  const cardId =
    typeof card.noteId === "number"
      ? card.noteId
      : 9_000_000 + idx; // deterministic, collision-free for the fixed seeds
  return {
    cardId,
    question: `<div class="fake-q">${front}</div>`,
    answer: `<div class="fake-q">${front}</div><hr><div class="fake-a">${back || front}</div>`,
    front,
  };
}

/** The two fixed cards used when no fake notes have been added. */
function fakeSeedDefaults(): ReviewCard[] {
  return [
    {
      cardId: 9_000_001,
      question: `<div class="fake-q">勉強</div>`,
      answer: `<div class="fake-q">勉強</div><hr><div class="fake-a">benkyō — study</div>`,
      front: "勉強",
    },
    {
      cardId: 9_000_002,
      question: `<div class="fake-q">図書館</div>`,
      answer: `<div class="fake-q">図書館</div><hr><div class="fake-a">toshokan — library</div>`,
      front: "図書館",
    },
  ];
}

/**
 * Lazily seed (once) and return the live fake queue. Seeds from the fake-Anki
 * note map if any cards were added, else from a fixed couple of cards. Once
 * built the SAME array instance is mutated by grading (answerCard splices),
 * so a drained queue stays empty — which lets the client reach its done state
 * on the post-batch refetch (no surprise reseed mid-session).
 */
function fakeQueueEnsure(): ReviewCard[] {
  if (fakeQueue) return fakeQueue;
  const notes = [...fakeCards.values()];
  fakeQueue =
    notes.length > 0
      ? notes.map((c, i) => fakeCardFromNote(c, i))
      : fakeSeedDefaults();
  return fakeQueue;
}

/** Reset the fake review queue + recorded answers (e2e seeding helper).
 *  Also clears any cards mined by other specs (fakeCards), so the queue
 *  rebuilds from the fixed 2-card seed (勉強, 図書館) regardless of run order
 *  — otherwise a mining spec (e.g. wave12 adding 学校) would leave its card at
 *  the head of the re-seeded queue and break the review specs' FRONT_1 head. */
export function fakeResetQueue(): void {
  if (!ankiFake()) return;
  fakeQueue = null;
  fakeAnswers.clear();
  fakeCards.clear();
}

// --- AnkiConnect REMOVED ----------------------------------------------------
//
// The app is fully windowless: every real read/write goes through the DB engine
// (src/lib/ankidb.ts), routed by review.ts's `*Auto` selectors. AnkiConnect
// (localhost:8765) and the remote anki-mcp backend are GONE — the local probe
// (ankiLocalAvailable), the raw client (acRaw), the field-map resolver
// (acFieldMap), the note list/add/delete (acListCards/acAddCard/acDeleteCard),
// the media writer (storeMedia), and the remote proxy (zehntageRequest) have all
// been deleted. What remains in this file is the in-memory FAKE double used only
// under ANKI_FAKE=1 by e2e (review.ts imports it for its fake branches).

/** Subset of an Anki card's fields needed to estimate days-overdue. */
export interface DaysOverdueCard {
  interval: number;
  queue: number;
  mod: number;
}

/**
 * Estimate how many whole days a review card is overdue (>= 0).
 *
 * Anki's `due` column is queue-dependent (a day-number for review cards, but
 * epoch-seconds / position for learn/new), and AnkiConnect doesn't hand us the
 * collection's "today" day-count to subtract against — so decoding `due`
 * directly is ambiguous. Instead we use a queue-independent, self-contained
 * signal: a review card (queue 2) was last reviewed at `mod` (epoch seconds)
 * and its next due moment is `mod + interval*86400`. Days overdue is then
 * `floor((now - nextDue) / 86400)`, clamped to >= 0.
 *
 * Defensive: returns 0 for non-review cards, missing/garbage `mod`/`interval`,
 * or any non-finite result — so an undecidable card behaves like the old
 * interval-proxy (never mis-colored as heavily rotten).
 *
 * @param now epoch MILLISECONDS reference (injectable for tests).
 */
export function decodeDaysOverdue(
  card: DaysOverdueCard,
  now: number = Date.now(),
): number {
  // Only review cards (queue 2) carry an interval-based due date we can trust.
  if (card.queue !== 2) return 0;
  const interval = card.interval;
  const mod = card.mod;
  if (
    typeof interval !== "number" ||
    typeof mod !== "number" ||
    !Number.isFinite(interval) ||
    !Number.isFinite(mod) ||
    interval < 0 ||
    mod <= 0
  ) {
    return 0;
  }
  const DAY_MS = 86_400_000;
  const nextDueMs = mod * 1000 + interval * DAY_MS;
  const overdue = Math.floor((now - nextDueMs) / DAY_MS);
  if (!Number.isFinite(overdue) || overdue < 0) return 0;
  return overdue;
}

// ===========================================================================
// FAKE AnkiConnect test double — review flow (ANKI_FAKE=1, e2e only)
// ===========================================================================
//
// The REAL review flow (queue → reveal → grade → delete) no longer lives here:
// after the Stage 2b cutover review.ts drives all real reads/writes through the
// DB engine and only calls these functions inside its `ANKI_FAKE === "1"`
// branch. So reviewQueue / answerCard / deleteNote below are now FAKE-ONLY: each
// operates purely on the in-memory fake queue/map above. The previous real
// AnkiConnect (localhost:8765) machinery for these — findCards/cardsInfo +
// answerCards + cardsToNotes/deleteNotes, plus the HTML helpers (stripHtml,
// rewriteAnkiMedia), the AcReviewCardInfo shape and queueRank sorter — was dead
// after 2b-1 and has been deleted. DO NOT reintroduce a real branch here; the
// real path is ankidb.ts (dbReviewQueue/dbAnswerCard/dbDeleteNote).
//
// review.ts imports these under ac* aliases (acReviewQueue/acAnswerCard/
// acDeleteNote), so the export NAMES must stay even though the behavior is fake.

export interface ReviewCard {
  cardId: number;
  question: string;
  answer: string;
  front: string;
}

/** FAKE-ONLY: serve the in-memory fake review queue (e2e). */
export async function reviewQueue(
  _scope: "zehntage" | "all",
  limit = 50,
): Promise<{ available: boolean; due: number; cards: ReviewCard[] }> {
  if (!ankiFake()) return { available: false, due: 0, cards: [] };
  // `scope` is honored only insofar as the queue is a single shared deck —
  // the client always asks for "all" now (scope toggle removed).
  const q = fakeQueueEnsure();
  const cards = q.slice(0, limit);
  return { available: true, due: q.length, cards };
}

/** FAKE-ONLY: record the grade and drop the card from the fake queue (e2e). */
export async function answerCard(
  cardId: number,
  ease: 1 | 2 | 3 | 4,
): Promise<{ ok: boolean; error?: string }> {
  if (!ankiFake()) return { ok: false, error: "AnkiConnect not available" };
  // Mirrors how a real grade removes the card from today's due set.
  fakeAnswers.set(cardId, ease);
  const q = fakeQueueEnsure();
  const idx = q.findIndex((c) => c.cardId === cardId);
  if (idx >= 0) q.splice(idx, 1);
  bustListWordsCache();
  return { ok: true };
}

/** FAKE-ONLY: drain the card from the fake queue so the UI advances (e2e). */
export async function deleteNote(
  cardId: number,
): Promise<{ ok: boolean; error?: string }> {
  if (!ankiFake()) return { ok: false, error: "AnkiConnect not available" };
  // The note-map keyed by front is not touched — acceptable for tests; the
  // card just disappears from the review session.
  if (fakeQueue) {
    const idx = fakeQueue.findIndex((c) => c.cardId === cardId);
    if (idx >= 0) fakeQueue.splice(idx, 1);
  }
  bustListWordsCache();
  return { ok: true };
}

// bustListWordsCache is retained as a no-op-safe cache buster: the real list
// path is now windowless (dbListCards, separately cached in the server), but the
// server still calls this to invalidate after a mutation. There's no longer an
// AnkiConnect list cache to clear here (fake mode reads the live map directly).
export function bustListWordsCache(): void {
  /* no AnkiConnect list cache anymore — fake mode reads the live map. */
}

/**
 * FAKE-ONLY: return the in-memory fake note map (e2e). The real list path is
 * windowless (review.ts listAuto → ankidb dbListCards); this is only reached via
 * review.ts's ANKI_FAKE branch (acListWords dep). Empty when ANKI_FAKE unset.
 */
export async function listWords(): Promise<AnkiCard[]> {
  if (!ankiFake()) return [];
  // Fake mode reads a mutable in-memory map directly — never cache it.
  return [...fakeCards.values()];
}

/**
 * FAKE-ONLY: progress map for token coloring (e2e). The real per-word
 * scheduling/progress now comes from ankidb.ts (dbProgress), routed by
 * review.ts's progressAuto; this fake branch (returns {}) is all that's left.
 */
export async function getProgress(): Promise<Record<string, number> | null> {
  if (ankiFake()) return {};
  return null;
}

/**
 * FAKE-ONLY: add a card to the in-memory fake note map (e2e). The real add path
 * is windowless (review.ts addNoteAuto → ankidb dbAddNote); this is only reached
 * via review.ts's ANKI_FAKE branch (acAddCard dep). No-op when ANKI_FAKE unset.
 */
export async function addCard(card: AnkiCard): Promise<void> {
  if (!ankiFake()) return;
  // Mirror the real anki-mcp behavior: an `image` renders as an <img> tag
  // inside the target field (the Cards tab filters on this).
  const stored = { ...card };
  if (stored.image && stored.image_field === "context") {
    stored.context = [stored.context, `<img src="${stored.image}">`]
      .filter(Boolean)
      .join("<br>");
  }
  fakeCards.set(card.front, stored);
}

/**
 * FAKE-ONLY: remove a card from the in-memory fake note map by front (e2e). The
 * real un-mine path is windowless (review.ts deleteNoteByFrontAuto → ankidb
 * dbDeleteNoteByFront); this is only reached via review.ts's ANKI_FAKE branch
 * (acDeleteCardByFront dep). No-op when ANKI_FAKE unset.
 */
export async function deleteCard(front: string): Promise<void> {
  if (!ankiFake()) return;
  fakeCards.delete(front);
}
