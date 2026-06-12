import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  type AnkiWordsResponse,
  type BatchStatus,
  type LibraryEntry,
} from "./api.ts";
import { Player } from "./Player.tsx";
import { computeCoverage, readKnownWords, type Coverage } from "./coverage.ts";
import { buildWordIndex } from "./progress.ts";
import { kataToHira } from "./tokenizer.ts";
import { tmEvent, tmStart } from "./telemetry.ts";

type Route =
  | { name: "library" }
  | { name: "player"; id: string; t?: number }
  | { name: "settings" }
  | { name: "stats" }
  | { name: "home" };

function parseHash(): Route {
  const h = window.location.hash.replace(/^#\/?/, "");
  if (h.startsWith("play/")) {
    // "#/play/<id>" or "#/play/<id>@123.4" (seek after load)
    const rest = h.slice("play/".length);
    const at = rest.indexOf("@");
    const id = at >= 0 ? rest.slice(0, at) : rest;
    const t = at >= 0 ? parseFloat(rest.slice(at + 1)) : NaN;
    return { name: "player", id, ...(Number.isFinite(t) && t >= 0 ? { t } : {}) };
  }
  if (h === "settings") return { name: "settings" };
  if (h === "stats") return { name: "stats" };
  if (h === "home") return { name: "home" };
  return { name: "library" };
}

const LAST_MEDIA_KEY = "zr.lastMedia";

function readLastMedia(): string | null {
  try {
    return localStorage.getItem(LAST_MEDIA_KEY);
  } catch {
    return null;
  }
}

function fmtSize(n: number): string {
  if (n > 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n > 1e6) return `${(n / 1e6).toFixed(0)} MB`;
  return `${(n / 1e3).toFixed(0)} KB`;
}

export function App() {
  const [route, setRoute] = useState<Route>(parseHash());
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [settings, setSettings] = useState<Record<string, unknown>>({});

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    void api.getSettings().then(setSettings).catch(() => {});
    tmStart();
  }, []);

  // Telemetry: one route_change event per navigation.
  useEffect(() => {
    tmEvent("route_change", {
      route: route.name,
      ...(route.name === "player" ? { mediaId: route.id } : {}),
    });
  }, [route]);

  // "View" nav target: the current/last-played episode.
  const lastMedia =
    route.name === "player" ? route.id : readLastMedia();

  // Keep the pending hide-timer so a second toast isn't cleared early by the
  // first toast's timeout.
  const toastTimer = useRef<number | null>(null);
  const toast = useCallback((msg: string) => {
    if (toastTimer.current != null) window.clearTimeout(toastTimer.current);
    setToastMsg(msg);
    toastTimer.current = window.setTimeout(() => {
      toastTimer.current = null;
      setToastMsg(null);
    }, 2600);
  }, []);

  const go = (hash: string) => {
    window.location.hash = hash;
  };

  const navItem = (
    label: string,
    icon: string,
    hash: string,
    active: boolean,
    disabled = false,
  ) => (
    <button
      className={`side-item${active ? " active" : ""}`}
      disabled={disabled}
      title={label}
      onClick={() => go(hash)}
    >
      <span className="side-icon" aria-hidden>{icon}</span>
      <span className="side-label">{label}</span>
    </button>
  );

  return (
    <div className="app shell">
      <aside className="sidebar">
        <a className="brand side-brand" href="#/home" title="Home">
          <span className="side-icon" aria-hidden>十</span>
          <span className="side-label">zehntage</span>
        </a>
        <nav className="side-nav">
          {navItem("Home", "⌂", "#/home", route.name === "home")}
          {navItem("Library", "▤", "#/", route.name === "library")}
          {navItem(
            "View",
            "▶",
            lastMedia ? `#/play/${lastMedia}` : "#/",
            route.name === "player",
            !lastMedia,
          )}
          {navItem("Stats", "∿", "#/stats", route.name === "stats")}
          {navItem("Settings", "⚙", "#/settings", route.name === "settings")}
        </nav>
      </aside>

      <main className="container">
        {route.name === "home" && <Home go={go} />}
        {route.name === "library" && <Library go={go} toast={toast} />}
        {route.name === "stats" && <Stats go={go} />}
        {route.name === "settings" && (
          <Settings settings={settings} setSettings={setSettings} toast={toast} go={go} />
        )}
        {route.name === "player" && (
          <PlayerRoute
            id={route.id}
            startAt={route.t}
            toast={toast}
            settings={settings}
            go={go}
          />
        )}
      </main>

      {toastMsg && <div className="toast">{toastMsg}</div>}
    </div>
  );
}

