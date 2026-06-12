import { test, expect } from "./helpers.ts";

test("library renders fixture entries with sub badges", async ({ page }) => {
  await page.goto("/#/");
  const clip = page.locator(".card", { hasText: "clip.mp4" });
  await expect(clip).toBeVisible();
  await expect(clip.locator(".badge", { hasText: /^ja$/ })).toBeVisible();
  await expect(clip.locator(".badge", { hasText: /^ru$/ })).toBeVisible();
  const bare = page.locator(".card", { hasText: "bare.mp4" });
  await expect(bare.locator(".badge", { hasText: "no subs" })).toBeVisible();
});

test("clicking a card opens the player and the video gets a src", async ({ page }) => {
  await page.goto("/#/");
  await page.locator(".card", { hasText: "clip.mp4" }).click();
  await expect(page).toHaveURL(/#\/play\/[a-f0-9]{12}/);
  const video = page.locator("video");
  await expect(video).toBeVisible();
  await expect(video).toHaveAttribute("src", /\/media\/[a-f0-9]{12}/);
});
