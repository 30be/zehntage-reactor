// #/review — Flashcard Review: a no-typing, hotkey-graded client backed by
// Anki's OWN scheduler (the server proxies AnkiConnect `answerCards`, so FSRS
// and daily limits live in Anki; we never reinvent scheduling).
//
// One card at a time. Press SPACE to reveal the answer (this user gesture also
// unblocks any [sound:] audio autoplay), then grade with the number row:
//   1 = Again   2 = Hard   3 = Good   4 = Easy   (R replays the answer audio)
//
// State machine:  loading → (offline | empty | reviewing) → done
// Queue scope is always "all" — reviews Anki's full due queue.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { api, type ReviewCard } from "./api.ts";
import { sanitizeAnkiHtml } from "./ankihtml.ts";

type Phase = "loading" | "offline" | "empty" | "question" | "answer" | "done";

const TWOCOL_KEY = "zr.review.twocol";

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
  const [phase, setPhase] = useState<Phase>("loading");
  const [reviewed, setReviewed] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  // visible banner shown when a grade can't be persisted (so we never silently
  // loop on the same card). Cleared on the next successful action.
  const [gradeErr, setGradeErr] = useState<string | null>(null);
  // two-column layout toggle, persisted across sessions (default off).
  const [twoCol, setTwoCol] = useState<boolean>(() => {
    try {
      return localStorage.getItem(TWOCOL_KEY) === "1";
    } catch {
      return false;
    }
  });
  const toggleTwoCol = useCallback((next: boolean) => {
    setTwoCol(next);
    try {
      localStorage.setItem(TWOCOL_KEY, next ? "1" : "0");
    } catch {
      /* storage may be unavailable (private mode) — toggle still works in-session */
    }
  }, []);

  const answerRef = useRef<HTMLDivElement>(null);
  // guards optimistic advance so a double key-press can't grade the same card
  // twice / skip a card before React re-renders the next one.
  const gradingRef = useRef(false);
  // separate guard for Delete so a double Delete can't fire twice on the same card.
  const deletingRef = useRef(false);

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
      setPos(0);
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

      // AWAIT the grade — only advance once Anki has actually recorded it.
      // Previously this was fire-and-forget and advanced regardless, so a
      // backend that couldn't persist (Anki unreachable) left the card in the
      // queue forever → silent infinite loop. Now a failed grade surfaces a
      // visible banner (+ toast if available) and we DON'T advance.
      void (async () => {
        const FAIL_MSG = "Couldn’t record grade — is Anki reachable?";
        try {
          const res = await api.reviewAnswer(gradedId, ease);
          if (!res.ok) {
            console.error("reviewAnswer not ok:", res.error);
            setGradeErr(FAIL_MSG);
            toast?.(FAIL_MSG);
            gradingRef.current = false; // allow a retry on the same card
            return;
          }
        } catch (e) {
          console.error("reviewAnswer failed:", e);
          setGradeErr(FAIL_MSG);
          toast?.(FAIL_MSG);
          gradingRef.current = false;
          return;
        }

        // success — clear any stale error and advance.
        setGradeErr(null);
        setReviewed((n) => n + 1);
        setDue((d) => Math.max(0, d - 1));

        const nextPos = pos + 1;
        if (nextPos < queue.length) {
          setPos(nextPos);
          setPhase("question");
          gradingRef.current = false;
          return;
        }
        // drained the batch — Anki may have surfaced more (learning steps).
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
          console.error("reviewQueue refetch failed:", e);
          setPhase("done");
        } finally {
          gradingRef.current = false;
        }
      })();
    },
    [phase, card, pos, queue.length, toast],
  );

  // Delete the current card's note from Anki (DESTRUCTIVE). Available on both
  // question and answer phases so the user can discard a card without revealing.
  const deleteCard = useCallback(() => {
    if (!card || deletingRef.current || gradingRef.current) return;
    deletingRef.current = true;
    const deletedId = card.cardId;

    void (async () => {
      const FAIL_MSG = "Couldn't delete note — is Anki reachable?";
      try {
        const res = await api.reviewDelete(deletedId);
        if (!res.ok) {
          console.error("reviewDelete not ok:", res.error);
          setGradeErr(FAIL_MSG);
          toast?.(FAIL_MSG);
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
      if (phase === "question") {
        if (e.key === " " || e.key === "Spacebar") {
          e.preventDefault();
          reveal();
        } else if (e.key === "Delete") {
          e.preventDefault();
          deleteCard();
        }
        return;
      }
      // phase === "answer"
      if (e.key === " " || e.key === "Spacebar") {
        // don't accidentally grade — space is consumed but does nothing.
        e.preventDefault();
        return;
      }
      if (e.key === "Delete") {
        e.preventDefault();
        deleteCard();
      } else if (e.key === "1") {
        e.preventDefault();
        grade(1);
      } else if (e.key === "2") {
        e.preventDefault();
        grade(2);
      } else if (e.key === "3") {
        e.preventDefault();
        grade(3);
      } else if (e.key === "4") {
        e.preventDefault();
        grade(4);
      } else if (e.key === "r" || e.key === "R") {
        e.preventDefault();
        playAnswerAudio();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, reveal, grade, playAnswerAudio, deleteCard]);

  // Sanitize once per card. The answer HTML already contains the front
  // (`{{FrontSide}}<hr>…`), so when revealed we render ONLY the answer (never
  // the question div too — that's what doubled the front).
  const answerHtml = useMemo(
    () => (card ? sanitizeAnkiHtml(card.answer) : ""),
    [card],
  );
  // For two-column mode, split off the trailing CONTEXT <div> (sentence/image).
  const split = useMemo(() => splitAnswerHtml(answerHtml), [answerHtml]);

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
        {err ?? "Open Anki to review — the scheduler runs there."}
        <span className="muted review-empty-sub">
          {err
            ? "Then try again."
            : "This client grades against your own Anki collection, so Anki (with AnkiConnect) needs to be open."}
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
  const left = Math.max(0, queue.length - pos);

  return (
    <div className={`review${twoCol ? " review-twocol-on" : ""}`}>
      <div className="review-head">
        <span className="review-count" aria-label="cards left in batch">
          {left} left
        </span>
        <span className="muted review-due" title="Cards Anki considers due">
          due: {due}
        </span>
        <span className="muted review-reviewed">
          reviewed: {reviewed}
        </span>
        <label
          className={`review-twocol-toggle${twoCol ? " active" : ""}`}
          title="Lay the card out in two columns to avoid scrolling"
        >
          <input
            type="checkbox"
            checked={twoCol}
            onChange={(e) => toggleTwoCol(e.target.checked)}
          />
          two-column
        </label>
      </div>

      {gradeErr && (
        <div className="review-error" role="alert">
          {gradeErr}
          <span className="muted review-empty-sub">
            Open Anki (with AnkiConnect), then grade again to retry.
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
        ) : twoCol && split.right ? (
          // ANSWER phase, two-column: main answer (front+back+notes) LEFT,
          // CONTEXT (sentence/image) RIGHT. The answer blob already holds the
          // front, so we never render the separate question div here.
          <div className="review-twocol">
            <div
              ref={answerRef}
              className="review-anki review-answer review-col-left"
              lang="ja"
              dangerouslySetInnerHTML={{ __html: split.left }}
            />
            <div
              className="review-anki review-context review-col-right"
              lang="ja"
              dangerouslySetInnerHTML={{ __html: split.right }}
            />
          </div>
        ) : (
          // ANSWER phase, one-column (default): the answer blob (contains front).
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
            <span className="muted review-replay-hint" title="Replay audio">
              <kbd>R</kbd> replay
            </span>
            <span className="muted review-delete-hint" title="Delete note from Anki">
              <kbd>Del</kbd> delete
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

export default Review;
