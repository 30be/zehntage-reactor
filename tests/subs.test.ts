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
  collapseRepeatedCues,
  dropRepeatingCycles,
  cleanCues,
  findCoverageHoles,
  kanaRatio,
  looksJapanese,
  JAPANESE_KANA_MIN,
  type SubTrack,
} from "../src/lib/subs.ts";
import { repairHole } from "../src/lib/whisper.ts";

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

describe("collapseRepeatedCues", () => {
  const cue = (start: number, end: number, text: string) => ({ start, end, text });

  test("collapses runs of >=4 identical cues into one spanning cue", () => {
    const cues = [
      cue(0, 2, "こんにちは"),
      cue(2, 4, "おれきほうたろお殿"),
      cue(4, 6, "おれきほうたろお殿。"),
      cue(6, 8, " おれきほうたろお殿 "),
      cue(8, 10, "おれきほうたろお殿!"),
      cue(10, 12, "次の台詞"),
    ];
    const out = collapseRepeatedCues(cues);
    // run collapses to its FIRST cue only (duration-capped) — the rest of the
    // loop's span is left uncovered so hole detection can kick in.
    expect(out).toEqual([
      cue(0, 2, "こんにちは"),
      cue(2, 4, "おれきほうたろお殿"),
      cue(10, 12, "次の台詞"),
    ]);
  });

  test("keeps runs of 2 untouched", () => {
    const cues = [cue(0, 1, "はい"), cue(1, 2, "はい"), cue(2, 3, "いいえ")];
    expect(collapseRepeatedCues(cues)).toEqual(cues);
  });

  test("keeps a legit short 3-run (待って x3) untouched", () => {
    const cues = [
      cue(0, 1, "待って"),
      cue(1, 2, "待って！"),
      cue(2, 3, "待って"),
      cue(3, 5, "ほうたろう"),
    ];
    expect(collapseRepeatedCues(cues)).toEqual(cues);
  });

  test("collapses a 3-run spanning more than 20s (hallucination)", () => {
    const cues = [
      cue(0, 8, "ご視聴ありがとうございました"),
      cue(8, 16, "ご視聴ありがとうございました"),
      cue(16, 25, "ご視聴ありがとうございました"),
      cue(25, 27, "次の台詞"),
    ];
    expect(collapseRepeatedCues(cues)).toEqual([
      cue(0, 8, "ご視聴ありがとうございました"),
      cue(25, 27, "次の台詞"),
    ]);
  });

  test("punctuation-only cues never merge with each other", () => {
    const cues = [cue(0, 1, "…"), cue(1, 2, "。。"), cue(2, 3, "…")];
    expect(collapseRepeatedCues(cues)).toEqual(cues);
  });

  test("empty input and idempotency", () => {
    expect(collapseRepeatedCues([])).toEqual([]);
    const cues = Array.from({ length: 10 }, (_, i) => cue(i, i + 1, "ループ"));
    const once = collapseRepeatedCues(cues);
    expect(once).toEqual([cue(0, 1, "ループ")]);
    expect(collapseRepeatedCues(once)).toEqual(once);
  });
});

describe("collapseRepeatedCues hallucination handling", () => {
  const mk = (start: number, end: number, text: string) => ({ start, end, text });
  test("near-duplicate loop (punctuation/substring drift) collapses to one capped cue", () => {
    const cues = [
      mk(0, 2, "おれきほうたろお殿"),
      mk(2, 4, "おれきほうたろお 殿"),
      mk(4, 6, "おれきほうたろお"),
      mk(6, 300, "おれきほうたろお殿。"),
      mk(300, 302, "本物のセリフ"),
    ];
    const out = collapseRepeatedCues(cues);
    expect(out).toHaveLength(2);
    expect(out[0]!.text).toBe("おれきほうたろお殿");
    // capped: must NOT span the whole loop and hide the coverage hole
    expect(out[0]!.end).toBeLessThanOrEqual(10);
    expect(out[1]!.text).toBe("本物のセリフ");
  });
  test("legit short repeats survive", () => {
    const cues = [mk(0, 1, "待って！"), mk(1, 2, "待って！"), mk(2, 3, "待って！")];
    expect(collapseRepeatedCues(cues)).toHaveLength(3);
  });
  test("musical-note loop collapses", () => {
    const cues = [mk(0, 5, "♪~"), mk(5, 10, "♪~"), mk(10, 15, "♪"), mk(15, 60, "♪~")];
    const out = collapseRepeatedCues(cues);
    expect(out).toHaveLength(1);
    expect(out[0]!.end).toBeLessThanOrEqual(10);
  });
});

