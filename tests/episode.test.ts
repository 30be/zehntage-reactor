import { describe, expect, test } from "bun:test";
import { guessEpisode } from "../src/lib/episode.ts";

describe("guessEpisode", () => {
  test("Hyouka with bracketed release tags", () => {
    expect(guessEpisode("Hyouka 07 [BDrip 1080p x265 10bit].mkv")).toBe(7);
  });

  test("zero-padded number at end of name", () => {
    expect(guessEpisode("Hyouka.01.mkv")).toBe(1);
    expect(guessEpisode("Hyouka 022.mkv")).toBe(22);
  });

  test("Episode / E / EP / ep prefixes", () => {
    expect(guessEpisode("Episode 12.mkv")).toBe(12);
    expect(guessEpisode("Show E03.mkv")).toBe(3);
    expect(guessEpisode("Show ep5.mkv")).toBe(5);
    expect(guessEpisode("Show EP 11.mkv")).toBe(11);
  });

  test("Japanese 第N counter", () => {
    expect(guessEpisode("氷菓 第8話.mkv")).toBe(8);
  });

  test("version suffix tolerated", () => {
    expect(guessEpisode("Hyouka 07v2.mkv")).toBe(7);
  });

  test("strips resolution/codec noise, not the episode", () => {
    expect(guessEpisode("Hyouka 1080p 10bit x264 04.mkv")).toBe(4);
  });

  test("no episode present -> null", () => {
    expect(guessEpisode("Hyouka [BDrip].mkv")).toBeNull();
    expect(guessEpisode("readme.txt")).toBeNull();
  });
});
