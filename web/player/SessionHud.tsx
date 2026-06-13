// The `.session-hud` overlay (toggled with `o`). Pure presentation — the
// session counters live in refs owned by Player.tsx; the parent reads them and
// passes the already-computed display values. Extracted from Player.tsx.

export function SessionHud({
  mins,
  cues,
  pct,
  mined,
  cards,
  unk,
}: {
  mins: number;
  cues: number;
  pct: number;
  mined: number;
  cards: number;
  unk: number;
}) {
  return (
    <div className="session-hud" data-testid="session-hud">
      {mins}m · {cues} cues · {pct}% known · {mined} mined · {cards} cards ·{" "}
      {unk} unk
    </div>
  );
}