describe("dropRepeatingCycles", () => {
  const c = (start: number, end: number, text: string) => ({ start, end, text });
  const texts = (cues: { text: string }[]) => cues.map((x) => x.text);

  test("empty input", () => {
    expect(dropRepeatingCycles([])).toEqual([]);
    expect(cleanCues([])).toEqual([]);
  });

  test("period-1 cycle below singleMinReps is left for collapseRepeatedCues", () => {
    // Two consecutive identical cues — dropRepeatingCycles must NOT touch it.
    const cues = [c(0, 1, "はい"), c(1, 2, "はい"), c(2, 3, "いいえ")];
    expect(dropRepeatingCycles(cues)).toEqual(cues);
  });

  test("period-1 cycle collapses via the full cleanCues pipeline", () => {
    // A single line looping is handled by collapseRepeatedCues (run length /
    // span heuristics); cleanCues chains it before the cycle pass.
    const cues = [
      c(0, 1, "ループ"),
      c(1, 2, "ループ"),
      c(2, 3, "ループ"),
      c(3, 4, "ループ"),
      c(4, 5, "ループ"),
      c(5, 6, "本物"),
    ];
    expect(texts(cleanCues(cues))).toEqual(["ループ", "本物"]);
  });

  test("period-2 cycle: keep first block, drop the repeat", () => {
    const cues = [
      c(0, 2, "A1"),
      c(2, 4, "B1"),
      c(4, 6, "A1"),
      c(6, 8, "B1"),
      c(8, 10, "次"),
    ];
    expect(texts(dropRepeatingCycles(cues))).toEqual(["A1", "B1", "次"]);
    // timestamps of kept cues preserved (no fabricated timings)
    const out = dropRepeatingCycles(cues);
    expect(out[0]).toEqual(c(0, 2, "A1"));
    expect(out[1]).toEqual(c(2, 4, "B1"));
    expect(out[2]).toEqual(c(8, 10, "次"));
  });

  test("period-3 cycle repeating twice collapses to one block", () => {
    const block = ["甲", "乙", "丙"];
    const cues = [...block, ...block].map((t, i) => c(i, i + 1, t));
    cues.push(c(99, 100, "終"));
    expect(texts(dropRepeatingCycles(cues))).toEqual(["甲", "乙", "丙", "終"]);
  });

  test("period-4 cycle prefers the long period over a coincidental sub-period", () => {
    const block = ["a", "b", "c", "d"];
    const cues = [...block, ...block, ...block].map((t, i) => c(i, i + 1, t));
    expect(texts(dropRepeatingCycles(cues))).toEqual(block);
  });

  test("partial trailing repeat is dropped, real divergence kept", () => {
    const block = ["一行目", "二行目", "三行目"];
    const cues = [
      ...block, // first (kept)
      ...block, // full repeat (dropped)
      "一行目", // partial trailing repeat (dropped)
      "二行目", // partial trailing repeat (dropped)
      "本物の続き", // divergence at this cycle position -> kept
    ].map((t, i) => c(i, i + 1, t));
    expect(texts(dropRepeatingCycles(cues))).toEqual(["一行目", "二行目", "三行目", "本物の続き"]);
  });

  test("LEGIT two-cue exchange occurring once is preserved", () => {
    const cues = [c(0, 1, "おはよう"), c(1, 2, "おはようございます"), c(2, 3, "いってきます")];
    expect(dropRepeatingCycles(cues)).toEqual(cues);
  });

  test("LEGIT genuine repeat (はい/はい once) preserved", () => {
    const cues = [c(0, 1, "はい"), c(1, 2, "はい")];
    expect(dropRepeatingCycles(cues)).toEqual(cues);
  });

  test("ep02 hole-repair loop: only the real letter (once) + continuation survive", () => {
    const cues = [
      // leading single-line hallucination preamble
      c(0.0, 2.0, "おれきほうたろお殿"),
      c(2.6, 5.58, "全略 私は今を見つけます"),
      c(5.6, 7.6, "おれきほうたろお殿"),
      // real letter, first reading (KEEP)
      c(7.6, 9.6, "おれきほうたろうどの。"),
      c(9.6, 11.6, "全略。私は今、ヴェナレスにいます。"),
      c(11.6, 13.6, "ちょっと遅れたけど、合格おめでとう。"),
      c(13.6, 15.6, "結局、神山高校だったんですよ。"),
      // full repeat (DROP)
      c(15.6, 17.6, "おれきほうたろうどの。"),
      c(17.6, 19.6, "全略。私は今、ヴェナレスにいます。"),
      c(19.6, 21.6, "ちょっと遅れたけど、合格おめでとう。"),
      c(21.6, 23.6, "結局、神山高校だったんですよ。"),
      // partial 3rd repeat (DROP)
      c(23.6, 25.6, "おれきほうたろうどの。"),
      c(25.6, 27.6, "全略。私は今、ヴェナレスにいます。"),
      // real continuation diverges here (KEEP)
      c(27.6, 29.6, "結局上山高校だってね"),
    ];
    const out = cleanCues(cues);
    expect(texts(out)).toEqual([
      "おれきほうたろうどの。",
      "全略。私は今、ヴェナレスにいます。",
      "ちょっと遅れたけど、合格おめでとう。",
      "結局、神山高校だったんですよ。",
      "結局上山高校だってね",
    ]);
    // kept cues keep their original timestamps
    expect(out[0]!.start).toBeCloseTo(7.6);
    expect(out[4]!).toEqual(c(27.6, 29.6, "結局上山高校だってね"));
  });

  test("cleanCues is idempotent on the ep02 pattern", () => {
    const cues = [
      c(0, 2, "おれきほうたろお殿"),
      c(2, 4, "全略 私は今を見つけます"),
      c(4, 6, "おれきほうたろお殿"),
      c(6, 8, "おれきほうたろうどの。"),
      c(8, 10, "全略。私は今、ヴェナレスにいます。"),
      c(10, 12, "ちょっと遅れたけど、合格おめでとう。"),
      c(12, 14, "結局、神山高校だったんですよ。"),
      c(14, 16, "おれきほうたろうどの。"),
      c(16, 18, "全略。私は今、ヴェナレスにいます。"),
      c(18, 20, "ちょっと遅れたけど、合格おめでとう。"),
      c(20, 22, "結局、神山高校だったんですよ。"),
      c(22, 24, "結局上山高校だってね"),
    ];
    const once = cleanCues(cues);
    expect(cleanCues(once)).toEqual(once);
  });

  test("no leading-preamble false positive: distinct line before a loop is kept", () => {
    const cues = [
      c(0, 2, "全然違う台詞です"), // unrelated, must survive
      c(2, 4, "letterA"),
      c(4, 6, "letterB"),
      c(6, 8, "letterA"),
      c(8, 10, "letterB"),
      c(10, 12, "次へ"),
    ];
    expect(texts(dropRepeatingCycles(cues))).toEqual(["全然違う台詞です", "letterA", "letterB", "次へ"]);
  });
});

