import { test, expect } from "./helpers.ts";
import { openPlayer, seekTo, waitForTokens } from "./helpers.ts";

test("tracks auto-select: ja primary, generated ru secondary", async ({ page }) => {
  await openPlayer(page, "clip.mp4");
  const primary = page.locator(".track-pick", { hasText: "Primary" }).locator("select");
  const secondary = page.locator(".track-pick", { hasText: "Secondary" }).locator("select");
  await expect(primary).toHaveValue("sidecar:ja.srt");
  await expect(secondary).toHaveValue("sidecar:gen:ru");
  // generated-origin track gets a friendly label
  await expect(secondary.locator("option[value='sidecar:gen:ru']")).toContainText("Russian");
});

test("cue text appears at the seeked time", async ({ page }) => {
  await openPlayer(page, "clip.mp4");
  // NOTE: innerText includes furigana <rt> readings, so match word pieces.
  await seekTo(page, 3);
  await expect(page.locator(".sub-primary")).toContainText("勉強");
  await expect(page.locator(".sub-primary")).toContainText("します");
  await waitForTokens(page);
  await expect(page.locator(".sub-secondary")).toContainText("Я учусь.");
  await seekTo(page, 7);
  await expect(page.locator(".sub-primary")).toContainText("図書館");
  await expect(page.locator(".sub-primary")).toContainText("ます");
});
