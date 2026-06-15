// ---------------------------------------------------------------------------
// Backend routing for the review engine (src/lib/review.ts).
//
// Stage 2b-1: DB-DIRECT ONLY. AnkiConnect (localhost:8765) is NO LONGER CALLED
// for any real read or write. The routing under test is now:
//
//   ANY *Auto:  ANKI_FAKE=1 -> the in-memory fake (test double, NOT AnkiConnect)
//               else        -> DB-direct (ankidb.ts)
//
//   READ  (reviewQueueAuto / deckCountsAuto): DB-direct unconditionally when
//         dbDirectEnabled() && present && schemaOk (works even while Anki is
//         open — the snapshot may lag, which is acceptable). No AnkiConnect
//         fallback; unavailable DB -> {available:false}/zeros.
//   WRITE (answerCardAuto / deleteNoteAuto / addNoteAuto): DB-direct
//         unconditionally. dbAnswerCard/dbDeleteNote/dbAddNote fail-closed when
//         Anki holds the collection (reason "anki-open"/"locked"), so grading
//         while Anki is open is safely REFUSED — forwarded verbatim, never a
//         silent ok, never a write.
//   STATUS(reviewStatus): canQueue = present && schemaOk;
//         canAnswer = dbDirectEnabled && present && schemaOk && !ankiOpen.
//         ankiOpen is retained so the UI can tell the user to close Anki.
//
// We can't drive this branch via ANKI_FAKE alone — that env flag forces every
// dependency into fake mode simultaneously, so it can only exercise the single
// fake path. And bun's mock.module() patches the GLOBAL module registry for the
// whole test run with no restore, which would corrupt anki.test.ts /
// ankidb.test.ts (they import these modules for real). So review.ts exposes an
// internal, test-only dependency seam (__setReviewDeps) that swaps the backend
// functions and returns a restore fn — zero global leakage. We assert the
// OBSERVABLE routing through the exported functions, plus ANKI_FAKE smokes.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  __setReviewDeps,
  reviewQueueAuto,
  deckCountsAuto,
  answerCardAuto,
  deleteNoteAuto,
  addNoteAuto,
  reviewStatus,
} from "../src/lib/review.ts";

// A DbStatus factory with sensible defaults; override per test.
function dbStatus(over: Partial<{
  present: boolean;
  ankiOpen: boolean;
  ver: number;
  schemaOk: boolean;
}> = {}) {
  return {
    present: true,
    ankiOpen: false,
    ver: 18,
    schemaOk: true,
    ...over,
  };
}

const card = (cardId: number) => ({
  cardId,
  question: "q",
  answer: "a",
  front: "f",
});

// Track calls so we can assert WHICH backend was hit. The `ac*` spies must stay
// at 0 for every real (non-fake) path — that is the core of the cutover.
interface Spy {
  acReviewQueue: number;
  acAnswerCard: number;
  acDeleteNote: number;
  acAddCard: number;
  dbReviewQueue: number;
  dbDeckCounts: number;
  dbAnswerCard: number;
  dbDeleteNote: number;
  dbAddNote: number;
}

