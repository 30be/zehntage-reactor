// UI preferences persisted in ~/.config/zehntage-reactor/settings.json.

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";

export interface Settings {
  targetLang: string;
  knownLang: string;
  blurSecondary: boolean;
  /**
   * Show a quiet "comprehension check? (q)" affordance at the end of an
   * episode (in the session-summary overlay). Default true; press q to start
   * a quiz over the just-watched cues, or ignore/Esc to dismiss.
   */
  autoQuizPrompt: boolean;
  /**
   * Override template for the word-lookup prompt. Placeholders {word}
   * {context} {source} are substituted. Empty string means "use the
   * built-in default" (see gemini.ts DEFAULT_LOOKUP_PROMPT).
   */
  lookupPrompt: string;
  /**
   * Override template for the sentence-explain prompt. Placeholders
   * {sentence} {context} {secondary} {source} are substituted. Empty string
   * means "use the built-in default" (gemini.ts DEFAULT_EXPLAIN_PROMPT).
   */
  explainPrompt: string;
  /**
   * UI colour theme. "light" matches the app's current appearance.
   * "system" follows the OS preference. Default "light".
   */
  theme: "light" | "dark" | "system";
  /**
   * Google AI Studio (Gemini) API key. When non-empty it takes precedence over
   * the GEMINI_API_KEY environment variable (see gemini.ts callGemini). Stored
   * in the settings file like any other string preference; entered via a masked
   * password field on the Settings page. Empty string means "use the env var".
   */
  geminiApiKey: string;
  [key: string]: unknown;
}

const DEFAULTS: Settings = {
  targetLang: "ja",
  knownLang: "ru",
  blurSecondary: true,
  autoQuizPrompt: true,
  lookupPrompt: "",
  explainPrompt: "",
  theme: "light",
  geminiApiKey: "",
};

// ZR_CONFIG_DIR override keeps tests away from the user's real settings.
// Resolved lazily (per call) so tests can set the env var after import — same
// pattern as state.ts.
function configDir(): string {
  return process.env.ZR_CONFIG_DIR || join(homedir(), ".config", "zehntage-reactor");
}
function settingsFile(): string {
  return join(configDir(), "settings.json");
}

const VALID_THEMES = new Set<Settings["theme"]>(["light", "dark", "system"]);

/**
 * The exhaustive set of known settings keys. Used as an allowlist by the
 * POST /api/settings handler: unknown keys are silently dropped before
 * persisting, so stale/typo/injection keys never accumulate in the file.
 */
export const SETTINGS_KEYS = new Set<keyof Settings>([
  // strings
  "targetLang",
  "knownLang",
  "lookupPrompt",
  "explainPrompt",
  "theme",
  "geminiApiKey",
  // booleans
  "blurSecondary",
  "autoQuizPrompt",
  "whisperAutoGenerate",
  "furigana",
  "pitchAccent",
  "showSecondary",
  // numbers
  "prestudyMinutes",
  "shadowRepeats",
  "autopauseMinUnknown",
  "subScale",
  // enum
  "autopauseMode",
]);

// Settings whose value must be a finite number to be accepted.
const NUMBER_KEYS = new Set<string>([
  "prestudyMinutes",
  "shadowRepeats",
  "autopauseMinUnknown",
  "subScale",
]);
// Settings whose value must be a boolean to be accepted.
const BOOLEAN_KEYS = new Set<string>([
  "blurSecondary",
  "autoQuizPrompt",
  "whisperAutoGenerate",
  "furigana",
  "pitchAccent",
  "showSecondary",
]);
// Settings whose value must be a string to be accepted.
const STRING_KEYS = new Set<string>([
  "targetLang",
  "knownLang",
  "lookupPrompt",
  "explainPrompt",
  "theme",
  "geminiApiKey",
  "autopauseMode",
]);

/**
 * Validate and coerce an incoming patch from the API.
 *
 * Returns `{ ok: true, patch }` with only known keys whose values pass a
 * basic type check, or `{ ok: false, error }` when the input is not a
 * plain object (e.g. an array or primitive).
 *
 * Unknown keys are silently dropped. Known keys with wrong types are also
 * dropped (rather than 400-ing the whole request) to be forward-compatible
 * with older clients sending partial updates.
 */
export function validateSettingsPatch(
  raw: unknown,
): { ok: true; patch: Partial<Settings> } | { ok: false; error: string } {
  if (
    raw === null ||
    typeof raw !== "object" ||
    Array.isArray(raw)
  ) {
    return { ok: false, error: "body must be a JSON object" };
  }
  const input = raw as Record<string, unknown>;
  const patch: Partial<Settings> = {};
  for (const k of SETTINGS_KEYS) {
    const key = String(k);
    if (!(key in input)) continue;
    const val = input[key];
    const out = patch as Record<string, unknown>;
    if (STRING_KEYS.has(key)) {
      if (typeof val === "string") out[key] = val;
    } else if (BOOLEAN_KEYS.has(key)) {
      if (typeof val === "boolean") out[key] = val;
    } else if (NUMBER_KEYS.has(key)) {
      if (typeof val === "number" && Number.isFinite(val)) out[key] = val;
    }
  }
  return { ok: true, patch };
}

function normalize(data: Partial<Settings>): Settings {
  const merged: Settings = { ...DEFAULTS, ...data };
  if (!VALID_THEMES.has(merged.theme)) merged.theme = "light";
  return merged;
}

export async function readSettings(): Promise<Settings> {
  try {
    const data = (await Bun.file(settingsFile()).json()) as Partial<Settings>;
    return normalize(data);
  } catch {
    return { ...DEFAULTS };
  }
}

export async function writeSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await readSettings();
  const next = { ...current, ...patch };
  await mkdir(configDir(), { recursive: true });
  await Bun.write(settingsFile(), JSON.stringify(next, null, 2));
  return next;
}
