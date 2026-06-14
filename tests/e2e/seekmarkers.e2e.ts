// seekmarkers.e2e.ts — F6 "seekbar cue heatmap" + F4 `d` hotkey.
//
// The player scrubber renders thin markers at the timeline positions of
// study-worthy cues: i+1 cues (neutral ink) and due-word cues (content-red).
// This spec seeds a due deck word the same way duejump.e2e.ts does
// (intercept /api/anki/words, inject progress[front].isDue) and asserts:
//   1. at least one due marker (.seek-marker-due) renders on the seekbar, at
//      roughly the position of the cue that holds the due word (cue 1, t=2s of
//      a 6-cue clip → its left% is small but > 0);
//   2. pressing the `d` hotkey seeks the video to that due cue (~t=2).

import { test, expect } from "./helpers.ts";
import { entryId } from "./helpers.ts";

const FRONT = "勉強 [べんきょう]";

const DUE_PAYLOAD = JSON.stringify({
  words: [{ front: FRONT, back: "учёба", reading: "べんきょう", notes: "" }],
  progress: { [FRONT]: { interval: 4, reps: 2, lapses: 0, isDue: true } },
});

test.describe("F6 seekbar cue heatmap + d hotkey", () => {
  test("due marker renders on the seekbar and d seeks to the due cue", async ({
    page,
  }) => {
    const id = await entryId(page, "clip.mp4");

    await page.route("**/api/anki/words", (route) =>
      route.fulfill({
        status: 200,
        headers: { "content-type": "application/json", etag: '"seekmarkers"' },
        body: DUE_PAYLOAD,
      }),
    );
    await page.addInitScript(() => {
      try {
        localStorage.removeItem("zr.ankiCache");
      } catch {
        /* ignore */
      }
    });

    await page.goto(`/#/play/${id}`);
    await expect(page.locator("video")).toBeVisible();

    // The due indicator appearing tells us the per-cue due pass finished.
    await expect(page.getByTestId("due-indicator")).toBeVisible({
      timeout: 20_000,
    });

    // Exactly one cue (勉強します。) holds the due word → one due marker.
    const dueMarker = page.getByTestId("seek-marker-due");
    await expect(dueMarker.first()).toBeAttached({ timeout: 20_000 });

    // It sits at the cue's timeline position: cue 1 starts at t=2 in a clip
    // that runs well past it, so left% is positive but nowhere near the end.
    const left = (await dueMarker.first().getAttribute("style")) ?? "";
    const m = /left:\s*([\d.]+)%/.exec(left);
    const pct = m ? parseFloat(m[1]!) : NaN;
    expect(pct).toBeGreaterThan(0);
    expect(pct).toBeLessThan(100);

    // `d` hotkey: from t=0 it jumps to the next due cue (~t=2).
    await page.evaluate(() => {
      document.querySelector("video")!.currentTime = 0;
    });
    await page.locator("video").focus().catch(() => {});
    await page.keyboard.press("d");

    await expect
      .poll(
        () =>
          page.evaluate(() => document.querySelector("video")!.currentTime),
        { timeout: 5_000 },
      )
      .toBeGreaterThanOrEqual(1.9);
  });
});
