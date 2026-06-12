// Shared e2e helpers: console-error collector fixture + common page actions.

import { test as base, expect, type Page } from "@playwright/test";

const ALLOWLIST = [
  /favicon\.ico/i,
  // benign media teardown noise when a test navigates away mid-load
  /ERR_ABORTED.*\/media\//,
  // expected 400 from the root-chooser invalid-path test (no URL is attached
  // to "Failed to load resource" console entries, so match by status text)
  /Failed to load resource.*400/,
  // Cards tab renders fake-anki frame paths ("fake/upload.jpg") that 404
  /Failed to load resource.*404/,
];

export const test = base.extend<{ page: Page }>({
  page: async ({ page }, use) => {
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });
    page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
    await use(page);
    const real = errors.filter((e) => !ALLOWLIST.some((re) => re.test(e)));
    expect(real, "console errors during test").toEqual([]);
  },
});

export { expect };

/** Library entry ids, resolved from the API (ids are sha1 of relPath). */
export async function entryId(page: Page, name: string): Promise<string> {
  const res = await page.request.get("/api/library");
  const list = (await res.json()) as { id: string; name: string }[];
  const e = list.find((x) => x.name === name);
  if (!e) throw new Error(`no library entry named ${name}`);
  return e.id;
}

export async function openPlayer(page: Page, name: string): Promise<string> {
  const id = await entryId(page, name);
  await page.goto(`/#/play/${id}`);
  await expect(page.locator("video")).toBeVisible();
  return id;
}

export const video = (page: Page) => page.locator("video");

export async function seekTo(page: Page, t: number): Promise<void> {
  await page.evaluate((tt) => {
    const v = document.querySelector("video")!;
    v.currentTime = tt;
  }, t);
}

export async function playVideo(page: Page): Promise<void> {
  await page.evaluate(() => document.querySelector("video")!.play());
}

/** Wait until the tokenizer has split the active cue into hoverable tokens. */
export async function waitForTokens(page: Page) {
  await expect(page.locator(".sub-primary .tok").first()).toBeVisible({ timeout: 20_000 });
}
