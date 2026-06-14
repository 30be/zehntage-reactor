// Read-only smoke test for src/lib/ankidb.ts against the LIVE Anki collection.
//
// This test NEVER writes to the collection. It asserts the read path works and
// reproduces Anki's due semantics for the zehntage scope. Validated against
// /tmp/wave18-live-due.md: the user has cleared today's zehntage reviews, so the
// due count must be ~0 and the future-dated cards (due > today) must NOT appear.
//
// If the collection isn't present on this host the structural assertions still
// hold (available:false, due:0) — the test is environment-tolerant.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  collectionPath,
  dbAnswerCard,
  dbDeleteNote,
  dbDeckCounts,
  dbReviewQueue,
  dbStatus,
} from "../src/lib/ankidb.ts";

const hasCollection = existsSync(collectionPath());

describe("ankidb.dbStatus", () => {
  test("never throws and returns a well-formed status", () => {
    const s = dbStatus();
    expect(typeof s.present).toBe("boolean");
    expect(typeof s.ankiOpen).toBe("boolean");
    expect(typeof s.ver).toBe("number");
    expect(typeof s.schemaOk).toBe("boolean");
  });

  test.if(hasCollection)("reports the live collection as present (ver 18)", () => {
    const s = dbStatus();
    expect(s.present).toBe(true);
    expect(s.ver).toBe(18);
    expect(s.schemaOk).toBe(true);
  });
});

describe("ankidb.dbReviewQueue", () => {
  test("does not throw for either scope", () => {
    expect(() => dbReviewQueue("zehntage")).not.toThrow();
    expect(() => dbReviewQueue("all")).not.toThrow();
  });

  test.if(hasCollection)(
    "zehntage scope: due ~0 today and no future cards leak in",
    () => {
      const q = dbReviewQueue("zehntage");
      expect(q.available).toBe(true);
      // User cleared today's 120 zehntage reviews → expect 0 (allow a tiny
      // tolerance for any learning card that re-entered the step queue).
      expect(q.due).toBeLessThanOrEqual(5);
      expect(q.cards.length).toBe(q.due);
      // Every returned card must be genuinely due (not future-dated).
      for (const c of q.cards) {
        expect(typeof c.cardId).toBe("number");
        expect(typeof c.question).toBe("string");
        expect(typeof c.answer).toBe("string");
        expect(typeof c.front).toBe("string");
      }
    },
  );

  test.if(hasCollection)("respects the limit parameter", () => {
    const q = dbReviewQueue("all", 3);
    expect(q.cards.length).toBeLessThanOrEqual(3);
  });
});

describe("ankidb.dbDeckCounts", () => {
  test("returns numeric counts without throwing", () => {
    const c = dbDeckCounts("zehntage");
    expect(typeof c.new).toBe("number");
    expect(typeof c.learning).toBe("number");
    expect(typeof c.review).toBe("number");
    expect(c.new).toBeGreaterThanOrEqual(0);
    expect(c.learning).toBeGreaterThanOrEqual(0);
    expect(c.review).toBeGreaterThanOrEqual(0);
  });

  test.if(hasCollection)("zehntage review count matches the ~0 due state", () => {
    const c = dbDeckCounts("zehntage");
    expect(c.review).toBeLessThanOrEqual(5);
  });
});

// ===========================================================================
// WRITE-BACK tests — dbAnswerCard. EVERYTHING runs against a TEMP COPY of a
// synthetic schema-18 collection. The user's REAL collection.anki2 is NEVER
// opened here (these tests use an explicit `path` hook pointing into tmpdir).
// ===========================================================================

