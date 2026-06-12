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

test("r replays the current cue (alias of a)", async ({ page }) => {
  await openPlayer(page, "clip.mp4");
  await seekTo(page, 8); // inside cue 2 (6–9s)
  await waitForTokens(page);
  await page.keyboard.press("r");
  const t = await page.evaluate(() => document.querySelector("video")!.currentTime);
  expect(t).toBeGreaterThanOrEqual(5.9);
  expect(t).toBeLessThan(6.5);
});

test("-/= change playbackRate, [/] show offset toast", async ({ page }) => {
  await openPlayer(page, "clip.mp4");
  // Wait for the track auto-selection to settle: the per-track offset restore
  // (keyed by primaryId) would otherwise reset an offset set mid-load.
  // Cue text rendering implies the primary track is selected and loaded.
  await seekTo(page, 3);
  await expect(page.locator(".sub-primary")).toContainText("勉強");
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

// --- wave 11: layout-independent (e.code) hotkeys + focused-element guard ---

test("letter hotkeys bind to e.code (work on a Russian layout)", async ({ page }) => {
  await openPlayer(page, "clip.mp4");
  await seekTo(page, 8); // inside cue 2 (6–9s)
  await waitForTokens(page);
  // Russian layout: physical A key produces key "ф", code "KeyA" -> replay.
  await page.evaluate(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ф", code: "KeyA", bubbles: true }),
    );
  });
  const t = await page.evaluate(() => document.querySelector("video")!.currentTime);
  expect(t).toBeGreaterThanOrEqual(5.9);
  expect(t).toBeLessThan(6.5);
});

test("letter hotkeys still fire while a button/popover control has focus", async ({ page }) => {
  await openPlayer(page, "clip.mp4");
  await seekTo(page, 3);
  await waitForTokens(page);
  // open the CC popover and focus one of its controls
  await page.locator(".vbar-cc").click();
  await expect(page.locator(".cc-pop")).toBeVisible();
  await page.locator('.cc-pop input[name="cc-primary"]').first().focus();
  const before = await page.locator(".cue-sidebar").count();
  await page.keyboard.press("l"); // toggle sidebar — must not be swallowed
  await expect
    .poll(() => page.locator(".cue-sidebar").count())
    .toBe(before === 0 ? 1 : 0);
  await page.keyboard.press("l"); // restore
});

test("Space passes through to a focused button instead of toggling playback", async ({ page }) => {
  await openPlayer(page, "clip.mp4");
  await expect(video(page)).toHaveJSProperty("paused", true);
  await page.locator(".vbar-cc").focus();
  await page.keyboard.press(" ");
  // native button activation opens the CC popover; playback stays paused
  await expect(page.locator(".cc-pop")).toBeVisible();
  await expect(video(page)).toHaveJSProperty("paused", true);
});
