// ---------------------------------------------------------------------------
// Routing for the player's `a` hotkey (mine / un-mine) so it ALWAYS works
// without ever risking the real collection. addNoteAuto / deleteNoteByFrontAuto
// pick the write channel by Anki state:
//
//   1. AnkiConnect reachable  -> add/delete THROUGH the running Anki (SAFE when
//      Anki is open; never touches the DB file).
//   2. else canWrite passes (Anki closed) -> direct-DB dbAddNote / dbDeleteNoteByFront.
//   3. else (Anki open, no AnkiConnect) -> {ok:false, reason:"anki-open", error:"...AnkiConnect..."}.
//
// We drive this through review.ts's test-only __setReviewDeps seam (no global
// module patching, no real network). The AnkiConnect client itself is unit-
// tested for card-shape parity in ankiconnect-client.test.ts.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  __setReviewDeps,
  addNoteAuto,
  deleteNoteByFrontAuto,
} from "../src/lib/review.ts";
import type { AnkiCard } from "../src/lib/anki.ts";
import type { CanWriteResult } from "../src/lib/ankilock.ts";

const sampleCard: AnkiCard = {
  front: "言葉 [ことば]",
  back: "word",
  notes: "n",
  context: "c",
  tags: ["zehntage"],
};

interface Spy {
  acAvailable: number;
  acAddNote: number;
  acDeleteByFront: number;
  dbAddNote: number;
  dbDeleteNoteByFront: number;
  canWrite: number;
}

// Build a world. `acUp` toggles AnkiConnect reachability; `canWriteResult`
// models the ankilock gate (Anki closed → {ok:true}; Anki open → anki-open).
function world(opts: {
  acUp: boolean;
  canWriteResult?: CanWriteResult;
  acAddResult?: { ok: boolean; error?: string; reason?: string; noteId?: number };
  acDeleteResult?: { ok: boolean; error?: string; reason?: string; deleted?: number };
  acAvailableThrows?: boolean;
  acAddThrows?: boolean;
  dbAddResult?: { ok: boolean; error?: string; reason?: string };
  dbDeleteResult?: { ok: boolean; error?: string; reason?: string };
  capture?: { addNote?: (c: unknown) => void };
}) {
  const spy: Spy = {
    acAvailable: 0,
    acAddNote: 0,
    acDeleteByFront: 0,
    dbAddNote: 0,
    dbDeleteNoteByFront: 0,
    canWrite: 0,
  };
  const restore = __setReviewDeps({
    acAvailable: async () => {
      spy.acAvailable++;
      if (opts.acAvailableThrows) throw new Error("probe boom");
      return opts.acUp;
    },
    acAddNote: async (c) => {
      spy.acAddNote++;
      opts.capture?.addNote?.(c);
      if (opts.acAddThrows) throw new Error("add boom");
      return opts.acAddResult ?? { ok: true, noteId: 42 };
    },
    acDeleteByFront: async (_front) => {
      spy.acDeleteByFront++;
      return opts.acDeleteResult ?? { ok: true, deleted: 1 };
    },
    canWrite: (_p) => {
      spy.canWrite++;
      return opts.canWriteResult ?? { ok: true };
    },
    collectionPath: () => "/tmp/fake/collection.anki2",
    dbAddNote: async (_card, _hooks) => {
      spy.dbAddNote++;
      return opts.dbAddResult ?? { ok: true, noteId: 7, cardIds: [8] };
    },
    dbDeleteNoteByFront: async (_front) => {
      spy.dbDeleteNoteByFront++;
      return opts.dbDeleteResult ?? { ok: true };
    },
  });
  return { restore, spy };
}

let restore: (() => void) | null = null;
beforeEach(() => {
  delete process.env.ANKI_FAKE;
});
afterEach(() => {
  restore?.();
  restore = null;
  delete process.env.ANKI_FAKE;
});

