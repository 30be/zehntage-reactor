import { describe, expect, test } from "bun:test";
import { fmtMin, localDateStr, activityShade } from "../web/statsfmt.ts";

// ---- fmtMin ----------------------------------------------------------------

describe("fmtMin", () => {
  test("0 seconds → 0 min", () => {
    expect(fmtMin(0)).toBe("0 min");
  });

  test("30 seconds → 1 min (rounds)", () => {
    expect(fmtMin(30)).toBe("1 min");
  });

  test("59 seconds → 1 min (rounds)", () => {
    expect(fmtMin(59)).toBe("1 min");
  });

  test("60 seconds → 1 min", () => {
    expect(fmtMin(60)).toBe("1 min");
  });

  test("90 seconds → 2 min (rounds)", () => {
    expect(fmtMin(90)).toBe("2 min");
  });

  test("3600 seconds → 60 min", () => {
    expect(fmtMin(3600)).toBe("60 min");
  });

  test("5400 seconds (90 min) → 90 min", () => {
    expect(fmtMin(5400)).toBe("90 min");
  });

  test("large value rounds correctly", () => {
    expect(fmtMin(7230)).toBe("121 min");
  });
});

// ---- localDateStr ----------------------------------------------------------

describe("localDateStr", () => {
  test("formats a known date correctly", () => {
    // Use fixed values to avoid TZ drift from new Date("2024-01-15")
    const d = new Date(2024, 0, 15); // Jan 15 2024 local time
    expect(localDateStr(d)).toBe("2024-01-15");
  });

  test("pads single-digit month and day", () => {
    const d = new Date(2023, 2, 5); // March 5 2023
    expect(localDateStr(d)).toBe("2023-03-05");
  });

  test("handles December correctly", () => {
    const d = new Date(2023, 11, 31); // Dec 31 2023
    expect(localDateStr(d)).toBe("2023-12-31");
  });

  test("uses local date components, not UTC", () => {
    // Create a date via local constructor — result must match local components
    const d = new Date(2024, 5, 13); // Jun 13 2024 local
    const result = localDateStr(d);
    expect(result).toBe(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
  });
});

// ---- activityShade ---------------------------------------------------------

describe("activityShade", () => {
  test("0 min → shade 0", () => {
    expect(activityShade(0)).toBe(0);
  });

  test("negative (defensive) → shade 0", () => {
    expect(activityShade(-1)).toBe(0);
  });

  test("1 min → shade 1 (< 10)", () => {
    expect(activityShade(1)).toBe(1);
  });

  test("9 min → shade 1 (boundary below 10)", () => {
    expect(activityShade(9)).toBe(1);
  });

  test("10 min → shade 2 (>= 10)", () => {
    expect(activityShade(10)).toBe(2);
  });

  test("29 min → shade 2 (boundary below 30)", () => {
    expect(activityShade(29)).toBe(2);
  });

  test("30 min → shade 3 (>= 30)", () => {
    expect(activityShade(30)).toBe(3);
  });

  test("59 min → shade 3 (boundary below 60)", () => {
    expect(activityShade(59)).toBe(3);
  });

  test("60 min → shade 4 (>= 60)", () => {
    expect(activityShade(60)).toBe(4);
  });

  test("120 min → shade 4", () => {
    expect(activityShade(120)).toBe(4);
  });
});
