// End-of-episode `.session-summary` overlay. Pure presentation — the summary
// object is built and owned by Player.tsx (auto-next lifecycle). Extracted from
// Player.tsx.

export interface SessionSummaryData {
  min: number;
  cues: number;
  lookups: number;
  cards: number;
  known: number;
  echo: { tried: number; perfect: number };
  streak: number | null;
}

export function SessionSummary({ summary }: { summary: SessionSummaryData }) {
  return (
    <div className="session-summary">
      <div className="ss-title">session</div>
      <div className="ss-line">
        {summary.min} min · {summary.cues} cues
      </div>
      <div className="ss-line">
        {summary.lookups} lookups · {summary.cards} cards ·{" "}
        {summary.known} marked known
      </div>
      {summary.echo.tried > 0 && (
        <div className="ss-line ss-dim">
          echo: {summary.echo.tried} tried ·{" "}
          {summary.echo.perfect} perfect
        </div>
      )}
      {summary.streak != null && (
        <div className="ss-line ss-dim">
          streak: {summary.streak} day
          {summary.streak === 1 ? "" : "s"}
        </div>
      )}
      <div className="ss-line ss-dim">
        next episode in 5s — any key cancels
      </div>
    </div>
  );
}
