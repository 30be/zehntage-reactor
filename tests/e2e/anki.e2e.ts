import { test, expect } from "./helpers.ts";
import { openPlayer, seekTo, waitForTokens } from "./helpers.ts";

test("`a` adds the popup word to Anki and colors the token instantly", async ({ page }) => {
  await openPlayer(page, "clip.mp4");
  await seekTo(page, 3); // 勉強します。
  await waitForTokens(page);

  await page.locator(".sub-primary .tok").first().click(); // pin popup on 勉強
  const popup = page.locator(".lookup");
  await expect(popup).toContainText("перевод(勉強)"); // fake lookup arrived
  // no Add/Delete buttons anymore — `a` toggles, color is the state cue
  await expect(popup.locator("button", { hasText: "Add to Anki" })).toHaveCount(0);

  await page.keyboard.press("a");
  // OPTIMISTIC: popup word + subtitle token flip to the in-deck color at
  // once — before the server roundtrip (frame/audio capture) resolves.
  await expect(popup.locator(".word")).toHaveClass(/saved/);
  const tok = page.locator(".sub-primary .tok.known").first();
  await expect(tok).toBeVisible();
  await expect(tok).toHaveAttribute("style", /color-mix\(in oklch/);
  await expect(tok).not.toHaveClass(/unk/);

  // fake anki received the card (front = word [real hiragana reading])
  await expect
    .poll(async () => {
      const res = await page.request.get("/api/anki/words");
      const { words } = (await res.json()) as { words: { front: string }[] };
      return words.map((w) => w.front);
    })
    .toContain("勉強 [べんきょう]");
});

test("`a` again deletes the matched card (toggle) and un-colors the token", async ({ page }) => {
  await openPlayer(page, "clip.mp4");
  await seekTo(page, 3); // 勉強します。 — 勉強 was added by the spec above
  await waitForTokens(page);

  await page.locator(".sub-primary .tok").first().click();
  const popup = page.locator(".lookup");
  await expect(popup).toBeVisible();
  await expect(popup.locator(".word")).toHaveClass(/saved/); // already in deck

  await page.keyboard.press("a"); // toggle → delete
  await expect(popup.locator(".word")).not.toHaveClass(/saved/);
  await expect(page.locator(".sub-primary .tok.unk").first()).toBeVisible();

  // the deck card is actually gone (delete targeted the matched front)
  await expect
    .poll(async () => {
      const res = await page.request.get("/api/anki/words");
      const { words } = (await res.json()) as { words: { front: string }[] };
      return words.map((w) => w.front);
    })
    .not.toContain("勉強 [べんきょう]");
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
