// #/review — Review / Cram mode: drill your DUE Anki deck words as clozes
// built from your OWN watched cues. One card at a time: the JA cue with the
// target word blanked (+ a toggleable RU hint), type the answer (Enter to
// check), see correct/wrong (monochrome ink / established-red), Space or → for
// next, a progress counter, and a "watch in context" deep-link to the cue.
//
// The cloze/scoring logic lives in web/review.ts (pure, unit-tested); this file
// is just the focused study screen.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Play } from "lucide-react";
import {
  buildDeck,
  scoreAnswer,
  type DueWord,
  type ReviewCard,
} from "./review.ts";
import { fmtCueTime } from "./App.tsx";

interface DueResponse {
  source: "is:due" | "interval";
  total: number;
  words: DueWord[];
}

type Phase = "answering" | "checked";

export function Review({ go }: { go: (h: string) => void }) {
  const [deck, setDeck] = useState<ReviewCard[] | null>(null);
  const [source, setSource] = useState<"is:due" | "interval">("is:due");
  const [err, setErr] = useState<string | null>(null);
  const [pos, setPos] = useState(0);
  const [typed, setTyped] = useState("");
  const [phase, setPhase] = useState<Phase>("answering");
  const [correct, setCorrect] = useState(false);
  const [showHint, setShowHint] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    setErr(null);
    void fetch("/api/review/due")
      .then((r) => (r.ok ? (r.json() as Promise<DueResponse>) : Promise.reject(r.status)))
      .then((data) => {
        setDeck(buildDeck(data.words));
        setSource(data.source);
        setPos(0);
        setTyped("");
        setPhase("answering");
      })
      .catch((e) => {
        setErr(`review/due → ${e instanceof Error ? e.message : e}`);
        setDeck((prev) => prev ?? []);
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const card: ReviewCard | undefined = deck?.[pos];

  // focus the answer input whenever a fresh card shows
  useEffect(() => {
    if (phase === "answering") inputRef.current?.focus();
  }, [pos, phase]);

  const check = useCallback(() => {
    if (!card) return;
    setCorrect(scoreAnswer(card, typed));
    setPhase("checked");
  }, [card, typed]);

  const next = useCallback(() => {
    setTyped("");
    setShowHint(false);
    setPhase("answering");
    setPos((p) => p + 1);
  }, []);

  const total = deck?.length ?? 0;
  const done = deck != null && pos >= total;

  // Space / → advance once a card is checked (mirrors the quiz flow).
  const onKey = useCallback(
    (e: React.KeyboardEvent) => {
      if (phase === "checked" && (e.key === " " || e.key === "ArrowRight")) {
        e.preventDefault();
        next();
      }
    },
    [phase, next],
  );

  const headerCount = useMemo(
    () => (deck == null ? "…" : `${Math.min(pos + 1, total)} / ${total}`),
    [deck, pos, total],
  );

  if (deck == null && err == null)
    return (
      <div className="state" role="status">
        <span className="spinner" aria-hidden /> Loading…
      </div>
    );

  if (err != null)
    return (
      <div className="state error" role="alert">
        Couldn’t load due words.
        <span className="state-detail">{err}</span>
        <button className="btn sm retry" onClick={load}>
          Retry
        </button>
      </div>
    );

  if (total === 0)
    return (
      <div className="empty review-empty">
        Nothing due right now.
        <span className="muted review-empty-sub">
          Mine words while watching, then come back to cram them.
        </span>
        <button className="btn sm" onClick={() => go("#/")}>
          Back to library
        </button>
      </div>
    );

  if (done)
    return (
      <div className="empty review-empty">
        Review complete — {total} card{total === 1 ? "" : "s"} drilled.
        <button className="btn sm" onClick={load}>
          Review again
        </button>
      </div>
    );

  return (
    <div className="review" onKeyDown={onKey}>
      <div className="review-head">
        <span className="review-count" aria-label="progress">
          {headerCount}
        </span>
        {source === "interval" && (
          <span className="review-src muted" title="is:due unavailable — ordered by interval (most overdue first)">
            interval order
          </span>
        )}
      </div>

      <div className={`review-card${phase === "checked" ? (correct ? " ok" : " bad") : ""}`}>
        <div className="review-prompt" lang="ja">
          {card!.prompt}
        </div>

        {showHint && <div className="review-hint">{card!.hint}</div>}

        {phase === "answering" ? (
          <input
            ref={inputRef}
            className="review-input"
            type="text"
            placeholder="type the word…"
            aria-label="Your answer"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                check();
              }
            }}
          />
        ) : (
          <div className="review-result" role="status">
            <span className={correct ? "review-correct" : "review-wrong"}>
              {correct ? "correct" : "wrong"}
            </span>
            <span className="review-answer" lang="ja">
              {card!.answer}
              {card!.front !== card!.answer && (
                <span className="muted review-front"> · {card!.front}</span>
              )}
            </span>
          </div>
        )}

        <div className="review-actions">
          {phase === "answering" ? (
            <>
              <button className="btn sm" onClick={check}>
                check (Enter)
              </button>
              <button
                className="btn sm ghost"
                onClick={() => setShowHint((s) => !s)}
                aria-pressed={showHint}
              >
                {showHint ? "hide hint" : "hint"}
              </button>
            </>
          ) : (
            <button className="btn sm" onClick={next}>
              next (Space)
            </button>
          )}
          {card!.deepLink && (
            <button
              className="btn sm ghost review-watch"
              title={
                card!.source
                  ? `Watch ${card!.source} @ ${fmtCueTime(deepLinkTime(card!.deepLink))}`
                  : "Watch in context"
              }
              onClick={() => go(card!.deepLink!)}
            >
              <Play size={14} strokeWidth={1.75} aria-hidden /> watch in context
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Seconds parsed out of a "#/play/<id>@<t>" deep-link (for the label). */
function deepLinkTime(link: string): number {
  const at = link.lastIndexOf("@");
  const t = at >= 0 ? parseFloat(link.slice(at + 1)) : NaN;
  return Number.isFinite(t) ? t : 0;
}

export default Review;
