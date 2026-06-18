import { describe, expect, test } from "bun:test";
import {
  buildBatchJsonl,
  estimateBatchCostUsd,
  BATCH_INPUT_USD_PER_1M,
  BATCH_OUTPUT_USD_PER_1M,
  type BatchItem,
} from "../src/lib/geminibatch.ts";
import { WORD_SCHEMA } from "../src/lib/gemini.ts";

describe("buildBatchJsonl", () => {
  const items: BatchItem[] = [
    { key: "a", prompt: "p1" },
    { key: "b", prompt: "p2" },
  ];

  test("one JSON line per item, no trailing newline", () => {
    const jsonl = buildBatchJsonl(items);
    const lines = jsonl.split("\n");
    expect(lines).toHaveLength(2);
    expect(jsonl.endsWith("\n")).toBe(false);
  });

  test("each line has key + request shape with WORD_SCHEMA", () => {
    const lines = buildBatchJsonl(items).split("\n").map((l) => JSON.parse(l));
    expect(lines[0].key).toBe("a");
    expect(lines[0].request.contents[0].parts[0].text).toBe("p1");
    const gc = lines[0].request.generation_config;
    expect(gc.response_mime_type).toBe("application/json");
    expect(gc.response_schema).toEqual(WORD_SCHEMA);
    expect(lines[1].key).toBe("b");
  });

  test("empty input yields empty string", () => {
    expect(buildBatchJsonl([])).toBe("");
  });
});

describe("estimateBatchCostUsd", () => {
  test("uses default 560 in / 130 out tokens", () => {
    const cost = estimateBatchCostUsd(1);
    const expected =
      (560 * BATCH_INPUT_USD_PER_1M) / 1e6 + (130 * BATCH_OUTPUT_USD_PER_1M) / 1e6;
    expect(cost).toBeCloseTo(expected, 12);
  });

  test("scales linearly with word count", () => {
    expect(estimateBatchCostUsd(1000)).toBeCloseTo(estimateBatchCostUsd(1) * 1000, 9);
  });

  test("custom token averages", () => {
    const cost = estimateBatchCostUsd(10, 1000, 200);
    const expected =
      (10 * 1000 * BATCH_INPUT_USD_PER_1M) / 1e6 +
      (10 * 200 * BATCH_OUTPUT_USD_PER_1M) / 1e6;
    expect(cost).toBeCloseTo(expected, 12);
  });

  test("zero words costs nothing", () => {
    expect(estimateBatchCostUsd(0)).toBe(0);
  });
});
