// Stage 2a — windowless DB-direct READ paths for src/lib/ankidb.ts:
//   dbListCards()  — Cards-tab note list (parity with anki.ts acListCards)
//   dbProgress()   — per-word scheduling map (parity with anki.ts acProgress)
//   dbGetMedia()   — media bytes from collection.media/ (parity w/ retrieveMedia)
//
// Plus routing tests for review.ts listCardsAuto / progressAuto / mediaAuto via
// the __setReviewDeps seam (FAKE -> fake, Anki OPEN -> AnkiConnect UNCHANGED,
// Anki CLOSED -> the new DB readers).
//
// SAFETY: every DB read runs against a TEMP COPY of a SYNTHETIC schema-18
// collection (built per /tmp/zehntage-dbaddnote-spec.md). The user's REAL
// collection.anki2 is NEVER opened — collectionPath() is redirected through the
// ZEHNTAGE_ANKI_DB env override into tmpdir, and dbGetMedia takes a path hook.
//
// PARITY: the field/shape comparisons against the AnkiConnect output are kept in
// `parity` describe blocks — they assert that dbListCards/dbProgress emit the
// SAME object keys (and key-by-front semantics) acListCards/acProgress emit, so
// Stage 2b can drop AnkiConnect without changing the wire shape.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  dbListCards,
  dbProgress,
  dbGetMedia,
  collectionPath,
} from "../src/lib/ankidb.ts";
import {
  __setReviewDeps,
  listCardsAuto,
  progressAuto,
  mediaAuto,
} from "../src/lib/review.ts";

const NOTETYPE_NAME = "Back+Front+Usage";
const NOTETYPE_ID = 1680028238431;
const DECK_NAME = "Mixed";
const DECK_ID = 1701241966991;
const OTHER_DECK_ID = 1; // Default deck (cards here must NOT appear)
const CRT = 1609459200; // 2021-01-01 — deterministic day math.

interface SeedNote {
  noteId: number;
  fields: string[]; // values in field-ORDINAL order
  tags?: string[];
  card: {
    queue: number;
    due: number;
    ivl: number;
    factor: number;
    reps: number;
    lapses: number;
    type: number;
    mod: number;
    did?: number; // default DECK_ID
  };
}

/**
 * Build a synthetic schema-18 collection with the unicase tables (notetypes /
 * fields / templates / decks) that the read paths resolve BY NAME. The `name`
 * columns are plain TEXT (no COLLATE) so the DB can be created without unicase
 * registered; the readers register unicase themselves and the `WHERE name = ?`
 * lookups work identically against plain TEXT.
 *
 * `fieldNames` lets a test deliberately reorder the fields (e.g. context BEFORE
 * back) so name-resolution must be used — a positional fallback would map the
 * wrong column, which the parity tests catch.
 */
