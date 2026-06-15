// ---------------------------------------------------------------------------
// Backend selector facade for the review engine (Stage 2b-1: DB-DIRECT ONLY).
//
// The app is now fully windowless: the real backend is ALWAYS the DB-direct
// engine (src/lib/ankidb.ts). AnkiConnect (localhost:8765) is NO LONGER CALLED
// for any real read or write — the user closes Anki and we read/write the
// collection.anki2 on disk directly.
//
// Routing for every `*Auto` function is now:
//   - ANKI_FAKE=1   → the in-memory fake (e2e/test double; NOT AnkiConnect).
//                     This branch MUST stay or all e2e breaks.
//   - else (real)   → DB-direct (ankidb.ts).
//
// Reads (queue/counts/list/progress/media) use the DB readers unconditionally.
// While Anki is open the on-disk snapshot may lag — acceptable and safe.
//
// Writes (answer/delete/add) use the DB write paths unconditionally. They
// already FAIL-CLOSED (reason like "anki-open"/"locked") when Anki holds the
// collection, so grading/adding while Anki is open is safely REFUSED (no
// corruption, no infinite loop because no write occurs).
//
// This file owns the selector only. It still imports a few anki.ts symbols for
// the ANKI_FAKE fake branch and for shared types, but it never routes a real
// request to AnkiConnect. The AnkiConnect functions in anki.ts are retained
// (later shrink step) — just no longer called here.
// ---------------------------------------------------------------------------

import {
  reviewQueue as acReviewQueue,
  answerCard as acAnswerCard,
  deleteNote as acDeleteNote,
  addCard as acAddCard,
  listWords as acListWords,
  getProgress as acGetProgress,
  type AnkiCard,
  type ReviewCard,
} from "./anki.ts";
import {
  dbStatus,
  dbReviewQueue,
  dbDeckCounts,
  dbAnswerCard,
  dbDeleteNote,
  dbAddNote,
  dbListCards,
  dbProgress,
  dbGetMedia,
  type DeckCounts,
  type DbMediaResult,
} from "./ankidb.ts";

export type ReviewScope = "zehntage" | "all";
export type ReviewBackend = "db" | "ankiconnect";

// In e2e/fake mode (ANKI_FAKE=1) we must NOT read the user's real
// collection.anki2 — tests run against the in-memory fake AnkiConnect. Gating
// the DB-direct path here keeps fake mode hermetic (and the offline-state e2e
// deterministic).
const dbDirectEnabled = (): boolean => process.env.ANKI_FAKE !== "1";

// ---------------------------------------------------------------------------
// Test seam (internal). The routing in this file depends on concrete functions
// from anki.ts (fake branch only) / ankidb.ts (real path). We can't unit-test
// the routing via env alone (ANKI_FAKE forces every dep into fake mode at
// once), and mock.module() in bun patches the GLOBAL module registry for the
// whole test run without restore — it would corrupt anki.test.ts /
// ankidb.test.ts which import these modules for real. So we expose a tiny
// overridable indirection table: production code calls through `deps`, which
// points at the real imports by default; `__setReviewDeps` (test-only) swaps
// them and returns a restore fn. Public signatures/behavior are unchanged.
//
// The `ac*` deps are used ONLY by the ANKI_FAKE fake branch now — never for a
// real AnkiConnect call.
interface ReviewDeps {
  acReviewQueue: typeof acReviewQueue;
  acAnswerCard: typeof acAnswerCard;
  acDeleteNote: typeof acDeleteNote;
  acAddCard: typeof acAddCard;
  dbStatus: typeof dbStatus;
  dbReviewQueue: typeof dbReviewQueue;
  dbDeckCounts: typeof dbDeckCounts;
  dbAnswerCard: typeof dbAnswerCard;
  dbDeleteNote: typeof dbDeleteNote;
  dbAddNote: typeof dbAddNote;
  acListWords: typeof acListWords;
  acGetProgress: typeof acGetProgress;
  dbListCards: typeof dbListCards;
  dbProgress: typeof dbProgress;
  dbGetMedia: typeof dbGetMedia;
}

const realDeps: ReviewDeps = {
  acReviewQueue,
  acAnswerCard,
  acDeleteNote,
  acAddCard,
  dbStatus,
  dbReviewQueue,
  dbDeckCounts,
  dbAnswerCard,
  dbDeleteNote,
  dbAddNote,
  acListWords,
  acGetProgress,
  dbListCards,
  dbProgress,
  dbGetMedia,
};

let deps: ReviewDeps = realDeps;

/**
 * TEST-ONLY. Override the backend dependencies and return a restore function.
 * Not part of the public API; do not call from production code.
 */
