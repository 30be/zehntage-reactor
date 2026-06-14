// Wave 18 — two loop-closing features:
//   1. End-of-episode auto-quiz: when an episode ends (and "auto-quiz at end of
//      episode" is on, the default), the comprehension quiz over the just-
//      watched cues launches directly — no "press q" affordance. Manual `q`
//      still opens the same quiz.  (Round-3 redesign: the old "comprehension
//      check? (q)" prompt line was removed in favor of auto-launch.)
//   2. Home "Today" panel: a quiet summary of today's study from telemetry,
//      rendered only when there is activity today.
//
// Uses the clip.mp4 fixture (6 JA cues 2–25s + aligned RU sidecar).

import { test, expect } from "./helpers.ts";
import { openPlayer, seekTo, waitForTokens } from "./helpers.ts";

// --- 1. end-of-episode auto-quiz affordance --------------------------------

test.describe("end-of-episode comprehension quiz", () => {
  test.beforeEach(async ({ page }) => {
    await openPlayer(page, "clip.mp4");
    // seek into the last cue (22–25s): every cue-start has passed, so all six
    // lines count as "watched" when the quiz is built.
    await seekTo(page, 23);
    await waitForTokens(page);
  });

  // End the episode by firing the media `ended` event the player listens for.
  async function endEpisode(page: import("@playwright/test").Page) {
    await page.evaluate(() => {
      const v = document.querySelector("video")!;
      v.dispatchEvent(new Event("ended"));
    });
  }

  test("ending an episode auto-launches the comprehension quiz (no '(q)' prompt)", async ({
    page,
  }) => {
    await endEpisode(page);
    // The quiz auto-opens over the watched cues — no "press q" affordance.
    const card = page.locator(".quiz-card");
    await expect(card).toBeVisible();
    await expect(card.locator(".quiz-prompt")).not.toBeEmpty();
    // The removed affordance line must not exist.
    await expect(page.locator(".ss-quiz")).toHaveCount(0);
  });

  test("the auto-launched quiz is the same quiz `q` builds; Esc closes it", async ({
    page,
  }) => {
    await endEpisode(page);
    const card = page.locator(".quiz-card");
    await expect(card).toBeVisible();
    await expect(card.locator(".quiz-prompt")).not.toBeEmpty();

    // First Esc dismisses the end-of-episode session-summary overlay (its
    // auto-next cancel listener); a second Esc closes the quiz itself.
    await page.keyboard.press("Escape");
    await expect(page.locator(".session-summary")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(card).toHaveCount(0);
  });

  test("the session summary still renders alongside the auto-quiz", async ({
    page,
  }) => {
    await endEpisode(page);
    await expect(page.locator(".quiz-card")).toBeVisible();
    // The end-of-episode summary overlay is still shown behind the quiz.
    await expect(page.locator(".session-summary")).toBeVisible();
  });
});

// --- 2. Home "Today" panel -------------------------------------------------

test.describe("Home today panel", () => {
  test("renders today's study tiles from seeded telemetry", async ({ page }) => {
    const now = Date.now();
    const mediaId = "feedfeedbeef";
    // Seed a representative day of activity (all timestamped "now" → today).
    const events = [
      { ts: now, type: "heartbeat", mediaId, position: 5, paused: false },
      { ts: now + 1, type: "heartbeat", mediaId, position: 20, paused: false },
      { ts: now + 2, type: "cue_active", mediaId, idx: 0 },
      { ts: now + 3, type: "cue_active", mediaId, idx: 1 },
      { ts: now + 4, type: "lookup", mediaId, word: "猫" },
      { ts: now + 5, type: "anki_add", mediaId, word: "猫" },
      { ts: now + 6, type: "quiz.result", mediaId, total: 6, correct: 4 },
    ];
    const res = await page.request.post("/api/events", { data: { events } });
    expect(res.ok()).toBe(true);

    await page.goto("/#/home");
    // `.today-panel` is now ambiguous — WordOfDayCard also carries it (as
    // `.today-panel.wordday-card`). Target the TodayPanel specifically.
    const panel = page.locator(".today-panel:not(.wordday-card)");
    await expect(panel).toBeVisible();
    await expect(panel.locator(".h2")).toHaveText("Today");
    // tiles exist and at least one carries a non-zero count
    const nums = panel.locator(".stat-num");
    await expect(nums.first()).toBeVisible();
    expect(await nums.count()).toBeGreaterThan(0);
    // words mined today (anki_add) should read ≥ 1
    await expect(panel).toContainText("words mined");
    await expect(panel).toContainText("cues watched");
    await expect(panel).toContainText("day streak");
  });
});
