import { describe, expect, test } from "bun:test";
import {
  parseSrt,
  parseVtt,
  parseAss,
  parseTimestamp,
  formatSrtTimestamp,
  cuesToSrt,
} from "../src/lib/subs.ts";

describe("parseTimestamp", () => {
  test("srt comma form", () => {
    expect(parseTimestamp("00:01:02,345")).toBeCloseTo(62.345);
  });
  test("vtt dot form, no hours", () => {
    expect(parseTimestamp("01:02.345")).toBeCloseTo(62.345);
  });
  test("ass centiseconds", () => {
    expect(parseTimestamp("0:00:05.50")).toBeCloseTo(5.5);
  });
});

describe("parseSrt", () => {
  const srt = `1
00:00:01,000 --> 00:00:03,000
こんにちは

2
00:00:04,000 --> 00:00:06,500
<i>気になります！</i>
二行目
`;
  test("parses cues with multi-line text and strips tags", () => {
    const cues = parseSrt(srt);
    expect(cues).toHaveLength(2);
    expect(cues[0]).toEqual({ start: 1, end: 3, text: "こんにちは" });
    expect(cues[1]!.text).toBe("気になります！\n二行目");
    expect(cues[1]!.end).toBeCloseTo(6.5);
  });
  test("handles BOM and CRLF", () => {
    const cues = parseSrt("﻿1\r\n00:00:00,000 --> 00:00:01,000\r\nhi\r\n");
    expect(cues).toHaveLength(1);
    expect(cues[0]!.text).toBe("hi");
  });
  test("empty input", () => {
    expect(parseSrt("")).toEqual([]);
  });
});

describe("parseVtt", () => {
  test("parses with header and cue settings", () => {
    const vtt = `WEBVTT

00:01.000 --> 00:03.000 align:start
hello
`;
    const cues = parseVtt(vtt);
    expect(cues).toEqual([{ start: 1, end: 3, text: "hello" }]);
  });
});

describe("parseAss", () => {
  test("parses Dialogue lines, drops override tags", () => {
    const ass = `[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\an8}テスト, with comma\\Nline two
`;
    const cues = parseAss(ass);
    expect(cues).toHaveLength(1);
    expect(cues[0]!.text).toBe("テスト, with comma\nline two");
    expect(cues[0]!.start).toBe(1);
  });
});

describe("srt roundtrip", () => {
  test("cuesToSrt → parseSrt is identity", () => {
    const cues = [
      { start: 0.5, end: 2.25, text: "a" },
      { start: 3, end: 4.001, text: "b\nc" },
    ];
    expect(parseSrt(cuesToSrt(cues))).toEqual(cues);
  });
  test("formatSrtTimestamp", () => {
    expect(formatSrtTimestamp(3723.456)).toBe("01:02:03,456");
  });
});
