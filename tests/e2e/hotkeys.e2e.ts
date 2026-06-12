import { test, expect } from "./helpers.ts";
import { openPlayer, seekTo, video, waitForTokens } from "./helpers.ts";

test("space toggles play/pause", async ({ page }) => {
  await openPlayer(page, "clip.mp4");
  await expect(video(page)).toHaveJSProperty("paused", true);
  await page.keyboard.press(" ");
  await expect(video(page)).toHaveJSProperty("paused", false);
  await page.keyboard.press(" ");
  await expect(video(page)).toHaveJSProperty("paused", true);
});

test("f fullscreens the stage element", async ({ page }) => {
  await openPlayer(page, "clip.mp4");
  await page.keyboard.press("f");
  await expect
    .poll(() =>
      page.evaluate(
        () => document.fullscreenElement?.classList.contains("video-stage") ?? false,
      ),
    )
    .toBe(true);
  await page.keyboard.press("f");
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
});

test("a replays the current cue (currentTime jumps back to cue start)", async ({ page }) => {
  await openPlayer(page, "clip.mp4");
  await seekTo(page, 8); // inside cue 2 (6–9s)
  await waitForTokens(page);
  await page.keyboard.press("a");
  const t = await page.evaluate(() => document.querySelector("video")!.currentTime);
  expect(t).toBeGreaterThanOrEqual(5.9);
  expect(t).toBeLessThan(6.5);
});

test("-/= change playbackRate, [/] show offset toast", async ({ page }) => {
  await openPlayer(page, "clip.mp4");
  // Wait for the track auto-selection to settle: the per-track offset restore
  // (keyed by primaryId) would otherwise reset an offset set mid-load.
  await expect(
    page.locator(".track-pick select").first(),
  ).toHaveValue(/sidecar|embedded/);
  await page.keyboard.press("=");
  await expect(video(page)).toHaveJSProperty("playbackRate", 1.25);
  await expect(page.locator(".toast")).toContainText("speed 1.25×");
  await page.keyboard.press("-");
  await expect(video(page)).toHaveJSProperty("playbackRate", 1);
  await page.keyboard.press("[");
  await expect(page.locator(".toast")).toContainText("subs -0.1s");
  await page.keyboard.press("]");
  await expect(page.locator(".toast")).toContainText("subs +0.0s");
});
