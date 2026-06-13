// Phase 1 (lemma vocab): interactive Anki adds (ReadRoute.onAdd /
// Player.onAdd) write the DICTIONARY (lemma) form as the card front instead of
// the conjugated surface. This test pins that behavior at the unit level by
// replicating the popup-front derivation used at both add sites and asserting
// that the resulting front matches ALL conjugations via matchFront (which the
// real highlighting/coverage pipeline uses).

import { describe, expect, test } from "bun:test";
import type { AnkiWord } from "../web/api.ts";
import { buildWordIndex, matchFront } from "../web/progress.ts";

// Mirror of the popup shape the add sites read (surface + dict form + reading).
interface Popup {
  surface: string;
  reading?: string;
  dictForm?: string;
}

// Replica of the `word`/`popupFront` derivation now shared by ReadRoute.tsx and
// Player.tsx: the lemma when it differs from the surface, plus the lemma's
// (lookup) reading. Keep in sync with both add sites.
function addedFront(popup: Popup, lookupReading?: string): { word: string; front: string } {
  const word = popup.dictForm ?? popup.surface;
  const reading = lookupReading || popup.reading;
  return { word, front: reading ? `${word} [${reading}]` : word };
}

const card = (front: string): AnkiWord => ({ front, back: "", notes: "", context: "" });

describe("lemma-form interactive add (Phase 1)", () => {
  test("adding a conjugated surface 食べた writes the dict form 食べる as the front", () => {
    // popup opened on 食べた; kuromoji gives basic_form 食べる, the Gemini
    // lookup reading is the dict-form reading たべる.
    const popup: Popup = { surface: "食べた", reading: "たべた", dictForm: "食べる" };
    const { word, front } = addedFront(popup, "たべる");
    expect(word).toBe("食べる");
    expect(front).toBe("食べる [たべる]");
  });

  test("that lemma-fronted card lights up ALL conjugations via matchFront", () => {
    const popup: Popup = { surface: "食べた", reading: "たべた", dictForm: "食べる" };
    const { front } = addedFront(popup, "たべる");
    const idx = buildWordIndex([card(front)], {});

    // every conjugation token (surface, surface-reading, basic_form 食べる)
    // resolves to the single lemma card via matchFront's basic_form fallback.
    const forms: Array<[string, string]> = [
      ["食べた", "たべた"],
      ["食べる", "たべる"],
      ["食べて", "たべて"],
      ["食べない", "たべない"],
    ];
    for (const [surface, reading] of forms) {
      expect(matchFront(idx, surface, reading, "食べる")).toBe(front);
    }
  });

  test("REGRESSION it fixes: a surface-fronted 食べた card would NOT cover other forms", () => {
    const idx = buildWordIndex([card("食べた [たべた]")], {});
    // only its own conjugation matches; the lemma and siblings do not.
    expect(matchFront(idx, "食べた", "たべた", "食べる")).toBe("食べた [たべた]");
    expect(matchFront(idx, "食べる", "たべる", "食べる")).toBeNull();
    expect(matchFront(idx, "食べて", "たべて", "食べる")).toBeNull();
  });

  test("noun/particle (dictForm undefined) falls back to the surface front", () => {
    const popup: Popup = { surface: "本", reading: "ほん", dictForm: undefined };
    const { word, front } = addedFront(popup, "ほん");
    expect(word).toBe("本");
    expect(front).toBe("本 [ほん]");
  });
});
