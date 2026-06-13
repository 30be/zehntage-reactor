import { describe, test, expect, beforeEach } from "bun:test";
import { calcProgress } from "../web/readProgress.ts";

// calcProgress is pure — no DOM/localStorage needed.

describe("calcProgress", () => {
  test("returns 0 for empty doc", () => {
    expect(calcProgress(0, 0)).toBe(0);
    expect(calcProgress(-1, 0)).toBe(0);
  });

  test("returns 0 when nothing read yet", () => {
    expect(calcProgress(-1, 10)).toBe(0);
  });

  test("first para read = 10% of 10", () => {
    expect(calcProgress(0, 10)).toBe(10);
  });

  test("last para = 100%", () => {
    expect(calcProgress(9, 10)).toBe(100);
  });

  test("mid doc", () => {
    expect(calcProgress(4, 10)).toBe(50);
  });

  test("single-paragraph doc", () => {
    expect(calcProgress(0, 1)).toBe(100);
  });
});
