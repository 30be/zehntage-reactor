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
import { localDateStr } from "./statsfmt.ts";
import {
  loadCachedWordOfDay,
  pickWordOfDay,
  saveCachedWordOfDay,
  type WordOfDay,
} from "./wordday.ts";

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
// arrives; shows an inline offline note if AnkiConnect is unreachable; renders
// the ring even on zero-activity days so new users see the goal.
function TodayPanel() {
  const [today, setToday] = useState<import("./api.ts").TodayStats | null>(null);
  const [ankiErr, setAnkiErr] = useState(false);
  useEffect(() => {
    void api.statsToday().then((data) => {
      setAnkiErr(false);
      setToday(data);
    }).catch(() => {
      setAnkiErr(true);
    });
  }, []);
  if (ankiErr) {
    return (
      <section className="today-panel card">
        <h2 className="h2">Today</h2>
        <p className="muted" style={{ margin: "0.5rem 0" }}>
          Anki offline — open Anki to see today's stats.
        </p>
      </section>
    );
  }
  // Still loading
  if (today === null) return null;
  // Loaded: render ring even when inactive/zero so new users see the goal widget
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
      {today.wordsMined === 0 && (
        <p className="muted" style={{ margin: "0.25rem 0 0.5rem", fontSize: "0.85em" }}>
          Mine your first word today!
        </p>
      )}
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

// G5 — "Word of the day": resurface ONE previously-learned deck word per day to
// passively reinforce it (word · reading · meaning + a deep-link into a clip
// where it appears). Deterministic per day (cached in localStorage); the deck +
// progress drive the pick, with a best-effort encounter for the context link.
function WordOfDayCard({ go }: { go: (h: string) => void }) {
  const [pick, setPick] = useState<WordOfDay | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [ankiErr, setAnkiErr] = useState(false);
  useEffect(() => {
    let alive = true;
    const day = localDateStr(new Date());
    const cached = loadCachedWordOfDay(day);
    if (cached) setPick(cached);
    void api.ankiWords().then((res) => {
      if (!alive) return;
      setAnkiErr(false);
      // The deck may hold unrelated cards (chemistry, quantum-computing, …).
      // Keep only OURS — mirror the server-side /api/anki/cards filter: a card
      // qualifies if it carries the "zehntage" tag (local AnkiConnect path, not
      // declared on the AnkiWord type so read defensively) OR its context holds
      // our source line ("<episode>.mkv @ mm:ss"). The wire payload from
      // /api/anki/words ships the raw cards including `tags`/`context`.
      const ours = res.words.filter((w) => {
        const tags = (w as { tags?: unknown }).tags;
        if (Array.isArray(tags) && tags.includes("zehntage")) return true;
        return /\.(mkv|mp4)\s*@\s*\d+:\d{2}/i.test(w.context ?? "");
      });
      // If nothing qualifies, pickWordOfDay returns null below and we render
      // nothing — no crash, no foreign card.
      const chosen = pickWordOfDay(ours, res.progress, day);
      if (!chosen) return;
      setPick(chosen);
      saveCachedWordOfDay(day, chosen);
    }).catch(() => {
      if (!alive) return;
      // Only set error if we have no cached word to show
      if (!cached) setAnkiErr(true);
    });
    return () => {
      alive = false;
    };
  }, []);
  // Best-effort "watch in context" deep-link from the encounter index.
  useEffect(() => {
    if (!pick) return;
    let alive = true;
    void api.indexEncounters(pick.word).then((hits) => {
      if (!alive) return;
      const hit = hits.find((h) => h.cues && h.cues.length > 0);
      const cue = hit?.cues?.[0];
      if (hit && cue) {
        setLink(`#/play/${hit.mediaId}@${Math.floor(cue.start)}`);
      }
    }).catch(() => {});
    return () => {
      alive = false;
    };
  }, [pick]);
  if (ankiErr) {
    return (
      <section className="today-panel card wordday-card">
        <h2 className="h2">Word of the day</h2>
        <p className="muted" style={{ margin: "0.5rem 0" }}>
          Anki offline — open Anki to see today's word.
        </p>
      </section>
    );
  }
  if (!pick) return null;
  return (
    <section className="today-panel card wordday-card">
      <h2 className="h2">Word of the day</h2>
      <div className="wordday-body">
        <span className="wordday-word" style={{ color: "var(--accent-known, #7aa2f7)" }}>
          {pick.word}
          {pick.reading ? <span className="wordday-reading muted"> （{pick.reading}）</span> : null}
        </span>
        <span className="wordday-meaning">{pick.meaning}</span>
        {link
          ? (
            <a
              className="wordday-link"
              href={link}
              onClick={(e) => {
                e.preventDefault();
                go(link);
              }}
            >
              watch in context →
            </a>
          )
          : null}
      </div>
    </section>
  );
}

export function Home({ go }: { go: (h: string) => void }) {
  const [root, setRoot] = useState<{ root: string; count: number } | null>(null);
  const [rootErr, setRootErr] = useState(false);
  useEffect(() => {
    void api.getRoot().then((data) => {
      setRootErr(false);
      setRoot(data);
    }).catch(() => {
      setRootErr(true);
    });
  }, []);
  return (
    <>
      <TodayPanel />
      <WordOfDayCard go={go} />
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
        Current library:{" "}
        {rootErr ? "(unavailable)" : root ? `${root.root} · ${root.count} entries` : "…"}
      </div>
      <div className="home-attrib muted">
        Pitch accent data: Kanjium (Uros O.), CC BY-SA 4.0
      </div>
    </>
  );
}

export default Home;
