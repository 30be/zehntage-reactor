// Wave 6: analytics v2 endpoints, stats page v2 sections, smart autopause
// settings, session summary overlay, lemma-index encounters.

import { test, expect } from "./helpers.ts";
import { openPlayer, playVideo, seekTo, entryId } from "./helpers.ts";

const MEDIA = "w6mediaw6media";

// Local noon today: the seeded events span ~32s and the rows group by local
// calendar day, so anchoring at noon keeps them on ONE day even when the
// suite runs across midnight (Date.now() would split the row and flake).
const NOON = new Date().setHours(12, 0, 0, 0);

test("/api/stats/episodes returns per-(media,day) rows; CSV + overview work", async ({ page }) => {
  const now = NOON;
  const res = await page.request.post("/api/events", {
    data: {
      events: [
        { ts: now, type: "heartbeat", mediaId: MEDIA, position: 10, paused: false },
        { ts: now + 15_000, type: "heartbeat", mediaId: MEDIA, position: 25, paused: false },
        { ts: now + 30_000, type: "heartbeat", mediaId: MEDIA, position: 40, paused: true },
        { ts: now + 31_000, type: "lookup", mediaId: MEDIA, word: "猫" },
        { ts: now + 32_000, type: "anki_add", mediaId: MEDIA, word: "猫" },
      ],
    },
  });
  expect(res.ok()).toBe(true);

  const rows = (await (await page.request.get("/api/stats/episodes")).json()) as Array<
    Record<string, unknown>
  >;
  expect(Array.isArray(rows)).toBe(true);
  const row = rows.find((r) => r.mediaId === MEDIA)!;
  expect(row).toBeTruthy();
  expect(row.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(row.wallPlayingSec as number).toBeGreaterThanOrEqual(30);
  expect(row.wallPausedSec as number).toBeGreaterThanOrEqual(15);
  expect(row.contentSec as number).toBeGreaterThanOrEqual(30);
  expect(row.lookups).toBe(1);
  expect(row.ankiAdds).toBe(1);
  expect(row).toHaveProperty("coefficient");
  expect(row).toHaveProperty("cardsPerMin");

  const csv = await page.request.get("/api/stats/episodes.csv");
  expect(csv.status()).toBe(200);
  expect(csv.headers()["content-type"]).toContain("text/csv");
  expect(csv.headers()["content-disposition"]).toContain("attachment");
  const text = await csv.text();
  expect(text.split("\n")[0]).toBe(
    "mediaId,date,wallPlayingSec,wallPausedSec,contentSec,coefficient,lookups,ankiAdds,cardsPerMin",
  );
  expect(text).toContain(MEDIA);

  const ov = await (await page.request.get("/api/stats/overview")).json();
  expect(ov.totals.ankiAdds).toBeGreaterThanOrEqual(1);
  expect(ov.last30Days).toHaveLength(30);
  expect(Array.isArray(ov.ankiCumulative)).toBe(true);
  expect(ov.ankiCumulative.length).toBeGreaterThanOrEqual(1);
});

test("stats page v2 renders pace bars, charts and the CSV link", async ({ page }) => {
  // seed events so every section has data
  await page.request.post("/api/events", {
    data: {
      events: [
        { ts: NOON, type: "heartbeat", mediaId: MEDIA, position: 5, paused: false },
        { ts: NOON + 15_000, type: "heartbeat", mediaId: MEDIA, position: 20, paused: false },
        { ts: NOON + 16_000, type: "anki_add", mediaId: MEDIA, word: "犬" },
      ],
    },
  });
  await page.goto("/#/stats");
  await expect(page.locator(".ep-series .ep-row").first()).toBeVisible();
  await expect(page.locator(".ep-row .ep-bar.wall").first()).toBeAttached();
  await expect(page.locator(".ep-row .ep-bar.content").first()).toBeAttached();
  await expect(page.locator(".csv-link")).toHaveAttribute(
    "href",
    "/api/stats/episodes.csv",
  );
  await expect(page.locator(".cpm-chart .cpm-col").first()).toBeAttached();
  expect(await page.locator(".cpm-chart .cpm-col").count()).toBe(30);
  await expect(page.locator(".cum-chart .cum-col").first()).toBeAttached();
});

test("smart autopause settings roundtrip", async ({ page }) => {
  await page.goto("/#/settings");
  await page.locator("#autopauseMode").selectOption("unknown");
  await page.locator("#autopauseMinUnknown").fill("3");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator(".toast")).toContainText("Settings saved");
  // fresh load — values come back from the server
  await page.goto("/#/settings");
  await page.reload();
  await expect(page.locator("#autopauseMode")).toHaveValue("unknown");
  await expect(page.locator("#autopauseMinUnknown")).toHaveValue("3");
  // restore the default so other autopause specs keep their semantics
  await page.locator("#autopauseMode").selectOption("every");
  await page.locator("#autopauseMinUnknown").fill("1");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator(".toast")).toContainText("Settings saved");
});

