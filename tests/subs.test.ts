import { describe, expect, test } from "bun:test";
import {
  parseSrt,
  parseVtt,
  parseAss,
  parseTimestamp,
  formatSrtTimestamp,
  cuesToSrt,
  languageName,
  trackLabel,
  parseSidecarTrackId,
  type SubTrack,
} from "../src/lib/subs.ts";

describe("languageName", () => {
  test("known codes (both 2- and 3-letter)", () => {
    expect(languageName("ja")).toBe("Japanese");
    expect(languageName("jpn")).toBe("Japanese");
    expect(languageName("ru")).toBe("Russian");
    expect(languageName("rus")).toBe("Russian");
    expect(languageName("en")).toBe("English");
    expect(languageName("eng")).toBe("English");
    expect(languageName("de")).toBe("German");
    expect(languageName("ger")).toBe("German");
  });
  test("case-insensitive", () => {
    expect(languageName("JPN")).toBe("Japanese");
  });
  test("unknown code uppercased", () => {
    expect(languageName("fr")).toBe("FR");
    expect(languageName("und")).toBe("UND");
  });
});

describe("trackLabel", () => {
  const mk = (p: Partial<SubTrack>): SubTrack =>
    ({ id: "x", kind: "embedded", lang: "jpn", ...p }) as SubTrack;
  test("embedded Whisper track", () => {
    expect(trackLabel(mk({ lang: "jpn", title: "Whisper transcription" }))).toBe(
      "Japanese · Whisper",
    );
  });
  test("embedded non-whisper track", () => {
    expect(trackLabel(mk({ lang: "jpn", title: "Full subs" }))).toBe("Japanese · embedded");
  });
  test("embedded with no title", () => {
    expect(trackLabel(mk({ lang: "eng" }))).toBe("English · embedded");
  });
  test("sidecar file", () => {
    expect(trackLabel(mk({ kind: "sidecar", lang: "rus" }))).toBe("Russian · file");
  });
});

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

describe("parseSidecarTrackId", () => {
  test("new ids with extension", () => {
    expect(parseSidecarTrackId("sidecar:ru.srt")).toEqual({
      generated: false,
      lang: "ru",
      ext: "srt",
    });
    expect(parseSidecarTrackId("sidecar:ru.ass")).toEqual({
      generated: false,
      lang: "ru",
      ext: "ass",
    });
    expect(parseSidecarTrackId("sidecar:ja-jp.vtt")).toEqual({
      generated: false,
      lang: "ja-jp",
      ext: "vtt",
    });
  });

  test("legacy ids without extension", () => {
    expect(parseSidecarTrackId("sidecar:ru")).toEqual({ generated: false, lang: "ru" });
    expect(parseSidecarTrackId("sidecar:und")).toEqual({ generated: false, lang: "und" });
  });

  test("generated ids", () => {
    expect(parseSidecarTrackId("sidecar:gen:ja")).toEqual({ generated: true, lang: "ja" });
    expect(parseSidecarTrackId("sidecar:gen:ru.srt")).toEqual({
      generated: true,
      lang: "ru",
      ext: "srt",
    });
  });

  test("non-sidecar ids return null", () => {
    expect(parseSidecarTrackId("embedded:2")).toBeNull();
  });
});
