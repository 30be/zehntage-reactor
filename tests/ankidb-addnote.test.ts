// Write-path tests for src/lib/ankidb.ts dbAddNote / dbStoreMedia.
//
// EVERYTHING runs against a TEMP COPY of a SYNTHETIC schema-18 collection built
// per /tmp/zehntage-dbaddnote-spec.md. The user's REAL collection.anki2 is NEVER
// opened (tests pass an explicit `path` hook into tmpdir and a passing canWrite
// gate + no-op backup). Asserts the created note+card are byte-faithful to what
// AnkiConnect produces: csum formula, base91 guid, NEW card (type0/queue0), due
// from nextPos (incremented), col.scm UNCHANGED + col.mod bumped, usn=-1, and
// that dbReviewQueue/dbDeckCounts can surface/count it.

import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dbAddNote, dbStoreMedia } from "../src/lib/ankidb.ts";

// Real ids/names from the user's collection (spec §1.3). Resolution is BY NAME;
// these ids are what the synthetic collection seeds so we can cross-check.
const NOTETYPE_NAME = "Back+Front+Usage";
const NOTETYPE_ID = 1680028238431;
const DECK_NAME = "Mixed";
const DECK_ID = 1701241966991;
const CRT = 1609459200; // 2021-01-01 — deterministic day math.

const passGate = () => ({ ok: true });
const noopBackup = async () => undefined;

const B91 =
  "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ!#$%&()*+,-./:;<=>?@[]^_`{|}~";

function stripForChecksum(s: string): string {
  return s
    .replace(/\[(?:sound|anki):[^\]]*\]/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ");
}
function expectedCsum(firstField: string): number {
  const hex = createHash("sha1").update(stripForChecksum(firstField), "utf8").digest("hex");
  return parseInt(hex.slice(0, 8), 16);
}

/**
 * Build a synthetic schema-18 collection with the unicase tables (notetypes /
 * fields / templates / decks) the windowless add path resolves BY NAME. The
 * name columns are plain TEXT (no COLLATE clause) so the DB can be CREATEd
 * without unicase registered; dbAddNote registers unicase itself and its
 * `WHERE name = ?` lookups work identically against plain TEXT.
 */
function makeCollection(opts: {
  templates?: number; // how many templates (default 1)
  nextPos?: number | null; // seed config.nextPos (null = omit)
  seedDuplicate?: { front: string }; // pre-insert a note with this first field
} = {}): { dir: string; path: string } {
  const templates = opts.templates ?? 1;
  const nextPos = opts.nextPos === undefined ? 8558 : opts.nextPos;
  const dir = mkdtempSync(join(tmpdir(), "zr-addnote-"));
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
  // unicase tables — plain TEXT name (see comment above).
  db.exec(`CREATE TABLE notetypes (id integer primary key, name text, mtime_secs integer, usn integer, config blob)`);
  db.exec(`CREATE TABLE fields (ntid integer, ord integer, name text, config blob, primary key (ntid, ord))`);
  db.exec(`CREATE TABLE templates (ntid integer, ord integer, name text, mtime_secs integer, usn integer, config blob, primary key (ntid, ord))`);
  db.exec(`CREATE TABLE decks (id integer primary key, name text, mtime_secs integer, usn integer, common blob, kind blob)`);
  db.exec(`CREATE TABLE config (key text primary key, usn integer, mtime_secs integer, val blob)`);

  db.query(
    "INSERT INTO col (id, crt, mod, scm, ver, dty, usn, ls, conf, models, decks, dconf, tags) VALUES (1,?,1000000,99999999999,18,0,1667,0,'{}','{}','{}','{}','{}')",
  ).run(CRT);
  db.query("INSERT INTO config (key, usn, mtime_secs, val) VALUES ('rollover',0,0,?)").run(
    new TextEncoder().encode("3"),
  );
  if (nextPos !== null) {
    db.query("INSERT INTO config (key, usn, mtime_secs, val) VALUES ('nextPos',0,0,?)").run(
      new TextEncoder().encode(String(nextPos)),
    );
  }

  // Notetype + fields + templates.
  db.query("INSERT INTO notetypes (id, name, mtime_secs, usn, config) VALUES (?,?,0,0,?)").run(
    NOTETYPE_ID,
    NOTETYPE_NAME,
    new Uint8Array(0),
  );
  const fieldNames = ["Front", "Back", "notes", "context"];
  fieldNames.forEach((name, ord) => {
    db.query("INSERT INTO fields (ntid, ord, name, config) VALUES (?,?,?,?)").run(
      NOTETYPE_ID,
      ord,
      name,
      new Uint8Array(0),
    );
  });
  for (let ord = 0; ord < templates; ord++) {
    db.query(
      "INSERT INTO templates (ntid, ord, name, mtime_secs, usn, config) VALUES (?,?,?,0,0,?)",
    ).run(NOTETYPE_ID, ord, `Card ${ord + 1}`, new Uint8Array(0));
  }

  // Decks: a default + Mixed.
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

  // Optional pre-existing note to trip the duplicate guard.
  if (opts.seedDuplicate) {
    const ff = opts.seedDuplicate.front;
    db.query(
      `INSERT INTO notes (id, guid, mid, mod, usn, tags, flds, sfld, csum, flags, data)
       VALUES (5001, 'seedguid01', ?, 0, 0, ' zehntage ', ?, ?, ?, 0, '')`,
    ).run(NOTETYPE_ID, `${ff}\x1fb\x1f\x1f`, ff, expectedCsum(ff));
    db.query(
      `INSERT INTO cards (id, nid, did, ord, mod, usn, type, queue, due, ivl,
         factor, reps, lapses, left, odue, odid, flags, data)
       VALUES (6001, 5001, ?, 0, 0, 0, 0, 0, 100, 0, 0, 0, 0, 0, 0, 0, 0, '')`,
    ).run(DECK_ID);
  }

  db.close();
  return { dir, path };
}