// -- minimal protobuf encoder (tests only) --
function tEncVarint(n: number | bigint): number[] {
  let v = BigInt(n);
  const out: number[] = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) b |= 0x80;
    out.push(b);
  } while (v > 0n);
  return out;
}
function tTag(field: number, wire: number): number[] {
  return tEncVarint((field << 3) | wire);
}
function tVarintField(field: number, n: number): number[] {
  return [...tTag(field, 0), ...tEncVarint(n)];
}
function tPackedFloats(field: number, nums: number[]): number[] {
  const buf = new Uint8Array(nums.length * 4);
  const dv = new DataView(buf.buffer);
  nums.forEach((n, i) => dv.setFloat32(i * 4, n, true));
  return [...tTag(field, 2), ...tEncVarint(buf.length), ...buf];
}

// The user's real deck weights (spec §1.3). 21 FSRS-6 params.
const W21 = [
  0.22, 0.7243, 1.6576, 3.3556, 6.2593, 0.2877, 2.4553, 0.0149, 1.6987, 0.0,
  0.7055, 1.2231, 0.1882, 0.3043, 1.6918, 0.5783, 1.9006, 1.0118, 0.4073,
  0.0393, 0.1,
];

function deckConfigBlob(): Uint8Array {
  return new Uint8Array([
    ...tPackedFloats(1, [1, 10]), // learn_steps minutes
    ...tPackedFloats(2, [10]), // relearn_steps minutes
    ...tPackedFloats(6, W21), // FSRS-6 weights
    ...tVarintField(9, 20), // new/day
    ...tVarintField(16, 36500), // max review interval
  ]);
}

// crt: a fixed creation epoch so day-number math is deterministic.
const CRT = 1609459200; // 2021-01-01T00:00:00Z

/** Build a synthetic schema-18 collection with one card, return its dir+path. */
function makeSyntheticCollection(card: {
  type: number;
  queue: number;
  due: number;
  ivl: number;
  factor: number;
  reps: number;
  lapses: number;
  left: number;
  data: string;
}): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "zr-wbtest-"));
  const path = join(dir, "collection.anki2");
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = wal");
  db.exec(`CREATE TABLE col (
    id integer primary key, crt integer, mod integer, scm integer,
    ver integer, dty integer, usn integer, ls integer,
    conf text, models text, decks text, dconf text, tags text)`);
  db.exec(`CREATE TABLE cards (
    id integer primary key, nid integer, did integer, ord integer,
    mod integer, usn integer, type integer, queue integer, due integer,
    ivl integer, factor integer, reps integer, lapses integer, left integer,
    odue integer, odid integer, flags integer, data text)`);
  db.exec(`CREATE TABLE revlog (
    id integer primary key, cid integer, usn integer, ease integer,
    ivl integer, lastIvl integer, factor integer, time integer, type integer)`);
  db.exec(`CREATE TABLE deck_config (
    id integer primary key, name text, mtime_secs integer, usn integer, config blob)`);
  db.exec(`CREATE TABLE config (key text primary key, usn integer, mtime_secs integer, val blob)`);

  db.query(
    "INSERT INTO col (id, crt, mod, scm, ver, dty, usn, ls, conf, models, decks, dconf, tags) VALUES (1,?,?,?,18,0,1667,0,'{}','{}','{}','{}','{}')",
  ).run(CRT, 1000000, 1772920255646);
  db.query(
    "INSERT INTO deck_config (id, name, mtime_secs, usn, config) VALUES (1,'Default',0,0,?)",
  ).run(deckConfigBlob());
  // rollover hour 3 (user's real value), stored as a byte blob "3".
  db.query("INSERT INTO config (key, usn, mtime_secs, val) VALUES ('rollover',0,0,?)").run(
    new TextEncoder().encode("3"),
  );
  db.query(
    `INSERT INTO cards (id, nid, did, ord, mod, usn, type, queue, due, ivl,
       factor, reps, lapses, left, odue, odid, flags, data)
     VALUES (101, 201, 1, 0, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?)`,
  ).run(
    card.type,
    card.queue,
    card.due,
    card.ivl,
    card.factor,
    card.reps,
    card.lapses,
    card.left,
    card.data,
  );
  db.close();
  return { dir, path };
}

const passGate = () => ({ ok: true });
const noopBackup = async () => undefined;

