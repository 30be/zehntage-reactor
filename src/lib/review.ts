// ---------------------------------------------------------------------------
// Backend selector facade for the review engine (Wave 18, read path).
//
// Goal: serve the review *queue* and *counts* even when the Anki GUI window is
// CLOSED, by reading the collection DB directly (read-only, snapshot-safe — see
// src/lib/ankidb.ts). When the DB is absent or unreadable, fall back to the
// existing AnkiConnect path (which requires Anki to be open).
//
// IMPORTANT — refuse-to-write contract:
//   This module performs NO writes to the user's collection. The answer
//   write-back (`answerCardAuto`) routes ONLY to AnkiConnect. There is NO
//   DB-write path here; DB write-back is a separate, future, approval-gated
//   task. We never touch collection.anki2 for writes.
//
// This file owns the selector only. It imports anki.ts and ankidb.ts but keeps
// them ignorant of each other; it does not modify either.
// ---------------------------------------------------------------------------

import {
  reviewQueue as acReviewQueue,
  answerCard as acAnswerCard,
  ankiLocalAvailable,
  type ReviewCard,
} from "./anki.ts";
import {
  dbStatus,
  dbReviewQueue,
  dbDeckCounts,
  type DeckCounts,
} from "./ankidb.ts";

export type ReviewScope = "zehntage" | "all";
export type ReviewBackend = "db" | "ankiconnect";

// In e2e/fake mode (ANKI_FAKE=1) we must NOT read the user's real
// collection.anki2 — tests run against the in-memory fake AnkiConnect. Gating
// the DB-direct path here keeps fake mode hermetic (and the offline-state e2e
// deterministic).
const dbDirectEnabled = (): boolean => process.env.ANKI_FAKE !== "1";

/** Refusal reason surfaced when grading cannot proceed. */
export type RefuseReason = "anki-closed-db-write-not-enabled";

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

export interface DeckCountsResult {
  new: number;
  learning: number;
  review: number;
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
  /** A grade can be written back (AnkiConnect only, for now). */
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
    const st = dbStatus();
    if (dbDirectEnabled() && st.present && st.schemaOk) {
      const r = dbReviewQueue(scope, limit);
      if (r.available) {
        return { available: true, due: r.due, cards: r.cards, backend: "db" };
      }
    }
  } catch {
    // fall through to AnkiConnect
  }

  // Fallback: AnkiConnect (requires Anki open).
  const r = await acReviewQueue(scope, limit);
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
    const st = dbStatus();
    if (dbDirectEnabled() && st.present && st.schemaOk) {
      const c: DeckCounts = dbDeckCounts(scope);
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
    const q = await acReviewQueue(scope, 0);
    if (q.available) {
      return { new: 0, learning: 0, review: q.due };
    }
  } catch {
    // fall through to zeros
  }

  return { new: 0, learning: 0, review: 0 };
}

/**
 * Grade a card. For now this routes ONLY to AnkiConnect (the working path).
 *
 * No DB-write path exists: if AnkiConnect is unavailable (Anki closed), we
 * return a refusal — we do NOT write to the collection. DB write-back is a
 * deferred, approval-gated task.
 */
export async function answerCardAuto(
  cardId: number,
  ease: 1 | 2 | 3 | 4,
): Promise<AnswerResult> {
  const r = await acAnswerCard(cardId, ease);
  if (r.ok) {
    return { ok: true, backend: "ankiconnect" };
  }
  // AnkiConnect refused/unavailable. We do NOT fall back to a DB write.
  return {
    ok: false,
    error: r.error ?? "AnkiConnect not available",
    reason: "anki-closed-db-write-not-enabled",
    backend: "ankiconnect",
  };
}

/**
 * Combined read/write capability snapshot for the UI.
 *
 * `canQueue` is true when either the DB read or AnkiConnect can produce a
 * queue. `canAnswer` is true only when AnkiConnect is reachable (the sole
 * write path today).
 */
export async function reviewStatus(): Promise<ReviewStatus> {
  let dbPresent = false;
  let ankiOpen = false;
  let schemaOk = false;
  try {
    const st = dbStatus();
    dbPresent = st.present;
    ankiOpen = st.ankiOpen;
    schemaOk = st.schemaOk;
  } catch {
    // leave defaults
  }

  let ankiConnectUp = false;
  try {
    ankiConnectUp = await ankiLocalAvailable();
  } catch {
    ankiConnectUp = false;
  }

  const canQueue = (dbPresent && schemaOk) || ankiConnectUp;
  const canAnswer = ankiConnectUp; // AnkiConnect-only write path for now
  return { dbPresent, ankiOpen, schemaOk, canQueue, canAnswer };
}
