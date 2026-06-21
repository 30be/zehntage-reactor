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
});
