// Read mode (#/read/<id>): first e2e coverage — token rendering, the word
// popup (click-pinned, deck/Gemini lookup) and the x blacklist hotkey.

import { test, expect, entryId } from "./helpers.ts";

async function openRead(page: import("@playwright/test").Page): Promise<string> {
  const id = await entryId(page, "clip.mp4");
  await page.goto(`/#/read/${id}`);
  await expect(page.locator(".read-mode")).toBeVisible();
  return id;
}

test("read mode renders tokenized paragraphs with translations", async ({ page }) => {
  await openRead(page);
  await expect(page.locator(".read-para").first()).toBeVisible();
  await expect(page.locator(".read-mode")).toContainText("図書館");
  // tokenizer splits the lines into hoverable tokens (dict init can be slow)
  await expect(page.locator(".read-para .tok").first()).toBeVisible({ timeout: 20_000 });
  // secondary RU lines render (toggleable via the ru on/off button)
  await expect(page.locator(".read-secondary").first()).toContainText("Я");
});

test("clicking a word opens the popup and looks it up", async ({ page }) => {
  await openRead(page);
  const tok = page.locator(".read-para .tok").first();
  await tok.waitFor({ timeout: 20_000 });
  await tok.click();
  const popup = page.locator(".read-popup");
  await expect(popup).toBeVisible();
  await expect(popup.locator(".word")).not.toBeEmpty();
  // fake-gemini lookup fills the translation
  await expect(popup.locator(".translation")).toBeVisible();
  // Esc closes
  await page.keyboard.press("Escape");
  await expect(popup).toHaveCount(0);
});

test("x hotkey toggles blacklist for the popup word", async ({ page }) => {
  await openRead(page);
  const tok = page.locator(".read-para .tok").first();
  await tok.waitFor({ timeout: 20_000 });
  await tok.click();
  const popup = page.locator(".read-popup");
  await expect(popup).toBeVisible();
  await page.keyboard.press("x");
  await expect(popup.locator(".known-flag", { hasText: "blacklisted" })).toBeVisible();
  await page.keyboard.press("x");
  await expect(popup.locator(".known-flag", { hasText: "blacklisted" })).toHaveCount(0);
});
