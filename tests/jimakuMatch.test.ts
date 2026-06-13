import { describe, expect, test } from "bun:test";
import {
  fileMatchesEpisode,
  normTitle,
  pickConfidentEntry,
  type JimakuEntry,
} from "../src/lib/jimaku.ts";

function entry(over: Partial<JimakuEntry> & { name: string }): JimakuEntry {
  return {
    id: 1,
    english_name: null,
    japanese_name: null,
    anilist_id: null,
    tmdb_id: null,
    flags: {},
    last_modified: "2024-01-01T00:00:00Z",
    ...over,
  };
}

describe("pickConfidentEntry", () => {
  test("clear single match passes", () => {
    const entries = [
      entry({ id: 1, name: "Hyouka", english_name: "Hyouka" }),
      entry({ id: 2, name: "Steins Gate" }),
    ];
    const got = pickConfidentEntry("hyouka", entries);
    expect(got).not.toBeNull();
    expect(got!.entry.id).toBe(1);
    expect(got!.score).toBeGreaterThanOrEqual(0.8);
  });

  test("exact series name beats franchise-sibling containment tie", () => {
    const entries = [
      entry({ id: 1451, name: "Hyouka" }),
      entry({ id: 5815, name: "Hyouka: Motsubeki Mono wa" }),
    ];
    const got = pickConfidentEntry("hyouka", entries);
    expect(got).not.toBeNull();
    expect(got!.entry.id).toBe(1451);
  });

  test("ambiguous close scores with no exact match returns null", () => {
    // Two same-franchise siblings both fully contain the query tokens and
    // NEITHER equals it exactly -> tie, no dominance, >1 over threshold -> null.
    const entries = [
      entry({ id: 1, name: "Fate Stay Night First Season" }),
      entry({ id: 2, name: "Fate Stay Night Unlimited Blade Works" }),
    ];
    expect(pickConfidentEntry("fate stay night", entries)).toBeNull();
  });

  test("low overlap returns null", () => {
    const entries = [
      entry({ id: 1, name: "Steins Gate" }),
      entry({ id: 2, name: "Cowboy Bebop" }),
    ];
    expect(pickConfidentEntry("hyouka", entries)).toBeNull();
  });

  test("adult entries are filtered out", () => {
    const entries = [entry({ id: 1, name: "Hyouka", flags: { adult: true } })];
    expect(pickConfidentEntry("hyouka", entries)).toBeNull();
  });

  test("empty entries returns null", () => {
    expect(pickConfidentEntry("hyouka", [])).toBeNull();
  });

  test("dominant top over weak runner-up passes", () => {
    const entries = [
      entry({ id: 1, name: "Violet Evergarden" }),
      entry({ id: 2, name: "Violet Garden Side Story Extra" }),
    ];
    const got = pickConfidentEntry("violet evergarden", entries);
    expect(got).not.toBeNull();
    expect(got!.entry.id).toBe(1);
    expect(got!.score - got!.runnerUp).toBeGreaterThanOrEqual(0.34);
  });

  test("exact match via english_name beats longer franchise sibling", () => {
    // english_name matches query exactly; id=11 only partially overlaps.
    const entries = [
      entry({ id: 10, name: "Koe no Katachi", english_name: "A Silent Voice" }),
      entry({ id: 11, name: "A Silent Voice The Movie Extended Cut" }),
    ];
    const got = pickConfidentEntry("a silent voice", entries);
    expect(got).not.toBeNull();
    expect(got!.entry.id).toBe(10);
    expect(got!.reason).toContain("exact-name");
  });

  test("exact match via japanese_name picks unique entry", () => {
    const entries = [
      entry({ id: 20, name: "Hyouka", japanese_name: "氷菓" }),
      entry({ id: 21, name: "Hyouka Extra" }),
    ];
    const got = pickConfidentEntry("氷菓", entries);
    expect(got).not.toBeNull();
    expect(got!.entry.id).toBe(20);
  });

  test("two entries sharing the exact same name → both exact → falls to scoring → tie → null", () => {
    // exact.length === 2 → not === 1 → falls through; equal tokenOverlap, gap 0 < 0.34
    // and both >= 0.8 (count > 1) → null.
    const entries = [
      entry({ id: 30, name: "Hyouka" }),
      entry({ id: 31, name: "Hyouka" }),
    ];
    expect(pickConfidentEntry("hyouka", entries)).toBeNull();
  });

  test("single candidate above threshold always passes dominance", () => {
    // No runner-up → the scored.filter(>=0.8).length === 1 branch fires.
    const entries = [entry({ id: 40, name: "Steins Gate" })];
    const got = pickConfidentEntry("steins gate", entries);
    expect(got).not.toBeNull();
    expect(got!.entry.id).toBe(40);
    expect(got!.runnerUp).toBe(0);
  });
});

describe("normTitle", () => {
  test("strips punctuation and lowercases", () => {
    expect(normTitle("Re:ZERO -Starting Life-")).toBe("re zero starting life");
  });
  test("keeps kana/kanji", () => {
    expect(normTitle("氷菓")).toBe("氷菓");
  });
  test("strips interpunct (・) and inserts space, keeps surrounding kana", () => {
    // ・ is not \p{Letter} nor \p{Number}, so it becomes a space separator.
    expect(normTitle("ソードアート・オンライン")).toBe("ソードアート オンライン");
  });
  test("collapses runs of multiple spaces", () => {
    expect(normTitle("foo   bar")).toBe("foo bar");
  });
  test("preserves digits alongside latin", () => {
    expect(normTitle("Season 2: Part 1")).toBe("season 2 part 1");
  });
  test("empty string returns empty", () => {
    expect(normTitle("")).toBe("");
  });
  test("only punctuation returns empty string", () => {
    expect(normTitle("---!!!---")).toBe("");
  });
  test("trims leading/trailing whitespace", () => {
    expect(normTitle("  hyouka  ")).toBe("hyouka");
  });
});

describe("fileMatchesEpisode", () => {
  test("matches episode in remote file name", () => {
    expect(fileMatchesEpisode("Hyouka - 05.srt", 5)).toBe(true);
  });
  test("rejects mismatched episode", () => {
    expect(fileMatchesEpisode("Hyouka - 05.srt", 6)).toBe(false);
  });
  test("matches E-prefixed episode", () => {
    expect(fileMatchesEpisode("[Sub] Hyouka E12 [1080p].ass", 12)).toBe(true);
  });
  test("matches zero-padded dash-separated episode", () => {
    expect(fileMatchesEpisode("Hyouka-03.srt", 3)).toBe(true);
  });
  test("rejects file with no episode number (guessEpisode → null)", () => {
    expect(fileMatchesEpisode("Hyouka [BDrip].srt", 1)).toBe(false);
  });
  test("matches 第N話 style episode", () => {
    expect(fileMatchesEpisode("氷菓 第7話.srt", 7)).toBe(true);
  });
  test("mismatch on 第N話 style", () => {
    expect(fileMatchesEpisode("氷菓 第7話.srt", 8)).toBe(false);
  });
  test("matches space-separated episode number at tail", () => {
    expect(fileMatchesEpisode("Hyouka 11.srt", 11)).toBe(true);
  });
});
