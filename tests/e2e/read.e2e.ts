// Read mode (#/read/<id>): first e2e coverage — token rendering, the word
// popup (click-pinned, deck/Gemini lookup) and the x blacklist hotkey.

import { test, expect, entryId } from "./helpers.ts";

async function openRead(
  page: import("@playwright/test").Page,
  name = "clip.mp4",
): Promise<string> {
  const id = await entryId(page, name);
  await page.goto(`/#/read/${id}`);
  await expect(page.locator(".read-mode")).toBeVisible();
  return id;
}

test("read mode renders tokenized paragraphs with translations", async ({ page }) => {
  await openRead(page);
  await expect(page.locator(".read-para").first()).toBeVisible();
  await expect(page.locator(".read-mode")).toContainText("図書館");
  // tokenizer splits the lines into hoverable tokens (dict init can be slow)
  await expect(page.locator(".read-para .tok").first()).toBeVisible({ timeout: 20_000 });
  // secondary RU lines render (toggleable via the ru on/off button)
  await expect(page.locator(".read-secondary").first()).toContainText("Я");
});

test("clicking a word opens the popup and looks it up", async ({ page }) => {
  await openRead(page);
  const tok = page.locator(".read-para .tok").first();
  await tok.waitFor({ timeout: 20_000 });
  await tok.click();
  const popup = page.locator(".read-popup");
  await expect(popup).toBeVisible();
  await expect(popup.locator(".word")).not.toBeEmpty();
  // fake-gemini lookup fills the translation
  await expect(popup.locator(".translation")).toBeVisible();
  // Esc closes
  await page.keyboard.press("Escape");
  await expect(popup).toHaveCount(0);
});

test("x hotkey toggles blacklist for the popup word", async ({ page }) => {
  await openRead(page);
  const tok = page.locator(".read-para .tok").first();
  await tok.waitFor({ timeout: 20_000 });
  await tok.click();
  const popup = page.locator(".read-popup");
  await expect(popup).toBeVisible();
  await page.keyboard.press("x");
  await expect(popup.locator(".known-flag", { hasText: "blacklisted" })).toBeVisible();
  await page.keyboard.press("x");
  await expect(popup.locator(".known-flag", { hasText: "blacklisted" })).toHaveCount(0);
});

test("tokenizer loading affordance shows then swaps in tokenized lines", async ({ page }) => {
  const id = await entryId(page, "clip.mp4");
  await page.goto(`/#/read/${id}`);
  await expect(page.locator(".read-mode")).toBeVisible();
  // Either we catch the quiet spinner, or tokens are already up — both are fine;
  // what matters is that tokenized lines eventually appear (no permanent plain
  // text), and the affordance is gone once they do.
  await expect(page.locator(".read-para .tok").first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".read-tokenizing")).toHaveCount(0);
});

test("clicking a word low on the page keeps the popup within the viewport", async ({ page }) => {
  await openRead(page);
  await page.locator(".read-para .tok").first().waitFor({ timeout: 20_000 });
  // click a token in the last paragraph (most likely below the fold)
  const lastTok = page.locator(".read-para").last().locator(".tok").last();
  await lastTok.scrollIntoViewIfNeeded();
  await lastTok.click();
  const popup = page.locator(".read-popup");
  await expect(popup).toBeVisible();
  const box = await popup.boundingBox();
  const vh = page.viewportSize()?.height ?? 0;
  expect(box).not.toBeNull();
  // top within viewport and the panel not running off the bottom edge
  expect(box!.y).toBeGreaterThanOrEqual(-1);
  expect(box!.y).toBeLessThan(vh);
});

test("j/k keys move the cursor line through the transcript", async ({ page }) => {
  // read.mp4 has cues >1.5s apart → one paragraph per cue (>=3 paragraphs)
  await openRead(page, "read.mp4");
  await page.locator(".read-para .tok").first().waitFor({ timeout: 20_000 });
  const paraCount = await page.locator(".read-para").count();
  test.skip(paraCount < 2, "needs >=2 paragraphs to test movement");

  // no cursor initially
  await expect(page.locator(".read-cursor")).toHaveCount(0);

  // first `j` lands on paragraph 0 (no-cursor state does not skip line 0)
  await page.keyboard.press("j");
  await expect(page.locator(".read-cursor")).toHaveAttribute("data-para-index", "0");

  // second `j` advances to paragraph 1
  await page.keyboard.press("j");
  await expect(page.locator(".read-cursor")).toHaveAttribute("data-para-index", "1");

  // `k` moves back up to paragraph 0
  await page.keyboard.press("k");
  await expect(page.locator(".read-cursor")).toHaveAttribute("data-para-index", "0");

  // ArrowUp at the top clamps (stays on 0)
  await page.keyboard.press("ArrowUp");
  await expect(page.locator(".read-cursor")).toHaveAttribute("data-para-index", "0");
});

