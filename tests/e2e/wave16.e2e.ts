// Wave 16 — learning insights:
//  1. "study next" curriculum marker on the Library (web/curriculum.ts)
//  2. comprehension trend on Stats from quiz.result telemetry
// Both reuse data we already collect; no Gemini. Uses the clip.mp4 fixture.

import { test, expect } from "./helpers.ts";

// --- study-next marker removed (feature deleted in round-2 redesign) ------

// --- comprehension trend -------------------------------------------------

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
