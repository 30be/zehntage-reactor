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

test("b hold temporarily unblurs the secondary line", async ({ page }) => {
  await openPlayer(page, "clip.mp4");
  await seekTo(page, 3); // ja cue 2-5s, ru line shown (blurred)
  const sec = page.locator(".sub-secondary");
  await expect(sec).toBeVisible();
  await expect(sec).not.toHaveClass(/\bshow\b/);
  await page.keyboard.down("b");
  await expect(sec).toHaveClass(/\bshow\b/);
  await page.keyboard.up("b");
  await expect(sec).not.toHaveClass(/\bshow\b/);
});

test("hovering the secondary line unblurs it and pauses; leaving resumes", async ({ page }) => {
  await openPlayer(page, "clip.mp4");
  await seekTo(page, 2.2);
  await playVideo(page);
  const sec = page.locator(".sub-secondary");
  await expect(sec).toBeVisible();
  await sec.hover();
  await expect(sec).toHaveClass(/\bshow\b/);
  await expect(page.locator("video")).toHaveJSProperty("paused", true);
  // leave the line → re-blurs, playback resumes (we paused it)
  await page.mouse.move(10, 10);
  await expect(sec).not.toHaveClass(/\bshow\b/);
  await expect(page.locator("video")).toHaveJSProperty("paused", false);
});
