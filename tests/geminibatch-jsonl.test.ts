import { describe, expect, test } from "bun:test";

import {
  buildBatchJsonl,
  estimateBatchCostUsd,
  BATCH_INPUT_USD_PER_1M,
  BATCH_OUTPUT_USD_PER_1M,
  type BatchItem,
} from "../src/lib/geminibatch.ts";
import { WORD_SCHEMA } from "../src/lib/gemini.ts";

// Complements geminibatch.test.ts: focuses on escaping, key re-alignment, and
// the exact dollar math at the new defaults. Pure helpers — NO network here.

describe("buildBatchJsonl — escaping & alignment", () => {
  test("escapes newlines/quotes/tabs/backslashes so each item stays one line", () => {
    const tricky = 'line1\nline2 "q" \t 猫\\back';
    const jsonl = buildBatchJsonl([{ key: 'k"1\n2', prompt: tricky }]);
    // The whole thing is a single line — no raw control char leaked in.
    expect(jsonl.includes("\n")).toBe(false);
    const obj = JSON.parse(jsonl);
    expect(obj.key).toBe('k"1\n2');
    expect(obj.request.contents[0].parts[0].text).toBe(tricky);
  });

  test("preserves key order for result re-alignment", () => {
    const items: BatchItem[] = [
      { key: "猫|ねこ|名詞", prompt: "x" },
      { key: "水|みず|名詞", prompt: "y" },
      { key: "火|ひ|名詞", prompt: "z" },
    ];
    const keys = buildBatchJsonl(items).split("\n").map((l) => JSON.parse(l).key);
    expect(keys).toEqual(["猫|ねこ|名詞", "水|みず|名詞", "火|ひ|名詞"]);
  });

  test("generation_config carries the WORD_SCHEMA verbatim", () => {
    const obj = JSON.parse(buildBatchJsonl([{ key: "k", prompt: "p" }]));
    const gc = obj.request.generation_config;
    expect(gc.response_mime_type).toBe("application/json");
    expect(gc.response_schema).toEqual(WORD_SCHEMA);
    // Exactly the keys we expect on the request object.
    expect(Object.keys(obj.request).sort()).toEqual(["contents", "generation_config"]);
  });
});

describe("estimateBatchCostUsd — exact dollar math", () => {
  test("documented batch-tier rates", () => {
    expect(BATCH_INPUT_USD_PER_1M).toBe(0.125);
    expect(BATCH_OUTPUT_USD_PER_1M).toBe(0.75);
  });

  test("per-word cost at 560 in / 130 out = $0.0001675", () => {
    // (560*0.125 + 130*0.75)/1e6 = (70 + 97.5)/1e6 = 1.675e-4
    expect(estimateBatchCostUsd(1)).toBeCloseTo(0.0001675, 12);
  });

  test("10k words ≈ $1.675 at defaults", () => {
    expect(estimateBatchCostUsd(10_000)).toBeCloseTo(1.675, 9);
  });
});
