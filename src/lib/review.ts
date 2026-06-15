// ---------------------------------------------------------------------------
// Backend selector facade for the review engine (Wave 18, read path).
//
// Goal: serve the review *queue* and *counts* even when the Anki GUI window is
// CLOSED, by reading the collection DB directly (read-only, snapshot-safe — see
// src/lib/ankidb.ts). When the DB is absent or unreadable, fall back to the
// existing AnkiConnect path (which requires Anki to be open).
//
// Write-back routing (`answerCardAuto`):
//   - Anki OPEN  → route to AnkiConnect `answerCard`. The live scheduler is
//     authoritative while the GUI holds the collection.
//   - Anki CLOSED → route to `dbAnswerCard` (src/lib/ankidb.ts), the gated,
//     backup-first, fail-closed windowless DB write. We rely on ankidb's own
//     guards (Anki not running, schema understood, backup taken) to stay safe.
//   - Neither    → refuse with a well-shaped {ok:false} result.
//
// This file owns the selector only. It imports anki.ts and ankidb.ts but keeps
// them ignorant of each other; it does not modify either.
// ---------------------------------------------------------------------------

import {
  reviewQueue as acReviewQueue,
  answerCard as acAnswerCard,
  deleteNote as acDeleteNote,
  addCard as acAddCard,
  ankiLocalAvailable,
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
  type DeckCounts,
} from "./ankidb.ts";

export type ReviewScope = "zehntage" | "all";
export type ReviewBackend = "db" | "ankiconnect";

// In e2e/fake mode (ANKI_FAKE=1) we must NOT read the user's real
// collection.anki2 — tests run against the in-memory fake AnkiConnect. Gating
// the DB-direct path here keeps fake mode hermetic (and the offline-state e2e
// deterministic).
const dbDirectEnabled = (): boolean => process.env.ANKI_FAKE !== "1";

// ---------------------------------------------------------------------------
// Test seam (internal). The routing in this file depends on five concrete
// functions from anki.ts / ankidb.ts. We can't unit-test the DB-vs-AnkiConnect
// branch via env alone (ANKI_FAKE forces every dep into fake mode at once), and
// mock.module() in bun patches the GLOBAL module registry for the whole test
// run without restore — it would corrupt anki.test.ts / ankidb.test.ts which
// import these modules for real. So we expose a tiny overridable indirection
// table: production code calls through `deps`, which points at the real imports
// by default; `__setReviewDeps` (test-only) swaps them and returns a restore fn.
// Public function signatures and default behavior are unchanged.
interface ReviewDeps {
  acReviewQueue: typeof acReviewQueue;
  acAnswerCard: typeof acAnswerCard;
  acDeleteNote: typeof acDeleteNote;
  acAddCard: typeof acAddCard;
  ankiLocalAvailable: typeof ankiLocalAvailable;
  dbStatus: typeof dbStatus;
  dbReviewQueue: typeof dbReviewQueue;
  dbDeckCounts: typeof dbDeckCounts;
  dbAnswerCard: typeof dbAnswerCard;
  dbDeleteNote: typeof dbDeleteNote;
  dbAddNote: typeof dbAddNote;
}

const realDeps: ReviewDeps = {
  acReviewQueue,
  acAnswerCard,
  acDeleteNote,
  acAddCard,
  ankiLocalAvailable,
  dbStatus,
  dbReviewQueue,
  dbDeckCounts,
  dbAnswerCard,
  dbDeleteNote,
  dbAddNote,
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
 * `no-backend` — neither AnkiConnect nor the DB write path is available
 * (Anki closed AND the collection is absent/unreadable/unsupported). Reasons
 * other than these may also be forwarded verbatim from `dbAnswerCard`.
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
  /** A queue can be produced (DB read or AnkiConnect). */
  canQueue: boolean;
  /** A grade can be written back (AnkiConnect, or windowless DB write). */
  canAnswer: boolean;
}

/**
 * Review queue for a scope, windowless-capable.
 *
 * Prefers the DB-direct engine: if the collection is present AND its schema is
 * understood, `dbReviewQueue` reads a read-only snapshot that works even while
 * Anki is open. If that read is unavailable or fails (returns available:false,
 * or throws), fall back to AnkiConnect. The returned shape is identical to the
 * AnkiConnect path; `backend` is added for logging and is stripped by the
 * server before it hits the wire.
 */
