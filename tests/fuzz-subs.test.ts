// PROPERTY / FUZZ tests for the pure subtitle parsers in src/lib/subs.ts.
//
// Invariant under test: parseSrt / parseVtt / parseAss / parseSubtitleText
// NEVER throw and ALWAYS return a Cue[] whose every element has finite numeric
// start/end and a string `text`, on ARBITRARY / garbage input (control chars,
// lone surrogates, huge lines, random `-->` / `Dialogue:` / `[Events]`
// fragments, mixed CRLF, override tags, mixed scripts/emoji).
//
// Deterministic: a fixed-seed mulberry32 PRNG (tests/_fuzz.ts) — NOT
// Math.random — so any failing case is reproducible by re-running.

import { describe, expect, test } from "bun:test";
import {
  parseSrt,
  parseVtt,
  parseAss,
  parseSubtitleText,
  type Cue,
} from "../src/lib/subs.ts";
import { Rng, fuzzString, maybeHugeString } from "./_fuzz.ts";

const PARSERS: Array<[string, (t: string) => Cue[]]> = [
  ["parseSrt", parseSrt],
  ["parseVtt", parseVtt],
  ["parseAss", parseAss],
  ["parseSubtitleText/srt", (t) => parseSubtitleText(t, "srt")],
  ["parseSubtitleText/vtt", (t) => parseSubtitleText(t, "vtt")],
  ["parseSubtitleText/ass", (t) => parseSubtitleText(t, "ass")],
  ["parseSubtitleText/unknown", (t) => parseSubtitleText(t, "🦀")],
];

/** Assert the parser output is a well-shaped Cue[]. Returns nothing; throws
 *  with the offending input on the first invalid shape. */
function assertSaneCues(cues: Cue[], input: string, label: string): void {
  expect(Array.isArray(cues)).toBe(true);
  for (const c of cues) {
    if (typeof c.text !== "string") {
      throw new Error(`${label}: non-string text for input ${JSON.stringify(input)}`);
    }
    if (typeof c.start !== "number" || !Number.isFinite(c.start)) {
      throw new Error(
        `${label}: non-finite start ${c.start} for input ${JSON.stringify(input)}`,
      );
    }
    if (typeof c.end !== "number" || !Number.isFinite(c.end)) {
      throw new Error(
        `${label}: non-finite end ${c.end} for input ${JSON.stringify(input)}`,
      );
    }
  }
}

describe("fuzz: subtitle parsers never throw / return sane Cue[]", () => {
  test("3000 random garbage inputs across all parsers", () => {
    const rng = new Rng(0x5eed01);
    for (let i = 0; i < 3000; i++) {
      const input = maybeHugeString(rng);
      for (const [label, fn] of PARSERS) {
        let cues: Cue[];
        expect(() => {
          cues = fn(input);
        }).not.toThrow();
        assertSaneCues(cues!, input, label);
      }
    }
  });

  // Structurally-valid-but-adversarial: build inputs that LOOK like real
  // SRT/ASS so we exercise the happy path with hostile field values.
  test("1500 structurally-valid-but-adversarial SRT/VTT inputs", () => {
    const rng = new Rng(0xabc123);
    for (let i = 0; i < 1500; i++) {
      const blocks: string[] = [];
      const nBlocks = rng.int(0, 6);
      for (let b = 0; b < nBlocks; b++) {
        const seq = rng.bool() ? `${rng.int(0, 9999)}\n` : "";
        const t1 = randomTimestamp(rng);
        const t2 = randomTimestamp(rng);
        const arrow = rng.pick([" --> ", "-->", "  -->  ", " --> "]);
        const body = fuzzString(rng, 20);
        blocks.push(`${seq}${t1}${arrow}${t2}\n${body}`);
      }
      const nl = rng.pick(["\n\n", "\r\n\r\n", "\n\n\n"]);
      const input = (rng.bool(0.3) ? "WEBVTT\n\n" : "") + blocks.join(nl);
      for (const [label, fn] of [
        ["parseSrt", parseSrt],
        ["parseVtt", parseVtt],
      ] as Array<[string, (t: string) => Cue[]]>) {
        let cues: Cue[];
        expect(() => {
          cues = fn(input);
        }).not.toThrow();
        assertSaneCues(cues!, input, label);
      }
    }
  });

  test("1500 structurally-valid-but-adversarial ASS inputs", () => {
    const rng = new Rng(0xdef456);
    const formats = [
      "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
      "Format: Start, End, Text", // minimal
      "Format: Text, Start, End, Style", // reordered
      "Format:", // empty format
      "Format: Foo, Bar", // no Text/Start/End at all
    ];
    const styles = ["Default", "staff", "JP", "CN-chs", "中文", "Sign", "", "credits"];
    for (let i = 0; i < 1500; i++) {
      const lines: string[] = ["[Script Info]", "Title: x", "[Events]", rng.pick(formats)];
      const nDlg = rng.int(0, 8);
      for (let d = 0; d < nDlg; d++) {
        const fields = [
          String(rng.int(0, 3)), // Layer
          randomTimestamp(rng), // Start
          randomTimestamp(rng), // End
          rng.pick(styles), // Style
          "", // Name
          "0",
          "0",
          "0",
          "", // Effect
          fuzzString(rng, 15), // Text (may itself contain commas)
        ];
        lines.push("Dialogue: " + fields.join(","));
      }
      const input = lines.join(rng.pick(["\n", "\r\n"]));
      let cues: Cue[];
      expect(() => {
        cues = parseAss(input);
      }).not.toThrow();
      assertSaneCues(cues!, input, "parseAss");
    }
  });
});

/** Emit a timestamp string, sometimes well-formed, sometimes garbage — both
 *  must be handled (garbage just yields NaN → the cue is dropped, never kept). */
function randomTimestamp(rng: Rng): string {
  const kind = rng.int(0, 5);
  switch (kind) {
    case 0:
      return `${pad(rng.int(0, 23))}:${pad(rng.int(0, 59))}:${pad(rng.int(0, 59))},${pad3(rng.int(0, 999))}`;
    case 1:
      return `${pad(rng.int(0, 9))}:${pad(rng.int(0, 59))}:${pad(rng.int(0, 59))}.${pad(rng.int(0, 99))}`;
    case 2:
      return `${rng.int(0, 99)}:${rng.int(0, 99)}:${rng.int(0, 99)}.${rng.int(0, 999)}`;
    case 3:
      return "garbage";
    case 4:
      return ""; // empty
    default:
      return `${rng.int(0, 99999)}`; // numeric-only, no colons → NaN
  }
}
const pad = (n: number) => String(n).padStart(2, "0");
const pad3 = (n: number) => String(n).padStart(3, "0");