function makeCollection(opts: {
  notes: SeedNote[];
  fieldNames?: string[]; // default ["Front","Back","notes","context"]
  rolloverHour?: number;
}): { dir: string; path: string } {
  const fieldNames = opts.fieldNames ?? ["Front", "Back", "notes", "context"];
  const dir = mkdtempSync(join(tmpdir(), "zr-readpath-"));
  const path = join(dir, "collection.anki2");
  const db = new Database(path, { create: true });
  db.exec(`CREATE TABLE col (
    id integer primary key, crt integer, mod integer, scm integer,
    ver integer, dty integer, usn integer, ls integer,
    conf text, models text, decks text, dconf text, tags text)`);
  db.exec(`CREATE TABLE notes (
    id integer primary key, guid text, mid integer, mod integer,
    usn integer, tags text, flds text, sfld text, csum integer, flags integer, data text)`);
  db.exec(`CREATE TABLE cards (
    id integer primary key, nid integer, did integer, ord integer,
    mod integer, usn integer, type integer, queue integer, due integer,
    ivl integer, factor integer, reps integer, lapses integer, left integer,
    odue integer, odid integer, flags integer, data text)`);
  db.exec(`CREATE TABLE revlog (
    id integer primary key, cid integer, usn integer, ease integer,
    ivl integer, lastIvl integer, factor integer, time integer, type integer)`);
  db.exec(`CREATE TABLE notetypes (id integer primary key, name text, mtime_secs integer, usn integer, config blob)`);
  db.exec(`CREATE TABLE fields (ntid integer, ord integer, name text, config blob, primary key (ntid, ord))`);
  db.exec(`CREATE TABLE templates (ntid integer, ord integer, name text, mtime_secs integer, usn integer, config blob, primary key (ntid, ord))`);
  db.exec(`CREATE TABLE decks (id integer primary key, name text, mtime_secs integer, usn integer, common blob, kind blob)`);
  db.exec(`CREATE TABLE config (key text primary key, usn integer, mtime_secs integer, val blob)`);

  db.query(
    "INSERT INTO col (id, crt, mod, scm, ver, dty, usn, ls, conf, models, decks, dconf, tags) VALUES (1,?,1000000,99999999999,18,0,1667,0,'{}','{}','{}','{}','{}')",
  ).run(CRT);
  db.query("INSERT INTO config (key, usn, mtime_secs, val) VALUES ('rollover',0,0,?)").run(
    new TextEncoder().encode(String(opts.rolloverHour ?? 3)),
  );

  db.query("INSERT INTO notetypes (id, name, mtime_secs, usn, config) VALUES (?,?,0,0,?)").run(
    NOTETYPE_ID,
    NOTETYPE_NAME,
    new Uint8Array(0),
  );
  fieldNames.forEach((name, ord) => {
    db.query("INSERT INTO fields (ntid, ord, name, config) VALUES (?,?,?,?)").run(
      NOTETYPE_ID,
      ord,
      name,
      new Uint8Array(0),
    );
  });
  db.query(
    "INSERT INTO templates (ntid, ord, name, mtime_secs, usn, config) VALUES (?,0,'Card 1',0,0,?)",
  ).run(NOTETYPE_ID, new Uint8Array(0));

  db.query("INSERT INTO decks (id, name, mtime_secs, usn, common, kind) VALUES (1,'Default',0,0,?,?)").run(
    new Uint8Array(0),
    new Uint8Array(0),
  );
  db.query("INSERT INTO decks (id, name, mtime_secs, usn, common, kind) VALUES (?,?,0,0,?,?)").run(
    DECK_ID,
    DECK_NAME,
    new Uint8Array(0),
    new Uint8Array(0),
  );

  let cid = 5_000_000;
  for (const n of opts.notes) {
    const flds = n.fields.join("\x1f");
    const tags = n.tags && n.tags.length ? ` ${n.tags.join(" ")} ` : "";
    db.query(
      "INSERT INTO notes (id, guid, mid, mod, usn, tags, flds, sfld, csum, flags, data) VALUES (?,?,?,?,?,?,?,?,?,0,'')",
    ).run(n.noteId, `g${n.noteId}`, NOTETYPE_ID, 0, -1, tags, flds, n.fields[0] ?? "", 0);
    db.query(
      `INSERT INTO cards (id, nid, did, ord, mod, usn, type, queue, due, ivl,
        factor, reps, lapses, left, odue, odid, flags, data)
       VALUES (?,?,?,0,?,-1,?,?,?,?,?,?,?,0,0,0,0,'')`,
    ).run(
      cid++,
      n.noteId,
      n.card.did ?? DECK_ID,
      n.card.mod,
      n.card.type,
      n.card.queue,
      n.card.due,
      n.card.ivl,
      n.card.factor,
      n.card.reps,
      n.card.lapses,
    );
  }
  db.close();
  return { dir, path };
}

/** Anki "today" day-number for our fixed CRT + rollover, at `nowMs`. */
function todayFor(nowMs: number, rolloverHour = 3): number {
  return Math.floor((Math.floor(nowMs / 1000) - CRT - rolloverHour * 3600) / 86400);
}

