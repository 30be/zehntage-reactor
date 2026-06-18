// review.e2e.ts — Flashcard Review (#/review) REAL flow coverage.
//
// The review client (web/ReviewRoute.tsx) is a no-typing, hotkey-graded client
// whose scheduling lives entirely in Anki. In e2e we run ANKI_FAKE mode: the
// server's reviewQueue()/answerCard() serve a small in-memory fake queue
// (src/lib/anki.ts, ANKI_FAKE branch — two fixed seed cards), so the route
// renders REAL review cards and we can drive the actual space→reveal→grade loop
// all the way to the done state.
//
// IMPORTANT — single shared queue: the fake queue is a module-level singleton on
// the server that drains as cards are graded. This spec resets it in
// beforeEach, then does every non-destructive assertion (front-doubling guard,
// single-column answer, Anki-style counters) FIRST while the deck is still full,
// and only THEN grades the deck down to the terminal "done" state.
//
// What this spec guards against (real loop bugs the feature shipped with):
//   1. The front being rendered TWICE on reveal (the question div was kept
//      visible alongside the answer blob, which already contains the front).
//      Fixed: on reveal there is NO standalone .review-question; the answer
//      blob holds the front exactly once.
//   2. A drained queue looping back to card 1 instead of reaching "All done".
//   3. The answer renders in a SINGLE column (the old two-column split + toggle
//      were removed).
//   4. Ctrl+Z undoes the last grade and re-shows the previous card.
//
// The scope toggle, the two-column toggle, and the type-the-word input were all
// removed; this spec asserts their absence. Selectors derive from
// web/ReviewRoute.tsx.

import { test, expect } from "./helpers.ts";

// The fixed fake-Anki seed fronts (src/lib/anki.ts → fakeSeedDefaults()).
const FRONT_1 = "勉強"; // first card
const FRONT_2 = "図書館"; // last/second card

test.describe("Review mode (real flow / fake-Anki queue)", () => {
  test.beforeEach(async ({ page }) => {
    // Reset the server-side fake queue so this spec always starts with the
    // full 2-card deck (勉強, 図書館) regardless of which spec ran first.
    const res = await page.request.post("http://localhost:8499/api/test/reset-review-queue");
    if (!res.ok()) throw new Error(`reset-review-queue failed: ${res.status()}`);
  });

  test("real space→reveal→grade flow: no front-doubling, single column, Anki counters, Ctrl+Z undo, drains to All done without looping", async ({
    page,
  }) => {
    await page.goto("/#/review");

    // ===================================================================
    // PHASE A — question state shape (no grading; deck stays full)
    // ===================================================================
    const question = page.locator(".review-question");
    await expect(question).toBeVisible();
    await expect(question).not.toBeEmpty();
    await expect(question).toContainText(FRONT_1);
    // answer not yet revealed; the hint prompts for Space.
    await expect(page.locator(".review-answer")).toHaveCount(0);
    await expect(page.locator(".review-hint")).toContainText("show answer");

    // Anki-style counters render (New + Learning + Due). The fake queue surfaces
    // its due total under the green "due" figure; new/learning are 0 in fake.
    await expect(page.locator(".review-counts")).toBeVisible();
    await expect(page.locator(".review-ct-due")).toBeVisible();

    // No type-the-word UI, no scope toggle, and NO two-column toggle anywhere on
    // the route. There are NO checkboxes at all now.
    await expect(page.locator(".review-scope")).toHaveCount(0);
    await expect(page.locator(".review-twocol-toggle")).toHaveCount(0);
    await expect(page.locator("input[type='text']")).toHaveCount(0);
    await expect(page.locator("textarea")).toHaveCount(0);
    await expect(page.locator(".review-input")).toHaveCount(0);
    await expect(page.locator(".review-prompt")).toHaveCount(0);
    await expect(page.locator(".forecast-histogram")).toHaveCount(0);
    await expect(page.locator("input[type='checkbox']")).toHaveCount(0);

    // ===================================================================
    // PHASE B — reveal & FRONT-DOUBLING GUARD (no grading)
    // ===================================================================
    await page.locator("body").click(); // window focus for the keydown listener
    await page.keyboard.press(" ");
    const answer = page.locator(".review-answer");
    await expect(answer).toBeVisible();
    await expect(page.locator(".review-grade")).toBeVisible();

    // Once revealed there is NO standalone question div, and the answer (which
    // already contains the front) shows the front EXACTLY ONCE across the whole
    // card — this is the doubling regression the ReviewRoute fix targets.
    await expect(question).toHaveCount(0);
    const countFront = (front: string) =>
      page.evaluate((f) => {
        const txt = document.querySelector(".review-card")?.textContent ?? "";
        let n = 0;
        let i = txt.indexOf(f);
        while (i !== -1) {
          n++;
          i = txt.indexOf(f, i + f.length);
        }
        return n;
      }, front);
    expect(await countFront(FRONT_1), "front rendered exactly once").toBe(1);
    // the answer also carries the back (study), so it's a real answer, not a
    // re-render of the question.
    await expect(answer).toContainText("study");

    // ===================================================================
    // PHASE C — single column (two-column layout was removed entirely)
    // ===================================================================
    await expect(page.locator(".review")).not.toHaveClass(/review-twocol-on/);
    await expect(page.locator(".review-twocol")).toHaveCount(0);
    await expect(page.locator(".review-col-left")).toHaveCount(0);
    await expect(page.locator(".review-col-right")).toHaveCount(0);

    // ===================================================================
    // PHASE D — grade card 1, then Ctrl+Z UNDO back to it
    // ===================================================================
    // Grade Good (3) → advance to card 2 (optimistic, instant).
    await page.locator(".review-good").click();
    await expect(question).toBeVisible();
    await expect(question).toContainText(FRONT_2);

    // Ctrl+Z → undo back to card 1, re-shown in the ANSWER phase.
    await page.keyboard.press("Control+z");
    await expect(page.locator(".review-answer")).toBeVisible();
    expect(await countFront(FRONT_1), "undo restores card 1").toBe(1);

    // ===================================================================
    // PHASE E — drive the WHOLE deck to "All done" (NO LOOP)
    //           This is the destructive pass; it drains the shared queue.
    // ===================================================================
    // We're back on card 1's answer. Grade it Good → advance to card 2.
    await page.locator(".review-good").click();
    await expect(question).toBeVisible();
    // NO LOOP: advanced to the SECOND card, not back to the first.
    await expect(question).toContainText(FRONT_2);
    await expect(question).not.toContainText(FRONT_1);

    // reveal + grade the LAST card via hotkeys (Space, then 3).
    await page.keyboard.press(" ");
    await expect(answer).toBeVisible();
    await expect(answer).toContainText("library");
    await page.keyboard.press("3");

    // drained the deck → terminal All done state (NOT back to card 1).
    const done = page.locator(".review-empty");
    await expect(done).toBeVisible();
    await expect(done).toContainText("All done");
    // reviewing surface is gone — we did not loop back into the queue.
    await expect(page.locator(".review-question")).toHaveCount(0);
    await expect(page.locator(".review-card")).toHaveCount(0);

    // still no type-the-word input / scope toggle on the done state.
    await expect(page.locator("input[type='text']")).toHaveCount(0);
    await expect(page.locator(".review-scope")).toHaveCount(0);
  });
});
