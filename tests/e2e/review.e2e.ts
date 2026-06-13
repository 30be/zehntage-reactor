// review.e2e.ts — Review / Cram mode (#/review) coverage.
//
// Uses the shared fake-Anki deck (ANKI_FAKE=1) seeded via /api/anki/add, the
// same fixture pattern as interactions.e2e.ts. The seeded word 勉強 appears in
// the clip.ja.srt cue "勉強します。", so the server's /api/review/due joins it
// with that watched cue to build a cloze. All selectors are derived from
// web/ReviewRoute.tsx.

import { test, expect } from "./helpers.ts";
import { entryId } from "./helpers.ts";

test.describe("Review mode", () => {
  test("empty deck → empty state", async ({ page }) => {
    // Clean the shared fake deck first (other specs may have seeded cards).
    const res = await page.request.get("/api/review/due");
    const data = (await res.json()) as { words: { front: string }[] };
    for (const w of data.words) {
      await page.request.post("/api/anki/delete", { data: { front: w.front } });
    }
    await page.goto("/#/review");
    await expect(page.locator(".review-empty")).toBeVisible();
    await expect(page.locator(".review-empty")).toContainText("Nothing due");
  });

  test("seeded due word renders a cloze; Enter scores; next advances", async ({
    page,
  }) => {
    await page.goto("/");
    const id = await entryId(page, "clip.mp4");

    // Seed a due deck word that appears in a watched cue.
    const seed = await page.request.post("/api/anki/add", {
      data: {
        word: "勉強",
        reading: "べんきょう",
        translation: "учёба",
        notes: "",
        context: "勉強します。",
        mediaId: id,
        timestamp: 2,
      },
    });
    expect(seed.ok()).toBe(true);

    await page.goto("/#/review");

    // A card renders with a progress counter.
    const card = page.locator(".review-card");
    await expect(card).toBeVisible();
    await expect(page.locator(".review-count")).toContainText("/");

    // The cloze prompt is a watched cue with the word blanked out.
    const prompt = page.locator(".review-prompt");
    await expect(prompt).toBeVisible();
    await expect(prompt).toContainText("します");
    await expect(prompt).not.toContainText("勉強");

    // A "watch in context" deep-link is offered for the encounter.
    await expect(page.locator(".review-watch")).toBeVisible();

    // Type the answer + Enter → scored correct (monochrome ink).
    const input = page.locator(".review-input");
    await input.fill("勉強");
    await input.press("Enter");
    await expect(page.locator(".review-correct")).toBeVisible();
    await expect(page.locator(".review-correct")).toContainText("correct");

    // Next (Space) advances past the only card → review-complete empty state.
    await page.locator(".review-card .btn", { hasText: "next" }).click();
    await expect(page.locator(".review-empty")).toContainText("complete");

    // Cleanup so the shared fake deck stays empty for other specs.
    await page.request.post("/api/anki/delete", {
      data: { front: "勉強 [べんきょう]" },
    });
  });

  test("wrong answer is flagged with established-red", async ({ page }) => {
    const id = await entryId(page, "clip.mp4");
    await page.request.post("/api/anki/add", {
      data: {
        word: "図書館",
        reading: "としょかん",
        translation: "библиотека",
        notes: "",
        context: "図書館へ行きます。",
        mediaId: id,
        timestamp: 6,
      },
    });

    await page.goto("/#/review");
    const input = page.locator(".review-input");
    await expect(input).toBeVisible();
    await input.fill("まちがい");
    await input.press("Enter");
    await expect(page.locator(".review-wrong")).toContainText("wrong");

    await page.request.post("/api/anki/delete", {
      data: { front: "図書館 [としょかん]" },
    });
  });
});