function fmtCueTime(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Saved resume position (seconds) from localStorage, or null. */
function savedPos(id: string): number | null {
  try {
    const v = parseFloat(localStorage.getItem(`zr.pos.${id}`) ?? "");
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

/** Per-entry status badge text from the batch status, or null. */
function entryBadge(status: BatchStatus | null, entryId: string): string | null {
  if (!status) return null;
  const jobs = status.whisper.filter((j) => j.entryId === entryId);
  const w = jobs[jobs.length - 1];
  const t = status.translate
    .filter((i) => i.entryId === entryId)
    .slice(-1)[0];
  if (w?.status === "running")
    return w.lastCue !== null ? `whisper ${fmtCueTime(w.lastCue)}…` : "whisper…";
  if (w?.status === "extracting") return "whisper…";
  if (w?.status === "queued") return "whisper queued";
  if (t?.status === "running") return "translating…";
  if (t?.status === "queued") return "translate queued";
  if (w?.status === "error" || t?.status === "error") return "error";
  if (w?.status === "done" || t?.status === "done") return "✓";
  return null;
}

/** Idle-time helper: resolves in an idle slice (setTimeout fallback). */
function idle(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    // Resolve immediately when aborted — a never-settling promise would leave
    // the caller's async loop suspended forever. Callers re-check the signal.
    if (signal.aborted) return resolve();
    if (typeof requestIdleCallback === "function")
      requestIdleCallback(() => resolve(), { timeout: 2000 });
    else setTimeout(resolve, 200);
  });
}

interface SearchHit {
  mediaId: string;
  name: string;
  start: number;
  text: string;
}

/** Wrap the matched substring in <mark>, using the same katakana→hiragana
 * normalization as the server (1:1 length-preserving). */
function highlightMatch(text: string, q: string): React.ReactNode {
  const nq = kataToHira(q.trim().toLowerCase());
  if (!nq) return text;
  const i = kataToHira(text.toLowerCase()).indexOf(nq);
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + nq.length)}</mark>
      {text.slice(i + nq.length)}
    </>
  );
}

// --- Home / onboarding ---

const HOTKEYS: [string, string][] = [
  ["space", "play / pause"],
  ["f", "fullscreen"],
  ["← →", "prev / next cue (seek)"],
  ["↑ ↓", "volume"],
  ["a", "replay current cue"],
  ["s", "autopause mode (then digits 1-9: count)"],
  ["Tab / Shift+Tab", "cycle subtitle tracks"],
  ["n / p", "next / previous episode"],
  ["h", "hard mode (hide JP while playing)"],
  ["k", "mark hovered word known"],
  ["l", "toggle cue-list sidebar"],
  ["w", "pre-study panel (upcoming words)"],
  ["b", "hold to unblur translation"],
  ["i", "toggle furigana"],
  ["- / =", "playback speed"],
  ["[ / ] / \\", "subtitle offset − / + / reset"],
  ["Esc", "close popups / panels"],
];

function Home({ go }: { go: (h: string) => void }) {
  const [root, setRoot] = useState<{ root: string; count: number } | null>(null);
  useEffect(() => {
    void api.getRoot().then(setRoot).catch(() => {});
  }, []);
  return (
    <>
      <h1 className="h1">zehntage-reactor</h1>
      <p className="home-tagline">
        Watch Japanese video, mine words as you go — lookups, grammar, and Anki
        cards without leaving the player.
      </p>
      <h2 className="h2">How it works</h2>
      <ol className="home-steps">
        <li>Pick an episode in the <a href="#/" onClick={() => go("#/")}>Library</a></li>
        <li>Hover or click words in the subtitles for instant lookups</li>
        <li>Hit (?) on a line for a grammar breakdown</li>
        <li>Cards land straight in Anki</li>
      </ol>
      <h2 className="h2">Hotkeys</h2>
      <div className="hotkey-grid">
        {HOTKEYS.map(([k, desc]) => (
          <div key={k} className="hotkey-row">
            <span className="hotkey-key">{k}</span>
            <span className="hotkey-desc">{desc}</span>
          </div>
        ))}
      </div>
      <div className="home-root muted">
        Current library: {root ? `${root.root} · ${root.count} entries` : "…"}
      </div>
    </>
  );
}

