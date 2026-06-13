import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSettings, writeSettings } from "../src/lib/settings.ts";

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
