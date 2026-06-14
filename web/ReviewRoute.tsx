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

import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { api, type ReviewCard } from "./api.ts";
import { sanitizeAnkiHtml } from "./ankihtml.ts";

type Phase = "loading" | "offline" | "empty" | "question" | "answer" | "done";

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

export function Review({ go }: { go: (h: string) => void }) {
  const [queue, setQueue] = useState<ReviewCard[]>([]);
  const [pos, setPos] = useState(0);
  const [due, setDue] = useState(0);
  const [phase, setPhase] = useState<Phase>("loading");
  const [reviewed, setReviewed] = useState(0);
  const [err, setErr] = useState<string | null>(null);

  const answerRef = useRef<HTMLDivElement>(null);
  // guards optimistic advance so a double key-press can't grade the same card
  // twice / skip a card before React re-renders the next one.
  const gradingRef = useRef(false);

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

      // fire-and-forget; advance optimistically so grading feels instant. A
      // failed grade isn't re-queued (avoids double-grading) — the card simply
      // reappears next session if Anki didn't record it.
      void api.reviewAnswer(gradedId, ease).catch((e) => {
        console.error("reviewAnswer failed:", e);
      });

      setReviewed((n) => n + 1);
      setDue((d) => Math.max(0, d - 1));

      const nextPos = pos + 1;
      if (nextPos < queue.length) {
        setPos(nextPos);
        setPhase("question");
        gradingRef.current = false;
      } else {
        // drained the batch — Anki may have surfaced more (learning steps).
        void (async () => {
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
      }
    },
    [phase, card, pos, queue.length],
  );

  // window keydown, mirroring QuizPanel's add/remove listener pattern.
  useEffect(() => {
    if (phase !== "question" && phase !== "answer") return;
    const onKey = (e: KeyboardEvent) => {
      if (isTextTarget(e.target)) return;
      if (phase === "question") {
        if (e.key === " " || e.key === "Spacebar") {
          e.preventDefault();
          reveal();
        }
        return;
      }
      // phase === "answer"
      if (e.key === " " || e.key === "Spacebar") {
        // don't accidentally grade — space is consumed but does nothing.
        e.preventDefault();
        return;
      }
      if (e.key === "1") {
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
  }, [phase, reveal, grade, playAnswerAudio]);

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
    <div className="review">
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
      </div>

      <div className="review-card">
        <div
          className="review-anki review-question"
          lang="ja"
          dangerouslySetInnerHTML={{
            __html: sanitizeAnkiHtml(card!.question),
          }}
        />

        {revealed && (
          <>
            <hr className="review-divider" aria-hidden />
            <div
              ref={answerRef}
              className="review-anki review-answer"
              lang="ja"
              dangerouslySetInnerHTML={{
                __html: sanitizeAnkiHtml(card!.answer),
              }}
            />
          </>
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
          </div>
        )}
      </div>
    </div>
  );
}

export default Review;
