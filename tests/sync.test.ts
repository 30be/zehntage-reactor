import { describe, expect, test } from "bun:test";
import {
  collectZr,
  applyRemote,
  startSync,
  TOMBSTONE,
  type ZrState,
} from "../web/sync.ts";
import { parseOrSet, orSetMembers, serializeOrSet } from "../web/orset.ts";
import { emitVocabChanged, onVocabChanged } from "../web/sync.ts";

// Minimal in-memory Storage (bun:test has no DOM localStorage).
function memStorage(): Storage {
  const m = new Map<string, string>();
  const s = {
    get length() {
      return m.size;
    },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
  };
  return s as Storage;
}

function seedTs(ls: Storage, ts: Record<string, number>) {
  ls.setItem("zr.sync.ts", JSON.stringify(ts));
}

describe("collectZr", () => {
  test("only zr.* keys, sync metadata excluded, ts from map", () => {
    const ls = memStorage();
    ls.setItem("zr.known", "[]");
    ls.setItem("zr.pos.abc", "12.5");
    ls.setItem("other", "x");
    seedTs(ls, { "zr.known": 42 });
    const snap = collectZr(ls);
    expect(Object.keys(snap).sort()).toEqual(["zr.known", "zr.pos.abc"]);
    expect(snap["zr.known"]).toEqual({ v: "[]", ts: 42 });
    expect(snap["zr.pos.abc"]!.ts).toBe(0); // unknown age
  });
});

describe("applyRemote", () => {
  test("newer remote overwrites, older is ignored", () => {
    const ls = memStorage();
    ls.setItem("zr.a", "local");
    seedTs(ls, { "zr.a": 100 });
    const changed = applyRemote(
      { "zr.a": { v: "remote", ts: 200 }, "zr.b": { v: "new", ts: 50 } },
      ls,
    );
    expect(changed.sort()).toEqual(["zr.a", "zr.b"]);
    expect(ls.getItem("zr.a")).toBe("remote");
    expect(ls.getItem("zr.b")).toBe("new");
    // second apply is a no-op (ts recorded)
    expect(applyRemote({ "zr.a": { v: "remote", ts: 200 } }, ls)).toEqual([]);
  });

  test("equal ts keeps local (remote wins only strictly-newer)", () => {
    const ls = memStorage();
    ls.setItem("zr.a", "local");
    seedTs(ls, { "zr.a": 100 });
    expect(applyRemote({ "zr.a": { v: "remote", ts: 100 } }, ls)).toEqual([]);
    expect(ls.getItem("zr.a")).toBe("local");
  });

  test("tombstone removes the key", () => {
    const ls = memStorage();
    ls.setItem("zr.gone", "x");
    const changed = applyRemote({ "zr.gone": { v: TOMBSTONE, ts: 10 } }, ls);
    expect(changed).toEqual(["zr.gone"]);
    expect(ls.getItem("zr.gone")).toBeNull();
  });

  test("non-zr keys in remote are ignored", () => {
    const ls = memStorage();
    expect(applyRemote({ evil: { v: "x", ts: 99 } }, ls)).toEqual([]);
    expect(ls.getItem("evil")).toBeNull();
  });
});

