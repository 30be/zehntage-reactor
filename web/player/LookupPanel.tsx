// Player lookup popup: word lookup / sentence-explain panel with encounters,
// Q/A thread and the ask… input. Pure presentation — lookup/explain fetching
// and popup state live in Player.tsx. Extracted from Player.tsx.

import { useEffect } from "react";
import type {
  EncounterHit,
  ExplainResult,
  WordHistory,
  WordLookup,
} from "../api.ts";
import { AccentReading } from "../TokenLine.tsx";
import { accentOf } from "../accent.ts";
import { freqRankOf, freqTier } from "../freq.ts";
import { type PopupState, type QaItem } from "./shared.ts";
import { Encounters } from "./Encounters.tsx";

// Compact, monochrome per-word history line for the lookup popup. Renders
// nothing when there's no recorded history (never-seen word). Derived entirely
// from the telemetry event log (see src/lib/telemetry.ts wordHistory).
function fmtDate(ts: number): string {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function WordHist({ hist }: { hist: WordHistory | null }) {
  if (!hist) return null;
  const parts: string[] = [];
  if (hist.addedAt !== undefined) parts.push(`added ${fmtDate(hist.addedAt)}`);
  if (hist.lookups > 0)
    parts.push(`looked up ${hist.lookups}×`);
  if (
    hist.addedAt === undefined &&
    hist.lookups === 0 &&
    hist.firstSeenAt !== undefined
  )
    parts.push(`first seen ${fmtDate(hist.firstSeenAt)}`);
  if (parts.length === 0) return null;
  return (
    <div className="whist" title="Your history with this word (from your study log)">
      {parts.join(" · ")}
    </div>
  );
}

export function LookupPanel({
  popup,
  popupPos,
  pinned,
  popupSaved,
  lookupRef,
  onPanelEnter,
  onPanelLeave,
  explain,
  explainLoading,
  lookup,
  lookupLoading,
  pitchOn,
  accents,
  freqMap,
  knownWords,
  blacklist,
  encHits,
  encOpen,
  onToggleEncounters,
  wordHist,
  qa,
  askText,
  setAskText,
  askInputRef,
  onAskFocus,
  onAskBlur,
  onAsk,
  onClose,
}: {
  popup: PopupState;
  popupPos: React.CSSProperties;
  pinned: boolean;
  popupSaved: boolean;
  lookupRef: React.RefObject<HTMLDivElement | null>;
  onPanelEnter: () => void;
  onPanelLeave: () => void;
  explain: ExplainResult | null;
  explainLoading: boolean;
  lookup: WordLookup | null;
  lookupLoading: boolean;
  pitchOn: boolean;
  accents: Map<string, number> | null;
  freqMap: Map<string, number> | null;
  knownWords: Set<string>;
  blacklist: Set<string>;
  encHits: EncounterHit[] | null;
  encOpen: boolean;
  onToggleEncounters: () => void;
  wordHist: WordHistory | null;
  qa: QaItem[];
  askText: string;
  setAskText: (s: string) => void;
  askInputRef: React.RefObject<HTMLInputElement | null>;
  onAskFocus: () => void;
  onAskBlur: () => void;
  onAsk: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    // a11y: auto-focus the first focusable child (or the panel itself) on open
    // so keyboard users land inside the dialog. The panel is unmounted/remounted
    // on each open, so this runs once per open.
    const first = lookupRef.current?.querySelector<HTMLElement>(
      'button,input,[tabindex]:not([tabindex="-1"])',
    );
    (first ?? lookupRef.current)?.focus();
  }, [lookupRef]);

  return (
    <div
      ref={lookupRef}
      className={`lookup${pinned ? " pinned" : ""}`}
      style={popupPos}
      role="dialog"
      aria-label="Word lookup"
      aria-modal="true"
      tabIndex={-1}
      onMouseEnter={onPanelEnter}
      onMouseLeave={onPanelLeave}
    >
      {popup.kind === "sentence" ? (
        <>
          <div className={`sentence${popupSaved ? " saved" : ""}`}>
            {popup.surface}
          </div>
          {explainLoading && <div className="spin">Explaining…</div>}
          {explain && (
            <>
              <div className="translation">{explain.translation}</div>
              <div className="notes breakdown">{explain.breakdown}</div>
              {explain.idioms && (
                <div className="notes breakdown">{explain.idioms}</div>
              )}
            </>
          )}
        </>
      ) : (
        <>
          <div>
            <span className={`word${popupSaved ? " saved" : ""}`}>
              {popup.surface}
            </span>
            {(lookup?.reading || popup.reading) && (
              <span className="reading popup-reading">
                {pitchOn && accents ? (
                  <AccentReading
                    reading={(lookup?.reading || popup.reading)!}
                    accent={accentOf(
                      accents,
                      popup.surface,
                      (lookup?.reading || popup.reading)!,
                      popup.dictForm,
                    )}
                  />
                ) : (
                  lookup?.reading || popup.reading
                )}
              </span>
            )}
            {freqMap && (
              <span
                className="freq-tag"
                title="How common this word is (rank in a 30k frequency list)"
              >
                {freqTier(freqRankOf(freqMap, popup.surface, popup.dictForm))}
              </span>
            )}
            {knownWords.has(popup.dictForm ?? popup.surface) && (
              <span
                className="known-flag"
                title="Marked as known — press k to toggle"
              >
                known
              </span>
            )}
            {blacklist.has(popup.dictForm ?? popup.surface) && (
              <span
                className="known-flag"
                title="Blacklisted — never counted as unknown; press x to toggle"
              >
                blacklisted
              </span>
            )}
          </div>
          {lookupLoading && <div className="spin">Looking up…</div>}
          {lookup && (
            <>
              <div className="translation">{lookup.translation}</div>
              {lookup.notes && <div className="notes">{lookup.notes}</div>}
            </>
          )}
          <Encounters
            hits={encHits}
            open={encOpen}
            onToggle={onToggleEncounters}
          />
          <WordHist hist={wordHist} />
        </>
      )}

      {qa.length > 0 && (
        <div className="qa">
          {qa.map((item, i) => (
            <div key={i} className="qa-item">
              <div className="qa-q">{item.q}</div>
              <div className="qa-a">{item.a ?? "…"}</div>
            </div>
          ))}
        </div>
      )}
      <input
        ref={askInputRef}
        className="ask-input"
        type="text"
        placeholder="ask…"
        value={askText}
        onChange={(e) => setAskText(e.target.value)}
        onFocus={onAskFocus}
        onBlur={onAskBlur}
        onKeyDown={(e) => {
          if (e.key === "Enter") onAsk();
          else if (e.key === "Escape") onClose();
        }}
      />
    </div>
  );
}