// ---------------------------------------------------------------------------
describe("addNoteAuto — AnkiConnect-first routing", () => {
  test("AnkiConnect reachable -> add via AnkiConnect, never the DB", async () => {
    const w = world({ acUp: true });
    restore = w.restore;
    const r = await addNoteAuto(sampleCard);
    expect(r.ok).toBe(true);
    expect(r.backend).toBe("ankiconnect");
    expect(w.spy.acAvailable).toBe(1);
    expect(w.spy.acAddNote).toBe(1);
    expect(w.spy.dbAddNote).toBe(0); // DB file never touched while Anki open
  });

  test("AnkiConnect down + canWrite ok (Anki closed) -> direct-DB add", async () => {
    const w = world({ acUp: false, canWriteResult: { ok: true } });
    restore = w.restore;
    const r = await addNoteAuto(sampleCard);
    expect(r.ok).toBe(true);
    expect(r.backend).toBe("db");
    expect(w.spy.acAvailable).toBe(1);
    expect(w.spy.acAddNote).toBe(0);
    expect(w.spy.dbAddNote).toBe(1);
  });

  test("AnkiConnect down + Anki open -> refuse anki-open, no DB write", async () => {
    const w = world({
      acUp: false,
      canWriteResult: { ok: false, reason: "anki-open" },
    });
    restore = w.restore;
    const r = await addNoteAuto(sampleCard);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("anki-open");
    expect(r.error).toContain("AnkiConnect");
    expect(w.spy.dbAddNote).toBe(0); // critical: DB untouched while Anki holds it
  });

  test("AnkiConnect down + collection locked -> refuse, no DB write", async () => {
    const w = world({
      acUp: false,
      canWriteResult: { ok: false, reason: "locked" },
    });
    restore = w.restore;
    const r = await addNoteAuto(sampleCard);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("anki-open");
    expect(w.spy.dbAddNote).toBe(0);
  });

  test("AnkiConnect down + canWrite fails for a NON-lock reason (schema) -> DB path runs and reports it", async () => {
    // A schema/missing failure is the DB writer's own concern; routing should
    // still hand off to dbAddNote (which fails-closed and reports the reason),
    // not the "Anki open" message.
    const w = world({
      acUp: false,
      canWriteResult: { ok: false, reason: "schema" },
      dbAddResult: { ok: false, reason: "schema" },
    });
    restore = w.restore;
    const r = await addNoteAuto(sampleCard);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("schema");
    expect(w.spy.dbAddNote).toBe(1);
  });

  test("AnkiConnect add reports duplicate -> forwarded verbatim", async () => {
    const w = world({
      acUp: true,
      acAddResult: { ok: false, reason: "duplicate", error: "cannot create note because it is a duplicate" },
    });
    restore = w.restore;
    const r = await addNoteAuto(sampleCard);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("duplicate");
    expect(r.backend).toBe("ankiconnect");
  });

  test("probe throws -> falls through to the fail-closed DB path", async () => {
    const w = world({
      acUp: true,
      acAvailableThrows: true,
      canWriteResult: { ok: true },
    });
    restore = w.restore;
    const r = await addNoteAuto(sampleCard);
    expect(r.ok).toBe(true);
    expect(r.backend).toBe("db");
    expect(w.spy.acAddNote).toBe(0);
    expect(w.spy.dbAddNote).toBe(1);
  });

  test("field/deck/tag payload handed to acAddNote mirrors dbAddNote's shape", async () => {
    let captured: unknown = null;
    const w = world({ acUp: true, capture: { addNote: (c) => (captured = c) } });
    restore = w.restore;
    await addNoteAuto({
      front: "言葉 [ことば]",
      back: "word",
      notes: "my note",
      context: "in a sentence",
      tags: ["zehntage"],
    });
    expect(captured).toEqual({
      front: "言葉 [ことば]",
      back: "word",
      notes: "my note",
      context: "in a sentence",
      tags: ["zehntage"],
    });
  });

  test("default tag is zehntage when the card omits tags", async () => {
    const captured: { tags?: string[] }[] = [];
    const w = world({ acUp: true, capture: { addNote: (c) => captured.push(c as { tags?: string[] }) } });
    restore = w.restore;
    await addNoteAuto({ front: "x", back: "y" } as AnkiCard);
    expect(captured[0]?.tags).toEqual(["zehntage"]);
  });
});

// ---------------------------------------------------------------------------
describe("deleteNoteByFrontAuto — AnkiConnect-first routing", () => {
  test("AnkiConnect reachable -> delete via AnkiConnect, never the DB", async () => {
    const w = world({ acUp: true });
    restore = w.restore;
    const r = await deleteNoteByFrontAuto("言葉 [ことば]");
    expect(r.ok).toBe(true);
    expect(r.backend).toBe("ankiconnect");
    expect(w.spy.acDeleteByFront).toBe(1);
    expect(w.spy.dbDeleteNoteByFront).toBe(0);
  });

  test("AnkiConnect down + Anki closed -> direct-DB delete-by-front", async () => {
    const w = world({ acUp: false, canWriteResult: { ok: true } });
    restore = w.restore;
    const r = await deleteNoteByFrontAuto("言葉 [ことば]");
    expect(r.ok).toBe(true);
    expect(r.backend).toBe("db");
    expect(w.spy.dbDeleteNoteByFront).toBe(1);
  });

  test("AnkiConnect down + Anki open -> refuse anki-open, no DB write", async () => {
    const w = world({
      acUp: false,
      canWriteResult: { ok: false, reason: "anki-open" },
    });
    restore = w.restore;
    const r = await deleteNoteByFrontAuto("言葉 [ことば]");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("anki-open");
    expect(r.error).toContain("AnkiConnect");
    expect(w.spy.dbDeleteNoteByFront).toBe(0);
  });

  test("AnkiConnect not-found -> forwarded (server maps it to an ok no-op)", async () => {
    const w = world({
      acUp: true,
      acDeleteResult: { ok: false, reason: "not-found", deleted: 0 },
    });
    restore = w.restore;
    const r = await deleteNoteByFrontAuto("missing");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("not-found");
    expect(r.backend).toBe("ankiconnect");
  });

  test("ANKI_FAKE=1 -> fake by-front branch, never AnkiConnect or the DB", async () => {
    process.env.ANKI_FAKE = "1";
    const w = world({ acUp: true });
    restore = w.restore;
    const r = await deleteNoteByFrontAuto("言葉 [ことば]");
    expect(r.backend).toBe("ankiconnect"); // fake branch reports this tag
    expect(w.spy.acDeleteByFront).toBe(0); // real AnkiConnect client untouched
    expect(w.spy.dbDeleteNoteByFront).toBe(0);
  });
});
