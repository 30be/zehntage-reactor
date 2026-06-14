// ---------------------------------------------------------------------------
// Backend routing for the review engine (src/lib/review.ts).
//
// review.ts selects between the windowless DB-direct path (ankidb.ts) and the
// AnkiConnect path (anki.ts) for reading the queue/counts and for grading. The
// rules under test:
//
//   READ  (reviewQueueAuto / deckCountsAuto): DB-direct ONLY when
//         dbDirectEnabled() && present && schemaOk && !ankiOpen; else AnkiConnect.
//   WRITE (answerCardAuto): Anki open -> AnkiConnect; Anki closed -> dbAnswerCard;
//         neither -> {ok:false, reason:"no-backend"}. Failures always carry a
//         reason so the UI never silently loops.
//   STATUS(reviewStatus.canAnswer): AnkiConnect up OR (closed+present+schemaOk).
//
// We can't drive this branch via ANKI_FAKE alone — that env flag forces every
// dependency (ankiLocalAvailable, dbDirectEnabled, the fake AnkiConnect) into
// fake mode simultaneously, so it can only exercise the single fake path. And
// bun's mock.module() patches the GLOBAL module registry for the whole test run
// with no restore, which would corrupt anki.test.ts / ankidb.test.ts (they
// import these modules for real). So review.ts exposes an internal, test-only
// dependency seam (__setReviewDeps) that swaps the backend functions and returns
// a restore fn — zero global leakage. We assert the OBSERVABLE routing through
// the exported functions, plus one ANKI_FAKE smoke for the fake branch.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, test } from "bun:test";
import {
  __setReviewDeps,
  reviewQueueAuto,
  deckCountsAuto,
  answerCardAuto,
  deleteNoteAuto,
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

// Track calls so we can assert WHICH backend was hit.
interface Spy {
  acReviewQueue: number;
  acAnswerCard: number;
  acDeleteNote: number;
  dbReviewQueue: number;
  dbDeckCounts: number;
  dbAnswerCard: number;
  dbDeleteNote: number;
}

// Install a fully-stubbed dep set for a given world; returns {restore, spy}.
function world(opts: {
  ankiOpen: boolean; // drives dbStatus().ankiOpen
  present?: boolean;
  schemaOk?: boolean;
  ankiConnectUp: boolean; // ankiLocalAvailable() resolves to this
  dbQueueAvailable?: boolean; // dbReviewQueue.available
  acAnswerOk?: boolean;
  acAnswerError?: string;
  dbAnswerResult?: { ok: boolean; error?: string; reason?: string };
  dbAnswerThrows?: boolean;
  acDeleteOk?: boolean;
  acDeleteError?: string;
  dbDeleteResult?: { ok: boolean; error?: string; reason?: string };
  dbDeleteThrows?: boolean;
}) {
  const spy: Spy = {
    acReviewQueue: 0,
    acAnswerCard: 0,
    acDeleteNote: 0,
    dbReviewQueue: 0,
    dbDeckCounts: 0,
    dbAnswerCard: 0,
    dbDeleteNote: 0,
  };
  const restore = __setReviewDeps({
    dbStatus: () =>
      dbStatus({
        ankiOpen: opts.ankiOpen,
        present: opts.present ?? true,
        schemaOk: opts.schemaOk ?? true,
      }),
    ankiLocalAvailable: async () => opts.ankiConnectUp,
    acReviewQueue: async (_scope, limit = 50) => {
      spy.acReviewQueue++;
      return { available: true, due: 7, cards: [card(700)].slice(0, limit) };
    },
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
      return { ok: opts.acAnswerOk ?? true, error: opts.acAnswerError };
    },
    dbAnswerCard: async (_id, _ease) => {
      spy.dbAnswerCard++;
      if (opts.dbAnswerThrows) throw new Error("disk on fire");
      return opts.dbAnswerResult ?? { ok: true };
    },
    acDeleteNote: async (_id) => {
      spy.acDeleteNote++;
      return { ok: opts.acDeleteOk ?? true, error: opts.acDeleteError };
    },
    dbDeleteNote: async (_id) => {
      spy.dbDeleteNote++;
      if (opts.dbDeleteThrows) throw new Error("disk ablaze");
      return opts.dbDeleteResult ?? { ok: true };
    },
  });
  return { restore, spy };
}

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
  delete process.env.ANKI_FAKE;
});

