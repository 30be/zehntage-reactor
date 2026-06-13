// READING MODE: the transcript as flowing text — merged paragraphs, timestamp
// margin links, the same hover/click word contract as the player.
//
// Props contract (ReadRoute.tsx is the live wiring):
//   <Read
//     cues={jaCues}                      // primary (target-lang) cues
//     secondaryCues={ruCues ?? null}     // translation cues or null
//     entryName={entry.name}
//     mediaId={entry.id}
//     tokenize={tokenizeFn}              // sync fn AFTER kuromoji is loaded:
//                                        //   (text) => KToken[]; pass null
//                                        //   while loading (plain text shown)
//     renderTokenLine={(tokens, fallback) =>
//       <TokenLine tokens={tokens} fallbackText={fallback}
//                  wordIndex={...} knownWords={...} furiganaOn={...}
//                  onWordEnter={...} onWordLeave={...} onWordClick={...} />}
//                                        // inject the Player's configured
//                                        // TokenLine so popups/underlines
//                                        // stay identical (Read itself never
//                                        // touches Anki/popup state)
//     onJump={(t) => { seek(t); switchToPlayerView(); }}
//     onCursorClick={(paraIndex) => void}  // optional: called on Enter/click
//     knownPct={number | null}           // optional: % known words in this doc
//     settings={{ showSecondary: true }} // initial toggles (optional)
//   />
//   - Word popup handlers live INSIDE renderTokenLine's closure; Read adds no
//     popup state of its own.
//   - Paragraphs = consecutive cues with gap < 1.5s between them.
//   - Standalone-compilable: only imports web/tokenizer.ts types.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { KToken } from "./tokenizer.ts";
import {
  readFurthest,
  writeFurthest,
  calcProgress,
} from "./readProgress.ts";

export interface ReadCue {
  start: number;
  end: number;
  text: string;
}

export interface ReadSettings {
  /** Show the secondary (translation) lines under each paragraph. */
  showSecondary?: boolean;
}

export interface ReadProps {
  cues: ReadCue[];
  secondaryCues?: ReadCue[] | null;
  entryName: string;
  mediaId: string;
  /** Sync tokenizer, or null while kuromoji is still loading. */
  tokenize: ((text: string) => KToken[]) | null;
  /** Inject the app's TokenLine (already bound to wordIndex/popup handlers).
   * `secondary` = the paragraph's RU translation, for mining context. */
  renderTokenLine: (
    tokens: KToken[] | null,
    fallbackText: string,
    secondary?: string,
  ) => ReactNode;
  /** Jump playback to t seconds (timestamp margin link click). */
  onJump: (t: number) => void;
  /** Called when the user presses Enter or clicks on the cursor line. */
  onCursorActivate?: (paraIndex: number) => void;
  /** % known words in this doc (0-100), shown in header if provided. */
  knownPct?: number | null;
  settings?: ReadSettings;
}

const PARAGRAPH_GAP_S = 1.5;

// Secondary-translation visibility, persisted via the zr.* state pattern (the
// startSync() monkey-patch round-trips zr.* keys to the server like other UI
// prefs). A single global pref — not per-document — so the choice sticks.
const SECONDARY_KEY = "zr.read.secondary";

function readShowSecondary(fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(SECONDARY_KEY);
    return v == null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}

function writeShowSecondary(on: boolean): void {
  try {
    localStorage.setItem(SECONDARY_KEY, on ? "1" : "0");
  } catch {
    /* quota / SSR — ignore */
  }
}

export interface Paragraph {
  start: number;
  end: number;
  /** Primary cue texts, in order (rendered space-joined). */
  lines: string[];
  /** Secondary cues overlapping [start, end], joined. */
  secondary: string;
}

/** Merge consecutive cues into paragraphs when the silence between them is short. */
export function buildParagraphs(
  cues: ReadCue[],
  secondaryCues?: ReadCue[] | null,
): Paragraph[] {
  const out: Paragraph[] = [];
  let cur: Paragraph | null = null;
  for (const c of cues) {
    const text = c.text.trim();
    if (!text) continue;
    if (cur && c.start - cur.end < PARAGRAPH_GAP_S) {
      cur.lines.push(text);
      cur.end = Math.max(cur.end, c.end);
    } else {
      cur = { start: c.start, end: c.end, lines: [text], secondary: "" };
      out.push(cur);
    }
  }
  if (secondaryCues?.length) {
    for (const p of out) {
      const parts: string[] = [];
      for (const s of secondaryCues) {
        if (s.start < p.end && s.end > p.start && s.text.trim())
          parts.push(s.text.trim());
        if (s.start >= p.end) break; // assume sorted
      }
      p.secondary = parts.join(" ");
    }
  }
  return out;
}

// clampPopupPos lives in ./readlayout.ts (DOM-free, unit-tested there).

