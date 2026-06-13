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
  [key: string]: unknown;
}

const DEFAULTS: Settings = {
  targetLang: "ja",
  knownLang: "ru",
  blurSecondary: true,
  autoQuizPrompt: true,
  lookupPrompt: "",
  explainPrompt: "",
};

// ZR_CONFIG_DIR override keeps tests away from the user's real settings.
const dir =
  process.env.ZR_CONFIG_DIR || join(homedir(), ".config", "zehntage-reactor");
const file = join(dir, "settings.json");

export async function readSettings(): Promise<Settings> {
  try {
    const data = (await Bun.file(file).json()) as Partial<Settings>;
    return { ...DEFAULTS, ...data };
  } catch {
    return { ...DEFAULTS };
  }
}

export async function writeSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await readSettings();
  const next = { ...current, ...patch };
  await mkdir(dir, { recursive: true });
  await Bun.write(file, JSON.stringify(next, null, 2));
  return next;
}
