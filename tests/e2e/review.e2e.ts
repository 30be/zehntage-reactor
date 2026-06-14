// review.e2e.ts — Flashcard Review (#/review) REAL flow coverage.
//
// The review client (web/ReviewRoute.tsx) is a no-typing, hotkey-graded client
// whose scheduling lives entirely in Anki. In e2e we run ANKI_FAKE mode: the
// server's reviewQueue()/answerCard() now serve a small in-memory fake queue
// (src/lib/anki.ts, ANKI_FAKE branch — two fixed seed cards), so the route
// renders REAL review cards and we can drive the actual space→reveal→grade loop
// all the way to the done state.
//
// The fake queue is a single shared deck that drains as cards are graded and is
// NOT reseeded mid-process (so the done state is reachable). This spec therefore
// runs as ONE test that exercises the whole flow in a single pass — it does not
// rely on the queue being refilled between tests.
//
// The scope toggle was removed (scope is always "all"); this spec asserts its
// absence along with the absence of any type-the-word input. All selectors
// derive from web/ReviewRoute.tsx.

import { test, expect } from "./helpers.ts";

test.describe("Review mode (real flow / fake-Anki queue)", () => {
  test("space→reveal→grade drives both seed cards through to All done", async ({
    page,
  }) => {
    await page.goto("/#/review");

    // --- first card: question phase --------------------------------------
    const question = page.locator(".review-question");
    await expect(question).toBeVisible();
    await expect(question).not.toBeEmpty();
    // answer not yet revealed; the hint prompts for Space.
    await expect(page.locator(".review-answer")).toHaveCount(0);
    await expect(page.locator(".review-hint")).toContainText("show answer");

    // No type-the-word UI and no scope toggle anywhere on the route.
    await expect(page.locator(".review-scope")).toHaveCount(0);
    await expect(page.locator("input[type='checkbox']")).toHaveCount(0);
    await expect(page.locator("input[type='text']")).toHaveCount(0);
    await expect(page.locator("textarea")).toHaveCount(0);
    await expect(page.locator(".review-input")).toHaveCount(0);
    await expect(page.locator(".review-prompt")).toHaveCount(0);
    await expect(page.locator(".forecast-histogram")).toHaveCount(0);

    // --- Space reveals the answer ----------------------------------------
    await page.locator("body").click(); // window focus for the keydown listener
    await page.keyboard.press(" ");
    await expect(page.locator(".review-answer")).toBeVisible();
    await expect(page.locator(".review-grade")).toBeVisible();

    // --- grade the first card via the click path (Good) → next card -------
    await page.locator(".review-good").click();
    await expect(page.locator(".review-question")).toBeVisible();
    await expect(page.locator(".review-answer")).toHaveCount(0);

    // --- reveal + grade the last card via hotkeys (Space, then 3) ---------
    await page.keyboard.press(" ");
    await expect(page.locator(".review-answer")).toBeVisible();
    await page.keyboard.press("3");

    // --- drained the deck → All done state -------------------------------
    const done = page.locator(".review-empty");
    await expect(done).toBeVisible();
    await expect(done).toContainText("All done");
    await expect(done).toContainText("2 words reviewed");

    // Still no type-the-word input / scope toggle on the done state.
    await expect(page.locator("input[type='text']")).toHaveCount(0);
    await expect(page.locator(".review-scope")).toHaveCount(0);
  });
});
