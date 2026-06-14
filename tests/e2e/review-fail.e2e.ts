// review-fail.e2e.ts — Grade-failure path in the review client.
//
// ANKI_FAKE always succeeds, so the only way to exercise the failure branch is
// to stub the network response for POST /api/review/answer via page.route().
//
// What this spec guards against:
//   1. A failed grade being silently swallowed (advancing the card without
//      Anki having recorded it — the silent-loop bug).
//   2. The error banner (`.review-error[role="alert"]`) not appearing when
//      the endpoint returns { ok: false }.
//   3. The queue draining to "All done" after only a failed grade.
//
// After the failure assertions the stub is removed and the card is graded
// again to confirm the success path then works normally.
//
// NOTE: we import directly from @playwright/test (not helpers) because this
// test deliberately triggers a console.error from the ReviewRoute client
// ("reviewAnswer not ok: stub"), and the helpers fixture fails on any
// unallowlisted console error.

import { test, expect } from "@playwright/test";

// Fixed fake-Anki seed fronts (src/lib/anki.ts → fakeSeedDefaults()).
const FRONT_1 = "勉強";

test.describe("Review grade-failure path", () => {
  test.beforeEach(async ({ request }) => {
    // Reset the server-side fake queue so this spec always starts with the
    // full 2-card deck (勉強, 図書館) regardless of which spec ran first.
    const res = await request.post("http://localhost:8499/api/test/reset-review-queue");
    if (!res.ok()) throw new Error(`reset-review-queue failed: ${res.status()}`);
  });

  test("failed grade shows error banner, does NOT advance and does NOT drain to All done", async ({
    page,
  }) => {
    // -----------------------------------------------------------------------
    // 1. Navigate to the review route and wait for the first card.
    // -----------------------------------------------------------------------
    await page.goto("/#/review");
    const question = page.locator(".review-question");
    await expect(question).toBeVisible();
    await expect(question).toContainText(FRONT_1);

    // -----------------------------------------------------------------------
    // 2. Install the route stub BEFORE grading — force the endpoint to report
    //    failure (HTTP 200 with { ok: false }).
    // -----------------------------------------------------------------------
    await page.route("**/api/review/answer", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: "stub",
          reason: "ankiconnect-failed",
        }),
      }),
    );

    // -----------------------------------------------------------------------
    // 3. Press SPACE to reveal, then grade Good (key "3").
    // -----------------------------------------------------------------------
    await page.locator("body").click(); // focus for the keydown listener
    await page.keyboard.press(" ");
    const answer = page.locator(".review-answer");
    await expect(answer).toBeVisible();
    await expect(page.locator(".review-grade")).toBeVisible();

    await page.keyboard.press("3");

    // -----------------------------------------------------------------------
    // 4. Assert: error banner appears with the expected message.
    // -----------------------------------------------------------------------
    const errorBanner = page.locator(".review-error[role='alert']");
    await expect(errorBanner).toBeVisible();
    // Match on a safe substring that avoids apostrophe encoding differences.
    await expect(errorBanner).toContainText(/record grade/i);

    // -----------------------------------------------------------------------
    // 5. Assert: the SAME card is still shown (NOT advanced to a different
    //    card, NOT showing the "All done" empty state).
    // -----------------------------------------------------------------------
    // After failure the UI rolls back to question phase: answer is gone,
    // question (same front) is back.
    await expect(page.locator(".review-empty")).toHaveCount(0);

    // The front of card 1 must still be present somewhere on the card.
    await expect.poll(async () => {
      const txt =
        (await page.locator(".review-card").textContent()) ??
        (await question.textContent()) ??
        "";
      return txt.includes(FRONT_1);
    }).toBe(true);

    // -----------------------------------------------------------------------
    // 6. Remove the stub and grade again — should now succeed and advance.
    // -----------------------------------------------------------------------
    await page.unroute("**/api/review/answer");

    // If still in answer phase (banner shown over revealed card), grade again.
    // If rolled back to question phase, reveal first.
    const answerVisible = await answer.isVisible().catch(() => false);
    if (!answerVisible) {
      await page.locator("body").click();
      await page.keyboard.press(" ");
      await expect(answer).toBeVisible();
    }

    await page.keyboard.press("3");

    // The error banner must be gone once the grade succeeds.
    await expect(errorBanner).toHaveCount(0);

    // Advanced to the second card OR reached the done state — either is fine
    // as long as we moved past card 1.
    await expect
      .poll(async () => {
        const isDone =
          (await page.locator(".review-empty").count()) > 0;
        const questionText =
          (await page.locator(".review-question").textContent().catch(() => "")) ?? "";
        const advancedToNext = !questionText.includes(FRONT_1);
        return isDone || advancedToNext;
      })
      .toBe(true);
  });
});
