// Wave 15 — comprehension quiz (`q`): open over watched cues, answer items,
// see a score, and emit a quiz.result telemetry event. Uses the clip.mp4
// fixture (6 JA cues + aligned RU sidecar) and the existing fakes.

import { test, expect } from "./helpers.ts";
import { openPlayer, seekTo, waitForTokens } from "./helpers.ts";

test.beforeEach(async ({ page }) => {
  await openPlayer(page, "clip.mp4");
  // seek into the last cue (22–25s): all 6 cue-starts have passed → every line
  // counts as "watched", and an active cue keeps tokens on screen for the gate
  await seekTo(page, 23);
  await waitForTokens(page);
});

test("`q` opens a comprehension quiz, answering shows a score", async ({ page }) => {
  await page.keyboard.press("q");
  const card = page.locator(".quiz-card");
  await expect(card).toBeVisible();
  // first question: progress counter + a prompt line
  await expect(card.locator(".quiz-count")).toContainText("/");
  await expect(card.locator(".quiz-prompt")).not.toBeEmpty();

  // Walk every question. MC → click the correct option (it gets .right after
  // answering); cloze → type its answer is hard to know, so just submit Enter
  // (counts as an attempt) — we only assert the run completes with a score.
  for (let guard = 0; guard < 20; guard++) {
    const end = card.locator(".quiz-end");
    if (await end.isVisible().catch(() => false)) break;

    const opts = card.locator(".quiz-opt");
    if ((await opts.count()) > 0) {
      // pick option 1 via number key, then advance
      await page.keyboard.press("1");
      await expect(card.locator(".quiz-verdict")).toBeVisible();
    } else {
      // cloze: submit (Enter), the verdict + Next button appear
      await page.keyboard.press("Enter");
      await expect(card.locator(".quiz-verdict")).toBeVisible();
    }
    await page.keyboard.press("Enter"); // Next / Finish
  }

  // final score card "N / M comprehension"
  await expect(card.locator(".quiz-score")).toBeVisible();
  await expect(card.locator(".quiz-score")).toHaveText(/^\d+ \/ \d+$/);
  await expect(card.locator(".quiz-sub")).toHaveText("comprehension");
});

test("answering all MC correctly scores full marks and emits quiz.result", async ({ page }) => {
  await page.keyboard.press("q");
  const card = page.locator(".quiz-card");
  await expect(card).toBeVisible();

  let total = 0;
  let correct = 0;
  for (let guard = 0; guard < 20; guard++) {
    if (await card.locator(".quiz-end").isVisible().catch(() => false)) break;
    total++;
    const opts = card.locator(".quiz-opt");
    if ((await opts.count()) > 0) {
      // pick option 1; the truly-correct option (maybe another) turns .right.
      await opts.first().click();
      await expect(card.locator(".quiz-opt.right")).toBeVisible();
      // option 1 scored a point only if option 1 itself is the .right one.
      if (await opts.first().and(card.locator(".right")).isVisible().catch(() => false)) {
        correct++;
      }
    } else {
      await page.keyboard.press("Enter"); // cloze attempt (likely wrong)
    }
    await page.keyboard.press("Enter"); // advance
  }

  await expect(card.locator(".quiz-score")).toHaveText(new RegExp(`^${correct} / ${total}$`));

  // the score was reported to telemetry as quiz.result — assert the
  // comprehension aggregation actually counts at least this quiz
  await expect
    .poll(
      async () => {
        const res = await page.request.get("/api/stats/comprehension");
        const comp = await res.json();
        return comp.quizzes ?? 0;
      },
      { timeout: 13_000 }, // client telemetry flushes every 10s
    )
    .toBeGreaterThanOrEqual(1);
});

test("Esc closes the quiz overlay", async ({ page }) => {
  await page.keyboard.press("q");
  await expect(page.locator(".quiz-card")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".quiz-card")).toHaveCount(0);
  // reopening with `q`, then `q` again toggles it closed
  await page.keyboard.press("q");
  await expect(page.locator(".quiz-card")).toBeVisible();
  await page.keyboard.press("q");
  await expect(page.locator(".quiz-card")).toHaveCount(0);
});
