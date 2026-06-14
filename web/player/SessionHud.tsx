// The `.session-hud` overlay (toggled with `o`). Pure presentation — the
// session counters live in refs owned by Player.tsx; the parent reads them and
// passes the already-computed display values. Extracted from Player.tsx.
//
// G4: also surfaces the immersion timer — this session's focused minutes vs the
// daily minutes goal (zr.goal.minutesPerDay, see web/timer.ts). The driving
// datum is the session elapsed (`mins`), the same value already shown; we read
// the goal target from localStorage on render (cheap; the HUD re-renders on a
// 1s tick while open).

import {
  loadMinutesGoal,
  minutesFraction,
  minutesGoalMet,
} from "../timer.ts";

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
  const goal = loadMinutesGoal();
  const frac = minutesFraction(mins, goal);
  const met = minutesGoalMet(mins, goal);
  return (
    <div className="session-hud" data-testid="session-hud">
      <div>
        {mins}m · {cues} cues · {pct}% known · {mined} mined · {cards} cards ·{" "}
        {unk} unk
      </div>
      <div
        data-testid="immersion-timer"
        title="Focused watch time this session vs your daily immersion goal"
      >
        immersion {mins} / {goal} min{met ? " ✓" : ""}
        <span
          aria-hidden="true"
          style={{
            display: "inline-block",
            width: "5em",
            height: "0.4em",
            marginLeft: "0.5em",
            verticalAlign: "middle",
            background: "currentColor",
            opacity: 0.25,
          }}
        >
          <span
            style={{
              display: "block",
              width: `${Math.round(frac * 100)}%`,
              height: "100%",
              background: "currentColor",
              opacity: met ? 1 : 0.8,
            }}
          />
        </span>
      </div>
    </div>
  );
}