describe("repairHole", () => {
  const c = (start: number, end: number, text: string) => ({ start, end, text });
  const texts = (cues: { text: string }[]) => cues.map((x) => x.text);

  test("clips repair to the hole window", () => {
    const repair = [c(0, 5, "前の残響"), c(48, 52, "穴の中身"), c(120, 125, "後ろの残響")];
    const out = repairHole(repair, { start: 50, end: 100 });
    expect(texts(out)).toEqual(["穴の中身"]);
  });

  test("dedups a looping repair so it cannot emit duplicate cycles", () => {
    // Repair itself loops a 2-line block; window comfortably fits one pass.
    const repair = [
      c(50, 53, "甲の台詞"),
      c(53, 56, "乙の台詞"),
      c(56, 59, "甲の台詞"),
      c(59, 62, "乙の台詞"),
    ];
    const out = repairHole(repair, { start: 50, end: 100 });
    expect(texts(out)).toEqual(["甲の台詞", "乙の台詞"]);
  });

  test("caps a runaway loop to ~hole length, dropping the overflow tail", () => {
    // 10s hole; repair loops far past 1.5× (15s) with distinct-enough drifting
    // lines that survive dedup. Should keep only the first hole-length worth.
    const repair = Array.from({ length: 30 }, (_, i) =>
      c(50 + i, 51 + i, `セリフ番号${i}`),
    );
    const out = repairHole(repair, { start: 50, end: 60 });
    const span = out[out.length - 1]!.end - out[0]!.start;
    expect(span).toBeLessThanOrEqual(10 * 1.5);
    // kept cues retain original timestamps (no fabrication)
    expect(out[0]!.start).toBe(50);
    expect(out.every((x) => repair.some((r) => r.start === x.start && r.end === x.end))).toBe(true);
  });

  test("content within ~hole length is returned untouched", () => {
    const repair = [c(50, 52, "一"), c(52, 54, "二"), c(54, 56, "三")];
    const out = repairHole(repair, { start: 50, end: 60 });
    expect(texts(out)).toEqual(["一", "二", "三"]);
  });

  test("empty repair returns empty", () => {
    expect(repairHole([], { start: 0, end: 50 })).toEqual([]);
  });
});

