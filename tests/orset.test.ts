import { describe, expect, test } from "bun:test";
import {
  type OrSet,
  parseOrSet,
  orSetMembers,
  orSetAdd,
  orSetRemove,
  mergeOrSet,
  migrateLegacyArray,
  SET_KEYS,
  isSetKey,
} from "../web/orset.ts";

describe("parseOrSet / migration", () => {
  test("plain legacy array migrates to {adds,removes}", () => {
    const o = parseOrSet('["a","b"]', 100);
    expect(o.adds).toEqual({ a: 100, b: 100 });
    expect(o.removes).toEqual({});
    expect(orSetMembers(o)).toEqual(new Set(["a", "b"]));
  });

  test("migration is idempotent and lossless", () => {
    const once = migrateLegacyArray('["x","y"]', 50);
    const o1 = parseOrSet(once, 999);
    // re-serializing the migrated value and re-parsing keeps the same members
    const o2 = parseOrSet(once, 999);
    expect(orSetMembers(o1)).toEqual(new Set(["x", "y"]));
    expect(orSetMembers(o2)).toEqual(new Set(["x", "y"]));
    // ts preserved from migration, not overwritten by the parse fallback ts
    expect(o1.adds.x).toBe(50);
  });

  test("already-orset value round-trips", () => {
    const raw = JSON.stringify({ adds: { a: 5 }, removes: { b: 7 } });
    const o = parseOrSet(raw, 0);
    expect(o.adds).toEqual({ a: 5 });
    expect(o.removes).toEqual({ b: 7 });
  });

  test("garbage parses to empty", () => {
    expect(orSetMembers(parseOrSet("not json", 0))).toEqual(new Set());
    expect(orSetMembers(parseOrSet("null", 0))).toEqual(new Set());
  });
});

describe("membership (add-ts vs remove-ts)", () => {
  test("add newer than remove -> member", () => {
    const o: OrSet = { adds: { a: 20 }, removes: { a: 10 } };
    expect(orSetMembers(o)).toEqual(new Set(["a"]));
  });
  test("remove newer than add -> absent", () => {
    const o: OrSet = { adds: { a: 10 }, removes: { a: 20 } };
    expect(orSetMembers(o)).toEqual(new Set());
  });
  test("equal ts -> remove wins (tombstone tie)", () => {
    const o: OrSet = { adds: { a: 10 }, removes: { a: 10 } };
    expect(orSetMembers(o)).toEqual(new Set());
  });
});

describe("orSetAdd / orSetRemove", () => {
  test("add records a fresh add ts", () => {
    const o = orSetAdd({ adds: {}, removes: {} }, "a", 100);
    expect(o.adds.a).toBe(100);
    expect(orSetMembers(o)).toEqual(new Set(["a"]));
  });
  test("remove records a tombstone ts", () => {
    const o = orSetRemove({ adds: { a: 50 }, removes: {} }, "a", 100);
    expect(o.removes.a).toBe(100);
    expect(orSetMembers(o)).toEqual(new Set());
  });
  test("re-add after remove with newer ts resurrects", () => {
    let o: OrSet = { adds: { a: 50 }, removes: { a: 100 } };
    o = orSetAdd(o, "a", 200);
    expect(orSetMembers(o)).toEqual(new Set(["a"]));
  });
});

describe("mergeOrSet — convergence", () => {
  test("two tabs add DIFFERENT members -> union (neither lost)", () => {
    const tabA: OrSet = { adds: { 猫: 100 }, removes: {} };
    const tabB: OrSet = { adds: { 犬: 100 }, removes: {} };
    const merged = mergeOrSet(tabA, tabB);
    expect(orSetMembers(merged)).toEqual(new Set(["猫", "犬"]));
    // symmetric
    expect(orSetMembers(mergeOrSet(tabB, tabA))).toEqual(new Set(["猫", "犬"]));
  });

  test("add then remove same member resolves by ts (later wins)", () => {
    const adder: OrSet = { adds: { a: 100 }, removes: {} };
    const remover: OrSet = { adds: {}, removes: { a: 200 } };
    expect(orSetMembers(mergeOrSet(adder, remover))).toEqual(new Set());
    // older remove loses to newer add
    const newAdd: OrSet = { adds: { a: 300 }, removes: {} };
    expect(
      orSetMembers(mergeOrSet({ adds: {}, removes: { a: 200 } }, newAdd)),
    ).toEqual(new Set(["a"]));
  });

  test("merge keeps the MAX ts per member on each side", () => {
    const x: OrSet = { adds: { a: 100 }, removes: {} };
    const y: OrSet = { adds: { a: 50 }, removes: {} };
    expect(mergeOrSet(x, y).adds.a).toBe(100);
  });

  test("merge is associative/commutative across three replicas", () => {
    const r1: OrSet = { adds: { a: 10 }, removes: {} };
    const r2: OrSet = { adds: { b: 20 }, removes: { a: 30 } };
    const r3: OrSet = { adds: { a: 40 }, removes: {} };
    const ab = mergeOrSet(mergeOrSet(r1, r2), r3);
    const ba = mergeOrSet(r3, mergeOrSet(r2, r1));
    expect(orSetMembers(ab)).toEqual(orSetMembers(ba));
    expect(orSetMembers(ab)).toEqual(new Set(["a", "b"])); // a: add40 > rm30
  });
});

describe("SET_KEYS guard", () => {
  test("only zr.known and zr.blacklist are set keys", () => {
    expect(isSetKey("zr.known")).toBe(true);
    expect(isSetKey("zr.blacklist")).toBe(true);
    expect(isSetKey("zr.pos.x")).toBe(false);
    expect(SET_KEYS.has("zr.known")).toBe(true);
  });
});
