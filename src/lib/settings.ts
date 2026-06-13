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
