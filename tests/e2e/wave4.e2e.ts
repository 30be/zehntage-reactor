// Wave 4: condensed audio export, OP/ED skip pill, stats page.

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./helpers.ts";
import { openPlayer, seekTo, playVideo } from "./helpers.ts";

const LIB = join(import.meta.dirname, "fixtures", "lib");
const CONDENSED = join(LIB, "subs", "clip.condensed.mp3");

test("condensed-audio option runs ffmpeg, saves the mp3 and streams it", async ({ page }) => {
  // a leftover from a previous run would mask a broken condense
  rmSync(CONDENSED, { force: true });
  const id = await openPlayer(page, "clip.mp4");
  const select = page.locator(".track-pick", { hasText: "Primary" }).locator("select");
  await expect(select.locator("option", { hasText: "+ condensed audio…" })).toHaveCount(1);
  await select.selectOption("__condense");
  // progress toast, then a completion toast naming where the file landed
  await expect(page.locator(".toast")).toContainText(/condens/i);
  await expect(page.locator(".toast")).toContainText("clip.condensed.mp3", {
    timeout: 30_000,
  });
  // file exists next to the video under subs/
  expect(existsSync(CONDENSED)).toBe(true);
  // and the server streams it
  const res = await page.request.get(`/media/condensed/${id}`);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toBe("audio/mpeg");
  expect((await res.body()).length).toBeGreaterThan(1000);
  // don't leave the byproduct in the fixtures dir
  rmSync(CONDENSED, { force: true });
});

test("skip pill appears inside a >60s dialogue gap and jumps to the next cue", async ({ page }) => {
  await openPlayer(page, "gap.mp4");
  // within the first 10s: no pill even though we're between cues
  // (assert while paused — playback past the 10s mark would make it appear)
  await seekTo(page, 7);
  await expect(page.locator(".skip-pill")).toHaveCount(0);
  await playVideo(page);
  // inside the 5s → 80s hole: pill shows
  await seekTo(page, 20);
  await expect(page.locator(".skip-pill")).toBeVisible();
  // clicking jumps to ~1s before the next cue (80s)
  await page.locator(".skip-pill").click();
  await expect
    .poll(() => page.evaluate(() => document.querySelector("video")!.currentTime))
    .toBeGreaterThan(78);
  // gap ended → pill hides
  await expect(page.locator(".skip-pill")).toHaveCount(0);
});

test("stats page renders totals and per-episode coverage bars", async ({ page }) => {
  await page.goto("/#/");
  await page.getByRole("button", { name: "Stats" }).click();
  await expect(page).toHaveURL(/#\/stats/);
  await expect(page.locator("h1")).toHaveText("Stats");
  await expect(page.locator(".stats-totals .stat", { hasText: "known words" })).toBeVisible();
  await expect(page.locator(".stats-totals .stat", { hasText: "cards added" })).toBeVisible();
  // episodes with subs get a row + a coverage bar (computed in idle time)
  const clipRow = page.locator(".stats-row", { hasText: "clip" });
  await expect(clipRow).toBeVisible();
  await expect(clipRow.locator(".stats-bar .stats-fill")).toHaveCount(1);
  await expect(clipRow.locator(".stats-cov")).toContainText("new", { timeout: 30_000 });
  // bare.mp4 has no subs → no row
  await expect(page.locator(".stats-row", { hasText: "bare" })).toHaveCount(0);
});
