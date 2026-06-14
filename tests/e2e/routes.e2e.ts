// E2E coverage for the Stats (#/stats) and Settings (#/settings) routes.
// These were extracted into StatsRoute.tsx / SettingsRoute.tsx and previously
// had no e2e tests. All selectors are derived from the actual source files.

import { test, expect } from "./helpers.ts";

// ─── Settings page ──────────────────────────────────────────────────────────

test.describe("Settings page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/#/settings");
    // Wait for the settings form to render (the first section heading)
    await expect(page.locator(".settings-form")).toBeVisible();
  });

  test("renders three main section headings", async ({ page }) => {
    const titles = page.locator(".group-title");
    // Languages / Player behavior / AI & prompt (Data is fourth)
    await expect(titles.filter({ hasText: "Languages" })).toBeVisible();
    await expect(titles.filter({ hasText: "Player behavior" })).toBeVisible();
    await expect(titles.filter({ hasText: "AI & prompt" })).toBeVisible();
  });

  test("renders Languages section with Primary and Secondary inputs", async ({
    page,
  }) => {
    await expect(page.locator("#settings-primaryLang")).toBeVisible();
    await expect(page.locator("#settings-secondaryLang")).toBeVisible();
  });

  test("renders Player behavior checkboxes", async ({ page }) => {
    await expect(page.locator("#furigana")).toBeVisible();
    await expect(page.locator("#autoQuizPrompt")).toBeVisible();
    await expect(page.locator("#autoWhisper")).toBeVisible();
    await expect(page.locator("#pitchAccent")).toBeVisible();
  });

  test("renders Data section with export/import buttons", async ({ page }) => {
    const dataSection = page.locator(".form-group", {
      has: page.locator(".group-title", { hasText: "Data" }),
    });
    await expect(dataSection).toBeVisible();
    await expect(
      dataSection.locator("button", { hasText: "Export data (JSON)" }),
    ).toBeVisible();
    await expect(
      dataSection.locator("button", { hasText: "Import data (JSON)" }),
    ).toBeVisible();
  });

  test("furigana checkbox is interactive and toggles its checked state", async ({
    page,
  }) => {
    const cb = page.locator("#furigana");
    const before = await cb.isChecked();
    await cb.click();
    // After click the state flips
    expect(await cb.isChecked()).toBe(!before);
    // Click again to restore
    await cb.click();
    expect(await cb.isChecked()).toBe(before);
  });

  test("secondary-language field accepts input", async ({ page }) => {
    const field = page.locator("#settings-secondaryLang");
    await field.fill("de");
    expect(await field.inputValue()).toBe("de");
  });

  test("settings persist: toggling furigana and reloading keeps the new value", async ({
    page,
  }) => {
    const cb = page.locator("#furigana");
    await expect(cb).toBeVisible();
    const before = await cb.isChecked();
    await cb.click();
    const after = !before;
    // Wait for the debounced autosave (600ms) + network round-trip
    await page.waitForTimeout(1200);

    // Reload and navigate back to settings
    await page.goto("/#/settings");
    await expect(page.locator(".settings-form")).toBeVisible();
    // The value should match what we set
    const reloaded = page.locator("#furigana");
    await expect(reloaded).toBeVisible();
    expect(await reloaded.isChecked()).toBe(after);

    // Restore original value so other tests start clean
    await reloaded.click();
    await page.waitForTimeout(1200);
  });
});

// ─── Stats page ──────────────────────────────────────────────────────────────

test.describe("Stats page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/#/stats");
    // The stats-totals block is always rendered regardless of data availability
    await expect(page.locator(".stats-totals").first()).toBeVisible();
  });

  test("renders the totals block with 'known words' and 'cards added' labels", async ({
    page,
  }) => {
    const totals = page.locator(".stats-totals").first();
    await expect(totals).toContainText("known words");
    await expect(totals).toContainText("cards added");
  });

  test("Activity section heading is present", async ({ page }) => {
    await expect(page.locator(".h2", { hasText: "Activity" })).toBeVisible();
  });

  test("Coverage section heading is present", async ({ page }) => {
    await expect(page.locator(".h2", { hasText: "Coverage" })).toBeVisible();
  });

  test("activity grid or loading state renders without crashing", async ({
    page,
  }) => {
    // Either the grid renders (if there are stats events) or a loading/empty
    // state appears — in either case there must be no JS error (checked by
    // the fixture) and the Activity heading must exist.
    await expect(page.locator(".h2", { hasText: "Activity" })).toBeVisible();

    // Confirm no unexpected crash by checking the main container stayed mounted
    await expect(page.locator(".stats-totals").first()).toBeVisible();
  });

  test("stats-list container renders for Coverage section", async ({
    page,
  }) => {
    // The .stats-list <div> is always rendered (it may be empty in the fixture)
    await expect(page.locator(".stats-list")).toBeVisible();
  });

  test("stat-num spans inside totals show a value (not blank)", async ({
    page,
  }) => {
    const nums = page.locator(".stats-totals").first().locator(".stat-num");
    const count = await nums.count();
    expect(count).toBeGreaterThanOrEqual(2);
    // Each .stat-num shows either a number or the loading ellipsis "…"
    for (const n of await nums.all()) {
      const text = (await n.textContent()) ?? "";
      expect(text.trim().length).toBeGreaterThan(0);
    }
  });
});
