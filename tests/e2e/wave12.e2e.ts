// Wave 12: read-mode Anki parity, subtitle-scale hotkeys, command palette,
// `?` cheatsheet overlay, due-word highlighting, pre-study i+1 ranking.

import { test, expect, entryId, openPlayer, seekTo, waitForTokens } from "./helpers.ts";

async function openRead(page: import("@playwright/test").Page): Promise<string> {
  const id = await entryId(page, "clip.mp4");
  await page.goto(`/#/read/${id}`);
  await expect(page.locator(".read-mode")).toBeVisible();
  return id;
}

/** The fake-anki map persists across tests in a run — clear a front first. */
async function deleteFront(page: import("@playwright/test").Page, front: string) {
  await page.request.post("/api/anki/delete", { data: { front } });
}

test("read mode: `a` mines the word with sentence context + source", async ({ page }) => {
  await deleteFront(page, "勉強 [べんきょう]");
  await openRead(page);
  const tok = page.locator(".read-para .tok").first(); // 勉強
  await tok.waitFor({ timeout: 20_000 });
  await tok.click();
  const popup = page.locator(".read-popup");
  await expect(popup).toBeVisible();
  await expect(popup.locator(".translation")).toBeVisible(); // fake lookup in

  // no Add/Delete buttons — `a` toggles, the word color is the state cue
  await expect(popup.locator("button", { hasText: "Add to Anki" })).toHaveCount(0);
  await page.keyboard.press("a");
  // optimistic flip to the saved (in-deck) color
  await expect(popup.locator(".word")).toHaveClass(/saved/);

  // fake anki received the card
  await expect
    .poll(async () => {
      const res = await page.request.get("/api/anki/words");
      const { words } = (await res.json()) as { words: { front: string }[] };
      return words.map((w) => w.front);
    })
    .toContain("勉強 [べんきょう]");

  // context = "JP paragraph<br>RU translation<br>source: <doc>" — no frame
  const res = await page.request.get("/api/anki/cards");
  const cards = (await res.json()) as { front: string; context: string }[];
  const card = cards.find((c) => c.front === "勉強 [べんきょう]");
  expect(card).toBeTruthy();
  expect(card!.context).toContain("勉強します。");
  expect(card!.context).toContain("Я учусь.");
  expect(card!.context).toContain("source: clip");
  expect(card!.context).not.toContain("<img"); // no video frame captured
});

test("read mode: ask field and k mark-known parity", async ({ page }) => {
  await openRead(page);
  const tok = page.locator(".read-para .tok").first();
  await tok.waitFor({ timeout: 20_000 });
  await tok.click();
  const popup = page.locator(".read-popup");
  await expect(popup).toBeVisible();

  // k toggles known for the popup word
  await page.keyboard.press("k");
  await expect(popup.locator(".known-flag", { hasText: "known" })).toBeVisible();
  await page.keyboard.press("k");
  await expect(popup.locator(".known-flag", { hasText: /^known$/ })).toHaveCount(0);

  // ask… follow-up goes through /api/ask (fake gemini answers)
  await popup.locator(".ask-input").fill("почему?");
  await popup.locator(".ask-input").press("Enter");
  await expect(popup.locator(".qa-q")).toHaveText("почему?");
  await expect(popup.locator(".qa-a")).not.toHaveText("…", { timeout: 10_000 });
});

test("Shift+= / Shift+- scale the subtitle overlay and persist", async ({ page }) => {
  await openPlayer(page, "clip.mp4");
  await seekTo(page, 3);
  await waitForTokens(page);
  const fontSize = () =>
    page
      .locator(".sub-primary")
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  const before = await fontSize();
  await page.keyboard.press("Shift+Equal");
  await expect(page.locator(".toast")).toHaveText("subs ×1.1");
  expect(await fontSize()).toBeGreaterThan(before);
  await page.keyboard.press("Shift+Minus");
  await expect(page.locator(".toast")).toHaveText("subs ×1.0");
  expect(await fontSize()).toBeCloseTo(before, 0);
  // persisted via the settings autosave (debounced)
  await page.keyboard.press("Shift+Minus");
  await expect(page.locator(".toast")).toHaveText("subs ×0.9");
  await expect
    .poll(async () => {
      const res = await page.request.get("/api/settings");
      return ((await res.json()) as { subScale?: number }).subScale;
    })
    .toBe(0.9);
});