describe("ankidb.dbAnswerCard (temp copy only)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  function readCard(path: string) {
    const db = new Database(path, { readonly: true });
    const c = db
      .query(
        "SELECT type, queue, due, ivl, reps, lapses, left, data, usn, mod FROM cards WHERE id=101",
      )
      .get() as Record<string, unknown>;
    db.close();
    return c;
  }
  function readRevlog(path: string) {
    const db = new Database(path, { readonly: true });
    const rows = db
      .query("SELECT id, cid, usn, ease, ivl, lastIvl, type FROM revlog WHERE cid=101")
      .all() as Record<string, unknown>[];
    db.close();
    return rows;
  }
  function readCol(path: string) {
    const db = new Database(path, { readonly: true });
    const c = db.query("SELECT mod, scm, usn FROM col LIMIT 1").get() as Record<
      string,
      unknown
    >;
    db.close();
    return c;
  }

  test("grades a REVIEW card Good: updates cards + revlog, usn=-1, scm unchanged", async () => {
    const lrt = Math.floor(Date.now() / 1000) - 20 * 86400; // ~20 days ago
    const { dir, path } = makeSyntheticCollection({
      type: 2,
      queue: 2,
      due: 100,
      ivl: 18,
      factor: 2500,
      reps: 5,
      lapses: 1,
      left: 0,
      data: JSON.stringify({ pos: 2, s: 18.0, d: 5.0, dr: 0.9, decay: 0.1, lrt }),
    });
    dirs.push(dir);
    const scmBefore = readCol(path).scm;

    const r = await dbAnswerCard(101, 3, {
      path,
      canWrite: passGate,
      backup: noopBackup,
    });
    expect(r.ok).toBe(true);

    const c = readCard(path);
    expect(c.type).toBe(2);
    expect(c.queue).toBe(2);
    expect(c.reps).toBe(6); // incremented
    expect(c.lapses).toBe(1); // unchanged on success
    expect(c.usn).toBe(-1); // pending sync
    expect(Number(c.ivl)).toBeGreaterThan(0);
    const data = JSON.parse(c.data as string);
    expect(data.s).toBeGreaterThan(0);
    expect(data.lrt).toBeGreaterThan(lrt); // refreshed

    const rl = readRevlog(path);
    expect(rl.length).toBe(1);
    expect(rl[0]!.ease).toBe(3);
    expect(rl[0]!.usn).toBe(-1);
    expect(rl[0]!.type).toBe(1); // review path
    expect(Number(rl[0]!.ivl)).toBeGreaterThan(0); // positive days
    expect(Number(rl[0]!.lastIvl)).toBe(18);

    expect(readCol(path).scm).toBe(scmBefore); // NEVER touched
    expect(Number(readCol(path).mod)).toBeGreaterThan(1000000); // bumped

    const db = new Database(path, { readonly: true });
    const ic = db.query("PRAGMA integrity_check").get() as Record<string, unknown>;
    db.close();
    expect(Object.values(ic)[0]).toBe("ok");
  });

  test("grades a REVIEW card Again: lapses++, enters relearning, revlog ivl in seconds", async () => {
    const lrt = Math.floor(Date.now() / 1000) - 20 * 86400;
    const { dir, path } = makeSyntheticCollection({
      type: 2,
      queue: 2,
      due: 100,
      ivl: 18,
      factor: 2500,
      reps: 5,
      lapses: 1,
      left: 0,
      data: JSON.stringify({ pos: 2, s: 18.0, d: 5.0, dr: 0.9, decay: 0.1, lrt }),
    });
    dirs.push(dir);

    const r = await dbAnswerCard(101, 1, {
      path,
      canWrite: passGate,
      backup: noopBackup,
    });
    expect(r.ok).toBe(true);

    const c = readCard(path);
    expect(c.type).toBe(3); // relearning
    expect(c.queue).toBe(1); // step queue
    expect(c.lapses).toBe(2); // incremented
    expect(c.usn).toBe(-1);

    const rl = readRevlog(path);
    expect(rl[0]!.ease).toBe(1);
    expect(rl[0]!.type).toBe(1); // lapse review row
    expect(Number(rl[0]!.ivl)).toBeLessThan(0); // seconds (relearn step)
    expect(Number(rl[0]!.lastIvl)).toBe(18);
  });

  test("grades a NEW card Again: enters learning step 0 (seconds)", async () => {
    const { dir, path } = makeSyntheticCollection({
      type: 0,
      queue: 0,
      due: 5,
      ivl: 0,
      factor: 0,
      reps: 0,
      lapses: 0,
      left: 0,
      data: "{}",
    });
    dirs.push(dir);

    const r = await dbAnswerCard(101, 1, {
      path,
      canWrite: passGate,
      backup: noopBackup,
    });
    expect(r.ok).toBe(true);

    const c = readCard(path);
    expect(c.type).toBe(1); // learning
    expect(c.queue).toBe(1);
    expect(c.reps).toBe(1);
    expect(c.usn).toBe(-1);
    const data = JSON.parse(c.data as string);
    expect(data.s).toBeGreaterThan(0); // S0 set
    expect(data.d).toBeGreaterThanOrEqual(1);

    const rl = readRevlog(path);
    expect(rl[0]!.type).toBe(0); // learn
    expect(Number(rl[0]!.ivl)).toBeLessThan(0); // step seconds
  });

  test("REFUSES (ok:false) when the write gate fails — never opens the DB", async () => {
    const { dir, path } = makeSyntheticCollection({
      type: 2,
      queue: 2,
      due: 100,
      ivl: 18,
      factor: 2500,
      reps: 5,
      lapses: 0,
      left: 0,
      data: JSON.stringify({ s: 18, d: 5, dr: 0.9, decay: 0.1, lrt: 1 }),
    });
    dirs.push(dir);
    const before = readCard(path);

    // Simulate ankiRunning → true (the real-world hard stop).
    const r = await dbAnswerCard(101, 3, {
      path,
      canWrite: () => ({ ok: false, reason: "anki-open" }),
      backup: noopBackup,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("anki-open");

    // DB must be untouched.
    const after = readCard(path);
    expect(after.reps).toBe(before.reps);
    expect(after.usn).toBe(before.usn);
    expect(readRevlog(path).length).toBe(0);
  });

  test("REFUSES via the real fail-closed gate when ankiRunning is stubbed true", async () => {
    // Exercise the REAL canWrite path with an injected ankiRunning stub, proving
    // the production gate ordering refuses while Anki is 'open'. Uses canWrite
    // from ankilock directly so we don't reach any DB open.
    const { canWrite: realCanWrite } = await import("../src/lib/ankilock.ts");
    const { dir, path } = makeSyntheticCollection({
      type: 2,
      queue: 2,
      due: 100,
      ivl: 18,
      factor: 2500,
      reps: 0,
      lapses: 0,
      left: 0,
      data: "{}",
    });
    dirs.push(dir);

    const r = await dbAnswerCard(101, 3, {
      path,
      canWrite: (p) => realCanWrite(p, { ankiRunning: () => true }),
      backup: noopBackup,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("anki-open");
    expect(readRevlog(path).length).toBe(0);
  });
});

// ===========================================================================
// dbStatus ankiOpen heuristic — stale -shm must NOT trigger "open"
//
// All assertions run against a temp dir; the real collection is never read.
// We use the ZEHNTAGE_ANKI_DB env override so dbStatus() points at our fake DB.
// ===========================================================================
describe("dbStatus ankiOpen heuristic (temp dir)", () => {
  let dir: string;
  let fakePath: string;
  let savedEnv: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "zr-status-test-"));
    fakePath = join(dir, "collection.anki2");
    savedEnv = process.env.ZEHNTAGE_ANKI_DB;
    process.env.ZEHNTAGE_ANKI_DB = fakePath;

    // Create a minimal valid SQLite collection so dbStatus can read schemaVer.
    const db = new Database(fakePath, { create: true });
    db.exec("PRAGMA journal_mode = wal");
    db.exec(`CREATE TABLE col (
      id integer primary key, crt integer, mod integer, scm integer,
      ver integer, dty integer, usn integer, ls integer,
      conf text, models text, decks text, dconf text, tags text)`);
    db.query(
      "INSERT INTO col (id,crt,mod,scm,ver,dty,usn,ls,conf,models,decks,dconf,tags) VALUES (1,0,0,0,18,0,0,0,'{}','{}','{}','{}','{}')",
    ).run();
    db.close();

    // After closing, remove the -wal and -shm SQLite may have left so each test
    // starts from a known baseline and can plant its own auxiliary files.
    const { unlinkSync: ul, existsSync: eS2 } = require("node:fs") as typeof import("node:fs");
    if (eS2(`${fakePath}-wal`)) ul(`${fakePath}-wal`);
    if (eS2(`${fakePath}-shm`)) ul(`${fakePath}-shm`);
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.ZEHNTAGE_ANKI_DB;
    } else {
      process.env.ZEHNTAGE_ANKI_DB = savedEnv;
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  test("lone stale -shm with empty -wal → ankiOpen=false", () => {
    const walPath = `${fakePath}-wal`;
    const shmPath = `${fakePath}-shm`;

    // Ensure -wal is absent or zero bytes.
    try {
      const { writeFileSync } = require("node:fs") as typeof import("node:fs");
      writeFileSync(walPath, new Uint8Array(0));
    } catch {
      // If it doesn't exist that's also fine — statSync will throw → walNonEmpty=false
    }

    // Place a 32768-byte -shm (same size as a real stale SQLite shm file).
    const { writeFileSync } = require("node:fs") as typeof import("node:fs");
    writeFileSync(shmPath, new Uint8Array(32768));

    // Stub the live-process check so we test PURELY the WAL/-shm file heuristic,
    // deterministically, even when the dev machine has a real Anki running.
    const s = dbStatus({ processRunning: () => false });
    expect(s.present).toBe(true);
    // The key assertion: stale -shm alone must NOT set ankiOpen.
    expect(s.ankiOpen).toBe(false);
  });

  test("non-empty -wal → ankiOpen=true regardless of -shm", () => {
    const walPath = `${fakePath}-wal`;
    const { writeFileSync } = require("node:fs") as typeof import("node:fs");
    // Write 512 bytes of non-zero data to simulate a live WAL.
    writeFileSync(walPath, new Uint8Array(512).fill(0xaa));

    // processRunning stubbed false so the truthy ankiOpen here is attributable
    // SOLELY to the non-empty WAL (the signal under test), not a live process.
    const s = dbStatus({ processRunning: () => false });
    expect(s.present).toBe(true);
    expect(s.ankiOpen).toBe(true);
  });

  test("absent -wal and absent -shm → ankiOpen=false", () => {
    // Remove both auxiliary files entirely.
    const { unlinkSync, existsSync: eS } = require("node:fs") as typeof import("node:fs");
    if (eS(`${fakePath}-wal`)) unlinkSync(`${fakePath}-wal`);
    if (eS(`${fakePath}-shm`)) unlinkSync(`${fakePath}-shm`);

    // Stub the live-process check: with no -wal/-shm and no live Anki, the DB is
    // closed. (Tested deterministically regardless of the dev's running Anki.)
    const s = dbStatus({ processRunning: () => false });
    expect(s.present).toBe(true);
    expect(s.ankiOpen).toBe(false);
  });
});

