// Supplemental tests for src/lib/subs.ts — covers gaps left by subs.test.ts:
//   - parseAss \\h (non-breaking space) escape → regular space
//   - parseAss: override-only line produces no cue (empty body after strip)
//   - trackLabel with origin "generated" sidecar
//   - parseTimestamp edge cases (sub-second .5 centisecond)
//   - parseSrt: block without a sequence number still parses

import { describe, expect, test } from "bun:test";
import {
  parseAss,
  parseSrt,
  parseVtt,
  trackLabel,
  parseTimestamp,
  isFansubCreditCue,
  type SubTrack,
} from "../src/lib/subs.ts";

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

// --- wave-13 #2: selectJapaneseDialogues / parseAss dual-language corner cases ---

describe("parseAss — selectJapaneseDialogues edge cases (wave-13 #2)", () => {
  // Kana-fallback no-overlap guard: when the file is a kana/hanzi-only mix, a
  // hanzi-only sign is dropped ONLY if it time-overlaps a kana (JP) line. A
  // hanzi-only sign sitting after ALL kana dialogue (no overlap) must survive.
  test("hanzi-only sign after all kana dialogue is kept (no-overlap fallback guard)", () => {
    const ass =
      evHeader +
      "Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,こんにちは\n" +
      "Dialogue: 0,0:00:03.00,0:00:04.00,Default,,0,0,0,,さようなら\n" +
      "Dialogue: 0,0:01:00.00,0:01:02.00,Sign,,0,0,0,,図書室\n";
    const cues = parseAss(ass).map((c) => c.text);
    expect(cues).toContain("図書室");
    expect(cues).toHaveLength(3);
  });

  // A hanzi-only line that DOES overlap a kana line is its CN counterpart → dropped.
  test("hanzi-only line overlapping a kana line is dropped (CN counterpart)", () => {
    const ass =
      evHeader +
      "Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,おはよう\n" +
      "Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,早上好\n";
    const cues = parseAss(ass).map((c) => c.text);
    expect(cues).toEqual(["おはよう"]);
  });

  // A style name carrying BOTH JP and CN markers (e.g. "CHS-JP") classifies as
  // unknown (""), so it is NOT dropped as a CN line even in a dual-language file.
  test("style with both JP and CN markers → unknown → survives the CN drop", () => {
    const ass =
      evHeader +
      "Dialogue: 0,0:00:01.00,0:00:02.00,JP,,0,0,0,,おはよう\n" +
      "Dialogue: 0,0:00:01.00,0:00:02.00,CHS,,0,0,0,,早上好\n" +
      "Dialogue: 0,0:00:01.00,0:00:02.00,CHS-JP,,0,0,0,,混在テキスト\n";
    const cues = parseAss(ass).map((c) => c.text);
    // CN-styled line dropped; JP-styled + dual-marker(unknown) line kept.
    expect(cues).toContain("おはよう");
    expect(cues).toContain("混在テキスト");
    expect(cues).not.toContain("早上好");
  });

  // A dual-language file (JP + unknown styles, kana/hanzi mix) where NO line
  // carries a recognizable CN style: the style-based drop never fires, so the
  // per-line kana fallback governs and the non-overlapping hanzi sign is kept.
  test("no line carries a CN style → JP + unknown signs all kept", () => {
    const ass =
      evHeader +
      "Dialogue: 0,0:00:01.00,0:00:02.00,JP,,0,0,0,,おはよう\n" +
      "Dialogue: 0,0:00:05.00,0:00:06.00,Sign,,0,0,0,,看板\n";
    const cues = parseAss(ass).map((c) => c.text);
    expect(cues).toEqual(["おはよう", "看板"]);
  });
});

// --- wave-13 #6: isFansubCreditCue handle-chain segment boundary ---

describe("isFansubCreditCue — handle-chain segment boundary (wave-13 #6)", () => {
  // @-prefixed handle list needs >= 2 segments.
  test('"@A／B" (2 segments, has @) → credit', () => {
    expect(isFansubCreditCue("@HandleA／HandleB")).toBe(true);
  });

  // Non-@ handle list needs >= 3 segments, so 2 is NOT enough.
  test('"A／B" (2 segments, no @) → NOT a credit', () => {
    expect(isFansubCreditCue("HandleA／HandleB")).toBe(false);
  });

  // Non-@ handle list with 3 segments (and no sentence punctuation) → credit.
  test('"A／B／C" (3 segments, no @) → credit', () => {
    expect(isFansubCreditCue("HandleA／HandleB／HandleC")).toBe(true);
  });

  // Guard: a 3-segment non-@ chain that ends in sentence punctuation is real
  // dialogue, not a credit (the no-punctuation rule).
  test("3-segment chain WITH sentence punctuation is NOT a credit", () => {
    expect(isFansubCreditCue("これ／それ／あれ。")).toBe(false);
  });
});

// --- wave-13 #11: parseVtt cue-setting stripping & header/NOTE handling ---

describe("parseVtt — cue settings, header variants, NOTE blocks (wave-13 #11)", () => {
  test("positional cue settings after the end timestamp are stripped", () => {
    const vtt =
      "WEBVTT\n\n" +
      "00:00:01.000 --> 00:00:03.000 line:10% position:50% align:center\n" +
      "Hello\n";
    const cues = parseVtt(vtt);
    expect(cues).toHaveLength(1);
    expect(cues[0]).toEqual({ start: 1, end: 3, text: "Hello" });
  });

  test("multiple cues each with their own settings parse cleanly", () => {
    const vtt =
      "WEBVTT\n\n" +
      "00:00:01.000 --> 00:00:03.000 line:10% position:50% align:center\nA\n\n" +
      "00:00:04.000 --> 00:00:06.000 align:start\nB\n";
    const cues = parseVtt(vtt);
    expect(cues.map((c) => c.text)).toEqual(["A", "B"]);
    expect(cues[1]).toEqual({ start: 4, end: 6, text: "B" });
  });

  test('"WEBVTT - metadata" header variant is stripped', () => {
    const vtt =
      "WEBVTT - Generated by whisper\n\n" +
      "00:00:01.000 --> 00:00:03.000\nReal line\n";
    const cues = parseVtt(vtt);
    expect(cues).toHaveLength(1);
    expect(cues[0]!.text).toBe("Real line");
  });

  test("NOTE comment block is ignored, real cue survives", () => {
    const vtt =
      "WEBVTT\n\n" +
      "NOTE this is a comment\nspanning two lines\n\n" +
      "00:00:01.000 --> 00:00:03.000\nReal\n";
    const cues = parseVtt(vtt);
    expect(cues).toHaveLength(1);
    expect(cues[0]!.text).toBe("Real");
  });
});
