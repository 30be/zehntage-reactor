// #/stats — Stats dashboard: known-words/cards totals, an activity heatmap,
// last-14-days + per-episode watch time, episode pace (with CSV export),
// cards/min + cumulative cards, comprehension trend, and per-episode coverage.
// Extracted verbatim from App.tsx (behavior-preserving).

import { useEffect, useState } from "react";
import {
  api,
  type AnkiWordsResponse,
  type LibraryEntry,
} from "./api.ts";
import { readKnownWords, useCoverage } from "./coverage.ts";
import { useApi } from "./useApi.ts";
import { activityShade, fmtMin, localDateStr } from "./statsfmt.ts";

/** Enter/Space → activate, for role="button" containers (a11y). */
function onActivateKey(handler: () => void) {
  return (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handler();
    }
  };
}

// Maturity threshold for "known" in Anki terms (interval >= 21 days).
const MATURE_INTERVAL = 21;

// Stats pure helpers live in ./statsfmt.ts (DOM-free, unit-tested there).

/** GitHub-style activity grid: last ~20 weeks of daily playing minutes. */
function ActivityGrid({ byDate }: { byDate: Map<string, number> }) {
  if (byDate.size === 0) return null;
  // End on today; start 139 days earlier, aligned back to Monday.
  const days: { date: string; min: number }[] = [];
  const start = new Date();
  start.setDate(start.getDate() - 139);
  while (start.getDay() !== 1) start.setDate(start.getDate() - 1);
  const today = localDateStr(new Date());
  for (const d = new Date(start); ; d.setDate(d.getDate() + 1)) {
    const key = localDateStr(d);
    days.push({ date: key, min: Math.round((byDate.get(key) ?? 0) / 60) });
    if (key === today) break;
  }
  return (
    <div className="activity-grid" role="img" aria-label="Activity heatmap" data-days={days.length}>
      {days.map((d) => (
        <span
          key={d.date}
          className={`activity-cell s${activityShade(d.min)}`}
          title={`${d.date}: ${d.min} min`}
          aria-label={d.min > 0 ? `${d.date}: ${d.min} min` : undefined}
        />
      ))}
    </div>
  );
}

// One point of the vocab-growth series from GET /api/stats/growth.
interface GrowthPoint {
  date: string;
  count: number;
  cumulative: number;
}

// Fetched directly (not via the api.ts client) like the old inline effect did.
function fetchGrowth(): Promise<GrowthPoint[]> {
  return fetch("/api/stats/growth").then((r) =>
    r.ok ? (r.json() as Promise<GrowthPoint[]>) : Promise.reject(r.status),
  );
}

type LoadState = "loading" | "error" | "ok";

function SectionLoad({
  state,
  label,
}: {
  state: LoadState;
  label: string;
}) {
  if (state === "loading")
    return (
      <div className="state" role="status" aria-label={`Loading ${label}`}>
        <span className="spinner" aria-hidden /> Loading…
      </div>
    );
  if (state === "error")
    return (
      <div className="state error" role="alert">
        Failed to load {label}.
      </div>
    );
  return null;
}