// Install a fully-stubbed dep set for a given world; returns {restore, spy}.
//
// `ankiOpen` drives dbStatus().ankiOpen. The DB WRITE stubs model the real
// ankidb fail-closed behavior: when Anki is open they refuse with
// {ok:false, reason:"anki-open"} unless the test supplies an explicit result.
function world(opts: {
  ankiOpen: boolean;
  present?: boolean;
  schemaOk?: boolean;
  dbQueueAvailable?: boolean;
  dbAnswerResult?: { ok: boolean; error?: string; reason?: string };
  dbAnswerThrows?: boolean;
  dbDeleteResult?: { ok: boolean; error?: string; reason?: string };
  dbDeleteThrows?: boolean;
  dbAddResult?: { ok: boolean; error?: string; reason?: string; noteId?: number; cardIds?: number[] };
  dbAddThrows?: boolean;
}) {
  const spy: Spy = {
    acReviewQueue: 0,
    acAnswerCard: 0,
    acDeleteNote: 0,
    acAddCard: 0,
    dbReviewQueue: 0,
    dbDeckCounts: 0,
    dbAnswerCard: 0,
    dbDeleteNote: 0,
    dbAddNote: 0,
  };
  // Default DB-write result honoring fail-closed when Anki is open.
  const failClosed = { ok: false, reason: "anki-open", error: "Anki is open" };
  const restore = __setReviewDeps({
    acReviewQueue: async (_scope, _limit) => {
      spy.acReviewQueue++;
      // Models the ANKI_FAKE in-memory fake queue (offline, never AnkiConnect).
      return { available: true, due: 2, cards: [card(1), card(2)] };
    },
    dbStatus: () =>
      dbStatus({
        ankiOpen: opts.ankiOpen,
        present: opts.present ?? true,
        schemaOk: opts.schemaOk ?? true,
      }),
    dbReviewQueue: (_scope, _limit) => {
      spy.dbReviewQueue++;
      const available = opts.dbQueueAvailable ?? true;
      return available
        ? { available: true, due: 3, cards: [card(300)] }
        : { available: false, due: 0, cards: [] };
    },
    dbDeckCounts: (_scope) => {
      spy.dbDeckCounts++;
      return { new: 1, learning: 2, review: 4 };
    },
    acAnswerCard: async (_id, _ease) => {
      spy.acAnswerCard++;
      return { ok: true };
    },
    dbAnswerCard: async (_id, _ease) => {
      spy.dbAnswerCard++;
      if (opts.dbAnswerThrows) throw new Error("disk on fire");
      return opts.dbAnswerResult ?? (opts.ankiOpen ? failClosed : { ok: true });
    },
    acDeleteNote: async (_id) => {
      spy.acDeleteNote++;
      return { ok: true };
    },
    dbDeleteNote: async (_id) => {
      spy.dbDeleteNote++;
      if (opts.dbDeleteThrows) throw new Error("disk ablaze");
      return opts.dbDeleteResult ?? (opts.ankiOpen ? failClosed : { ok: true });
    },
    acAddCard: async (_card) => {
      spy.acAddCard++;
    },
    dbAddNote: async (_card, _hooks) => {
      spy.dbAddNote++;
      if (opts.dbAddThrows) throw new Error("disk inferno");
      return (
        opts.dbAddResult ??
        (opts.ankiOpen ? failClosed : { ok: true, noteId: 12345, cardIds: [12346] })
      );
    },
  });
  return { restore, spy };
}

let restore: (() => void) | null = null;
// Defensive: another test file may have left ANKI_FAKE set in the shared
// process env. The non-fake routing here depends on dbDirectEnabled() being
// true, so clear it before each test (and after, for our own fake-mode tests).
beforeEach(() => {
  delete process.env.ANKI_FAKE;
});
afterEach(() => {
  restore?.();
  restore = null;
  delete process.env.ANKI_FAKE;
});

// ---------------------------------------------------------------------------
describe("reviewQueueAuto / deckCountsAuto routing (DB-direct only)", () => {
  test("Anki CLOSED -> queue+counts use the DB read, never AnkiConnect", async () => {
    const w = world({ ankiOpen: false });
    restore = w.restore;

    const q = await reviewQueueAuto("zehntage", 50);
    expect(q.backend).toBe("db");
    expect(q.due).toBe(3);
    expect(w.spy.dbReviewQueue).toBe(1);

    const c = await deckCountsAuto("zehntage");
    expect(c).toEqual({ new: 1, learning: 2, review: 4 });
    expect(w.spy.dbDeckCounts).toBe(1);
  });

  test("Anki OPEN -> queue+counts STILL use the DB read (snapshot may lag, that's ok)", async () => {
    const w = world({ ankiOpen: true });
    restore = w.restore;

    const q = await reviewQueueAuto("zehntage", 50);
    expect(q.backend).toBe("db");
    expect(q.due).toBe(3);
    expect(w.spy.dbReviewQueue).toBe(1);

    const c = await deckCountsAuto("zehntage");
    expect(c).toEqual({ new: 1, learning: 2, review: 4 });
    expect(w.spy.dbDeckCounts).toBe(1);
  });

  test("DB queue unavailable -> {available:false}, NO AnkiConnect fallback", async () => {
    const w = world({ ankiOpen: false, dbQueueAvailable: false });
    restore = w.restore;

    const q = await reviewQueueAuto("zehntage", 50);
    expect(w.spy.dbReviewQueue).toBe(1);
    expect(q.available).toBe(false);
    expect(q.backend).toBe("db");
    expect(q.due).toBe(0);
    expect(q.cards).toEqual([]);
  });

  test("schema not understood -> no DB read, returns unavailable/zeros", async () => {
    const w = world({ ankiOpen: false, schemaOk: false });
    restore = w.restore;

    const q = await reviewQueueAuto("zehntage", 50);
    expect(w.spy.dbReviewQueue).toBe(0); // gate failed: schemaOk=false
    expect(q.available).toBe(false);
    expect(q.backend).toBe("db");

    const c = await deckCountsAuto("zehntage");
    expect(w.spy.dbDeckCounts).toBe(0);
    expect(c).toEqual({ new: 0, learning: 0, review: 0 });
  });

  test("ANKI_FAKE=1 -> queue+counts serve the in-memory fake, NEVER the real DB", async () => {
    process.env.ANKI_FAKE = "1";
    const w = world({ ankiOpen: false });
    restore = w.restore;

    const q = await reviewQueueAuto("zehntage", 50);
    expect(w.spy.acReviewQueue).toBe(1); // served by the fake queue...
    expect(w.spy.dbReviewQueue).toBe(0); // ...and NEVER the real DB
    expect(q.available).toBe(true);
    expect(q.due).toBe(2);

    const c = await deckCountsAuto("zehntage");
    expect(w.spy.acReviewQueue).toBe(2); // counts derived from the fake queue
    expect(w.spy.dbDeckCounts).toBe(0); // ...and NEVER the real DB
    expect(c).toEqual({ new: 0, learning: 0, review: 2 });
  });
});