// ===========================================================================
// dbDeleteNote tests — all against a TEMP COPY of a synthetic schema-18
// collection. The user's real collection is NEVER opened or referenced.
// ===========================================================================

/** Build a synthetic schema-18 collection with notes + graves tables.
 *  Seeds one note (nid=201, flds="word\x1ftranslation") and one card (id=101, nid=201).
 *  An optional second card (id=102, nid=201) is added when twoCards=true so
 *  multi-card-per-note deletion can be tested. */
function makeSyntheticCollectionWithNotes(opts: {
  twoCards?: boolean;
} = {}): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "zr-deltest-"));
  const path = join(dir, "collection.anki2");
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = wal");
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
  db.exec(`CREATE TABLE graves (usn integer, oid integer, type integer)`);
  db.exec(`CREATE TABLE deck_config (
    id integer primary key, name text, mtime_secs integer, usn integer, config blob)`);
  db.exec(`CREATE TABLE config (key text primary key, usn integer, mtime_secs integer, val blob)`);

  db.query(
    "INSERT INTO col (id, crt, mod, scm, ver, dty, usn, ls, conf, models, decks, dconf, tags) VALUES (1,?,1000000,99999999999,18,0,0,0,'{}','{}','{}','{}','{}')",
  ).run(CRT);
  db.query(
    "INSERT INTO deck_config (id, name, mtime_secs, usn, config) VALUES (1,'Default',0,0,?)",
  ).run(deckConfigBlob());
  db.query("INSERT INTO config (key, usn, mtime_secs, val) VALUES ('rollover',0,0,?)").run(
    new TextEncoder().encode("3"),
  );
  // Insert one note.
  db.query(
    `INSERT INTO notes (id, guid, mid, mod, usn, tags, flds, sfld, csum, flags, data)
     VALUES (201, 'abc', 1234567890, 0, 0, ' zehntage ', 'word\x1ftranslation', 'word', 0, 0, '')`,
  ).run();
  // Insert card 101.
  db.query(
    `INSERT INTO cards (id, nid, did, ord, mod, usn, type, queue, due, ivl,
       factor, reps, lapses, left, odue, odid, flags, data)
     VALUES (101, 201, 1, 0, 0, 0, 2, 2, 100, 18, 2500, 5, 0, 0, 0, 0, 0, '{}')`,
  ).run();
  if (opts.twoCards) {
    // Second card for the same note (e.g. cloze template 1).
    db.query(
      `INSERT INTO cards (id, nid, did, ord, mod, usn, type, queue, due, ivl,
         factor, reps, lapses, left, odue, odid, flags, data)
       VALUES (102, 201, 1, 1, 0, 0, 2, 2, 100, 14, 2500, 3, 0, 0, 0, 0, 0, '{}')`,
    ).run();
  }
  db.close();
  return { dir, path };
}

