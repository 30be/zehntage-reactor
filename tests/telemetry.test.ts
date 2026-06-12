import { describe, expect, test } from "bun:test";
import { summarizeEvents, type TelemetryEvent } from "../src/lib/telemetry.ts";

const DAY = new Date(2026, 5, 10, 12, 0, 0).getTime(); // local noon

function hb(ts: number, mediaId: string, position: number, paused = false): TelemetryEvent {
  return { ts, type: "heartbeat", mediaId, position, paused };
}

describe("summarizeEvents", () => {
  test("empty log → empty summary", () => {
    expect(summarizeEvents([])).toEqual({ days: [], media: [] });
  });

  test("heartbeats split playing/paused wall time and estimate content time", () => {
    const ev = [
      hb(DAY, "m1", 10),
      hb(DAY + 15_000, "m1", 25), // +15s content
      hb(DAY + 30_000, "m1", 40), // +15s content
      hb(DAY + 45_000, "m1", 40, true), // paused
      hb(DAY + 60_000, "m1", 500), // seek: delta 460 > 60 → no content
    ];
    const s = summarizeEvents(ev);
    expect(s.days).toHaveLength(1);
    const d = s.days[0]!;
    expect(d.playSec).toBe(4 * 15);
    expect(d.pauseSec).toBe(15);
    expect(d.mediaCount).toBe(1);
    const m = s.media[0]!;
    expect(m.mediaId).toBe("m1");
    expect(m.wallSec).toBe(4 * 15);
    expect(m.contentSec).toBe(30);
  });

  test("anki_add and lookup counted per day and per media", () => {
    const ev: TelemetryEvent[] = [
      { ts: DAY, type: "anki_add", mediaId: "m1" },
      { ts: DAY + 1000, type: "lookup", mediaId: "m1" },
      { ts: DAY + 2000, type: "lookup" }, // no media — day-only
      hb(DAY + 3000, "m1", 5),
    ];
    const s = summarizeEvents(ev);
    expect(s.days[0]!.ankiAdds).toBe(1);
    expect(s.days[0]!.lookups).toBe(2);
    expect(s.media[0]!.ankiAdds).toBe(1);
    expect(s.media[0]!.lookups).toBe(1);
  });

  test("days are sorted and split across midnights", () => {
    const day2 = DAY + 24 * 3600 * 1000;
    const s = summarizeEvents([hb(day2, "m1", 1), hb(DAY, "m1", 0)]);
    expect(s.days).toHaveLength(2);
    expect(s.days[0]!.date < s.days[1]!.date).toBe(true);
  });

  test("unknown event types are ignored in aggregates", () => {
    const s = summarizeEvents([{ ts: DAY, type: "route_change", route: "stats" }]);
    expect(s.days[0]!.playSec).toBe(0);
    expect(s.media).toEqual([]);
  });
});
