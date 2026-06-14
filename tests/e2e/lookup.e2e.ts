import { test, expect } from "./helpers.ts";
import { openPlayer, seekTo, waitForTokens } from "./helpers.ts";

test.beforeEach(async ({ page }) => {
  await openPlayer(page, "clip.mp4");
  await seekTo(page, 3); // 勉強します。
  await waitForTokens(page);
});

test("hover word opens popup with fake lookup; Escape closes", async ({ page }) => {
  await page.locator(".sub-primary .tok").first().hover();
  const popup = page.locator(".lookup");
  await expect(popup).toBeVisible();
  await expect(popup).toContainText("勉強");
  await expect(popup).toContainText("перевод(勉強)");
  await expect(popup).toContainText("fake-notes(勉強)");
  await page.keyboard.press("Escape");
  await expect(popup).toHaveCount(0);
});

test("click pins the popup; it survives hover-out, Escape closes", async ({ page }) => {
  await page.locator(".sub-primary .tok").first().click();
  const popup = page.locator(".lookup.pinned");
  await expect(popup).toBeVisible();
  await page.mouse.move(5, 5);
  // The pinned popup must NOT close on hover-out. Playwright's auto-retry on
  // toBeVisible() proves it stays up without sleeping out the grace period.
  await expect(popup).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".lookup")).toHaveCount(0);
});

test("sentence (?) opens explain panel; ask appends fake Q/A", async ({ page }) => {
  await page.locator(".explain-q").click();
  const popup = page.locator(".lookup");
  await expect(popup).toBeVisible();
  await expect(popup).toContainText("fake-перевод(勉強します。)");
  await expect(popup).toContainText("fake-breakdown(勉強します。)");
  await expect(popup).toContainText("fake-idioms");

  const ask = popup.locator(".ask-input");
  await ask.fill("почему?");
  await ask.press("Enter");
  await expect(popup.locator(".qa-q")).toContainText("почему?");
  await expect(popup.locator(".qa-a")).toContainText("fake-answer(почему?)");
});
