// READING MODE: the transcript as flowing text — merged paragraphs, timestamp
// margin links, the same hover/click word contract as the player.
//
// WIRING CONTRACT (for the integration agent):
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
//     settings={{ showSecondary: true }} // initial toggles (optional)
//   />
//   - Word popup handlers live INSIDE renderTokenLine's closure; Read adds no
//     popup state of its own.
//   - Paragraphs = consecutive cues with gap < 1.5s between them.
//   - Standalone-compilable: only imports web/tokenizer.ts types.

import { useMemo, useState, type ReactNode } from "react";
import type { KToken } from "./tokenizer.ts";

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
  settings?: ReadSettings;
}

const PARAGRAPH_GAP_S = 1.5;

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
  settings,
}: ReadProps) {
  const [showSecondary, setShowSecondary] = useState(
    settings?.showSecondary ?? true,
  );

  const paragraphs = useMemo(
    () => buildParagraphs(cues, secondaryCues),
    [cues, secondaryCues],
  );

  // Tokenize per paragraph text (joined) once the tokenizer is ready.
  const tokenized = useMemo(() => {
    if (!tokenize) return null;
    return paragraphs.map((p) => tokenize(p.lines.join("")));
  }, [paragraphs, tokenize]);

  return (
    <div
      className="read-mode"
      data-media-id={mediaId}
      style={{
        maxWidth: "42em",
        margin: "0 auto",
        padding: "2rem 1rem 6rem",
        lineHeight: 2,
        fontSize: "1.15rem",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: "1rem",
          marginBottom: "1.5rem",
        }}
      >
        <h2 style={{ margin: 0, fontSize: "1rem", fontWeight: 500, opacity: 0.8 }}>
          {entryName}
        </h2>
        {secondaryCues?.length ? (
          <button
            type="button"
            onClick={() => setShowSecondary((v) => !v)}
            title="toggle translation lines"
            style={{
              background: "none",
              border: "1px solid currentColor",
              borderRadius: 4,
              color: "inherit",
              opacity: 0.5,
              cursor: "pointer",
              fontSize: "0.75rem",
              padding: "0.1rem 0.5rem",
            }}
          >
            {showSecondary ? "ru on" : "ru off"}
          </button>
        ) : null}
      </header>

      {paragraphs.map((p, i) => (
        <div
          key={`${p.start}-${i}`}
          className="read-para"
          style={{ display: "flex", gap: "1rem", marginBottom: "1.1rem" }}
        >
          <a
            href={`#t=${Math.floor(p.start)}`}
            onClick={(e) => {
              e.preventDefault();
              onJump(p.start);
            }}
            title="jump to this moment"
            style={{
              flex: "0 0 3.5em",
              textAlign: "right",
              fontVariantNumeric: "tabular-nums",
              fontSize: "0.75rem",
              opacity: 0.35,
              textDecoration: "none",
              color: "inherit",
              lineHeight: 2.6,
              userSelect: "none",
            }}
          >
            {fmtTime(p.start)}
          </a>
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ margin: 0 }} lang="ja">
              {renderTokenLine(
                tokenized?.[i] ?? null,
                p.lines.join(" "),
                p.secondary || undefined,
              )}
            </p>
            {showSecondary && p.secondary ? (
              <p
                className="read-secondary"
                style={{
                  margin: "0.1rem 0 0",
                  fontSize: "0.85rem",
                  lineHeight: 1.5,
                  opacity: 0.45,
                }}
              >
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
