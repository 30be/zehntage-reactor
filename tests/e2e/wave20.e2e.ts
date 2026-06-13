// Wave 20 — Home "continue watching" affordance + scoped hotkey cheatsheet.
//
//   - Player persists resume positions as zr.pos.<id> (seconds) and a recency
//     stamp zr.posAt.<id> (epoch ms). The library top shows a quiet "continue"
//     row for the most-recent episodes, deep-linking to #/play/<id>@<sec>.
//   - The `?` cheatsheet groups hotkeys by scope (player / read / global) so the
//     dual-scope keys (j, k) are no longer ambiguous.

import { test, expect, entryId } from "./helpers.ts";

test.describe("continue watching", () => {
  test("seeded resume position surfaces on Home and deep-links", async ({
    page,
  }) => {
    const id = await entryId(page, "clip.mp4");

    // seed a resume position + recency stamp before the app boots; pin a
    // far-future sync timestamp so this local seed always wins the LWW merge
    // against any zr.pos left in the shared server state by other tests.
    await page.addInitScript(
      ([mediaId]) => {
        localStorage.setItem(`zr.pos.${mediaId}`, "42");
        localStorage.setItem(`zr.posAt.${mediaId}`, String(Date.now()));
        const farFuture = Date.now() + 1e9;
        localStorage.setItem(
          "zr.sync.ts",
          JSON.stringify({
            [`zr.pos.${mediaId}`]: farFuture,
            [`zr.posAt.${mediaId}`]: farFuture,
          }),
        );
      },
      [id],
    );

    await page.goto("/#/");

    const row = page.locator(".continue-row");
    await expect(row).toBeVisible();
    const card = row.locator(".continue-card", { hasText: "clip" });
    await expect(card).toBeVisible();
    // resume position rendered as m:ss (42s -> 0:42)
    await expect(card.locator(".badge")).toHaveText(/0:42/);

    // clicking deep-links to the player at the saved second
    await card.click();
    await expect(page).toHaveURL(/#\/play\/[a-f0-9]{12}@42/);
  });

  test("no continue row when there is no resume position", async ({ page }) => {
    await page.goto("/#/");
    // (no seed) — the affordance renders nothing
    await expect(page.locator(".continue-row")).toHaveCount(0);
  });
});

test.describe("scoped hotkey cheatsheet", () => {
  test("`?` overlay groups keys by scope including read", async ({ page }) => {
    await page.goto("/#/");
    // wait for the app shell to mount so the global `?` listener is attached
    await expect(page.locator(".sidebar .brand")).toBeVisible();
    const sheet = page.locator(".cheatsheet");
    await expect(async () => {
      await page.keyboard.press("?");
      await expect(sheet).toBeVisible({ timeout: 1000 });
    }).toPass();

    // all three scope columns present
    await expect(sheet.locator(".cheat-scope", { hasText: /^player$/ })).toBeVisible();
    await expect(sheet.locator(".cheat-scope", { hasText: /^read$/ })).toBeVisible();
    await expect(sheet.locator(".cheat-scope", { hasText: /^global$/ })).toBeVisible();

    // the dual-scope `j` shows up under both player and read columns
    const playerCol = sheet.locator(".cheat-col", { hasText: "player" });
    const readCol = sheet.locator(".cheat-col", { hasText: "read" });
    await expect(playerCol.locator(".palette-kbd", { hasText: /^j$/ })).toBeVisible();
    await expect(readCol.locator(".palette-kbd", { hasText: /^j \/ ↓$/ })).toBeVisible();
  });
});
