// #/home — Home / onboarding page: a quiet "Today" study summary, a "how it
// works" walkthrough, the hotkey cheatsheet grid, and the current library root.
// Extracted verbatim from App.tsx (behavior-preserving).

import { useEffect, useState } from "react";
import { api } from "./api.ts";
import { HOTKEYS } from "./commands.ts";

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
    { label: "day streak", value: today.streak },
  ].filter((t, i) => i < 4 || t.value > 0); // hide a 0-day streak tile
  return (
    <section className="today-panel card">
      <h2 className="h2">Today</h2>
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
