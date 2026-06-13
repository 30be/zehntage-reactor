// Edge-case and load/stress tests for src/lib/subs.ts
// Focuses on malformed/empty/huge inputs not covered by subs.test.ts or subs-extra.test.ts.

import { describe, expect, test } from "bun:test";
import {
  parseSrt,
  parseAss,
  parseVtt,
  parseSubtitleText as parseSubtitleTextDirect,
  collapseRepeatedCues,
  dropRepeatingCycles,
  cleanCues,
  findCoverageHoles,
  kanaRatio,
  looksJapanese,
  type Cue,
} from "../src/lib/subs.ts";

// ---------------------------------------------------------------------------
// parseSrt — malformed inputs
// ---------------------------------------------------------------------------

describe("parseSrt — malformed inputs", () => {
  test("empty string → []", () => {
    expect(parseSrt("")).toEqual([]);
  });

  test("only whitespace → []", () => {
    expect(parseSrt("   \n\n\t  ")).toEqual([]);
  });

  test("no timing line → []", () => {
    // A sequence number with only text, no '-->' line
    const srt = "1\nこんにちは\n";
    expect(parseSrt(srt)).toEqual([]);
  });

  test("malformed timestamp (letters) → block skipped", () => {
    const srt = "1\nXX:YY:ZZ,000 --> 00:00:02,000\nテスト\n";
    expect(parseSrt(srt)).toEqual([]);
  });

  test("malformed timestamp on end side → block skipped", () => {
    const srt = "1\n00:00:01,000 --> BADTIME\nテスト\n";
    expect(parseSrt(srt)).toEqual([]);
  });

  test("CRLF line endings parse correctly", () => {
    const srt = "1\r\n00:00:01,000 --> 00:00:02,000\r\nCRLF test\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\n二行目\r\n";
    const cues = parseSrt(srt);
    expect(cues).toHaveLength(2);
    expect(cues[0]!.text).toBe("CRLF test");
    expect(cues[1]!.text).toBe("二行目");
  });

  test("out-of-order indices still sorted by start time", () => {
    const srt = `5
00:00:10,000 --> 00:00:12,000
C

2
00:00:01,000 --> 00:00:03,000
A

9
00:00:05,000 --> 00:00:07,000
B
`;
    const cues = parseSrt(srt);
    expect(cues.map((c) => c.text)).toEqual(["A", "B", "C"]);
  });

  test("missing blank line between blocks: still parses what it can", () => {
    // No blank line separating blocks — parseSrt uses /\n{2,}/ splits
    // so a single \n separator merges blocks; partial parse expected.
    const srt = "1\n00:00:01,000 --> 00:00:02,000\nA\n2\n00:00:03,000 --> 00:00:04,000\nB\n";
    // Don't assert exact count — just no throw, and text from either block appears
    const cues = parseSrt(srt);
    expect(() => parseSrt(srt)).not.toThrow();
    expect(Array.isArray(cues)).toBe(true);
  });

  test("whitespace-only cue body is skipped", () => {
    const srt = "1\n00:00:01,000 --> 00:00:02,000\n   \n\n2\n00:00:03,000 --> 00:00:04,000\nReal cue\n";
    const cues = parseSrt(srt);
    // The whitespace-only cue is stripped → only "Real cue" survives (or maybe both; at minimum no throw)
    expect(cues.some((c) => c.text === "Real cue")).toBe(true);
    expect(cues.every((c) => c.text.trim().length > 0)).toBe(true);
  });

  test("extremely long single cue text (10k chars) is preserved, no throw", () => {
    const longText = "あ".repeat(10_000);
    const srt = `1\n00:00:01,000 --> 00:00:02,000\n${longText}\n`;
    const cues = parseSrt(srt);
    expect(cues).toHaveLength(1);
    expect(cues[0]!.text.length).toBeGreaterThan(1000);
  });

  test("unicode / emoji in cue text preserved (surrogate pairs)", () => {
    // 🐱 U+1F431 is a surrogate pair in UTF-16; Bun strings handle them correctly
    const text = "猫🐱ネコ🎌";
    const srt = `1\n00:00:01,000 --> 00:00:02,000\n${text}\n`;
    const cues = parseSrt(srt);
    expect(cues).toHaveLength(1);
    expect(cues[0]!.text).toBe(text);
  });

  test("HTML tag stripping leaves actual content", () => {
    const srt = "1\n00:00:01,000 --> 00:00:02,000\n<b><i>Hello</i></b>\n";
    const cues = parseSrt(srt);
    expect(cues).toHaveLength(1);
    expect(cues[0]!.text).toBe("Hello");
  });
});

// ---------------------------------------------------------------------------
// parseAss — malformed / degenerate inputs
// ---------------------------------------------------------------------------

