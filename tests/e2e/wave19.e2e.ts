// Wave 19 — data export / import (portable JSON bundle).
//
//   GET  /api/export -> { version, exportedAt, settings, state, events }
//   POST /api/import -> merges settings + state (LWW), skips events by default
//
// These exercise the live endpoints; the Settings "Data" section drives the
// same client calls (exercised via the API here to stay deterministic — the
// import path reloads the page, which the API-level round-trip avoids).

import { test, expect } from "./helpers.ts";

test.describe("data export", () => {
  test("GET /api/export returns a valid bundle with settings + state", async ({
    page,
  }) => {
    // seed a state key so the export is non-trivial
    const stateRes = await page.request.post("/api/state", {
      data: { "zr.test.export": { v: "1", ts: Date.now() } },
    });
    expect(stateRes.ok()).toBe(true);

    const res = await page.request.get("/api/export");
    expect(res.ok()).toBe(true);
    // browser-download header present
    expect(res.headers()["content-disposition"] ?? "").toContain(
      "zehntage-export-",
    );

    const bundle = (await res.json()) as {
      version: number;
      exportedAt: string;
      settings: Record<string, unknown>;
      state: Record<string, { v: string; ts: number }>;
      events: unknown[];
      eventsTruncated: boolean;
    };
    expect(typeof bundle.version).toBe("number");
    expect(typeof bundle.exportedAt).toBe("string");
    expect(bundle.settings).toBeTruthy();
    expect(bundle.settings.targetLang).toBeTruthy(); // DEFAULTS folded in
    expect(bundle.state["zr.test.export"]).toEqual({
      v: "1",
      ts: expect.any(Number),
    });
    expect(Array.isArray(bundle.events)).toBe(true);
    expect(typeof bundle.eventsTruncated).toBe("boolean");
  });
});

test.describe("data import round-trip", () => {
  test("POST /api/import changes a setting and merges state", async ({ page }) => {
    // capture current settings to restore afterwards (shared server)
    const before = (await (await page.request.get("/api/settings")).json()) as {
      knownLang?: string;
    };
    const original = before.knownLang ?? "ru";
    const flipped = original === "de" ? "ru" : "de";

    const bundle = {
      version: 1,
      exportedAt: new Date().toISOString(),
      settings: { knownLang: flipped },
      state: { "zr.test.import": { v: "imported", ts: Date.now() } },
      events: [{ ts: Date.now(), type: "lookup" }], // must be skipped
    };

    const res = await page.request.post("/api/import", { data: bundle });
    expect(res.ok()).toBe(true);
    const result = (await res.json()) as {
      settingsImported: boolean;
      stateKeys: number;
      eventsImported: number;
    };
    expect(result.settingsImported).toBe(true);
    expect(result.eventsImported).toBe(0); // events skipped by default
    expect(result.stateKeys).toBeGreaterThanOrEqual(1);

    // setting actually changed
    const after = (await (await page.request.get("/api/settings")).json()) as {
      knownLang?: string;
    };
    expect(after.knownLang).toBe(flipped);

    // state key landed
    const state = (await (await page.request.get("/api/state")).json()) as Record<
      string,
      { v: string }
    >;
    expect(state["zr.test.import"]?.v).toBe("imported");

    // restore the original setting so the shared server is left as found
    await page.request.post("/api/import", {
      data: { version: 1, settings: { knownLang: original }, state: {}, events: [] },
    });
  });

  test("POST /api/import rejects a malformed bundle", async ({ page }) => {
    const res = await page.request.post("/api/import", { data: { nope: true } });
    expect(res.status()).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error ?? "").toMatch(/version/i);
  });

  test("Settings page shows a Data section with export/import controls", async ({
    page,
  }) => {
    await page.goto("/#/settings");
    const section = page.locator(".form-group", { hasText: "Data" });
    await expect(section).toBeVisible();
    await expect(
      section.getByRole("button", { name: /Export data/i }),
    ).toBeVisible();
    await expect(
      section.getByRole("button", { name: /Import data/i }),
    ).toBeVisible();
  });
});
