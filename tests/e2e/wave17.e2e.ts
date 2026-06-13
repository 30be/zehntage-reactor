// Wave 17 — Read-mode enrichment: cursor navigation (j/k/arrows), resume
// affordance, progress indicator.
//
// Uses read.mp4 (fixtures/lib/read.mp4 + read.ja.srt), which has 4 cues with
// >5 s gaps between each, so buildParagraphs() yields 4 distinct .read-para
// elements (one per cue).  clip.mp4's 6 cues are all <1.5 s apart, collapsing
// into one paragraph — hence this dedicated fixture.
//
// Isolation: each test pins zr.read.pos.<id> (and the zr.sync.ts clock for
// that key) via addInitScript so server-state from writeFurthest never bleeds
// across tests regardless of run order.

import { test, expect, entryId } from "./helpers.ts";

async function openRead(page: import("@playwright/test").Page): Promise<string> {
  const id = await entryId(page, "read.mp4");

  // Isolation: clear any server-synced read progress for this entry.
  // Set a far-future zr.sync.ts so the client-local value (empty) wins the
  // last-write-wins merge with whatever the server has stored.
  await page.addInitScript(([mid]) => {
    const key = `zr.read.pos.${mid}`;
    localStorage.removeItem(key);
    const tsMap = (() => {
      try { return JSON.parse(localStorage.getItem("zr.sync.ts") ?? "{}"); }
      catch { return {}; }
    })();
    tsMap[key] = Date.now() + 2e9;
    localStorage.setItem("zr.sync.ts", JSON.stringify(tsMap));
  }, [id] as const);

  await page.goto(`/#/read/${id}`);
  await expect(page.locator(".read-mode")).toBeVisible();
  // wait for at least one paragraph
  await expect(page.locator(".read-para").first()).toBeVisible();
  return id;
}

// ---- cursor navigation -------------------------------------------------------

test("j/k keys move the cursor highlight through paragraphs", async ({ page }) => {
  await openRead(page);

  // Initially no cursor line.
  await expect(page.locator(".read-para.read-cursor")).toHaveCount(0);

  // Press j → first paragraph gains cursor.
  await page.keyboard.press("j");
  await expect(page.locator(".read-para.read-cursor")).toHaveCount(1);
  const first = page.locator(".read-para").first();
  await expect(first).toHaveClass(/read-cursor/);

  // Press j again → cursor moves to second paragraph.
  await page.keyboard.press("j");
  const paras = page.locator(".read-para");
  await expect(paras.nth(1)).toHaveClass(/read-cursor/);
  await expect(paras.nth(0)).not.toHaveClass(/read-cursor/);

  // Press k → cursor moves back to first paragraph.
  await page.keyboard.press("k");
  await expect(paras.nth(0)).toHaveClass(/read-cursor/);
  await expect(paras.nth(1)).not.toHaveClass(/read-cursor/);
});

test("arrow keys also navigate the cursor", async ({ page }) => {
  await openRead(page);

  await page.keyboard.press("ArrowDown");
  await expect(page.locator(".read-para.read-cursor")).toHaveCount(1);
  await expect(page.locator(".read-para").first()).toHaveClass(/read-cursor/);

  await page.keyboard.press("ArrowDown");
  await expect(page.locator(".read-para").nth(1)).toHaveClass(/read-cursor/);

  await page.keyboard.press("ArrowUp");
  await expect(page.locator(".read-para").nth(0)).toHaveClass(/read-cursor/);
});

test("cursor does not go below first paragraph", async ({ page }) => {
  await openRead(page);
  // Already at index 0 after first j; another k should stay at 0.
  await page.keyboard.press("j");
  await page.keyboard.press("k");
  await page.keyboard.press("k");
  await expect(page.locator(".read-para").first()).toHaveClass(/read-cursor/);
});

