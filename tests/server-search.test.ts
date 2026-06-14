import { expect, test } from "bun:test";
import { buildSearchLines } from "../src/server/index.ts";

test("buildSearchLines: JA-only (no RU track) → no ru fields, JA normalized", () => {
  const lines = buildSearchLines(
    [
      { start: 1, text: "図書館" },
      { start: 2, text: "トモダチ" },
    ],
    null,
  );
  expect(lines).toEqual([
    { start: 1, text: "図書館", norm: "図書館" },
    // katakana → hiragana on the JA side
    { start: 2, text: "トモダチ", norm: "ともだち" },
  ]);
});

test("buildSearchLines: equal counts pair RU 1:1 by index", () => {
  const lines = buildSearchLines(
    [
      { start: 1, text: "本" },
      { start: 5, text: "犬" },
    ],
    [
      { start: 1, text: "Книга" },
      { start: 5, text: "Собака" },
    ],
  );
  expect(lines[0]).toEqual({
    start: 1,
    text: "本",
    norm: "本",
    ru: "Книга",
    ruNorm: "книга", // RU normalization is lowercase-only
  });
  expect(lines[1]!.ru).toBe("Собака");
  expect(lines[1]!.ruNorm).toBe("собака");
});

test("buildSearchLines: mismatched counts pair by nearest start within 0.5s", () => {
  const lines = buildSearchLines(
    [
      { start: 1.0, text: "A" },
      { start: 10.0, text: "B" },
    ],
    // out-of-order, different count
    [
      { start: 10.2, text: "RuB" },
      { start: 1.1, text: "RuA" },
      { start: 99.0, text: "Extra" },
    ],
  );
  expect(lines[0]!.ru).toBe("RuA"); // 1.0 ↔ 1.1 (0.1s)
  expect(lines[1]!.ru).toBe("RuB"); // 10.0 ↔ 10.2 (0.2s)
});

test("buildSearchLines: no RU cue within tolerance → JA line stays RU-less", () => {
  const lines = buildSearchLines(
    [{ start: 1, text: "A" }],
    [
      { start: 50, text: "far" },
      { start: 60, text: "farther" },
    ],
  );
  expect(lines[0]!.ru).toBeUndefined();
  expect(lines[0]!.ruNorm).toBeUndefined();
});

test("buildSearchLines: empty RU text is treated as absent", () => {
  const lines = buildSearchLines(
    [{ start: 1, text: "A" }],
    [{ start: 1, text: "" }],
  );
  expect(lines[0]!.ru).toBeUndefined();
});