export function Stats({ go }: { go: (h: string) => void }) {
  const [entries, setEntries] = useState<LibraryEntry[] | null>(null);
  const [anki, setAnki] = useState<AnkiWordsResponse | null>(null);
  const [ankiErr, setAnkiErr] = useState(false);
  const { data: summary, state: summaryState } = useApi(api.statsSummary);
  const { data: episodes, state: episodesState } = useApi(api.statsEpisodes);
  const { data: ov, state: ovState } = useApi(api.statsOverview);
  const { data: comp, state: compState } = useApi(api.statsComprehension);
  // Vocab growth (G2): fetched directly like other Stats sections.
  const { data: growth, state: growthState } = useApi(fetchGrowth);
  // Per-episode coverage, computed in idle time (web/coverage.ts hook).
  const coverage = useCoverage(entries, anki);

  useEffect(() => {
    void api.library().then(setEntries).catch(() => setEntries([]));
    void api
      .ankiWords()
      .then(setAnki)
      .catch(() => { setAnki({ words: [], progress: {} }); setAnkiErr(true); });
  }, []);

  const localKnown = readKnownWords().size;
  const mature = anki
    ? Object.values(anki.progress).filter((p) => p.interval >= MATURE_INTERVAL)
        .length
    : 0;
  const withSubs = entries?.filter((e) => e.subLangs.length > 0) ?? [];

  return (
    <>
      <div className="stats-totals">
        <div className="stat">
          <span className="stat-num">{anki ? mature + localKnown : "…"}</span>
          words known{ankiErr && (
            <span className="muted" style={{ fontSize: "0.75em", display: "block" }}>
              (+Anki unavailable)
            </span>
          )}
        </div>
        <div className="stat">
          <span className="stat-num">{anki ? anki.words.length : "…"}</span>
          words added{ankiErr && (
            <span className="muted" style={{ fontSize: "0.75em", display: "block" }}>
              (+Anki unavailable)
            </span>
          )}
        </div>
      </div>

      <h2 className="h2">Activity</h2>
      <div className="section-intro muted">
        Daily watch time over the last ~20 weeks — darker means more minutes.
      </div>
      {summaryState !== "ok" ? (
        <SectionLoad state={summaryState} label="activity" />
      ) : (summary?.days ?? []).length === 0 ? (
        <div className="empty">No watch activity yet — play an episode to start tracking.</div>
      ) : (
        <ActivityGrid
          byDate={
            new Map((summary?.days ?? []).map((d) => [d.date, d.playSec]))
          }
        />
      )}

      {summary && summary.days.length > 0 && (
        <>
          <h2 className="h2">Last 14 days</h2>
          <div className="section-intro muted">
            Watch time per day, with cards added and word lookups.
          </div>
          <div className="daily-list">
            {(() => {
              const days = summary.days.slice(-14).reverse();
              const max = Math.max(1, ...days.map((d) => d.playSec));
              return days.map((d) => (
                <div key={d.date} className="daily-row">
                  <span className="daily-date">{d.date}</span>
                  <span className="stats-bar">
                    <span
                      className="stats-fill dim"
                      style={{ width: `${(d.playSec / max) * 100}%` }}
                    />
                  </span>
                  <span className="daily-min">{fmtMin(d.playSec)}</span>
                  <span className="daily-extra muted">
                    {d.ankiAdds} cards · {d.lookups} lookups
                  </span>
                </div>
              ));
            })()}
          </div>
        </>
      )}

      {summary && summary.media.length > 0 && (
        <>
          <h2 className="h2">Per episode (watch time)</h2>
          <div className="section-intro muted">
            Total wall-clock time per episode. ×coef = wall / content time
            (how much you pause and replay) — click a row to rewatch.
          </div>
          <div className="daily-list">
            {(() => {
              const media = summary.media.slice(0, 20);
              const max = Math.max(1, ...media.map((m) => m.wallSec));
              return media.map((m) => {
                const e = entries?.find((x) => x.id === m.mediaId);
                const name = (e?.name ?? m.mediaId).replace(/\.[^.]+$/, "");
                const coef =
                  m.contentSec > 0 ? (m.wallSec / m.contentSec).toFixed(2) : "—";
                return (
                  <div
                    key={m.mediaId}
                    className="daily-row media-row"
                    role="button"
                    tabIndex={0}
                    onClick={() => go(`#/play/${m.mediaId}`)}
                    onKeyDown={onActivateKey(() => go(`#/play/${m.mediaId}`))}
                  >
                    <span className="daily-date ep-trunc" title={name}>
                      {name}
                    </span>
                    <span className="stats-bar">
                      <span
                        className="stats-fill dim"
                        style={{ width: `${(m.wallSec / max) * 100}%` }}
                      />
                    </span>
                    <span className="daily-min">{fmtMin(m.wallSec)}</span>
                    <span className="daily-extra muted">
                      ×{coef} · {m.ankiAdds} cards · {m.lookups} lookups
                    </span>
                  </div>
                );
              });
            })()}
          </div>
        </>
      )}

      {episodesState !== "ok" && episodesState !== "loading" ? (
        <>
          <h2 className="h2">Episode pace</h2>
          <SectionLoad state={episodesState} label="episode pace" />
        </>
      ) : episodesState === "loading" ? null : episodes && episodes.length > 0 && (
        <>
          <h2 className="h2">
            Episode pace{" "}
            <a className="csv-link" href="/api/stats/episodes.csv" download>
              Export CSV
            </a>
          </h2>
          <div className="section-intro muted">
            One row per episode and day: solid bar = wall time, faint bar =
            content covered. Rows are grouped by episode.
          </div>
          <div className="ep-series">
            {(() => {
              // grouped by media, then chronological; cap at the last 60 rows
              const rows = episodes
                .slice()
                .sort((a, b) =>
                  a.mediaId !== b.mediaId
                    ? a.mediaId.localeCompare(b.mediaId)
                    : a.date < b.date
                      ? -1
                      : 1,
                )
                .slice(-60);
              const max = Math.max(
                1,
                ...rows.map((r) =>
                  Math.max(r.wallPlayingSec + r.wallPausedSec, r.contentSec),
                ),
              );
              const epName = (id: string) => {
                const e = entries?.find((x) => x.id === id);
                return e?.name
                  ? e.name.replace(/\.[^.]+$/, "")
                  : `episode ${id.slice(0, 8)}`;
              };
              const out: React.ReactNode[] = [];
              for (let i = 0; i < rows.length; i++) {
                const r = rows[i]!;
                const wall = r.wallPlayingSec + r.wallPausedSec;
                const isFirst = i === 0 || rows[i - 1]!.mediaId !== r.mediaId;
                if (isFirst) {
                  out.push(
                    <div
                      key={`hdr ${r.mediaId}`}
                      className="ep-group-header"
                      title={epName(r.mediaId)}
                    >
                      {epName(r.mediaId)}
                    </div>,
                  );
                }
                out.push(
                  <div key={`${r.mediaId} ${r.date}`} className="ep-row">
                    <span className="ep-name muted">{r.date}</span>
                    <span className="ep-bars">
                      <span
                        className="ep-bar wall"
                        title={`wall ${fmtMin(wall)}`}
                        style={{ width: `${(wall / max) * 100}%` }}
                      />
                      <span
                        className="ep-bar content"
                        title={`content ${fmtMin(r.contentSec)}`}
                        style={{ width: `${(r.contentSec / max) * 100}%` }}
                      />
                    </span>
                    <span
                      className="ep-coef muted"
                      title="wall / content time for this day"
                    >
                      {r.coefficient != null
                        ? `×${r.coefficient.toFixed(2)}`
                        : "—"}
                    </span>
                  </div>,
                );
              }
              return out;
            })()}
          </div>
        </>
      )}

      {ovState === "error" ? (
        <>
          <h2 className="h2">Cards / min (30 days, 7d rolling)</h2>
          <SectionLoad state="error" label="cards/min overview" />
        </>
      ) : ov && (
        <>
          <h2 className="h2">Cards / min (30 days, 7d rolling)</h2>
          <div className="section-intro muted">
            Mining intensity: cards added per minute of watching, smoothed over
            a 7-day window.
          </div>
          <div className="cpm-chart">
            {(() => {
              const vals = ov.last30Days.map((d) =>
                d.wallPlayingSec > 0 ? d.ankiAdds / (d.wallPlayingSec / 60) : 0,
              );
              const roll = vals.map((_, i) => {
                const a = vals.slice(Math.max(0, i - 6), i + 1);
                return a.reduce((s, x) => s + x, 0) / a.length;
              });
              const max = Math.max(0.01, ...roll);
              return ov.last30Days.map((d, i) => (
                <span
                  key={d.date}
                  className="cpm-col"
                  title={`${d.date}: ${roll[i]!.toFixed(2)} cards/min`}
                  style={{ height: `${Math.max(2, (roll[i]! / max) * 100)}%` }}
                />
              ));
            })()}
          </div>
          {ov.ankiCumulative.length > 0 && (
            <>
              <h2 className="h2">Cumulative cards</h2>
              <div className="section-intro muted">
                Total deck size over time.
              </div>
              <div className="cum-chart">
                {(() => {
                  const max =
                    ov.ankiCumulative[ov.ankiCumulative.length - 1]!.total || 1;
                  return ov.ankiCumulative.map((p) => (
                    <span
                      key={p.date}
                      className="cum-col"
                      title={`${p.date}: ${p.total}`}
                      style={{ height: `${Math.max(2, (p.total / max) * 100)}%` }}
                    />
                  ));
                })()}
              </div>
            </>
          )}
        </>
      )}

      {compState === "error" ? (
        <>
          <h2 className="h2">Comprehension trend</h2>
          <SectionLoad state="error" label="comprehension trend" />
        </>
      ) : comp && comp.quizzes > 0 && (
        <>
          <h2 className="h2">Comprehension trend</h2>
          <div className="section-intro muted">
            Score on each comprehension quiz (q) over time — taller bar means a
            higher share of questions answered correctly.
          </div>
          <div className="stats-totals">
            <div className="stat">
              <span className="stat-num">{comp.avgPct}%</span>
              avg comprehension
            </div>
            <div className="stat">
              <span className="stat-num">{comp.quizzes}</span>
              quizzes taken
            </div>
          </div>
          <div className="comp-chart">
            {comp.points.slice(-40).map((p, i) => (
              <span
                key={`${p.ts}:${i}`}
                className="comp-col"
                title={`${p.date}: ${p.correct}/${p.total} (${p.pct}%)`}
                style={{ height: `${Math.max(2, p.pct)}%` }}
              />
            ))}
          </div>
        </>
      )}

      {growthState === "error" ? (
        <>
          <h2 className="h2">Vocabulary growth</h2>
          <SectionLoad state="error" label="vocabulary growth" />
        </>
      ) : growthState === "loading" ? (
        <>
          <h2 className="h2">Vocabulary growth</h2>
          <SectionLoad state="loading" label="vocabulary growth" />
        </>
      ) : (
        growth && (
          <>
            <h2 className="h2">Vocabulary growth</h2>
            <div className="section-intro muted">
              Cumulative words mined over time (since tracking began) — each bar
              is your total deck size on a day you added cards.
            </div>
            {growth.length === 0 ? (
              <div className="empty">No words mined yet.</div>
            ) : (
              <>
                <div className="stats-totals">
                  <div className="stat">
                    <span className="stat-num">
                      {growth[growth.length - 1]!.cumulative}
                    </span>
                    words mined
                  </div>
                  <div className="stat">
                    <span className="stat-num">{growth.length}</span>
                    active days
                  </div>
                </div>
                <div className="cum-chart">
                  {(() => {
                    const max = growth[growth.length - 1]!.cumulative || 1;
                    return growth.map((p) => (
                      <span
                        key={p.date}
                        className="cum-col"
                        title={`${p.date}: ${p.cumulative} total (+${p.count})`}
                        style={{
                          height: `${Math.max(2, (p.cumulative / max) * 100)}%`,
                        }}
                      />
                    ));
                  })()}
                </div>
              </>
            )}
          </>
        )
      )}

      <h2 className="h2">Coverage</h2>
      <div className="section-intro muted">
        Share of words in each episode you already know — click a row to watch.
      </div>
      {entries == null && (
        <div className="state" role="status">
          <span className="spinner" aria-hidden /> Loading…
        </div>
      )}
      {entries != null && withSubs.length === 0 && (
        <div className="empty">No episodes with subtitles.</div>
      )}
      <div className="stats-list">
        {withSubs.map((e) => {
          const c = coverage.get(e.id);
          return (
            <div
              key={e.id}
              className="stats-row"
              role="button"
              tabIndex={0}
              onClick={() => go(`#/play/${e.id}`)}
              onKeyDown={onActivateKey(() => go(`#/play/${e.id}`))}
            >
              <span className="stats-name">{e.name.replace(/\.[^.]+$/, "")}</span>
              <span className="stats-bar">
                <span
                  className="stats-fill"
                  style={{ width: `${c?.pct ?? 0}%` }}
                />
              </span>
              <span className="stats-cov">
                {c
                  ? `${c.pct}% · ${c.newCount} new`
                  : c === null
                    ? "no ja"
                    : "…"}
              </span>
            </div>
          );
        })}
      </div>
    </>
  );
}

export default Stats;
