// ---------------------------------------------------------------------------
// Unit tests for the minimal AnkiConnect client (src/lib/ankiconnect.ts).
//
// We stub globalThis.fetch so NO real network is touched, and assert:
//   - acAddNote builds EXACTLY dbAddNote's card shape (model Back+Front+Usage,
//     deck Mixed, tag zehntage, fields Front/Back/notes/context, allowDuplicate:false),
//   - acDeleteByFront does findNotes(Front:"...") then deleteNotes(ids),
//   - connection-refused / timeout / {error:!null} never throw and map cleanly,
//   - duplicate add and not-found delete surface the right reasons.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  acAvailable,
  acAddNote,
  acDeleteByFront,
} from "../src/lib/ankiconnect.ts";

type Body = { action: string; version: number; params: Record<string, unknown> };

const realFetch = globalThis.fetch;
let calls: Body[] = [];

// Install a fetch stub driven by a per-action responder. Each responder returns
// the AnkiConnect JSON body (or throws to simulate a transport failure).
function stubFetch(
  responders: Record<string, (params: Record<string, unknown>) => unknown>,
) {
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Body;
    calls.push(body);
    const responder = responders[body.action];
    if (!responder) throw new Error(`no stub for action ${body.action}`);
    const out = responder(body.params);
    if (out instanceof Error) throw out; // simulate connection-refused / abort
    return new Response(JSON.stringify(out), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

beforeEach(() => {
  calls = [];
  delete process.env.ANKI_FAKE;
  delete process.env.ZR_ANKICONNECT_DISABLE;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.ANKI_FAKE;
  delete process.env.ZR_ANKICONNECT_DISABLE;
});

// ---------------------------------------------------------------------------
describe("acAvailable", () => {
  test("returns true when version responds", async () => {
    stubFetch({ version: () => ({ result: 6, error: null }) });
    expect(await acAvailable()).toBe(true);
  });

  test("returns false on connection refusal (fetch throws)", async () => {
    stubFetch({ version: () => new Error("ECONNREFUSED 127.0.0.1:8765") });
    expect(await acAvailable()).toBe(false);
  });

  test("returns false under ANKI_FAKE=1 without ever calling fetch", async () => {
    process.env.ANKI_FAKE = "1";
    stubFetch({ version: () => ({ result: 6, error: null }) });
    expect(await acAvailable()).toBe(false);
    expect(calls.length).toBe(0);
  });

  test("returns false when ZR_ANKICONNECT_DISABLE=1", async () => {
    process.env.ZR_ANKICONNECT_DISABLE = "1";
    stubFetch({ version: () => ({ result: 6, error: null }) });
    expect(await acAvailable()).toBe(false);
    expect(calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe("acAddNote — card-shape parity with dbAddNote", () => {
  test("builds the exact Back+Front+Usage / Mixed / zehntage note", async () => {
    stubFetch({ addNote: () => ({ result: 1700000000001, error: null }) });
    const r = await acAddNote({
      front: "言葉 [ことば]",
      back: "word",
      notes: "my note",
      context: "in a sentence",
    });
    expect(r.ok).toBe(true);
    expect(r.noteId).toBe(1700000000001);

    expect(calls.length).toBe(1);
    const note = (calls[0]!.params as { note: Record<string, unknown> }).note;
    expect(note.deckName).toBe("Mixed");
    expect(note.modelName).toBe("Back+Front+Usage");
    expect(note.fields).toEqual({
      Front: "言葉 [ことば]",
      Back: "word",
      notes: "my note",
      context: "in a sentence",
    });
    expect(note.tags).toEqual(["zehntage"]);
    expect(note.options).toEqual({ allowDuplicate: false });
  });

  test("missing notes/context become empty strings (matches dbAddNote)", async () => {
    stubFetch({ addNote: () => ({ result: 1, error: null }) });
    await acAddNote({ front: "x", back: "y" });
    const note = (calls[0]!.params as { note: { fields: Record<string, string> } }).note;
    expect(note.fields.notes).toBe("");
    expect(note.fields.context).toBe("");
  });

  test("explicit tags override the zehntage default", async () => {
    stubFetch({ addNote: () => ({ result: 1, error: null }) });
    await acAddNote({ front: "x", back: "y", tags: ["zehntage", "extra"] });
    const note = (calls[0]!.params as { note: { tags: string[] } }).note;
    expect(note.tags).toEqual(["zehntage", "extra"]);
  });

  test("duplicate -> {ok:false, reason:'duplicate'}", async () => {
    stubFetch({
      addNote: () => ({
        result: null,
        error: "cannot create note because it is a duplicate",
      }),
    });
    const r = await acAddNote({ front: "dup", back: "b" });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("duplicate");
  });

  test("connection refused -> {ok:false, reason:'transport'}, never throws", async () => {
    stubFetch({ addNote: () => new Error("ECONNREFUSED") });
    const r = await acAddNote({ front: "x", back: "y" });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("transport");
  });

  test("addNote returns no id without error -> soft failure", async () => {
    stubFetch({ addNote: () => ({ result: null, error: null }) });
    const r = await acAddNote({ front: "x", back: "y" });
    expect(r.ok).toBe(false);
    expect(r.reason).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
describe("acDeleteByFront — findNotes then deleteNotes", () => {
  test("matches Front exactly, deletes the ids", async () => {
    stubFetch({
      findNotes: (p) => {
        expect(p.query).toBe('deck:Mixed Front:"言葉 [ことば]"');
        return { result: [111, 222], error: null };
      },
      deleteNotes: (p) => {
        expect(p.notes).toEqual([111, 222]);
        return { result: null, error: null };
      },
    });
    const r = await acDeleteByFront("言葉 [ことば]");
    expect(r.ok).toBe(true);
    expect(r.deleted).toBe(2);
    expect(calls.map((c) => c.action)).toEqual(["findNotes", "deleteNotes"]);
  });

  test("escapes quotes/backslashes in the front", async () => {
    stubFetch({
      findNotes: (p) => {
        expect(p.query).toBe('deck:Mixed Front:"a\\"b\\\\c"');
        return { result: [], error: null };
      },
    });
    await acDeleteByFront('a"b\\c');
  });

  test("no match -> {ok:false, reason:'not-found'}, deleteNotes never called", async () => {
    stubFetch({ findNotes: () => ({ result: [], error: null }) });
    const r = await acDeleteByFront("missing");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("not-found");
    expect(calls.map((c) => c.action)).toEqual(["findNotes"]);
  });

  test("findNotes connection refused -> transport, never throws", async () => {
    stubFetch({ findNotes: () => new Error("ECONNREFUSED") });
    const r = await acDeleteByFront("x");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("transport");
  });

  test("deleteNotes error -> {ok:false} with the error surfaced", async () => {
    stubFetch({
      findNotes: () => ({ result: [5], error: null }),
      deleteNotes: () => ({ result: null, error: "some failure" }),
    });
    const r = await acDeleteByFront("x");
    expect(r.ok).toBe(false);
    expect(r.error).toBe("some failure");
  });

  test("a single matching note → deleteNotes([id]), deleted:1", async () => {
    stubFetch({
      findNotes: () => ({ result: [777], error: null }),
      deleteNotes: (p) => {
        expect(p.notes).toEqual([777]);
        return { result: null, error: null };
      },
    });
    const r = await acDeleteByFront("solo");
    expect(r).toEqual({ ok: true, deleted: 1 });
  });

  test("several notes share a front → all ids deleted (un-mine the word)", async () => {
    stubFetch({
      findNotes: () => ({ result: [1, 2, 3], error: null }),
      deleteNotes: (p) => {
        expect(p.notes).toEqual([1, 2, 3]);
        return { result: null, error: null };
      },
    });
    const r = await acDeleteByFront("dup-front");
    expect(r.ok).toBe(true);
    expect(r.deleted).toBe(3);
  });

  test("findNotes {error:!null} (e.g. bad query) → failure, no deleteNotes", async () => {
    stubFetch({
      findNotes: () => ({ result: null, error: "invalid search" }),
    });
    const r = await acDeleteByFront("x");
    expect(r.ok).toBe(false);
    expect(r.error).toBe("invalid search");
    expect(r.reason).toBeUndefined(); // reachable-but-failed, NOT transport
    expect(calls.map((c) => c.action)).toEqual(["findNotes"]);
  });

  test("deleteNotes connection refused mid-delete → transport reason", async () => {
    stubFetch({
      findNotes: () => ({ result: [9], error: null }),
      deleteNotes: () => new Error("ECONNREFUSED"),
    });
    const r = await acDeleteByFront("x");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("transport");
  });

  test("only a backslash in the front is escaped", async () => {
    stubFetch({
      findNotes: (p) => {
        expect(p.query).toBe('deck:Mixed Front:"C:\\\\path"');
        return { result: [], error: null };
      },
    });
    await acDeleteByFront("C:\\path");
  });

  test("a front with no special chars passes through unescaped", async () => {
    stubFetch({
      findNotes: (p) => {
        expect(p.query).toBe('deck:Mixed Front:"猫 [ねこ]"');
        return { result: [], error: null };
      },
    });
    await acDeleteByFront("猫 [ねこ]");
  });
});

// ---------------------------------------------------------------------------
// Transport / protocol edge cases shared across actions: timeout (AbortError),
// HTTP non-200, malformed JSON. All must map cleanly without throwing — and the
// transport ones must be distinguishable so review.ts can fall back to the DB.
// ---------------------------------------------------------------------------
describe("acAvailable — probe failure modes", () => {
  test("AnkiConnect {error:!null} on the version probe → not available", async () => {
    // Reachable but the version action itself errored → treat as unavailable
    // (no usable numeric version), NOT a crash.
    stubFetch({ version: () => ({ result: null, error: "collection is not open" }) });
    expect(await acAvailable()).toBe(false);
  });

  test("version returns a non-number result → not available", async () => {
    stubFetch({ version: () => ({ result: "six", error: null }) });
    expect(await acAvailable()).toBe(false);
  });

  test("HTTP 500 from the endpoint → not available, never throws", async () => {
    globalThis.fetch = (async () =>
      new Response("nope", { status: 500 })) as unknown as typeof fetch;
    expect(await acAvailable()).toBe(false);
  });

  test("timeout (AbortError) is treated as unavailable", async () => {
    // Simulate the AbortController firing: fetch rejects with an AbortError, the
    // same shape acRaw's catch maps to a transport failure.
    globalThis.fetch = (async () => {
      const e = new Error("The operation was aborted.");
      e.name = "AbortError";
      throw e;
    }) as unknown as typeof fetch;
    expect(await acAvailable()).toBe(false);
  });
});

describe("acAddNote — transport/protocol edge cases", () => {
  test("HTTP 500 → {ok:false}, reachable (reason undefined, NOT transport)", async () => {
    globalThis.fetch = (async () =>
      new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const r = await acAddNote({ front: "x", back: "y" });
    expect(r.ok).toBe(false);
    expect(r.reason).toBeUndefined();
    expect(r.error).toContain("HTTP 500");
  });

  test("malformed JSON body → {ok:false} reachable, never throws", async () => {
    globalThis.fetch = (async () =>
      new Response("<html>not json</html>", {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const r = await acAddNote({ front: "x", back: "y" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("bad JSON");
    expect(r.reason).toBeUndefined();
  });

  test("timeout (AbortError) → transport failure", async () => {
    globalThis.fetch = (async () => {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }) as unknown as typeof fetch;
    const r = await acAddNote({ front: "x", back: "y" });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("transport");
  });

  test("disabled via ANKI_FAKE=1 → transport failure, fetch never called", async () => {
    process.env.ANKI_FAKE = "1";
    stubFetch({ addNote: () => ({ result: 1, error: null }) });
    const r = await acAddNote({ front: "x", back: "y" });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("transport");
    expect(calls.length).toBe(0);
  });

  test("explicit empty tags array falls back to the zehntage default", async () => {
    // [] is "no tags" → the client uses the ZR_TAG default (matches dbAddNote).
    stubFetch({ addNote: () => ({ result: 1, error: null }) });
    await acAddNote({ front: "x", back: "y", tags: [] });
    const note = (calls[0]!.params as { note: { tags: string[] } }).note;
    expect(note.tags).toEqual(["zehntage"]);
  });
});

describe("acDeleteByFront — transport/protocol edge cases", () => {
  test("HTTP 500 on findNotes → {ok:false} reachable, no deleteNotes", async () => {
    globalThis.fetch = (async () =>
      new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const r = await acDeleteByFront("x");
    expect(r.ok).toBe(false);
    expect(r.reason).toBeUndefined();
  });

  test("disabled via ZR_ANKICONNECT_DISABLE=1 → transport, fetch never called", async () => {
    process.env.ZR_ANKICONNECT_DISABLE = "1";
    stubFetch({ findNotes: () => ({ result: [1], error: null }) });
    const r = await acDeleteByFront("x");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("transport");
    expect(calls.length).toBe(0);
  });
});
