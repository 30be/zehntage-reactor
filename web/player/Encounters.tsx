// Shared "encounters: N" block for word-lookup popups (player + read mode).
// Presentational/controlled: the owner fetches the hits (api.indexEncounters)
// and owns the expand/collapse state. Renders the collapsible cue list with
// "watch in context" deep-links into the player (#/play/<id>@<t>). Extracted
// from LookupPanel so the Read-mode popup reaches player parity. Markup/classes
// are byte-equivalent to the original LookupPanel `.enc` block — reuses the
// existing .enc / .enc-line / .enc-list / .enc-hit / .enc-meta CSS.

import type { EncounterHit } from "../api.ts";
import { fmtTime } from "./shared.ts";

export function Encounters({
  hits,
  open,
  onToggle,
}: {
  hits: EncounterHit[] | null;
  open: boolean;
  onToggle: () => void;
}) {
  if (!hits || hits.length === 0) return null;
  return (
    <div className="enc">
      <div
        className="enc-line"
        title="Where else this word appears in the library"
        onClick={onToggle}
      >
        encounters: {hits.reduce((s, h) => s + h.count, 0)}
      </div>
      {open && (
        <div className="enc-list">
          {hits
            .flatMap((h) =>
              h.cues.map((c) => ({
                mediaId: h.mediaId,
                name: h.name,
                start: c.start,
                text: c.text,
              })),
            )
            .slice(0, 20)
            .map((s, i) => (
              <div
                key={`${s.mediaId}:${s.start}:${i}`}
                className="enc-hit"
                onClick={() => {
                  window.location.hash = `#/play/${s.mediaId}@${s.start}`;
                }}
              >
                <span className="enc-meta">
                  {s.name.replace(/\.[^.]+$/, "")} · {fmtTime(s.start)}
                </span>{" "}
                {s.text}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
