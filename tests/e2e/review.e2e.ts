// review.e2e.ts — Flashcard Review (#/review) coverage.
//
// The review client (web/ReviewRoute.tsx) was rewritten into a no-typing,
// hotkey-graded client whose scheduling lives entirely in Anki: the server's
// reviewQueue() returns { available: false } whenever real AnkiConnect is
// absent. In e2e we run ANKI_FAKE mode, so AnkiConnect is "unavailable" and the
// route deterministically renders the OFFLINE state. These tests therefore
// assert the offline-state markup plus the scope toggle's localStorage
// persistence — the only review behavior reachable without a live Anki. All
// selectors are derived from web/ReviewRoute.tsx.

import { test, expect } from "./helpers.ts";

const SCOPE_KEY = "zr.review.scope";

test.describe("Review mode (offline / fake-Anki)", () => {
  test("renders the offline state, not a type-the-word input", async ({
    page,
  }) => {
    await page.goto("/#/review");

    // Offline state: ANKI_FAKE => reviewQueue available:false => phase "offline".
    const empty = page.locator(".review-empty");
    await expect(empty).toBeVisible();
    await expect(empty).toContainText("Open Anki to review");

    // The "Try again" / "Back to library" actions of the offline state.
    await expect(
      page.locator(".review-actions .retry", { hasText: "Try again" }),
    ).toBeVisible();

    // The OLD type-the-word UI is gone: no input, no check/hint, no histogram.
    await expect(page.locator(".review-input")).toHaveCount(0);
    await expect(page.locator("input[type='text']")).toHaveCount(0);
    await expect(page.locator(".review-prompt")).toHaveCount(0);
    await expect(page.locator(".forecast-histogram")).toHaveCount(0);
    await expect(page.locator(".review-correct")).toHaveCount(0);
    await expect(page.locator(".review-wrong")).toHaveCount(0);
  });

  test("scope toggle is present, clickable, and persists to localStorage", async ({
    page,
  }) => {
    await page.goto("/#/review");

    const toggle = page.locator(".review-scope input[type='checkbox']");
    await expect(toggle).toBeVisible();
    await expect(
      page.locator(".review-scope", { hasText: "zehntage cards only" }),
    ).toBeVisible();

    // Default scope is "zehntage" => the checkbox is checked.
    await expect(toggle).toBeChecked();

    // Unchecking switches scope to "all" and persists it.
    await toggle.uncheck();
    await expect(toggle).not.toBeChecked();
    await expect
      .poll(() => page.evaluate((k) => localStorage.getItem(k), SCOPE_KEY))
      .toBe("all");

    // Re-checking switches back to "zehntage" and persists it.
    await toggle.check();
    await expect(toggle).toBeChecked();
    await expect
      .poll(() => page.evaluate((k) => localStorage.getItem(k), SCOPE_KEY))
      .toBe("zehntage");
  });

  test("no forecast histogram and no type-the-word input anywhere on the route", async ({
    page,
  }) => {
    await page.goto("/#/review");
    await expect(page.locator(".review-empty")).toBeVisible();

    // Belt-and-braces: nothing typed/forecast-shaped exists in the whole route.
    await expect(page.locator("textarea")).toHaveCount(0);
    await expect(page.locator("input[type='text']")).toHaveCount(0);
    await expect(page.locator(".review-input")).toHaveCount(0);
    await expect(page.locator(".forecast-histogram")).toHaveCount(0);
    await expect(page.locator(".forecast")).toHaveCount(0);
  });
});
