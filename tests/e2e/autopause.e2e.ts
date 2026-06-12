import { test, expect } from "./helpers.ts";
import { openPlayer, playVideo, seekTo, video } from "./helpers.ts";

test("autopause stops playback at the cue end (±0.5s)", async ({ page }) => {
  await openPlayer(page, "clip.mp4");
  // autopause has no UI control anymore — the `u` hotkey toggles it
  await page.keyboard.press("u");
  await expect(page.locator(".toast")).toHaveText("autopause on");
  await seekTo(page, 3.5); // cue 1 ends at 5.0
  await playVideo(page);
  await expect(video(page)).toHaveJSProperty("paused", false);
  await expect(video(page)).toHaveJSProperty("paused", true, { timeout: 8000 });
  const t = await page.evaluate(() => document.querySelector("video")!.currentTime);
  expect(Math.abs(t - 5.0)).toBeLessThanOrEqual(0.5);
  // the finished cue stays rendered while paused
  await expect(page.locator(".sub-primary")).toContainText("勉強"); // furigana may pad innerText
});
