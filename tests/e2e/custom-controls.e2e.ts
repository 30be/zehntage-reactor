// Custom video controls bar: replaces the native <video controls>.

import { test, expect } from "./helpers.ts";
import { openPlayer, playVideo, video } from "./helpers.ts";

test("custom bar renders and native controls are gone", async ({ page }) => {
  await openPlayer(page, "clip.mp4");
  await expect(page.locator(".vbar")).toBeVisible();
  await expect(video(page)).not.toHaveAttribute("controls", /.*/);
  await expect(page.locator(".vbar-play")).toBeVisible();
  await expect(page.locator(".vbar-time")).toContainText("/");
  await expect(page.locator(".vbar-fs")).toBeVisible();
});

test("clicking the seek bar seeks", async ({ page }) => {
  await openPlayer(page, "clip.mp4");
  // wait for metadata so duration-based seeking works
  await expect
    .poll(() => page.evaluate(() => document.querySelector("video")!.duration))
    .toBeGreaterThan(0);
  const bar = page.locator(".seekbar");
  const box = (await bar.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const { t, d } = await page.evaluate(() => {
    const v = document.querySelector("video")!;
    return { t: v.currentTime, d: v.duration };
  });
  expect(t).toBeGreaterThan(d * 0.4);
  expect(t).toBeLessThan(d * 0.6);
});

test("fullscreen button fullscreens the stage", async ({ page }) => {
  await openPlayer(page, "clip.mp4");
  await page.locator(".vbar-fs").click();
  await expect
    .poll(() =>
      page.evaluate(() => document.fullscreenElement?.className ?? null),
    )
    .toContain("video-stage");
  await page.keyboard.press("f");
  await expect
    .poll(() => page.evaluate(() => document.fullscreenElement == null))
    .toBe(true);
});

test("bar autohides while playing and reappears on mousemove", async ({ page }) => {
  await openPlayer(page, "clip.mp4");
  const stage = page.locator(".video-stage");
  await expect(stage).not.toHaveClass(/hud-hidden/);
  await playVideo(page);
  // nudge the mouse once to arm the hide timer, then hold still
  const box = (await stage.boundingBox())!;
  await page.mouse.move(box.x + 40, box.y + 40);
  await expect(stage).toHaveClass(/hud-hidden/, { timeout: 6000 });
  await page.mouse.move(box.x + 80, box.y + 80);
  await expect(stage).not.toHaveClass(/hud-hidden/);
});

test("clicking the video toggles play/pause; play button works", async ({ page }) => {
  await openPlayer(page, "clip.mp4");
  const paused = () =>
    page.evaluate(() => document.querySelector("video")!.paused);
  expect(await paused()).toBe(true);
  // click dead-center top area of the video (away from bar/subtitles)
  const box = (await page.locator(".video-stage").boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + 40);
  await expect.poll(paused).toBe(false);
  await page.mouse.click(box.x + box.width / 2, box.y + 40);
  await expect.poll(paused).toBe(true);
  await page.locator(".vbar-play").click();
  await expect.poll(paused).toBe(false);
  await page.locator(".vbar-play").click();
  await expect.poll(paused).toBe(true);
  // a clicked bar button must not steal the space hotkey
  await page.keyboard.press(" ");
  await expect.poll(paused).toBe(false);
  await page.keyboard.press(" ");
  await expect.poll(paused).toBe(true);
});