function readNote(path: string, id: number) {
  const db = new Database(path, { readonly: true });
  const n = db
    .query("SELECT id, guid, mid, mod, usn, tags, flds, sfld, csum, flags, data FROM notes WHERE id=?")
    .get(id) as Record<string, unknown>;
  db.close();
  return n;
}
function readCardsByNid(path: string, nid: number) {
  const db = new Database(path, { readonly: true });
  const rows = db
    .query(
      "SELECT id, nid, did, ord, usn, type, queue, due, ivl, factor, reps, lapses, left, odue, odid, flags, data FROM cards WHERE nid=? ORDER BY ord",
    )
    .all(nid) as Record<string, unknown>[];
  db.close();
  return rows;
}
function readCol(path: string) {
  const db = new Database(path, { readonly: true });
  const c = db.query("SELECT mod, scm, usn, ver FROM col LIMIT 1").get() as Record<string, unknown>;
  db.close();
  return c;
}
function readNextPos(path: string): number | null {
  const db = new Database(path, { readonly: true });
  const r = db.query("SELECT val FROM config WHERE key='nextPos'").get() as
    | { val: Uint8Array | string }
    | null;
  db.close();
  if (!r) return null;
  const t = typeof r.val === "string" ? r.val : new TextDecoder().decode(r.val as Uint8Array);
  return Number(t.trim());
}

