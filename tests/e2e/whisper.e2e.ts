import { test, expect } from "./helpers.ts";
import { openPlayer } from "./helpers.ts";

test("whisper generate: progress UI streams, completes, ja track appears", async ({ page }) => {
  await openPlayer(page, "bare.mp4");
  const generate = page.locator("button", { hasText: "Generate ja" });
  await expect(generate).toBeVisible();
  await generate.click();

  const progress = page.locator(".whisper-progress");
  await expect(progress).toBeVisible();
  await expect(progress).toContainText("Generating ja subs…");
  // streamed cues advance the progress timestamp past 0:00
  await expect(progress).toContainText(/0:0[1-9]|0:1[0-9]/, { timeout: 10_000 });

  await expect(page.locator(".toast")).toContainText("Japanese subtitles generated", {
    timeout: 15_000,
  });
  await expect(progress).toHaveCount(0);
  const primary = page.locator(".track-pick", { hasText: "Primary" }).locator("select");
  await expect(primary).toHaveValue("sidecar:gen:ja");
  await expect(primary.locator("option[value='sidecar:gen:ja']")).toContainText("Japanese");
});
