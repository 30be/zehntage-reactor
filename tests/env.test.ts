import { describe, expect, test } from "bun:test";
import { parseEnvText, loadSecrets } from "../src/lib/env.ts";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("parseEnvText", () => {
  test("parses plain, quoted, exported, commented", () => {
    const vars = parseEnvText(`# comment
GEMINI_API_KEY=abc123
export ZEHNTAGE_ANKI_URL="https://example.com"
ZEHNTAGE_ANKI_KEY='secret key'
TRAILING=value # note
BAD LINE
`);
    expect(vars["GEMINI_API_KEY"]).toBe("abc123");
    expect(vars["ZEHNTAGE_ANKI_URL"]).toBe("https://example.com");
    expect(vars["ZEHNTAGE_ANKI_KEY"]).toBe("secret key");
    expect(vars["TRAILING"]).toBe("value");
    expect(Object.keys(vars)).toHaveLength(4);
  });
});

describe("loadSecrets", () => {
  test("loads from a custom env file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zehntage-env-"));
    const file = join(dir, ".env");
    await Bun.write(file, "GEMINI_API_KEY=g\nZEHNTAGE_ANKI_URL=u\nZEHNTAGE_ANKI_KEY=k\n");
    const s = await loadSecrets(file);
    expect(s).toEqual({ geminiApiKey: "g", ankiUrl: "u", ankiKey: "k" });
  });

  test("missing file yields undefineds (or process env)", async () => {
    const s = await loadSecrets("/nonexistent/.env");
    expect(typeof s).toBe("object");
  });
});
