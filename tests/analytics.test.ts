import { describe, expect, test } from "bun:test";
import {
  episodeSeries,
  overview,
  toCsv,
  type TelemetryEvent,
} from "../src/lib/telemetry.ts";

const DAY = new Date(2026, 5, 10, 12, 0, 0).getTime(); // local noon
const DAY2 = DAY + 24 * 3600 * 1000;

function hb(ts: number, mediaId: string, position: number, paused = false): TelemetryEvent {
  return { ts, type: "heartbeat", mediaId, position, paused };
}

/** n playing heartbeats every 15s, position advancing 15s/beat. */
function watch(ts: number, mediaId: string, n: number, pos0 = 0): TelemetryEvent[] {
  return Array.from({ length: n }, (_, i) =>
    hb(ts + i * 15_000, mediaId, pos0 + i * 15),
  );
}

describe("episodeSeries", () => {
  test("empty → empty", () => {
    expect(episodeSeries([])).toEqual([]);
  });

  test("wall playing/paused split and content deltas per (media, day)", () => {
    const ev = [
      ...watch(DAY, "m1", 5), // 75s playing, 60s content (4 deltas)
      hb(DAY + 5 * 15_000, "m1", 60, true), // paused beat, no pos advance
      hb(DAY + 6 * 15_000, "m1", 500), // seek > 60 → no content
    ];
    const rows = episodeSeries(ev);
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.mediaId).toBe("m1");
    expect(r.wallPlayingSec).toBe(6 * 15);
    expect(r.wallPausedSec).toBe(15);
    expect(r.contentSec).toBe(60);
    // coefficient = wall total / content = 105/60
    expect(r.coefficient).toBeCloseTo(105 / 60, 5);
  });

  test("coefficient null when contentSec < 60", () => {
    const rows = episodeSeries(watch(DAY, "m1", 3)); // 30s content
    expect(rows[0]!.contentSec).toBe(30);
    expect(rows[0]!.coefficient).toBeNull();
  });

  test("lookups, ankiAdds, cardsPerMin", () => {
    const ev: TelemetryEvent[] = [
      ...watch(DAY, "m1", 8), // 120s playing = 2 min
      { ts: DAY + 1000, type: "anki_add", mediaId: "m1" },
      { ts: DAY + 2000, type: "anki_add", mediaId: "m1" },
      { ts: DAY + 2000, type: "anki_add", mediaId: "m1" },
      { ts: DAY + 3000, type: "lookup", mediaId: "m1" },
      { ts: DAY + 4000, type: "anki_add" }, // no media → not in series
    ];
    const r = episodeSeries(ev)[0]!;
    expect(r.ankiAdds).toBe(3);
    expect(r.lookups).toBe(1);
    expect(r.cardsPerMin).toBeCloseTo(3 / 2, 5);
  });

  test("cardsPerMin null with zero playing time", () => {
    const r = episodeSeries([{ ts: DAY, type: "anki_add", mediaId: "m1" }])[0]!;
    expect(r.cardsPerMin).toBeNull();
  });

  test("rows split per (mediaId, day) and are sorted", () => {
    const ev = [
      ...watch(DAY2, "m2", 2),
      ...watch(DAY2, "m1", 2, 100),
      ...watch(DAY, "m1", 2),
    ];
    const rows = episodeSeries(ev);
    expect(rows.map((r) => `${r.date}/${r.mediaId}`)).toEqual([
      "2026-06-10/m1",
      "2026-06-11/m1",
      "2026-06-11/m2",
    ]);
  });
});

describe("overview", () => {
  test("totals, 30-day window, cumulative anki curve", () => {
    const ev: TelemetryEvent[] = [
      ...watch(DAY, "m1", 5),
      ...watch(DAY2, "m2", 3),
      { ts: DAY, type: "anki_add", mediaId: "m1" },
      { ts: DAY2, type: "anki_add", mediaId: "m2" },
      { ts: DAY2 + 1, type: "anki_add", mediaId: "m2" },
      { ts: DAY2, type: "lookup", mediaId: "m2" },
    ];
    const o = overview(ev);
    expect(o.totals.wallPlayingSec).toBe(8 * 15);
    expect(o.totals.ankiAdds).toBe(3);
    expect(o.totals.lookups).toBe(1);
    expect(o.totals.mediaCount).toBe(2);
    expect(o.last30Days).toHaveLength(30);
    // window anchored on last event day
    expect(o.last30Days[29]!.date).toBe("2026-06-11");
    expect(o.last30Days[29]!.ankiAdds).toBe(2);
    expect(o.last30Days[28]!.date).toBe("2026-06-10");
    expect(o.last30Days[28]!.wallPlayingSec).toBe(5 * 15);
    // gap days are zero-filled
    expect(o.last30Days[0]!.wallPlayingSec).toBe(0);
    expect(o.ankiCumulative).toEqual([
      { date: "2026-06-10", total: 1 },
      { date: "2026-06-11", total: 3 },
    ]);
  });

  test("empty log → zero totals, 30 zero days, empty curve", () => {
    const o = overview([], DAY);
    expect(o.totals.ankiAdds).toBe(0);
    expect(o.last30Days).toHaveLength(30);
    expect(o.ankiCumulative).toEqual([]);
  });
});

describe("toCsv", () => {
  test("header + rows, null → empty cell, floats trimmed", () => {
    const rows = episodeSeries([
      ...watch(DAY, "m1", 5),
      { ts: DAY, type: "anki_add", mediaId: "m1" },
    ]);
    const csv = toCsv(rows);
    const lines = csv.trimEnd().split("\n");
    expect(lines[0]).toBe(
      "mediaId,date,wallPlayingSec,wallPausedSec,contentSec,coefficient,lookups,ankiAdds,cardsPerMin",
    );
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe("m1,2026-06-10,75,0,60,1.250,0,1,0.800");
    expect(csv.endsWith("\n")).toBe(true);
  });

  test("null coefficient renders as empty field and commas get quoted", () => {
    const csv = toCsv([
      {
        mediaId: 'm,"1"',
        date: "2026-06-10",
        wallPlayingSec: 15,
        wallPausedSec: 0,
        contentSec: 10,
        coefficient: null,
        lookups: 0,
        ankiAdds: 0,
        cardsPerMin: 0,
      },
    ]);
    expect(csv.split("\n")[1]).toBe('"m,""1""",2026-06-10,15,0,10,,0,0,0');
  });
});
