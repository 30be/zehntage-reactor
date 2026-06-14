// wordday.e2e.ts — G5 "word of the day" card on #/home.
//
// Home renders ONE resurfaced deck word (word · reading · meaning + optional
// "watch in context" link), built CLIENT-side from /api/anki/words. We stub that
// endpoint with a deterministic deck (one mature card) plus an encounter so the
// context link appears, then assert the card shows the word + meaning + link.
// Selectors derive from web/HomeRoute.tsx (.wordday-*).

import { expect, test } from "./helpers.ts";

const MATURE_FRONT = "勉強 [べんきょう]";

const WORDS_PAYLOAD = JSON.stringify({
  words: [
    { front: MATURE_FRONT, back: "учёба", reading: "べんきょう", notes: "" },
  ],
  progress: {
    [MATURE_FRONT]: { interval: 60, reps: 10, lapses: 0, queue: 2, type: 2 },
  },
});

const ENCOUNTERS_PAYLOAD = JSON.stringify([
  {
    mediaId: "clip.mp4",
    name: "clip",
    count: 1,
    cues: [{ idx: 0, start: 42, text: "勉強します。" }],
  },
]);

test.describe("G5 word of the day", () => {
  test("renders the word, reading, meaning and a context link", async ({
    page,
  }) => {
    await page.route("**/api/anki/words", (route) =>
      route.fulfill({
        status: 200,
        headers: { "content-type": "application/json", etag: '"wordday"' },
        body: WORDS_PAYLOAD,
      }));
    await page.route("**/api/index/encounters**", (route) =>
      route.fulfill({
        status: 200,
        headers: { "content-type": "application/json" },
        body: ENCOUNTERS_PAYLOAD,
      }));
    // Clear ankicache + any prior wordday pick so the stub drives the pick.
    await page.addInitScript(() => {
      try {
        for (const k of Object.keys(localStorage)) {
          if (k.toLowerCase().includes("anki") || k.includes("wordday")) {
            localStorage.removeItem(k);
          }
        }
      } catch {
        /* ignore */
      }
    });

    await page.goto("/#/home");

    const card = page.locator(".wordday-card");
    await expect(card).toBeVisible();
    await expect(card.locator(".h2")).toContainText("Word of the day");
    await expect(card.locator(".wordday-word")).toContainText("勉強");
    await expect(card.locator(".wordday-reading")).toContainText("べんきょう");
    await expect(card.locator(".wordday-meaning")).toContainText("учёба");

    const link = card.locator(".wordday-link");
    await expect(link).toBeVisible();
    await link.click();
    await expect(page).toHaveURL(/#\/play\/clip\.mp4@42/);
  });

  test("empty deck → no card", async ({ page }) => {
    await page.route("**/api/anki/words", (route) =>
      route.fulfill({
        status: 200,
        headers: { "content-type": "application/json", etag: '"wordday-empty"' },
        body: JSON.stringify({ words: [], progress: {} }),
      }));
    await page.addInitScript(() => {
      try {
        for (const k of Object.keys(localStorage)) {
          if (k.toLowerCase().includes("anki") || k.includes("wordday")) {
            localStorage.removeItem(k);
          }
        }
      } catch {
        /* ignore */
      }
    });

    await page.goto("/#/home");
    await expect(page.locator(".home-steps")).toBeVisible();
    await expect(page.locator(".wordday-card")).toHaveCount(0);
  });
});