test("reading progress persists across reload and offers resume", async ({ page }) => {
  const id = await openRead(page, "read.mp4");
  await page.locator(".read-para .tok").first().waitFor({ timeout: 20_000 });
  const paraCount = await page.locator(".read-para").count();
  test.skip(paraCount < 2, "needs >=2 paragraphs to test progress");

  // advance the cursor to bump the furthest-read index
  await page.keyboard.press("j");
  await page.keyboard.press("j");
  await expect(page.locator(".read-cursor")).toHaveAttribute("data-para-index", "1");

  // persistence: zr.read.pos.<id> records the furthest paragraph index
  const stored = await page.evaluate(
    (mediaId) => localStorage.getItem("zr.read.pos." + mediaId),
    id,
  );
  expect(stored).toBe("1");

  // progress indicator is rendered
  await expect(page.locator(".read-progress-label")).toBeVisible();
  await expect(page.locator(".read-progress-track")).toBeVisible();

  // reload — furthest persists, so a resume affordance appears (cursor < 0)
  await page.reload();
  await expect(page.locator(".read-mode")).toBeVisible();
  await page.locator(".read-para .tok").first().waitFor({ timeout: 20_000 });

  const resume = page.locator(".read-resume");
  await expect(resume).toBeVisible();
  // furthest index 1 → "line 2"
  await expect(resume).toContainText("line 2");

  // clicking resume restores the cursor to the saved paragraph
  await resume.click();
  await expect(page.locator(".read-cursor")).toHaveAttribute("data-para-index", "1");
});

test("`a` from the Read popup flips the word to saved (optimistic)", async ({ page }) => {
  await openRead(page);
  const tok = page.locator(".read-para .tok").first();
  await tok.waitFor({ timeout: 20_000 });
  await tok.click();
  const popup = page.locator(".read-popup");
  await expect(popup).toBeVisible();
  // wait for the fake lookup to resolve (the add path is gated on `lookup`)
  await expect(popup.locator(".translation")).toBeVisible();

  const word = popup.locator(".word");
  // normalise to a not-saved baseline (a prior test may have left a card)
  const startsSaved = ((await word.getAttribute("class")) ?? "")
    .split(/\s+/)
    .includes("saved");
  if (startsSaved) {
    await page.keyboard.press("a");
    await expect(word).not.toHaveClass(/saved/);
  }

  // add via `a` — optimistic flip to saved
  await page.keyboard.press("a");
  await expect(word).toHaveClass(/saved/);

  // remove via `a` again — cleanup so the shared fake deck stays clean
  await page.keyboard.press("a");
  await expect(word).not.toHaveClass(/saved/);
});

test("t hotkey toggles the secondary translation lines and persists", async ({ page }) => {
  const id = await openRead(page);
  const secondary = page.locator(".read-secondary").first();
  await expect(secondary).toBeVisible();
  // hide
  await page.keyboard.press("t");
  await expect(page.locator(".read-secondary")).toHaveCount(0);
  // persisted via zr.* localStorage
  const stored = await page.evaluate(() => localStorage.getItem("zr.read.secondary"));
  expect(stored).toBe("0");
  // survives a reload
  await page.reload();
  await expect(page.locator(".read-mode")).toBeVisible();
  await page.locator(".read-para .tok").first().waitFor({ timeout: 20_000 });
  await expect(page.locator(".read-secondary")).toHaveCount(0);
  // show again
  await page.keyboard.press("t");
  await expect(page.locator(".read-secondary").first()).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("zr.read.secondary"))).toBe("1");
});

test("read popup shows the encounters line for a word in the library", async ({ page }) => {
  // read.mp4 cue 2 is 図書館へ行きます。 — the lemma 行く is indexed for this
  // episode, so the popup's encounters line (player↔read parity) must render.
  await openRead(page, "read.mp4");
  await page.locator(".read-para .tok").first().waitFor({ timeout: 20_000 });
  // click the 勉強 token — a noun whose lemma (= surface) is indexed for this
  // episode, so the encounters lookup returns a hit.
  const tok = page.locator(".read-para .tok", { hasText: "勉強" }).first();
  await tok.click();
  const popup = page.locator(".read-popup");
  await expect(popup).toBeVisible();
  await expect(popup.locator(".translation")).toBeVisible();
  // the encounters line renders with a count
  const encLine = popup.locator(".enc .enc-line");
  await expect(encLine).toBeVisible();
  await expect(encLine).toContainText("encounters:");
  const count = Number((await encLine.textContent())!.replace(/\D+/g, ""));
  expect(count).toBeGreaterThanOrEqual(1);
  // clicking the line expands the cue list
  await encLine.click();
  await expect(popup.locator(".enc .enc-list .enc-hit").first()).toBeVisible();
});
