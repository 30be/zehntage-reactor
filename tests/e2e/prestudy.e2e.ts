import { test, expect } from "./helpers.ts";
import { openPlayer, seekTo, waitForTokens } from "./helpers.ts";

test.beforeEach(async ({ page }) => {
  await openPlayer(page, "clip.mp4");
  await seekTo(page, 3); // 勉強します。
  await waitForTokens(page);
});

test("word popup shows a frequency tier tag", async ({ page }) => {
  await page.locator(".sub-primary .tok").first().hover();
  const popup = page.locator(".lookup");
  await expect(popup).toBeVisible();
  await expect(popup.locator(".freq-tag")).toHaveText(/^(top \d+k|rare)$/);
});

test("`w` opens the pre-study panel listing upcoming unknown words", async ({ page }) => {
  await page.keyboard.press("w");
  const panel = page.locator(".lookup.prestudy");
  await expect(panel).toBeVisible();
  // unknown lemmas from the fixture cues ahead of t=3
  await expect(panel).toContainText("図書館");
  await expect(panel).toContainText("友達");
  // rows carry freq tier tags and checkboxes
  expect(await panel.locator(".prestudy-row .freq-tag").count()).toBeGreaterThan(0);
  await expect(panel.locator("button", { hasText: /^Add \d+ to Anki$/ })).toBeVisible();
  // `w` again closes
  await page.keyboard.press("w");
  await expect(panel).toHaveCount(0);
  // reopen, Esc closes too
  await page.keyboard.press("w");
  await expect(page.locator(".lookup.prestudy")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".lookup.prestudy")).toHaveCount(0);
});

test("bulk add sends checked words to (fake) Anki", async ({ page }) => {
  await page.keyboard.press("w");
  const panel = page.locator(".lookup.prestudy");
  await expect(panel).toContainText("図書館");

  // uncheck everything except 図書館 to keep the run small
  const rows = panel.locator(".prestudy-row");
  const n = await rows.count();
  for (let i = 0; i < n; i++) {
    const row = rows.nth(i);
    if ((await row.locator(".ps-word").innerText()) !== "図書館") {
      await row.locator("input[type=checkbox]").uncheck();
    }
  }
  await panel.locator("button", { hasText: "Add 1 to Anki" }).click();

  // the row flips to added, and the fake backend received the card
  await expect(panel.locator(".prestudy-row.added")).toHaveCount(1);
  await expect
    .poll(async () => {
      const res = await page.request.get("/api/anki/words");
      const { words } = (await res.json()) as { words: { front: string }[] };
      return words.map((w) => w.front);
    })
    .toContain("図書館 [としょかん]");
});
