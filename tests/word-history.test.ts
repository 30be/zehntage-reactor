import { describe, expect, test } from "bun:test";
import { wordHistory, type TelemetryEvent } from "../src/lib/telemetry.ts";

const T0 = new Date(2026, 5, 10, 12, 0, 0).getTime();

function ev(
  type: string,
  word: string,
  dt: number,
  mediaId?: string,
): TelemetryEvent {
  return { ts: T0 + dt, type, word, ...(mediaId ? { mediaId } : {}) };
}

describe("wordHistory", () => {
  test("empty log → no history, zero lookups", () => {
    expect(wordHistory([], ["食べる"])).toEqual({ lookups: 0 });
  });

  test("unknown lemma → no history", () => {
    const events = [ev("lookup", "走る", 0), ev("anki_add", "走る", 1000)];
    expect(wordHistory(events, ["食べる"])).toEqual({ lookups: 0 });
  });

  test("counts lookups for matching word", () => {
    const events = [
      ev("lookup", "食べる", 0),
      ev("lookup", "食べる", 1000),
      ev("lookup", "走る", 2000), // other word
      ev("heartbeat", "食べる", 3000), // wrong type
    ];
    const h = wordHistory(events, ["食べる"]);
    expect(h.lookups).toBe(2);
    expect(h.addedAt).toBeUndefined();
  });

  test("picks earliest anki_add as addedAt", () => {
    const events = [
      ev("anki_add", "食べる", 5000),
      ev("anki_add", "食べる", 2000), // earlier
      ev("anki_add", "食べる", 9000),
    ];
    const h = wordHistory(events, ["食べる"]);
    expect(h.addedAt).toBe(T0 + 2000);
  });

  test("firstSeenAt is the earliest interaction of any type, with its mediaId", () => {
    const events = [
      ev("anki_add", "食べる", 5000, "ep2"),
      ev("lookup", "食べる", 1000, "ep1"), // earliest
      ev("lookup", "食べる", 8000, "ep3"),
    ];
    const h = wordHistory(events, ["食べる"]);
    expect(h.firstSeenAt).toBe(T0 + 1000);
    expect(h.firstSeenMediaId).toBe("ep1");
    expect(h.lookups).toBe(2);
    expect(h.addedAt).toBe(T0 + 5000);
  });

  test("matches any of the provided forms (lemma + surface)", () => {
    const events = [
      ev("lookup", "食べ", 0), // surface
      ev("anki_add", "食べる", 1000), // lemma
    ];
    const h = wordHistory(events, ["食べる", "食べ"]);
    expect(h.lookups).toBe(1);
    expect(h.addedAt).toBe(T0 + 1000);
    expect(h.firstSeenAt).toBe(T0);
  });

  test("blank forms are ignored", () => {
    const events = [ev("lookup", "", 0), ev("lookup", "食べる", 1000)];
    const h = wordHistory(events, ["", "  ", "食べる"]);
    expect(h.lookups).toBe(1);
  });
});
