// Wave 3: transcript search, dialogue-density strip, b-hold RU unblur.

import { test, expect } from "./helpers.ts";
import { openPlayer, playVideo, seekTo } from "./helpers.ts";

test("transcript search finds a fixture line and navigates + seeks", async ({ page }) => {
  await page.goto("/#/");
  await page.locator(".search-input").fill("図書館");
  const hit = page.locator(".search-hit", { hasText: "図書館" });
  await expect(hit).toBeVisible();
  await expect(hit.locator("mark")).toHaveText("図書館");
  await expect(hit).toContainText("clip");
  await hit.click();
  await expect(page).toHaveURL(/#\/play\/[a-f0-9]+@6/);
  await expect(page.locator("video")).toBeVisible();
  // deep link seeks to the cue start (6s) once metadata loads
  await expect
    .poll(() =>
      page.evaluate(() => document.querySelector("video")!.currentTime),
    )
    .toBeGreaterThan(5.5);
});

test("search clears with Escape", async ({ page }) => {
  await page.goto("/#/");
  const input = page.locator(".search-input");
  await input.fill("図書館");
  await expect(page.locator(".search-hit").first()).toBeVisible();
  await input.press("Escape");
  await expect(input).toHaveValue("");
  await expect(page.locator(".search-results")).toHaveCount(0);
  await expect(page.locator(".grid")).toBeVisible();
});

test("density strip canvas renders when cues exist", async ({ page }) => {
  await openPlayer(page, "clip.mp4");
  await expect(page.locator("canvas.density-strip")).toBeVisible();
  await expect(page.locator(".density-marker")).toHaveCount(1);
});

test("b hold temporarily reveals the translation tooltip", async ({ page }) => {
  await openPlayer(page, "clip.mp4");
  await seekTo(page, 3); // ja cue 2-5s, ru cue active
  const hint = page.locator(".sec-hint");
  await expect(hint).toBeVisible(); // dim "?" at the JP line's right edge
  await expect(page.locator(".sec-tip")).toHaveCount(0);
  await page.keyboard.down("b");
  await expect(page.locator(".sec-tip")).toBeVisible();
  await expect(page.locator(".sec-tip")).toContainText("Я учусь.");
  await page.keyboard.up("b");
  await expect(page.locator(".sec-tip")).toHaveCount(0);
});

test("hovering the ? shows the tooltip and pauses; leaving resumes", async ({ page }) => {
  await openPlayer(page, "clip.mp4");
  await seekTo(page, 2.2);
  await playVideo(page);
  const hint = page.locator(".sec-hint");
  await hint.hover();
  await expect(page.locator(".sec-tip")).toContainText("Я учусь.");
  await expect(page.locator("video")).toHaveJSProperty("paused", true);
  // leave the hint → tooltip hides, playback resumes (we paused it)
  await page.mouse.move(10, 10);
  await expect(page.locator(".sec-tip")).toHaveCount(0);
  await expect(page.locator("video")).toHaveJSProperty("paused", false);
});