let savedDbEnv: string | undefined;
let cleanupDirs: string[] = [];
afterEach(() => {
  if (savedDbEnv === undefined) delete process.env.ZEHNTAGE_ANKI_DB;
  else process.env.ZEHNTAGE_ANKI_DB = savedDbEnv;
  savedDbEnv = undefined;
  for (const d of cleanupDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  cleanupDirs = [];
});

function useCollection(c: { dir: string; path: string }) {
  savedDbEnv = process.env.ZEHNTAGE_ANKI_DB;
  process.env.ZEHNTAGE_ANKI_DB = c.path;
  cleanupDirs.push(c.dir);
}

// ===========================================================================
// dbListCards
// ===========================================================================
describe("ankidb.dbListCards", () => {
  test("returns the Mixed-deck notes with raw field values, tags, noteId", () => {
    const c = makeCollection({
      notes: [
        {
          noteId: 1001,
          fields: ["勉強", "study", "n1", "ctx1"],
          tags: ["zehntage"],
          card: { queue: 0, due: 1, ivl: 0, factor: 0, reps: 0, lapses: 0, type: 0, mod: CRT },
        },
        {
          noteId: 1002,
          fields: ["図書館 [としょかん]", "library", "", "<img src=\"x.jpg\">"],
          tags: ["zehntage", "wave12"],
          card: { queue: 2, due: 5, ivl: 10, factor: 2500, reps: 3, lapses: 0, type: 2, mod: CRT },
        },
      ],
    });
    useCollection(c);

    const list = dbListCards("all");
    expect(list.length).toBe(2);
    const byId = new Map(list.map((x) => [x.noteId, x]));

    const a = byId.get(1001)!;
    expect(a.front).toBe("勉強");
    expect(a.back).toBe("study");
    expect(a.notes).toBe("n1");
    expect(a.context).toBe("ctx1");
    expect(a.tags).toEqual(["zehntage"]);

    const b = byId.get(1002)!;
    expect(b.front).toBe("図書館 [としょかん]");
    expect(b.context).toBe('<img src="x.jpg">'); // raw HTML preserved
    expect(b.tags).toEqual(["zehntage", "wave12"]);
  });

  test("resolves fields BY NAME even when ordinals are reordered", () => {
    // context is ord 1, back is ord 3 — a positional fallback would mis-map.
    const c = makeCollection({
      fieldNames: ["Front", "context", "notes", "Back"],
      notes: [
        {
          noteId: 2001,
          fields: ["走る", "the-context", "the-notes", "to run"],
          tags: ["zehntage"],
          card: { queue: 0, due: 1, ivl: 0, factor: 0, reps: 0, lapses: 0, type: 0, mod: CRT },
        },
      ],
    });
    useCollection(c);
    const [card] = dbListCards("all");
    expect(card!.front).toBe("走る");
    expect(card!.back).toBe("to run"); // ord 3, resolved by /back/i
    expect(card!.context).toBe("the-context"); // ord 1, resolved by /context/i
    expect(card!.notes).toBe("the-notes");
  });

  test("excludes cards in other decks (scope all = Mixed only)", () => {
    const c = makeCollection({
      notes: [
        {
          noteId: 3001,
          fields: ["inMixed", "x", "", ""],
          tags: ["zehntage"],
          card: { queue: 0, due: 1, ivl: 0, factor: 0, reps: 0, lapses: 0, type: 0, mod: CRT },
        },
        {
          noteId: 3002,
          fields: ["inDefault", "y", "", ""],
          tags: ["zehntage"],
          card: { queue: 0, due: 1, ivl: 0, factor: 0, reps: 0, lapses: 0, type: 0, mod: CRT, did: OTHER_DECK_ID },
        },
      ],
    });
    useCollection(c);
    const list = dbListCards("all");
    expect(list.map((x) => x.front).sort()).toEqual(["inMixed"]);
  });

  test("scope zehntage filters by tag", () => {
    const c = makeCollection({
      notes: [
        {
          noteId: 4001,
          fields: ["tagged", "x", "", ""],
          tags: ["zehntage"],
          card: { queue: 0, due: 1, ivl: 0, factor: 0, reps: 0, lapses: 0, type: 0, mod: CRT },
        },
        {
          noteId: 4002,
          fields: ["untagged", "y", "", ""],
          tags: ["other"],
          card: { queue: 0, due: 1, ivl: 0, factor: 0, reps: 0, lapses: 0, type: 0, mod: CRT },
        },
      ],
    });
    useCollection(c);
    expect(dbListCards("zehntage").map((x) => x.front)).toEqual(["tagged"]);
  });

  test("returns [] when the collection is absent", () => {
    savedDbEnv = process.env.ZEHNTAGE_ANKI_DB;
    process.env.ZEHNTAGE_ANKI_DB = join(tmpdir(), "zr-nope-does-not-exist", "collection.anki2");
    expect(dbListCards("all")).toEqual([]);
  });
});

// ===========================================================================
// dbProgress
// ===========================================================================
describe("ankidb.dbProgress", () => {
  const now = Date.UTC(2024, 0, 15, 12, 0, 0); // fixed reference

  test("emits ProgressEntry keyed by raw front with correct fields", () => {
    const today = todayFor(now);
    const c = makeCollection({
      notes: [
        {
          noteId: 5001,
          fields: ["新しい", "new", "", ""],
          tags: ["zehntage"],
          card: { queue: 0, due: 1, ivl: 0, factor: 0, reps: 0, lapses: 0, type: 0, mod: CRT },
        },
        {
          noteId: 5002,
          fields: ["復習", "review", "", ""],
          tags: ["zehntage"],
          // review card due in the past (today-1) → isDue true
          card: { queue: 2, due: today - 1, ivl: 20, factor: 2300, reps: 5, lapses: 1, type: 2, mod: CRT },
        },
      ],
    });
    useCollection(c);
    const p = dbProgress("all", now);

    expect(Object.keys(p).sort()).toEqual(["復習", "新しい"]);

    const newCard = p["新しい"]!;
    expect(newCard).toEqual({
      interval: 0,
      due: 1,
      reps: 0,
      lapses: 0,
      ease: 0,
      queue: 0,
      type: 0,
      isDue: false,
      daysOverdue: 0,
    });

    const rev = p["復習"]!;
    expect(rev.interval).toBe(20);
    expect(rev.ease).toBe(2300); // factor -> ease
    expect(rev.reps).toBe(5);
    expect(rev.lapses).toBe(1);
    expect(rev.queue).toBe(2);
    expect(rev.isDue).toBe(true); // due (today-1) <= today
  });

  test("review card not yet due is isDue=false", () => {
    const today = todayFor(now);
    const c = makeCollection({
      notes: [
        {
          noteId: 6001,
          fields: ["未来", "future", "", ""],
          tags: ["zehntage"],
          card: { queue: 2, due: today + 10, ivl: 30, factor: 2500, reps: 2, lapses: 0, type: 2, mod: CRT },
        },
      ],
    });
    useCollection(c);
    const p = dbProgress("all", now);
    expect(p["未来"]!.isDue).toBe(false);
  });

  test("daysOverdue decodes like decodeDaysOverdue (queue 2, mod+ivl in the past)", () => {
    // mod 30 days ago, interval 10 days → overdue ~20 days.
    const modSec = Math.floor(now / 1000) - 30 * 86400;
    const c = makeCollection({
      notes: [
        {
          noteId: 7001,
          fields: ["遅れ", "overdue", "", ""],
          tags: ["zehntage"],
          card: { queue: 2, due: 1, ivl: 10, factor: 2500, reps: 4, lapses: 0, type: 2, mod: modSec },
        },
      ],
    });
    useCollection(c);
    const p = dbProgress("all", now);
    expect(p["遅れ"]!.daysOverdue).toBe(20);
  });

  test("non-review queues never report daysOverdue", () => {
    const modSec = Math.floor(now / 1000) - 100 * 86400;
    const c = makeCollection({
      notes: [
        {
          noteId: 7101,
          fields: ["学習", "learning", "", ""],
          tags: ["zehntage"],
          card: { queue: 1, due: 1, ivl: 10, factor: 0, reps: 1, lapses: 0, type: 1, mod: modSec },
        },
      ],
    });
    useCollection(c);
    expect(dbProgress("all", now)["学習"]!.daysOverdue).toBe(0);
  });

  test("learning card (queue 1) isDue uses epoch-seconds horizon", () => {
    const nowSec = Math.floor(now / 1000);
    const c = makeCollection({
      notes: [
        {
          noteId: 8001,
          fields: ["learnDue", "x", "", ""],
          tags: ["zehntage"],
          card: { queue: 1, due: nowSec - 60, ivl: 0, factor: 0, reps: 1, lapses: 0, type: 1, mod: CRT },
        },
        {
          noteId: 8002,
          fields: ["learnLater", "y", "", ""],
          tags: ["zehntage"],
          card: { queue: 1, due: nowSec + 3600, ivl: 0, factor: 0, reps: 1, lapses: 0, type: 1, mod: CRT },
        },
      ],
    });
    useCollection(c);
    const p = dbProgress("all", now);
    expect(p["learnDue"]!.isDue).toBe(true);
    expect(p["learnLater"]!.isDue).toBe(false);
  });

  test("skips cards with empty front (mirrors acProgress `if (!front) continue`)", () => {
    const c = makeCollection({
      notes: [
        {
          noteId: 9001,
          fields: ["", "noFront", "", ""],
          tags: ["zehntage"],
          card: { queue: 0, due: 1, ivl: 0, factor: 0, reps: 0, lapses: 0, type: 0, mod: CRT },
        },
      ],
    });
    useCollection(c);
    expect(dbProgress("all", now)).toEqual({});
  });

  test("returns {} when the collection is absent", () => {
    savedDbEnv = process.env.ZEHNTAGE_ANKI_DB;
    process.env.ZEHNTAGE_ANKI_DB = join(tmpdir(), "zr-nope-2", "collection.anki2");
    expect(dbProgress("all", now)).toEqual({});
  });
});

// ===========================================================================
// dbGetMedia
// ===========================================================================
describe("ankidb.dbGetMedia", () => {
  function makeMediaColl(files: Record<string, Uint8Array>): {
    dir: string;
    path: string;
  } {
    const dir = mkdtempSync(join(tmpdir(), "zr-media-"));
    const path = join(dir, "collection.anki2");
    const db = new Database(path, { create: true });
    db.exec("CREATE TABLE col (id integer primary key)");
    db.query("INSERT INTO col (id) VALUES (1)").run();
    db.close();
    const mediaDir = join(dir, "collection.media");
    mkdirSync(mediaDir, { recursive: true });
    for (const [name, bytes] of Object.entries(files)) {
      writeFileSync(join(mediaDir, name), bytes);
    }
    return { dir, path };
  }

  test("returns bytes + content-type for an existing file", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const c = makeMediaColl({ "pic.png": png });
    cleanupDirs.push(c.dir);
    const r = dbGetMedia("pic.png", { path: c.path });
    expect(r).not.toBeNull();
    expect(Array.from(r!.bytes)).toEqual(Array.from(png));
    expect(r!.contentType).toBe("image/png");
  });

  test("infers audio content-type from extension", () => {
    const c = makeMediaColl({ "snd.mp3": new Uint8Array([1, 2]) });
    cleanupDirs.push(c.dir);
    expect(dbGetMedia("snd.mp3", { path: c.path })!.contentType).toBe("audio/mpeg");
  });

  test("returns null for a missing file", () => {
    const c = makeMediaColl({ "exists.png": new Uint8Array([1]) });
    cleanupDirs.push(c.dir);
    expect(dbGetMedia("absent.png", { path: c.path })).toBeNull();
  });

  test("refuses path-traversal names", () => {
    const c = makeMediaColl({ "ok.png": new Uint8Array([1]) });
    cleanupDirs.push(c.dir);
    expect(dbGetMedia("../secret", { path: c.path })).toBeNull();
    expect(dbGetMedia("a/b.png", { path: c.path })).toBeNull();
    expect(dbGetMedia("a\\b.png", { path: c.path })).toBeNull();
    expect(dbGetMedia("", { path: c.path })).toBeNull();
  });
});

