import { expect, test, describe } from "bun:test";
import { existsSync, copyFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Database } from "bun:sqlite";
import {
  readProtoFields,
  protoString,
  protoNumber,
  protoFloat,
  protoPackedFloats,
  decodeTemplate,
  decodeNotetype,
  decodeDeckConfig,
  renderCard,
  rewriteAnkiMedia,
  splitFields,
  WireType,
} from "../src/lib/ankirender.ts";

// ---------------------------------------------------------------------------
// Synthetic protobuf encoder (tests only — exercises the reader/decoders)
// ---------------------------------------------------------------------------

function encVarint(n: number | bigint): number[] {
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
function tag(field: number, wire: number): number[] {
  return encVarint((field << 3) | wire);
}
function encString(field: number, s: string): number[] {
  const bytes = [...new TextEncoder().encode(s)];
  return [...tag(field, WireType.LengthDelimited), ...encVarint(bytes.length), ...bytes];
}
function encVarintField(field: number, n: number): number[] {
  return [...tag(field, WireType.Varint), ...encVarint(n)];
}
function encPackedFloats(field: number, nums: number[]): number[] {
  const buf = new Uint8Array(nums.length * 4);
  const dv = new DataView(buf.buffer);
  nums.forEach((n, i) => dv.setFloat32(i * 4, n, true));
  return [...tag(field, WireType.LengthDelimited), ...encVarint(buf.length), ...buf];
}
function encFloat(field: number, n: number): number[] {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setFloat32(0, n, true);
  return [...tag(field, WireType.Fixed32), ...buf];
}
function bytes(...parts: number[][]): Uint8Array {
  return new Uint8Array(parts.flat());
}

// ---------------------------------------------------------------------------
// Protobuf reader unit tests
// ---------------------------------------------------------------------------

describe("readProtoFields", () => {
  test("decodes mixed wire types, repeated fields", () => {
    const buf = bytes(
      encString(1, "hello"),
      encVarintField(2, 42),
      encString(1, "world"), // repeated field 1
      encFloat(5, 3.5),
      encPackedFloats(6, [1, 2, 3]),
    );
    const f = readProtoFields(buf);
    expect(f.get(1)!.map((v) => protoString(v))).toEqual(["hello", "world"]);
    expect(protoNumber(f.get(2)![0])).toBe(42);
    expect(protoFloat(f.get(5)![0])).toBeCloseTo(3.5, 5);
    expect(protoPackedFloats(f.get(6)![0])).toEqual([1, 2, 3]);
  });

  test("large varint round-trips", () => {
    const f = readProtoFields(bytes(encVarintField(9, 1000), encVarintField(16, 36500)));
    expect(protoNumber(f.get(9)![0])).toBe(1000);
    expect(protoNumber(f.get(16)![0])).toBe(36500);
  });

  test("throws on truncated varint", () => {
    expect(() => readProtoFields(new Uint8Array([0x08, 0x80]))).toThrow();
  });

  test("throws on unterminated varint mid-message (after a valid field)", () => {
    // field 1 = "hi", then tag for field 2 varint, then an unterminated varint.
    const buf = bytes(encString(1, "hi"), tag(2, WireType.Varint), [0x80, 0x80]);
    expect(() => readProtoFields(buf)).toThrow(/truncated varint/);
  });

  test("throws on truncated length-delimited field (claims more than remains)", () => {
    // field 1, len-delimited, declares 100 bytes but only 3 follow.
    const buf = bytes([...tag(1, WireType.LengthDelimited), ...encVarint(100)], [1, 2, 3]);
    expect(() => readProtoFields(buf)).toThrow(/truncated length-delimited/);
  });

  test("throws on truncated fixed32", () => {
    const buf = bytes([...tag(5, WireType.Fixed32)], [0x00, 0x01]); // only 2 of 4 bytes
    expect(() => readProtoFields(buf)).toThrow(/truncated fixed32/);
  });

  test("throws on truncated fixed64", () => {
    const buf = bytes([...tag(7, WireType.Fixed64)], [0x00, 0x01, 0x02]); // 3 of 8 bytes
    expect(() => readProtoFields(buf)).toThrow(/truncated fixed64/);
  });
});

// ---------------------------------------------------------------------------
// Config decoder unit tests (synthetic blobs)
// ---------------------------------------------------------------------------

describe("config decoders", () => {
  test("decodeTemplate reads qfmt/afmt", () => {
    const blob = bytes(encString(1, "{{Front}}"), encString(2, "{{FrontSide}}<hr>{{Back}}"));
    expect(decodeTemplate(blob)).toEqual({
      qfmt: "{{Front}}",
      afmt: "{{FrontSide}}<hr>{{Back}}",
    });
  });

  test("decodeNotetype reads css from field 3", () => {
    const blob = bytes(encString(3, ".card{color:black}"), encString(5, "\\latex"));
    expect(decodeNotetype(blob)).toEqual({ css: ".card{color:black}" });
  });

  test("decodeDeckConfig picks newest weight array + limits", () => {
    const old17 = Array.from({ length: 17 }, (_, i) => i + 0.1);
    const cur21 = Array.from({ length: 21 }, (_, i) => i + 0.5);
    const blob = bytes(
      encPackedFloats(1, [1, 10]),
      encPackedFloats(2, [10]),
      encPackedFloats(3, old17),
      encPackedFloats(6, cur21),
      encVarintField(9, 1000),
      encVarintField(10, 9999),
      encVarintField(16, 36500),
      encFloat(37, 0.9),
    );
    const dc = decodeDeckConfig(blob);
    expect(dc.learningSteps).toEqual([1, 10]);
    expect(dc.relearningSteps).toEqual([10]);
    expect(dc.weights.length).toBe(21);
    expect(dc.weights[0]).toBeCloseTo(0.5, 4);
    expect(dc.weightHistory[3]!.length).toBe(17);
    expect(dc.newPerDay).toBe(1000);
    expect(dc.revPerDay).toBe(9999);
    expect(dc.maximumReviewInterval).toBe(36500);
    expect(dc.desiredRetention).toBeCloseTo(0.9, 5);
  });

  test("decodeDeckConfig throws on a wrong-length weight array", () => {
    // f6 present but only 20 weights (one short of the required 21).
    const bad20 = Array.from({ length: 20 }, (_, i) => i + 0.5);
    const blob = bytes(
      encPackedFloats(1, [1, 10]),
      encPackedFloats(6, bad20),
      encVarintField(9, 1000),
    );
    expect(() => decodeDeckConfig(blob)).toThrow(/expected 21 FSRS weights, got 20/);
  });

  test("decodeDeckConfig throws when no weight array is present at all", () => {
    const blob = bytes(encVarintField(9, 1000), encVarintField(10, 9999));
    expect(() => decodeDeckConfig(blob)).toThrow(/expected 21 FSRS weights, got 0/);
  });
});

// ---------------------------------------------------------------------------
// Renderer unit tests
// ---------------------------------------------------------------------------

describe("renderCard", () => {
  const fields = { Front: "katze", Back: "cat", notes: "", context: "<b>Die Katze.</b>" };

  test("substitutes fields without HTML-escaping; wraps with style+card", () => {
    const { question, answer } = renderCard(
      fields,
      "<h5>{{Front}}</h5>",
      "{{FrontSide}}<hr><b>{{Back}}</b>{{notes}}<div>{{context}}</div>",
      ".card{color:black}",
    );
    expect(question).toBe('<style>.card{color:black}</style><div class="card"><h5>katze</h5></div>');
    // FrontSide is the rendered front, not raw qfmt:
    expect(answer).toContain("<h5>katze</h5><hr><b>cat</b>");
    // unescaped HTML field preserved:
    expect(answer).toContain("<b>Die Katze.</b>");
    expect(answer.startsWith('<style>.card{color:black}</style><div class="card">')).toBe(true);
  });

  test("{{#Field}} kept when non-empty, dropped when empty", () => {
    const f = { A: "x", B: "" };
    const { question } = renderCard(f, "{{#A}}[A={{A}}]{{/A}}{{#B}}[B]{{/B}}", "", "");
    expect(question).toContain("[A=x]");
    expect(question).not.toContain("[B]");
  });

  test("{{^Field}} kept when empty", () => {
    const f = { A: "x", B: "" };
    const { question } = renderCard(f, "{{^A}}noA{{/A}}{{^B}}noB{{/B}}", "", "");
    expect(question).toContain("noB");
    expect(question).not.toContain("noA");
  });

  test("strips {{type:..}} and reveals {{hint:..}}", () => {
    const f = { Front: "q", Extra: "the hint" };
    const { question } = renderCard(f, "{{type:Front}}{{hint:Extra}}", "", "");
    expect(question).not.toContain("type:");
    expect(question).toContain("the hint");
  });

  test("cloze markers stripped to plain text", () => {
    const f = { Text: "The {{c1::quick::speed}} fox" };
    const { question } = renderCard(f, "{{cloze:Text}}", "", "");
    expect(question).toContain("The quick fox");
    expect(question).not.toContain("c1::");
  });

  test("stray braces in field values are not reparsed", () => {
    const f = { Front: "a {{b}} c" };
    const { question } = renderCard(f, "<x>{{Front}}</x>", "", "");
    expect(question).toContain("<x>a {{b}} c</x>");
  });

  // {{furigana:Field}} converts Anki's `kanji[reading]` bracket notation into
  // <ruby> markup (NOT the raw field). Two real notetypes rely on it: Kaishi
  // 1.5k (1487 cards: Word/Sentence Furigana) and Japanese Radicals (Japanese
  // Name). Before the fix the reader showed the literal `私[わたし]` brackets.
  test("furigana: filter converts kanji[reading] to <ruby>", () => {
    const f = { Word: "私[わたし]" };
    const { question } = renderCard(f, "{{furigana:Word}}", "", "");
    expect(question).toContain("<ruby><rb>私</rb><rt>わたし</rt></ruby>");
    // the literal bracket notation must NOT survive
    expect(question).not.toContain("私[わたし]");
  });

  test("furigana: keeps surrounding HTML and handles multiple tokens", () => {
    const f = { S: "<b>私[わたし]</b>は 日本[にほん]です" };
    const { question } = renderCard(f, "{{furigana:S}}", "", "");
    // the <b> wrapper is preserved; the kanji capture stops at '>'
    expect(question).toContain("<b><ruby><rb>私</rb><rt>わたし</rt></ruby></b>");
    expect(question).toContain("<ruby><rb>日本</rb><rt>にほん</rt></ruby>");
    expect(question).not.toMatch(/\[にほん\]|\[わたし\]/);
  });

  test("furigana: leaves [sound:..] tokens untouched", () => {
    const f = { S: "[sound:a.mp3]" };
    const { question } = renderCard(f, "{{furigana:S}}", "", "");
    expect(question).toContain("[sound:a.mp3]");
    expect(question).not.toContain("<ruby");
  });
});

// ---------------------------------------------------------------------------
// Media rewrite unit tests
// ---------------------------------------------------------------------------

describe("rewriteAnkiMedia", () => {
  test("rewrites bare img src to proxy", () => {
    expect(rewriteAnkiMedia('<img src="paste-abc.jpg">')).toBe(
      '<img src="/api/anki/media/paste-abc.jpg">',
    );
  });
  test("rewrites [sound:..] to audio element", () => {
    expect(rewriteAnkiMedia("[sound:zr_123.mp3]")).toBe(
      '<audio controls src="/api/anki/media/zr_123.mp3"></audio>',
    );
  });
  test("leaves absolute/scheme/data srcs untouched", () => {
    const html = '<img src="https://x/y.png"><img src="/abs.png"><img src="data:image/png;base64,AA">';
    expect(rewriteAnkiMedia(html)).toBe(html);
  });
  test("refuses path-traversal names", () => {
    expect(rewriteAnkiMedia('<img src="../etc/passwd">')).toBe('<img src="../etc/passwd">');
    expect(rewriteAnkiMedia("[sound:../x.mp3]")).toBe("[sound:../x.mp3]");
  });
});

describe("splitFields", () => {
  test("maps US-separated flds to names by order", () => {
    expect(splitFields("a\x1fb\x1fc", ["Front", "Back", "notes", "context"])).toEqual({
      Front: "a",
      Back: "b",
      notes: "c",
      context: "",
    });
  });
});

// ---------------------------------------------------------------------------
// Live read-only test against the user's REAL collection.anki2
// ---------------------------------------------------------------------------

const DB_PATH = `${process.env.HOME}/.local/share/Anki2/User 1/collection.anki2`;
const MID = 1680028238431; // "Back+Front+Usage"

/**
 * Open the real DB read-only. Anki keeps it in WAL mode (locked), and a custom
 * `unicase` collation is declared on collation-bearing tables (templates,
 * notetypes, fields, deck_config) — stock sqlite + bun:sqlite lack it, so even a
 * SELECT errors. Strategy: copy main+wal+shm into a temp dir (original
 * untouched), and register a no-op `unicase` collation via a tiny C extension
 * loaded through bun:sqlite's loadExtension. If the extension can't be built
 * (no cc/headers), return null so the live test self-skips with a note.
 */
function openRealDbReadOnly(): { db: Database; note: string } | null {
  if (!existsSync(DB_PATH)) return null;
  const dir = mkdtempSync(join(tmpdir(), "zr-ankidb-"));
  const dst = join(dir, "collection.anki2");
  copyFileSync(DB_PATH, dst);
  for (const ext of ["-wal", "-shm"]) {
    if (existsSync(DB_PATH + ext)) copyFileSync(DB_PATH + ext, dst + ext);
  }
  // Build no-op unicase collation extension.
  const csrc = join(dir, "unicase_ext.c");
  const cso = join(dir, "unicase_ext.so");
  writeFileSync(
    csrc,
    `#include "sqlite3ext.h"\nSQLITE_EXTENSION_INIT1\n` +
      `static int noopcmp(void*u,int n1,const void*p1,int n2,const void*p2){` +
      `int n=n1<n2?n1:n2;int r=0;if(n)r=__builtin_memcmp(p1,p2,n);if(r)return r;return n1-n2;}\n` +
      `int sqlite3_unicaseext_init(sqlite3*db,char**e,const sqlite3_api_routines*api){` +
      `SQLITE_EXTENSION_INIT2(api);sqlite3_create_collation(db,"unicase",SQLITE_UTF8,0,noopcmp);` +
      `return SQLITE_OK;}\n`,
  );
  try {
    execFileSync("cc", ["-O2", "-fPIC", "-shared", "-I/usr/include", csrc, "-o", cso]);
  } catch {
    return null; // no compiler/headers — skip live test
  }
  const db = new Database(dst, { readonly: true });
  db.loadExtension(cso.replace(/\.so$/, ""), "sqlite3_unicaseext_init");
  return { db, note: "copied DB + loaded no-op unicase collation extension" };
}

describe("real collection.anki2 (read-only)", () => {
  const opened = openRealDbReadOnly();

  test.if(!!opened)("decodes zehntage template/css and renders a real note", () => {
    const { db } = opened!;
    const tplRow = db
      .query("SELECT ord, name, config FROM templates WHERE ntid = ? ORDER BY ord")
      .all(MID) as Array<{ ord: number; name: string; config: Uint8Array }>;
    expect(tplRow.length).toBeGreaterThan(0);
    const { qfmt, afmt } = decodeTemplate(tplRow[0]!.config);
    expect(qfmt).toContain("{{Front}}");
    expect(afmt).toContain("{{FrontSide}}");
    expect(afmt).toContain("{{Back}}");

    const ntRow = db.query("SELECT config FROM notetypes WHERE id = ?").get(MID) as {
      config: Uint8Array;
    };
    const { css } = decodeNotetype(ntRow.config);
    expect(css).toContain(".card");
    expect(css).toContain("font-family");

    const fieldRows = db
      .query("SELECT ord, name FROM fields WHERE ntid = ? ORDER BY ord")
      .all(MID) as Array<{ ord: number; name: string }>;
    const fieldNames = fieldRows.map((r) => r.name);
    expect(fieldNames).toEqual(["Front", "Back", "notes", "context"]);

    const noteRow = db.query("SELECT flds FROM notes WHERE mid = ? LIMIT 1").get(MID) as {
      flds: string;
    };
    const fields = splitFields(noteRow.flds, fieldNames);
    const { question, answer } = renderCard(fields, qfmt, afmt, css);

    // The rendered question must contain the Front field text.
    const front = fields.Front ?? "";
    const back = fields.Back ?? "";
    expect(front.length).toBeGreaterThan(0);
    expect(question).toContain(front);
    // The answer embeds the rendered front (FrontSide) + the Back field.
    expect(answer).toContain(front);
    expect(answer).toContain(back);
    expect(question.startsWith("<style>")).toBe(true);

    // Spot-check deck_config FSRS decode against the known real values.
    const dcRow = db.query("SELECT config FROM deck_config WHERE id = 1").get() as {
      config: Uint8Array;
    };
    const dc = decodeDeckConfig(dcRow.config);
    expect(dc.weights.length).toBe(21);
    expect(dc.weights[0]).toBeCloseTo(0.22002, 4);
    expect(dc.learningSteps).toEqual([1, 10]);
    expect(dc.relearningSteps).toEqual([10]);
    expect(dc.desiredRetention).toBeCloseTo(0.9, 5);
    expect(dc.newPerDay).toBe(1000);
    expect(dc.revPerDay).toBe(9999);

    db.close();
  });

  test.if(!opened)("live DB unavailable — skipped (see note)", () => {
    // Either the DB file is missing or the unicase collation extension could
    // not be built (no cc/sqlite headers). Unit tests above still cover the
    // full decoder + renderer surface with synthetic protobuf blobs.
    expect(true).toBe(true);
  });
});