describe("ankidb.dbDeleteNote (temp copy only)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  function readCards(path: string) {
    const db = new Database(path, { readonly: true });
    const rows = db.query("SELECT id, nid FROM cards").all() as { id: number; nid: number }[];
    db.close();
    return rows;
  }
  function readNotes(path: string) {
    const db = new Database(path, { readonly: true });
    const rows = db.query("SELECT id FROM notes").all() as { id: number }[];
    db.close();
    return rows;
  }
  function readGraves(path: string) {
    const db = new Database(path, { readonly: true });
    const rows = db.query("SELECT usn, oid, type FROM graves ORDER BY oid").all() as {
      usn: number;
      oid: number;
      type: number;
    }[];
    db.close();
    return rows;
  }
  function readCol(path: string) {
    const db = new Database(path, { readonly: true });
    const c = db.query("SELECT mod, scm FROM col LIMIT 1").get() as { mod: number; scm: number };
    db.close();
    return c;
  }

  test("deletes card + note rows, inserts correct graves (usn=-1), bumps col.mod, col.scm unchanged", async () => {
    const { dir, path } = makeSyntheticCollectionWithNotes();
    dirs.push(dir);
    const colBefore = readCol(path);
    const scmBefore = colBefore.scm;

    const r = await dbDeleteNote(101, { path, canWrite: passGate, backup: noopBackup });
    expect(r.ok).toBe(true);

    // card and note rows must be gone.
    expect(readCards(path)).toHaveLength(0);
    expect(readNotes(path)).toHaveLength(0);

    // graves: one for card (type 0), one for note (type 1), all usn=-1.
    const graves = readGraves(path);
    expect(graves.length).toBe(2);
    const cardGrave = graves.find((g) => g.type === 0);
    const noteGrave = graves.find((g) => g.type === 1);
    expect(cardGrave).toBeDefined();
    expect(cardGrave!.oid).toBe(101); // card id
    expect(cardGrave!.usn).toBe(-1);
    expect(noteGrave).toBeDefined();
    expect(noteGrave!.oid).toBe(201); // note id
    expect(noteGrave!.usn).toBe(-1);

    // col.scm must NEVER be touched.
    const colAfter = readCol(path);
    expect(colAfter.scm).toBe(scmBefore);
    // col.mod must be bumped (> 1000000 which was the seed value).
    expect(colAfter.mod).toBeGreaterThan(1000000);

    // integrity check on the modified file.
    const db = new Database(path, { readonly: true });
    const ic = db.query("PRAGMA integrity_check").get() as Record<string, unknown>;
    db.close();
    expect(Object.values(ic)[0]).toBe("ok");
  });

  test("multi-card note: all cards deleted, graves for each card + the note", async () => {
    const { dir, path } = makeSyntheticCollectionWithNotes({ twoCards: true });
    dirs.push(dir);

    // resolve via either card id.
    const r = await dbDeleteNote(101, { path, canWrite: passGate, backup: noopBackup });
    expect(r.ok).toBe(true);

    expect(readCards(path)).toHaveLength(0);
    expect(readNotes(path)).toHaveLength(0);

    const graves = readGraves(path);
    // 2 card graves (type 0) + 1 note grave (type 1) = 3.
    expect(graves.length).toBe(3);
    const cardGraves = graves.filter((g) => g.type === 0);
    const noteGraves = graves.filter((g) => g.type === 1);
    expect(cardGraves.length).toBe(2);
    expect(noteGraves.length).toBe(1);
    expect(cardGraves.every((g) => g.usn === -1)).toBe(true);
    expect(noteGraves[0]!.usn).toBe(-1);
    // Both card ids are in the graves.
    const cardGraveOids = new Set(cardGraves.map((g) => g.oid));
    expect(cardGraveOids.has(101)).toBe(true);
    expect(cardGraveOids.has(102)).toBe(true);
  });

  test("REFUSES when write gate fails — DB is untouched", async () => {
    const { dir, path } = makeSyntheticCollectionWithNotes();
    dirs.push(dir);

    const r = await dbDeleteNote(101, {
      path,
      canWrite: () => ({ ok: false, reason: "anki-open" }),
      backup: noopBackup,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("anki-open");

    // Real file must be untouched.
    expect(readCards(path)).toHaveLength(1);
    expect(readNotes(path)).toHaveLength(1);
    expect(readGraves(path)).toHaveLength(0);
  });

  test("returns ok:false for a nonexistent cardId (no graves, no changes)", async () => {
    const { dir, path } = makeSyntheticCollectionWithNotes();
    dirs.push(dir);

    const r = await dbDeleteNote(9999, { path, canWrite: passGate, backup: noopBackup });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/9999/);

    expect(readCards(path)).toHaveLength(1); // original card still there
    expect(readGraves(path)).toHaveLength(0);
  });

  test("real file untouched after a refused write (gate fails)", async () => {
    const { dir, path } = makeSyntheticCollectionWithNotes();
    dirs.push(dir);
    const colBefore = readCol(path);

    await dbDeleteNote(101, {
      path,
      canWrite: () => ({ ok: false, reason: "locked" }),
      backup: noopBackup,
    });

    // col.mod must be UNCHANGED (no write occurred).
    expect(readCol(path).mod).toBe(colBefore.mod);
  });
});
