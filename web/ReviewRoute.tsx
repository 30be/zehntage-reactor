// #/review — Flashcard Review: a no-typing, hotkey-graded client backed by
// Anki's OWN scheduler (the server proxies AnkiConnect `answerCards`, so FSRS
// and daily limits live in Anki; we never reinvent scheduling).
//
// One card at a time. Press SPACE to reveal the answer (this user gesture also
// unblocks any [sound:] audio autoplay), then grade with the number row:
//   1 = Again   2 = Hard   3 = Good   4 = Easy
// Ctrl+Z undoes the last grade (Anki-style) — steps back to the prior card.
//
// State machine:  loading → (offline | empty | reviewing) → done
// Queue scope is always "all" — reviews Anki's full due queue.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { api, type ReviewCard } from "./api.ts";
import { sanitizeAnkiHtml } from "./ankihtml.ts";

type Phase = "loading" | "offline" | "empty" | "question" | "answer" | "done";

/** Split a sanitized Anki answer HTML into its main part (front + back + notes)
 *  and the trailing CONTEXT block (the example sentence / image). The card
 *  template is `{{FrontSide}}<hr id=answer>…<div …>{{context}}</div>`, so the
 *  context is the LAST top-level <div>. We parse the string into a DOM fragment
 *  and pull off the last element-level <div> child; if none exists we fall back
 *  to splitting on the last <hr>. Returns the two HTML strings (right may be
 *  empty, in which case callers should treat the card as single-column). */
export function splitAnswerHtml(html: string): { left: string; right: string } {
  if (typeof document !== "undefined") {
    const tpl = document.createElement("template");
    tpl.innerHTML = html;
    const frag = tpl.content;
    // last top-level element that is a <div>
    let lastDiv: HTMLDivElement | null = null;
    for (let i = frag.childNodes.length - 1; i >= 0; i--) {
      const n = frag.childNodes[i];
      if (n && n.nodeType === 1 && (n as Element).tagName === "DIV") {
        lastDiv = n as HTMLDivElement;
        break;
      }
    }
    if (lastDiv) {
      const right = lastDiv.outerHTML;
      lastDiv.remove();
      const left = tpl.innerHTML;
      if (right.trim()) return { left, right };
    }
  }
  // fallback: split on the last <hr …>, but only trust it when the right side
  // actually contains a block element (img, div, figure, audio) — otherwise
  // it's likely bare back-answer text and we leave it as single-column.
  const m = html.match(/^([\s\S]*)<hr[^>]*>([\s\S]*)$/i);
  if (m) {
    const right = m[2] ?? "";
    if (/<(img|div|figure|audio)[\s>]/i.test(right)) {
      return { left: m[1] ?? html, right };
    }
  }
  return { left: html, right: "" };
}

/** True while focus is in a text-entry control — we then ignore our hotkeys so
 *  typing (e.g. a future search box) never triggers grading. */
function isTextTarget(el: EventTarget | null): boolean {
  const node = el as HTMLElement | null;
  if (!node) return false;
  const tag = node.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    node.isContentEditable === true
  );
}

