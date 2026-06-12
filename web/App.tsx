import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { startSync } from "./sync.ts";
import { readBlacklist } from "./blacklist.ts";
import { computeCoverage, readKnownWords, type Coverage } from "./coverage.ts";
import { buildWordIndex } from "./progress.ts";
import { kataToHira } from "./tokenizer.ts";
import { tmEvent, tmStart } from "./telemetry.ts";
import { loadFreq } from "./freq.ts";
import {
  filterCards,
  type DateRange,
  type Rarity,
  type Stage,
} from "./cardfilter.ts";

type Route =
  | { name: "library" }
  | { name: "player"; id: string; t?: number }
  | { name: "read"; id: string }
  | { name: "settings" }
  | { name: "stats" }
  | { name: "cards" }
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
  if (h.startsWith("read/")) return { name: "read", id: h.slice("read/".length) };
  if (h === "settings") return { name: "settings" };
  if (h === "stats") return { name: "stats" };
  if (h === "cards") return { name: "cards" };
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
          <span className="side-icon brand-mark" aria-hidden>十日</span>
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
          {navItem("Cards", "▣", "#/cards", route.name === "cards")}
          {navItem("Stats", "∿", "#/stats", route.name === "stats")}
          {navItem("Settings", "⚙", "#/settings", route.name === "settings")}
        </nav>
      </aside>

      <main className="container">
        {route.name === "home" && <Home go={go} />}
        {route.name === "library" && <Library go={go} toast={toast} />}
        {route.name === "stats" && <Stats go={go} />}
        {route.name === "cards" && <Cards go={go} toast={toast} />}
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
  ["s", "shadowing loop current cue (count: Settings)"],
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
}: {
  toast: (m: string) => void;
  onChanged: () => void;
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

/** Best-effort episode number from a video filename (release tags stripped). */
function guessEpisode(name: string): number | null {
  const clean = name
    .replace(/\.[^.]+$/, "")
    .replace(/\[[^\]]*\]|\([^)]*\)/g, " ")
    .replace(/\b\d{3,4}p\b|\bx26[45]\b|\b10.?bit\b/gi, " ");
  const m =
    clean.match(/(?:e|ep|episode|第)\s*0*(\d{1,3})/i) ??
    clean.match(/(?:^|[\s._-])0*(\d{1,3})(?:v\d)?(?=[\s._-]*$)/);
  if (!m) return null;
  const n = parseInt(m[1]!, 10);
  return Number.isFinite(n) && n > 0 && n < 1000 ? n : null;
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
  // comprehensibility sort: "name" (default) | "known" (server pctKnown desc)
  const [sortMode, setSortMode] = useState<"name" | "known">("name");
  const [knownPct, setKnownPct] = useState<Map<string, number | null> | null>(
    null,
  );
  const [sortBusy, setSortBusy] = useState(false);
  // entryId -> count of due Anki words appearing in the episode (SRS hint)
  const [dueCounts, setDueCounts] = useState<Map<string, number>>(() => new Map());

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
      const anki = await api.ankiWords().catch(() => ({ words: [], progress: {} }));
      const known = new Set<string>([...readKnownWords(), ...readBlacklist()]);
      for (const w of anki.words) known.add(w.front.replace(/\s*\[.*$/, "").trim());
      const rows = await api.indexComprehensibility([...known]);
      setKnownPct(new Map(rows.map((r) => [r.mediaId, r.pctKnown])));
    } catch {
      /* sort silently stays name-equivalent */
    } finally {
      setSortBusy(false);
    }
  }, [sortMode, knownPct, sortBusy]);

  // SRS hint badges: due-word intersection per entry. Due info is BEST-EFFORT
  // approximated from Anki progress (interval > 0 && queue in {1,2}) because
  // the real due date isn't available through /zehntage/progress.
  useEffect(() => {
    if (!entries || entries.length === 0) return;
    let cancelled = false;
    void (async () => {
      const anki = await api.ankiWords().catch(() => null);
      if (!anki || cancelled) return;
      const dueFronts = anki.words
        .map((w) => w.front)
        .filter((f) => {
          const p = anki.progress[f];
          return p != null && p.interval > 0 && (p.queue === 1 || p.queue === 2);
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
      // blacklisted lemmas count as "known" — excluded from coverage %
      const known = new Set([...readKnownWords(), ...readBlacklist()]);
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
        {(sortMode === "known" && knownPct
          ? entries
              .slice()
              .sort(
                (a, b) =>
                  (knownPct.get(b.id) ?? -1) - (knownPct.get(a.id) ?? -1),
              )
          : entries
        ).map((e) => (
          <div key={e.id} className="card" onClick={() => go(`#/play/${e.id}`)}>
            <div className="name">{e.name}</div>
            <div className="meta">
              {e.relPath} · {fmtSize(e.size)}
              {(() => {
                const p = savedPos(e.id);
                return p != null ? (
                  <span className="resume-hint" title="resume position">
                    {" "}· ▶ {fmtCueTime(p)}
                  </span>
                ) : null;
              })()}
              {(() => {
                const c = coverage.get(e.id);
                return c ? (
                  <span
                    className="cov-hint"
                    title={`${c.pct}% of words in this episode you already know · ${c.newCount} new unique words`}
                  >
                    {" "}· {c.pct}% · {c.newCount} new
                  </span>
                ) : null;
              })()}
            </div>
            <div className="badges">
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

  const [episodes, setEpisodes] = useState<EpisodeDayRow[] | null>(null);
  const [ov, setOv] = useState<Overview | null>(null);

  useEffect(() => {
    void api.statsSummary().then(setSummary).catch(() => {});
    void api.statsEpisodes().then(setEpisodes).catch(() => {});
    void api.statsOverview().then(setOv).catch(() => {});
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
      // blacklisted lemmas count as "known" — excluded from coverage %
      const known = new Set([...readKnownWords(), ...readBlacklist()]);
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
      <div className="section-intro muted">
        Daily watch time over the last ~20 weeks — darker means more minutes.
      </div>
      <ActivityGrid
        byDate={
          new Map((summary?.days ?? []).map((d) => [d.date, d.playSec]))
        }
      />

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

      {episodes && episodes.length > 0 && (
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
              return rows.map((r, i) => {
                const e = entries?.find((x) => x.id === r.mediaId);
                const name = (e?.name ?? r.mediaId).replace(/\.[^.]+$/, "");
                const wall = r.wallPlayingSec + r.wallPausedSec;
                const newGroup = i > 0 && rows[i - 1]!.mediaId !== r.mediaId;
                return (
                  <div
                    key={`${r.mediaId} ${r.date}`}
                    className={`ep-row${newGroup ? " ep-group-start" : ""}`}
                  >
                    <span className="ep-name muted" title={`${name} · ${r.date}`}>
                      {name} · {r.date}
                    </span>
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
                  </div>
                );
              });
            })()}
          </div>
        </>
      )}

      {ov && (
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

      <h2 className="h2">Coverage</h2>
      <div className="section-intro muted">
        Share of words in each episode you already know — click a row to watch.
      </div>
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

// --- Cards browser: Anki cards added from the player (context has a frame) ---

interface FullCard {
  front: string;
  back: string;
  notes: string;
  context: string;
  noteId?: number;
}

/** <img src="..."> inside the context HTML, or null. Bare Anki media
 * filenames are rewritten to the /api/anki/media proxy. */
function cardImgSrc(context: string): string | null {
  const m = context.match(/<img[^>]*\bsrc="([^"]+)"/i);
  const src = m?.[1];
  if (!src) return null;
  // absolute URL / data URI / server path → use as-is
  if (/^(https?:|data:|blob:|\/)/i.test(src)) return src;
  // bare Anki collection filename → local AnkiConnect media proxy
  return `/api/anki/media/${encodeURIComponent(src)}`;
}

/** Parse "<episode name> @ mm:ss" out of the context HTML. */
function cardEpisodeRef(context: string): { name: string; sec: number } | null {
  for (const part of context.split(/<br\s*\/?>/i)) {
    const m = part.trim().match(/^(.+) @ (\d+):(\d{2})$/);
    if (m) return { name: m[1]!, sec: parseInt(m[2]!, 10) * 60 + parseInt(m[3]!, 10) };
  }
  return null;
}

const PAGE_SIZE = 50;

function Cards({ go, toast }: { go: (h: string) => void; toast: (m: string) => void }) {
  const [cards, setCards] = useState<FullCard[] | null>(null);
  const [entries, setEntries] = useState<LibraryEntry[]>([]);
  // double-click-to-confirm delete: front of the card in "sure?" state
  const [confirmFront, setConfirmFront] = useState<string | null>(null);
  // one progress map + one freq map for the whole list — no per-row fetches
  const [intervals, setIntervals] = useState<Map<string, number>>(() => new Map());
  const [freq, setFreq] = useState<Map<string, number> | null>(null);
  // filters (laconic): text, date range, learning stage, rarity
  const [q, setQ] = useState("");
  const [range, setRange] = useState<DateRange>("all");
  const [stage, setStage] = useState<Stage>("all");
  const [rarity, setRarity] = useState<Rarity>("all");
  const [visible, setVisible] = useState(PAGE_SIZE);

  useEffect(() => {
    void fetch("/api/anki/cards")
      .then((r) => (r.ok ? (r.json() as Promise<FullCard[]>) : Promise.reject(r.status)))
      .then(setCards)
      .catch(() => setCards([]));
    void api.library().then(setEntries).catch(() => {});
    void api
      .ankiWords()
      .then((a) =>
        setIntervals(
          new Map(
            Object.entries(a.progress).map(([front, p]) => [front, p.interval]),
          ),
        ),
      )
      .catch(() => {});
    void loadFreq().then(setFreq).catch(() => {});
  }, []);

  // reset paging whenever a filter changes
  useEffect(() => {
    setVisible(PAGE_SIZE);
  }, [q, range, stage, rarity]);

  // The Cards tab shows cards mined from the player (their context carries a
  // frame). Filtering + sorting is memoized and pure — smooth at 10k cards.
  const frameCards = useMemo(
    () => (cards ?? []).filter((c) => /<img/i.test(c.context)),
    [cards],
  );
  const filtered = useMemo(
    () => filterCards(frameCards, { q, range, stage, rarity, intervals, freq }),
    [frameCards, q, range, stage, rarity, intervals, freq],
  );

  const onDelete = async (front: string) => {
    if (confirmFront !== front) {
      setConfirmFront(front);
      return;
    }
    setConfirmFront(null);
    // optimistic removal
    setCards((prev) => (prev ? prev.filter((c) => c.front !== front) : prev));
    try {
      await api.ankiDelete(front);
    } catch (e) {
      toast(`Delete failed: ${e instanceof Error ? e.message : e}`);
    }
  };

  return (
    <>
      <h1 className="h1">Cards</h1>
      <div className="cards-filters">
        <input
          className="search-input cards-search"
          type="text"
          placeholder="search…"
          title="Filter by front or translation text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setQ("");
          }}
        />
        <select
          title="Filter by when the card was added (needs local Anki)"
          value={range}
          onChange={(e) => setRange(e.target.value as DateRange)}
        >
          <option value="all">any time</option>
          <option value="today">today</option>
          <option value="7d">7 days</option>
          <option value="30d">30 days</option>
        </select>
        <select
          title="Filter by learning stage (from the SRS interval)"
          value={stage}
          onChange={(e) => setStage(e.target.value as Stage)}
        >
          <option value="all">any stage</option>
          <option value="new">new</option>
          <option value="learning">learning</option>
          <option value="mature">mature</option>
        </select>
        <select
          title="Filter by word rarity (frequency tier)"
          value={rarity}
          onChange={(e) => setRarity(e.target.value as Rarity)}
        >
          <option value="all">any rarity</option>
          <option value="top 1k">top 1k</option>
          <option value="top 3k">top 3k</option>
          <option value="top 10k">top 10k</option>
          <option value="top 30k">top 30k</option>
          <option value="rare">rare</option>
        </select>
        {cards != null && (
          <span className="cards-count muted" title="Matching / total mined cards">
            {filtered.length} / {frameCards.length}
          </span>
        )}
      </div>
      {cards == null && <div className="empty">Loading…</div>}
      {cards != null && frameCards.length === 0 && (
        <div className="empty">No cards with frames yet.</div>
      )}
      {cards != null && frameCards.length > 0 && filtered.length === 0 && (
        <div className="empty">No cards match the filters.</div>
      )}
      <div className="cards-list">
        {filtered.slice(0, visible).map((c) => {
          const img = cardImgSrc(c.context);
          const ref = cardEpisodeRef(c.context);
          const entry = ref ? entries.find((e) => e.name === ref.name) : undefined;
          return (
            <div key={c.front} className="card-row">
              {img ? (
                <img className="card-frame" src={img} alt="" loading="lazy" />
              ) : (
                <span className="card-frame placeholder" />
              )}
              <span className="card-front">{c.front}</span>
              <span className="card-back muted">{c.back}</span>
              <span className="card-actions">
                <button
                  className="btn sm card-rewatch"
                  disabled={!entry || !ref}
                  title={
                    entry && ref
                      ? `Rewatch ${ref.name} @ ${fmtCueTime(ref.sec)}`
                      : "Source episode not in the library"
                  }
                  onClick={() => entry && ref && go(`#/play/${entry.id}@${ref.sec}`)}
                >
                  rewatch
                </button>
                <button
                  className={`btn sm danger card-delete${confirmFront === c.front ? " confirm" : ""}`}
                  onClick={() => void onDelete(c.front)}
                  onBlur={() => setConfirmFront((f) => (f === c.front ? null : f))}
                >
                  {confirmFront === c.front ? "sure?" : "delete"}
                </button>
              </span>
            </div>
          );
        })}
      </div>
      {filtered.length > visible && (
        <button
          className="btn sm cards-more"
          title="Render the next 50 matching cards"
          onClick={() => setVisible((v) => v + PAGE_SIZE)}
        >
          show more ({filtered.length - visible} left)
        </button>
      )}
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
  const promptDefault = (settings.lookupPromptDefault as string) || "";
  const [lookupPrompt, setLookupPrompt] = useState(
    (settings.lookupPrompt as string) || promptDefault,
  );

  useEffect(() => {
    setPrimaryLang((settings.targetLang as string) || "ja");
    setSecondaryLang((settings.knownLang as string) || "ru");
    setAutoWhisper(Boolean(settings.whisperAutoGenerate));
    setFurigana(settings.furigana !== false);
    setPitchAccent(settings.pitchAccent !== false);
    setPrestudyMinutes(String(Number(settings.prestudyMinutes) || 10));
    setShadowRepeats(String(Math.max(0, Math.round(Number(settings.shadowRepeats)) || 0)));
    setAutopauseMode(settings.autopauseMode === "unknown" ? "unknown" : "every");
    setAutopauseMinUnknown(
      String(Math.max(1, Math.round(Number(settings.autopauseMinUnknown)) || 1)),
    );
    const def = (settings.lookupPromptDefault as string) || "";
    setLookupPrompt((settings.lookupPrompt as string) || def);
  }, [settings]);

  // --- autosave: no Save button — every change saves (debounced), blur
  // flushes immediately; a tiny "saved" toast confirms. ---
  const latest = useRef({
    primaryLang,
    secondaryLang,
    autoWhisper,
    furigana,
    pitchAccent,
    prestudyMinutes,
    shadowRepeats,
    autopauseMode,
    autopauseMinUnknown,
    lookupPrompt,
  });
  latest.current = {
    primaryLang,
    secondaryLang,
    autoWhisper,
    furigana,
    pitchAccent,
    prestudyMinutes,
    shadowRepeats,
    autopauseMode,
    autopauseMinUnknown,
    lookupPrompt,
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
        lookupPrompt: s.lookupPrompt,
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
      <h1 className="h1">Settings</h1>
      <div className="form">
        <div className="field">
          <label>Primary language (target)</label>
          <input
            type="text"
            title="Language you're learning — preferred primary subtitle track (e.g. ja)"
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
          <label>Secondary language (known)</label>
          <input
            type="text"
            title="Language you already know — preferred translation track (e.g. ru)"
            value={secondaryLang}
            onChange={(e) => {
              setSecondaryLang(e.target.value);
              scheduleSave();
            }}
            onBlur={onBlurSave}
            placeholder="ru"
          />
        </div>
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
        <div className="field">
          <label htmlFor="prestudyMinutes">Pre-study window (minutes)</label>
          <input
            id="prestudyMinutes"
            type="number"
            min={1}
            max={120}
            title="How many minutes of upcoming dialogue the pre-study panel (w) scans for unknown words"
            value={prestudyMinutes}
            onChange={(e) => {
              setPrestudyMinutes(e.target.value);
              scheduleSave();
            }}
            onBlur={onBlurSave}
          />
        </div>
        <div className="field">
          <label htmlFor="shadowRepeats">Shadowing repeats (0 = infinite)</label>
          <input
            id="shadowRepeats"
            type="number"
            min={0}
            max={99}
            title="How many times the s-loop repeats one line; 0 = endless"
            value={shadowRepeats}
            onChange={(e) => {
              setShadowRepeats(e.target.value);
              scheduleSave();
            }}
            onBlur={onBlurSave}
          />
        </div>
        <div className="field">
          <label htmlFor="autopauseMode">Autopause mode</label>
          <select
            id="autopauseMode"
            title="Pause at the end of every subtitle, or only on lines containing unknown words"
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
          <label htmlFor="autopauseMinUnknown">
            Autopause: min unknown words per cue
          </label>
          <input
            id="autopauseMinUnknown"
            type="number"
            min={1}
            max={20}
            title="In 'unknown' mode, only pause when a line has at least this many unknown words"
            value={autopauseMinUnknown}
            onChange={(e) => {
              setAutopauseMinUnknown(e.target.value);
              scheduleSave();
            }}
            onBlur={onBlurSave}
          />
        </div>
        <div className="field">
          <label>Word-lookup prompt (Gemini)</label>
          <textarea
            className="prompt"
            rows={12}
            title="Prompt template used for word lookups; changes save automatically"
            value={lookupPrompt}
            onChange={(e) => {
              setLookupPrompt(e.target.value);
              scheduleSave();
            }}
            onBlur={onBlurSave}
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
        <div className="hint">Changes save automatically.</div>
      </div>
    </>
  );
}