describe("startSync", () => {
  function fakeServer(initial: ZrState = {}) {
    let state = { ...initial };
    const posts: ZrState[] = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as ZrState;
        posts.push(body);
        for (const [k, e] of Object.entries(body)) {
          const cur = state[k];
          if (!cur || e.ts > cur.ts) state[k] = e;
        }
      }
      return new Response(JSON.stringify(state), {
        headers: { "Content-Type": "application/json" },
      });
    };
    return { fetchImpl, posts, get state() { return state; } };
  }

  test("pull-on-start applies remote-newer keys (set key migrates+merges)", async () => {
    const ls = memStorage();
    // remote ships a LEGACY plain array; sync migrates it into the OR-Set shape
    // and the local membership reflects it.
    const srv = fakeServer({ "zr.known": { v: '["猫"]', ts: 999 } });
    const h = startSync(srv.fetchImpl, ls);
    await h.ready;
    expect(orSetMembers(parseOrSet(ls.getItem("zr.known"), 0))).toEqual(
      new Set(["猫"]),
    );
    h.stop();
  });

  test("pull-on-start applies a non-set remote-newer key verbatim", async () => {
    const ls = memStorage();
    const srv = fakeServer({ "zr.pos.x": { v: "42", ts: 999 } });
    const h = startSync(srv.fetchImpl, ls);
    await h.ready;
    expect(ls.getItem("zr.pos.x")).toBe("42");
    h.stop();
  });

  test("patched setItem queues zr.* writes; flush pushes them", async () => {
    const ls = memStorage();
    const srv = fakeServer();
    const h = startSync(srv.fetchImpl, ls);
    await h.ready;
    ls.setItem("zr.pos.x", "33");
    ls.setItem("not-zr", "ignored");
    await h.flush();
    expect(srv.posts.length).toBe(1);
    expect(srv.posts[0]!["zr.pos.x"]!.v).toBe("33");
    expect(srv.posts[0]!["not-zr"]).toBeUndefined();
    expect(ls.getItem("zr.pos.x")).toBe("33"); // write-through preserved
    h.stop();
  });

  test("removeItem pushes a tombstone", async () => {
    const ls = memStorage();
    ls.setItem("zr.dead", "1");
    const srv = fakeServer();
    const h = startSync(srv.fetchImpl, ls);
    await h.ready;
    await h.flush(); // initial push of zr.dead
    ls.removeItem("zr.dead");
    await h.flush();
    expect(srv.state["zr.dead"]!.v).toBe(TOMBSTONE);
    h.stop();
  });

  test("stop restores original methods", async () => {
    const ls = memStorage();
    const orig = ls.setItem;
    const srv = fakeServer();
    const h = startSync(srv.fetchImpl, ls);
    expect(ls.setItem).not.toBe(orig);
    await h.ready;
    h.stop();
    ls.setItem("zr.after", "x");
    await h.flush();
    // write after stop is not tracked
    expect(srv.state["zr.after"]).toBeUndefined();
  });

  test("local-newer keys get pushed after start", async () => {
    const ls = memStorage();
    ls.setItem("zr.a", "local");
    seedTs(ls, { "zr.a": 500 });
    const srv = fakeServer({ "zr.a": { v: "remote", ts: 100 } });
    const h = startSync(srv.fetchImpl, ls);
    await h.ready;
    expect(ls.getItem("zr.a")).toBe("local"); // remote older, not applied
    await h.flush();
    expect(srv.state["zr.a"]!.v).toBe("local");
    h.stop();
  });
});

