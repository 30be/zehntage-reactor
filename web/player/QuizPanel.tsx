// Comprehension-quiz overlay (`q`): one question at a time, keyboard-driven,
// laconic monochrome. Item generation is pure (web/quiz.ts); this component
// only renders items + tallies the score and reports it via the onDone
// callback (which emits a "quiz.result" telemetry event from Player.tsx).
//
// Keys:
//   MC      1-4 / ↑↓ + Enter select; after answering Enter advances
//   cloze   type then Enter to check; Enter again advances
//   Esc     close (handled by the parent hotkey path AND a local listener)

import { useCallback, useEffect, useRef, useState } from "react";
import { BLANK, checkCloze, type QuizItem } from "../quiz.ts";

export interface QuizResult {
  total: number;
  correct: number;
}

export function QuizPanel({
  items,
  onClose,
  onDone,
}: {
  items: QuizItem[];
  onClose: () => void;
  onDone: (r: QuizResult) => void;
}) {
  const [idx, setIdx] = useState(0);
  const [correct, setCorrect] = useState(0);
  const [answered, setAnswered] = useState(false);
  const [wasRight, setWasRight] = useState(false);
  const [choice, setChoice] = useState<number | null>(null);
  const [typed, setTyped] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const done = idx >= items.length;
  const item = items[idx];

  // report the score exactly once, when the run finishes
  const reportedRef = useRef(false);
  useEffect(() => {
    if (done && !reportedRef.current) {
      reportedRef.current = true;
      onDone({ total: items.length, correct });
    }
  }, [done, items.length, correct, onDone]);

  // focus the cloze input when a new cloze question shows
  useEffect(() => {
    if (item?.kind === "cloze" && !answered) inputRef.current?.focus();
  }, [idx, item?.kind, answered]);

  const grade = useCallback(
    (ok: boolean) => {
      setAnswered(true);
      setWasRight(ok);
      if (ok) setCorrect((c) => c + 1);
    },
    [],
  );

  const answerMc = useCallback(
    (i: number) => {
      if (answered || item?.kind !== "mc") return;
      setChoice(i);
      grade(i === item.answer);
    },
    [answered, item, grade],
  );

  const answerCloze = useCallback(() => {
    if (answered || item?.kind !== "cloze") return;
    grade(checkCloze(typed, item.answer));
  }, [answered, item, typed, grade]);

  const next = useCallback(() => {
    setAnswered(false);
    setWasRight(false);
    setChoice(null);
    setTyped("");
    setIdx((i) => i + 1);
  }, []);

  // keyboard: number keys / arrows + Enter. Capture phase so the player's
  // global hotkeys never see these while the overlay owns the screen.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (done) {
        if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        if (!answered) {
          if (item?.kind === "mc" && choice != null) answerMc(choice);
          else if (item?.kind === "cloze") answerCloze();
        } else {
          next();
        }
        return;
      }
      if (item?.kind === "mc" && !answered) {
        if (/^[1-9]$/.test(e.key)) {
          const i = Number(e.key) - 1;
          if (i < item.options.length) {
            e.preventDefault();
            e.stopPropagation();
            answerMc(i);
          }
        } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          e.stopPropagation();
          const n = item.options.length;
          setChoice((c) =>
            c == null
              ? 0
              : (c + (e.key === "ArrowDown" ? 1 : n - 1)) % n,
          );
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [done, answered, item, choice, answerMc, answerCloze, next, onClose]);

  return (
    <div className="quiz-overlay" role="dialog" aria-label="comprehension quiz">
      <div className="quiz-card">
        {done ? (
          <div className="quiz-end">
            <div className="quiz-score">
              {correct} / {items.length}
            </div>
            <div className="quiz-sub">comprehension</div>
            <button className="btn" onClick={onClose}>
              Close
            </button>
          </div>
        ) : item ? (
          <>
            <div className="quiz-count">
              {idx + 1} / {items.length}
            </div>
            <div className="quiz-prompt">{item.prompt}</div>

            {item.kind === "mc" ? (
              <div className="quiz-options">
                {item.options.map((opt, i) => {
                  const cls =
                    answered && i === item.answer
                      ? " right"
                      : answered && i === choice
                        ? " wrong"
                        : choice === i
                          ? " sel"
                          : "";
                  return (
                    <button
                      key={i}
                      className={`quiz-opt${cls}`}
                      disabled={answered}
                      onClick={() => answerMc(i)}
                    >
                      <span className="quiz-num">{i + 1}</span>
                      {opt}
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="quiz-cloze">
                <input
                  ref={inputRef}
                  className="quiz-input"
                  value={typed}
                  disabled={answered}
                  placeholder={`recall ${BLANK}`}
                  onChange={(e) => setTyped(e.target.value)}
                />
                {answered && !wasRight && (
                  <div className="quiz-answer">{item.answer}</div>
                )}
                {answered && item.translation && (
                  <div className="quiz-hint">{item.translation}</div>
                )}
              </div>
            )}

            {answered && (
              <div className={`quiz-verdict${wasRight ? " ok" : " no"}`}>
                {wasRight ? "correct" : "wrong"}
                <button className="btn" onClick={next}>
                  {idx + 1 < items.length ? "Next" : "Finish"} ⏎
                </button>
              </div>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}
