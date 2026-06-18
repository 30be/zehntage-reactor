// Unit tests for the pure notetype field-ordinal picker (pickFieldOrdinals).
//
// The lookup popup's "card fallback" (deckCardToLookup) reads back=MEANING and
// notes=note/example. These tests pin the field resolution against the user's
// REAL notetypes so the popup surfaces the gloss, not the kana reading:
//   - Japanese mining type (1708628080880): 誰 → back="Word Meaning"=who,
//     NOT ord1 "Word Reading"=だれ.
//   - Classic Front/Back/notes/context (1680028238431): must NOT regress —
//     back stays the "Back" field, notes the "notes" field.

import { describe, expect, test } from "bun:test";

import { pickFieldOrdinals } from "../src/lib/ankidb.ts";

// Real notetype field-name layouts pulled from the user's collection.
const JP_MINING = [
  "Word", // 0
  "Word Reading", // 1  ← kana reading (だれ) — the OLD/wrong back
  "Word Meaning", // 2  ← the meaning (who) — the RIGHT back
  "Word Furigana", // 3
  "Word Audio", // 4
  "Sentence", // 5
  "Sentence Meaning", // 6
  "Sentence Furigana", // 7
  "Sentence Audio", // 8
  "Notes", // 9  ← the RIGHT notes
  "Pitch Accent", // 10
  "Pitch Accent Notes", // 11
  "Frequency", // 12
  "Picture", // 13
];

const FRONT_BACK = ["Front", "Back", "notes", "context"];

describe("pickFieldOrdinals", () => {
  test("Japanese mining notetype: back=Word Meaning, not the reading", () => {
    const fm = pickFieldOrdinals(JP_MINING);
    expect(fm.front).toBe(0); // "Word"
    expect(fm.back).toBe(2); // "Word Meaning" (who) — NOT 1 "Word Reading" (だれ)
    expect(fm.notes).toBe(9); // "Notes" — NOT 5 "Sentence"
  });

  test("classic Front/Back/notes/context is NOT regressed", () => {
    const fm = pickFieldOrdinals(FRONT_BACK);
    expect(fm.front).toBe(0); // "Front"
    expect(fm.back).toBe(1); // "Back"
    expect(fm.notes).toBe(2); // "notes"
    expect(fm.context).toBe(3); // "context"
  });

  test("English-gloss field is preferred for back", () => {
    const fm = pickFieldOrdinals(["Expression", "Reading", "English", "Example"]);
    expect(fm.front).toBe(0);
    expect(fm.back).toBe(2); // "English"
    // "Example" is an example sentence → notes.
    expect(fm.notes).toBe(3);
  });

  test("'translation'/'sentence' layout: back=translation, notes=sentence-but-not-front", () => {
    // ["sentence","translation","freq ranks","audio","audio_english"]
    const fm = pickFieldOrdinals([
      "sentence",
      "translation",
      "freq ranks",
      "audio",
      "audio_english",
    ]);
    // front defaults to ord 0 ("sentence" — no /front/i match).
    expect(fm.front).toBe(0);
    // back must prefer the meaning-ish "translation".
    expect(fm.back).toBe(1);
    // notes must NOT collapse onto the front field (ord 0); here there is no
    // other note/example/context field → notes is left unset.
    expect(fm.notes).not.toBe(0);
  });

  test("no meaning field at all: back falls to first non-front non-reading field", () => {
    // Only kana reading + a plain extra field; no name matches the meaning regex.
    const fm = pickFieldOrdinals(["Kanji", "Kana", "Extra"]);
    expect(fm.front).toBe(0); // "Kanji"
    // "Kana" looks like a reading → skip it; back is the next text field.
    expect(fm.back).toBe(2); // "Extra"
  });

  test("back never collides with front when only front+reading exist", () => {
    const fm = pickFieldOrdinals(["Word", "Reading"]);
    expect(fm.front).toBe(0);
    // No meaning, no non-reading field → back falls back but must be defined.
    expect(typeof fm.back).toBe("number");
    expect(fm.back).not.toBe(fm.front);
  });

  test("explicit Front/Back names win over positional defaults", () => {
    const fm = pickFieldOrdinals(["Extra", "Front", "Back", "Reading"]);
    expect(fm.front).toBe(1); // "Front" by name
    expect(fm.back).toBe(2); // "Back" by name
  });
});
