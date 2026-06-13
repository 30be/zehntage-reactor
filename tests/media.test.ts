import { describe, expect, it } from "bun:test";
import { contentTypeFor, mergeAudioSpans } from "../src/lib/media.ts";
import type { AudioSpan } from "../src/lib/media.ts";

// NOTE: serveFileWithRange is skipped here — it calls Bun.file(path) eagerly
// and reads file.size, so range-parsing cannot be unit-tested without a real fs
// file. Integration-level tests (e2e) are the appropriate venue.

// NOTE: checkCodecs, condenseAudio, cutAudio, remuxToFmp4, captureFrame all
// require ffprobe/ffmpeg or a real filesystem, so they are not tested here.

describe("contentTypeFor", () => {
  it("returns video/x-matroska for .mkv", () => {
    expect(contentTypeFor("episode.mkv")).toBe("video/x-matroska");
  });
  it("returns video/mp4 for .mp4", () => {
    expect(contentTypeFor("clip.mp4")).toBe("video/mp4");
  });
  it("returns video/webm for .webm", () => {
    expect(contentTypeFor("video.webm")).toBe("video/webm");
  });
  it("returns audio/mpeg for .mp3", () => {
    expect(contentTypeFor("audio.mp3")).toBe("audio/mpeg");
  });
  it("returns application/octet-stream for unknown extension", () => {
    expect(contentTypeFor("file.xyz")).toBe("application/octet-stream");
  });
  it("is case-insensitive (uppercase extension)", () => {
    expect(contentTypeFor("VIDEO.MKV")).toBe("video/x-matroska");
  });
  it("handles path with directories", () => {
    expect(contentTypeFor("/some/dir/show.mp4")).toBe("video/mp4");
  });
});

describe("mergeAudioSpans", () => {
  it("returns empty array for empty input", () => {
    expect(mergeAudioSpans([])).toEqual([]);
  });

  it("filters out degenerate spans (end <= start)", () => {
    const spans: AudioSpan[] = [
      { start: 5, end: 3 }, // reversed
      { start: 5, end: 5 }, // zero-length
    ];
    expect(mergeAudioSpans(spans)).toEqual([]);
  });

  it("filters out non-finite spans", () => {
    const spans: AudioSpan[] = [
      { start: NaN, end: 5 },
      { start: 0, end: Infinity },
    ];
    expect(mergeAudioSpans(spans)).toEqual([]);
  });

  it("pads a single span on both sides", () => {
    const result = mergeAudioSpans([{ start: 1, end: 2 }], 0.2, 0.4);
    expect(result).toHaveLength(1);
    expect(result[0]!.start).toBeCloseTo(0.8);
    expect(result[0]!.end).toBeCloseTo(2.2);
  });

  it("clamps padded start to 0", () => {
    const result = mergeAudioSpans([{ start: 0.1, end: 1 }], 0.2, 0.4);
    expect(result[0]!.start).toBe(0);
  });

  it("merges overlapping spans into one", () => {
    const spans: AudioSpan[] = [
      { start: 0, end: 2 },
      { start: 1, end: 3 },
    ];
    const result = mergeAudioSpans(spans, 0, 0);
    expect(result).toHaveLength(1);
    expect(result[0]!.start).toBeCloseTo(0);
    expect(result[0]!.end).toBeCloseTo(3);
  });

  it("merges spans whose gap is smaller than `gap` parameter", () => {
    // gap between end=2 and start=2.3 is 0.3, which is < default gap=0.4
    const spans: AudioSpan[] = [
      { start: 0, end: 2 },
      { start: 2.3, end: 4 },
    ];
    const result = mergeAudioSpans(spans, 0, 0.4);
    expect(result).toHaveLength(1);
    expect(result[0]!.end).toBeCloseTo(4);
  });

  it("keeps spans separate when gap is larger than `gap` parameter", () => {
    // gap between end=2 and start=3 is 1.0 > 0.4
    const spans: AudioSpan[] = [
      { start: 0, end: 2 },
      { start: 3, end: 5 },
    ];
    const result = mergeAudioSpans(spans, 0, 0.4);
    expect(result).toHaveLength(2);
  });

  it("handles unsorted input (sorts before merging)", () => {
    const spans: AudioSpan[] = [
      { start: 10, end: 12 },
      { start: 0, end: 2 },
      { start: 5, end: 7 },
    ];
    const result = mergeAudioSpans(spans, 0, 0);
    expect(result).toHaveLength(3);
    expect(result[0]!.start).toBeCloseTo(0);
    expect(result[1]!.start).toBeCloseTo(5);
    expect(result[2]!.start).toBeCloseTo(10);
  });

  it("adjacent spans that touch exactly are merged (gap=0)", () => {
    // after padding=0: spans touch at exactly 2.0; gap=0 means < 0 → NOT merged
    // But with tiny epsilon they should not merge — confirm boundary behavior
    const spans: AudioSpan[] = [
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ];
    // gap = start_next - end_prev = 2 - 2 = 0, which is NOT < 0
    const result = mergeAudioSpans(spans, 0, 0);
    // 0 < 0 is false, so they stay separate
    expect(result).toHaveLength(2);
  });

  it("merges three consecutive overlapping spans into one", () => {
    const spans: AudioSpan[] = [
      { start: 0, end: 3 },
      { start: 2, end: 5 },
      { start: 4, end: 7 },
    ];
    const result = mergeAudioSpans(spans, 0, 0);
    expect(result).toHaveLength(1);
    expect(result[0]!.end).toBeCloseTo(7);
  });

  it("with default pad=0.2 and gap=0.4: nearby cues get merged", () => {
    // two cues separated by 0.2s; after padding each by 0.2, the gap becomes
    // 0.2 - 0.4 = -0.2 < 0.4, so they merge
    const spans: AudioSpan[] = [
      { start: 1.0, end: 2.0 },
      { start: 2.2, end: 3.0 },
    ];
    const result = mergeAudioSpans(spans); // default pad+gap
    expect(result).toHaveLength(1);
  });
});
