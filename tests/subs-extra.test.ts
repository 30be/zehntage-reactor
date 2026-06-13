// Supplemental tests for src/lib/subs.ts — covers gaps left by subs.test.ts:
//   - parseAss \\h (non-breaking space) escape → regular space
//   - parseAss: override-only line produces no cue (empty body after strip)
//   - trackLabel with origin "generated" sidecar
//   - parseTimestamp edge cases (sub-second .5 centisecond)
//   - parseSrt: block without a sequence number still parses

import { describe, expect, test } from "bun:test";
import { parseAss, parseSrt, trackLabel, parseTimestamp, type SubTrack } from "../src/lib/subs.ts";

// Helper to build a minimal ASS Events block.
const evHeader =
  "[Events]\n" +
  "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n";

describe("parseAss — \\h (hard space) escape", () => {
  test("\\h in ASS text is converted to a regular space", () => {
    const ass = evHeader + "Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,お\\hかえり\n";
    const cues = parseAss(ass);
    expect(cues).toHaveLength(1);
    expect(cues[0]!.text).toBe("お かえり");
  });

  test("multiple \\h escapes all become spaces", () => {
    const ass = evHeader + "Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,a\\hb\\hc\n";
    const cues = parseAss(ass);
    expect(cues[0]!.text).toBe("a b c");
  });
});

describe("parseAss — override-tag-only lines produce no cue", () => {
  test("a line that is only override tags collapses to empty body and is skipped", () => {
    // After stripping {…} and \N/\n the text is empty → should not appear in output.
    const ass =
      evHeader +
      "Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\an8}{\\pos(640,50)}\n" +
      "Dialogue: 0,0:00:03.00,0:00:04.00,Default,,0,0,0,,実際のセリフ\n";
    const cues = parseAss(ass);
    expect(cues).toHaveLength(1);
    expect(cues[0]!.text).toBe("実際のセリフ");
  });
});

describe("parseAss — \\N and \\n become real newlines", () => {
  test("\\N escape becomes \\n in cue text", () => {
    const ass = evHeader + "Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,一行目\\N二行目\n";
    const cues = parseAss(ass);
    expect(cues[0]!.text).toBe("一行目\n二行目");
  });

  test("\\n (lowercase) escape also becomes \\n", () => {
    const ass = evHeader + "Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,甲\\n乙\n";
    const cues = parseAss(ass);
    expect(cues[0]!.text).toBe("甲\n乙");
  });
});

describe("parseAss — BOM tolerance", () => {
  test("UTF-8 BOM at the start of file is stripped silently", () => {
    const ass = "﻿" + evHeader + "Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,テスト\n";
    const cues = parseAss(ass);
    expect(cues).toHaveLength(1);
    expect(cues[0]!.text).toBe("テスト");
  });
});

describe("trackLabel — sidecar generated origin", () => {
  const mk = (p: Partial<SubTrack>): SubTrack =>
    ({ id: "x", kind: "sidecar", lang: "ja", ...p }) as SubTrack;

  test("sidecar with origin 'generated' → '· generated'", () => {
    expect(trackLabel(mk({ origin: "generated" }))).toBe("Japanese · generated");
  });

  test("sidecar with origin 'external' → '· file'", () => {
    expect(trackLabel(mk({ origin: "external" }))).toBe("Japanese · file");
  });

  test("sidecar with no origin → '· file' (default)", () => {
    expect(trackLabel(mk({}))).toBe("Japanese · file");
  });

  test("embedded track with title matching /whisper/i → '· Whisper'", () => {
    expect(trackLabel(mk({ kind: "embedded", title: "Whisper ASR" }))).toBe("Japanese · Whisper");
  });

  test("embedded track with unrelated title → '· embedded'", () => {
    expect(trackLabel(mk({ kind: "embedded", title: "Full dialogue" }))).toBe(
      "Japanese · embedded",
    );
  });
});

describe("parseTimestamp — additional edge cases", () => {
  test("exact integer seconds", () => {
    expect(parseTimestamp("0:01:00.00")).toBeCloseTo(60);
  });

  test("centisecond .5 → 0.5 s", () => {
    // ASS uses centiseconds: "0:00:00.50" → 0.5s
    expect(parseTimestamp("0:00:00.50")).toBeCloseTo(0.5);
  });

  test("millisecond .500 (srt comma form) → 0.5 s", () => {
    expect(parseTimestamp("00:00:00,500")).toBeCloseTo(0.5);
  });

  test("invalid string → NaN", () => {
    expect(parseTimestamp("not-a-time")).toBeNaN();
  });
});

describe("parseSrt — additional edge cases", () => {
  test("block without sequence number is still parsed", () => {
    // Some generators omit the counter line entirely.
    const srt = "00:00:01,000 --> 00:00:03,000\nこんにちは\n";
    const cues = parseSrt(srt);
    expect(cues).toHaveLength(1);
    expect(cues[0]!.text).toBe("こんにちは");
  });

  test("cues are returned sorted by start time regardless of input order", () => {
    const srt = `2
00:00:05,000 --> 00:00:07,000
B

1
00:00:01,000 --> 00:00:03,000
A
`;
    const cues = parseSrt(srt);
    expect(cues[0]!.text).toBe("A");
    expect(cues[1]!.text).toBe("B");
  });
});
