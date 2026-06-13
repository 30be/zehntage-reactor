// Wave 18 — two loop-closing features:
//   1. End-of-episode auto-quiz prompt: when an episode ends, the session
//      summary surfaces a quiet "comprehension check? (q)" affordance; pressing
//      q starts the quiz over the just-watched cues (no modal auto-opens).
//   2. Home "Today" panel: a quiet summary of today's study from telemetry,
//      rendered only when there is activity today.
//
// Uses the clip.mp4 fixture (6 JA cues 2–25s + aligned RU sidecar).

import { test, expect } from "./helpers.ts";
import { openPlayer, seekTo, waitForTokens } from "./helpers.ts";

// --- 1. end-of-episode auto-quiz affordance --------------------------------

test.describe("end-of-episode comprehension prompt", () => {
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

  test("ending an episode surfaces a quiet 'comprehension check? (q)' affordance", async ({
    page,
  }) => {
    await endEpisode(page);
    const summary = page.locator(".session-summary");
    await expect(summary).toBeVisible();
    await expect(summary.locator(".ss-quiz")).toContainText("comprehension check?");
    await expect(summary.locator(".ss-quiz")).toContainText("q");
    // The modal must NOT auto-open — only the affordance is shown.
    await expect(page.locator(".quiz-card")).toHaveCount(0);
  });

  test("pressing q starts the quiz over watched cues (and dismisses the prompt)", async ({
    page,
  }) => {
    await endEpisode(page);
    await expect(page.locator(".session-summary")).toBeVisible();

    await page.keyboard.press("q");
    const card = page.locator(".quiz-card");
    await expect(card).toBeVisible();
    await expect(card.locator(".quiz-prompt")).not.toBeEmpty();
    // the summary/countdown overlay is gone (q started the quiz, not nav)
    await expect(page.locator(".session-summary")).toHaveCount(0);

    // Esc closes the quiz again.
    await page.keyboard.press("Escape");
    await expect(card).toHaveCount(0);
  });

  test("ignoring the prompt dismisses it without opening the quiz", async ({
    page,
  }) => {
    await endEpisode(page);
    await expect(page.locator(".session-summary")).toBeVisible();
    // any non-q key cancels the auto-next + summary, no quiz appears
    await page.keyboard.press("ArrowUp");
    await expect(page.locator(".session-summary")).toHaveCount(0);
    await expect(page.locator(".quiz-card")).toHaveCount(0);
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
    const panel = page.locator(".today-panel");
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