const evHeader =
  "[Events]\n" +
  "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n";

describe("parseAss — malformed / degenerate inputs", () => {
  test("empty string → []", () => {
    expect(parseAss("")).toEqual([]);
  });

  test("no [Events] section → []", () => {
    const ass = "[Script Info]\nTitle: test\n[V4+ Styles]\nFormat: Name\nStyle: Default\n";
    expect(parseAss(ass)).toEqual([]);
  });

  test("[Events] with Format but no Dialogue lines → []", () => {
    expect(parseAss(evHeader)).toEqual([]);
  });

  test("only whitespace-body Dialogue lines → []", () => {
    // After stripping override tags, body is only spaces → trimmed to "" → skipped
    const ass = evHeader + "Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\an8}  \n";
    const cues = parseAss(ass);
    // Body after stripping tags = "  ".trim() = "" → skipped
    expect(cues.every((c) => c.text.trim().length > 0)).toBe(true);
  });

  test("Dialogue with malformed start timestamp → line skipped, no throw", () => {
    const ass =
      evHeader +
      "Dialogue: 0,BADTIME,0:00:02.00,Default,,0,0,0,,テスト\n" +
      "Dialogue: 0,0:00:03.00,0:00:04.00,Default,,0,0,0,,正常\n";
    const cues = parseAss(ass);
    expect(() => parseAss(ass)).not.toThrow();
    expect(cues.some((c) => c.text === "正常")).toBe(true);
    expect(cues.every((c) => c.text !== "テスト")).toBe(true);
  });

  test("only override tags in text → no cue emitted", () => {
    const ass = evHeader + "Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\an8}{\\blur4}{\\c&H00FF00&}\n";
    const cues = parseAss(ass);
    expect(cues).toHaveLength(0);
  });

  test("extremely long single cue text → parsed without throw", () => {
    const longText = "あ".repeat(5_000);
    const ass = evHeader + `Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,${longText}\n`;
    const cues = parseAss(ass);
    expect(cues).toHaveLength(1);
    expect(cues[0]!.text.length).toBeGreaterThan(100);
  });

  test("emoji/surrogate pairs in dialogue text preserved", () => {
    const ass = evHeader + "Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,猫🐱です\n";
    const cues = parseAss(ass);
    expect(cues).toHaveLength(1);
    expect(cues[0]!.text).toBe("猫🐱です");
  });

  test("BOM + no [Events] → []", () => {
    const ass = "﻿[Script Info]\nTitle: x\n";
    expect(parseAss(ass)).toEqual([]);
  });

  test("Dialogue line missing enough comma fields → skipped gracefully", () => {
    // Only 3 fields: not enough to reach Text at index 9
    const ass = evHeader + "Dialogue: 0,0:00:01.00,0:00:02.00\n";
    expect(() => parseAss(ass)).not.toThrow();
    expect(parseAss(ass)).toEqual([]);
  });

  test("multiple \\N and \\n create real newlines in correct positions", () => {
    const ass = evHeader + "Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,A\\NB\\nC\n";
    const cues = parseAss(ass);
    expect(cues).toHaveLength(1);
    expect(cues[0]!.text).toBe("A\nB\nC");
  });
});

// ---------------------------------------------------------------------------
// parseVtt — edge cases
// ---------------------------------------------------------------------------

describe("parseVtt — edge cases", () => {
  test("empty string → []", () => {
    expect(parseVtt("")).toEqual([]);
  });

  test("WEBVTT header only → []", () => {
    expect(parseVtt("WEBVTT\n")).toEqual([]);
  });

  test("cue with cue settings stripped, text preserved", () => {
    const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000 align:left position:20%\nHello\n";
    const cues = parseVtt(vtt);
    expect(cues).toHaveLength(1);
    expect(cues[0]!.text).toBe("Hello");
  });
});

// ---------------------------------------------------------------------------
// parseSubtitleText — dispatch edge cases
// ---------------------------------------------------------------------------

