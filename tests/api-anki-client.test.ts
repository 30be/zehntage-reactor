// ---------------------------------------------------------------------------
// Client surfacing of refused Anki writes (web/api.ts ankiAdd / ankiDelete).
//
// The server reports a refused windowless write as { ok:false, reason } at
// HTTP 200 (so jpost does NOT throw). The api.anki* wrappers must turn that into
// a THROWN Error carrying the human message from ankiWriteError(), so the
// Player's catch reverts the optimistic mark + toasts (the "silent blue→red
// flash" bug). On { ok:true } they must resolve normally and write through to
// the localStorage cache.
//
// We mock globalThis.fetch + provide an in-memory localStorage (bun:test has no
// DOM). No real network, no real server.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { api } from "../web/api.ts";

// Minimal in-memory Storage (same shape used by ankicache.test.ts).
function memStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
  } as Storage;
}

const realFetch = globalThis.fetch;
const g = globalThis as { localStorage?: Storage };

interface Posted {
  url: string;
  body: unknown;
}
let posted: Posted[] = [];

// Route POSTs to /api/anki/add|delete through `responder`; everything else
// (e.g. the background /api/anki/words refresh) gets a benign empty payload so
// the fire-and-forget revalidation never rejects loudly.
function mockFetch(
  responder: (url: string, body: unknown) => { status?: number; json: unknown },
) {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (
      typeof url === "string" &&
      (url.includes("/api/anki/add") || url.includes("/api/anki/delete"))
    ) {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      posted.push({ url, body });
      const out = responder(url, body);
      return new Response(JSON.stringify(out.json), {
        status: out.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    }
    // Background refresh (refreshAnkiWords) and anything else.
    return new Response(JSON.stringify({ words: [], progress: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

const addArgs = {
  word: "猫",
  reading: "ねこ",
  translation: "cat",
  notes: "",
  context: "今日は猫を見た",
};

beforeEach(() => {
  posted = [];
  g.localStorage = memStorage();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete g.localStorage;
});

// ---------------------------------------------------------------------------
describe("api.ankiAdd — surfaces a refused write as a thrown Error", () => {
  test("ok:true → resolves and POSTs to /api/anki/add", async () => {
    mockFetch(() => ({ json: { ok: true } }));
    const r = await api.ankiAdd(addArgs);
    expect(r.ok).toBe(true);
    expect(posted.some((p) => p.url.includes("/api/anki/add"))).toBe(true);
    // wrote through to the cache (front built from word+reading)
    const raw = g.localStorage!.getItem("zr.ankiCache");
    expect(raw).toBeTruthy();
    expect(raw).toContain("猫");
  });

  test("ok:false reason:anki-open → throws the close-Anki message", async () => {
    mockFetch(() => ({ json: { ok: false, reason: "anki-open" } }));
    await expect(api.ankiAdd(addArgs)).rejects.toThrow(
      /Anki is open.*close it.*AnkiConnect.*to mine/,
    );
  });

  test("ok:false reason:locked → same close-Anki message", async () => {
    mockFetch(() => ({ json: { ok: false, reason: "locked" } }));
    await expect(api.ankiAdd(addArgs)).rejects.toThrow(/Anki is open/);
  });

  test("ok:false reason:schema → unsupported-version message", async () => {
    mockFetch(() => ({ json: { ok: false, reason: "schema" } }));
    await expect(api.ankiAdd(addArgs)).rejects.toThrow(
      /Unsupported Anki collection version/,
    );
  });

  test("ok:false reason:missing → collection-not-found message", async () => {
    mockFetch(() => ({ json: { ok: false, reason: "missing" } }));
    await expect(api.ankiAdd(addArgs)).rejects.toThrow(
      /Anki collection not found/,
    );
  });

  test("ok:false with an explicit error string → that error wins", async () => {
    mockFetch(() => ({
      json: { ok: false, error: "duplicate note", reason: "duplicate" },
    }));
    await expect(api.ankiAdd(addArgs)).rejects.toThrow("duplicate note");
  });

  test("ok:false unknown reason → generic 'write failed (reason)'", async () => {
    mockFetch(() => ({ json: { ok: false, reason: "weird" } }));
    await expect(api.ankiAdd(addArgs)).rejects.toThrow(
      /Anki write failed \(weird\)/,
    );
  });

  test("ok:false with no reason/error → bare 'Anki write failed'", async () => {
    mockFetch(() => ({ json: { ok: false } }));
    await expect(api.ankiAdd(addArgs)).rejects.toThrow(/Anki write failed/);
  });

  test("a refused add does NOT write through to the cache", async () => {
    mockFetch(() => ({ json: { ok: false, reason: "anki-open" } }));
    await expect(api.ankiAdd(addArgs)).rejects.toThrow();
    // No optimistic cache entry was created (the card was never made).
    const raw = g.localStorage!.getItem("zr.ankiCache");
    expect(raw).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("api.ankiDelete — surfaces a refused un-mine as a thrown Error", () => {
  test("ok:true → resolves and POSTs the front to /api/anki/delete", async () => {
    mockFetch(() => ({ json: { ok: true } }));
    const r = await api.ankiDelete("猫 [ねこ]");
    expect(r.ok).toBe(true);
    const del = posted.find((p) => p.url.includes("/api/anki/delete"));
    expect(del).toBeTruthy();
    expect((del!.body as { front: string }).front).toBe("猫 [ねこ]");
  });

  test("ok:false reason:anki-open → throws the close-Anki message", async () => {
    mockFetch(() => ({ json: { ok: false, reason: "anki-open" } }));
    await expect(api.ankiDelete("猫 [ねこ]")).rejects.toThrow(/Anki is open/);
  });

  test("ok:false explicit error → that error wins", async () => {
    mockFetch(() => ({ json: { ok: false, error: "boom from server" } }));
    await expect(api.ankiDelete("x")).rejects.toThrow("boom from server");
  });

  test("ok:false unknown reason → generic message includes the reason", async () => {
    mockFetch(() => ({ json: { ok: false, reason: "frob" } }));
    await expect(api.ankiDelete("x")).rejects.toThrow(
      /Anki write failed \(frob\)/,
    );
  });
});