// --- library root chooser (dim line above the cards) ---

function RootChooser({
  toast,
  onChanged,
}: {
  toast: (m: string) => void;
  onChanged: () => void;
}) {
  const [info, setInfo] = useState<{ root: string; count: number } | null>(null);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api.getRoot().then(setInfo).catch(() => {});
  }, []);

  const submit = async () => {
    const p = value.trim();
    if (!p) return;
    setBusy(true);
    try {
      const next = await api.setRoot(p);
      setInfo(next);
      setEditing(false);
      toast(`Library root set: ${next.root} (${next.count} entries)`);
      onChanged();
    } catch (e) {
      toast(`Set root failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(false);
    }
  };

  if (!editing) {
    return (
      <div
        className="root-line muted"
        title="Click to change the library root"
        onClick={() => {
          setValue(info?.root ?? "");
          setEditing(true);
        }}
      >
        {info ? `${info.root} · ${info.count} entries` : "…"}
      </div>
    );
  }
  return (
    <div className="root-line editing">
      <input
        type="text"
        className="root-input"
        autoFocus
        placeholder="/absolute/path/to/library"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void submit();
          if (e.key === "Escape") setEditing(false);
        }}
      />
      <button className="btn sm" disabled={busy} onClick={() => void submit()}>
        {busy ? "…" : "Set"}
      </button>
    </div>
  );
}

function Library({ go, toast }: { go: (h: string) => void; toast: (m: string) => void }) {
  const [entries, setEntries] = useState<LibraryEntry[] | null>(null);
  // --- transcript search (debounced 300ms; Esc clears) ---
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setHits(null);
      return;
    }
    let cancelled = false;
    const t = window.setTimeout(() => {
      void fetch(`/api/search?q=${encodeURIComponent(q)}`)
        .then((r) => (r.ok ? (r.json() as Promise<SearchHit[]>) : []))
        .then((res) => !cancelled && setHits(res))
        .catch(() => !cancelled && setHits([]));
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [query]);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<BatchStatus | null>(null);
  // entryId -> coverage ("82% · 47 new"); null = computed but no ja track
  const [coverage, setCoverage] = useState<Map<string, Coverage | null>>(
    () => new Map(),
  );

  // Auto-compute episode coverage in idle time: one episode at a time, only
  // entries with subs, abortable on unmount. Never blocks the UI.
  useEffect(() => {
    if (!entries || entries.length === 0) return;
    const ctrl = new AbortController();
    const { signal } = ctrl;
    void (async () => {
      const anki = await api
        .ankiWords()
        .catch(() => ({ words: [], progress: {} }));
      if (signal.aborted) return;
      const wordIndex = buildWordIndex(anki.words, anki.progress);
      const known = readKnownWords();
      for (const e of entries) {
        if (signal.aborted) return;
        if (e.subLangs.length === 0) continue;
        await idle(signal);
        if (signal.aborted) return;
        try {
          const cov = await computeCoverage(
            e.id,
            wordIndex,
            known,
            anki.words.length,
            signal,
          );
          if (signal.aborted) return;
          setCoverage((prev) => new Map(prev).set(e.id, cov));
        } catch {
          /* skip this entry — tokenizer/network hiccup */
        }
      }
    })();
    return () => ctrl.abort();
  }, [entries]);

  const loadEntries = useCallback(() => {
    void api
      .library()
      .then(setEntries)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const refreshStatus = useCallback(() => {
    void api.batchStatus().then(setStatus).catch(() => {});
  }, []);

  useEffect(() => {
    loadEntries();
    refreshStatus();
  }, [loadEntries, refreshStatus]);

  // Poll every 3s while anything is active; refresh entries when work settles
  // (new sidecar langs appear on the cards).
  const active = status?.active ?? false;
  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(refreshStatus, 3000);
    return () => {
      window.clearInterval(t);
      loadEntries();
    };
  }, [active, refreshStatus, loadEntries]);

  const onBatchAll = async () => {
    try {
      const r = await api.batchAll();
      toast(
        r.started.length > 0
          ? `Queued ${r.started.length} file(s) for ja + ru generation`
          : "Nothing to do — all entries have ja + ru subs",
      );
      refreshStatus();
    } catch (e) {
      toast(`Generate all failed: ${e instanceof Error ? e.message : e}`);
    }
  };

  if (error) return <div className="empty">Failed to load library: {error}</div>;
  if (!entries) return <div className="empty">Loading library…</div>;
  if (entries.length === 0)
    return (
      <>
        <h1 className="h1">Library</h1>
        <RootChooser toast={toast} onChanged={loadEntries} />
        <div className="empty">No video files found.</div>
      </>
    );

  return (
    <>
      <h1 className="h1">Library</h1>
      <RootChooser toast={toast} onChanged={loadEntries} />
      <input
        className="search-input"
        type="text"
        placeholder="search transcripts…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setQuery("");
        }}
      />
      {hits != null && (
        <div className="search-results">
          {hits.length === 0 && <div className="muted">no matches</div>}
          {hits.map((h, i) => (
            <div
              key={`${h.mediaId}:${h.start}:${i}`}
              className="search-hit"
              onClick={() => go(`#/play/${h.mediaId}@${h.start}`)}
            >
              <span className="search-meta">
                {h.name.replace(/\.[^.]+$/, "")} · {fmtCueTime(h.start)}
              </span>{" "}
              {highlightMatch(h.text, query)}
            </div>
          ))}
        </div>
      )}
      <div className="batchbar">
        <button className="btn sm" onClick={() => void onBatchAll()}>
          Generate all (ja + ru)
        </button>
      </div>
      <div className="grid">
        {entries.map((e) => (
          <div key={e.id} className="card" onClick={() => go(`#/play/${e.id}`)}>
            <div className="name">{e.name}</div>
            <div className="meta">
              {e.relPath} · {fmtSize(e.size)}
              {(() => {
                const p = savedPos(e.id);
                return p != null ? (
                  <span className="resume-hint"> · ▶ {fmtCueTime(p)}</span>
                ) : null;
              })()}
              {(() => {
                const c = coverage.get(e.id);
                return c ? (
                  <span className="cov-hint">
                    {" "}· {c.pct}% · {c.newCount} new
                  </span>
                ) : null;
              })()}
            </div>
            <div className="badges">
              {e.subLangs.length === 0 && <span className="badge">no subs</span>}
              {e.subLangs.map((l, i) => (
                <span key={i} className="badge">
                  {l}
                </span>
              ))}
              {(() => {
                const b = entryBadge(status, e.id);
                return b ? <span className="badge jobstatus">{b}</span> : null;
              })()}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

// Maturity threshold for "known" in Anki terms (interval >= 21 days).
const MATURE_INTERVAL = 21;

function localDateStr(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** GitHub-style activity grid: last ~20 weeks of daily playing minutes. */
function ActivityGrid({ byDate }: { byDate: Map<string, number> }) {
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
  const shade = (min: number) =>
    min <= 0 ? 0 : min < 10 ? 1 : min < 30 ? 2 : min < 60 ? 3 : 4;
  return (
    <div className="activity-grid" data-days={days.length}>
      {days.map((d) => (
        <span
          key={d.date}
          className={`activity-cell s${shade(d.min)}`}
          title={`${d.date}: ${d.min} min`}
        />
      ))}
    </div>
  );
}

function fmtMin(sec: number): string {
  return `${Math.round(sec / 60)} min`;
}

function Stats({ go }: { go: (h: string) => void }) {
  const [entries, setEntries] = useState<LibraryEntry[] | null>(null);
  const [anki, setAnki] = useState<AnkiWordsResponse | null>(null);
  const [summary, setSummary] = useState<import("./api.ts").StatsSummary | null>(null);

  useEffect(() => {
    void api.statsSummary().then(setSummary).catch(() => {});
  }, []);
  const [coverage, setCoverage] = useState<Map<string, Coverage | null>>(
    () => new Map(),
  );

  useEffect(() => {
    void api.library().then(setEntries).catch(() => setEntries([]));
    void api
      .ankiWords()
      .then(setAnki)
      .catch(() => setAnki({ words: [], progress: {} }));
  }, []);

  // Per-episode coverage, computed in idle time (same approach as Library).
  useEffect(() => {
    if (!entries || !anki || entries.length === 0) return;
    const ctrl = new AbortController();
    const { signal } = ctrl;
    void (async () => {
      const wordIndex = buildWordIndex(anki.words, anki.progress);
      const known = readKnownWords();
      for (const e of entries) {
        if (signal.aborted) return;
        if (e.subLangs.length === 0) continue;
        await idle(signal);
        if (signal.aborted) return;
        try {
          const cov = await computeCoverage(
            e.id,
            wordIndex,
            known,
            anki.words.length,
            signal,
          );
          if (signal.aborted) return;
          setCoverage((prev) => new Map(prev).set(e.id, cov));
        } catch {
          /* skip this entry */
        }
      }
    })();
    return () => ctrl.abort();
  }, [entries, anki]);

  const localKnown = readKnownWords().size;
  const mature = anki
    ? Object.values(anki.progress).filter((p) => p.interval >= MATURE_INTERVAL)
        .length
    : 0;
  const withSubs = entries?.filter((e) => e.subLangs.length > 0) ?? [];

  return (
    <>
      <h1 className="h1">Stats</h1>
      <div className="stats-totals">
        <div className="stat">
          <span className="stat-num">{anki ? mature + localKnown : "…"}</span>
          known words
        </div>
        <div className="stat">
          <span className="stat-num">{anki ? anki.words.length : "…"}</span>
          cards added
        </div>
      </div>

      <h2 className="h2">Activity</h2>
      <ActivityGrid
        byDate={
          new Map((summary?.days ?? []).map((d) => [d.date, d.playSec]))
        }
      />

      {summary && summary.days.length > 0 && (
        <>
          <h2 className="h2">Last 14 days</h2>
          <div className="daily-list">
            {summary.days.slice(-14).reverse().map((d) => (
              <div key={d.date} className="daily-row">
                <span className="daily-date">{d.date}</span>
                <span className="daily-min">{fmtMin(d.playSec)}</span>
                <span className="daily-extra muted">
                  {d.ankiAdds} cards · {d.lookups} lookups
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      {summary && summary.media.length > 0 && (
        <>
          <h2 className="h2">Per episode (watch time)</h2>
          <div className="daily-list">
            {summary.media.slice(0, 20).map((m) => {
              const e = entries?.find((x) => x.id === m.mediaId);
              const name = (e?.name ?? m.mediaId).replace(/\.[^.]+$/, "");
              const coef =
                m.contentSec > 0 ? (m.wallSec / m.contentSec).toFixed(2) : "—";
              return (
                <div
                  key={m.mediaId}
                  className="daily-row media-row"
                  onClick={() => go(`#/play/${m.mediaId}`)}
                >
                  <span className="daily-date">{name}</span>
                  <span className="daily-min">{fmtMin(m.wallSec)}</span>
                  <span className="daily-extra muted">
                    ×{coef} · {m.ankiAdds} cards · {m.lookups} lookups
                  </span>
                </div>
              );
            })}
          </div>
          <div className="hint stats-footnote">
            ×coefficient = wall / content time. Content time is approximated
            from playback-position advance between heartbeats (seeks excluded),
            not from unique cue coverage.
          </div>
        </>
      )}

      <h2 className="h2">Coverage</h2>
      {entries == null && <div className="empty">Loading…</div>}
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
              onClick={() => go(`#/play/${e.id}`)}
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

function PlayerRoute({
  id,
  startAt,
  toast,
  settings,
  go,
}: {
  id: string;
  startAt?: number;
  toast: (m: string) => void;
  settings: Record<string, unknown>;
  go: (h: string) => void;
}) {
  const [entry, setEntry] = useState<LibraryEntry | null>(null);
  const [notFound, setNotFound] = useState(false);

  // Remember the last-played episode for the sidebar "View" item.
  useEffect(() => {
    try {
      localStorage.setItem(LAST_MEDIA_KEY, id);
    } catch {
      /* private mode */
    }
  }, [id]);

  useEffect(() => {
    void api
      .library()
      .then((lib) => {
        const e = lib.find((x) => x.id === id);
        if (e) setEntry(e);
        else setNotFound(true);
      })
      .catch(() => setNotFound(true));
  }, [id]);

  if (notFound)
    return (
      <div className="empty">
        File not found.{" "}
        <button className="btn sm" onClick={() => go("#/")}>
          Back to library
        </button>
      </div>
    );
  if (!entry) return <div className="empty">Loading…</div>;

  return (
    <>
      <button className="btn ghost sm" onClick={() => go("#/")} style={{ marginBottom: 12 }}>
        ← Library
      </button>
      <Player
        key={entry.id}
        entry={entry}
        startAt={startAt}
        toast={toast}
        settings={settings}
      />
    </>
  );
}

function Settings({
  settings,
  setSettings,
  toast,
  go,
}: {
  settings: Record<string, unknown>;
  setSettings: (s: Record<string, unknown>) => void;
  toast: (m: string) => void;
  go: (h: string) => void;
}) {
  const [primaryLang, setPrimaryLang] = useState(
    (settings.targetLang as string) || "ja",
  );
  const [secondaryLang, setSecondaryLang] = useState(
    (settings.knownLang as string) || "ru",
  );
  const [autoWhisper, setAutoWhisper] = useState(
    Boolean(settings.whisperAutoGenerate),
  );
  const [furigana, setFurigana] = useState(settings.furigana !== false);
  const [prestudyMinutes, setPrestudyMinutes] = useState(
    String(Number(settings.prestudyMinutes) || 10),
  );
  const promptDefault = (settings.lookupPromptDefault as string) || "";
  const [lookupPrompt, setLookupPrompt] = useState(
    (settings.lookupPrompt as string) || promptDefault,
  );
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setPrimaryLang((settings.targetLang as string) || "ja");
    setSecondaryLang((settings.knownLang as string) || "ru");
    setAutoWhisper(Boolean(settings.whisperAutoGenerate));
    setFurigana(settings.furigana !== false);
    setPrestudyMinutes(String(Number(settings.prestudyMinutes) || 10));
    const def = (settings.lookupPromptDefault as string) || "";
    setLookupPrompt((settings.lookupPrompt as string) || def);
  }, [settings]);

  const onSave = async () => {
    setSaving(true);
    try {
      const next = await api.saveSettings({
        targetLang: primaryLang,
        knownLang: secondaryLang,
        whisperAutoGenerate: autoWhisper,
        furigana,
        prestudyMinutes: Math.max(
          1,
          Math.min(120, Math.round(Number(prestudyMinutes)) || 10),
        ),
        lookupPrompt,
      });
      setSettings(next);
      toast("Settings saved");
    } catch (e) {
      toast(`Save failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <button className="btn ghost sm" onClick={() => go("#/")} style={{ marginBottom: 12 }}>
        ← Library
      </button>
      <h1 className="h1">Settings</h1>
      <div className="form">
        <div className="field">
          <label>Primary language (target)</label>
          <input
            type="text"
            value={primaryLang}
            onChange={(e) => setPrimaryLang(e.target.value)}
            placeholder="ja"
          />
        </div>
        <div className="field">
          <label>Secondary language (known)</label>
          <input
            type="text"
            value={secondaryLang}
            onChange={(e) => setSecondaryLang(e.target.value)}
            placeholder="ru"
          />
        </div>
        <div className="switch">
          <input
            type="checkbox"
            id="autoWhisper"
            checked={autoWhisper}
            onChange={(e) => setAutoWhisper(e.target.checked)}
          />
          <label htmlFor="autoWhisper">Auto-generate Japanese subtitles</label>
        </div>
        <div className="switch">
          <input
            type="checkbox"
            id="furigana"
            checked={furigana}
            onChange={(e) => setFurigana(e.target.checked)}
          />
          <label htmlFor="furigana">Furigana on unknown kanji</label>
        </div>
        <div className="field">
          <label htmlFor="prestudyMinutes">Pre-study window (minutes)</label>
          <input
            id="prestudyMinutes"
            type="number"
            min={1}
            max={120}
            value={prestudyMinutes}
            onChange={(e) => setPrestudyMinutes(e.target.value)}
          />
        </div>
        <div className="field">
          <label>Word-lookup prompt (Gemini)</label>
          <textarea
            className="prompt"
            rows={12}
            value={lookupPrompt}
            onChange={(e) => setLookupPrompt(e.target.value)}
            placeholder={promptDefault}
          />
          <div className="hint">
            Template placeholders: <code>{"{word}"}</code> <code>{"{context}"}</code>{" "}
            <code>{"{source}"}</code> are substituted at lookup time.
          </div>
          <div>
            <button
              type="button"
              className="btn sm"
              onClick={() => setLookupPrompt(promptDefault)}
            >
              Reset to default
            </button>
          </div>
        </div>
        <div>
          <button className="btn primary" disabled={saving} onClick={onSave}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </>
  );
}
