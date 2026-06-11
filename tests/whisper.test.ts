import { describe, expect, test } from "bun:test";
import { parseWhisperLine } from "../src/lib/whisper.ts";

describe("parseWhisperLine", () => {
  test("parses whisper-cli segment lines", () => {
    const cue = parseWhisperLine("[00:00:01.000 --> 00:00:04.500]   こんにちは、世界");
    expect(cue).toEqual({ start: 1, end: 4.5, text: "こんにちは、世界" });
  });
  test("ignores non-segment output", () => {
    expect(parseWhisperLine("whisper_init_from_file: loading model")).toBeNull();
    expect(parseWhisperLine("")).toBeNull();
  });
});
