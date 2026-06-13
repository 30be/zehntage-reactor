// Telemetry backbone: POST /api/events batches land in the JSONL log and
// surface through GET /api/stats/summary; the stats page renders the
// activity grid from them.

import { test, expect } from "./helpers.ts";

test("posted event batch shows up in /api/stats/summary", async ({ page }) => {
  const now = Date.now();
  const mediaId = "feedfeedfeed";
  const res = await page.request.post("/api/events", {
    data: {
      events: [
        { ts: now, type: "heartbeat", mediaId, position: 10, paused: false },
        { ts: now + 15_000, type: "heartbeat", mediaId, position: 25, paused: false },
        { ts: now + 30_000, type: "heartbeat", mediaId, position: 25, paused: true },
        { ts: now + 31_000, type: "lookup", mediaId, word: "猫" },
        { ts: now + 32_000, type: "anki_add", mediaId, word: "猫" },
      ],
    },
  });
  expect(res.ok()).toBe(true);
  expect((await res.json()).count).toBe(5);

  const sum = await (await page.request.get("/api/stats/summary")).json();
  expect(Array.isArray(sum.days)).toBe(true);
  expect(Array.isArray(sum.media)).toBe(true);
  const today = sum.days[sum.days.length - 1];
  expect(today).toMatchObject({
    date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
  });
  expect(today.playSec).toBeGreaterThanOrEqual(30);
  expect(today.pauseSec).toBeGreaterThanOrEqual(15);
  expect(today.ankiAdds).toBeGreaterThanOrEqual(1);
  expect(today.lookups).toBeGreaterThanOrEqual(1);
  const m = sum.media.find((x: { mediaId: string }) => x.mediaId === mediaId);
  expect(m).toBeTruthy();
  expect(m.wallSec).toBeGreaterThanOrEqual(30);
  expect(m.contentSec).toBeGreaterThanOrEqual(15);
  expect(m.ankiAdds).toBe(1);
  expect(m.lookups).toBe(1);
});

test("events with bad body are rejected", async ({ page }) => {
  const res = await page.request.post("/api/events", { data: { nope: 1 } });
  expect(res.status()).toBe(400);
});

test("stats page renders the activity grid and daily list", async ({ page }) => {
  // Seed at least one playing heartbeat for today so the grid has a lit cell.
  await page.request.post("/api/events", {
    data: {
      events: [
        { ts: Date.now(), type: "heartbeat", mediaId: "feedfeedfeed", position: 1, paused: false },
      ],
    },
  });
  await page.goto("/#/stats");
  const grid = page.locator(".activity-grid");
  await expect(grid).toBeVisible();
  // ~20 weeks of day cells
  expect(await grid.locator(".activity-cell").count()).toBeGreaterThan(130);
  await expect(grid.locator(".activity-cell.s1, .activity-cell.s2, .activity-cell.s3, .activity-cell.s4").first()).toBeAttached();
  await expect(page.locator(".daily-row").first()).toBeVisible();
});

test("home page shows hotkeys and current library root", async ({ page }) => {
  await page.goto("/#/home");
  await expect(page.locator(".hotkey-grid .hotkey").first()).toBeVisible();
  await expect(page.locator(".home-root")).toContainText("fixtures/lib");
  await expect(page.locator(".home-root")).toContainText("entries");
});

test("sidebar navigates and marks the active item", async ({ page }) => {
  await page.goto("/#/");
  await expect(page.locator(".side-item.active")).toContainText("Library");
  await page.locator(".side-item", { hasText: "Stats" }).click();
  await expect(page).toHaveURL(/#\/stats/);
  await expect(page.locator(".side-item.active")).toContainText("Stats");
});

test("library root line shows the path; bad path errors with a toast", async ({ page }) => {
  await page.goto("/#/");
  const line = page.locator(".root-line");
  await expect(line).toContainText("fixtures/lib");
  await line.click();
  // Wait for the async browse response to populate the input — it would
  // otherwise overwrite a value typed mid-flight (race).
  await expect(page.locator(".root-input")).toHaveValue(/fixtures\/lib/);
  await page.locator(".root-input").fill("/definitely/not/a/dir");
  await page.locator(".root-line .btn", { hasText: "Set" }).click();
  await expect(page.locator(".toast")).toContainText("Set root failed");
});
