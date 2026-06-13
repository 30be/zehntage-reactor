import { describe, expect, test } from "bun:test";
import { jimakuQueryFromName } from "../src/server/index.ts";

describe("jimakuQueryFromName", () => {
  test("strips space-separated trailing episode number", () => {
    expect(
      jimakuQueryFromName("Hyouka 02 [BDrip 852x480 x264 Vorbis].mkv"),
    ).toBe("Hyouka");
  });

  test("keeps dash-separated behavior", () => {
    expect(jimakuQueryFromName("Hyouka - 02 [BDrip x264].mkv")).toBe("Hyouka");
  });

  test("does not nuke numeric-only titles", () => {
    expect(jimakuQueryFromName("86 [BDrip x264].mkv")).toBe("86");
  });

  test("keeps numeric word that is part of the title", () => {
    expect(jimakuQueryFromName("Mob Psycho 100 [BDrip].mkv")).toBe(
      "Mob Psycho 100",
    );
  });

  test("strips space-separated episode with version suffix", () => {
    expect(jimakuQueryFromName("Hyouka 02v2 [BDrip].mkv")).toBe("Hyouka");
  });
});
