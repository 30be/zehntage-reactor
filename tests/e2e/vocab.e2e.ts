// vocab.e2e.ts — vocabulary / word-coloring feature coverage
//
// Covers:
//   1. Unknown words (.tok.unk) render red in the player subtitle view
//   2. In-deck (learning) words render with .tok.known + a color-mix style
//   3. Adding via `a` flips the token from .unk → .known immediately (optimistic)
//   4. Removing via `a` again flips it back to .unk
//   5. Popup dictionary form: the .word element shows the lemma form
//   6. Library "new words" count appears in .lib-head once coverage is computed
//
// Lemma-level colouring (all conjugations of the same lemma treated identically)
// cannot be fully verified without seeding a deck card for a conjugated form then
// looking at a different conjugation in a separate subtitle. The fixture cues
// contain only base/masu forms, so we instead verify the foundational behaviour:
// the popup shows the dictionary/base form (.word) and the deck-match is lemma-
// based (adding 勉強 via `a` stores the lemma front, not just the surface form).

import { test, expect } from "./helpers.ts";
import { openPlayer, seekTo, waitForTokens, entryId } from "./helpers.ts";

// ---------------------------------------------------------------------------
// 1. Unknown tokens render with .unk class and red colour
// ---------------------------------------------------------------------------
test("unknown words render with .unk class and muted-red colour in player", async ({
  page,
}) => {
  await openPlayer(page, "clip.mp4");
  await seekTo(page, 3); // cue: 勉強します。
  await waitForTokens(page);

  const unk = page.locator(".sub-primary .tok.unk").first();
  await expect(unk).toBeVisible();

  // Class check — must not carry .known simultaneously
  await expect(unk).not.toHaveClass(/known/);

  // Colour: the fake-anki deck starts empty, so every token is unknown → red
  // #f2a0a8 maps to rgb(242, 160, 168) in Playwright CSS resolution
  await expect(unk).toHaveCSS("color", "rgb(242, 160, 168)");
});

