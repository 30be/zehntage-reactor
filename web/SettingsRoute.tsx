// #/settings — Settings page: language tracks, player behavior toggles,
// AI/prompt editors, and a Data export/import bundle. Autosaves on change
// (debounced) and flushes on blur. Extracted verbatim from App.tsx
// (behavior-preserving).

import { useCallback, useEffect, useRef, useState } from "react";
import { api, type SnapshotMeta } from "./api.ts";
import { clampMinutesGoal, loadMinutesGoal, saveMinutesGoal } from "./timer.ts";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function Settings({
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
  const [blurSecondary, setBlurSecondary] = useState(
    settings.blurSecondary !== false,
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
  // G4: daily immersion goal (minutes) — persisted to localStorage, not the
  // server settings, mirroring the cards daily goal (web/timer.ts).
  const [minutesGoal, setMinutesGoal] = useState<string>(() =>
    String(loadMinutesGoal()),
  );

  useEffect(() => {
    setPrimaryLang((settings.targetLang as string) || "ja");
    setSecondaryLang((settings.knownLang as string) || "ru");
    setAutoWhisper(Boolean(settings.whisperAutoGenerate));
    setBlurSecondary(settings.blurSecondary !== false);
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
    blurSecondary,
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
    blurSecondary,
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
        // TODO(player): read settings.blurSecondary instead of useState(false)
        blurSecondary: s.blurSecondary,
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
            <label htmlFor="autoWhisper">
              Auto-generate Japanese subtitles{" "}
              <span className="hint">(not yet enforced by server)</span>
            </label>
          </div>
          <div
            className="switch"
            title="Blur the secondary (translation) subtitle track until hovered"
          >
            <input
              type="checkbox"
              id="blurSecondary"
              checked={blurSecondary}
              onChange={(e) => {
                setBlurSecondary(e.target.checked);
                scheduleSave();
              }}
            />
            {/* TODO(player): read settings.blurSecondary instead of useState(false) */}
            <label htmlFor="blurSecondary">Blur secondary subtitles until hovered</label>
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
          <div className="field-row">
            <div className="field">
              <label htmlFor="minutesGoal">Daily immersion goal (minutes)</label>
              <input
                id="minutesGoal"
                type="number"
                min={1}
                max={600}
                title="Target focused watch time per day; shown in the player session HUD (o)."
                value={minutesGoal}
                onChange={(e) => {
                  setMinutesGoal(e.target.value);
                  // Don't snap to the clamp min while the field is mid-edit
                  // (empty/partial) — onBlur re-clamps and persists.
                  if (e.target.value.trim() !== "")
                    saveMinutesGoal(clampMinutesGoal(Number(e.target.value)));
                }}
                onBlur={() => {
                  const clamped = clampMinutesGoal(Number(minutesGoal));
                  setMinutesGoal(String(clamped));
                  saveMinutesGoal(clamped);
                }}
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
                  // Set "" so gemini.ts treats it as "use built-in default"
                  // (template && template.trim() check). Storing the full text
                  // would snapshot the current default and miss future updates.
                  setLookupPrompt("");
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
                  // Set "" so gemini.ts treats it as "use built-in default"
                  // (template && template.trim() check). Storing the full text
                  // would snapshot the current default and miss future updates.
                  setExplainPrompt("");
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

  // --- snapshots (auto-backup) ---
  const [snapshots, setSnapshots] = useState<SnapshotMeta[]>([]);
  const [snapConfirm, setSnapConfirm] = useState<string | null>(null);
  const [snapBusy, setSnapBusy] = useState(false);

  const loadSnapshots = useCallback(async () => {
    try {
      const res = await api.listSnapshots();
      setSnapshots(res.snapshots);
    } catch {
      setSnapshots([]);
    }
  }, []);

  useEffect(() => {
    void loadSnapshots();
  }, [loadSnapshots]);

  const onRestoreSnapshot = useCallback(
    async (name: string) => {
      setSnapBusy(true);
      setMsg(null);
      try {
        const res = await api.restoreSnapshot(name);
        const next = await api.getSettings();
        setSettings(next);
        setSnapConfirm(null);
        setMsg({
          kind: "ok",
          text: `Restored${res.settingsImported ? " settings," : ""} ${res.stateKeys} state keys. Reloading…`,
        });
        window.setTimeout(() => window.location.reload(), 800);
      } catch (e) {
        setMsg({
          kind: "error",
          text: `Restore failed: ${e instanceof Error ? e.message : e}`,
        });
      } finally {
        setSnapBusy(false);
      }
    },
    [setSettings],
  );

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
      <div className="field">
        <label className="label">Snapshots</label>
        <div className="hint">
          Automatic local backups taken on startup (kept: last 3). Restoring
          overwrites current settings and merges saved progress.
        </div>
        {snapshots.length === 0 ? (
          <div className="hint">No snapshots yet.</div>
        ) : (
          snapshots.map((s) => (
            <div className="field-row" key={s.name}>
              <span>
                {new Date(s.timestamp).toLocaleString()} · {formatBytes(s.size)}
              </span>
              {snapConfirm === s.name ? (
                <>
                  <button
                    className="btn sm danger"
                    disabled={snapBusy}
                    onClick={() => void onRestoreSnapshot(s.name)}
                  >
                    {snapBusy ? "Restoring…" : "Confirm restore"}
                  </button>
                  <button
                    className="btn sm ghost"
                    disabled={snapBusy}
                    onClick={() => setSnapConfirm(null)}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  className="btn sm danger"
                  disabled={snapBusy}
                  onClick={() => setSnapConfirm(s.name)}
                >
                  Restore
                </button>
              )}
            </div>
          ))
        )}
      </div>
    </section>
  );
}

export default Settings;