// ===========================================================================
// PARITY — prove dbListCards/dbProgress emit the SAME shape acListCards/
// acProgress emit, so Stage 2b can drop AnkiConnect without behavior change.
//
// We build the AnkiConnect output shape from the SAME fixture data (the exact
// transform acListCards/acProgress apply, lifted from anki.ts) and assert the
// DB output has identical KEYS and key-by-front semantics.
// ===========================================================================
describe("parity: dbListCards shape == acListCards shape", () => {
  test("same object keys per card; raw field values; front-derived", () => {
    const c = makeCollection({
      notes: [
        {
          noteId: 11001,
          fields: ["親", "parent", "noteX", "ctxX"],
          tags: ["zehntage"],
          card: { queue: 2, due: 3, ivl: 12, factor: 2500, reps: 2, lapses: 0, type: 2, mod: CRT },
        },
      ],
    });
    useCollection(c);
    const [dbCard] = dbListCards("all");

    // acListCards returns exactly these keys (anki.ts ~201-208):
    const AC_KEYS = ["front", "back", "notes", "context", "noteId", "tags"].sort();
    expect(Object.keys(dbCard!).sort()).toEqual(AC_KEYS);

    // The simulated AnkiConnect note for the same data:
    const acShape = {
      front: "親",
      back: "parent",
      notes: "noteX",
      context: "ctxX",
      noteId: 11001,
      tags: ["zehntage"],
    };
    expect(dbCard).toEqual(acShape);
  });
});