test("Ctrl+K palette: navigate and run player actions", async ({ page }) => {
  // pin autopause OFF (it's a synced zr.* key — another test's `p` press can
  // bleed it ON via shared server state, flipping the toggle's expected toast)
  await page.addInitScript(() => {
    localStorage.setItem("zr.autopause", "0");
    localStorage.setItem("zr.sync.ts", JSON.stringify({ "zr.autopause": Date.now() + 1e9 }));
  });
  await page.goto("/#/");
  await expect(page.locator(".grid .card").first()).toBeVisible();
  await page.keyboard.press("Control+k");
  const palette = page.locator(".palette");
  await expect(palette).toBeVisible();
  await palette.locator("input").fill("stats");
  await page.keyboard.press("Enter");
  await expect(palette).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe("#/stats");

  // player scope: commands appear only on the player route
  await openPlayer(page, "clip.mp4");
  await page.keyboard.press("Control+k");
  await expect(palette).toBeVisible();
  // typing in the palette input never triggers player hotkeys
  await palette.locator("input").fill("w");
  await expect(page.locator(".lookup.prestudy")).toHaveCount(0);
  await palette.locator("input").fill("autopause");
  await expect(palette.locator(".palette-row.sel")).toContainText("autopause");
  await page.keyboard.press("Enter");
  await expect(page.locator(".toast")).toHaveText("autopause on");
});

test("? opens the hotkey cheatsheet; player hotkeys stay quiet under it", async ({ page }) => {
  await openPlayer(page, "clip.mp4");
  await seekTo(page, 3);
  await waitForTokens(page);
  await page.keyboard.press("?");
  const sheet = page.locator(".cheatsheet");
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText("autopause");
  await expect(sheet).toContainText("command palette");
  // `s` would toast "loop …" — the modal guard must swallow it
  await page.keyboard.press("s");
  await page.waitForTimeout(400);
  await expect(page.locator(".toast")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
});

test("due words from progress get the .due class", async ({ page }) => {
  await page.route("**/api/anki/words", (route) =>
    route.fulfill({
      json: {
        words: [{ front: "図書館 [としょかん]", back: "библиотека", notes: "", context: "" }],
        progress: {
          "図書館 [としょかん]": {
            interval: 3,
            due: 0,
            reps: 1,
            lapses: 0,
            ease: 2500,
            queue: 2,
            type: 2,
            isDue: true,
          },
        },
      },
    }),
  );
  await openPlayer(page, "clip.mp4");
  await seekTo(page, 7); // 図書館へ行きます。
  await waitForTokens(page);
  const due = page.locator(".sub-primary .tok.due");
  await expect(due).toHaveText(/図書館/);
  await expect(due).toHaveClass(/known/);
  // wave-11: underlines dropped (color is the only signal) — assert the .due
  // class is present rather than the removed dotted text-decoration.
  await expect(due).toHaveClass(/\bdue\b/);
});

test("pre-study promotes i+1 candidates with a badge", async ({ page }) => {
  // leave 勉強 as the only unknown of its cue
  await deleteFront(page, "勉強 [べんきょう]");
  // Start from an empty known-set so server state from earlier specs (which may
  // push a far-future-ts known-list) can't pre-mark 勉強.
  await page.addInitScript(() => {
    localStorage.setItem("zr.known", JSON.stringify([]));
    localStorage.setItem(
      "zr.sync.ts",
      JSON.stringify({ "zr.known": Date.now() + 1e9 }),
    );
  });
  await openPlayer(page, "clip.mp4");
  await seekTo(page, 3); // 勉強します。
  await waitForTokens(page);
  // Mark the verb stem する (し) known through the real `k` hotkey so it's
  // persisted under the homograph-aware vocabKey — leaving 勉強 the SOLE unknown
  // of its cue (i+1). Pre-seeding the bare lemma "する" no longer matches the
  // token key the pre-study scan looks up.
  await page.locator(".sub-primary .tok", { hasText: "し" }).first().hover();
  await page.keyboard.press("k");
  await page.keyboard.press("w");
  const panel = page.locator(".lookup.prestudy");
  await expect(panel).toBeVisible();
  const row = panel.locator(".prestudy-row", { hasText: "勉強" });
  await expect(row).toBeVisible();
  await expect(row.locator(".badge.iplus")).toHaveText("i+1");

  // Clean up: the addInitScript pushed zr.known (with a far-future ts) to the
  // server. Wipe it so subsequent tests don't inherit a poisoned known-list.
  await page.request.post("/api/state", {
    data: { "zr.known": { v: " zr-deleted", ts: Date.now() + 2e9 } },
  });
});