export function __setReviewDeps(overrides: Partial<ReviewDeps>): () => void {
  const prev = deps;
  deps = { ...deps, ...overrides };
  return () => {
    deps = prev;
  };
}

/**
 * Refusal reason surfaced when grading cannot proceed.
 *
 * `no-backend` — the DB write path is unavailable (fake mode / DB-direct
 * disabled). Reasons such as "anki-open" / "locked" are forwarded verbatim
 * from `dbAnswerCard` when Anki is holding the collection.
 */
export type RefuseReason = "no-backend" | (string & {});

export interface ReviewQueueResult {
  available: boolean;
  due: number;
  cards: ReviewCard[];
  /** Informational only — the server strips this before replying. */
  backend: ReviewBackend;
}

export interface AnswerResult {
  ok: boolean;
  error?: string;
  reason?: RefuseReason;
  /** Informational only — the server strips this before replying. */
  backend: ReviewBackend;
}

export interface DeleteResult {
  ok: boolean;
  error?: string;
  reason?: RefuseReason;
  /** Informational only — the server strips this before replying. */
  backend: ReviewBackend;
}

export interface DeckCountsResult {
  new: number;
  learning: number;
  review: number;
}

export interface AddResult {
  ok: boolean;
  error?: string;
  reason?: RefuseReason;
  /** Informational only — the server strips this before replying. */
  backend: ReviewBackend;
}

export interface ReviewStatus {
  /** collection.anki2 exists and a schema version could be read. */
  dbPresent: boolean;
  /** Anki appears to be running / holding the DB. */
  ankiOpen: boolean;
  /** col.ver is a version the DB engine understands. */
  schemaOk: boolean;
  /** A queue can be produced from the DB (present + schema understood). */
  canQueue: boolean;
  /** A grade can be written back windowless (DB-direct, present, schema, Anki closed). */
  canAnswer: boolean;
}

/**
 * Review queue for a scope, windowless (DB-direct only).
 *
 * Reads the read-only DB snapshot unconditionally. While Anki is open the
 * on-disk file may lag (Anki buffers edits in WAL) — that's acceptable and
 * safe, because grading then fails-closed at the write step (see
 * `answerCardAuto`), so no graded card is lost and no infinite loop occurs.
 * `backend` is informational and stripped by the server before the wire.
 */
export async function reviewQueueAuto(
  scope: ReviewScope = "zehntage",
  limit = 50,
): Promise<ReviewQueueResult> {
  // Fake/e2e mode: serve the in-memory fake queue (NOT AnkiConnect — its fake
  // branch is fully offline). This branch MUST stay or all review e2e breaks.
  if (process.env.ANKI_FAKE === "1") {
    const r = await deps.acReviewQueue(scope, limit);
    return {
      available: r.available,
      due: r.due,
      cards: r.cards,
      backend: "ankiconnect",
    };
  }

  // Real path: read the read-only DB snapshot. No AnkiConnect fallback.
  try {
    const st = deps.dbStatus();
    if (dbDirectEnabled() && st.present && st.schemaOk) {
      const r = deps.dbReviewQueue(scope, limit);
      if (r.available) {
        return { available: true, due: r.due, cards: r.cards, backend: "db" };
      }
    }
  } catch {
    // fall through to unavailable
  }

  // DB unavailable (collection absent/unreadable/unsupported, or an empty
  // snapshot). There is no AnkiConnect fallback anymore.
  return { available: false, due: 0, cards: [], backend: "db" };
}

/**
 * Due counts {new, learning, review}, windowless (DB-direct only).
 *
 * Reads the DB snapshot unconditionally. Returns zeros when the DB is
 * unavailable (fake mode / absent / unreadable) so callers always get a
 * well-shaped object. No AnkiConnect fallback.
 */
export async function deckCountsAuto(
  scope: ReviewScope = "zehntage",
): Promise<DeckCountsResult> {
  // Fake/e2e mode: derive counts from the in-memory fake queue (review-only
  // signal; the fake has no new/learning split). Surfaces the due total under
  // `review`. This branch MUST stay or review-count e2e breaks.
  if (process.env.ANKI_FAKE === "1") {
    try {
      const q = await deps.acReviewQueue(scope, 0);
      if (q.available) return { new: 0, learning: 0, review: q.due };
    } catch {
      // fall through to zeros
    }
    return { new: 0, learning: 0, review: 0 };
  }

  // Real path: read the DB snapshot. No AnkiConnect fallback.
  try {
    const st = deps.dbStatus();
    if (dbDirectEnabled() && st.present && st.schemaOk) {
      const c: DeckCounts = deps.dbDeckCounts(scope);
      return { new: c.new, learning: c.learning, review: c.review };
    }
  } catch {
    // fall through to zeros
  }

  return { new: 0, learning: 0, review: 0 };
}

