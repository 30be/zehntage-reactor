import { test, expect } from "./helpers.ts";
import { openPlayer, seekTo, waitForTokens } from "./helpers.ts";

test("tracks auto-select: ja primary, generated ru secondary (CC popover)", async ({ page }) => {
  await openPlayer(page, "clip.mp4");
  await page.locator(".vbar-cc").click();
  const pop = page.locator(".cc-pop");
  await expect(pop).toBeVisible();
  await expect(
    pop.locator('input[name="cc-primary"][value="sidecar:ja.srt"]'),
  ).toBeChecked();
  await expect(
    pop.locator('input[name="cc-secondary"][value="sidecar:gen:ru"]'),
  ).toBeChecked();
  // generated-origin track gets a friendly label
  await expect(pop).toContainText("Russian");
  // Esc closes the popover
  await page.keyboard.press("Escape");
  await expect(pop).toHaveCount(0);
});

test("cue text appears at the seeked time", async ({ page }) => {
  await openPlayer(page, "clip.mp4");
  // NOTE: innerText includes furigana <rt> readings, so match word pieces.
  await seekTo(page, 3);
  await expect(page.locator(".sub-primary")).toContainText("勉強");
  await expect(page.locator(".sub-primary")).toContainText("します");
  await waitForTokens(page);
  // RU line is on screen (blurred until hovered / b-held)
  await expect(page.locator(".sub-secondary")).toContainText("Я учусь.");
  await seekTo(page, 7);
  await expect(page.locator(".sub-primary")).toContainText("図書館");
  await expect(page.locator(".sub-primary")).toContainText("ます");
});

// ---------------------------------------------------------------------------
// Dual-line "retard mode" (zr.twoLine): a checkbox in the CC popover turns on a
// second subtitle line (the PREVIOUS cue, in .sub-prev) and makes the overlay
// never-blank — during a gap it HOLDS the last cue instead of clearing. Fixture
// JA_CUES: cue[0] 2–5 "勉強します。", cue[1] 6–9 "図書館へ行きます。",
// cue[2] 10–13 "気になります。" → gap 5→6 and 9→10.
// ---------------------------------------------------------------------------
test("retard mode: .sub-prev shows the previous cue; gap stays visible", async ({
  page,
}) => {
  await openPlayer(page, "clip.mp4");

  // OFF by default: no second line even while a cue is active.
  await seekTo(page, 7); // cue[1] active
  await expect(page.locator(".sub-primary")).toContainText("図書館");
  await expect(page.locator(".sub-prev")).toHaveCount(0);

  // Toggle the checkbox in the CC popover.
  await page.locator(".vbar-cc").click();
  const pop = page.locator(".cc-pop");
  await expect(pop).toBeVisible();
  const checkbox = pop.locator('input[type="checkbox"]');
  await expect(checkbox).not.toBeChecked();
  await checkbox.check();
  await expect(checkbox).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(pop).toHaveCount(0);

  // Active cue[1]: .sub-primary = current (図書館…), .sub-prev = previous cue[0].
  await seekTo(page, 7);
  await expect(page.locator(".sub-primary")).toContainText("図書館");
  const prev = page.locator(".sub-prev");
  await expect(prev).toBeVisible();
  await expect(prev).toContainText("勉強"); // cue[0] "勉強します。"

  // Seek into the gap AFTER cue[1] (9→10): the overlay must HOLD cue[1], not
  // blank. Primary still shows 図書館…, prev still shows 勉強….
  await seekTo(page, 9.5);
  await expect(page.locator(".sub-primary")).toContainText("図書館");
  await expect(page.locator(".sub-prev")).toContainText("勉強");

  // Advancing to cue[2] (10–13) shifts the pair: current=気になります, prev=図書館…
  // NOTE: innerText interleaves furigana <rt> readings (e.g. 気→気き), so match
  // on the kana tail that no reading splits.
  await seekTo(page, 11);
  await expect(page.locator(".sub-primary")).toContainText("になります");
  await expect(page.locator(".sub-prev")).toContainText("図書館");

  // At the FIRST cue there is no previous line (eff===0 → prev empty).
  await seekTo(page, 3); // cue[0] active
  await expect(page.locator(".sub-primary")).toContainText("勉強");
  await expect(page.locator(".sub-prev")).toHaveCount(0);
});