describe("findCoverageHoles", () => {
  const mk = (start: number, end: number) => ({ start, end, text: "x" });
  test("detects head, middle and tail holes", () => {
    const cues = [mk(100, 105), mk(106, 110), mk(400, 405)];
    const holes = findCoverageHoles(cues, 1000);
    expect(holes).toEqual([
      { start: 0, end: 100 },
      { start: 110, end: 400 },
      { start: 405, end: 1000 },
    ]);
  });
  test("no holes for dense coverage with credit slack", () => {
    const cues = [mk(0, 500), mk(500, 960)];
    expect(findCoverageHoles(cues, 1000)).toEqual([]);
  });
  test("gaps under threshold ignored", () => {
    const cues = [mk(0, 100), mk(140, 990)];
    expect(findCoverageHoles(cues, 1000)).toEqual([]);
  });
});

describe("kanaRatio / looksJapanese", () => {
  const cue = (text: string) => ({ start: 0, end: 1, text });

  test("Japanese dialogue → high ratio, looksJapanese true", () => {
    const jp = "わたしは奉太郎です。今日は学校に行きました。";
    expect(kanaRatio(jp)).toBeGreaterThan(0.3);
    expect(looksJapanese([cue(jp)])).toBe(true);
  });

  test("Chinese hanzi-only → ~0 ratio, looksJapanese false", () => {
    const zh = "我是折木奉太郎，今天去了学校。";
    expect(kanaRatio(zh)).toBe(0);
    expect(looksJapanese([cue(zh)])).toBe(false);
  });

  test("mixed: mostly Chinese with stray katakana sign stays below threshold", () => {
    const cues = [
      cue("第一集 我们一起走吧 这是非常重要的事情"),
      cue("我是侦探 这就是整个案件的真相所在 你听明白了吗"),
      cue("如果我们不快点行动 那么所有的努力都将白费"),
      cue("ロゴ"), // a lone katakana sign amid a wall of hanzi
    ];
    expect(kanaRatio(cues.map((c) => c.text).join("\n"))).toBeLessThan(JAPANESE_KANA_MIN);
    expect(looksJapanese(cues)).toBe(false);
  });

  test("no kana/CJK at all → ratio 0, false", () => {
    expect(kanaRatio("Hello World 123")).toBe(0);
    expect(looksJapanese([cue("Hello World")])).toBe(false);
  });

  test("empty cue list → false", () => {
    expect(looksJapanese([])).toBe(false);
  });
});

