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

type Route =
  | { name: "library" }
  | { name: "player"; id: string; t?: number }
  | { name: "settings" }
  | { name: "stats" };

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
  return { name: "library" };
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
  }, []);

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

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="#/" title="Back to Library">
          zehntage-reactor
        </a>
        <nav>
          <button className="btn ghost sm" onClick={() => go("#/")}>
            Library
          </button>
          <button className="btn ghost sm" onClick={() => go("#/stats")}>
            Stats
          </button>
          <button className="btn ghost sm" onClick={() => go("#/settings")}>
            Settings
          </button>
        </nav>
      </header>

      <main className="container">
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
  if (entries.length === 0) return <div className="empty">No video files found.</div>;

  return (
    <>
      <h1 className="h1">Library</h1>
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

function Stats({ go }: { go: (h: string) => void }) {
  const [entries, setEntries] = useState<LibraryEntry[] | null>(null);
  const [anki, setAnki] = useState<AnkiWordsResponse | null>(null);
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
