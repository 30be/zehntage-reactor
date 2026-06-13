import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { guessEpisode } from "../src/lib/episode.ts";
import {
  api,
  type AnkiWordsResponse,
  type BatchStatus,
  type EpisodeDayRow,
  type LibraryEntry,
  type Overview,
} from "./api.ts";
import { Player } from "./Player.tsx";
import { ReadRoute } from "./ReadRoute.tsx";
import { HealthRoute } from "./HealthRoute.tsx";
import { Cards } from "./CardsRoute.tsx";
import { Palette } from "./Palette.tsx";
import { HOTKEYS } from "./commands.ts";
import {
  pickContinueWatching,
  readResumeRecords,
} from "./continueWatching.ts";
import { startSync } from "./sync.ts";
import { readBlacklist } from "./blacklist.ts";
import { readKnownWords, useCoverage } from "./coverage.ts";
import { kataToHira } from "./tokenizer.ts";
import { tmEvent, tmStart } from "./telemetry.ts";
import { activityShade, fmtMin, localDateStr } from "./statsfmt.ts";
import {
  CardsIcon,
  HealthIcon,
  HomeIcon,
  LibraryIcon,
  SettingsIcon,
  StatsIcon,
  ViewIcon,
} from "./icons.tsx";

type Route =
  | { name: "library" }
  | { name: "player"; id: string; t?: number }
  | { name: "read"; id: string }
  | { name: "settings" }
  | { name: "stats" }
  | { name: "cards" }
  | { name: "home" }
  | { name: "health" };

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
  if (h.startsWith("read/")) return { name: "read", id: h.slice("read/".length) };
  if (h === "settings") return { name: "settings" };
  if (h === "stats") return { name: "stats" };
  if (h === "cards") return { name: "cards" };
  if (h === "home") return { name: "home" };
  if (h === "health") return { name: "health" };
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
    void api
      .getSettings()
      .then((s) => {
        setSettings(s);
        // apply the persisted theme once on load, and mirror it to
        // localStorage so index.html's bootstrap avoids a flash next time.
        const theme = (s.theme as string) || "light";
        document.documentElement.dataset.theme = theme;
        try {
          localStorage.setItem("zr.theme", theme);
        } catch {
          /* ignore storage errors */
        }
      })
      .catch(() => {});
    tmStart();
  }, []);

  // zr.* localStorage <-> server state sync (web/sync.ts contract): pull on
  // start, then push changed keys debounced. Once per app lifetime.
  useEffect(() => {
    const handle = startSync();
    return () => handle.stop();
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

  // Toasts must render inside the fullscreened element, otherwise they're
  // invisible (the top-layer fullscreen element covers body-level nodes).
  const [fsEl, setFsEl] = useState<Element | null>(null);
  useEffect(() => {
    const sync = () => setFsEl(document.fullscreenElement);
    sync();
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);

  const go = (hash: string) => {
    window.location.hash = hash;
  };

  // Current theme + shared setter, reused by the sidebar switcher and the
  // Settings <select> (both stay in sync via the shared `settings` state).
  const theme = (settings.theme as string) || "light";
  const applyTheme = (value: string) => {
    document.documentElement.dataset.theme = value;
    try {
      localStorage.setItem("zr.theme", value);
    } catch {
      /* ignore storage errors */
    }
    setSettings((s) => ({ ...s, theme: value }));
    void api.saveSettings({ theme: value }).catch(() => {});
  };

  const navItem = (
    label: string,
    icon: React.ReactNode,
    hash: string,
    active: boolean,
    disabled = false,
  ) => (
    <button
      className={`side-item${active ? " active" : ""}`}
      disabled={disabled}
      title={label}
      aria-label={label}
      aria-current={active ? "page" : undefined}
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
          <span className="side-icon brand-mark" aria-hidden>十日</span>
          <span className="side-label">zehntage</span>
        </a>
        <nav className="side-nav">
          {navItem("Home", <HomeIcon />, "#/home", route.name === "home")}
          {navItem("Library", <LibraryIcon />, "#/", route.name === "library")}
          {navItem(
            "View",
            <ViewIcon />,
            lastMedia ? `#/play/${lastMedia}` : "#/",
            route.name === "player",
            !lastMedia,
          )}
          {navItem("Cards", <CardsIcon />, "#/cards", route.name === "cards")}
          {navItem("Stats", <StatsIcon />, "#/stats", route.name === "stats")}
          {navItem("Settings", <SettingsIcon />, "#/settings", route.name === "settings")}
          {navItem("Health", <HealthIcon />, "#/health", route.name === "health")}
        </nav>
        <div className="side-theme" role="group" aria-label="Theme">
          <button
            className="theme-opt"
            data-active={theme === "light"}
            title="Light theme"
            aria-label="Light theme"
            aria-pressed={theme === "light"}
            onClick={() => applyTheme("light")}
          >
            日
          </button>
          <button
            className="theme-opt"
            data-active={theme === "dark"}
            title="Dark theme"
            aria-label="Dark theme"
            aria-pressed={theme === "dark"}
            onClick={() => applyTheme("dark")}
          >
            月
          </button>
          <button
            className="theme-opt"
            data-active={theme === "system"}
            title="Follow system theme"
            aria-label="System theme"
            aria-pressed={theme === "system"}
            onClick={() => applyTheme("system")}
          >
            ◐
          </button>
        </div>
      </aside>

      <main className="container">
        {route.name === "home" && <Home go={go} />}
        {route.name === "library" && <Library go={go} toast={toast} />}
        {route.name === "stats" && <Stats go={go} />}
        {route.name === "cards" && <Cards go={go} toast={toast} />}
        {route.name === "health" && <HealthRoute />}
        {route.name === "settings" && (
          <Settings settings={settings} setSettings={setSettings} toast={toast} />
        )}
        {route.name === "read" && (
          <ReadRoute key={route.id} id={route.id} settings={settings} />
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

      {toastMsg &&
        (fsEl
          ? createPortal(<div className="toast">{toastMsg}</div>, fsEl)
          : <div className="toast">{toastMsg}</div>)}
      <Palette go={go} toast={toast} settings={settings} setSettings={setSettings} />
    </div>
  );
}

export function fmtCueTime(t: number): string {
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
  if (w?.status === "done" && (!t || t.status === "done")) return "✓";
  return null;
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

function Home({ go }: { go: (h: string) => void }) {
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

// --- library root chooser: mini directory navigator (dim line above cards) ---

interface BrowseResult {
  path: string;
  parent: string | null;
  dirs: string[];
}

function RootChooser({
  toast,
  onChanged,
  newWords,
}: {
  toast: (m: string) => void;
  onChanged: () => void;
  // Library-wide count of new (unknown) words still to learn. Sum of the
  // per-episode newCount across entries whose coverage is computed; undefined
  // while coverage is still being computed in idle time.
  newWords?: number;
}) {
  const [info, setInfo] = useState<{ root: string; count: number } | null>(null);
  const [open, setOpen] = useState(false);
  const [browse, setBrowse] = useState<BrowseResult | null>(null);
  const [value, setValue] = useState(""); // manual path entry (power users)
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api.getRoot().then(setInfo).catch(() => {});
  }, []);

  // Esc closes the panel (global while open).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const browseTo = async (p?: string) => {
    try {
      const r = await fetch(
        `/api/browse${p ? `?path=${encodeURIComponent(p)}` : ""}`,
      );
      if (!r.ok) throw new Error(`browse → ${r.status}`);
      const data = (await r.json()) as BrowseResult;
      setBrowse(data);
      setValue(data.path);
    } catch (e) {
      toast(`Browse failed: ${e instanceof Error ? e.message : e}`);
    }
  };

  const applyRoot = async (p: string) => {
    if (!p.trim()) return;
    setBusy(true);
    try {
      const next = await api.setRoot(p.trim());
      setInfo(next);
      setOpen(false);
      toast(`Library root set: ${next.root} (${next.count} entries)`);
      onChanged();
    } catch (e) {
      toast(`Set root failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`root-line${open ? " editing" : " muted"}`}>
      <div
        className="root-current"
        title="Click to change the library root"
        onClick={() => {
          if (open) {
            setOpen(false);
            return;
          }
          setOpen(true);
          void browseTo(info?.root);
        }}
      >
        {info ? `${info.root} · ${info.count} entries` : "…"}
        {info && newWords != null && newWords > 0 ? (
          <span className="root-newwords" title="New (unknown) words to learn across the library">
            {" · "}
            {newWords.toLocaleString()} new words
          </span>
        ) : null}
      </div>
      {open && (
        <div className="root-panel">
          <div className="root-manual">
            <input
              type="text"
              className="root-input"
              placeholder="/absolute/path/to/library"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void applyRoot(value);
              }}
            />
            <button
              className="btn sm"
              disabled={busy}
              onClick={() => void applyRoot(value)}
            >
              {busy ? "…" : "Set"}
            </button>
          </div>
          <div className="root-dirs">
            {browse?.parent != null && (
              <div
                className="root-dir up"
                onClick={() => void browseTo(browse.parent!)}
              >
                ..
              </div>
            )}
            {browse?.dirs.map((d) => (
              <div
                key={d}
                className="root-dir"
                onClick={() => void browseTo(`${browse.path.replace(/\/$/, "")}/${d}`)}
              >
                {d}/
              </div>
            ))}
            {browse && browse.dirs.length === 0 && (
              <div className="root-dir muted none">no subfolders</div>
            )}
          </div>
          <div className="root-actions">
            <button
              className="btn sm primary root-use"
              disabled={busy || !browse}
              onClick={() => browse && void applyRoot(browse.path)}
            >
              Use this folder
            </button>
            <button className="btn sm ghost" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// --- jimaku.cc "find subs" panel (entries without any subtitles) ---

interface JimakuEntryRow {
  id: number;
  name: string;
  english_name: string | null;
  japanese_name: string | null;
}

interface JimakuFileRow {
  url: string;
  name: string;
  size: number;
}

function JimakuFind({
  entry,
  toast,
  onDownloaded,
}: {
  entry: LibraryEntry;
  toast: (m: string) => void;
  onDownloaded: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<JimakuEntryRow[] | null>(null);
  const [files, setFiles] = useState<JimakuFileRow[] | null>(null);
  const [picked, setPicked] = useState<JimakuEntryRow | null>(null);

  const fail = (e: unknown, status?: number) => {
    setError(
      status === 401
        ? "set JIMAKU_API_KEY in ~/.env"
        : e instanceof Error
          ? e.message
          : String(e),
    );
  };

  const search = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/jimaku/search?mediaId=${entry.id}`);
      const j = (await r.json()) as { error?: string; entries?: JimakuEntryRow[] };
      if (!r.ok) return fail(new Error(j.error ?? `HTTP ${r.status}`), r.status);
      setResults(j.entries ?? []);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const pick = async (je: JimakuEntryRow) => {
    setPicked(je);
    setFiles(null);
    setBusy(true);
    setError(null);
    try {
      const ep = guessEpisode(entry.name);
      const r = await fetch(
        `/api/jimaku/files?entryId=${je.id}${ep != null ? `&episode=${ep}` : ""}`,
      );
      const j = (await r.json()) as JimakuFileRow[] | { error?: string };
      if (!r.ok)
        return fail(new Error((j as { error?: string }).error ?? `HTTP ${r.status}`), r.status);
      setFiles(j as JimakuFileRow[]);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const download = async (f: JimakuFileRow) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/jimaku/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mediaId: entry.id, url: f.url, name: f.name }),
      });
      const j = (await r.json()) as { error?: string; lang?: string };
      if (!r.ok) return fail(new Error(j.error ?? `HTTP ${r.status}`), r.status);
      toast(`Subtitle downloaded (${j.lang ?? "ja"}): ${f.name}`);
      setOpen(false);
      onDownloaded();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="jimaku" onClick={(e) => e.stopPropagation()}>
      <span
        className="jimaku-link muted"
        title="Search jimaku.cc for subtitles"
        onClick={() => {
          setOpen((o) => !o);
          if (!open && results == null) void search();
        }}
      >
        find subs
      </span>
      {open && (
        <span className="jimaku-panel">
          {busy && <span className="muted">…</span>}
          {error && <span className="jimaku-error">{error}</span>}
          {!picked &&
            results?.map((je) => (
              <span key={je.id} className="jimaku-row" onClick={() => void pick(je)}>
                {je.name}
                {je.english_name ? ` · ${je.english_name}` : ""}
              </span>
            ))}
          {!picked && results?.length === 0 && !busy && !error && (
            <span className="muted">no matches</span>
          )}
          {picked && files == null && !busy && !error && (
            <span className="muted">no files</span>
          )}
          {picked &&
            files?.map((f) => (
              <span key={f.url} className="jimaku-row" onClick={() => void download(f)}>
                {f.name} · {fmtSize(f.size)}
              </span>
            ))}
          {picked && files?.length === 0 && !busy && (
            <span className="muted">
              no files{guessEpisode(entry.name) != null ? " for this episode" : ""}
            </span>
          )}
          {picked && (
            <span
              className="jimaku-row muted"
              onClick={() => {
                setPicked(null);
                setFiles(null);
              }}
            >
              ← back
            </span>
          )}
        </span>
      )}
    </span>
  );
}

function Library({ go, toast }: { go: (h: string) => void; toast: (m: string) => void }) {
  const [entries, setEntries] = useState<LibraryEntry[] | null>(null);
  // --- transcript search (debounced 300ms; Esc clears) ---
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  // search field hidden until the user presses "/" (global hotkey)
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/") return;
      const el = document.activeElement as HTMLElement | null;
      const typing =
        el != null &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.isContentEditable);
      if (typing) return;
      e.preventDefault();
      setSearchOpen(true);
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);
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
  const coverage = useCoverage(entries);
  // Library-wide new-word total: sum of per-episode newCount across all entries
  // whose coverage has been computed. This is an aggregate sum, not a true
  // cross-episode unique union (the coverage cache stores only counts, not the
  // lemma sets, so a real union would need re-tokenizing every episode). Cheap:
  // just folds the already-computed coverage map.
  const newWordsTotal = useMemo(() => {
    let sum = 0;
    let any = false;
    for (const cov of coverage.values()) {
      if (cov) {
        sum += cov.newCount;
        any = true;
      }
    }
    return any ? sum : undefined;
  }, [coverage]);
  // comprehensibility sort: "name" (default) | "known" (server pctKnown desc)
  const [sortMode, setSortMode] = useState<"name" | "known">("name");
  const [knownPct, setKnownPct] = useState<Map<string, number | null> | null>(
    null,
  );
  const [sortBusy, setSortBusy] = useState(false);
  // entryId -> count of due Anki words appearing in the episode (SRS hint)
  const [dueCounts, setDueCounts] = useState<Map<string, number>>(() => new Map());
  // shared anki word list — fetched once, reused by dueCounts effect and toggleSort
  const [ankiData, setAnkiData] = useState<Awaited<ReturnType<typeof api.ankiWords>> | null>(null);
  // --- continue watching: most-recent episodes with a resume position ---
  const continueWatching = useMemo(
    () =>
      pickContinueWatching(readResumeRecords((entries ?? []).map((e) => e.id)))
        .map((r) => ({ rec: r, entry: (entries ?? []).find((e) => e.id === r.id) }))
        .filter((x): x is { rec: typeof x.rec; entry: LibraryEntry } => !!x.entry),
    [entries],
  );

  const savedPositions = useMemo(
    () => new Map((entries ?? []).map((e) => [e.id, savedPos(e.id)])),
    [entries],
  );

  const ordered = useMemo(() => {
    const base = entries ?? [];
    return sortMode === "known" && knownPct
      ? base
          .slice()
          .sort(
            (a, b) => (knownPct.get(b.id) ?? -1) - (knownPct.get(a.id) ?? -1),
          )
      : base;
  }, [entries, sortMode, knownPct]);

  const toggleSort = useCallback(async () => {
    if (sortMode === "known") {
      setSortMode("name");
      return;
    }
    setSortMode("known");
    if (knownPct || sortBusy) return;
    setSortBusy(true);
    try {
      // known set = local zr.known + Anki card lemmas (front sans reading)
      const anki = ankiData ?? await api.ankiWords().catch(() => ({ words: [], progress: {} }));
      if (!ankiData) setAnkiData(anki as Awaited<ReturnType<typeof api.ankiWords>>);
      const known = new Set<string>([...readKnownWords(), ...readBlacklist()]);
      for (const w of anki.words) known.add(w.front.replace(/\s*\[.*$/, "").trim());
      const rows = await api.indexComprehensibility([...known]);
      setKnownPct(new Map(rows.map((r) => [r.mediaId, r.pctKnown])));
    } catch {
      /* sort silently stays name-equivalent */
    } finally {
      setSortBusy(false);
    }
  }, [sortMode, knownPct, sortBusy, ankiData]);

  // SRS hint badges: due-word intersection per entry. Due info is BEST-EFFORT
  // approximated from Anki progress (interval > 0 && queue in {1,2}) because
  // the real due date isn't available through /zehntage/progress.
  useEffect(() => {
    if (!entries || entries.length === 0) return;
    let cancelled = false;
    void (async () => {
      const anki = await api.ankiWords().catch(() => null);
      if (!anki || cancelled) return;
      if (!cancelled) setAnkiData(anki);
      const dueFronts = anki.words
        .map((w) => w.front)
        .filter((f) => {
          const p = anki.progress[f];
          if (p == null) return false;
          // Real "is:due" flag from the local AnkiConnect path when present;
          // otherwise the old interval/queue approximation.
          if (p.isDue != null) return p.isDue;
          return p.interval > 0 && (p.queue === 1 || p.queue === 2);
        });
      if (dueFronts.length === 0) return;
      const rows = await api.indexDue(dueFronts).catch(() => null);
      if (!rows || cancelled) return;
      setDueCounts(new Map(rows.map((r) => [r.mediaId, r.count])));
    })();
    return () => {
      cancelled = true;
    };
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

  if (error)
    return (
      <>
        <div className="state error" role="alert">
          Failed to load the library.
          <span className="state-detail">{error}</span>
          <button className="btn sm retry" onClick={loadEntries}>
            Retry
          </button>
        </div>
      </>
    );
  if (!entries)
    return (
      <>
        <div className="state" role="status">
          <span className="spinner" aria-hidden /> Loading library…
        </div>
      </>
    );
  if (entries.length === 0)
    return (
      <>
        <RootChooser toast={toast} onChanged={loadEntries} />
        <div className="empty">No video files found.</div>
      </>
    );

  return (
    <>
      <div className="lib-head">
        <RootChooser toast={toast} onChanged={loadEntries} newWords={newWordsTotal} />
        {continueWatching.length > 0 && (() => {
          const { rec, entry } = continueWatching[0]!;
          return (
            <button
              className="card continue-card"
              aria-label="Continue watching"
              onClick={() => go(`#/play/${rec.id}@${Math.floor(rec.pos)}`)}
              title={`Resume ${entry.name} at ${fmtCueTime(rec.pos)}`}
            >
              <span className="continue-name">
                {entry.name.replace(/\.[^.]+$/, "")}
              </span>
              <span className="badge">▶ {fmtCueTime(rec.pos)}</span>
            </button>
          );
        })()}
      </div>
      <input
        ref={searchRef}
        className="search-input"
        type="text"
        aria-label="Search library"
        placeholder="search transcripts…  (press / )"
        hidden={!searchOpen}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setQuery("");
            setSearchOpen(false);
          }
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
        <button
          className="btn sm"
          title="Whisper-transcribe ja subs where missing, then translate to ru — for every entry"
          onClick={() => void onBatchAll()}
        >
          Generate all (ja + ru)
        </button>
        <button
          className="btn sm sort-toggle"
          disabled={sortBusy}
          title="Sort by name or by comprehensibility (known-word %)"
          onClick={() => void toggleSort()}
        >
          {sortBusy ? "sort: …" : `sort: ${sortMode === "name" ? "name" : "known%"}`}
        </button>
      </div>
      <div className="grid">
        {ordered.map((e) => {
          const resume = savedPositions.get(e.id) ?? null;
          const cov = coverage.get(e.id);
          return (
            <div
              key={e.id}
              className="card lib-row"
              onClick={() => go(`#/play/${e.id}`)}
            >
              <div className="lib-row-main">
                <div className="name">{e.name}</div>
              </div>
              {resume != null && (
                <span className="ep-time" title="resume position">
                  ▶ {fmtCueTime(resume)}
                </span>
              )}
              {cov && (
                <span
                  className="ep-known"
                  title={`${cov.pct}% of words in this episode you already know · ${cov.newCount} new unique words`}
                >
                  {cov.pct}%
                </span>
              )}
              <div className="lib-langs">
                {e.subLangs.length === 0 && (
                  <>
                    <span className="badge">no subs</span>
                    <JimakuFind entry={e} toast={toast} onDownloaded={loadEntries} />
                  </>
                )}
                {e.subLangs.map((l, i) => (
                  <span key={i} className="badge">
                    {l}
                  </span>
                ))}
                {(() => {
                  const b = entryBadge(status, e.id);
                  return b ? <span className="badge jobstatus">{b}</span> : null;
                })()}
                {(() => {
                  const n = dueCounts.get(e.id) ?? 0;
                  return n > 0 ? (
                    <span className="badge due" title="Due Anki words in this episode (approx.)">
                      {n} due word{n === 1 ? "" : "s"}
                    </span>
                  ) : null;
                })()}
                {sortMode === "known" && knownPct?.get(e.id) != null && (
                  <span
                    className="badge known-pct"
                    title="Share of word occurrences in this episode you already know"
                  >
                    {Math.round(knownPct.get(e.id)! * 100)}% known
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
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

function Stats({ go }: { go: (h: string) => void }) {
  const [entries, setEntries] = useState<LibraryEntry[] | null>(null);
  const [anki, setAnki] = useState<AnkiWordsResponse | null>(null);
  const [summary, setSummary] = useState<import("./api.ts").StatsSummary | null>(null);
  const [summaryState, setSummaryState] = useState<LoadState>("loading");

  const [episodes, setEpisodes] = useState<EpisodeDayRow[] | null>(null);
  const [episodesState, setEpisodesState] = useState<LoadState>("loading");

  const [ov, setOv] = useState<Overview | null>(null);
  const [ovState, setOvState] = useState<LoadState>("loading");

  const [comp, setComp] = useState<
    import("./api.ts").ComprehensionSummary | null
  >(null);
  const [compState, setCompState] = useState<LoadState>("loading");

  useEffect(() => {
    void api
      .statsSummary()
      .then((v) => { setSummary(v); setSummaryState("ok"); })
      .catch(() => setSummaryState("error"));
    void api
      .statsEpisodes()
      .then((v) => { setEpisodes(v); setEpisodesState("ok"); })
      .catch(() => setEpisodesState("error"));
    void api
      .statsOverview()
      .then((v) => { setOv(v); setOvState("ok"); })
      .catch(() => setOvState("error"));
    void api
      .statsComprehension()
      .then((v) => { setComp(v); setCompState("ok"); })
      .catch(() => setCompState("error"));
  }, []);
  // Per-episode coverage, computed in idle time (web/coverage.ts hook).
  const coverage = useCoverage(entries, anki);

  useEffect(() => {
    void api.library().then(setEntries).catch(() => setEntries([]));
    void api
      .ankiWords()
      .then(setAnki)
      .catch(() => setAnki({ words: [], progress: {} }));
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
          known words
        </div>
        <div className="stat">
          <span className="stat-num">{anki ? anki.words.length : "…"}</span>
          cards added
        </div>
      </div>

      <h2 className="h2">Activity</h2>
      <div className="section-intro muted">
        Daily watch time over the last ~20 weeks — darker means more minutes.
      </div>
      {summaryState !== "ok" ? (
        <SectionLoad state={summaryState} label="activity" />
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
                    onClick={() => go(`#/play/${m.mediaId}`)}
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
  if (!entry)
    return (
      <div className="state" role="status">
        <span className="spinner" aria-hidden /> Loading…
      </div>
    );

  return (
    <>
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
}: {
  settings: Record<string, unknown>;
  setSettings: (s: Record<string, unknown>) => void;
  toast: (m: string) => void;
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
  const [pitchAccent, setPitchAccent] = useState(settings.pitchAccent !== false);
  const [autoQuizPrompt, setAutoQuizPrompt] = useState(
    settings.autoQuizPrompt !== false,
  );
  const [prestudyMinutes, setPrestudyMinutes] = useState(
    String(Number(settings.prestudyMinutes) || 10),
  );
  const [shadowRepeats, setShadowRepeats] = useState(
    String(Math.max(0, Math.round(Number(settings.shadowRepeats)) || 0)),
  );
  const [autopauseMode, setAutopauseMode] = useState(
    settings.autopauseMode === "unknown" ? "unknown" : "every",
  );
  const [autopauseMinUnknown, setAutopauseMinUnknown] = useState(
    String(Math.max(1, Math.round(Number(settings.autopauseMinUnknown)) || 1)),
  );
  const [theme, setTheme] = useState((settings.theme as string) || "light");
  const promptDefault = (settings.lookupPromptDefault as string) || "";
  const [lookupPrompt, setLookupPrompt] = useState(
    (settings.lookupPrompt as string) || promptDefault,
  );
  const explainDefault = (settings.explainPromptDefault as string) || "";
  const [explainPrompt, setExplainPrompt] = useState(
    (settings.explainPrompt as string) || explainDefault,
  );

  useEffect(() => {
    setPrimaryLang((settings.targetLang as string) || "ja");
    setSecondaryLang((settings.knownLang as string) || "ru");
    setAutoWhisper(Boolean(settings.whisperAutoGenerate));
    setFurigana(settings.furigana !== false);
    setPitchAccent(settings.pitchAccent !== false);
    setAutoQuizPrompt(settings.autoQuizPrompt !== false);
    setPrestudyMinutes(String(Number(settings.prestudyMinutes) || 10));
    setShadowRepeats(String(Math.max(0, Math.round(Number(settings.shadowRepeats)) || 0)));
    setAutopauseMode(settings.autopauseMode === "unknown" ? "unknown" : "every");
    setAutopauseMinUnknown(
      String(Math.max(1, Math.round(Number(settings.autopauseMinUnknown)) || 1)),
    );
    setTheme((settings.theme as string) || "light");
    const def = (settings.lookupPromptDefault as string) || "";
    setLookupPrompt((settings.lookupPrompt as string) || def);
    const exDef = (settings.explainPromptDefault as string) || "";
    setExplainPrompt((settings.explainPrompt as string) || exDef);
  }, [settings]);

  // --- autosave: no Save button — every change saves (debounced), blur
  // flushes immediately; a tiny "saved" toast confirms. ---
  const latest = useRef({
    primaryLang,
    secondaryLang,
    autoWhisper,
    furigana,
    pitchAccent,
    autoQuizPrompt,
    prestudyMinutes,
    shadowRepeats,
    autopauseMode,
    autopauseMinUnknown,
    theme,
    lookupPrompt,
    explainPrompt,
  });
  latest.current = {
    primaryLang,
    secondaryLang,
    autoWhisper,
    furigana,
    pitchAccent,
    autoQuizPrompt,
    prestudyMinutes,
    shadowRepeats,
    autopauseMode,
    autopauseMinUnknown,
    theme,
    lookupPrompt,
    explainPrompt,
  };
  const saveTimer = useRef<number | null>(null);
  const save = useCallback(async () => {
    if (saveTimer.current != null) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const s = latest.current;
    try {
      const next = await api.saveSettings({
        targetLang: s.primaryLang,
        knownLang: s.secondaryLang,
        whisperAutoGenerate: s.autoWhisper,
        furigana: s.furigana,
        pitchAccent: s.pitchAccent,
        autoQuizPrompt: s.autoQuizPrompt,
        prestudyMinutes: Math.max(
          1,
          Math.min(120, Math.round(Number(s.prestudyMinutes)) || 10),
        ),
        shadowRepeats: Math.max(0, Math.round(Number(s.shadowRepeats)) || 0),
        autopauseMode: s.autopauseMode,
        autopauseMinUnknown: Math.max(
          1,
          Math.round(Number(s.autopauseMinUnknown)) || 1,
        ),
        theme: s.theme,
        lookupPrompt: s.lookupPrompt,
        explainPrompt: s.explainPrompt,
      });
      setSettings(next);
      toast("saved");
    } catch (e) {
      toast(`Save failed: ${e instanceof Error ? e.message : e}`);
    }
  }, [setSettings, toast]);
  // Debounced save: typing in a field doesn't fire a request per keystroke.
  const scheduleSave = useCallback(() => {
    if (saveTimer.current != null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => void save(), 600);
  }, [save]);
  // flush a pending save on blur (and never leave a dangling timer on unmount)
  const onBlurSave = useCallback(() => {
    if (saveTimer.current != null) void save();
  }, [save]);
  useEffect(
    () => () => {
      if (saveTimer.current != null) window.clearTimeout(saveTimer.current);
    },
    [],
  );

  return (
    <>
      <div className="form settings-form">
        <section className="form-group">
          <h2 className="group-title">Languages</h2>
          <div className="field-row">
            <div className="field">
              <label htmlFor="settings-primaryLang">Primary (target)</label>
              <input
                id="settings-primaryLang"
                type="text"
                title="Preferred primary subtitle track."
                value={primaryLang}
                onChange={(e) => {
                  setPrimaryLang(e.target.value);
                  scheduleSave();
                }}
                onBlur={onBlurSave}
                placeholder="ja"
              />
            </div>
            <div className="field">
              <label htmlFor="settings-secondaryLang">Secondary (known)</label>
              <input
                id="settings-secondaryLang"
                type="text"
                title="Translation track, blurred until hovered."
                value={secondaryLang}
                onChange={(e) => {
                  setSecondaryLang(e.target.value);
                  scheduleSave();
                }}
                onBlur={onBlurSave}
                placeholder="ru"
              />
            </div>
          </div>
        </section>

        <section className="form-group">
          <h2 className="group-title">Player behavior</h2>
          <div
            className="switch"
            title="Queue a Whisper transcription automatically for videos without Japanese subs"
          >
            <input
              type="checkbox"
              id="autoWhisper"
              checked={autoWhisper}
              onChange={(e) => {
                setAutoWhisper(e.target.checked);
                scheduleSave();
              }}
            />
            <label htmlFor="autoWhisper">Auto-generate Japanese subtitles</label>
          </div>
          <div
            className="switch"
            title="Show readings above kanji you haven't learned yet"
          >
            <input
              type="checkbox"
              id="furigana"
              checked={furigana}
              onChange={(e) => {
                setFurigana(e.target.checked);
                scheduleSave();
              }}
            />
            <label htmlFor="furigana">Furigana on unknown kanji</label>
          </div>
          <div
            className="switch"
            title="Mark pitch accent in furigana readings (overline = high, ꜜ = downstep)"
          >
            <input
              type="checkbox"
              id="pitchAccent"
              checked={pitchAccent}
              onChange={(e) => {
                setPitchAccent(e.target.checked);
                scheduleSave();
              }}
            />
            <label htmlFor="pitchAccent">Pitch accent marks</label>
          </div>
          <div
            className="switch"
            title="Automatically launch the comprehension quiz when an episode reaches its end, covering the cues you just watched"
          >
            <input
              type="checkbox"
              id="autoQuizPrompt"
              checked={autoQuizPrompt}
              onChange={(e) => {
                setAutoQuizPrompt(e.target.checked);
                scheduleSave();
              }}
            />
            <label htmlFor="autoQuizPrompt">
              Auto-quiz at end of episode
            </label>
          </div>
          <div className="field-row">
            <div className="field">
              <label htmlFor="prestudyMinutes">Pre-study window</label>
              <input
                id="prestudyMinutes"
                type="number"
                min={1}
                max={120}
                title="Minutes the pre-study panel (w) scans ahead."
                value={prestudyMinutes}
                onChange={(e) => {
                  setPrestudyMinutes(e.target.value);
                  scheduleSave();
                }}
                onBlur={onBlurSave}
              />
            </div>
            <div className="field">
              <label htmlFor="shadowRepeats">Shadowing repeats</label>
              <input
                id="shadowRepeats"
                type="number"
                min={0}
                max={99}
                title="Repeats per s-loop; 0 = infinite."
                value={shadowRepeats}
                onChange={(e) => {
                  setShadowRepeats(e.target.value);
                  scheduleSave();
                }}
                onBlur={onBlurSave}
              />
            </div>
          </div>
          <div className="field-row">
            <div className="field">
              <label htmlFor="autopauseMode">Autopause mode</label>
              <select
                id="autopauseMode"
                title="Toggle autopause in the player with u."
                value={autopauseMode}
                onChange={(e) => {
                  setAutopauseMode(e.target.value);
                  scheduleSave();
                }}
              >
                <option value="every">every cue</option>
                <option value="unknown">cues with unknown words</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="autopauseMinUnknown">Autopause threshold</label>
              <input
                id="autopauseMinUnknown"
                type="number"
                min={1}
                max={20}
                title="Min unknown words per cue (unknown mode)."
                value={autopauseMinUnknown}
                onChange={(e) => {
                  setAutopauseMinUnknown(e.target.value);
                  scheduleSave();
                }}
                onBlur={onBlurSave}
              />
            </div>
          </div>
        </section>

        <section className="form-group">
          <h2 className="group-title">AI &amp; prompt</h2>
          <div className="field">
            <label>Word-lookup prompt (Gemini)</label>
            <textarea
              className="prompt"
              rows={12}
              title="Placeholders {word} {context} {source} are substituted at lookup time."
              value={lookupPrompt}
              onChange={(e) => {
                setLookupPrompt(e.target.value);
                scheduleSave();
              }}
              onBlur={onBlurSave}
              placeholder={promptDefault}
            />
            <div>
              <button
                type="button"
                className="btn sm"
                title="Restore the built-in lookup prompt"
                onClick={() => {
                  setLookupPrompt(promptDefault);
                  scheduleSave();
                }}
              >
                Reset to default
              </button>
            </div>
          </div>
          <div className="field">
            <label>Sentence explanation prompt (Gemini)</label>
            <textarea
              className="prompt"
              rows={10}
              title="Placeholders {sentence} {context} {secondary} {source} are substituted at explain time."
              value={explainPrompt}
              onChange={(e) => {
                setExplainPrompt(e.target.value);
                scheduleSave();
              }}
              onBlur={onBlurSave}
              placeholder={explainDefault}
            />
            <div>
              <button
                type="button"
                className="btn sm"
                title="Restore the built-in explanation prompt"
                onClick={() => {
                  setExplainPrompt(explainDefault);
                  scheduleSave();
                }}
              >
                Reset to default
              </button>
            </div>
          </div>
        </section>

        <DataSection setSettings={setSettings} />

        <div className="hint">Changes save automatically.</div>
      </div>
    </>
  );
}

// Export / import the JSON data bundle (settings + state + events).
// Importing overwrites settings/state, so it asks for an inline confirm first.
function DataSection({
  setSettings,
}: {
  setSettings: (s: Record<string, unknown>) => void;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [pending, setPending] = useState<unknown | null>(null);
  const [pendingName, setPendingName] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null,
  );

  const onExport = useCallback(async () => {
    setMsg(null);
    try {
      const bundle = await api.exportData();
      const blob = new Blob([JSON.stringify(bundle, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `zehntage-export-${bundle.exportedAt.slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setMsg({ kind: "ok", text: "Exported." });
    } catch (e) {
      setMsg({ kind: "error", text: `Export failed: ${e instanceof Error ? e.message : e}` });
    }
  }, []);

  const onPick = useCallback(async (file: File) => {
    setMsg(null);
    try {
      const parsed = JSON.parse(await file.text());
      setPending(parsed);
      setPendingName(file.name);
    } catch {
      setMsg({ kind: "error", text: "Not valid JSON." });
    }
  }, []);

  const onConfirm = useCallback(async () => {
    if (pending == null) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await api.importData(pending);
      // Refresh the in-memory settings so the UI reflects the imported values.
      const next = await api.getSettings();
      setSettings(next);
      setPending(null);
      setPendingName("");
      setMsg({
        kind: "ok",
        text: `Imported${res.settingsImported ? " settings," : ""} ${res.stateKeys} state keys. Reloading…`,
      });
      // State sync reads from the server on load; reload to re-hydrate cleanly.
      window.setTimeout(() => window.location.reload(), 800);
    } catch (e) {
      setMsg({ kind: "error", text: `Import failed: ${e instanceof Error ? e.message : e}` });
    } finally {
      setBusy(false);
    }
  }, [pending, setSettings]);

  return (
    <section className="form-group">
      <h2 className="group-title">Data</h2>
      <div className="field">
        <div className="field-row">
          <button className="btn sm" onClick={onExport}>
            Export data (JSON)
          </button>
          <button className="btn sm" onClick={() => fileRef.current?.click()}>
            Import data (JSON)
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onPick(f);
              e.target.value = "";
            }}
          />
        </div>
        <div className="hint">
          Exports settings, progress and stats. Importing overwrites settings
          and merges progress; telemetry events are skipped.
        </div>
        {pending != null && (
          <div className="state" role="alert">
            <span>
              Import “{pendingName}”? This overwrites settings and merges saved
              progress.
            </span>
            <span className="field-row">
              <button
                className="btn sm primary"
                disabled={busy}
                onClick={() => void onConfirm()}
              >
                {busy ? "Importing…" : "Confirm import"}
              </button>
              <button
                className="btn sm ghost"
                disabled={busy}
                onClick={() => {
                  setPending(null);
                  setPendingName("");
                }}
              >
                Cancel
              </button>
            </span>
          </div>
        )}
        {msg && (
          <div
            className={msg.kind === "error" ? "state error" : "state"}
            role="status"
          >
            {msg.text}
          </div>
        )}
      </div>
    </section>
  );
}