// ---------------------------------------------------------------------------
describe("answerCardAuto routing (DB-direct only) + reason surfacing", () => {
  test("Anki CLOSED -> dbAnswerCard (windowless write), never AnkiConnect", async () => {
    const w = world({ ankiOpen: false, dbAnswerResult: { ok: true } });
    restore = w.restore;

    const r = await answerCardAuto(123, 4);
    expect(r.ok).toBe(true);
    expect(r.backend).toBe("db");
    expect(w.spy.dbAnswerCard).toBe(1);
    expect(w.spy.acAnswerCard).toBe(0);
  });

  test("Anki OPEN -> dbAnswerCard fails-closed; grade is REFUSED, not silently ok", async () => {
    const w = world({ ankiOpen: true });
    restore = w.restore;

    const r = await answerCardAuto(123, 3);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("anki-open"); // forwarded verbatim from dbAnswerCard
    expect(r.backend).toBe("db");
    expect(w.spy.dbAnswerCard).toBe(1); // attempted the DB write...
    expect(w.spy.acAnswerCard).toBe(0); // ...and NEVER AnkiConnect
  });

  test("Anki CLOSED, DB refuses (locked) -> forwards reason verbatim", async () => {
    const w = world({
      ankiOpen: false,
      dbAnswerResult: { ok: false, reason: "locked", error: "WAL is hot" },
    });
    restore = w.restore;

    const r = await answerCardAuto(123, 2);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("locked");
    expect(r.error).toBe("WAL is hot");
    expect(r.backend).toBe("db");
  });

  test("DB write THROWS -> surfaces a reason, not a silent ok", async () => {
    const w = world({ ankiOpen: false, dbAnswerThrows: true });
    restore = w.restore;

    const r = await answerCardAuto(123, 3);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("db-write-threw");
    expect(r.error).toContain("disk on fire");
  });

  test("ANKI_FAKE=1 -> answer routes to the fake, NEVER the DB write", async () => {
    process.env.ANKI_FAKE = "1";
    const w = world({ ankiOpen: false });
    restore = w.restore;

    const r = await answerCardAuto(999, 3);
    expect(r.backend).toBe("ankiconnect"); // fake double reports this backend tag
    expect(w.spy.acAnswerCard).toBe(1); // fake branch hits the fake stub
    expect(w.spy.dbAnswerCard).toBe(0); // and NEVER the DB write
  });
});