/**
 * Grade a card, windowless (DB-direct only).
 *
 *   - ANKI_FAKE=1 → the in-memory fake (records the grade, drains the fake
 *     queue). Never touches the real collection or the DB write.
 *   - else → `dbAnswerCard`, the gated, backup-first, fail-closed DB write.
 *     ankidb performs its own safety checks (Anki not running, schema
 *     understood, backup taken) and is the authority on whether the write may
 *     proceed; we forward its {ok, error?, reason?} verbatim. When Anki is open
 *     it refuses (e.g. reason "anki-open"/"locked") — grading is safely blocked,
 *     no corruption, no infinite loop (no write occurs).
 *   - DB-direct disabled (fake mode) → refuse with {ok:false, reason:"no-backend"}.
 */
export async function answerCardAuto(
  cardId: number,
  ease: 1 | 2 | 3 | 4,
): Promise<AnswerResult> {
  // Fake/e2e mode: route to the in-memory fake (NOT AnkiConnect). Never touches
  // the real collection or the DB write.
  if (process.env.ANKI_FAKE === "1") {
    const r = await deps.acAnswerCard(cardId, ease);
    return { ok: r.ok, error: r.error, backend: "ankiconnect" };
  }

  // Real path: windowless DB write. dbAnswerCard fails-closed when Anki holds
  // the collection, so grading while Anki is open is safely refused.
  if (dbDirectEnabled()) {
    try {
      // `await` tolerates either a sync result or a Promise, so this stays
      // correct regardless of how ankidb finalizes dbAnswerCard's signature.
      const r = await deps.dbAnswerCard(cardId, ease);
      return {
        ok: r.ok,
        error: r.error,
        reason: r.reason,
        backend: "db",
      };
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        reason: "db-write-threw",
        backend: "db",
      };
    }
  }

  // DB-direct disabled (fake mode without the fake branch — unreachable in
  // practice) → no backend.
  return {
    ok: false,
    error: "No grading backend available",
    reason: "no-backend",
    backend: "db",
  };
}

/**
 * Delete a note from Anki, windowless (DB-direct only). Same routing shape as
 * `answerCardAuto`:
 *
 *   - ANKI_FAKE=1 → call the fake delete stub (graceful: ok:true if the stub
 *     doesn't implement deleteNotes).
 *   - else → `dbDeleteNote`, the gated, backup-first, fail-closed windowless DB
 *     write. ankidb performs all safety checks and refuses when Anki is open.
 *   - DB-direct disabled → refuse with {ok:false, reason:"no-backend"}.
 */
export async function deleteNoteAuto(cardId: number): Promise<DeleteResult> {
  // Fake/e2e mode: call the fake delete stub; never touch the real collection.
  if (process.env.ANKI_FAKE === "1") {
    try {
      const r = await deps.acDeleteNote(cardId);
      return { ok: r.ok, error: r.error, backend: "ankiconnect" };
    } catch {
      // If the fake stub doesn't implement deleteNotes, treat as ok (e2e can
      // stub the whole function via __setReviewDeps if it needs assertions).
      return { ok: true, backend: "ankiconnect" };
    }
  }

  // Real path: windowless DB write. dbDeleteNote fails-closed when Anki is open.
  if (dbDirectEnabled()) {
    try {
      const r = await deps.dbDeleteNote(cardId);
      return {
        ok: r.ok,
        error: r.error,
        reason: r.reason,
        backend: "db",
      };
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        reason: "db-write-threw",
        backend: "db",
      };
    }
  }

  // DB-direct disabled → no backend.
  return {
    ok: false,
    error: "No delete backend available",
    reason: "no-backend",
    backend: "db",
  };
}

/**
 * Add a note (mine a card), windowless (DB-direct only). Mirrors answerCardAuto:
 *
 *   - ANKI_FAKE=1 → route to the in-memory fake add (acAddCard's fake branch).
 *     Never touches the real collection or the DB write.
 *   - else → `dbAddNote`, the gated, backup-first, fail-closed windowless DB
 *     write. Media for the windowless path (audio via dbStoreMedia, images
 *     inline as data:URI) is handled by the caller BEFORE this routes, so the
 *     card here already carries the final field text. dbAddNote refuses when
 *     Anki is open.
 *   - DB-direct disabled → refuse with {ok:false, reason:"no-backend"}.
 */
