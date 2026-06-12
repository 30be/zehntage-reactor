import { test, expect } from "./helpers.ts";
import { openPlayer, seekTo, waitForTokens } from "./helpers.ts";

test("tracks auto-select: ja primary, generated ru secondary (CC popover)", async ({ page }) => {
  await openPlayer(page, "clip.mp4");
  await page.locator(".vbar-cc").click();
  const pop = page.locator(".cc-pop");
  await expect(pop).toBeVisible();
  await expect(
    pop.locator('input[name="cc-primary"][value="sidecar:ja.srt"]'),
  ).toBeChecked();
  await expect(
    pop.locator('input[name="cc-secondary"][value="sidecar:gen:ru"]'),
  ).toBeChecked();
  // generated-origin track gets a friendly label
  await expect(pop).toContainText("Russian");
  // Esc closes the popover
  await page.keyboard.press("Escape");
  await expect(pop).toHaveCount(0);
});

test("cue text appears at the seeked time", async ({ page }) => {
  await openPlayer(page, "clip.mp4");
  // NOTE: innerText includes furigana <rt> readings, so match word pieces.
  await seekTo(page, 3);
  await expect(page.locator(".sub-primary")).toContainText("勉強");
  await expect(page.locator(".sub-primary")).toContainText("します");
  await waitForTokens(page);
  // The translation is no longer an always-visible line: it lives in the
  // "?" hover tooltip at the line's right edge — `b` hold also reveals it.
  await page.keyboard.down("b");
  await expect(page.locator(".sec-tip")).toContainText("Я учусь.");
  await page.keyboard.up("b");
  await expect(page.locator(".sec-tip")).toHaveCount(0);
  await seekTo(page, 7);
  await expect(page.locator(".sub-primary")).toContainText("図書館");
  await expect(page.locator(".sub-primary")).toContainText("ます");
});
