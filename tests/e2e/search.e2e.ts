import { test, expect } from "./helpers.ts";

// Global subtitle search route (#/search): type a query that matches a fixture
// cue (clip.ja.srt line "図書館へ行きます。"), assert grouped results render
// with episode + timestamp, then click → land on the player at the cue time.

test("search route finds a cue and renders episode + timestamp", async ({ page }) => {
  await page.goto("/#/search");
  const input = page.locator(".search-route-input");
  await expect(input).toBeFocused();

  await input.fill("図書");

  const results = page.locator(".search-route-results");
  await expect(results).toBeVisible({ timeout: 10_000 });

  // grouped by episode
  const clipGroup = page.locator(".search-route-group", { hasText: "clip" });
  await expect(clipGroup.locator(".search-route-episode")).toContainText("clip");

  // the matching cue with a timestamp marker and a highlighted substring
  const hit = clipGroup.locator(".search-route-hit", { hasText: "図書館へ行きます" });
  await expect(hit).toBeVisible();
  await expect(hit.locator(".search-route-time")).toContainText("0:06");
  await expect(hit.locator("mark").first()).toHaveText("図書");
});

test("clicking a search result deep-links into the player at the cue time", async ({ page }) => {
  await page.goto("/#/search");
  await page.locator(".search-route-input").fill("図書");

  const clipGroup = page.locator(".search-route-group", { hasText: "clip" });
  const hit = clipGroup.locator(".search-route-hit", { hasText: "図書館へ行きます" });
  await expect(hit).toBeVisible({ timeout: 10_000 });
  await hit.click();

  // lands on the player with an @<start> deep-link (cue 2 starts at 6s)
  await expect(page).toHaveURL(/#\/play\/[a-f0-9]{12}@6\b/);
  const video = page.locator("video");
  await expect(video).toBeVisible();
});

test("no-match query shows an empty state", async ({ page }) => {
  await page.goto("/#/search");
  await page.locator(".search-route-input").fill("ZZZNOPE");
  await expect(page.locator(".search-route-status")).toHaveText("no matches", {
    timeout: 10_000,
  });
});