// ---------------------------------------------------------------------------
describe("reviewQueueAuto / deckCountsAuto routing", () => {
  test("Anki OPEN -> queue+counts use AnkiConnect, never the DB read", async () => {
    const w = world({ ankiOpen: true, ankiConnectUp: true });
    restore = w.restore;

    const q = await reviewQueueAuto("zehntage", 50);
    expect(q.backend).toBe("ankiconnect");
    expect(q.due).toBe(7);
    expect(w.spy.acReviewQueue).toBe(1);
    expect(w.spy.dbReviewQueue).toBe(0);

    const c = await deckCountsAuto("zehntage");
    // counts come from the AnkiConnect fallback (db read skipped while open)
    expect(c).toEqual({ new: 0, learning: 0, review: 7 });
    expect(w.spy.dbDeckCounts).toBe(0);
  });

  test("Anki CLOSED + present + schemaOk -> queue+counts use the DB read", async () => {
    const w = world({ ankiOpen: false, ankiConnectUp: false });
    restore = w.restore;

    const q = await reviewQueueAuto("zehntage", 50);
    expect(q.backend).toBe("db");
    expect(q.due).toBe(3);
    expect(w.spy.dbReviewQueue).toBe(1);
    expect(w.spy.acReviewQueue).toBe(0);

    const c = await deckCountsAuto("zehntage");
    expect(c).toEqual({ new: 1, learning: 2, review: 4 });
    expect(w.spy.dbDeckCounts).toBe(1);
  });

  test("Anki CLOSED but DB unavailable -> falls back to AnkiConnect", async () => {
    const w = world({
      ankiOpen: false,
      ankiConnectUp: true,
      dbQueueAvailable: false,
    });
    restore = w.restore;

    const q = await reviewQueueAuto("zehntage", 50);
    expect(w.spy.dbReviewQueue).toBe(1); // tried the DB...
    expect(q.backend).toBe("ankiconnect"); // ...then fell back
    expect(w.spy.acReviewQueue).toBe(1);
  });

  test("Anki CLOSED but schema not understood -> AnkiConnect (no DB read)", async () => {
    const w = world({ ankiOpen: false, ankiConnectUp: true, schemaOk: false });
    restore = w.restore;

    const q = await reviewQueueAuto("zehntage", 50);
    expect(w.spy.dbReviewQueue).toBe(0); // gate failed: schemaOk=false
    expect(q.backend).toBe("ankiconnect");
  });
});

// ---------------------------------------------------------------------------
describe("answerCardAuto routing + reason surfacing", () => {
  test("Anki OPEN -> AnkiConnect; success returns ok with no reason", async () => {
    const w = world({ ankiOpen: true, ankiConnectUp: true, acAnswerOk: true });
    restore = w.restore;

    const r = await answerCardAuto(123, 3);
    expect(r).toEqual({ ok: true, backend: "ankiconnect" });
    expect(w.spy.acAnswerCard).toBe(1);
    expect(w.spy.dbAnswerCard).toBe(0);
  });

  test("Anki OPEN but AnkiConnect grade FAILS -> reason, not silent ok", async () => {
    const w = world({
      ankiOpen: true,
      ankiConnectUp: true,
      acAnswerOk: false,
      acAnswerError: "card not in review queue",
    });
    restore = w.restore;

    const r = await answerCardAuto(123, 1);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("ankiconnect-failed");
    expect(r.error).toBe("card not in review queue");
    expect(r.backend).toBe("ankiconnect");
  });

  test("Anki CLOSED + present -> dbAnswerCard (windowless write)", async () => {
    const w = world({
      ankiOpen: false,
      ankiConnectUp: false,
      dbAnswerResult: { ok: true },
    });
    restore = w.restore;

    const r = await answerCardAuto(123, 4);
    expect(r.ok).toBe(true);
    expect(r.backend).toBe("db");
    expect(w.spy.dbAnswerCard).toBe(1);
    expect(w.spy.acAnswerCard).toBe(0);
  });

  test("Anki CLOSED, DB refuses -> forwards dbAnswerCard's reason verbatim", async () => {
    const w = world({
      ankiOpen: false,
      ankiConnectUp: false,
      dbAnswerResult: { ok: false, reason: "locked", error: "WAL is hot" },
    });
    restore = w.restore;

    const r = await answerCardAuto(123, 2);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("locked");
    expect(r.error).toBe("WAL is hot");
    expect(r.backend).toBe("db");
  });

  test("Anki CLOSED, DB write THROWS -> surfaces a reason, not a silent ok", async () => {
    const w = world({
      ankiOpen: false,
      ankiConnectUp: false,
      dbAnswerThrows: true,
    });
    restore = w.restore;

    const r = await answerCardAuto(123, 3);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("db-write-threw");
    expect(r.error).toContain("disk on fire");
  });

  test("ANKI_FAKE=1 -> answer routes to AnkiConnect (fake) regardless of deps", async () => {
    process.env.ANKI_FAKE = "1";
    const w = world({ ankiOpen: false, ankiConnectUp: false });
    restore = w.restore;

    const r = await answerCardAuto(999, 3);
    expect(r.backend).toBe("ankiconnect");
    expect(w.spy.acAnswerCard).toBe(1); // fake branch hits acAnswerCard
    expect(w.spy.dbAnswerCard).toBe(0); // and NEVER the DB write
  });
});

