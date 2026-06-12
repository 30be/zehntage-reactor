import { useCallback, useEffect, useRef, useState } from "react";
import { api, type BatchStatus, type LibraryEntry } from "./api.ts";
import { Player } from "./Player.tsx";

type Route =
  | { name: "library" }
  | { name: "player"; id: string }
  | { name: "settings" };

function parseHash(): Route {
  const h = window.location.hash.replace(/^#\/?/, "");
  if (h.startsWith("play/")) return { name: "player", id: h.slice("play/".length) };
  if (h === "settings") return { name: "settings" };
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
          <button className="btn ghost sm" onClick={() => go("#/settings")}>
            Settings
          </button>
        </nav>
      </header>

      <main className="container">
        {route.name === "library" && <Library go={go} toast={toast} />}
        {route.name === "settings" && (
          <Settings settings={settings} setSettings={setSettings} toast={toast} go={go} />
        )}
        {route.name === "player" && (
          <PlayerRoute id={route.id} toast={toast} settings={settings} go={go} />
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

function Library({ go, toast }: { go: (h: string) => void; toast: (m: string) => void }) {
  const [entries, setEntries] = useState<LibraryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<BatchStatus | null>(null);

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

  const onBatchSubtitle = async () => {
    try {
      const r = await api.batchSubtitle();
      toast(
        r.started.length > 0
          ? `Queued whisper for ${r.started.length} file(s)`
          : "Nothing to subtitle — all have Japanese tracks",
      );
      refreshStatus();
    } catch (e) {
      toast(`Batch subtitle failed: ${e instanceof Error ? e.message : e}`);
    }
  };

  const onBatchTranslate = async () => {
    try {
      const r = await api.batchTranslate();
      toast(
        r.started.length > 0
          ? `Queued translation for ${r.started.length} file(s)`
          : "Nothing to translate",
      );
      refreshStatus();
    } catch (e) {
      toast(`Batch translate failed: ${e instanceof Error ? e.message : e}`);
    }
  };

  if (error) return <div className="empty">Failed to load library: {error}</div>;
  if (!entries) return <div className="empty">Loading library…</div>;
  if (entries.length === 0) return <div className="empty">No video files found.</div>;

  return (
    <>
      <h1 className="h1">Library</h1>
      <div className="batchbar">
        <button className="btn sm" onClick={() => void onBatchSubtitle()}>
          Subtitle all (ja)
        </button>
        <button className="btn sm" onClick={() => void onBatchTranslate()}>
          Translate all → ru
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

function PlayerRoute({
  id,
  toast,
  settings,
  go,
}: {
  id: string;
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
      <Player key={entry.id} entry={entry} toast={toast} settings={settings} />
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
