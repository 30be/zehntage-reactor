// Interactive player/app flows: comprehension quiz (`q`), Cards-tab filtering
// + hover actions, the command palette (Ctrl+K), and echo dictation (`e`).
// Selectors are derived from the real components:
//   web/player/QuizPanel.tsx, web/CardsRoute.tsx, web/Palette.tsx,
//   web/player/{useEcho,EchoOverlay}.tsx, web/player/useActiveCues.ts.

import { test, expect } from "./helpers.ts";
import { entryId, openPlayer, playVideo, seekTo, video } from "./helpers.ts";

// --- 1. Comprehension quiz (`q`) ------------------------------------------
// buildQuizFromWatched() takes primary cues whose start has already passed.
// clip.mp4 has 6 JA cues (2..25s) each with a RU translation, so seeking to
// ~26s makes all 6 "watched" → buildQuiz emits MC items (>=3 distinct RU
// translations available).
test("pressing q opens the quiz panel with a question and an answerable item", async ({ page }) => {
  await openPlayer(page, "clip.mp4");
  // wait for metadata so currentTime sticks
  await expect
    .poll(() => page.evaluate(() => document.querySelector("video")!.duration))
    .toBeGreaterThan(0);
  // mark all cues as watched
  await seekTo(page, 26);

  await page.keyboard.press("q");

  // The overlay opens once items are built (async tokenize). It may briefly be
  // absent while building, so allow the default expect timeout.
  const overlay = page.locator(".quiz-overlay");
  await expect(overlay).toBeVisible();
  await expect(overlay).toHaveAttribute("role", "dialog");
  await expect(page.locator(".quiz-card")).toBeVisible();

  // A question renders: progress counter + prompt.
  await expect(page.locator(".quiz-count")).toContainText("/");
  await expect(page.locator(".quiz-prompt")).toBeVisible();

  // Answerable: either an MC option button or a cloze input must exist.
  const mcOpts = page.locator(".quiz-opt");
  const clozeInput = page.locator(".quiz-input");
  const isMc = (await mcOpts.count()) > 0;
  if (isMc) {
    // pick the first option; a verdict appears (correct/wrong) and advances.
    await mcOpts.first().click();
    await expect(page.locator(".quiz-verdict")).toBeVisible();
  } else {
    await expect(clozeInput).toBeVisible();
    await clozeInput.fill("テスト");
    expect(await clozeInput.inputValue()).toBe("テスト");
    await page.keyboard.press("Enter");
    await expect(page.locator(".quiz-verdict")).toBeVisible();
  }

  // Esc closes the overlay (QuizPanel's own capture listener).
  await page.keyboard.press("Escape");
  await expect(overlay).toHaveCount(0);
});

// --- 2. Cards tab: grid, filter, hover-revealed actions -------------------
test("cards grid renders fixture tiles; search filters; hover reveals actions", async ({ page }) => {
  await page.goto("/");
  const id = await entryId(page, "clip.mp4");

  // Seed two distinct frame cards (mediaId+timestamp → captured <img> frame).
  for (const c of [
    { word: "図書館", reading: "としょかん", translation: "library" },
    { word: "勉強", reading: "べんきょう", translation: "study" },
  ]) {
    const res = await page.request.post("/api/anki/add", {
      data: {
        word: c.word,
        reading: c.reading,
        translation: c.translation,
        notes: "",
        context: `${c.word}します。`,
        mediaId: id,
        timestamp: 5,
      },
    });
    expect(res.ok()).toBe(true);
  }

  await page.locator(".side-item", { hasText: "Cards" }).click();
  await expect(page).toHaveURL(/#\/cards$/);

  // Both tiles render in the grid.
  const grid = page.locator(".cards-grid");
  await expect(grid).toBeVisible();
  const tileA = page.locator(".card-tile", { hasText: "図書館" });
  const tileB = page.locator(".card-tile", { hasText: "勉強" });
  await expect(tileA).toHaveCount(1);
  await expect(tileB).toHaveCount(1);
  await expect(tileA.locator(".card-frame")).toBeVisible();

  // Search/filter bar narrows the grid to matching tiles.
  const search = page.locator(".cards-search");
  await search.fill("図書館");
  await expect(tileA).toHaveCount(1);
  await expect(tileB).toHaveCount(0);
  // Escape clears the filter (CardsRoute onKeyDown).
  await search.press("Escape");
  expect(await search.inputValue()).toBe("");
  await expect(tileB).toHaveCount(1);

  // Hover reveals the action controls (play + delete) over the frame.
  await tileA.hover();
  const play = tileA.locator(".card-play");
  const del = tileA.locator(".card-del");
  await expect(play).toBeVisible();
  await expect(del).toBeVisible();
  await expect(play).toBeEnabled(); // episode is in the library

  // Clean up the cards we added so the shared fake Anki stays tidy.
  for (const front of ["図書館 [としょかん]", "勉強 [べんきょう]"]) {
    const r = await page.request.post("/api/anki/delete", { data: { front } });
    expect(r.ok()).toBe(true);
  }
});

// --- 3. Command palette (Ctrl+K) ------------------------------------------
test("Ctrl+K opens the command palette; typing filters; Escape closes", async ({ page }) => {
  await page.goto("/");
  // ensure the document has focus so the global keydown listener fires
  await page.locator("body").click();

  await page.keyboard.press("Control+KeyK");
  const palette = page.locator(".palette");
  await expect(palette).toBeVisible();
  await expect(palette).toHaveAttribute("role", "dialog");

  const input = palette.locator("input");
  await expect(input).toBeFocused();

  // Unfiltered: several static commands render.
  const rows = page.locator(".palette-row");
  const before = await rows.count();
  expect(before).toBeGreaterThan(1);

  // Typing filters the list down to matching commands ("settings").
  await input.fill("settings");
  await expect(page.locator(".palette-row", { hasText: "settings" }).first()).toBeVisible();
  await expect.poll(() => rows.count()).toBeLessThan(before);

  // Escape closes the palette.
  await page.keyboard.press("Escape");
  await expect(palette).toHaveCount(0);
});

// --- 4. Echo dictation (`e`) ----------------------------------------------
// `e` toggles echo mode (toast). With echo on, playback pauses at each cue end
// and opens the `.echo-overlay` dictation input over the finished line.
test("e toggles echo mode and shows the dictation input at a cue end", async ({ page }) => {
  await openPlayer(page, "clip.mp4");
  await expect
    .poll(() => page.evaluate(() => document.querySelector("video")!.duration))
    .toBeGreaterThan(0);

  await page.keyboard.press("e");
  await expect(page.locator(".toast")).toHaveText("echo on");

  // Seek just before cue 1's end (5.0s) and play; echo forces a pause at the
  // cue end and opens the dictation overlay.
  await seekTo(page, 3.6);
  await playVideo(page);

  await expect(video(page)).toHaveJSProperty("paused", true, { timeout: 8000 });
  const overlay = page.locator(".echo-overlay");
  await expect(overlay).toBeVisible();
  const echoInput = page.locator(".echo-input").first();
  await expect(echoInput).toBeVisible();

  // The affordance accepts input.
  await echoInput.fill("勉強します");
  expect(await echoInput.inputValue()).toBe("勉強します");

  // Enter checks → reveal score panel (echo-reveal / echo-score).
  await page.keyboard.press("Enter");
  await expect(page.locator(".echo-score")).toBeVisible();
});