export async function reviewQueueAuto(
  scope: ReviewScope = "zehntage",
  limit = 50,
): Promise<ReviewQueueResult> {
  // Try the windowless DB read first.
  try {
    const st = deps.dbStatus();
    // Use the DB-direct snapshot ONLY when Anki is CLOSED. While Anki is open it
    // holds edits in memory (WAL), so the on-disk file lags AnkiConnect's live
    // state — reading the snapshot then grading via AnkiConnect makes graded
    // cards reappear (an infinite review loop). When Anki is open, AnkiConnect is
    // authoritative for BOTH read and write.
    if (dbDirectEnabled() && st.present && st.schemaOk && !st.ankiOpen) {
      const r = deps.dbReviewQueue(scope, limit);
      if (r.available) {
        return { available: true, due: r.due, cards: r.cards, backend: "db" };
      }
    }
  } catch {
    // fall through to AnkiConnect
  }

  // Fallback: AnkiConnect (requires Anki open).
  const r = await deps.acReviewQueue(scope, limit);
  return {
    available: r.available,
    due: r.due,
    cards: r.cards,
    backend: "ankiconnect",
  };
}

/**
 * Due counts {new, learning, review}, windowless-capable.
 *
 * Prefers the DB-direct engine. On failure, falls back to AnkiConnect-derived
 * counts; if even that is unreachable, returns zeros so callers always get a
 * well-shaped object.
 */
export async function deckCountsAuto(
  scope: ReviewScope = "zehntage",
): Promise<DeckCountsResult> {
  // Try the windowless DB read first.
  try {
    const st = deps.dbStatus();
    // Use the DB-direct snapshot ONLY when Anki is CLOSED. While Anki is open it
    // holds edits in memory (WAL), so the on-disk file lags AnkiConnect's live
    // state — reading the snapshot then grading via AnkiConnect makes graded
    // cards reappear (an infinite review loop). When Anki is open, AnkiConnect is
    // authoritative for BOTH read and write.
    if (dbDirectEnabled() && st.present && st.schemaOk && !st.ankiOpen) {
      const c: DeckCounts = deps.dbDeckCounts(scope);
      return { new: c.new, learning: c.learning, review: c.review };
    }
  } catch {
    // fall through to AnkiConnect
  }

  // Fallback: derive counts from the AnkiConnect queue (review-only signal).
  // AnkiConnect's `is:due` queue does not distinguish new/learning/review
  // cheaply, so we surface the due total under `review` and leave the rest at 0
  // rather than fabricating a breakdown.
  try {
    const q = await deps.acReviewQueue(scope, 0);
    if (q.available) {
      return { new: 0, learning: 0, review: q.due };
    }
  } catch {
    // fall through to zeros
  }

  return { new: 0, learning: 0, review: 0 };
}

/**
 * Grade a card, windowless-capable.
 *
 *   - Anki OPEN (AnkiConnect reachable) → route to AnkiConnect `answerCard`.
 *     The live scheduler owns the collection while the GUI is up.
 *   - Anki CLOSED → route to `dbAnswerCard`, the gated, backup-first,
 *     fail-closed DB write. ankidb performs its own safety checks (Anki not
 *     running, schema understood, backup taken) and is the authority on whether
 *     the write may proceed; we forward its {ok, error?, reason?} verbatim.
 *   - Neither    → refuse with {ok:false, reason:"no-backend"}.
 *
 * The DB-write path is suppressed in fake mode (ANKI_FAKE=1) so e2e never
 * touches the real collection.anki2.
 */
export async function answerCardAuto(
  cardId: number,
  ease: 1 | 2 | 3 | 4,
): Promise<AnswerResult> {
  // Fake/e2e mode: route to the in-memory fake AnkiConnect (records the grade,
  // drains the fake queue). Never touches the real collection or the DB write.
  if (process.env.ANKI_FAKE === "1") {
    const r = await deps.acAnswerCard(cardId, ease);
    return { ok: r.ok, error: r.error, backend: "ankiconnect" };
  }
  // Is Anki up? If so, AnkiConnect is authoritative.
  let ankiConnectUp = false;
  try {
    ankiConnectUp = await deps.ankiLocalAvailable();
  } catch {
    ankiConnectUp = false;
  }

  if (ankiConnectUp) {
    const r = await deps.acAnswerCard(cardId, ease);
    if (r.ok) {
      return { ok: true, backend: "ankiconnect" };
    }
    // Surface a CLEAR reason so the UI never silently loops on a failed grade.
    return {
      ok: false,
      error: r.error ?? "AnkiConnect not available",
      reason: "ankiconnect-failed",
      backend: "ankiconnect",
    };
  }

  // Anki closed → windowless DB write (unless fake mode, which must not write).
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

  // No backend available (Anki closed and DB-direct disabled/unavailable).
  return {
    ok: false,
    error: "No grading backend available (Anki closed)",
    reason: "no-backend",
    backend: "ankiconnect",
  };
}