// ---------------------------------------------------------------------------
describe("reviewStatus (DB-direct only)", () => {
  test("Anki closed + present + schemaOk -> canQueue && canAnswer", async () => {
    const w = world({ ankiOpen: false });
    restore = w.restore;
    const s = await reviewStatus();
    expect(s.canQueue).toBe(true);
    expect(s.canAnswer).toBe(true);
    expect(s.ankiOpen).toBe(false);
  });

  test("Anki OPEN -> canQueue true (reads ok) but canAnswer FALSE (write blocked)", async () => {
    const w = world({ ankiOpen: true });
    restore = w.restore;
    const s = await reviewStatus();
    expect(s.canQueue).toBe(true); // snapshot read still works
    expect(s.canAnswer).toBe(false); // windowless write blocked while Anki open
    expect(s.ankiOpen).toBe(true); // retained so the UI can message it
  });

  test("Anki closed + collection absent -> canQueue && canAnswer false", async () => {
    const w = world({ ankiOpen: false, present: false, schemaOk: false });
    restore = w.restore;
    const s = await reviewStatus();
    expect(s.canAnswer).toBe(false);
    expect(s.canQueue).toBe(false);
  });

  test("ANKI_FAKE=1 -> DB-direct gated off; canAnswer false even when otherwise ready", async () => {
    process.env.ANKI_FAKE = "1";
    const w = world({ ankiOpen: false });
    restore = w.restore;
    const s = await reviewStatus();
    expect(s.canAnswer).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("deleteNoteAuto routing (DB-direct only)", () => {
  test("Anki CLOSED -> dbDeleteNote, never AnkiConnect", async () => {
    const w = world({ ankiOpen: false, dbDeleteResult: { ok: true } });
    restore = w.restore;

    const r = await deleteNoteAuto(456);
    expect(r.ok).toBe(true);
    expect(r.backend).toBe("db");
    expect(w.spy.dbDeleteNote).toBe(1);
    expect(w.spy.acDeleteNote).toBe(0);
  });

  test("Anki OPEN -> dbDeleteNote fails-closed; REFUSED, never AnkiConnect", async () => {
    const w = world({ ankiOpen: true });
    restore = w.restore;

    const r = await deleteNoteAuto(456);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("anki-open");
    expect(r.backend).toBe("db");
    expect(w.spy.dbDeleteNote).toBe(1);
    expect(w.spy.acDeleteNote).toBe(0);
  });

  test("Anki CLOSED, DB refuses -> forwards dbDeleteNote's reason verbatim", async () => {
    const w = world({
      ankiOpen: false,
      dbDeleteResult: { ok: false, reason: "locked", error: "WAL is hot" },
    });
    restore = w.restore;

    const r = await deleteNoteAuto(789);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("locked");
    expect(r.error).toBe("WAL is hot");
    expect(r.backend).toBe("db");
  });

  test("DB delete THROWS -> surfaces a reason, not a silent ok", async () => {
    const w = world({ ankiOpen: false, dbDeleteThrows: true });
    restore = w.restore;

    const r = await deleteNoteAuto(111);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("db-write-threw");
    expect(r.error).toContain("disk ablaze");
  });

  test("ANKI_FAKE=1 -> fake delete branch (fake stub called, never DB)", async () => {
    process.env.ANKI_FAKE = "1";
    const w = world({ ankiOpen: false });
    restore = w.restore;

    const r = await deleteNoteAuto(999);
    expect(r.backend).toBe("ankiconnect");
    expect(w.spy.acDeleteNote).toBe(1);
    expect(w.spy.dbDeleteNote).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe("addNoteAuto routing (DB-direct only)", () => {
  const sampleCard = {
    front: "言葉 [ことば]",
    back: "word",
    notes: "n",
    context: "c",
    tags: ["zehntage"],
  };

  test("Anki CLOSED -> windowless dbAddNote, never AnkiConnect", async () => {
    const w = world({ ankiOpen: false });
    restore = w.restore;
    const r = await addNoteAuto(sampleCard);
    expect(r.ok).toBe(true);
    expect(r.backend).toBe("db");
    expect(w.spy.dbAddNote).toBe(1);
    expect(w.spy.acAddCard).toBe(0);
  });

  test("Anki OPEN -> dbAddNote fails-closed; REFUSED, never AnkiConnect", async () => {
    const w = world({ ankiOpen: true });
    restore = w.restore;
    const r = await addNoteAuto(sampleCard);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("anki-open");
    expect(r.backend).toBe("db");
    expect(w.spy.dbAddNote).toBe(1);
    expect(w.spy.acAddCard).toBe(0);
  });

  test("Anki CLOSED + dbAddNote refuses -> reason forwarded", async () => {
    const w = world({
      ankiOpen: false,
      dbAddResult: { ok: false, reason: "duplicate" },
    });
    restore = w.restore;
    const r = await addNoteAuto(sampleCard);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("duplicate");
    expect(r.backend).toBe("db");
  });

  test("Anki CLOSED + dbAddNote throws -> db-write-threw", async () => {
    const w = world({ ankiOpen: false, dbAddThrows: true });
    restore = w.restore;
    const r = await addNoteAuto(sampleCard);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("db-write-threw");
    expect(r.backend).toBe("db");
  });

  test("ANKI_FAKE=1 -> fake add branch (fake stub called, never DB)", async () => {
    process.env.ANKI_FAKE = "1";
    const w = world({ ankiOpen: false });
    restore = w.restore;
    const r = await addNoteAuto(sampleCard);
    expect(r.ok).toBe(true);
    expect(r.backend).toBe("ankiconnect");
    expect(w.spy.acAddCard).toBe(1);
    expect(w.spy.dbAddNote).toBe(0);
  });
});
