import { useCallback, useEffect, useState } from "react";
import { api, type LibraryEntry } from "./api.ts";
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

  const toast = useCallback((msg: string) => {
    setToastMsg(msg);
    window.setTimeout(() => setToastMsg(null), 2600);
  }, []);

  const go = (hash: string) => {
    window.location.hash = hash;
  };

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">zehntage-reactor</span>
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
        {route.name === "library" && <Library go={go} />}
        {route.name === "settings" && (
          <Settings settings={settings} setSettings={setSettings} toast={toast} />
        )}
        {route.name === "player" && (
          <PlayerRoute id={route.id} toast={toast} settings={settings} go={go} />
        )}
      </main>

      {toastMsg && <div className="toast">{toastMsg}</div>}
    </div>
  );
}

function Library({ go }: { go: (h: string) => void }) {
  const [entries, setEntries] = useState<LibraryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api
      .library()
      .then(setEntries)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  if (error) return <div className="empty">Failed to load library: {error}</div>;
  if (!entries) return <div className="empty">Loading library…</div>;
  if (entries.length === 0) return <div className="empty">No video files found.</div>;

  return (
    <>
      <h1 className="h1">Library</h1>
      <div className="grid">
        {entries.map((e) => (
          <div key={e.id} className="card" onClick={() => go(`#/play/${e.id}`)}>
            <div className="name">{e.name}</div>
            <div className="meta">
              {e.relPath} · {fmtSize(e.size)}
            </div>
            <div className="badges">
              {e.subLangs.length === 0 && <span className="badge">no subs</span>}
              {e.subLangs.map((l, i) => (
                <span key={i} className="badge">
                  {l}
                </span>
              ))}
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
      <Player entry={entry} toast={toast} settings={settings} />
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
    (settings.primaryLang as string) || "ja",
  );
  const [secondaryLang, setSecondaryLang] = useState(
    (settings.secondaryLang as string) || "ru",
  );
  const [autoWhisper, setAutoWhisper] = useState(
    Boolean(settings.whisperAutoGenerate),
  );
  const promptDefault = (settings.lookupPromptDefault as string) || "";
  const [lookupPrompt, setLookupPrompt] = useState(
    (settings.lookupPrompt as string) || promptDefault,
  );
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setPrimaryLang((settings.primaryLang as string) || "ja");
    setSecondaryLang((settings.secondaryLang as string) || "ru");
    setAutoWhisper(Boolean(settings.whisperAutoGenerate));
    const def = (settings.lookupPromptDefault as string) || "";
    setLookupPrompt((settings.lookupPrompt as string) || def);
  }, [settings]);

  const onSave = async () => {
    setSaving(true);
    try {
      const next = await api.saveSettings({
        primaryLang,
        secondaryLang,
        whisperAutoGenerate: autoWhisper,
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