test("session summary overlay appears on ended and a key dismisses it", async ({ page }) => {
  await openPlayer(page, "clip.mp4");
  await seekTo(page, 29.2); // fixture is 30s
  await playVideo(page);
  const summary = page.locator(".session-summary");
  await expect(summary).toBeVisible({ timeout: 15_000 });
  await expect(summary).toContainText("min");
  await expect(summary).toContainText("cues");
  await expect(summary).toContainText("next episode in 5s");
  // any key cancels the auto-next AND dismisses the summary
  await page.keyboard.press("x");
  await expect(summary).toHaveCount(0);
  // still on the same episode (auto-next canceled)
  await expect(page.locator("video")).toBeVisible();
});

test("encounters endpoint finds a lemma in the requested media", async ({ page }) => {
  const id = await entryId(page, "clip.mp4");
  const res = await page.request.get(
    `/api/index/encounters?lemma=${encodeURIComponent("行く")}&mediaIds=${id}`,
  );
  expect(res.ok()).toBe(true);
  const hits = (await res.json()) as Array<{
    mediaId: string;
    name: string;
    count: number;
    cues: { start: number; text: string }[];
  }>;
  const hit = hits.find((h) => h.mediaId === id)!;
  expect(hit).toBeTruthy();
  expect(hit.name).toBe("clip.mp4");
  expect(hit.count).toBeGreaterThanOrEqual(1);
  expect(hit.cues[0]!.text).toContain("行きます");

  // missing lemma param is a 400
  expect((await page.request.get("/api/index/encounters")).status()).toBe(400);
});

test("comprehensibility and due endpoints answer per entry", async ({ page }) => {
  const id = await entryId(page, "clip.mp4");
  const comp = await page.request.post("/api/index/comprehensibility", {
    data: { known: ["勉強", "する", "行く"] },
  });
  expect(comp.ok()).toBe(true);
  const compRows = (await comp.json()) as Array<{
    mediaId: string;
    pctKnown: number | null;
    unknown: { lemma: string; count: number }[];
  }>;
  const c = compRows.find((r) => r.mediaId === id)!;
  expect(c).toBeTruthy();
  expect(c.pctKnown).toBeGreaterThan(0);
  expect(c.pctKnown).toBeLessThan(1);
  expect(c.unknown.length).toBeGreaterThan(0);

  const due = await page.request.post("/api/index/due", {
    data: { dueFronts: ["行く [いく]", "勉強"] },
  });
  expect(due.ok()).toBe(true);
  const dueRows = (await due.json()) as Array<{ mediaId: string; count: number }>;
  const d = dueRows.find((r) => r.mediaId === id)!;
  expect(d.count).toBeGreaterThanOrEqual(2);

  expect(
    (await page.request.post("/api/index/due", { data: {} })).status(),
  ).toBe(400);
});
