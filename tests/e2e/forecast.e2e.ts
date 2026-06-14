// forecast.e2e.ts — G3 "SRS due-forecast histogram" on #/review.
//
// The Review page renders a small bar chart of upcoming review load, built
// CLIENT-side from /api/anki/words progress{interval,isDue,daysOverdue}. In e2e
// fake-Anki mode getProgress() returns {} (no real scheduler), so this spec
// intercepts /api/anki/words to inject a deterministic progress map: one
// currently-due card (bucket 0, red "now" bar) and one card with interval 5
// (bucket +5). /api/review/due is also stubbed so the drill itself renders.
// Selectors derive from web/ReviewRoute.tsx (.forecast*).

import { test, expect } from "./helpers.ts";

const DUE_FRONT = "勉強 [べんきょう]";
const FUTURE_FRONT = "図書館 [としょかん]";

// Full deck: one due card + one scheduled-in-5-days card.
const WORDS_PAYLOAD = JSON.stringify({
  words: [
    { front: DUE_FRONT, back: "учёба", reading: "べんきょう", notes: "" },
    { front: FUTURE_FRONT, back: "библиотека", reading: "としょかん", notes: "" },
  ],
  progress: {
    [DUE_FRONT]: { interval: 4, reps: 2, lapses: 0, queue: 2, type: 2, isDue: true },
    [FUTURE_FRONT]: { interval: 5, reps: 3, lapses: 0, queue: 2, type: 2, isDue: false },
  },
});

// Only the due card flows into the drill (/api/review/due returns due cards).
const DUE_PAYLOAD = JSON.stringify({
  source: "is:due",
  total: 1,
  words: [{ front: DUE_FRONT, word: "勉強", reading: "べんきょう", back: "учёба", interval: 4, isDue: true }],
});

test.describe("G3 due-forecast histogram", () => {
  test("renders forecast bars with a red due-now bar and a +5 bar", async ({
    page,
  }) => {
    await page.route("**/api/anki/words", (route) =>
      route.fulfill({
        status: 200,
        headers: { "content-type": "application/json", etag: '"forecast"' },
        body: WORDS_PAYLOAD,
      }),
    );
    await page.route("**/api/review/due", (route) =>
      route.fulfill({
        status: 200,
        headers: { "content-type": "application/json" },
        body: DUE_PAYLOAD,
      }),
    );
    // Clear ankicache so the stub is the source of truth.
    await page.addInitScript(() => {
      try {
        for (const k of Object.keys(localStorage)) {
          if (k.toLowerCase().includes("anki")) localStorage.removeItem(k);
        }
      } catch {
        /* ignore */
      }
    });

    await page.goto("/#/review");

    // The histogram renders with a title and the full window of columns.
    const forecast = page.locator(".forecast");
    await expect(forecast).toBeVisible();
    await expect(forecast.locator(".forecast-title")).toContainText("Due forecast");
    // 15 columns (0..14).
    await expect(forecast.locator(".forecast-col")).toHaveCount(15);

    // The "due now" column is emphasized and labeled.
    const nowCol = forecast.locator(".forecast-col.now");
    await expect(nowCol).toHaveCount(1);
    await expect(nowCol).toContainText("now");
    await expect(nowCol).toHaveAttribute("title", /due now: 1 card/);

    // The interval-5 card lands in the +5 column (title carries the count).
    const cols = forecast.locator(".forecast-col");
    await expect(cols.nth(5)).toHaveAttribute("title", /\+5d: 1 card/);

    // Sanity: the drill itself still renders behind the forecast.
    await expect(page.locator(".review-card")).toBeVisible();
  });

  test("empty deck → forecast empty note", async ({ page }) => {
    await page.route("**/api/anki/words", (route) =>
      route.fulfill({
        status: 200,
        headers: { "content-type": "application/json", etag: '"forecast-empty"' },
        body: JSON.stringify({ words: [], progress: {} }),
      }),
    );
    // /api/review/due returns one due card so the page isn't the review-empty
    // state — we want to see the forecast's OWN empty note alongside a drill.
    await page.route("**/api/review/due", (route) =>
      route.fulfill({
        status: 200,
        headers: { "content-type": "application/json" },
        body: DUE_PAYLOAD,
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

    await page.goto("/#/review");
    await expect(page.locator(".forecast-empty")).toBeVisible();
    await expect(page.locator(".forecast-empty")).toContainText("No scheduled cards");
  });
});
