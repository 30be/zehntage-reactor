// The `.echo-overlay` echo-dictation input / reveal overlay (Wave 13.B). Pure
// presentation — echo state (echoCue/echoInput/echoResult) and the keydown
// handler live in Player.tsx. Extracted from Player.tsx.

import type { scoreDictation } from "../dictation.ts";

export function EchoOverlay({
  echoResult,
  echoInput,
  setEchoInput,
  echoInputRef,
  onEchoKeyDown,
}: {
  echoResult: ReturnType<typeof scoreDictation> | null;
  echoInput: string;
  setEchoInput: (s: string) => void;
  echoInputRef: React.RefObject<HTMLInputElement | null>;
  onEchoKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}) {
  return (
    <div className="echo-overlay">
      {echoResult == null ? (
        <>
          <input
            ref={echoInputRef}
            className="echo-input"
            value={echoInput}
            placeholder="type what you heard — Enter to check, Tab to replay"
            onChange={(e) => setEchoInput(e.target.value)}
            onKeyDown={onEchoKeyDown}
            autoFocus
          />
        </>
      ) : (
        <div className="echo-reveal">
          <div className="echo-diff">
            {echoResult.cells.map((c, i) => (
              <span key={i} className={c.ok ? "echo-ok" : "echo-bad"}>
                {c.ch}
              </span>
            ))}
          </div>
          <div className="echo-score">
            {echoResult.correct}/{echoResult.total} — Enter to continue
          </div>
          <input
            ref={echoInputRef}
            className="echo-input echo-input-hidden"
            value={echoInput}
            onChange={(e) => setEchoInput(e.target.value)}
            onKeyDown={onEchoKeyDown}
            autoFocus
          />
        </div>
      )}
    </div>
  );
}
