import { test, expect } from "./helpers.ts";
import { openPlayer } from "./helpers.ts";

test("whisper generate: progress UI streams, completes, ja track appears", async ({ page }) => {
  await openPlayer(page, "bare.mp4");
  // "+ generate ja…" lives in the CC popover now
  await page.locator(".vbar-cc").click();
  const generate = page.locator(".cc-action", { hasText: "+ generate ja…" });
  await expect(generate).toBeVisible();
  await generate.click();
  await expect(page.locator(".cc-pop")).toHaveCount(0); // popover closes

  const progress = page.locator(".whisper-progress");
  await expect(progress).toBeVisible();
  await expect(progress).toContainText("Generating ja subs…");
  // streamed cues advance the progress timestamp past 0:00
  await expect(progress).toContainText(/0:0[1-9]|0:1[0-9]/, { timeout: 10_000 });

  await expect(page.locator(".toast")).toContainText("Japanese subtitles generated", {
    timeout: 15_000,
  });
  await expect(progress).toHaveCount(0);
  // the freshly generated ja track is auto-selected as primary
  await page.locator(".vbar-cc").click();
  const pop = page.locator(".cc-pop");
  await expect(
    pop.locator('input[name="cc-primary"][value="sidecar:gen:ja"]'),
  ).toBeChecked();
  await expect(pop).toContainText("Japanese");
});
