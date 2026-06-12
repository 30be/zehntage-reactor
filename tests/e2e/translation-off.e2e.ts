// Wave 11 hotfix: switching the translation track OFF mid-playback used to
// crash (stale activeS indexing an emptied secondaryCues). The helpers
// fixture fails any test that produces console/page errors, so these specs
// double as crash detectors.

import { test, expect } from "./helpers.ts";
import { openPlayer, playVideo, seekTo } from "./helpers.ts";

test("switching the translation off during playback does not crash", async ({ page }) => {
  await openPlayer(page, "clip.mp4");
  await seekTo(page, 3); // ja cue 2-5s, ru cue active
  await playVideo(page);
  await expect(page.locator(".sub-secondary")).toContainText("Я учусь.");

  // CC popover → Translation → off, while the ru cue is active.
  await page.locator(".vbar-cc").click();
  const pop = page.locator(".cc-pop");
  await expect(pop).toBeVisible();
  await pop.locator('input[name="cc-secondary"][value=""]').check();

  // RU line disappears, player stays alive (no pageerror — fixture asserts).
  await expect(page.locator(".sub-secondary")).toHaveCount(0);
  await expect(page.locator("video")).toBeVisible();
  await expect(page.locator(".sub-primary")).toContainText("勉強");

  // Still functional after further seeking.
  await seekTo(page, 7);
  await expect(page.locator(".sub-primary")).toContainText("図書館");
});

test("switching the translation back on restores the blurred line", async ({ page }) => {
  await openPlayer(page, "clip.mp4");
  await seekTo(page, 3);
  await page.locator(".vbar-cc").click();
  const pop = page.locator(".cc-pop");
  await pop.locator('input[name="cc-secondary"][value=""]').check();
  await expect(page.locator(".sub-secondary")).toHaveCount(0);
  await pop.locator('input[name="cc-secondary"][value="sidecar:gen:ru"]').check();
  await expect(page.locator(".sub-secondary")).toContainText("Я учусь.");
});

test("sidebar translation lines are blurred until the row is hovered", async ({ page }) => {
  await openPlayer(page, "clip.mp4");
  await seekTo(page, 3);
  await page.keyboard.press("l"); // open the cue sidebar
  await expect(page.locator(".cue-sidebar")).toBeVisible();
  const sec = page.locator(".cue-sidebar .cue-sec").first();
  await expect(sec).toBeVisible();
  const blurred = () =>
    sec.evaluate((el) => window.getComputedStyle(el).filter.includes("blur"));
  expect(await blurred()).toBe(true);
  await sec.hover(); // hovering the row reveals the translation
  await expect.poll(blurred).toBe(false);
  await page.mouse.move(10, 10);
  await expect.poll(blurred).toBe(true);
});