describe("applyRemote — OR-Set merge for set keys (Fix 2)", () => {
  const os = (raw: string | null) => orSetMembers(parseOrSet(raw, 0));

  test("set key: concurrent different members UNION (no loss), even if remote ts is older", () => {
    const ls = memStorage();
    // local already has 猫 (legacy-array migrated by sync on first touch, but
    // here we seed the new shape directly) with a high local ts
    ls.setItem("zr.known", serializeOrSet({ adds: { 猫: 100 }, removes: {} }));
    seedTs(ls, { "zr.known": 100 });
    // remote added 犬 with an OLDER ts — plain LWW would discard it entirely
    const changed = applyRemote(
      { "zr.known": { v: serializeOrSet({ adds: { 犬: 50 }, removes: {} }), ts: 50 } },
      ls,
    );
    expect(changed).toEqual(["zr.known"]);
    expect(os(ls.getItem("zr.known"))).toEqual(new Set(["猫", "犬"]));
  });

  test("set key: legacy plain ARRAY local value is migrated then merged (lossless)", () => {
    const ls = memStorage();
    ls.setItem("zr.blacklist", JSON.stringify(["a"])); // legacy shape on disk
    seedTs(ls, { "zr.blacklist": 100 });
    applyRemote(
      { "zr.blacklist": { v: serializeOrSet({ adds: { b: 200 }, removes: {} }), ts: 200 } },
      ls,
    );
    expect(os(ls.getItem("zr.blacklist"))).toEqual(new Set(["a", "b"]));
  });

  test("set key: remote remove (tombstone) wins over older local add", () => {
    const ls = memStorage();
    ls.setItem("zr.known", serializeOrSet({ adds: { a: 100 }, removes: {} }));
    seedTs(ls, { "zr.known": 100 });
    applyRemote(
      { "zr.known": { v: serializeOrSet({ adds: {}, removes: { a: 200 } }), ts: 200 } },
      ls,
    );
    expect(os(ls.getItem("zr.known"))).toEqual(new Set());
  });

  test("set key: idempotent — re-applying the same merged value reports no change", () => {
    const ls = memStorage();
    ls.setItem("zr.known", serializeOrSet({ adds: { a: 1, b: 2 }, removes: {} }));
    seedTs(ls, { "zr.known": 10 });
    const v = serializeOrSet({ adds: { a: 1, b: 2 }, removes: {} });
    // remote equals local content; nothing to change
    expect(applyRemote({ "zr.known": { v, ts: 5 } }, ls)).toEqual([]);
  });

  test("non-set zr key still uses plain LWW (no regression)", () => {
    const ls = memStorage();
    ls.setItem("zr.pos.x", "10");
    seedTs(ls, { "zr.pos.x": 100 });
    // older remote ignored
    expect(applyRemote({ "zr.pos.x": { v: "99", ts: 50 } }, ls)).toEqual([]);
    expect(ls.getItem("zr.pos.x")).toBe("10");
    // newer remote wins
    applyRemote({ "zr.pos.x": { v: "77", ts: 200 } }, ls);
    expect(ls.getItem("zr.pos.x")).toBe("77");
  });

  test("two devices converge to the SAME members regardless of apply order", () => {
    const mk = (raw: string) => {
      const ls = memStorage();
      ls.setItem("zr.known", raw);
      seedTs(ls, { "zr.known": 100 });
      return ls;
    };
    const A = serializeOrSet({ adds: { 猫: 100, 鳥: 100 }, removes: { 鳥: 150 } });
    const B = serializeOrSet({ adds: { 犬: 120, 鳥: 200 }, removes: {} });
    const lsA = mk(A);
    applyRemote({ "zr.known": { v: B, ts: 200 } }, lsA);
    const lsB = mk(B);
    applyRemote({ "zr.known": { v: A, ts: 150 } }, lsB);
    // 鳥: max add 200 > max remove 150 -> present
    expect(os(lsA.getItem("zr.known"))).toEqual(
      os(lsB.getItem("zr.known")),
    );
    expect(os(lsA.getItem("zr.known"))).toEqual(new Set(["猫", "犬", "鳥"]));
  });
});

describe("vocab pub/sub (Fix 3 refresh wiring)", () => {
  test("emitVocabChanged delivers only set keys to subscribers", () => {
    const got: string[][] = [];
    const off = onVocabChanged((keys) => got.push(keys));
    emitVocabChanged(["zr.known", "zr.pos.x"]); // pos.x must be filtered out
    emitVocabChanged(["zr.pos.x"]); // no set key -> no delivery
    emitVocabChanged(["zr.blacklist"]);
    off();
    emitVocabChanged(["zr.known"]); // after unsubscribe -> ignored
    expect(got).toEqual([["zr.known"], ["zr.blacklist"]]);
  });

  test("onRemoteApplied fires with changed set keys after a remote apply", async () => {
    const ls = memStorage();
    const applied: string[][] = [];
    const srv = (() => {
      const state: ZrState = {
        "zr.known": { v: serializeOrSet({ adds: { 猫: 999 }, removes: {} }), ts: 999 },
      };
      return {
        fetchImpl: async () =>
          new Response(JSON.stringify(state), {
            headers: { "Content-Type": "application/json" },
          }),
      };
    })();
    const h = startSync(srv.fetchImpl, ls, (keys) => applied.push(keys));
    await h.ready;
    expect(applied).toEqual([["zr.known"]]);
    expect(orSetMembers(parseOrSet(ls.getItem("zr.known"), 0))).toEqual(
      new Set(["猫"]),
    );
    h.stop();
  });
});