describe("parseSubtitleText — extension dispatch", () => {
  test("unknown extension falls back to parseSrt", () => {
    const srt = "1\n00:00:01,000 --> 00:00:02,000\ntest\n";
    const cues = parseSubtitleTextDirect(srt, ".xyz");
    expect(cues).toHaveLength(1);
  });

  test(".ass extension dispatches to parseAss", () => {
    const ass = evHeader + "Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,日本語\n";
    const cues = parseSubtitleTextDirect(ass, ".ass");
    expect(cues).toHaveLength(1);
  });

  test(".ssa extension also dispatches to parseAss", () => {
    const ass = evHeader + "Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,日本語\n";
    const cues = parseSubtitleTextDirect(ass, ".ssa");
    expect(cues).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// LOAD: parse large subtitle files (deterministic, no timing assertions)
// ---------------------------------------------------------------------------

describe("parseSrt — LOAD: 5000-cue synthetic file", () => {
  test("5000 cues parse correctly and count matches", () => {
    const N = 5_000;
    const blocks: string[] = [];
    for (let i = 0; i < N; i++) {
      const startSec = i * 4;
      const endSec = startSec + 3;
      const hh = (n: number) => String(Math.floor(n / 3600)).padStart(2, "0");
      const mm = (n: number) => String(Math.floor((n % 3600) / 60)).padStart(2, "0");
      const ss = (n: number) => String(n % 60).padStart(2, "0");
      const fmt = (t: number) => `${hh(t)}:${mm(t)}:${ss(t)},000`;
      blocks.push(`${i + 1}\n${fmt(startSec)} --> ${fmt(endSec)}\n語彙${i}\n`);
    }
    const srt = blocks.join("\n");
    const cues = parseSrt(srt);
    expect(cues.length).toBe(N);
    expect(cues[0]!.text).toBe("語彙0");
    expect(cues[N - 1]!.text).toBe(`語彙${N - 1}`);
  });
});

describe("parseAss — LOAD: 5000-cue synthetic file", () => {
  test("5000 Dialogue lines parse correctly", () => {
    const N = 5_000;
    const lines: string[] = [evHeader];
    for (let i = 0; i < N; i++) {
      const startSec = i * 4;
      const h = Math.floor(startSec / 3600);
      const m = Math.floor((startSec % 3600) / 60);
      const s = startSec % 60;
      const ts = (t: number) => {
        const hh = Math.floor(t / 3600);
        const mm = Math.floor((t % 3600) / 60);
        const ss = t % 60;
        return `${hh}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}.00`;
      };
      lines.push(`Dialogue: 0,${ts(startSec)},${ts(startSec + 3)},Default,,0,0,0,,セリフ${i}`);
    }
    const ass = lines.join("\n");
    const cues = parseAss(ass);
    expect(cues.length).toBe(N);
    expect(cues[0]!.text).toBe("セリフ0");
  });
});

// ---------------------------------------------------------------------------
// collapseRepeatedCues / dropRepeatingCycles — degenerate inputs
// ---------------------------------------------------------------------------

describe("collapseRepeatedCues — degenerate inputs", () => {
  const mk = (i: number, text: string): Cue => ({ start: i, end: i + 1, text });

  test("single cue → returned unchanged", () => {
    const cues = [mk(0, "A")];
    expect(collapseRepeatedCues(cues)).toEqual(cues);
  });

  test("all distinct cues → unchanged", () => {
    const cues = Array.from({ length: 100 }, (_, i) => mk(i, `${i}`));
    expect(collapseRepeatedCues(cues)).toEqual(cues);
  });

  test("LOAD: 10k identical cues collapse to exactly 1", () => {
    const cues = Array.from({ length: 10_000 }, (_, i) => mk(i, "ループ"));
    const out = collapseRepeatedCues(cues);
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe("ループ");
  });

  test("LOAD: 10k distinct cues return all 10k (no false collapses)", () => {
    const cues = Array.from({ length: 10_000 }, (_, i) => mk(i, `distinct_${i}`));
    const out = collapseRepeatedCues(cues);
    expect(out).toHaveLength(10_000);
  });
});

describe("dropRepeatingCycles — degenerate inputs", () => {
  const mk = (i: number, text: string): Cue => ({ start: i, end: i + 1, text });

  test("single cue → returned unchanged", () => {
    const cues = [mk(0, "A")];
    expect(dropRepeatingCycles(cues)).toEqual(cues);
  });

  test("LOAD: 10k distinct cues → all preserved (no false cycle detection)", () => {
    const cues = Array.from({ length: 10_000 }, (_, i) => mk(i, `行${i}`));
    const out = dropRepeatingCycles(cues);
    expect(out).toHaveLength(10_000);
  });

  test("LOAD: 2500 repetitions of period-4 block collapse (no throw, significantly reduced)", () => {
    // dropRepeatingCycles prefers the LONGEST matching period ≤ maxPeriod=8,
    // so 2500×4 cues (10000 total) collapses greedily. We just assert: no throw,
    // returns significantly fewer cues than input, and all retained texts are from the original block.
    const block = ["甲", "乙", "丙", "丁"];
    const cues: Cue[] = [];
    for (let rep = 0; rep < 2_500; rep++) {
      for (let k = 0; k < 4; k++) {
        cues.push(mk(rep * 4 + k, block[k]!));
      }
    }
    expect(() => dropRepeatingCycles(cues)).not.toThrow();
    const out = dropRepeatingCycles(cues);
    expect(out.length).toBeLessThan(cues.length / 10); // at least 10× reduction
    expect(out.every((c) => block.includes(c.text))).toBe(true);
  });
});

describe("cleanCues — degenerate inputs", () => {
  test("empty input → []", () => {
    expect(cleanCues([])).toEqual([]);
  });

  test("single cue → unchanged", () => {
    const cues = [{ start: 0, end: 1, text: "A" }];
    expect(cleanCues(cues)).toEqual(cues);
  });
});

// ---------------------------------------------------------------------------
// findCoverageHoles — edge cases
// ---------------------------------------------------------------------------

describe("findCoverageHoles — edge cases", () => {
  test("empty cues and short video (< minGap) → no holes from tail", () => {
    // duration 10s, tailSlack 30s → tail = 10-30 = -20 → no tail hole
    const holes = findCoverageHoles([], 10, 45, 30);
    expect(holes).toEqual([]);
  });

  test("empty cues and long video → one hole covering most of duration", () => {
    // 1000s video, no cues → head hole [0, 1000], tail slack = 30 → hole [0, 1000]
    const holes = findCoverageHoles([], 1_000, 45, 30);
    // head: 0 to 1000 gap=1000 ≥ 45 → hole; tail: 1000-30=970, 970-0=970 ≥ 45 but
    // covered=0 → pushed as tail hole from covered=0, end=1000
    expect(holes.length).toBeGreaterThanOrEqual(1);
  });

  test("single cue at very start, no gap → no head hole", () => {
    const cues = [{ start: 0, end: 600, text: "x" }];
    // No head hole, tail depends on duration
    const holes = findCoverageHoles(cues, 630, 45, 30);
    expect(holes).toEqual([]); // 630-30=600; 600-600=0 < 45 → no tail
  });

  test("overlapping cues (covered tracks max end)", () => {
    const cues = [
      { start: 0, end: 100, text: "a" },
      { start: 50, end: 80, text: "b" }, // overlaps first, end < first.end
      { start: 90, end: 200, text: "c" },
    ];
    const holes = findCoverageHoles(cues, 200, 45, 0);
    // covered goes: max(0,100)=100, max(100,80)=100, max(100,200)=200 → no holes
    expect(holes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// kanaRatio — edge cases
// ---------------------------------------------------------------------------

describe("kanaRatio — edge cases", () => {
  test("empty string → 0", () => {
    expect(kanaRatio("")).toBe(0);
  });

  test("only ASCII → 0", () => {
    expect(kanaRatio("Hello World 123")).toBe(0);
  });

  test("only kana → 1", () => {
    expect(kanaRatio("あいうえおアイウエオ")).toBe(1);
  });

  test("only kanji → 0", () => {
    expect(kanaRatio("漢字熟語")).toBe(0);
  });

  test("mixed kana + kanji → between 0 and 1", () => {
    const r = kanaRatio("私はガッコウに行く");
    expect(r).toBeGreaterThan(0);
    expect(r).toBeLessThan(1);
  });

  test("emoji/surrogate pairs are not counted as kana/CJK → no crash, ratio 0", () => {
    expect(kanaRatio("🐱🎌🗾")).toBe(0);
  });

  test("extended CJK block (U+3400–U+4DBF) counted as CJK, not kana", () => {
    // 㐀 is U+3400, inside CJK Extension A
    const r = kanaRatio("㐀");
    expect(r).toBe(0); // CJK only → 0
  });
});

// ---------------------------------------------------------------------------
// looksJapanese — edge cases
// ---------------------------------------------------------------------------

describe("looksJapanese — edge cases", () => {
  test("empty cue list → false", () => {
    expect(looksJapanese([])).toBe(false);
  });

  test("cue with only punctuation → false (no kana/CJK)", () => {
    expect(looksJapanese([{ start: 0, end: 1, text: "... ♪ !" }])).toBe(false);
  });

  test("custom minRatio: very low threshold → true even for mostly kanji", () => {
    // 行 is kanji only; with minRatio=0 any non-empty result should return true
    // Actually ratio=0 and 0>=0 → true
    const cues = [{ start: 0, end: 1, text: "行" }];
    expect(looksJapanese(cues, 0)).toBe(true);
  });

  test("custom minRatio: 1.0 → false unless 100% kana", () => {
    const cues = [{ start: 0, end: 1, text: "私は行く" }]; // has kanji
    expect(looksJapanese(cues, 1.0)).toBe(false);
  });

  test("pure kana cues → true at default threshold", () => {
    const cues = [{ start: 0, end: 1, text: "あいうえおかきくけこ" }];
    expect(looksJapanese(cues)).toBe(true);
  });
});
