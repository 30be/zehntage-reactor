import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { guessEpisode } from "../src/lib/episode.ts";
import {
  api,
  type BatchStatus,
  type LibraryEntry,
} from "./api.ts";
import { Player } from "./Player.tsx";
import { ReadRoute } from "./ReadRoute.tsx";
import { HealthRoute } from "./HealthRoute.tsx";
import { Cards } from "./CardsRoute.tsx";
import { Stats } from "./StatsRoute.tsx";
import { Settings } from "./SettingsRoute.tsx";
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
