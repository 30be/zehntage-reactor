import { describe, expect, test } from "bun:test";
import {
  parseWhisperLine,
  parseRemoteWhisperBody,
  whisperLocalCapability,
} from "../src/lib/whisper.ts";

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

// --- remote whisper backend: response parsing ------------------------------

describe("parseRemoteWhisperBody", () => {
  test("parses { cues: [...] } JSON", () => {
    const body = JSON.stringify({
      cues: [
        { start: 0.5, end: 2.0, text: "勉強します。" },
        { start: 2.5, end: 4.0, text: "図書館へ行きます。" },
      ],
    });
    const cues = parseRemoteWhisperBody(body, "application/json");
    expect(cues).toEqual([
      { start: 0.5, end: 2.0, text: "勉強します。" },
      { start: 2.5, end: 4.0, text: "図書館へ行きます。" },
    ]);
  });

  test("parses a bare cue array", () => {
    const body = JSON.stringify([{ start: 1, end: 2, text: "本" }]);
    const cues = parseRemoteWhisperBody(body, "application/json");
    expect(cues).toEqual([{ start: 1, end: 2, text: "本" }]);
  });

  test("drops malformed cue entries (NaN times / empty text)", () => {
    const body = JSON.stringify({
      cues: [
        { start: "x", end: 2, text: "bad" },
        { start: 1, end: 2, text: "" },
        { start: 3, end: 4, text: "good" },
      ],
    });
    const cues = parseRemoteWhisperBody(body, "application/json");
    expect(cues).toEqual([{ start: 3, end: 4, text: "good" }]);
  });

  test("falls back to SRT parsing for a subrip body", () => {
    const srt = "1\n00:00:01,000 --> 00:00:02,000\nこんにちは\n";
    const cues = parseRemoteWhisperBody(srt, "application/x-subrip");
    expect(cues.length).toBe(1);
    expect(cues[0]).toMatchObject({ start: 1, end: 2, text: "こんにちは" });
  });

  test("returns [] for an unparseable body", () => {
    expect(parseRemoteWhisperBody("not json, not srt", "text/plain")).toEqual([]);
  });
});

// --- local capability probe (smart toasts) ---------------------------------

describe("whisperLocalCapability", () => {
  test("reports fully available under WHISPER_FAKE=1", () => {
    const prev = process.env.WHISPER_FAKE;
    process.env.WHISPER_FAKE = "1";
    try {
      const cap = whisperLocalCapability();
      expect(cap).toEqual({ available: true, whisperCli: true, model: true });
    } finally {
      if (prev === undefined) delete process.env.WHISPER_FAKE;
      else process.env.WHISPER_FAKE = prev;
    }
  });

  test("never throws and returns a well-shaped object", () => {
    const prev = process.env.WHISPER_FAKE;
    delete process.env.WHISPER_FAKE;
    try {
      const cap = whisperLocalCapability();
      expect(typeof cap.available).toBe("boolean");
      expect(typeof cap.whisperCli).toBe("boolean");
      expect(typeof cap.model).toBe("boolean");
      // available is the AND of the two probes.
      expect(cap.available).toBe(cap.whisperCli && cap.model);
    } finally {
      if (prev !== undefined) process.env.WHISPER_FAKE = prev;
    }
  });
});