export function fmtTime(t: number): string {
  const s = Math.max(0, Math.floor(t));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? h + ":" : ""}${mm}:${String(sec).padStart(2, "0")}`;
}

export function Read({
  cues,
  secondaryCues,
  entryName,
  mediaId,
  tokenize,
  renderTokenLine,
  onJump,
  onCursorActivate,
  knownPct,
  settings,
}: ReadProps) {
  const [showSecondary, setShowSecondary] = useState(() =>
    readShowSecondary(settings?.showSecondary ?? true),
  );
  const toggleSecondary = useCallback(() => {
    setShowSecondary((v) => {
      const next = !v;
      writeShowSecondary(next);
      return next;
    });
  }, []);

  const paragraphs = useMemo(
    () => buildParagraphs(cues, secondaryCues),
    [cues, secondaryCues],
  );

  // Tokenize per paragraph text (joined) once the tokenizer is ready.
  const tokenized = useMemo(() => {
    if (!tokenize) return null;
    return paragraphs.map((p) => tokenize(p.lines.join("")));
  }, [paragraphs, tokenize]);

  // --- cursor (j/k / arrow keys) ---
  const [cursor, setCursor] = useState<number>(-1);
  // refs so keyboard handler is stable
  const cursorRef = useRef(cursor);
  const paraCountRef = useRef(paragraphs.length);
  cursorRef.current = cursor;
  paraCountRef.current = paragraphs.length;

  const paraRefs = useRef<(HTMLDivElement | null)[]>([]);

  // Scroll the cursor line into view, centered.
  const scrollToCursor = useCallback((idx: number) => {
    const el = paraRefs.current[idx];
    if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
  }, []);

  const moveCursor = useCallback(
    (delta: number) => {
      const total = paraCountRef.current;
      if (total === 0) return;
      setCursor((prev) => {
        // From the no-cursor state, the first press (either direction) lands on
        // the first line rather than skipping it.
        const next =
          prev < 0
            ? 0
            : Math.max(0, Math.min(total - 1, prev + delta));
        // scroll after state settles
        setTimeout(() => scrollToCursor(next), 0);
        return next;
      });
    },
    [scrollToCursor],
  );

  // Advance furthest-read when cursor moves forward.
  useEffect(() => {
    if (cursor >= 0) writeFurthest(mediaId, cursor);
  }, [cursor, mediaId]);

  // Keyboard handler (j/k/arrows/Enter) — active when no popup is open.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Respect text inputs and modifier keys.
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      if (e.code === "KeyJ" || e.key === "ArrowDown") {
        e.preventDefault();
        moveCursor(+1);
      } else if (e.code === "KeyK" || e.key === "ArrowUp") {
        e.preventDefault();
        moveCursor(-1);
      } else if (e.key === "Enter" && cursorRef.current >= 0) {
        e.preventDefault();
        onCursorActivate?.(cursorRef.current);
      } else if (e.code === "KeyT") {
        e.preventDefault();
        toggleSecondary();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [moveCursor, onCursorActivate, toggleSecondary]);

  // --- resume affordance ---
  const [furthest, setFurthest] = useState<number>(() => readFurthest(mediaId));
  // re-read when mediaId changes
  useEffect(() => {
    setFurthest(readFurthest(mediaId));
  }, [mediaId]);

  const [resumeDismissed, setResumeDismissed] = useState(false);
  const showResume =
    !resumeDismissed && furthest >= 0 && cursor < 0 && paragraphs.length > 0;

  const handleResume = useCallback(() => {
    setResumeDismissed(true);
    // clamp: a saved position can exceed the paragraph count if the transcript
    // shrank since last session (otherwise progress would read >100%).
    const target = Math.min(furthest, paragraphs.length - 1);
    setCursor(target);
    setTimeout(() => scrollToCursor(target), 0);
  }, [furthest, paragraphs.length, scrollToCursor]);

  // --- progress ---
  const progress = calcProgress(
    Math.min(Math.max(furthest, cursor), paragraphs.length - 1),
    paragraphs.length,
  );

  // --- header stats ---
  const lineCount = paragraphs.length;

  return (
    <div
      className="read-mode"
      data-media-id={mediaId}
    >
      {/* ---- header ---- */}
      <header>
        <h2>
          {entryName}
        </h2>
        <div className="read-header-meta">
          <span className="read-meta-item">{lineCount} lines</span>
          {knownPct != null && (
            <span className="read-meta-item">{knownPct}% known</span>
          )}
          {progress > 0 && (
            <span className="read-meta-item read-progress-label" aria-label={`Reading progress: ${progress}%`}>
              {progress}%
            </span>
          )}
          {secondaryCues?.length ? (
            <button
              type="button"
              onClick={toggleSecondary}
              title="toggle translation lines (t)"
              className="read-toggle-btn"
            >
              {showSecondary ? "ru on" : "ru off"}
            </button>
          ) : null}
        </div>
      </header>

      {/* ---- progress bar ---- */}
      {progress > 0 && (
        <div className="read-progress-track" aria-hidden>
          <div
            className="read-progress-fill"
            style={{ width: `${progress}%` }}
          />
        </div>
      )}

      {/* ---- tokenizer loading affordance ---- */}
      {!tokenize && paragraphs.length > 0 && (
        <div className="state read-tokenizing" role="status">
          <span className="spinner" aria-hidden /> Preparing text…
        </div>
      )}

      {/* ---- resume affordance ---- */}
      {showResume && (
        <button
          type="button"
          className="read-resume"
          onClick={handleResume}
          aria-label={`Resume reading from line ${furthest + 1}`}
        >
          resume · line {furthest + 1}
        </button>
      )}

      {tokenize && paragraphs.map((p, i) => (
        <div
          key={`${p.start}-${i}`}
          ref={(el) => { paraRefs.current[i] = el; }}
          className={`read-para${cursor === i ? " read-cursor" : ""}`}
          data-para-index={i}
          onClick={() => {
            setCursor(i);
            onCursorActivate?.(i);
          }}
        >
          <a
            href={`#t=${Math.floor(p.start)}`}
            onClick={(e) => {
              e.preventDefault();
              onJump(p.start);
            }}
            title="jump to this moment"
            className="read-timestamp"
          >
            {fmtTime(p.start)}
          </a>
          <div className="read-para-body">
            <p lang="ja">
              {renderTokenLine(
                tokenized?.[i] ?? null,
                p.lines.join(" "),
                p.secondary || undefined,
              )}
            </p>
            {showSecondary && p.secondary ? (
              <p className="read-secondary">
                {p.secondary}
              </p>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}

export default Read;
