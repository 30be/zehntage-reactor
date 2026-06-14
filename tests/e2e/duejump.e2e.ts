// duejump.e2e.ts — F4 "due-here jump + indicator" (SRS during watching).
//
// While watching, the player shows a small "N due" indicator counting cues that
// contain a DUE deck word, and clicking it jumps to the next such cue (mirror of
// the i+1 `j` jump). The due flag comes from the CLIENT-side word index:
// /api/anki/words returns { words, progress } and progress[front].isDue marks a
// card as currently due (the same payload the retention coloring reads).
//
// In e2e fake-Anki mode getProgress() returns {} (no real scheduler), so this
// spec intercepts /api/anki/words and injects a progress map with isDue — the
// deterministic way to exercise the Player-only due computation without a live
// Anki. The fixture clip.ja.srt has 6 cues; only cue 1 ("勉強します。") contains
// the seeded due word 勉強, so the indicator must read exactly "1 due".

import { test, expect } from "./helpers.ts";
import { entryId } from "./helpers.ts";

const FRONT = "勉強 [べんきょう]";

// /api/anki/words payload: one deck card (勉強) flagged due via progress.isDue.
const DUE_PAYLOAD = JSON.stringify({
  words: [
    {
      front: FRONT,
      back: "учёба",
      reading: "べんきょう",
      notes: "",
    },
  ],
  progress: {
    [FRONT]: { interval: 4, reps: 2, lapses: 0, isDue: true },
  },
});

test.describe("F4 due-here jump + indicator", () => {
  test("indicator counts due cues and jump seeks to the due cue", async ({
    page,
  }) => {
    const id = await entryId(page, "clip.mp4");

    // Stub the deck endpoint so the client word index sees 勉強 as due. We serve
    // a fresh 200 (never 304) so any cached localStorage copy from a prior spec
    // can't shadow our payload.
    await page.route("**/api/anki/words", (route) =>
      route.fulfill({
        status: 200,
        headers: { "content-type": "application/json", etag: '"duejump"' },
        body: DUE_PAYLOAD,
      }),
    );

    // Clear the ankicache localStorage so the stub is the source of truth.
    await page.addInitScript(() => {
      try {
        localStorage.removeItem("zr.ankiCache");
      } catch {
        /* ignore */
      }
    });

    await page.goto(`/#/play/${id}`);
    await expect(page.locator("video")).toBeVisible();

    // The indicator appears once the per-cue due pass finishes; exactly 1 cue
    // (勉強します。) contains the due word.
    const indicator = page.getByTestId("due-indicator");
    await expect(indicator).toBeVisible({ timeout: 20_000 });
    await expect(indicator).toHaveText("1 due");

    // Seek away from the due cue (start at 0), then click to jump. Cue 1 starts
    // at t=2s, so currentTime should land at ~2 after the jump.
    await page.evaluate(() => {
      document.querySelector("video")!.currentTime = 0;
    });
    await indicator.click();

    await expect
      .poll(() => page.evaluate(() => document.querySelector("video")!.currentTime), {
        timeout: 5_000,
      })
      .toBeGreaterThanOrEqual(1.9);
  });

  test("no due words → no indicator", async ({ page }) => {
    await page.goto("/");
    const id = await entryId(page, "clip.mp4");

    // Empty deck / no due progress → the indicator must not render.
    await page.route("**/api/anki/words", (route) =>
      route.fulfill({
        status: 200,
        headers: { "content-type": "application/json", etag: '"duejump-empty"' },
        body: JSON.stringify({ words: [], progress: {} }),
      }),
    );
    await page.addInitScript(() => {
      try {
        for (const k of Object.keys(localStorage)) {
          if (k.toLowerCase().includes("anki")) localStorage.removeItem(k);
        }
      } catch {
        /* ignore */
      }
    });

    await page.goto(`/#/play/${id}`);
    await expect(page.locator("video")).toBeVisible();
    // Give the due pass time to run, then assert the indicator stayed absent.
    await page.waitForTimeout(1500);
    await expect(page.getByTestId("due-indicator")).toHaveCount(0);
  });
});