describe("parity: dbProgress shape == acProgress shape", () => {
  test("per-word entry carries the exact acProgress keys, keyed by front", () => {
    const now = Date.UTC(2024, 0, 15, 12, 0, 0);
    const today = todayFor(now);
    const c = makeCollection({
      notes: [
        {
          noteId: 12001,
          fields: ["木", "tree", "", ""],
          tags: ["zehntage"],
          card: { queue: 2, due: today - 2, ivl: 15, factor: 2400, reps: 6, lapses: 2, type: 2, mod: CRT },
        },
      ],
    });
    useCollection(c);
    const p = dbProgress("all", now);

    // acProgress is keyed by the raw front value (anki.ts ~290-292).
    expect(Object.keys(p)).toEqual(["木"]);

    // acProgress entry keys (anki.ts ~292-302):
    const AC_ENTRY_KEYS = [
      "interval",
      "due",
      "reps",
      "lapses",
      "ease",
      "queue",
      "type",
      "isDue",
      "daysOverdue",
    ].sort();
    expect(Object.keys(p["木"]!).sort()).toEqual(AC_ENTRY_KEYS);
  });
});

// ===========================================================================
// ROUTING — listCardsAuto / progressAuto / mediaAuto via __setReviewDeps.
// ===========================================================================
describe("listCardsAuto / progressAuto / mediaAuto routing", () => {
  let restore: (() => void) | null = null;
  // Defensive: clear any ANKI_FAKE leaked by another test file so the non-fake
  // DB-direct routing (dbDirectEnabled() === true) is exercised as intended.
  beforeEach(() => {
    delete process.env.ANKI_FAKE;
  });
  afterEach(() => {
    restore?.();
    restore = null;
    delete process.env.ANKI_FAKE;
  });

  test("Anki OPEN -> DB readers used anyway (snapshot may lag, AnkiConnect never called)", async () => {
    // Stage 2b-1: list/progress/media are DB-direct ONLY. Even when Anki is
    // open we read the on-disk snapshot — AnkiConnect is never consulted.
    let acList = 0,
      acProg = 0,
      dbList = 0,
      dbProg = 0,
      dbMedia = 0;
    restore = __setReviewDeps({
      dbStatus: () => ({ present: true, ankiOpen: true, ver: 18, schemaOk: true }),
      acListWords: async () => {
        acList++;
        return [{ front: "ac", back: "b", notes: "", context: "", noteId: 1, tags: [] }];
      },
      acGetProgress: async () => {
        acProg++;
        return { ac: 1 } as unknown as Record<string, number>;
      },
      dbListCards: () => {
        dbList++;
        return [
          { front: "db", back: "b", notes: "n", context: "c", noteId: 7, tags: ["zehntage"] },
        ];
      },
      dbProgress: () => {
        dbProg++;
        return {
          db: {
            interval: 1,
            due: 1,
            reps: 0,
            lapses: 0,
            ease: 0,
            queue: 0,
            type: 0,
            isDue: false,
            daysOverdue: 0,
          },
        };
      },
      dbGetMedia: () => {
        dbMedia++;
        return { bytes: new Uint8Array([9, 9]), contentType: "image/png" };
      },
    });

    const list = await listCardsAuto();
    expect(list[0]!.front).toBe("db"); // DB reader, not AnkiConnect
    const prog = await progressAuto();
    expect(prog).toHaveProperty("db");
    const media = await mediaAuto("x.png");
    expect(Array.from(media!.bytes)).toEqual([9, 9]);

    expect([acList, acProg]).toEqual([0, 0]); // AnkiConnect NEVER called
    expect([dbList, dbProg, dbMedia]).toEqual([1, 1, 1]);
  });

  test("Anki CLOSED -> DB readers, AnkiConnect untouched", async () => {
    let acList = 0,
      acProg = 0,
      dbList = 0,
      dbProg = 0,
      dbMedia = 0;
    restore = __setReviewDeps({
      dbStatus: () => ({ present: true, ankiOpen: false, ver: 18, schemaOk: true }),
      acListWords: async () => {
        acList++;
        return [];
      },
      acGetProgress: async () => {
        acProg++;
        return {};
      },
      dbListCards: () => {
        dbList++;
        return [
          { front: "db", back: "b", notes: "n", context: "c", noteId: 42, tags: ["zehntage"] },
        ];
      },
      dbProgress: () => {
        dbProg++;
        return {
          db: {
            interval: 1,
            due: 1,
            reps: 0,
            lapses: 0,
            ease: 0,
            queue: 0,
            type: 0,
            isDue: false,
            daysOverdue: 0,
          },
        };
      },
      dbGetMedia: () => {
        dbMedia++;
        return { bytes: new Uint8Array([7]), contentType: "image/png" };
      },
    });

    const list = await listCardsAuto();
    expect(list[0]!.front).toBe("db");
    expect(list[0]!.noteId).toBe(42);
    const prog = await progressAuto();
    expect(prog).toHaveProperty("db");
    const media = await mediaAuto("y.png");
    expect(Array.from(media!.bytes)).toEqual([7]);
    expect(media!.contentType).toBe("image/png");

    expect([acList, acProg]).toEqual([0, 0]);
    expect([dbList, dbProg, dbMedia]).toEqual([1, 1, 1]);
  });

  test("ANKI_FAKE=1 -> fake (acListWords/acGetProgress); media is null", async () => {
    process.env.ANKI_FAKE = "1";
    let acList = 0,
      acProg = 0,
      dbList = 0,
      dbProg = 0,
      dbMedia = 0;
    restore = __setReviewDeps({
      acListWords: async () => {
        acList++;
        return [{ front: "fake", back: "", notes: "", context: "", noteId: 9, tags: [] }];
      },
      acGetProgress: async () => {
        acProg++;
        return {};
      },
      dbListCards: () => {
        dbList++;
        return [];
      },
      dbProgress: () => {
        dbProg++;
        return {};
      },
      dbGetMedia: () => {
        dbMedia++;
        return { bytes: new Uint8Array([1]), contentType: "image/png" };
      },
    });

    const list = await listCardsAuto();
    expect(list[0]!.front).toBe("fake");
    await progressAuto();
    const media = await mediaAuto("z.png");
    expect(media).toBeNull(); // fake mode serves no media

    expect([acList, acProg]).toEqual([1, 1]);
    expect([dbList, dbProg, dbMedia]).toEqual([0, 0, 0]);
  });
});

// A guard so the real collection is never touched by the suite's env handling.
describe("safety", () => {
  test("collectionPath honours ZEHNTAGE_ANKI_DB override (tests stay hermetic)", () => {
    const saved = process.env.ZEHNTAGE_ANKI_DB;
    process.env.ZEHNTAGE_ANKI_DB = "/tmp/zr-override-check.anki2";
    expect(collectionPath()).toBe("/tmp/zr-override-check.anki2");
    if (saved === undefined) delete process.env.ZEHNTAGE_ANKI_DB;
    else process.env.ZEHNTAGE_ANKI_DB = saved;
  });
});
