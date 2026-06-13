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
});

describe("normTitle", () => {
  test("strips punctuation and lowercases", () => {
    expect(normTitle("Re:ZERO -Starting Life-")).toBe("re zero starting life");
  });
  test("keeps kana/kanji", () => {
    expect(normTitle("氷菓")).toBe("氷菓");
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
});
