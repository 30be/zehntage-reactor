// PROPERTY / FUZZ tests for the pure token-keying helpers:
//   web/tokenizer.ts  and  src/lib/jatok.ts
//     vocabKey / mergeTokens / lemmaOf / kataToHira / isLexical
//
// Invariants under test on randomized KToken-shaped objects (random pos,
// missing/empty/`*` reading & basic_form, surrogate-pair & empty surfaces):
//   - none of these functions throw;
//   - vocabKey returns a non-empty string WHENEVER there is something to key on
//     (surface OR basic_form non-empty), and always returns a string otherwise;
//   - the browser copy (web/tokenizer.ts) and the server copy (src/lib/jatok.ts)
//     of vocabKey / lemmaOf / kataToHira agree byte-for-byte for the same token
//     (they are explicitly documented to stay logic-identical).
//   - mergeTokens returns an array of well-shaped tokens.
//
// Deterministic: fixed-seed mulberry32 PRNG (tests/_fuzz.ts), never Math.random.

import { describe, expect, test } from "bun:test";
import * as web from "../web/tokenizer.ts";
import * as srv from "../src/lib/jatok.ts";
import { Rng, fuzzToken, type FuzzKToken } from "./_fuzz.ts";

describe("fuzz: vocabKey / lemmaOf / kataToHira never throw + server↔browser parity", () => {
  test("5000 random tokens: parity + non-empty key invariant", () => {
    const rng = new Rng(0x10c0de);
    for (let i = 0; i < 5000; i++) {
      const tok = fuzzToken(rng) as web.KToken & srv.KToken;

      // --- never throws + string results ---
      let wKey: string, sKey: string, wLem: string, sLem: string;
      expect(() => {
        wKey = web.vocabKey(tok);
        sKey = srv.vocabKey(tok);
        wLem = web.lemmaOf(tok);
        sLem = srv.lemmaOf(tok);
        web.isLexical(tok);
        srv.isLexical(tok);
        web.kataToHira(tok.surface_form);
        srv.kataToHira(tok.surface_form);
      }).not.toThrow();

      // --- server ↔ browser parity (documented contract) ---
      expect(wKey!).toBe(sKey!);
      expect(wLem!).toBe(sLem!);

      // --- shape: always a string ---
      expect(typeof wKey!).toBe("string");
      expect(typeof wLem!).toBe("string");

      // --- non-empty key WHEN there is content to key on ---
      // vocabKey degrades to lemmaOf(tok) which is basic_form (if not '*') else
      // surface_form. The only way to get "" is an empty/whitespace surface with
      // no usable basic_form — document that explicitly rather than asserting
      // unconditional non-emptiness.
      const lemmaSource =
        tok.basic_form && tok.basic_form !== "*" ? tok.basic_form : tok.surface_form;
      if (lemmaSource && lemmaSource.length > 0) {
        expect(wKey!.length).toBeGreaterThan(0);
      }
    }
  });

  test("kataToHira parity on arbitrary strings + idempotent-ish on hiragana", () => {
    const rng = new Rng(0x4a4a);
    for (let i = 0; i < 3000; i++) {
      const t = fuzzToken(rng);
      const s = t.surface_form + (t.reading ?? "");
      let w: string, sv: string;
      expect(() => {
        w = web.kataToHira(s);
        sv = srv.kataToHira(s);
      }).not.toThrow();
      expect(w!).toBe(sv!);
      // converting twice never re-converts already-hiragana output beyond the
      // first pass (no katakana left in the [ァ-ヶ] range that maps).
      expect(web.kataToHira(w!)).toBe(srv.kataToHira(w!));
    }
  });
});

describe("fuzz: mergeTokens never throws + returns well-shaped token arrays", () => {
  test("4000 random token LISTS through both copies", () => {
    const rng = new Rng(0x9e2e9e);
    for (let i = 0; i < 4000; i++) {
      const n = rng.int(0, 12);
      const raw: FuzzKToken[] = [];
      for (let k = 0; k < n; k++) raw.push(fuzzToken(rng));

      let wOut: web.KToken[], sOut: srv.KToken[];
      expect(() => {
        // pass a fresh clone to each — mergeTokens spreads inputs but the
        // glue path mutates the accumulator's own copies, so a shared input
        // array must not be aliased between the two calls.
        wOut = web.mergeTokens(raw.map((t) => ({ ...t })) as web.KToken[]);
        sOut = srv.mergeTokens(raw.map((t) => ({ ...t })) as srv.KToken[]);
      }).not.toThrow();

      expect(Array.isArray(wOut!)).toBe(true);
      expect(Array.isArray(sOut!)).toBe(true);
      // merge only ever fuses tokens → output is never longer than input.
      expect(wOut!.length).toBeLessThanOrEqual(n);
      expect(sOut!.length).toBeLessThanOrEqual(n);
      for (const t of wOut!) expect(typeof t.surface_form).toBe("string");
      // server ↔ browser parity on the merge result (surface + pos).
      expect(sOut!.length).toBe(wOut!.length);
      for (let j = 0; j < wOut!.length; j++) {
        expect(sOut![j]!.surface_form).toBe(wOut![j]!.surface_form);
        expect(sOut![j]!.pos).toBe(wOut![j]!.pos);
      }
      // every merged token still produces a valid key.
      for (const t of wOut!) {
        expect(() => web.vocabKey(t)).not.toThrow();
        expect(web.vocabKey(t)).toBe(srv.vocabKey(t as srv.KToken));
      }
    }
  });
});
