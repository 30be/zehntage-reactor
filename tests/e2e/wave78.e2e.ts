// Wave 7+8 wiring: /api/state roundtrip, reading mode, blacklist exclusion.

import { test, expect } from "./helpers.ts";
import { entryId, openPlayer, seekTo, waitForTokens } from "./helpers.ts";

test("/api/state roundtrip: POST merges, GET returns the merged state", async ({
  page,
}) => {
  await page.goto("/#/home");
  const key = `zr.e2e.${Date.now()}`;
  const ts = Date.now();
  const post = await page.request.post("/api/state", {
    data: { [key]: { v: "hello", ts } },
  });
  expect(post.ok()).toBe(true);
  const merged = (await post.json()) as Record<string, { v: string; ts: number }>;
  expect(merged[key]?.v).toBe("hello");

  const get = await page.request.get("/api/state");
  expect(get.ok()).toBe(true);
  const state = (await get.json()) as Record<string, { v: string; ts: number }>;
  expect(state[key]).toEqual({ v: "hello", ts });

  // older write for the same key loses the merge (last-write-wins)
  const stale = await page.request.post("/api/state", {
    data: { [key]: { v: "stale", ts: ts - 1000 } },
  });
  const merged2 = (await stale.json()) as Record<string, { v: string }>;
  expect(merged2[key]?.v).toBe("hello");
});

test("reading mode renders the transcript with timestamps", async ({ page }) => {
  const id = await entryId(page, "clip.mp4");
  await page.goto(`/#/read/${id}`);
  const read = page.locator(".read-mode");
  await expect(read).toBeVisible();
  // furigana <rt> text interleaves with the base text, so match per token
  await expect(read).toContainText("図書館");
  await expect(read).toContainText("勉強");
  // secondary (RU) line merged under the paragraph
  await expect(read).toContainText("Я иду в библиотеку");
  // margin timestamp link exists (jump target back to the player)
  await expect(read.locator(".read-para a").first()).toBeVisible();
});

test("blacklisted lemma is excluded from the pre-study panel", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("zr.blacklist", JSON.stringify(["友達"]));
  });
  await openPlayer(page, "clip.mp4");
  await seekTo(page, 3); // 勉強します。 — an active cue makes tokens visible
  await waitForTokens(page);
  await page.keyboard.press("w");
  const panel = page.locator(".lookup.prestudy");
  await expect(panel).toBeVisible();
  // 明日 (明日も来ます。) is unknown and stays listed…
  await expect(panel).toContainText("明日");
  // …while the blacklisted 友達 never shows up
  await expect(panel).not.toContainText("友達");
});
