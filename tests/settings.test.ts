import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSettings, writeSettings, validateSettingsPatch, SETTINGS_KEYS } from "../src/lib/settings.ts";

let base: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "zr-settings-test-"));
  savedEnv["ZR_CONFIG_DIR"] = process.env.ZR_CONFIG_DIR;
  process.env.ZR_CONFIG_DIR = base;
});

afterEach(async () => {
  process.env.ZR_CONFIG_DIR = savedEnv["ZR_CONFIG_DIR"];
  await rm(base, { recursive: true, force: true });
});

// --- M20-1 / M20-2: validateSettingsPatch ---

describe("validateSettingsPatch", () => {
  test("rejects null", () => {
    const r = validateSettingsPatch(null);
    expect(r.ok).toBe(false);
  });

  test("rejects a primitive (number)", () => {
    const r = validateSettingsPatch(42);
    expect(r.ok).toBe(false);
  });

  test("rejects a string", () => {
    const r = validateSettingsPatch("hello");
    expect(r.ok).toBe(false);
  });

  test("rejects an array body (M20-2: prevents numeric-key pollution)", () => {
    const r = validateSettingsPatch(["a", "b"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/object/i);
  });

  test("accepts a valid partial settings object", () => {
    const r = validateSettingsPatch({ theme: "dark", blurSecondary: false });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.patch.theme).toBe("dark");
      expect(r.patch.blurSecondary).toBe(false);
    }
  });

  test("silently drops unknown keys", () => {
    const r = validateSettingsPatch({ theme: "light", evil: "payload", __proto__: "x" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.patch.theme).toBe("light");
      expect("evil" in r.patch).toBe(false);
    }
  });

  test("drops known keys with wrong types", () => {
    // blurSecondary must be boolean, not string
    const r = validateSettingsPatch({ blurSecondary: "yes", theme: "dark" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect("blurSecondary" in r.patch).toBe(false);
      expect(r.patch.theme).toBe("dark");
    }
  });

  test("empty object is accepted (no-op patch)", () => {
    const r = validateSettingsPatch({});
    expect(r.ok).toBe(true);
    if (r.ok) expect(Object.keys(r.patch)).toHaveLength(0);
  });

  test("SETTINGS_KEYS covers all expected keys", () => {
    const expected = [
      "targetLang", "knownLang", "blurSecondary", "autoQuizPrompt",
      "lookupPrompt", "explainPrompt", "theme", "geminiApiKey",
      // player/learning prefs the UI actually persists (regression: these
      // were dropped by an over-narrow allowlist and stopped persisting)
      "whisperAutoGenerate", "furigana", "pitchAccent", "showSecondary",
      "prestudyMinutes", "shadowRepeats", "autopauseMinUnknown", "subScale",
      "autopauseMode",
    ];
    for (const k of expected) {
      expect(SETTINGS_KEYS.has(k as Parameters<typeof SETTINGS_KEYS.has>[0])).toBe(true);
    }
  });

  test("accepts numeric settings (subScale, autopauseMinUnknown)", () => {
    const r = validateSettingsPatch({ subScale: 0.9, autopauseMinUnknown: 3 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect((r.patch as Record<string, unknown>).subScale).toBe(0.9);
      expect((r.patch as Record<string, unknown>).autopauseMinUnknown).toBe(3);
    }
  });

  test("drops non-finite / wrong-typed numeric settings", () => {
    const r = validateSettingsPatch({ subScale: "big", autopauseMinUnknown: NaN });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect("subScale" in r.patch).toBe(false);
      expect("autopauseMinUnknown" in r.patch).toBe(false);
    }
  });

  test("accepts geminiApiKey as a string, drops a non-string value", () => {
    const ok = validateSettingsPatch({ geminiApiKey: "AIzaSecret" });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect((ok.patch as Record<string, unknown>).geminiApiKey).toBe("AIzaSecret");
    const bad = validateSettingsPatch({ geminiApiKey: 12345 });
    expect(bad.ok).toBe(true);
    if (bad.ok) expect("geminiApiKey" in bad.patch).toBe(false);
  });

  test("accepts furigana/autopauseMode (regression: persistence)", () => {
    const r = validateSettingsPatch({ furigana: false, autopauseMode: "unknown" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect((r.patch as Record<string, unknown>).furigana).toBe(false);
      expect((r.patch as Record<string, unknown>).autopauseMode).toBe("unknown");
    }
  });
});

// --- Integration: writeSettings only persists allowlisted keys ---

describe("writeSettings allowlist integration", () => {
  test("unknown keys in patch are not persisted", async () => {
    // validateSettingsPatch strips unknowns; writeSettings receives clean patch.
    const r = validateSettingsPatch({ theme: "dark", injected: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await writeSettings(r.patch);
    const s = await readSettings();
    expect(s.theme).toBe("dark");
    expect((s as Record<string, unknown>)["injected"]).toBeUndefined();
  });

  test("array patch via validateSettingsPatch is rejected before writeSettings", async () => {
    const initial = await readSettings();
    const r = validateSettingsPatch(["a", "b", "c"]);
    expect(r.ok).toBe(false);
    // settings must be unchanged
    const after = await readSettings();
    expect(after.theme).toBe(initial.theme);
    expect(Object.keys(after).filter(k => /^\d+$/.test(k))).toHaveLength(0);
  });
});

describe("settings theme field", () => {
  test("default theme is light", async () => {
    const s = await readSettings();
    expect(s.theme).toBe("light");
  });

  test("valid themes are preserved", async () => {
    for (const theme of ["light", "dark", "system"] as const) {
      await writeSettings({ theme });
      const s = await readSettings();
      expect(s.theme).toBe(theme);
    }
  });

  test("invalid persisted theme normalizes to light", async () => {
    // Write a raw settings file with a bogus theme value.
    await Bun.write(join(base, "settings.json"), JSON.stringify({ theme: "solarized" }));
    const s = await readSettings();
    expect(s.theme).toBe("light");
  });
});
