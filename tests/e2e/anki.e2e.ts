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

  // word index refresh marks the token as in-deck (.known) and colors it
  // learning-blue (color-mix toward the ambient text color; the fake backend
  // reports no interval -> fresh blue). The unknown-red .unk class is gone.
  const tok = page.locator(".sub-primary .tok.known").first();
  await expect(tok).toBeVisible();
  await expect(tok).toHaveAttribute("style", /color-mix\(in oklch/);
  await expect(tok).not.toHaveClass(/unk/);
});

test("unknown words render with the muted-red .unk class, no underline border", async ({ page }) => {
  await openPlayer(page, "clip.mp4");
  await seekTo(page, 3); // 勉強します。
  await waitForTokens(page);
  const unk = page.locator(".sub-primary .tok.unk").first();
  await expect(unk).toBeVisible();
  await expect(unk).toHaveCSS("color", "rgb(242, 160, 168)"); // #f2a0a8 (overlay red)
  await expect(unk).toHaveCSS("border-bottom-width", "0px");
});