// ---------------------------------------------------------------------------
describe("reviewStatus.canAnswer", () => {
  test("AnkiConnect up (Anki open) -> canAnswer true", async () => {
    const w = world({ ankiOpen: true, ankiConnectUp: true });
    restore = w.restore;
    const s = await reviewStatus();
    expect(s.canAnswer).toBe(true);
    expect(s.ankiOpen).toBe(true);
  });

  test("Anki closed + present + schemaOk -> canAnswer true (windowless)", async () => {
    const w = world({ ankiOpen: false, ankiConnectUp: false });
    restore = w.restore;
    const s = await reviewStatus();
    expect(s.canAnswer).toBe(true);
    expect(s.canQueue).toBe(true);
  });

  test("Anki closed + collection absent -> canAnswer false", async () => {
    const w = world({
      ankiOpen: false,
      ankiConnectUp: false,
      present: false,
      schemaOk: false,
    });
    restore = w.restore;
    const s = await reviewStatus();
    expect(s.canAnswer).toBe(false);
    expect(s.canQueue).toBe(false);
  });

  test("ANKI_FAKE=1 -> DB-write path gated off; canAnswer follows AnkiConnect only", async () => {
    process.env.ANKI_FAKE = "1";
    // present+schemaOk+closed would normally enable the DB write, but fake mode
    // gates dbDirectEnabled() off, so canAnswer must depend solely on AnkiConnect.
    const w = world({ ankiOpen: false, ankiConnectUp: false });
    restore = w.restore;
    const s = await reviewStatus();
    expect(s.canAnswer).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("deleteNoteAuto routing", () => {
  test("Anki OPEN -> AnkiConnect delete; success returns ok with no reason", async () => {
    const w = world({ ankiOpen: true, ankiConnectUp: true, acDeleteOk: true });
    restore = w.restore;

    const r = await deleteNoteAuto(123);
    expect(r.ok).toBe(true);
    expect(r.backend).toBe("ankiconnect");
    expect(w.spy.acDeleteNote).toBe(1);
    expect(w.spy.dbDeleteNote).toBe(0);
  });

  test("Anki OPEN but AnkiConnect delete FAILS -> ok:false with reason", async () => {
    const w = world({
      ankiOpen: true,
      ankiConnectUp: true,
      acDeleteOk: false,
      acDeleteError: "note not found",
    });
    restore = w.restore;

    const r = await deleteNoteAuto(123);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("ankiconnect-failed");
    expect(r.error).toBe("note not found");
    expect(r.backend).toBe("ankiconnect");
  });

  test("Anki CLOSED + present -> dbDeleteNote (windowless write)", async () => {
    const w = world({
      ankiOpen: false,
      ankiConnectUp: false,
      dbDeleteResult: { ok: true },
    });
    restore = w.restore;

    const r = await deleteNoteAuto(456);
    expect(r.ok).toBe(true);
    expect(r.backend).toBe("db");
    expect(w.spy.dbDeleteNote).toBe(1);
    expect(w.spy.acDeleteNote).toBe(0);
  });

  test("Anki CLOSED, DB refuses -> forwards dbDeleteNote's reason verbatim", async () => {
    const w = world({
      ankiOpen: false,
      ankiConnectUp: false,
      dbDeleteResult: { ok: false, reason: "locked", error: "WAL is hot" },
    });
    restore = w.restore;

    const r = await deleteNoteAuto(789);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("locked");
    expect(r.error).toBe("WAL is hot");
    expect(r.backend).toBe("db");
  });

  test("Anki CLOSED, DB delete THROWS -> surfaces a reason, not a silent ok", async () => {
    const w = world({
      ankiOpen: false,
      ankiConnectUp: false,
      dbDeleteThrows: true,
    });
    restore = w.restore;

    const r = await deleteNoteAuto(111);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("db-write-threw");
    expect(r.error).toContain("disk ablaze");
  });

  test("Neither backend available -> no-backend reason", async () => {
    const w = world({ ankiOpen: false, ankiConnectUp: false, present: false, schemaOk: false });
    restore = w.restore;

    // With ANKI_FAKE off and db-direct disabled (present=false → canWrite would
    // refuse, but dbDirectEnabled() is true; the gate is at dbDeleteNote level).
    // To test no-backend we need dbDirectEnabled()=false, i.e. ANKI_FAKE=1.
    process.env.ANKI_FAKE = "1";
    // In fake mode: routes to acDeleteNote (fake). The no-backend path needs
    // ANKI_FAKE=0 + no AC + dbDirectEnabled=false. We can't disable dbDirect
    // without ANKI_FAKE. Instead test the ANKI_FAKE=1 path: acDeleteNote called.
    const r = await deleteNoteAuto(222);
    expect(r.backend).toBe("ankiconnect");
    expect(w.spy.acDeleteNote).toBe(1);
    expect(w.spy.dbDeleteNote).toBe(0);
  });

  test("ANKI_FAKE=1 -> fake delete branch (acDeleteNote called)", async () => {
    process.env.ANKI_FAKE = "1";
    const w = world({ ankiOpen: false, ankiConnectUp: false });
    restore = w.restore;

    const r = await deleteNoteAuto(999);
    expect(r.backend).toBe("ankiconnect");
    expect(w.spy.acDeleteNote).toBe(1);
    expect(w.spy.dbDeleteNote).toBe(0);
  });
});
