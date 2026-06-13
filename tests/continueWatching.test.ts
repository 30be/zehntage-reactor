import { describe, expect, test } from "bun:test";
import {
  pickContinueWatching,
  MIN_RESUME_SEC,
  type ResumeRecord,
} from "../web/continueWatching.ts";

const rec = (id: string, pos: number, at: number | null): ResumeRecord => ({
  id,
  pos,
  at,
});

describe("pickContinueWatching", () => {
  test("returns nothing when no records", () => {
    expect(pickContinueWatching([])).toEqual([]);
  });

  test("drops positions at/under the threshold", () => {
    const out = pickContinueWatching([
      rec("a", MIN_RESUME_SEC, 1),
      rec("b", MIN_RESUME_SEC - 1, 2),
      rec("c", MIN_RESUME_SEC + 0.5, 3),
    ]);
    expect(out.map((r) => r.id)).toEqual(["c"]);
  });

  test("sorts most-recent first by timestamp", () => {
    const out = pickContinueWatching([
      rec("old", 100, 1000),
      rec("new", 100, 3000),
      rec("mid", 100, 2000),
    ]);
    expect(out.map((r) => r.id)).toEqual(["new", "mid", "old"]);
  });

  test("caps at the limit (default 3)", () => {
    const recs = Array.from({ length: 6 }, (_, i) =>
      rec(String(i), 100, i),
    );
    expect(pickContinueWatching(recs)).toHaveLength(3);
    expect(pickContinueWatching(recs, 2)).toHaveLength(2);
  });

  test("records without a timestamp sort last but stay eligible", () => {
    const out = pickContinueWatching([
      rec("stamped", 100, 5000),
      rec("nostamp", 100, null),
    ]);
    expect(out.map((r) => r.id)).toEqual(["stamped", "nostamp"]);
  });

  test("ignores non-finite positions", () => {
    expect(pickContinueWatching([rec("nan", NaN, 1)])).toEqual([]);
  });

  test("limit of 0 yields nothing", () => {
    expect(pickContinueWatching([rec("a", 100, 1)], 0)).toEqual([]);
  });
});