export async function addNoteAuto(card: AnkiCard): Promise<AddResult> {
  // Fake/e2e mode: route to the in-memory fake add.
  if (process.env.ANKI_FAKE === "1") {
    try {
      await deps.acAddCard(card);
      return { ok: true, backend: "ankiconnect" };
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        reason: "fake-add-threw",
        backend: "ankiconnect",
      };
    }
  }

  // Real path: windowless DB write. dbAddNote fails-closed when Anki is open.
  if (dbDirectEnabled()) {
    try {
      const r = await deps.dbAddNote({
        front: card.front,
        back: card.back,
        notes: typeof card.notes === "string" ? card.notes : "",
        context: typeof card.context === "string" ? card.context : "",
        tags: Array.isArray(card.tags) ? card.tags : ["zehntage"],
      });
      return {
        ok: r.ok,
        error: r.error,
        reason: r.reason,
        backend: "db",
      };
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        reason: "db-write-threw",
        backend: "db",
      };
    }
  }

  // DB-direct disabled → no backend.
  return {
    ok: false,
    error: "No add backend available",
    reason: "no-backend",
    backend: "db",
  };
}

/**
 * List the Mixed-deck cards for the Cards tab, windowless (DB-direct only).
 *
 *   - ANKI_FAKE=1 → existing fake (acListWords reads the in-memory fake map).
 *   - else → dbListCards (read-only DB snapshot).
 *
 * Returns AnkiCard[] in the SAME shape both paths produce
 * ({front, back, notes, context, noteId, tags}). On any DB failure it returns
 * what dbListCards returns ([]) rather than throwing.
 */
export async function listCardsAuto(): Promise<AnkiCard[]> {
  if (process.env.ANKI_FAKE === "1") {
    return deps.acListWords();
  }
  // Real path: windowless DB read.
  if (dbDirectEnabled()) {
    const cards = deps.dbListCards("all");
    return cards.map((c): AnkiCard => ({
      front: c.front,
      back: c.back,
      notes: c.notes,
      context: c.context,
      noteId: c.noteId,
      tags: c.tags,
    }));
  }
  return [];
}

/**
 * Per-word scheduling/progress map for token coloring, windowless (DB-direct).
 *
 *   - ANKI_FAKE=1 → existing fake (acGetProgress returns {}).
 *   - else → dbProgress (read-only DB snapshot).
 *
 * The returned map is keyed identically (by the raw `front` field value) and
 * each entry carries the SAME fields acProgress emits
 * ({interval,due,reps,lapses,ease,queue,type,isDue,daysOverdue}). Returns {} on
 * failure / when no backend is available.
 */
export async function progressAuto(): Promise<Record<string, unknown> | null> {
  if (process.env.ANKI_FAKE === "1") {
    return deps.acGetProgress();
  }
  // Real path: windowless DB read.
  if (dbDirectEnabled()) {
    return deps.dbProgress("all") as Record<string, unknown>;
  }
  return {};
}

/**
 * Read a media file's bytes for the /api/anki/media proxy, windowless (DB-direct).
 *
 *   - ANKI_FAKE=1 → null (no media in fake mode; mirrors retrieveMedia).
 *   - else → dbGetMedia (reads collection.media/ on disk; returns bytes +
 *     content-type).
 *
 * Returns { bytes, contentType? } or null on miss (graceful). The server
 * applies its own content-type map, so contentType here is advisory.
 */
export async function mediaAuto(
  filename: string,
): Promise<{ bytes: Uint8Array; contentType?: string } | null> {
  if (process.env.ANKI_FAKE === "1") return null;
  // Real path: windowless DB media read.
  if (dbDirectEnabled()) {
    const r: DbMediaResult | null = deps.dbGetMedia(filename);
    return r ? { bytes: r.bytes, contentType: r.contentType } : null;
  }
  return null;
}

/**
 * Combined read/write capability snapshot for the UI (DB-direct only).
 *
 * `canQueue` is true when the on-disk collection can produce a queue
 * (present + schema understood) — reads work even while Anki is open (the
 * snapshot may lag, which is acceptable). `canAnswer` is true only for the
 * windowless DB write: DB-direct enabled (not fake mode) + collection present +
 * schema understood + Anki CLOSED. `ankiOpen` is retained so the UI can tell
 * the user to close Anki to sync/review windowlessly. AnkiConnect is no longer
 * consulted.
 */
export async function reviewStatus(): Promise<ReviewStatus> {
  let dbPresent = false;
  let ankiOpen = false;
  let schemaOk = false;
  try {
    const st = deps.dbStatus();
    dbPresent = st.present;
    ankiOpen = st.ankiOpen;
    schemaOk = st.schemaOk;
  } catch {
    // leave defaults
  }

  const canQueue = dbPresent && schemaOk;
  // Windowless DB write is usable when Anki is closed, the collection is
  // present with an understood schema, and we are not in fake mode.
  const canAnswer = dbDirectEnabled() && dbPresent && schemaOk && !ankiOpen;
  return { dbPresent, ankiOpen, schemaOk, canQueue, canAnswer };
}