test("clicking a paragraph moves the cursor to that paragraph", async ({ page }) => {
  await openRead(page);
  const paras = page.locator(".read-para");
  const count = await paras.count();
  if (count < 2) return; // fixture too short; skip
  const second = paras.nth(1);
  // Click the paragraph div itself (outside any token) to set cursor without
  // opening a word popup.  Use force:true so the click lands on the div even
  // if tokens fill its bounding box; Playwright still fires the React onClick.
  await second.click({ force: true });
  await expect(second).toHaveClass(/read-cursor/);
});

// ---- progress + header -------------------------------------------------------

test("header shows line count", async ({ page }) => {
  await openRead(page);
  // The header meta should contain "lines" text.
  await expect(page.locator(".read-header-meta")).toContainText("lines");
});

test("progress bar appears after navigating at least one line", async ({ page }) => {
  await openRead(page);
  // No progress bar at the very start.
  await expect(page.locator(".read-progress-track")).toHaveCount(0);

  await page.keyboard.press("j");
  // Progress bar should now be visible.
  await expect(page.locator(".read-progress-track")).toBeVisible();
  await expect(page.locator(".read-progress-fill")).toBeVisible();
  // Progress label in the header should show a %.
  await expect(page.locator(".read-progress-label")).toContainText("%");
});

// ---- resume affordance -------------------------------------------------------

test("resume affordance appears on reopen after reading some lines", async ({ page }) => {
  const id = await entryId(page, "read.mp4");

  // Seed progress in localStorage: pretend we read to paragraph 2.
  // Pin the sync timestamp so the server cannot overwrite this value.
  await page.addInitScript(([mid]) => {
    const key = `zr.read.pos.${mid}`;
    localStorage.setItem(key, "2");
    const tsMap = (() => {
      try { return JSON.parse(localStorage.getItem("zr.sync.ts") ?? "{}"); }
      catch { return {}; }
    })();
    tsMap[key] = Date.now() + 2e9;
    localStorage.setItem("zr.sync.ts", JSON.stringify(tsMap));
  }, [id] as const);

  await page.goto(`/#/read/${id}`);
  await expect(page.locator(".read-mode")).toBeVisible();
  await expect(page.locator(".read-para").first()).toBeVisible();

  // The resume button should appear.
  const resume = page.locator(".read-resume");
  await expect(resume).toBeVisible();
  await expect(resume).toContainText("resume");

  // Clicking it dismisses the affordance and positions the cursor at the
  // saved paragraph (the cursor highlight should appear).
  await resume.click();
  await expect(resume).toHaveCount(0);
  await expect(page.locator(".read-para.read-cursor")).toHaveCount(1);
  // The cursor should be on paragraph index 2 (the saved position).
  await expect(page.locator('[data-para-index="2"]')).toHaveClass(/read-cursor/);
});

test("resume affordance is absent on first visit (no saved progress)", async ({ page }) => {
  await openRead(page);
  // With no seeded localStorage, no resume button.
  await expect(page.locator(".read-resume")).toHaveCount(0);
});

test("resume affordance is dismissed when navigating before clicking it", async ({
  page,
}) => {
  const id = await entryId(page, "read.mp4");

  // Seed progress + pin sync clock so server state cannot overwrite it.
  await page.addInitScript(([mid]) => {
    const key = `zr.read.pos.${mid}`;
    localStorage.setItem(key, "1");
    const tsMap = (() => {
      try { return JSON.parse(localStorage.getItem("zr.sync.ts") ?? "{}"); }
      catch { return {}; }
    })();
    tsMap[key] = Date.now() + 2e9;
    localStorage.setItem("zr.sync.ts", JSON.stringify(tsMap));
  }, [id] as const);

  await page.goto(`/#/read/${id}`);
  await expect(page.locator(".read-resume")).toBeVisible();

  // Once the user navigates (cursor becomes >= 0), the resume affordance hides
  // automatically — cursor navigation replaces the need for it.
  await page.keyboard.press("j");
  await expect(page.locator(".read-resume")).toHaveCount(0);
});
