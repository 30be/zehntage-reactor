// Capture UI screenshots for the README.
// Run: bun run scripts/screenshots.ts
// Requires the dev server running at http://localhost:8417 (the real library).
//
// Mirrors the e2e setup: drives chromium via @playwright/test's bundled browser.

import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const BASE = process.env.ZR_BASE ?? "http://localhost:8417";
const OUT = join(import.meta.dir, "..", "docs", "screenshots");

type Shot = { route: string; name: string; selector?: string };

const LIGHT: Shot[] = [
  { route: "/", name: "library-light", selector: ".container" },
  { route: "/cards", name: "cards", selector: ".container" },
  { route: "/stats", name: "stats", selector: ".container" },
  { route: "/home", name: "home-hotkeys", selector: ".hotkey-grid" },
];

const DARK: Shot[] = [
  { route: "/", name: "library-dark", selector: ".container" },
  { route: "/cards", name: "cards-dark", selector: ".container" },
];

async function main() {
  await mkdir(OUT, { recursive: true });

  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();

  async function capture(shots: Shot[], theme: "light" | "dark") {
    for (const { route, name, selector } of shots) {
      await page.goto(`${BASE}/#${route}`, { waitUntil: "load", timeout: 30_000 });
      // Settle: a key selector if given, else network idle, with a bounded wait.
      if (selector) {
        await page.locator(selector).first().waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
      }
      await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
      // Force the theme deterministically. The app applies the persisted server
      // setting via an onload effect, so override the dataset AFTER it settles.
      await page.evaluate((t) => {
        localStorage.setItem("zr.theme", t);
        document.documentElement.dataset.theme = t;
      }, theme);
      await page.waitForTimeout(600); // let theme transition / fonts settle
      const file = join(OUT, `${name}.png`);
      await page.screenshot({ path: file });
      console.log(`wrote ${file}`);
    }
  }

  await capture(LIGHT, "light");
  await capture(DARK, "dark");

  await browser.close();
  console.log("done");
}

main().catch((err) => {
  console.error("screenshot run failed:", err);
  process.exit(1);
});