describe("parseAss dual-language (Kamigami JP+CN) selection", () => {
  const stylesHeader =
    "[Script Info]\n" +
    "[V4+ Styles]\n" +
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n" +
    "Style: JP,Source Han Sans,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,1,2,10,10,10,1\n" +
    "Style: CN,Source Han Sans,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,1,2,10,10,10,1\n" +
    "[Events]\n" +
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n";

  test("style-based: keeps JP lines, drops overlapping CN lines, count = JP count", () => {
    const ass =
      stylesHeader +
      "Dialogue: 0,0:00:01.00,0:00:03.00,JP,,0,0,0,,おはようございます\n" +
      "Dialogue: 0,0:00:01.00,0:00:03.00,CN,,0,0,0,,早上好\n" +
      "Dialogue: 0,0:00:04.00,0:00:06.00,JP,,0,0,0,,気になります！\n" +
      "Dialogue: 0,0:00:04.00,0:00:06.00,CN,,0,0,0,,我很在意\n" +
      "Dialogue: 0,0:00:07.00,0:00:09.00,JP,,0,0,0,,わたし気になります\n" +
      "Dialogue: 0,0:00:07.00,0:00:09.00,CN,,0,0,0,,我很好奇\n";
    const cues = parseAss(ass);
    expect(cues).toHaveLength(3);
    expect(cues.map((c) => c.text)).toEqual([
      "おはようございます",
      "気になります！",
      "わたし気になります",
    ]);
    // none of the Chinese hanzi-only lines survive
    expect(cues.some((c) => c.text === "早上好")).toBe(false);
    expect(looksJapanese(cues)).toBe(true);
  });

  test("style-based dual keeps a JP kanji-only sign (JP style) too", () => {
    const ass =
      stylesHeader +
      "Dialogue: 0,0:00:01.00,0:00:03.00,JP,,0,0,0,,古典部\n" + // kanji-only JP sign
      "Dialogue: 0,0:00:04.00,0:00:06.00,JP,,0,0,0,,おはよう\n" +
      "Dialogue: 0,0:00:04.00,0:00:06.00,CN,,0,0,0,,早上好\n";
    const cues = parseAss(ass);
    expect(cues.map((c) => c.text)).toEqual(["古典部", "おはよう"]);
  });

  test("kana fallback: unnamed styles, overlapping JP/CN pairs → CN dropped", () => {
    const header =
      "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n";
    const ass =
      header +
      "Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,おはようございます\n" +
      "Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,早上好\n" +
      "Dialogue: 0,0:00:04.00,0:00:06.00,Default,,0,0,0,,気になります\n" +
      "Dialogue: 0,0:00:04.00,0:00:06.00,Default,,0,0,0,,我很在意\n";
    const cues = parseAss(ass);
    expect(cues.map((c) => c.text)).toEqual(["おはようございます", "気になります"]);
    expect(looksJapanese(cues)).toBe(true);
  });

  test("kana fallback keeps a kanji-only JP line with NO overlapping CN counterpart", () => {
    const header =
      "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n";
    const ass =
      header +
      "Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,おはよう\n" +
      "Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,早上好\n" + // overlaps JP → drop
      "Dialogue: 0,0:00:10.00,0:00:12.00,Default,,0,0,0,,古典部\n"; // lone kanji-only sign → keep
    const cues = parseAss(ass);
    expect(cues.map((c) => c.text)).toEqual(["おはよう", "古典部"]);
  });

  test("pure-Japanese ass keeps all lines", () => {
    const ass =
      stylesHeader +
      "Dialogue: 0,0:00:01.00,0:00:03.00,JP,,0,0,0,,おはようございます\n" +
      "Dialogue: 0,0:00:04.00,0:00:06.00,JP,,0,0,0,,気になります\n" +
      "Dialogue: 0,0:00:07.00,0:00:09.00,JP,,0,0,0,,古典部へようこそ\n";
    const cues = parseAss(ass);
    expect(cues).toHaveLength(3);
    expect(looksJapanese(cues)).toBe(true);
  });

  test("pure-Chinese ass yields no kana → looksJapanese false", () => {
    const ass =
      "[V4+ Styles]\n" +
      "Format: Name, Fontname\n" +
      "Style: CN,Source Han Sans\n" +
      "[Events]\n" +
      "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n" +
      "Dialogue: 0,0:00:01.00,0:00:03.00,CN,,0,0,0,,早上好\n" +
      "Dialogue: 0,0:00:04.00,0:00:06.00,CN,,0,0,0,,我很在意\n";
    const cues = parseAss(ass);
    expect(looksJapanese(cues)).toBe(false);
  });
});

describe("parseAss drops vector-drawing/sign lines", () => {
  const header =
    "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n";

  test("\\p1 drawing dialogue is skipped, real dialogue kept", () => {
    const ass =
      header +
      "Dialogue: 0,0:00:01.00,0:00:02.00,Sign,,0,0,0,,{\\p1}m 0 0 l 100 0 100 100 0 100{\\p0}\n" +
      "Dialogue: 0,0:00:03.00,0:00:04.00,Default,,0,0,0,,こんにちは\n";
    const cues = parseAss(ass);
    expect(cues).toHaveLength(1);
    expect(cues[0]!.text).toBe("こんにちは");
  });
});
