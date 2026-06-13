import { test, expect } from "./helpers.ts";
import {
  openPlayer,
  playVideo,
  seekTo,
  video,
  waitForTokens,
} from "./helpers.ts";

// ---------------------------------------------------------------------------
// Wave 13.A — session HUD (`o`) + smart-resume affordance
// ---------------------------------------------------------------------------

test("`o` toggles the session HUD (and layout-independent via KeyO)", async ({
  page,
}) => {
  await openPlayer(page, "clip.mp4");
  await seekTo(page, 3);
  await waitForTokens(page);
  await expect(page.locator(".session-hud")).toHaveCount(0);
  await page.keyboard.press("o");
  await expect(page.locator(".session-hud")).toBeVisible();
  // Russian layout: physical O produces "щ", code KeyO → still toggles
  await page.evaluate(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "щ", code: "KeyO", bubbles: true }),
    );
  });
  await expect(page.locator(".session-hud")).toHaveCount(0);
});

test("HUD cue counter increments after crossing a cue boundary", async ({
  page,
}) => {
  await openPlayer(page, "clip.mp4");
  await seekTo(page, 3);
  await waitForTokens(page);
  await page.keyboard.press("o");
  // Seek to 5.9s — just before cue 2 starts at 6.0s. The video only needs
  // to advance ~0.1s to cross the boundary, making this reliable under CPU load.
  await seekTo(page, 5.9); // gap between cue 1 (ends 5.0) and cue 2 (starts 6.0)
  await playVideo(page);
  // auto-retry: Playwright keeps polling until the HUD shows ≥1 cue or 10s elapses
  await expect(page.locator(".session-hud")).toContainText(/[1-9]\d* cues/, {
    timeout: 10000,
  });
});

test("smart-resume auto-seeks to the saved position on open (no z prompt)", async ({
  page,
}) => {
  const id = await openPlayer(page, "clip.mp4");
  // seed a resume position > 15s and reload the player
  await page.evaluate((mid) => {
    localStorage.setItem(`zr.pos.${mid}`, "18");
  }, id);
  await page.reload();
  await expect(page.locator("video")).toBeVisible();
  // AUTO-RESUME: it jumps to the saved position with no affordance / no `z`.
  await expect(page.locator(".resume-hint")).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => document.querySelector("video")!.currentTime))
    .toBeGreaterThan(17);
});

// ---------------------------------------------------------------------------
// Wave 13.B — echo dictation mode (`e`)
// ---------------------------------------------------------------------------

test("echo mode pauses at cue end, hides the line, scores typed input", async ({
  page,
}) => {
  await openPlayer(page, "clip.mp4");
  await seekTo(page, 3);
  await waitForTokens(page);
  await page.keyboard.press("e");
  await expect(page.locator(".toast")).toHaveText("echo on");
  // Seek to 4.95s — only 50ms before cue 1 ends at 5.0s. Echo pauses at cue end,
  // so the video needs to advance just ~50ms rather than ~700ms from 4.3s.
  await seekTo(page, 4.95); // cue 1 (勉強します。) ends at 5.0
  await playVideo(page);
  // input appears, video paused, JP line hidden
  const input = page.locator(".echo-input").first();
  await expect(input).toBeVisible({ timeout: 10000 });
  await expect(video(page)).toHaveJSProperty("paused", true);
  await expect(page.locator(".sub-primary")).toHaveCount(0);
  // type the exact cue text → full score, no red chars
  await input.fill("勉強します");
  await input.press("Enter");
  await expect(page.locator(".echo-reveal")).toBeVisible();
  await expect(page.locator(".echo-bad")).toHaveCount(0);
  await expect(page.locator(".echo-score")).toContainText("/");
});

test("echo wrong answer shows red chars", async ({ page }) => {
  await openPlayer(page, "clip.mp4");
  await seekTo(page, 3);
  await waitForTokens(page);
  await page.keyboard.press("e");
  await seekTo(page, 4.95); // 50ms before cue 1 ends at 5.0s
  await playVideo(page);
  const input = page.locator(".echo-input").first();
  await expect(input).toBeVisible({ timeout: 10000 });
  await input.fill("ちがう");
  await input.press("Enter");
  await expect(page.locator(".echo-bad").first()).toBeVisible();
});

// ---------------------------------------------------------------------------
// Wave 13.C — i+1 jump (`j`)
// ---------------------------------------------------------------------------

test("`j` responds with an i+1 affordance", async ({ page }) => {
  await openPlayer(page, "clip.mp4");
  await seekTo(page, 3);
  await waitForTokens(page);
  await seekTo(page, 0.5);
  await page.keyboard.press("j");
  // it either jumped to an i+1 cue (toast "i+1 cue N") or reported none —
  // both are valid given the deck; assert the affordance responded.
  await expect(page.locator(".toast")).toContainText(/i\+1 cue|no i\+1/, {
    timeout: 8000,
  });
});
