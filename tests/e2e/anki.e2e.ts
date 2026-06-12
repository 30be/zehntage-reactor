import { test, expect } from "./helpers.ts";
import { openPlayer, seekTo, waitForTokens } from "./helpers.ts";

test("Add to Anki stores the card in the fake backend and marks the word", async ({ page }) => {
  await openPlayer(page, "clip.mp4");
  await seekTo(page, 3); // 勉強します。
  await waitForTokens(page);

  await page.locator(".sub-primary .tok").first().click(); // pin popup on 勉強
  const popup = page.locator(".lookup");
  await expect(popup).toContainText("перевод(勉強)"); // fake lookup arrived

  const add = popup.locator("button", { hasText: "Add to Anki" });
  await add.click();
  // optimistic flip to the saved/Delete state
  await expect(popup.locator("button", { hasText: "Delete" })).toBeVisible();

  // fake anki received the card (front = word [reading])
  await expect
    .poll(async () => {
      const res = await page.request.get("/api/anki/words");
      const { words } = (await res.json()) as { words: { front: string }[] };
      return words.map((w) => w.front);
    })
    .toContain("勉強 [フェイク]");

  // word index refresh marks the token as known (underline class)
  await expect(page.locator(".sub-primary .tok.known").first()).toBeVisible();
});