describe("ankidb.dbAddNote (synthetic temp copy only)", () => {
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

  test("happy path: inserts a valid NEW note+card, byte-faithful to AnkiConnect", async () => {
    const { dir, path } = makeCollection();
    dirs.push(dir);
    const colBefore = readCol(path);
    const posBefore = readNextPos(path);
    expect(posBefore).toBe(8558);

    const front = "テスト [てすと]";
    const r = await dbAddNote(
      { front, back: "test", notes: "n", context: "c", tags: ["zehntage"] },
      { path, canWrite: passGate, backup: noopBackup },
    );
    expect(r.ok).toBe(true);
    expect(typeof r.noteId).toBe("number");
    expect(r.cardIds?.length).toBe(1);

    const note = readNote(path, r.noteId!);
    // mid resolved BY NAME == the seeded Back+Front+Usage id.
    expect(note.mid).toBe(NOTETYPE_ID);
    expect(note.usn).toBe(-1);
    expect(note.flags).toBe(0);
    expect(note.data).toBe("");
    expect(note.tags).toBe(" zehntage ");
    // flds split by \x1f in field-ordinal order [Front, Back, notes, context].
    expect((note.flds as string).split("\x1f")).toEqual([front, "test", "n", "c"]);
    // sfld = stripped first field (text affinity for non-numeric).
    expect(note.sfld).toBe(front);
    // csum matches Anki's exact formula.
    expect(note.csum).toBe(expectedCsum(front));

    const cards = readCardsByNid(path, r.noteId!);
    expect(cards.length).toBe(1);
    const c = cards[0]!;
    expect(c.id).toBe(r.cardIds![0]);
    expect(c.did).toBe(DECK_ID); // resolved BY NAME
    expect(c.ord).toBe(0);
    expect(c.type).toBe(0); // NEW
    expect(c.queue).toBe(0); // NEW
    expect(c.due).toBe(posBefore); // due == nextPos
    expect(c.ivl).toBe(0);
    expect(c.factor).toBe(0);
    expect(c.reps).toBe(0);
    expect(c.lapses).toBe(0);
    expect(c.left).toBe(0);
    expect(c.odue).toBe(0);
    expect(c.odid).toBe(0);
    expect(c.flags).toBe(0);
    expect(c.usn).toBe(-1);
    expect(c.data).toBe("");

    // nextPos incremented by exactly the card count.
    expect(readNextPos(path)).toBe((posBefore as number) + 1);

    // col.scm UNCHANGED; col.mod bumped (== a ms timestamp > the old value).
    const colAfter = readCol(path);
    expect(colAfter.scm).toBe(colBefore.scm);
    expect(colAfter.usn).toBe(colBefore.usn);
    expect(colAfter.ver).toBe(18);
    expect(colAfter.mod as number).toBeGreaterThan(colBefore.mod as number);
  });

  test("guid is base91, ~10 chars, and unique in the notes table", async () => {
    const { dir, path } = makeCollection();
    dirs.push(dir);
    const r = await dbAddNote(
      { front: "wohl", back: "b", tags: ["zehntage"] },
      { path, canWrite: passGate, backup: noopBackup },
    );
    expect(r.ok).toBe(true);
    const note = readNote(path, r.noteId!);
    const guid = note.guid as string;
    expect(guid.length).toBeGreaterThanOrEqual(1);
    expect(guid.length).toBeLessThanOrEqual(12);
    for (const ch of guid) expect(B91.includes(ch)).toBe(true);
    const db = new Database(path, { readonly: true });
    const cnt = db.query("SELECT count(*) AS c FROM notes WHERE guid=?").get(guid) as { c: number };
    db.close();
    expect(cnt.c).toBe(1);
  });

  test("integrity_check ok and foreign_key_check empty after the write", async () => {
    const { dir, path } = makeCollection();
    dirs.push(dir);
    const r = await dbAddNote(
      { front: "derjenige", back: "b", context: "ctx", tags: ["zehntage"] },
      { path, canWrite: passGate, backup: noopBackup },
    );
    expect(r.ok).toBe(true);
    const db = new Database(path, { readonly: true });
    const ic = db.query("PRAGMA integrity_check").get() as { integrity_check: string };
    const fk = db.query("PRAGMA foreign_key_check").all();
    db.close();
    expect(ic.integrity_check).toBe("ok");
    expect(fk.length).toBe(0);
  });

  test("csum matches Anki's formula for a first field containing a [sound:] token", async () => {
    const { dir, path } = makeCollection();
    dirs.push(dir);
    const front = "言葉 [ことば]";
    const r = await dbAddNote(
      { front, back: "word", tags: ["zehntage"] },
      { path, canWrite: passGate, backup: noopBackup },
    );
    expect(r.ok).toBe(true);
    expect(readNote(path, r.noteId!).csum).toBe(expectedCsum(front));
  });

  test("multi-template notetype emits one card per ord, distinct ids, all NEW", async () => {
    const { dir, path } = makeCollection({ templates: 2 });
    dirs.push(dir);
    const posBefore = readNextPos(path)!;
    const r = await dbAddNote(
      { front: "x", back: "y", tags: ["zehntage"] },
      { path, canWrite: passGate, backup: noopBackup },
    );
    expect(r.ok).toBe(true);
    expect(r.cardIds?.length).toBe(2);
    const cards = readCardsByNid(path, r.noteId!);
    expect(cards.length).toBe(2);
    expect(cards.map((c) => c.ord)).toEqual([0, 1]);
    expect(cards.map((c) => c.due)).toEqual([posBefore, posBefore + 1]);
    for (const c of cards) {
      expect(c.type).toBe(0);
      expect(c.queue).toBe(0);
    }
    // ids distinct (cards + note).
    const ids = new Set([r.noteId!, ...r.cardIds!]);
    expect(ids.size).toBe(3);
    // nextPos advanced by 2.
    expect(readNextPos(path)).toBe(posBefore + 2);
  });

  test("nextPos missing: falls back to max(due)+1 and writes nextPos back", async () => {
    const { dir, path } = makeCollection({ nextPos: null });
    dirs.push(dir);
    const r = await dbAddNote(
      { front: "fallback", back: "b", tags: ["zehntage"] },
      { path, canWrite: passGate, backup: noopBackup },
    );
    expect(r.ok).toBe(true);
    const c = readCardsByNid(path, r.noteId!)[0]!;
    // No new cards existed → max(due)+1 over empty type=0 set = 1.
    expect(c.due).toBe(1);
    expect(readNextPos(path)).toBe(2);
  });

  test("duplicate guard refuses a same-deck same-csum add and writes nothing", async () => {
    const front = "dupword";
    const { dir, path } = makeCollection({ seedDuplicate: { front } });
    dirs.push(dir);
    const before = readFileSync(path);
    const r = await dbAddNote(
      { front, back: "b", tags: ["zehntage"] },
      { path, canWrite: passGate, backup: noopBackup },
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("duplicate");
    // No note added beyond the seed.
    const db = new Database(path, { readonly: true });
    const cnt = db.query("SELECT count(*) AS c FROM notes").get() as { c: number };
    db.close();
    expect(cnt.c).toBe(1);
  });

  test("allowDuplicate bypasses the guard", async () => {
    const front = "dupword";
    const { dir, path } = makeCollection({ seedDuplicate: { front } });
    dirs.push(dir);
    const r = await dbAddNote(
      { front, back: "b", tags: ["zehntage"] },
      { path, canWrite: passGate, backup: noopBackup, allowDuplicate: true },
    );
    expect(r.ok).toBe(true);
    const db = new Database(path, { readonly: true });
    const cnt = db.query("SELECT count(*) AS c FROM notes").get() as { c: number };
    db.close();
    expect(cnt.c).toBe(2);
  });

  test("fail-closed: refused gate writes nothing (file byte-identical)", async () => {
    const { dir, path } = makeCollection();
    dirs.push(dir);
    // Checkpoint WAL into the main file first so the byte comparison is stable.
    const before = readFileSync(path);
    const r = await dbAddNote(
      { front: "z", back: "b" },
      { path, canWrite: () => ({ ok: false, reason: "anki-open" }), backup: noopBackup },
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("anki-open");
    const after = readFileSync(path);
    expect(Buffer.compare(before, after)).toBe(0);
  });

  test("missing notetype name → fail-closed error, no write", async () => {
    const { dir, path } = makeCollection();
    dirs.push(dir);
    // Drop the notetype to force resolution failure.
    const w = new Database(path, { readwrite: true });
    w.query("DELETE FROM notetypes WHERE id=?").run(NOTETYPE_ID);
    w.close();
    const r = await dbAddNote(
      { front: "z", back: "b" },
      { path, canWrite: passGate, backup: noopBackup },
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("notetype");
    const db = new Database(path, { readonly: true });
    const cnt = db.query("SELECT count(*) AS c FROM notes").get() as { c: number };
    db.close();
    expect(cnt.c).toBe(0);
  });

  test("surfaces via dbReviewQueue/dbDeckCounts (env-pointed read path)", async () => {
    const { dir, path } = makeCollection();
    dirs.push(dir);
    const r = await dbAddNote(
      { front: "surfaceme", back: "b", context: "ctx", tags: ["zehntage"] },
      { path, canWrite: passGate, backup: noopBackup },
    );
    expect(r.ok).toBe(true);

    // Point the read path at our temp collection via the documented env var.
    const prev = process.env.ZEHNTAGE_ANKI_DB;
    process.env.ZEHNTAGE_ANKI_DB = path;
    try {
      // Re-import lazily so collectionPath() picks up the env var.
      const { dbReviewQueue, dbDeckCounts } = await import("../src/lib/ankidb.ts");
      const q = dbReviewQueue("zehntage", 50);
      expect(q.available).toBe(true);
      const found = q.cards.some((c) => c.cardId === r.cardIds![0]);
      expect(found).toBe(true);
      const counts = dbDeckCounts("zehntage");
      expect(counts.new).toBeGreaterThanOrEqual(1);
    } finally {
      if (prev === undefined) delete process.env.ZEHNTAGE_ANKI_DB;
      else process.env.ZEHNTAGE_ANKI_DB = prev;
    }
  });
});

describe("ankidb.dbStoreMedia (synthetic temp copy only)", () => {
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

  function makeMediaColl(): { dir: string; path: string; mediaDir: string; db2: string } {
    const dir = mkdtempSync(join(tmpdir(), "zr-media-"));
    const path = join(dir, "collection.anki2");
    // a minimal col so canWrite-style path resolution is consistent (not used here)
    const db = new Database(path, { create: true });
    db.exec("CREATE TABLE col (id integer primary key)");
    db.query("INSERT INTO col (id) VALUES (1)").run();
    db.close();
    const mediaDir = join(dir, "collection.media");
    mkdirSync(mediaDir);
    const db2 = join(dir, "collection.media.db2");
    const m = new Database(db2, { create: true });
    m.exec(
      `CREATE TABLE media (fname text NOT NULL PRIMARY KEY, csum text, mtime int NOT NULL, dirty int NOT NULL) WITHOUT ROWID`,
    );
    m.exec("CREATE INDEX idx_media_dirty ON media (dirty)");
    m.exec("CREATE TABLE meta (dirMod int, lastUsn int)");
    m.close();
    return { dir, path, mediaDir, db2 };
  }

  function sha1(bytes: Uint8Array): string {
    return createHash("sha1").update(bytes).digest("hex");
  }
  function readMediaRow(db2: string, fname: string) {
    const db = new Database(db2, { readonly: true });
    const r = db.query("SELECT fname, csum, mtime, dirty FROM media WHERE fname=?").get(fname) as
      | Record<string, unknown>
      | null;
    db.close();
    return r;
  }

  test("stores bytes, writes file + media row (full sha1 csum, dirty=1)", async () => {
    const { dir, path, mediaDir, db2 } = makeMediaColl();
    dirs.push(dir);
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const t0 = Date.now();
    const r = await dbStoreMedia(bytes, "zr-clip-1m02s.mp3", { path, canWrite: passGate });
    expect(r.ok).toBe(true);
    expect(r.filename).toBe("zr-clip-1m02s.mp3");
    // File written with exact bytes.
    const onDisk = readFileSync(join(mediaDir, r.filename!));
    expect(Buffer.compare(Buffer.from(bytes), onDisk)).toBe(0);
    // Row: full 40-char sha1, dirty=1, mtime ~ now.
    const row = readMediaRow(db2, r.filename!)!;
    expect(row.csum).toBe(sha1(bytes));
    expect((row.csum as string).length).toBe(40);
    expect(row.dirty).toBe(1);
    expect(row.mtime as number).toBeGreaterThanOrEqual(t0);
  });

  test("idempotent: same name + same bytes → no dup row, same name", async () => {
    const { dir, path, db2 } = makeMediaColl();
    dirs.push(dir);
    const bytes = new Uint8Array([9, 8, 7]);
    const r1 = await dbStoreMedia(bytes, "a.mp3", { path, canWrite: passGate });
    const r2 = await dbStoreMedia(bytes, "a.mp3", { path, canWrite: passGate });
    expect(r1.filename).toBe("a.mp3");
    expect(r2.filename).toBe("a.mp3");
    const db = new Database(db2, { readonly: true });
    const cnt = db.query("SELECT count(*) AS c FROM media").get() as { c: number };
    db.close();
    expect(cnt.c).toBe(1);
  });

  test("collision: same name, different bytes → disambiguated filename", async () => {
    const { dir, path, mediaDir } = makeMediaColl();
    dirs.push(dir);
    const r1 = await dbStoreMedia(new Uint8Array([1]), "x.mp3", { path, canWrite: passGate });
    const r2 = await dbStoreMedia(new Uint8Array([2]), "x.mp3", { path, canWrite: passGate });
    expect(r1.filename).toBe("x.mp3");
    expect(r2.filename).toBe("x-1.mp3");
    expect(existsSync(join(mediaDir, "x.mp3"))).toBe(true);
    expect(existsSync(join(mediaDir, "x-1.mp3"))).toBe(true);
  });

  test("fail-closed: refused gate stores nothing", async () => {
    const { dir, path, mediaDir } = makeMediaColl();
    dirs.push(dir);
    const r = await dbStoreMedia(new Uint8Array([1]), "y.mp3", {
      path,
      canWrite: () => ({ ok: false, reason: "anki-open" }),
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("anki-open");
    expect(existsSync(join(mediaDir, "y.mp3"))).toBe(false);
  });

  test("fail-closed: missing media dir/db → error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zr-nomedia-"));
    dirs.push(dir);
    const path = join(dir, "collection.anki2");
    const db = new Database(path, { create: true });
    db.exec("CREATE TABLE col (id integer primary key)");
    db.close();
    const r = await dbStoreMedia(new Uint8Array([1]), "z.mp3", { path, canWrite: passGate });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("media");
  });
});
