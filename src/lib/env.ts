import { homedir } from "node:os";
import { join } from "node:path";

export interface Secrets {
  geminiApiKey: string | undefined;
  ankiUrl: string | undefined;
  ankiKey: string | undefined;
}

/** Parse a dotenv-style file: KEY=value lines, optional `export `, quotes, # comments. */
export function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2]!;
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    } else {
      // strip trailing comment for unquoted values
      const hash = value.indexOf(" #");
      if (hash !== -1) value = value.slice(0, hash);
      value = value.trim();
    }
    out[m[1]!] = value;
  }
  return out;
}

let cached: Secrets | null = null;

export async function loadSecrets(envPath?: string): Promise<Secrets> {
  if (cached && !envPath) return cached;
  const path = envPath ?? join(homedir(), ".env");
  let vars: Record<string, string> = {};
  try {
    vars = parseEnvText(await Bun.file(path).text());
  } catch {
    // missing ~/.env is fine; fall back to process env only
  }
  const get = (k: string) => vars[k] ?? process.env[k];
  const secrets: Secrets = {
    geminiApiKey: get("GEMINI_API_KEY"),
    ankiUrl: get("ZEHNTAGE_ANKI_URL"),
    ankiKey: get("ZEHNTAGE_ANKI_KEY"),
  };
  if (!envPath) cached = secrets;
  return secrets;
}
