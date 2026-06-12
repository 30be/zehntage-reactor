// Cards browser tab (#/cards): lists Anki cards added from the player (their
// context carries an <img> frame), with rewatch + double-click delete.
// NOTE: the fake Anki is shared across the serial e2e run (earlier specs may
// have added their own frame cards), so assertions target OUR rows only.

import { test, expect } from "./helpers.ts";
import { entryId } from "./helpers.ts";

test("cards tab lists frame cards; rewatch navigates; delete needs confirm", async ({ page }) => {
  await page.goto("/");
  const id = await entryId(page, "clip.mp4");

  // Seed the fake Anki with a card added "from the player": mediaId+timestamp
  // make the server capture a frame (fake upload → <img> in context) plus a
  // "clip.mp4 @ 0:05" reference line.
  const res = await page.request.post("/api/anki/add", {
    data: {
      word: "図書館",
      reading: "としょかん",
      translation: "library",
      notes: "",
      context: "図書館へ行きます。",
      mediaId: id,
      timestamp: 5,
    },
  });
  expect(res.ok()).toBe(true);

  // A second, text-only card (no frame) must NOT show in the Cards tab.
  const res2 = await page.request.post("/api/anki/add", {
    data: {
      word: "学校",
      reading: "がっこう",
      translation: "school",
      notes: "",
      context: "学校へ行きます。",
    },
  });
  expect(res2.ok()).toBe(true);

  // Open via the sidebar item.
  await page.locator(".side-item", { hasText: "Cards" }).click();
  await expect(page).toHaveURL(/#\/cards$/);

  const row = page.locator(".card-row", { hasText: "図書館" });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("library");
  await expect(row.locator(".card-frame")).toBeVisible();
  // the frameless card is filtered out
  await expect(page.locator(".card-row", { hasText: "学校" })).toHaveCount(0);

  // Rewatch: enabled (episode in library), navigates to #/play/<id>@5.
  const rewatch = row.locator(".card-rewatch");
  await expect(rewatch).toBeEnabled();
  await rewatch.click();
  await expect(page).toHaveURL(new RegExp(`#/play/${id}@5$`));
  await expect(page.locator("video")).toBeVisible();

  // Back to cards: delete needs a second click ("sure?"), then removes.
  await page.locator(".side-item", { hasText: "Cards" }).click();
  await expect(row).toHaveCount(1);
  const del = row.locator(".card-delete");
  await del.click();
  await expect(del).toHaveText("sure?");
  await expect(row).toHaveCount(1); // first click never deletes
  await del.click();
  await expect(page.locator(".card-row", { hasText: "図書館" })).toHaveCount(0);

  // Server-side: the card is actually gone from the fake Anki.
  const words = await (await page.request.get("/api/anki/words")).json();
  const fronts = (words.words as { front: string }[]).map((w) => w.front);
  expect(fronts).not.toContain("図書館 [としょかん]");
});
