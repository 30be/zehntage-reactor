// tests/e2e/health.e2e.ts
import { test, expect } from "./helpers.ts";

test("health page loads and shows perf table", async ({ page }) => {
  // Seed some perf events via POST /api/events
  const now = Date.now();
  await page.request.post("/api/events", {
    data: {
      events: [
        { ts: now - 1000, type: "perf.route", ms: 120, path: "/api/lookup", status: 200 },
        { ts: now - 2000, type: "perf.route", ms: 800, path: "/api/lookup", status: 200 },
        { ts: now - 3000, type: "perf.gemini", ms: 600, op: "lookup" },
        { ts: now - 4000, type: "anomaly.anki_slow", ms: 4500 },
        { ts: now - 5000, type: "anomaly.whisper_warning", message: "coverage hole: 30s–60s", mediaId: "abc" },
      ],
    },
  });

  await page.goto("/#/health");

  // Perf stats table should have at least one row
  const table = page.locator(".health-table").first();
  await expect(table).toBeVisible();
  await expect(table.locator("tbody tr").first()).toBeVisible();

  // Should show perf.route or perf.gemini type
  const types = await page.locator(".health-table .health-type").allTextContents();
  const hasPerfType = types.some((t) => t.startsWith("perf."));
  expect(hasPerfType).toBe(true);
});

test("health page shows anomaly counts", async ({ page }) => {
  const now = Date.now();
  await page.request.post("/api/events", {
    data: {
      events: [
        { ts: now - 1000, type: "anomaly.anki_slow", ms: 5000 },
        { ts: now - 2000, type: "anomaly.anki_slow", ms: 6000 },
      ],
    },
  });

  await page.goto("/#/health");

  // Anomaly section should list anki_slow
  const sections = page.locator(".health-section");
  const anomalySection = sections.filter({ hasText: "anomalies" });
  await expect(anomalySection).toBeVisible();
  await expect(anomalySection.locator("tbody tr").first()).toBeVisible();
});

test("health page shows whisper warnings", async ({ page }) => {
  const now = Date.now();
  await page.request.post("/api/events", {
    data: {
      events: [
        { ts: now - 500, type: "anomaly.whisper_warning", message: "coverage hole: 45s–90s", mediaId: "xyz" },
      ],
    },
  });

  await page.goto("/#/health");

  const sections = page.locator(".health-section");
  const warnSection = sections.filter({ hasText: "whisper warnings" });
  await expect(warnSection).toBeVisible();
  await expect(warnSection.locator("td", { hasText: "coverage hole" }).first()).toBeVisible();
});

test("health page shown in sidebar nav", async ({ page }) => {
  await page.goto("/#/");
  const healthNav = page.locator(".side-item", { hasText: "Health" });
  await expect(healthNav).toBeVisible();
  await healthNav.click();
  await expect(page).toHaveURL(/#\/health/);
});

test("health page surfaces a visible error state on fetch failure", async ({ page }) => {
  await page.route("**/api/health/summary", (route) =>
    route.fulfill({ status: 500, body: "boom" }),
  );
  await page.goto("/#/health");
  const err = page.locator(".state.error[role='alert']");
  await expect(err).toBeVisible();
  await expect(err).toContainText(/load/i);
});

test("health page shows a loading spinner while the summary is in flight", async ({ page }) => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  await page.route("**/api/health/summary", async (route) => {
    await gate;
    await route.continue();
  });
  await page.goto("/#/health");
  await expect(page.locator(".state[role='status'] .spinner")).toBeVisible();
  release();
  await expect(page.locator(".health-table").first()).toBeVisible();
});
