// Tests for web/coverage.ts coverageOfCues with emphasis on:
//   - unknown set keyed by wordKey (lemma/basic_form), so conjugated forms of
//     the same verb count as ONE unknown, not two.
//   - matchFront integration: a card added for 食べる means 食べた is KNOWN.
//   - homograph cases: same surface, different lemma → correct newCount.
//
// Uses same mock setup as coverage.test.ts.

import { describe, expect, test, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — registered before any import of coverage.ts
// ---------------------------------------------------------------------------

const realTokenizer = await import("../web/tokenizer.ts");

interface FakeToken {
  surface_form: string;
  basic_form?: string;
  pos?: string;
  reading?: string;
}

let fakeTokens: FakeToken[] = [];

mock.module("../web/tokenizer.ts", () => ({
  ...realTokenizer,
  getTokenizer: () =>
    Promise.resolve({ tokenize: (_text: string) => fakeTokens }),
  isLexical: (tok: FakeToken) => tok.pos !== "記号",
}));

// We control matchFront behaviour via this variable.
// When truthy, the set of "front" strings that the mock considers matched.
let knownFronts: Set<string> = new Set();

// wordKey: mirrors real impl (basic_form if set and not *, else surface)
mock.module("../web/TokenLine.tsx", () => ({
  wordKey: (tok: FakeToken) =>
    tok.basic_form && tok.basic_form !== "*" ? tok.basic_form : tok.surface_form,
}));

mock.module("../web/progress.ts", () => ({
  buildWordIndex: () => ({}),
  // matchFront checks the surface and basic_form against knownFronts
  matchFront: (_idx: unknown, surface: string, _reading?: string, basicForm?: string): string | null => {
    if (knownFronts.has(surface)) return surface;
    if (basicForm && basicForm !== "*" && basicForm !== surface && knownFronts.has(basicForm))
      return basicForm;
    return null;
  },
}));

mock.module("../web/api.ts", () => ({}));
mock.module("../web/blacklist.ts", () => ({ readBlacklist: () => new Set() }));
mock.module("../web/lang.ts", () => ({ isJaLang: () => false }));
mock.module("react", () => ({
  useEffect: () => {},
  useState: (init: unknown) => [
    typeof init === "function" ? (init as () => unknown)() : init,
    () => {},
  ],
}));

import { coverageOfCues } from "../web/coverage.ts";

type Cue = { start: number; end: number; text: string };
function cue(text: string): Cue {
  return { start: 0, end: 1, text };
}
const EMPTY_INDEX = {} as Parameters<typeof coverageOfCues>[1];

// ---------------------------------------------------------------------------
// Unknown-set lemma keying: two conjugations → ONE unknown entry
// ---------------------------------------------------------------------------

describe("coverageOfCues — unknown set keyed by lemma (wordKey)", () => {
  test("食べた and 食べない from same lemma → newCount = 1 (not 2)", async () => {
    fakeTokens = [
      { surface_form: "食べた",   basic_form: "食べる", pos: "動詞" },
      { surface_form: "食べない", basic_form: "食べる", pos: "動詞" },
    ];
    knownFronts = new Set();
    const cov = await coverageOfCues([cue("x")], EMPTY_INDEX, new Set());
    // wordKey of both is "食べる" → only 1 distinct unknown
    expect(cov.newCount).toBe(1);
    expect(cov.pct).toBe(0);
  });

  test("different verbs → newCount = 2", async () => {
    fakeTokens = [
      { surface_form: "食べた", basic_form: "食べる", pos: "動詞" },
      { surface_form: "飲んだ", basic_form: "飲む",   pos: "動詞" },
    ];
    knownFronts = new Set();
    const cov = await coverageOfCues([cue("x")], EMPTY_INDEX, new Set());
    expect(cov.newCount).toBe(2);
  });

  test("same lemma across multiple cues → still newCount = 1", async () => {
    fakeTokens = [{ surface_form: "猫", basic_form: "猫", pos: "名詞" }];
    knownFronts = new Set();
    const cov = await coverageOfCues(
      [cue("c1"), cue("c2"), cue("c3")],
      EMPTY_INDEX,
      new Set(),
    );
    expect(cov.newCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// matchFront integration: card for lemma covers conjugations
// ---------------------------------------------------------------------------

describe("coverageOfCues — matchFront covers conjugated tokens", () => {
  test("card '食べる' → 食べた token is counted as KNOWN", async () => {
    fakeTokens = [
      { surface_form: "食べた", basic_form: "食べる", pos: "動詞" },
    ];
    knownFronts = new Set(["食べる"]); // simulate card in deck
    const cov = await coverageOfCues([cue("x")], EMPTY_INDEX, new Set());
    expect(cov.pct).toBe(100);
    expect(cov.newCount).toBe(0);
  });

  test("card '食べる' covers 食べない and 食べます too", async () => {
    fakeTokens = [
      { surface_form: "食べない", basic_form: "食べる", pos: "動詞" },
      { surface_form: "食べます", basic_form: "食べる", pos: "動詞" },
    ];
    knownFronts = new Set(["食べる"]);
    const cov = await coverageOfCues([cue("x")], EMPTY_INDEX, new Set());
    expect(cov.pct).toBe(100);
    expect(cov.newCount).toBe(0);
  });

  test("card NOT in deck → conjugated form unknown", async () => {
    fakeTokens = [{ surface_form: "食べた", basic_form: "食べる", pos: "動詞" }];
    knownFronts = new Set(["飲む"]); // different verb
    const cov = await coverageOfCues([cue("x")], EMPTY_INDEX, new Set());
    expect(cov.pct).toBe(0);
    expect(cov.newCount).toBe(1);
  });

  test("knownWords set with lemma key marks conjugation as known", async () => {
    fakeTokens = [{ surface_form: "食べた", basic_form: "食べる", pos: "動詞" }];
    knownFronts = new Set();
    // Pass the wordKey (食べる) in knownWords
    const cov = await coverageOfCues([cue("x")], EMPTY_INDEX, new Set(["食べる"]));
    expect(cov.pct).toBe(100);
    expect(cov.newCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Homograph coverage: same surface, different lemma (basic_form differs)
// ---------------------------------------------------------------------------

describe("coverageOfCues — homograph handling", () => {
  test("two homographs with different basic_forms → two separate unknowns", async () => {
    fakeTokens = [
      { surface_form: "辛い", basic_form: "辛い_karai", pos: "形容詞", reading: "カライ" },
      { surface_form: "辛い", basic_form: "辛い_tsurai", pos: "形容詞", reading: "ツライ" },
    ];
    knownFronts = new Set();
    const cov = await coverageOfCues([cue("x")], EMPTY_INDEX, new Set());
    expect(cov.newCount).toBe(2);
  });

  test("knowing one homograph lemma covers exactly 1 of 2 occurrences → pct 50", async () => {
    fakeTokens = [
      { surface_form: "辛い", basic_form: "辛い_karai",  pos: "形容詞" },
      { surface_form: "辛い", basic_form: "辛い_tsurai", pos: "形容詞" },
    ];
    knownFronts = new Set(["辛い_karai"]);
    const cov = await coverageOfCues([cue("x")], EMPTY_INDEX, new Set());
    expect(cov.pct).toBe(50);
    expect(cov.newCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// i1density with lemma-aware unknown counting
// ---------------------------------------------------------------------------

describe("coverageOfCues — i1density and lemma keying", () => {
  test("two occurrences of same unknown lemma in one cue: cueUnknown=2 → NOT i1", async () => {
    // Source counts cueUnknown per OCCURRENCE, not per distinct lemma.
    // So 食べた + 食べない = 2 occurrences of unknown → not an i+1 cue.
    fakeTokens = [
      { surface_form: "食べた",   basic_form: "食べる", pos: "動詞" },
      { surface_form: "食べない", basic_form: "食べる", pos: "動詞" },
    ];
    knownFronts = new Set();
    const cov = await coverageOfCues([cue("x")], EMPTY_INDEX, new Set());
    expect(cov.i1density).toBe(0); // cueUnknown=2, not 1
    expect(cov.newCount).toBe(1);  // but only 1 DISTINCT unknown lemma
  });

  test("one unknown token among knowns → i1 cue", async () => {
    fakeTokens = [
      { surface_form: "猫",    basic_form: "猫",    pos: "名詞" }, // known
      { surface_form: "食べた", basic_form: "食べる", pos: "動詞" }, // unknown
    ];
    knownFronts = new Set(["猫"]);
    const cov = await coverageOfCues([cue("x")], EMPTY_INDEX, new Set());
    expect(cov.i1density).toBe(1);
    expect(cov.newCount).toBe(1);
  });

  test("all known: i1density=0 (no cue has exactly 1 unknown)", async () => {
    fakeTokens = [{ surface_form: "猫", basic_form: "猫", pos: "名詞" }];
    knownFronts = new Set(["猫"]);
    const cov = await coverageOfCues([cue("x")], EMPTY_INDEX, new Set());
    expect(cov.i1density).toBe(0);
    expect(cov.pct).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("coverageOfCues — edge cases", () => {
  test("no cues → pct 100, newCount 0, i1density 0", async () => {
    fakeTokens = [];
    knownFronts = new Set();
    const cov = await coverageOfCues([], EMPTY_INDEX, new Set());
    expect(cov.pct).toBe(100);
    expect(cov.newCount).toBe(0);
    expect(cov.i1density).toBe(0);
  });

  test("all-punctuation cue: i1density=0, pct=100 (vacuous)", async () => {
    fakeTokens = [{ surface_form: "。", pos: "記号" }];
    knownFronts = new Set();
    const cov = await coverageOfCues([cue("。")], EMPTY_INDEX, new Set());
    expect(cov.i1density).toBe(0);
    expect(cov.pct).toBe(100);
    expect(cov.newCount).toBe(0);
  });

  test("pct rounds to nearest integer", async () => {
    // 1 known, 3 total → 33.33... → rounds to 33
    fakeTokens = [
      { surface_form: "A", basic_form: "A", pos: "名詞" },
      { surface_form: "B", basic_form: "B", pos: "名詞" },
      { surface_form: "C", basic_form: "C", pos: "名詞" },
    ];
    knownFronts = new Set(["A"]);
    const cov = await coverageOfCues([cue("x")], EMPTY_INDEX, new Set());
    expect(cov.pct).toBe(33);
  });
});