export function Review({
  go,
  toast,
}: {
  go: (h: string) => void;
  toast?: (m: string) => void;
}) {
  const [queue, setQueue] = useState<ReviewCard[]>([]);
  const [pos, setPos] = useState(0);
  const [due, setDue] = useState(0);
  // Anki-style deck counts {new, learning, review}, shown as the colored
  // "<new> + <learning> + <review>" header. Sourced from /api/review/queue.
  const [counts, setCounts] = useState({ new: 0, learning: 0, review: 0 });
  const [phase, setPhase] = useState<Phase>("loading");
  const [reviewed, setReviewed] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  // visible banner shown when a grade can't be persisted (so we never silently
  // loop on the same card). Cleared on the next successful action.
  const [gradeErr, setGradeErr] = useState<string | null>(null);

  const answerRef = useRef<HTMLDivElement>(null);
  // guards optimistic advance so a double key-press can't grade the same card
  // twice / skip a card before React re-renders the next one.
  const gradingRef = useRef(false);
  // separate guard for Delete so a double Delete can't fire twice on the same card.
  const deletingRef = useRef(false);
  // Undo stack (Ctrl+Z): each graded card pushes {pos, ease} so we can step the
  // UI back to the previous card. The server grade is best-effort un-done via a
  // compensating grade only if needed; here we restore the CLIENT position so
  // the user sees and can re-grade the card (Anki-style "undo last answer").
  const undoRef = useRef<{ pos: number; cardId: number }[]>([]);

  const card: ReviewCard | undefined = queue[pos];

  // Fetch the queue and decide the entry phase.
  const load = useCallback(async () => {
    setPhase("loading");
    setErr(null);
    try {
      const res = await api.reviewQueue("all");
      if (!res.available) {
        setQueue([]);
        setDue(0);
        setPhase("offline");
        return;
      }
      setQueue(res.cards);
      setDue(res.due);
      setCounts(res.counts ?? { new: 0, learning: 0, review: 0 });
      setPos(0);
      undoRef.current = [];
      gradingRef.current = false;
      setPhase(res.cards.length === 0 ? "empty" : "question");
    } catch (e) {
      // human message first, never a raw API path.
      setErr(
        "Couldn’t reach the review service. Is the server running?",
      );
      console.error("reviewQueue failed:", e);
      setQueue([]);
      setPhase("offline");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // play the first <audio> in the revealed answer (call site is a user gesture)
  const playAnswerAudio = useCallback(() => {
    const audio = answerRef.current?.querySelector("audio");
    if (audio) void (audio as HTMLAudioElement).play().catch(() => {});
  }, []);

  // Reveal the answer AND play its audio inside the same user-gesture call
  // stack (the SPACE keydown). flushSync forces React to render the answer
  // synchronously so answerRef points at the live <audio> before we call
  // .play() — keeping the play() inside the gesture so browser autoplay policy
  // doesn't block the first card's audio. (Mirrors the `R` replay path.)
  const reveal = useCallback(() => {
    flushSync(() => setPhase("answer"));
    playAnswerAudio();
  }, [playAnswerAudio]);

  const grade = useCallback(
    (ease: number) => {
      if (phase !== "answer" || !card || gradingRef.current) return;
      gradingRef.current = true;
      const gradedId = card.cardId;
      const gradedPos = pos;

      // OPTIMISTIC: advance the UI IMMEDIATELY (no awaited round-trip — that was
      // the ~0.5s stall) and persist the grade in the BACKGROUND. The graded
      // card stays in the local `queue` array, so Ctrl+Z can step `pos` back to
      // re-show it. A background failure surfaces a banner (+ toast) but does
      // NOT loop us on the card — the user can Ctrl+Z to retry.
      undoRef.current.push({ pos: gradedPos, cardId: gradedId });
      setGradeErr(null);
      setReviewed((n) => n + 1);
      setDue((d) => Math.max(0, d - 1));

      const nextPos = gradedPos + 1;
      if (nextPos < queue.length) {
        setPos(nextPos);
        setPhase("question");
        gradingRef.current = false;
      } else {
        // drained the local batch — show "done" optimistically; the background
        // refetch below may surface more (learning steps) and re-enter review.
        setPhase("done");
        gradingRef.current = false;
      }

      // Persist + (if we drained) refetch, all off the critical path.
      void (async () => {
        const FAIL_MSG = "Couldn’t record grade — is the server running?";
        // When Anki is open it holds the collection, so the windowless DB write
        // fails-closed. Tell the user to close Anki rather than blaming the net.
        const ANKI_OPEN_MSG =
          "Anki is open — close it to review/sync windowlessly, then grade again.";
        const isAnkiOpen = (reason?: string) =>
          reason === "anki-open" || reason === "locked";
        try {
          const res = await api.reviewAnswer(gradedId, ease);
          if (!res.ok) {
            console.error("reviewAnswer not ok:", res.error, res.reason);
            const msg = isAnkiOpen(res.reason) ? ANKI_OPEN_MSG : FAIL_MSG;
            setGradeErr(msg);
            toast?.(msg);
            return;
          }
        } catch (e) {
          console.error("reviewAnswer failed:", e);
          setGradeErr(FAIL_MSG);
          toast?.(FAIL_MSG);
          return;
        }

        // Only refetch when we drained the local batch — Anki may have surfaced
        // more (learning steps) since we optimistically showed "done".
        if (nextPos >= queue.length) {
          try {
            const more = await api.reviewQueue("all");
            if (more.available && more.cards.length > 0) {
              setQueue(more.cards);
              setDue(more.due);
              setCounts(more.counts ?? { new: 0, learning: 0, review: 0 });
              setPos(0);
              undoRef.current = [];
              setPhase("question");
            } else {
              setDue(0);
            }
          } catch (e) {
            console.error("reviewQueue refetch failed:", e);
          }
        }
      })();
    },
    [phase, card, pos, queue.length, toast],
  );

  // Ctrl+Z — undo the last grade (Anki-style). Steps the client position back
  // to the previously-graded card and re-shows it (answer phase) so the user can
  // re-grade. Re-grading overwrites the schedule via a fresh dbAnswerCard, so no
  // separate server "un-answer" is needed. Pure client-side restore.
  const undo = useCallback(() => {
    const last = undoRef.current.pop();
    if (last === undefined) return;
    if (last.pos >= queue.length) return; // queue was refetched out from under us
    gradingRef.current = false;
    setGradeErr(null);
    setReviewed((n) => Math.max(0, n - 1));
    setDue((d) => d + 1);
    setPos(last.pos);
    setPhase("answer");
  }, [queue.length]);

  // Delete the current card's note from Anki (DESTRUCTIVE). Available on both
  // question and answer phases so the user can discard a card without revealing.
  const deleteCard = useCallback(() => {
    if (!card || deletingRef.current || gradingRef.current) return;
    deletingRef.current = true;
    const deletedId = card.cardId;

    void (async () => {
      const FAIL_MSG = "Couldn't delete note — is the server running?";
      const ANKI_OPEN_MSG =
        "Anki is open — close it to delete windowlessly, then try again.";
      const isAnkiOpen = (reason?: string) =>
        reason === "anki-open" || reason === "locked";
      try {
        const res = await api.reviewDelete(deletedId);
        if (!res.ok) {
          console.error("reviewDelete not ok:", res.error, res.reason);
          const msg = isAnkiOpen(res.reason) ? ANKI_OPEN_MSG : FAIL_MSG;
          setGradeErr(msg);
          toast?.(msg);
          deletingRef.current = false;
          return;
        }
      } catch (e) {
        console.error("reviewDelete failed:", e);
        setGradeErr(FAIL_MSG);
        toast?.(FAIL_MSG);
        deletingRef.current = false;
        return;
      }

      // success — clear any stale error; advance without counting as reviewed
      // (the card was deleted, not studied).
      setGradeErr(null);
      setDue((d) => Math.max(0, d - 1));

      const nextPos = pos + 1;
      if (nextPos < queue.length) {
        setPos(nextPos);
        setPhase("question");
        deletingRef.current = false;
        return;
      }
      // drained the batch — refetch to catch any remaining learning steps.
      try {
        const res = await api.reviewQueue("all");
        if (res.available && res.cards.length > 0) {
          setQueue(res.cards);
          setDue(res.due);
          setPos(0);
          setPhase("question");
        } else {
          setDue(0);
          setPhase("done");
        }
      } catch (e) {
        console.error("reviewQueue refetch failed after delete:", e);
        setPhase("done");
      } finally {
        deletingRef.current = false;
      }
    })();
  }, [card, pos, queue.length, toast]);

  // window keydown, mirroring QuizPanel's add/remove listener pattern.
  useEffect(() => {
    if (phase !== "question" && phase !== "answer") return;
    const onKey = (e: KeyboardEvent) => {
      if (isTextTarget(e.target)) return;
      // Ctrl+Z (or ⌘Z) — undo the last grade. Layout-independent via e.code, and
      // valid in BOTH question and answer phases (you can undo right after
      // advancing to the next card's question).
      if ((e.ctrlKey || e.metaKey) && e.code === "KeyZ") {
        e.preventDefault();
        undo();
        return;
      }
      // Layout-INDEPENDENT key matching via e.code (physical key), mirroring the
      // player (web/Player.tsx / useHotkeys.ts) so digit hotkeys still fire on
      // a non-Latin layout. Digit grades accept both the number row (Digit1..4)
      // and numpad (Numpad1..4). Delete is already layout-independent but we
      // read e.code too.
      const gradeFor: Record<string, number> = {
        Digit1: 1,
        Numpad1: 1,
        Digit2: 2,
        Numpad2: 2,
        Digit3: 3,
        Numpad3: 3,
        Digit4: 4,
        Numpad4: 4,
      };
      if (phase === "question") {
        if (e.code === "Space") {
          e.preventDefault();
          reveal();
        } else if (e.code === "Delete") {
          e.preventDefault();
          deleteCard();
        }
        return;
      }
      // phase === "answer"
      if (e.code === "Space") {
        // don't accidentally grade — space is consumed but does nothing.
        e.preventDefault();
        return;
      }
      if (e.code === "Delete") {
        e.preventDefault();
        deleteCard();
      } else if (e.code in gradeFor) {
        e.preventDefault();
        grade(gradeFor[e.code]!);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, reveal, grade, deleteCard, undo]);

  // Sanitize once per card. The answer HTML already contains the front
  // (`{{FrontSide}}<hr>…`), so when revealed we render ONLY the answer (never
  // the question div too — that's what doubled the front).
  const answerHtml = useMemo(
    () => (card ? sanitizeAnkiHtml(card.answer) : ""),
    [card],
  );

  // --- non-reviewing states ---

  if (phase === "loading")
    return (
      <div className="state" role="status">
        <span className="spinner" aria-hidden /> Loading review…
      </div>
    );

  if (phase === "offline")
    return (
      <div className="empty review-empty">
        {err ?? "No cards available — close Anki to review windowlessly."}
        <span className="muted review-empty-sub">
          {err
            ? "Then try again."
            : "This client reads and grades your Anki collection directly on disk. Anki must be CLOSED so it isn’t holding the collection."}
        </span>
        <div className="review-actions">
          <button className="btn sm retry" onClick={() => void load()}>
            Try again
          </button>
          <button className="btn sm ghost" onClick={() => go("#/")}>
            Back to library
          </button>
        </div>
      </div>
    );

  if (phase === "empty")
    return (
      <div className="empty review-empty">
        Nothing due right now 🎉
        <span className="muted review-empty-sub">
          Mine more words while watching, or check back later when cards come due.
        </span>
        <div className="review-actions">
          <button className="btn sm" onClick={() => void load()}>
            Check again
          </button>
          <button className="btn sm ghost" onClick={() => go("#/")}>
            Back to library
          </button>
        </div>
      </div>
    );

  if (phase === "done")
    return (
      <div className="empty review-empty">
        All done — {reviewed} word{reviewed === 1 ? "" : "s"} reviewed
        <span className="muted review-empty-sub">
          Anki has nothing more due for now.
        </span>
        <div className="review-actions">
          <button className="btn sm" onClick={() => void load()}>
            Check again
          </button>
          <button className="btn sm ghost" onClick={() => go("#/")}>
            Back to library
          </button>
        </div>
      </div>
    );

  // --- reviewing (question | answer) ---
  const revealed = phase === "answer";

  return (
    <div className="review">
      <div className="review-head">
        {/* Anki-style counters: New (blue) + Learning (red) + Due/Review (green). */}
        <span
          className="review-counts"
          aria-label={`${counts.new} new, ${counts.learning} learning, ${due} due`}
          title="New + Learning + Due (Anki counts)"
        >
          <span className="review-ct review-ct-new">{counts.new}</span>
          <span className="review-ct-sep"> + </span>
          <span className="review-ct review-ct-learning">{counts.learning}</span>
          <span className="review-ct-sep"> + </span>
          <span className="review-ct review-ct-due">{due}</span>
        </span>
      </div>

      {gradeErr && (
        <div className="review-error" role="alert">
          {gradeErr}
          <span className="muted review-empty-sub">
            Make sure Anki is closed, then grade again to retry.
          </span>
        </div>
      )}

      <div className="review-card">
        {!revealed ? (
          // QUESTION phase: render only the question (front).
          <div
            className="review-anki review-question"
            lang="ja"
            dangerouslySetInnerHTML={{
              __html: sanitizeAnkiHtml(card!.question),
            }}
          />
        ) : (
          // ANSWER phase, single column: the answer blob (already contains the
          // front, so we never render the separate question div here).
          <div
            ref={answerRef}
            className="review-anki review-answer"
            lang="ja"
            dangerouslySetInnerHTML={{ __html: answerHtml }}
          />
        )}

        {!revealed ? (
          <div className="review-hint muted" role="note">
            <kbd>Space</kbd> to show answer
          </div>
        ) : (
          <div className="review-grade">
            <button
              className="btn sm review-again"
              title="Again — didn’t know it (1)"
              onClick={() => grade(1)}
            >
              <kbd>1</kbd> didn’t know
            </button>
            <button
              className="btn sm ghost"
              title="Hard (2)"
              onClick={() => grade(2)}
            >
              <kbd>2</kbd> hard
            </button>
            <button
              className="btn sm review-good"
              title="Good — knew it (3)"
              onClick={() => grade(3)}
            >
              <kbd>3</kbd> knew it
            </button>
            <button
              className="btn sm ghost"
              title="Easy (4)"
              onClick={() => grade(4)}
            >
              <kbd>4</kbd> easy
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default Review;