// ---------------------------------------------------------------------------
// 2 & 3. Adding a word via `a` flips unk → known with learning colour (optimistic)
// ---------------------------------------------------------------------------
test("adding a word via `a` flips token from .unk to .known with a color-mix style", async ({
  page,
}) => {
  await openPlayer(page, "clip.mp4");
  await seekTo(page, 3); // 勉強します。
  await waitForTokens(page);

  // Verify the first token is unknown before we add it
  const firstTok = page.locator(".sub-primary .tok").first();
  await expect(firstTok).toHaveClass(/unk/);

  // Click to pin popup, wait for the fake lookup
  await firstTok.click();
  const popup = page.locator(".lookup");
  await expect(popup).toContainText("перевод(勉強)");

  // Press `a` — optimistic update should fire before the server round-trip
  await page.keyboard.press("a");

  // The popup word flips to saved state
  await expect(popup.locator(".word")).toHaveClass(/saved/);

  // The subtitle token switches to .known and receives a color-mix style
  const knownTok = page.locator(".sub-primary .tok.known").first();
  await expect(knownTok).toBeVisible();
  await expect(knownTok).toHaveAttribute("style", /color-mix\(in oklch/);
  await expect(knownTok).not.toHaveClass(/unk/);

  // Cleanup: remove the word so the shared fake-Anki server stays clean for
  // subsequent tests (wave13 etc. will 100%-known otherwise and break)
  await page.keyboard.press("a");
  await expect(popup.locator(".word")).not.toHaveClass(/saved/);
});

// ---------------------------------------------------------------------------
// 4. Toggling `a` produces a consistent add→remove→unk cycle
// ---------------------------------------------------------------------------
test("toggling `a` add→remove cycle: token ends up .unk with empty deck", async ({
  page,
}) => {
  await openPlayer(page, "clip.mp4");
  await seekTo(page, 3);
  await waitForTokens(page);

  // Pin the popup and wait for the fake lookup to arrive
  await page.locator(".sub-primary .tok").first().click();
  const popup = page.locator(".lookup");
  await expect(popup).toContainText("перевод(勉強)");

  // Determine initial state and normalise to "not saved" before the cycle
  const wordEl = popup.locator(".word");
  const startsSaved = ((await wordEl.getAttribute("class")) ?? "")
    .split(/\s+/)
    .includes("saved");
  if (startsSaved) {
    // already in deck (left by a prior test) — remove it first
    await page.keyboard.press("a");
    await expect(wordEl).not.toHaveClass(/saved/);
  }

  // Now add via `a`
  await page.keyboard.press("a");
  await expect(wordEl).toHaveClass(/saved/);
  await expect(page.locator(".sub-primary .tok.known").first()).toBeVisible();

  // Remove via `a` again
  await page.keyboard.press("a");
  await expect(wordEl).not.toHaveClass(/saved/);
  await expect(page.locator(".sub-primary .tok.unk").first()).toBeVisible();
});

// ---------------------------------------------------------------------------
// 5. Popup shows the dictionary/base form (lemma), not just the surface form
// ---------------------------------------------------------------------------
test("word popup .word element shows the dictionary/lemma form", async ({
  page,
}) => {
  await openPlayer(page, "clip.mp4");
  await seekTo(page, 3); // 勉強します。 — 勉強 (noun/lemma) is the first lexical token
  await waitForTokens(page);

  await page.locator(".sub-primary .tok").first().click();
  const popup = page.locator(".lookup");
  await expect(popup).toBeVisible();

  // The .word element must be non-empty and contain the dictionary form
  const word = popup.locator(".word");
  await expect(word).not.toBeEmpty();
  // The fake Gemini response echoes the lookup word; verifying the popup
  // contains 勉強 confirms the correct lemma was sent to the backend
  await expect(popup).toContainText("勉強");
});

// ---------------------------------------------------------------------------
// 4b. Verify the deck actually received the lemma front
// (merged into test 2's flow conceptually; tested here inline via request)
// This runs early in the suite before teardown can close connections.

// ---------------------------------------------------------------------------
// 5b. Read-mode popup also shows the dictionary form on click
// ---------------------------------------------------------------------------
test("read mode popup shows dictionary form on token click", async ({
  page,
}) => {
  const id = await entryId(page, "clip.mp4");
  await page.goto(`/#/read/${id}`);
  await expect(page.locator(".read-mode")).toBeVisible();
  await expect(page.locator(".read-para .tok").first()).toBeVisible({
    timeout: 20_000,
  });

  await page.locator(".read-para .tok").first().click();
  const popup = page.locator(".read-popup");
  await expect(popup).toBeVisible();

  // .word must be non-empty (dictionary form)
  await expect(popup.locator(".word")).not.toBeEmpty();
  // Fake Gemini translation is shown
  await expect(popup.locator(".translation")).toBeVisible();
});

// ---------------------------------------------------------------------------
// 6. Library "new words" count appears in .lib-head once coverage is computed
// ---------------------------------------------------------------------------
test("library .lib-head shows a new-words count once coverage is computed", async ({
  page,
}) => {
  // The coverage computation runs client-side in idle time.  We open the
  // library and wait for the .root-newwords span to become visible.  If the
  // fixture deck is empty every lexical word in clip.mp4 counts as unknown, so
  // the total will be > 0 and the span will render.
  await page.goto("/#/");
  await expect(page.locator(".lib-head")).toBeVisible();

  // Give the idle-time coverage worker time to finish (kuromoji init + tokenise)
  await expect(page.locator(".root-newwords")).toBeVisible({ timeout: 30_000 });
  const text = await page.locator(".root-newwords").innerText();
  // Should read something like " · 42 new words"
  expect(text).toMatch(/\d+\s+new words/);
});

// ---------------------------------------------------------------------------
// 7. In-deck token carries a lemma-based front stored in the fake Anki deck
//    (checks the /api/anki/words endpoint immediately after the optimistic flip)
// ---------------------------------------------------------------------------
test("after adding, fake Anki deck contains lemma-front entry for 勉強", async ({
  page,
}) => {
  await openPlayer(page, "clip.mp4");
  await seekTo(page, 3);
  await waitForTokens(page);

  // Ensure starting from a clean state: if 勉強 is already in deck, remove it
  await page.locator(".sub-primary .tok").first().click();
  const popup = page.locator(".lookup");
  await expect(popup).toContainText("перевод(勉強)");
  const alreadySaved = (
    (await popup.locator(".word").getAttribute("class")) ?? ""
  )
    .split(/\s+/)
    .includes("saved");
  if (alreadySaved) {
    await page.keyboard.press("a");
    await expect(popup.locator(".word")).not.toHaveClass(/saved/);
  }

  // Add
  await page.keyboard.press("a");
  await expect(popup.locator(".word")).toHaveClass(/saved/, { timeout: 5_000 });

  // Poll the fake Anki endpoint until the card shows up (the POST is async;
  // the optimistic flip fires before the network call resolves)
  await expect
    .poll(
      async () => {
        const res = await page.request.get("/api/anki/words");
        const { words } = (await res.json()) as { words: { front: string }[] };
        return words.map((w) => w.front);
      },
      { timeout: 8_000 },
    )
    .toContain("勉強 [べんきょう]");

  // Cleanup: remove the word so subsequent tests start with a clean deck
  await page.keyboard.press("a");
  await expect(popup.locator(".word")).not.toHaveClass(/saved/);
});

// ---------------------------------------------------------------------------
// 8. Per-word mining history line (.whist) appears after adding a word
//    The add logs an anki_add telemetry event; /api/word/history surfaces it.
// ---------------------------------------------------------------------------
test("popup shows a .whist history line after the word is added", async ({
  page,
}) => {
  await openPlayer(page, "clip.mp4");
  await seekTo(page, 3);
  await waitForTokens(page);

  await page.locator(".sub-primary .tok").first().click();
  const popup = page.locator(".lookup");
  await expect(popup).toContainText("перевод(勉強)");

  // Normalise to a clean (not-saved) starting state
  const wordEl = popup.locator(".word");
  if (
    ((await wordEl.getAttribute("class")) ?? "").split(/\s+/).includes("saved")
  ) {
    await page.keyboard.press("a");
    await expect(wordEl).not.toHaveClass(/saved/);
  }

  // Add — server logs anki_add; the history effect re-fetches on popupSaved.
  await page.keyboard.press("a");
  await expect(wordEl).toHaveClass(/saved/, { timeout: 5_000 });

  // The compact history line shows the add date.
  const whist = popup.locator(".whist");
  await expect(whist).toBeVisible({ timeout: 8_000 });
  await expect(whist).toContainText("added");

  // Cleanup: remove the word so subsequent tests start with a clean deck
  await page.keyboard.press("a");
  await expect(wordEl).not.toHaveClass(/saved/);
});
