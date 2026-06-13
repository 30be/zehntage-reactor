// Wave 16 — learning insights:
//  1. "study next" curriculum marker on the Library (web/curriculum.ts)
//  2. comprehension trend on Stats from quiz.result telemetry
// Both reuse data we already collect; no Gemini. Uses the clip.mp4 fixture.

import { test, expect, entryId } from "./helpers.ts";

// --- 1. study-next marker -------------------------------------------------

test("the study-next toggle marks the recommended episode", async ({ page }) => {
  // Pre-seed the coverage cache (web/coverage.ts localStorage contract) with a
  // strong i+1 signal at a comfortable known% for clip.mp4 — independent of the
  // tokenizer. The cache key is (trackId, ankiCount, knownCount). ankiCount is
  // the live fake-deck size (cards accumulate across the run), and we leave
  // zr.known empty (knownCount 0), so the useCoverage hook reads our seeded
  // value instead of recomputing.
  const clipId = await entryId(page, "clip.mp4");
  const subs = await (await page.request.get(`/api/subs/${clipId}`)).json();
  const jaTrack = (subs as { id: string; lang: string }[]).find((t) =>
    t.lang.startsWith("ja"),
  )!;
  const deck = await (await page.request.get("/api/anki/words")).json();
  const ankiCount = (deck as { words: unknown[] }).words.length;
  await page.addInitScript(
    ([id, trackId, count]) => {
      localStorage.setItem(
        `zr.cov.${id}`,
        JSON.stringify({
          trackId,
          ankiCount: count,
          knownCount: 0,
          pct: 80,
          newCount: 5,
          i1density: 0.6,
        }),
      );
    },
    [clipId, jaTrack.id, ankiCount] as const,
  );

  await page.goto("/#/");
  await expect(page.locator(".grid .card").first()).toBeVisible();

  const toggle = page.locator(".study-toggle");
  await expect(toggle).toBeVisible();
  // off by default — no marker, no active class
  await expect(page.locator(".card.study-next")).toHaveCount(0);

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");

  // coverage computes in idle time; the recommended card gets the marker.
  const marked = page.locator(".card.study-next");
  await expect(marked).toBeVisible({ timeout: 20_000 });
  await expect(marked.locator(".badge.study-next-mark")).toHaveText("study next");
  // the recommended card floats to the front of the grid
  await expect(page.locator(".grid .card").first()).toHaveClass(/study-next/);

  // toggling off removes the marker
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".card.study-next")).toHaveCount(0);
});

// --- 2. comprehension trend ----------------------------------------------

test("quiz.result events aggregate into /api/stats/comprehension", async ({ page }) => {
  const now = Date.now();
  const res = await page.request.post("/api/events", {
    data: {
      events: [
        { ts: now, type: "quiz.result", mediaId: "feedfeedfeed", total: 10, correct: 8 },
        { ts: now + 1000, type: "quiz.result", mediaId: "feedfeedfeed", total: 4, correct: 2 },
      ],
    },
  });
  expect(res.ok()).toBe(true);

  const comp = await (await page.request.get("/api/stats/comprehension")).json();
  expect(comp.quizzes).toBeGreaterThanOrEqual(2);
  expect(Array.isArray(comp.points)).toBe(true);
  expect(comp.avgPct).toBeGreaterThan(0);
  expect(comp.totalQuestions).toBeGreaterThanOrEqual(14);
  expect(comp.totalCorrect).toBeGreaterThanOrEqual(10);
  // each point carries a rounded pct and a local date
  const p = comp.points[comp.points.length - 1];
  expect(p.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(typeof p.pct).toBe("number");
});

test("stats page renders the comprehension trend section", async ({ page }) => {
  await page.request.post("/api/events", {
    data: {
      events: [
        { ts: Date.now(), type: "quiz.result", mediaId: "feedfeedfeed", total: 6, correct: 5 },
      ],
    },
  });
  await page.goto("/#/stats");
  const heading = page.locator(".h2", { hasText: "Comprehension trend" });
  await expect(heading).toBeVisible();
  // sparkline bars + the avg / count aggregate stats
  await expect(page.locator(".comp-chart .comp-col").first()).toBeVisible();
  await expect(page.locator(".comp-chart")).toContainText("");
  await expect(
    page.locator(".stat", { hasText: "avg comprehension" }),
  ).toBeVisible();
  await expect(
    page.locator(".stat", { hasText: "quizzes taken" }),
  ).toBeVisible();
});
