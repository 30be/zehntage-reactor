// #/home — Home / onboarding page: a quiet "Today" study summary, a "how it
// works" walkthrough, the hotkey cheatsheet grid, and the current library root.
// Extracted verbatim from App.tsx (behavior-preserving).

import { useEffect, useState } from "react";
import { api } from "./api.ts";
import { HOTKEYS } from "./commands.ts";
import {
  clampGoal,
  DEFAULT_GOAL,
  GOAL_KEY,
  goalFraction,
  goalMet,
  ringDashoffset,
} from "./goal.ts";

// Daily-goal ring for the Today panel: today's words-mined count vs a target
// kept in localStorage. SVG ring + center number + streak; the goal is nudged
// inline with +/- (persisted). Monochrome, in keeping with the zen aesthetic.
const RING_R = 34;
const RING_C = 2 * Math.PI * RING_R;

function loadGoal(): number {
  try {
    const raw = localStorage.getItem(GOAL_KEY);
    if (raw == null) return DEFAULT_GOAL;
    return clampGoal(Number(raw));
  } catch {
    return DEFAULT_GOAL;
  }
}

function saveGoal(goal: number): void {
  try {
    localStorage.setItem(GOAL_KEY, String(goal));
  } catch { /* ignore quota / disabled storage */ }
}

function TodayGoal({ value, streak }: { value: number; streak: number }) {
  const [goal, setGoal] = useState<number>(loadGoal);
  const nudge = (d: number) => {
    setGoal((g) => {
      const next = clampGoal(g + d);
      saveGoal(next);
      return next;
    });
  };
  const met = goalMet(value, goal);
  const pct = Math.round(goalFraction(value, goal) * 100);
  return (
    <div className={`today-goal${met ? " is-met" : ""}`}>
      <svg
        className="goal-ring"
        viewBox="0 0 80 80"
        role="img"
        aria-label={`${value} of ${goal} words mined today (${pct}%)`}
      >
        <circle className="goal-ring-track" cx="40" cy="40" r={RING_R} />
        <circle
          className="goal-ring-fill"
          cx="40"
          cy="40"
          r={RING_R}
          strokeDasharray={RING_C}
          strokeDashoffset={ringDashoffset(value, goal, RING_C)}
        />
        <text className="goal-ring-num" x="40" y="40">{value}</text>
        <text className="goal-ring-sub" x="40" y="54">/ {goal}</text>
      </svg>
      <div className="today-goal-meta">
        <div className="today-goal-ctl">
          <button
            type="button"
            className="goal-step"
            aria-label="lower daily goal"
            onClick={() => nudge(-1)}
          >
            −
          </button>
          <span className="goal-label">words/day{met ? " · done" : ""}</span>
          <button
            type="button"
            className="goal-step"
            aria-label="raise daily goal"
            onClick={() => nudge(1)}
          >
            +
          </button>
        </div>
        {streak > 0 && (
          <div className="today-goal-streak">
            <span className="stat-num">{streak}</span> day streak
          </div>
        )}
      </div>
    </div>
  );
}

// --- Home / onboarding ---
// (hotkey data lives in web/commands.ts — shared with the `?` overlay)

// Quiet summary of TODAY's study, from telemetry. Renders nothing until data
// arrives and nothing at all on a day with no activity (no empty shell).
function TodayPanel() {
  const [today, setToday] = useState<import("./api.ts").TodayStats | null>(null);
  useEffect(() => {
    void api.statsToday().then(setToday).catch(() => {});
  }, []);
  if (!today || !today.active) return null;
  const tiles: { label: string; value: number }[] = [
    { label: "words mined", value: today.wordsMined },
    { label: "cues watched", value: today.cuesWatched },
    { label: "minutes", value: today.minutes },
    { label: "quizzes", value: today.quizzes },
  ];
  return (
    <section className="today-panel card">
      <h2 className="h2">Today</h2>
      <TodayGoal value={today.wordsMined} streak={today.streak} />
      <div className="today-tiles">
        {tiles.map((t) => (
          <div key={t.label} className="stat">
            <span className="stat-num">{t.value}</span>
            {t.label}
          </div>
        ))}
      </div>
    </section>
  );
}

export function Home({ go }: { go: (h: string) => void }) {
  const [root, setRoot] = useState<{ root: string; count: number } | null>(null);
  useEffect(() => {
    void api.getRoot().then(setRoot).catch(() => {});
  }, []);
  return (
    <>
      <TodayPanel />
      <h2 className="h2">How it works</h2>
      <ol className="home-steps">
        <li>Pick an episode in the <a href="#/" onClick={() => go("#/")}>Library</a></li>
        <li>Hover or click words in the subtitles for instant lookups</li>
        <li>Hit (?) on a line for a grammar breakdown</li>
        <li>Cards land straight in Anki</li>
      </ol>
      <h2 className="h2">Hotkeys</h2>
      <div className="hotkey-grid">
        {(["player", "read", "global"] as const)
          .map((scope) => ({
            scope,
            rows: HOTKEYS.filter((h) => h.scope === scope),
          }))
          .filter((g) => g.rows.length > 0)
          .map((g) => (
            <section key={g.scope} className="hotkey-group">
              <h3 className="hotkey-group-title">{g.scope}</h3>
              <div className="hotkey-items">
                {g.rows.map((h) => (
                  <div key={`${h.scope}:${h.keys}`} className="hotkey">
                    <kbd className="hotkey-key">{h.keys}</kbd>
                    <span className="hotkey-desc">{h.what}</span>
                  </div>
                ))}
              </div>
            </section>
          ))}
      </div>
      <div className="home-root muted">
        Current library: {root ? `${root.root} · ${root.count} entries` : "…"}
      </div>
      <div className="home-attrib muted">
        Pitch accent data: Kanjium (Uros O.), CC BY-SA 4.0
      </div>
    </>
  );
}

export default Home;
