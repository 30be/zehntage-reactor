import { describe, expect, test } from "bun:test";
import {
  buildCard,
  buildDeck,
  orderDue,
  scoreAnswer,
  BLANK,
  type DueWord,
} from "../web/review.ts";

function word(p: Partial<DueWord>): DueWord {
  return {
    front: "勉強 [べんきょう]",
    word: "勉強",
    back: "study",
    interval: 0,
    ...p,
  };
}

describe("orderDue", () => {
  test("isDue cards lead, then ascending interval (most overdue first)", () => {
    const a = word({ front: "a", word: "a", interval: 30, isDue: false });
    const b = word({ front: "b", word: "b", interval: 5, isDue: false });
    const c = word({ front: "c", word: "c", interval: 100, isDue: true });
    const ordered = orderDue([a, b, c]).map((w) => w.front);
    expect(ordered).toEqual(["c", "b", "a"]);
  });

  test("ties broken deterministically by front", () => {
    const x = word({ front: "z", word: "z", interval: 3 });
    const y = word({ front: "a", word: "a", interval: 3 });
    expect(orderDue([x, y]).map((w) => w.front)).toEqual(["a", "z"]);
  });

  test("does not mutate the input array", () => {
    const arr = [word({ front: "b", interval: 9 }), word({ front: "a", interval: 1 })];
    const before = arr.map((w) => w.front);
    orderDue(arr);
    expect(arr.map((w) => w.front)).toEqual(before);
  });
});

describe("buildCard", () => {
  test("builds a cloze from a watched cue + deep-link", () => {
    const c = buildCard(
      word({
        encounter: {
          mediaId: "ep1",
          name: "clip.mp4",
          start: 2,
          text: "勉強します。",
        },
      }),
    );
    expect(c.hasCue).toBe(true);
    expect(c.prompt).toContain(BLANK);
    expect(c.prompt).not.toContain("勉強");
    expect(c.prompt).toContain("します"); // surrounding context preserved
    expect(c.answer).toBe("勉強");
    expect(c.hint).toBe("study");
    expect(c.deepLink).toBe("#/play/ep1@2");
    expect(c.source).toBe("clip.mp4");
  });

  test("falls back to front-only when there is no encounter", () => {
    const c = buildCard(word({ encounter: undefined }));
    expect(c.hasCue).toBe(false);
    expect(c.prompt).toBe("勉強");
    expect(c.deepLink).toBeUndefined();
  });

  test("falls back when the word is absent from the cue text", () => {
    const c = buildCard(
      word({
        word: "図書館",
        encounter: { mediaId: "ep1", start: 6, text: "勉強します。" },
      }),
    );
    expect(c.hasCue).toBe(false);
    expect(c.prompt).toBe("図書館");
  });
});

describe("buildDeck", () => {
  test("empty due list yields an empty deck", () => {
    expect(buildDeck([])).toEqual([]);
  });

  test("orders and builds in one pass", () => {
    const deck = buildDeck([
      word({ front: "b", word: "b", interval: 50 }),
      word({ front: "a", word: "a", interval: 1, isDue: true }),
    ]);
    expect(deck.map((c) => c.front)).toEqual(["a", "b"]);
  });
});

describe("scoreAnswer", () => {
  const c = buildCard(word({}));
  test("exact match is correct", () => {
    expect(scoreAnswer(c, "勉強")).toBe(true);
  });
  test("tolerant of surrounding whitespace/punctuation", () => {
    expect(scoreAnswer(c, " 勉強 ")).toBe(true);
  });
  test("wrong word is incorrect", () => {
    expect(scoreAnswer(c, "図書館")).toBe(false);
  });
  test("empty / punctuation-only guess is never correct", () => {
    expect(scoreAnswer(c, "")).toBe(false);
    expect(scoreAnswer(c, "・・・")).toBe(false);
  });
});
