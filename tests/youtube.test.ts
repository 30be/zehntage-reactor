import { describe, expect, test } from "bun:test";
import { isYoutubeUrl, parseYtdlpPercent } from "../src/lib/youtube.ts";

describe("isYoutubeUrl", () => {
  test("accepts youtube watch / short / subdomain forms", () => {
    expect(isYoutubeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(true);
    expect(isYoutubeUrl("https://youtube.com/watch?v=abc")).toBe(true);
    expect(isYoutubeUrl("https://youtu.be/dQw4w9WgXcQ")).toBe(true);
    expect(isYoutubeUrl("https://m.youtube.com/watch?v=abc")).toBe(true);
    expect(isYoutubeUrl("https://music.youtube.com/watch?v=abc")).toBe(true);
    expect(isYoutubeUrl("http://www.youtube.com/watch?v=abc")).toBe(true);
  });

  test("rejects non-youtube hosts and non-http schemes", () => {
    expect(isYoutubeUrl("https://vimeo.com/12345")).toBe(false);
    expect(isYoutubeUrl("https://notyoutube.com/watch?v=abc")).toBe(false);
    // lookalike host must not pass the exact-host check
    expect(isYoutubeUrl("https://youtube.com.evil.test/watch?v=abc")).toBe(false);
    expect(isYoutubeUrl("file:///etc/passwd")).toBe(false);
    expect(isYoutubeUrl("javascript:alert(1)")).toBe(false);
    expect(isYoutubeUrl("not a url")).toBe(false);
    expect(isYoutubeUrl("")).toBe(false);
  });
});

describe("parseYtdlpPercent", () => {
  test("parses our progress-template and raw download lines", () => {
    expect(parseYtdlpPercent("download: 12.3%")).toBeCloseTo(12.3);
    expect(parseYtdlpPercent("download:100.0%")).toBe(100);
    expect(parseYtdlpPercent("[download]   5.0% of 12.34MiB at 1.2MiB/s")).toBeCloseTo(5);
    expect(parseYtdlpPercent("download:  0.0%")).toBe(0);
  });

  test("returns null for lines without a percentage", () => {
    expect(parseYtdlpPercent("[Merger] Merging formats into out.mp4")).toBeNull();
    expect(parseYtdlpPercent("[info] Downloading 1 format(s)")).toBeNull();
    expect(parseYtdlpPercent("")).toBeNull();
  });

  test("clamps to 0..100", () => {
    expect(parseYtdlpPercent("download:999%")).toBe(100);
  });
});