/**
 * Delete a note from Anki, windowless-capable. Same routing shape as
 * `answerCardAuto`:
 *
 *   - ANKI_FAKE=1 → call the fake delete on the in-memory stub (always ok:true
 *     if the stub doesn't implement deleteNotes; graceful).
 *   - Anki OPEN (AnkiConnect reachable) → AnkiConnect: map card→note via
 *     `cardsToNotes`, then `deleteNotes`. The live collection is authoritative.
 *   - Anki CLOSED → `dbDeleteNote`, the gated, backup-first, fail-closed
 *     windowless DB write. ankidb performs all safety checks.
 *   - Neither → refuse with {ok:false, reason:"no-backend"}.
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

  // Is Anki up? If so, AnkiConnect is authoritative.
  let ankiConnectUp = false;
  try {
    ankiConnectUp = await deps.ankiLocalAvailable();
  } catch {
    ankiConnectUp = false;
  }

  if (ankiConnectUp) {
    const r = await deps.acDeleteNote(cardId);
    if (r.ok) {
      return { ok: true, backend: "ankiconnect" };
    }
    return {
      ok: false,
      error: r.error ?? "AnkiConnect delete failed",
      reason: "ankiconnect-failed",
      backend: "ankiconnect",
    };
  }

  // Anki closed → windowless DB write (unless fake mode, which must not write).
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

  // No backend available.
  return {
    ok: false,
    error: "No delete backend available (Anki closed)",
    reason: "no-backend",
    backend: "ankiconnect",
  };
}

/**
 * Add a note (mine a card), windowless-capable. Mirrors answerCardAuto routing:
 *
 *   - ANKI_FAKE=1 → route to the in-memory fake add (acAddCard's fake branch).
 *     Never touches the real collection or the DB write.
 *   - Anki OPEN (AnkiConnect reachable) → AnkiConnect `addCard` (UNCHANGED). The
 *     live collection is authoritative; media was already stored via storeMedia
 *     and inlined into `card.context` by the caller.
 *   - Anki CLOSED → `dbAddNote`, the gated, backup-first, fail-closed windowless
 *     DB write. Media for the closed path (audio via dbStoreMedia, images inline
 *     as data:URI) is handled by the caller BEFORE this routes, so the card here
 *     already carries the final field text.
 *   - Neither → refuse with {ok:false, reason:"no-backend"}.
 *
 * The DB-write path is suppressed in fake mode (ANKI_FAKE=1).
 */
export async function addNoteAuto(card: AnkiCard): Promise<AddResult> {
  // Fake/e2e mode: route to the in-memory fake AnkiConnect add.
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

  // Is Anki up? If so, AnkiConnect is authoritative (UNCHANGED path).
  let ankiConnectUp = false;
  try {
    ankiConnectUp = await deps.ankiLocalAvailable();
  } catch {
    ankiConnectUp = false;
  }

  if (ankiConnectUp) {
    try {
      await deps.acAddCard(card);
      return { ok: true, backend: "ankiconnect" };
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        reason: "ankiconnect-failed",
        backend: "ankiconnect",
      };
    }
  }

  // Anki closed → windowless DB write (unless fake mode, which must not write).
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

  // No backend available (Anki closed and DB-direct disabled/unavailable).
  return {
    ok: false,
    error: "No add backend available (Anki closed)",
    reason: "no-backend",
    backend: "ankiconnect",
  };
}

/**
 * Combined read/write capability snapshot for the UI.
 *
 * `canQueue` is true when either the DB read or AnkiConnect can produce a
 * queue. `canAnswer` is true when EITHER AnkiConnect is reachable (Anki open)
 * OR the DB write path is usable (Anki closed + collection present + schema
 * understood) — grading now works windowless. The DB write path is gated off
 * in fake mode (ANKI_FAKE=1).
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

  let ankiConnectUp = false;
  try {
    ankiConnectUp = await deps.ankiLocalAvailable();
  } catch {
    ankiConnectUp = false;
  }

  const canQueue = (dbPresent && schemaOk) || ankiConnectUp;
  // Windowless DB write is usable when Anki is closed, the collection is
  // present with an understood schema, and we are not in fake mode.
  const dbWritable = dbDirectEnabled() && dbPresent && schemaOk && !ankiOpen;
  const canAnswer = ankiConnectUp || dbWritable;
  return { dbPresent, ankiOpen, schemaOk, canQueue, canAnswer };
}
