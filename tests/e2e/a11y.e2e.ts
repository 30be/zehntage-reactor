// Keyboard-operability + AT-announcement regression coverage for the a11y
// pass: clickable rows that used to be <div onClick> must now be reachable and
// activatable from the keyboard, and the toast must be a live region.
import { test, expect, openPlayer } from "./helpers.ts";

test("library grid row is keyboard-focusable and Enter navigates", async ({
  page,
}) => {
  await page.goto("/#/");
  const row = page.locator(".lib-row", { hasText: "clip.mp4" });
  await expect(row).toBeVisible();
  // The row exposes button semantics (role=button container with tabIndex).
  await expect(row).toHaveAttribute("role", "button");
  await expect(row).toHaveAttribute("tabindex", "0");
  // Focus it directly and activate with Enter — must open the player.
  await row.focus();
  await expect(row).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#\/play\/[a-f0-9]{12}/);
});

test("toast container is an aria-live status region", async ({ page }) => {
  // Trigger a toast deterministically via the player speed hotkey ('='),
  // then assert the toast carries the AT live-region contract.
  await openPlayer(page, "clip.mp4");
  await page.keyboard.press("=");
  const toast = page.locator(".toast");
  await expect(toast).toContainText("speed 1.25×");
  await expect(toast).toHaveAttribute("role", "status");
  await expect(toast).toHaveAttribute("aria-live", "polite");
});
