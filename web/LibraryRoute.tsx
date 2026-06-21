// #/ (default) — Library page: the episode grid with a root chooser, transcript
// search ("/"), continue-watching card, batch-generate bar, comprehensibility
// sort, coverage + due-word badges, and a jimaku.cc "find subs" panel.
// Extracted verbatim from App.tsx (behavior-preserving).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { guessEpisode } from "../src/lib/episode.ts";
import { Plus } from "lucide-react";
import {
  api,
  type BatchStatus,
  type CacheAllEstimate,
  type CacheAllStatus,
  type CacheEpisodeStatus,
  type LibraryEntry,
  type YtJob,
} from "./api.ts";
import {
  pickContinueWatching,
  readResumeRecords,
} from "./continueWatching.ts";
import { readBlacklist } from "./blacklist.ts";
import { readKnownWords, useCoverage } from "./coverage.ts";
import { kataToHira } from "./tokenizer.ts";
import { fmtCueTime } from "./App.tsx";

/** Enter/Space → activate, for role="button" containers (a11y). */
function onActivateKey(handler: () => void) {
  return (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handler();
    }
  };
}

function fmtSize(n: number): string {
  if (n > 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n > 1e6) return `${(n / 1e6).toFixed(0)} MB`;
  return `${(n / 1e3).toFixed(0)} KB`;
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
      <button
        type="button"
        className="a11y-rowbtn root-current"
        title="Click to change the library root"
        aria-expanded={open}
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
      </button>
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
              <button
                type="button"
                className="a11y-rowbtn root-dir up"
                onClick={() => void browseTo(browse.parent!)}
              >
                ..
              </button>
            )}
            {browse?.dirs.map((d) => (
              <button
                key={d}
                type="button"
                className="a11y-rowbtn root-dir"
                onClick={() => void browseTo(`${browse.path.replace(/\/$/, "")}/${d}`)}
              >
                {d}/
              </button>
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
      <button
        type="button"
        className="a11y-inlinebtn jimaku-link muted"
        title="Search jimaku.cc for subtitles"
        aria-expanded={open}
        onClick={() => {
          setOpen((o) => !o);
          if (!open && results == null) void search();
        }}
      >
        find subs
      </button>
      {open && (
        <span className="jimaku-panel">
          {busy && <span className="muted">…</span>}
          {error && <span className="jimaku-error">{error}</span>}
          {!picked &&
            results?.map((je) => (
              <button
                key={je.id}
                type="button"
                className="a11y-rowbtn jimaku-row"
                onClick={() => void pick(je)}
              >
                {je.name}
                {je.english_name ? ` · ${je.english_name}` : ""}
              </button>
            ))}
          {!picked && results?.length === 0 && !busy && !error && (
            <span className="muted">no matches</span>
          )}
          {picked && files == null && !busy && !error && (
            <span className="muted">no files</span>
          )}
          {picked &&
            files?.map((f) => (
              <button
                key={f.url}
                type="button"
                className="a11y-rowbtn jimaku-row"
                onClick={() => void download(f)}
              >
                {f.name} · {fmtSize(f.size)}
              </button>
            ))}
          {picked && files?.length === 0 && !busy && (
            <span className="muted">
              no files{guessEpisode(entry.name) != null ? " for this episode" : ""}
            </span>
          )}
          {picked && (
            <button
              type="button"
              className="a11y-rowbtn jimaku-row muted"
              onClick={() => {
                setPicked(null);
                setFiles(null);
              }}
            >
              ← back
            </button>
          )}
        </span>
      )}
    </span>
  );
}

// --- yt-dlp "add a YouTube video" control: a [+] button that floats an input ---

function YtAdd({ onSubmit }: { onSubmit: (url: string) => void }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    setValue(""); // don't leave a stale URL behind when the panel reopens
  }, []);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  const submit = () => {
    const v = value.trim();
    if (!v) return;
    onSubmit(v);
    close();
  };

  return (
    <div className="yt-add">
      <button
        type="button"
        className="btn sm icon yt-add-btn"
        aria-expanded={open}
        aria-label="Add a YouTube video"
        title="Add a YouTube video"
        onClick={() => (open ? close() : setOpen(true))}
      >
        <Plus size={16} />
      </button>
      {open && (
        <div className="root-panel yt-panel">
          <div className="root-manual">
            <input
              ref={inputRef}
              type="text"
              className="root-input"
              placeholder="Paste a YouTube link…"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
            />
            <button className="btn sm primary" onClick={submit}>
              Add
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Short status word for a yt-dlp job row. */
function ytStatusLabel(j: YtJob): string {
  switch (j.status) {
    case "probing":
      return "Fetching info…";
    case "downloading":
      return `Downloading ${Math.round(j.percent)}%`;
    case "merging":
      return "Merging…";
    case "error":
      return j.error ?? "Download failed";
    default:
      return "";
  }
}

export function Library({ go, toast }: { go: (h: string) => void; toast: (m: string) => void }) {
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
      // Local known/blacklist are stored as homograph-aware vocabKeys
      // (`lemma|reading|pos`), but the server index matches on lemma only
      // (comprehensibility() does knownSet.has(lemma)). Strip the suffix so the
      // keys line up — otherwise known% is understated. Local to this sort path.
      const known = new Set<string>(
        [...readKnownWords(), ...readBlacklist()].map((k) => k.split("|")[0]!),
      );
      for (const w of anki.words) known.add(w.front.replace(/\s*\[.*$/, "").trim());
      const rows = await api.indexComprehensibility([...known]);
      setKnownPct(new Map(rows.map((r) => [r.mediaId, r.pctKnown])));
    } catch {
      toast("Comprehensibility sort unavailable — Anki offline?");
      setSortMode("name");
    } finally {
      setSortBusy(false);
    }
  }, [sortMode, knownPct, sortBusy, ankiData, toast]);

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

  // --- yt-dlp downloads: poll active jobs, surface them as grid rows ---
  const [ytJobs, setYtJobs] = useState<YtJob[]>([]);
  const ytHandledDone = useRef<Set<string>>(new Set());
  const ytDismissed = useRef<Set<string>>(new Set());
  const refreshYtJobs = useCallback(() => {
    void api
      .youtubeJobs()
      .then((jobs) => {
        for (const j of jobs) {
          if (j.status === "done" && !ytHandledDone.current.has(j.id)) {
            ytHandledDone.current.add(j.id);
            loadEntries(); // the finished file is now a real episode
          }
        }
        // Keep only non-done jobs in state: done ones become real grid rows, so
        // holding them would just churn re-renders.
        setYtJobs(jobs.filter((j) => j.status !== "done"));
      })
      .catch(() => {});
  }, [loadEntries]);
  const ytActiveCount = ytJobs.filter(
    (j) => j.status !== "done" && j.status !== "error",
  ).length;
  // Recover any in-flight job after a reload, then poll while work is active.
  useEffect(() => {
    refreshYtJobs();
  }, [refreshYtJobs]);
  useEffect(() => {
    if (ytActiveCount === 0) return;
    const t = window.setInterval(refreshYtJobs, 1200);
    return () => window.clearInterval(t);
  }, [ytActiveCount, refreshYtJobs]);
  const onYtSubmit = useCallback(
    (url: string) => {
      void api
        .youtubeDownload(url)
        .then(({ jobId }) => {
          // Optimistic row so progress shows instantly. Its "probing" status
          // makes ytActiveCount > 0, which starts the polling interval; no
          // immediate refetch needed (and avoids racing the just-created job).
          setYtJobs((prev) => [
            {
              id: jobId,
              url,
              status: "probing",
              percent: 0,
              title: null,
              error: null,
              entryId: null,
              filePath: null,
              createdAt: Date.now(),
            },
            ...prev.filter((j) => j.id !== jobId),
          ]);
        })
        .catch((e) =>
          toast(`YouTube download failed: ${e instanceof Error ? e.message : e}`),
        );
    },
    [toast],
  );
  const dismissYtJob = useCallback((id: string) => {
    ytDismissed.current.add(id);
    setYtJobs((prev) => prev.filter((j) => j.id !== id));
    // Also drop it server-side so it doesn't return on the next poll / reload.
    void api.youtubeDismiss(id).catch(() => {});
  }, []);
  // Rows to render: active or errored jobs the user hasn't dismissed. Done jobs
  // drop out — they've become real episodes via loadEntries().
  const ytRows = ytJobs.filter(
    (j) => j.status !== "done" && !ytDismissed.current.has(j.id),
  );

  const refreshStatus = useCallback(() => {
    void api.batchStatus().then(setStatus).catch(() => {});
  }, []);

  // --- offline lookup cache ("Cache all"): cost estimate + run status ---
  const [cacheEst, setCacheEst] = useState<CacheAllEstimate | null>(null);
  const [cacheStatus, setCacheStatus] = useState<CacheAllStatus | null>(null);
  const refreshCacheEstimate = useCallback(() => {
    void api.cacheAllEstimate().then(setCacheEst).catch(() => {});
  }, []);
  const cacheRunning =
    cacheStatus?.state === "pending" || cacheStatus?.state === "running";

  // --- per-episode offline lookup cache: status map + true unique new-word
  // count. Polled while any episode is pending/running OR the global cache-all
  // is active (globalActive).
  const [epStatus, setEpStatus] = useState<CacheEpisodeStatus | null>(null);
  const refreshEpStatus = useCallback(() => {
    void api.cacheEpisodeStatus().then(setEpStatus).catch(() => {});
    // Keep the global "Cache all" estimate in lockstep with per-episode status:
    // per-episode caching shrinks the same uncached-word pool that drives
    // cacheEst.wordCount, so without this the global estimate goes stale and
    // "Cache all" can stay disabled (wordCount===0) while per-episode buttons
    // are still enabled.
    refreshCacheEstimate();
  }, [refreshCacheEstimate]);
  const epActive = useMemo(() => {
    if (!epStatus) return false;
    if (epStatus.globalActive) return true;
    for (const s of Object.values(epStatus.episodes)) {
      if (s.state === "pending" || s.state === "running") return true;
    }
    return false;
  }, [epStatus]);

  const onCacheEpisode = useCallback(
    async (id: string) => {
      try {
        const r = await api.cacheEpisode(id);
        if (!r.started) return;
        // Optimistically flip this entry to "pending" so the button shows
        // "Caching…" immediately, then let the poll take over.
        setEpStatus((prev) =>
          prev
            ? {
                ...prev,
                episodes: {
                  ...prev.episodes,
                  [id]: {
                    total: r.total || prev.episodes[id]?.total || 0,
                    cached: prev.episodes[id]?.cached ?? 0,
                    state: "pending",
                  },
                },
              }
            : prev,
        );
        refreshEpStatus();
      } catch (e) {
        toast(`Cache episode failed: ${e instanceof Error ? e.message : e}`);
      }
    },
    [refreshEpStatus, toast],
  );

  useEffect(() => {
    loadEntries();
    refreshStatus();
    refreshCacheEstimate();
    refreshEpStatus();
    // Resume-on-mount: if a cache-all batch is already in flight server-side
    // (e.g. after a page reload), re-attach to it so the progress indicator and
    // the 3s poll come back without needing an in-session click.
    void api
      .cacheAllStatus()
      .then((s) => {
        if (s.state === "pending" || s.state === "running") setCacheStatus(s);
      })
      .catch(() => {});
  }, [loadEntries, refreshStatus, refreshCacheEstimate, refreshEpStatus]);

  // Poll per-episode cache status every 3s while any episode is pending/running
  // or the global cache-all is active; stop when nothing is active.
  useEffect(() => {
    if (!epActive) return;
    const t = window.setInterval(refreshEpStatus, 3000);
    return () => window.clearInterval(t);
  }, [epActive, refreshEpStatus]);

  // Poll the cache run every 3s while pending/running; toast + refresh on settle.
  useEffect(() => {
    if (!cacheRunning) return;
    const t = window.setInterval(() => {
      void api
        .cacheAllStatus()
        .then((s) => {
          setCacheStatus(s);
          if (s.state === "done" || s.state === "succeeded") {
            toast(`Cached ${s.done} word lookups for offline use`);
            refreshCacheEstimate();
          } else if (
            s.state === "failed" ||
            s.state === "expired" ||
            s.state === "cancelled"
          ) {
            toast(`Cache all ${s.state}: ${s.error ?? "unknown error"}`);
            refreshCacheEstimate();
          }
        })
        .catch(() => {});
    }, 3000);
    return () => window.clearInterval(t);
  }, [cacheRunning, toast, refreshCacheEstimate]);

  const onCacheAll = useCallback(async () => {
    const est = cacheEst;
    if (!est || est.wordCount === 0) return;
    const ok = window.confirm(
      `Cache ${est.wordCount} words via Gemini batch (~$${est.estCostUsd.toFixed(
        2,
      )})? This only caches lookups, it does not add cards.`,
    );
    if (!ok) return;
    try {
      const r = await api.cacheAllStart();
      if (!r.started) {
        toast("Cache all: nothing to do");
        return;
      }
      setCacheStatus({ state: "running", total: r.total, done: 0, costUsd: 0 });
    } catch (e) {
      toast(`Cache all failed: ${e instanceof Error ? e.message : e}`);
    }
  }, [cacheEst, toast]);

  const cacheTitle = cacheEst
    ? cacheEst.wordCount === 0
      ? "All unknown words already cached"
      : `Cache word lookups for offline viewing · ${cacheEst.wordCount} new words · ~$${cacheEst.estCostUsd.toFixed(
          2,
        )} (Gemini batch) · ${cacheEst.alreadyCached} already cached`
    : "Cache word lookups for offline viewing";

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
        <div className="lib-head-left">
          <RootChooser
            toast={toast}
            onChanged={loadEntries}
            newWords={epStatus?.uniqueNewWords ?? newWordsTotal}
          />
          <YtAdd onSubmit={onYtSubmit} />
        </div>
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
            <button
              key={`${h.mediaId}:${h.start}:${i}`}
              type="button"
              className="a11y-rowbtn search-hit"
              onClick={() => go(`#/play/${h.mediaId}@${h.start}`)}
            >
              <span className="search-meta">
                {h.name.replace(/\.[^.]+$/, "")} · {fmtCueTime(h.start)}
              </span>{" "}
              {highlightMatch(h.text, query)}
            </button>
          ))}
        </div>
      )}
      <div className="batchbar">
        <button
          className="btn sm"
          title="Whisper-transcribe ja subs where missing, then translate to ru — for every entry"
          onClick={() => void onBatchAll()}
        >
          Transcribe &amp; translate all
        </button>
        <button
          className="btn sm"
          title={cacheTitle}
          disabled={cacheRunning || cacheEst?.wordCount === 0}
          onClick={() => void onCacheAll()}
        >
          {cacheRunning && cacheStatus
            ? `Caching… ${cacheStatus.done}/${cacheStatus.total}`
            : "Cache all"}
        </button>
        <button
          className="btn sm sort-toggle"
          disabled={sortBusy}
          title="Sort by name or by comprehensibility (known-word %)"
          onClick={() => void toggleSort()}
        >
          {sortBusy ? "sort: …" : `sort: ${sortMode === "name" ? "name" : "known %"}`}
        </button>
      </div>
      {cacheRunning && cacheStatus && (
        <div
          className={`cache-progress${cacheStatus.state === "pending" ? " indeterminate" : ""}`}
          title="Caching word lookups for offline viewing — this keeps running server-side even if you reload or close the page"
        >
          <div
            className="cache-progress-fill"
            style={{
              width:
                cacheStatus.state === "pending" || !cacheStatus.total
                  ? "100%"
                  : `${Math.round((cacheStatus.done / cacheStatus.total) * 100)}%`,
            }}
          />
          <span className="cache-progress-label">
            {cacheStatus.state === "pending"
              ? `Caching… queued at Gemini (${cacheStatus.total} words)`
              : `Caching… ${cacheStatus.done}/${cacheStatus.total} words`}
          </span>
        </div>
      )}
      <div className="grid">
        {ytRows.map((j) => (
          <div
            key={j.id}
            className={`card lib-row yt-row${j.status === "error" ? " err" : ""}${
              j.status === "probing" || j.status === "merging" ? " indet" : ""
            }`}
            aria-busy={j.status !== "error"}
            title={ytStatusLabel(j)}
          >
            <div className="lib-row-main">
              <div className="name">{j.title ?? j.url}</div>
            </div>
            <span className="ep-known yt-pct">
              {j.status === "error"
                ? "failed"
                : j.status === "downloading"
                  ? `${Math.round(j.percent)}%`
                  : j.status === "merging"
                    ? "merging…"
                    : "…"}
            </span>
            {j.status === "error" && (
              <button
                type="button"
                className="btn sm ghost yt-dismiss"
                aria-label="Dismiss"
                title={j.error ?? "Download failed"}
                onClick={() => dismissYtJob(j.id)}
              >
                ×
              </button>
            )}
            {j.status !== "error" && (
              <div className="yt-progress-bar">
                <i
                  style={{
                    width:
                      j.status === "probing" || j.status === "merging"
                        ? "100%"
                        : `${Math.round(j.percent)}%`,
                  }}
                />
              </div>
            )}
          </div>
        ))}
        {ordered.map((e) => {
          const resume = savedPositions.get(e.id) ?? null;
          const cov = coverage.get(e.id);
          return (
            <div
              key={e.id}
              className="card lib-row"
              role="button"
              tabIndex={0}
              onClick={() => go(`#/play/${e.id}`)}
              onKeyDown={onActivateKey(() => go(`#/play/${e.id}`))}
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
                  const es = epStatus?.episodes[e.id];
                  // Nothing to cache → render nothing.
                  if (!es || es.total === 0) return null;
                  const globalActive = epStatus?.globalActive ?? false;
                  const fullyCached = es.cached >= es.total;
                  const busy =
                    es.state === "pending" || es.state === "running";
                  // Already done → inert "Cached" chip.
                  if (fullyCached) {
                    return (
                      <button
                        type="button"
                        className="btn sm ep-cache"
                        disabled
                        title="All unknown words in this episode are cached for offline viewing"
                        onClick={(ev) => ev.stopPropagation()}
                      >
                        Cached
                      </button>
                    );
                  }
                  // In flight (this episode, or the global cache-all sweeping
                  // everything) → disabled progress label, no redundant click.
                  if (busy || globalActive) {
                    return (
                      <button
                        type="button"
                        className="btn sm ep-cache"
                        disabled
                        title="Caching word lookups for offline viewing"
                        onClick={(ev) => ev.stopPropagation()}
                      >
                        Caching… {es.cached}/{es.total}
                      </button>
                    );
                  }
                  // Idle with uncached words → offer the click.
                  return (
                    <button
                      type="button"
                      className="btn sm ep-cache"
                      title={`Cache ${es.total - es.cached} word lookup(s) for this episode (offline)`}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        void onCacheEpisode(e.id);
                      }}
                    >
                      Cache
                    </button>
                  );
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

export default Library;
