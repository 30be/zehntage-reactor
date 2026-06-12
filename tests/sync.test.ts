import { describe, expect, test } from "bun:test";
import {
  collectZr,
  applyRemote,
  startSync,
  TOMBSTONE,
  type ZrState,
} from "../web/sync.ts";

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

  test("pull-on-start applies remote-newer keys", async () => {
    const ls = memStorage();
    const srv = fakeServer({ "zr.known": { v: '["猫"]', ts: 999 } });
    const h = startSync(srv.fetchImpl, ls);
    await h.ready;
    expect(ls.getItem("zr.known")).toBe('["猫"]');
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
