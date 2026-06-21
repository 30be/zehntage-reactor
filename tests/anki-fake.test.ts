/**
 * Unit tests for src/lib/anki.ts — the in-memory FAKE Anki double.
 *
 * After AnkiConnect was fully removed (windowless cutover), src/lib/anki.ts is
 * the ANKI_FAKE-only test double: listWords / addCard / deleteCard operate on an
 * in-memory map (no network, no secrets), and bustListWordsCache is a no-op-safe
 * cache buster the server still calls. The real read/write paths live in
 * ankidb.ts (routed by review.ts); the deleted AnkiConnect/remote upload helpers
 * (ankiLocalAvailable, uploadImage, uploadMedia, resolveMediaName, storeMedia)
 * are gone, so their tests were removed with them.
 *
 * Strategy:
 *  - ANKI_FAKE=1 for all in-memory path tests (no network, no secrets).
 *  - Unique front values per test (the module-level fakeCards map persists).
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listWords,
  addCard,
  deleteCard,
  bustListWordsCache,
  fakeDeckList,
  fakeDeckAdd,
  fakeDeckDeleteByFront,
  fakeDeckDeleteById,
  type AnkiCard,
} from "../src/lib/anki.ts";

// ---- helpers -----------------------------------------------------------------

const realEnv = { ...process.env };

function setFakeMode(on: boolean) {
  if (on) {
    process.env.ANKI_FAKE = "1";
  } else {
    delete process.env.ANKI_FAKE;
  }
}

function restoreEnv() {
  for (const k of Object.keys(process.env)) {
    if (!(k in realEnv)) delete process.env[k];
  }
  Object.assign(process.env, realEnv);
}

afterEach(() => {
  restoreEnv();
  bustListWordsCache();
});

// ===========================================================================
// ANKI_FAKE mode — in-memory map, no network
// ===========================================================================

describe("ANKI_FAKE — listWords / addCard / deleteCard", () => {
  beforeEach(() => {
    setFakeMode(true);
    bustListWordsCache();
  });

  test("starts empty", async () => {
    const cards = await listWords();
    // The module-level fakeCards map persists across tests because it is
    // module-level state. We cannot reset it directly (it is not exported),
    // but we use unique front values per test to avoid interference.
    expect(Array.isArray(cards)).toBe(true);
  });

  test("listWords returns [] when ANKI_FAKE is unset (no real backend here)", async () => {
    setFakeMode(false);
    const cards = await listWords();
    expect(cards).toEqual([]);
  });

  test("addCard stores card; listWords reflects it immediately (no cache)", async () => {
    const front = `test-front-${Date.now()}`;
    await addCard({ front, back: "裏面", notes: "n", context: "c" });
    const cards = await listWords();
    const found = cards.find((c) => c.front === front);
    expect(found).toBeDefined();
    expect(found!.back).toBe("裏面");
  });

  test("addCard with image_field=context wraps image in <img> tag inside context field", async () => {
    const front = `img-front-${Date.now()}`;
    await addCard({
      front,
      back: "back",
      context: "existing-context",
      image: "data:image/jpeg;base64,AAAA",
      image_field: "context",
    });
    const cards = await listWords();
    const found = cards.find((c) => c.front === front);
    expect(found).toBeDefined();
    // should contain both existing context and the <img> tag
    expect(found!.context).toContain("existing-context");
    expect(found!.context).toContain('<img src="data:image/jpeg;base64,AAAA">');
  });

  test("addCard with image but no image_field does NOT inject into context", async () => {
    const front = `img-noctx-${Date.now()}`;
    await addCard({
      front,
      back: "back",
      image: "data:image/jpeg;base64,BBBB",
      // no image_field
    });
    const cards = await listWords();
    const found = cards.find((c) => c.front === front);
    expect(found).toBeDefined();
    // context should NOT contain the img tag (image_field is not "context")
    expect(found!.context ?? "").not.toContain("<img");
  });

  test("addCard is a no-op when ANKI_FAKE is unset", async () => {
    setFakeMode(false);
    const front = `noop-${Date.now()}`;
    await addCard({ front, back: "b" });
    // Re-enable fake mode and confirm nothing was stored.
    setFakeMode(true);
    const cards = await listWords();
    expect(cards.find((c) => c.front === front)).toBeUndefined();
  });

  test("deleteCard removes the card", async () => {
    const front = `del-front-${Date.now()}`;
    await addCard({ front, back: "b" });
    await deleteCard(front);
    const cards = await listWords();
    expect(cards.find((c) => c.front === front)).toBeUndefined();
  });

  test("deleteCard on nonexistent front does not throw", async () => {
    await expect(deleteCard("nonexistent-zzz-xyz")).resolves.toBeUndefined();
  });

  test("listWords always reads live map in fake mode (no TTL cache)", async () => {
    const front = `cache-test-${Date.now()}`;
    // call listWords first to potentially cache
    await listWords();
    // add after
    await addCard({ front, back: "b" });
    // should still see it (no cache in fake mode)
    const cards = await listWords();
    expect(cards.find((c) => c.front === front)).toBeDefined();
  });

  test("addCard preserves extra fields (tags, noteId, etc.)", async () => {
    const front = `tags-test-${Date.now()}`;
    const card: AnkiCard = {
      front,
      back: "b",
      tags: ["zehntage", "test"],
      noteId: 12345,
    };
    await addCard(card);
    const cards = await listWords();
    const found = cards.find((c) => c.front === front);
    expect(found!.tags).toEqual(["zehntage", "test"]);
  });
});

// ===========================================================================
// listWords — live-map behavior + bustListWordsCache (ANKI_FAKE mode)
// ===========================================================================

describe("listWords — live-map in ANKI_FAKE mode", () => {
  beforeEach(() => {
    setFakeMode(true);
    bustListWordsCache();
  });

  test("concurrent calls in fake mode all return the same live-map snapshot", async () => {
    const front = `concurrent-${Date.now()}`;
    await addCard({ front, back: "b" });
    const [a, b, c] = await Promise.all([listWords(), listWords(), listWords()]);
    // All should see the same card (live map, no caching in fake mode)
    expect(a.find((card) => card.front === front)).toBeDefined();
    expect(b.find((card) => card.front === front)).toBeDefined();
    expect(c.find((card) => card.front === front)).toBeDefined();
  });

  test("bustListWordsCache is callable and idempotent (no AnkiConnect cache now)", () => {
    expect(() => bustListWordsCache()).not.toThrow();
    expect(() => bustListWordsCache()).not.toThrow(); // idempotent
  });
});

// ===========================================================================
// PERSISTENT FAKE DECK (ankiBackend === "fake") — on-disk JSON store
// ===========================================================================

describe("persistent fake deck (on-disk JSON store)", () => {
  let base: string;
  let savedDir: string | undefined;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "zr-fakedeck-test-"));
    savedDir = process.env.ZR_CONFIG_DIR;
    process.env.ZR_CONFIG_DIR = base;
  });

  afterEach(async () => {
    if (savedDir === undefined) delete process.env.ZR_CONFIG_DIR;
    else process.env.ZR_CONFIG_DIR = savedDir;
    await rm(base, { recursive: true, force: true });
  });

  test("list is [] when nothing has been written", () => {
    expect(fakeDeckList()).toEqual([]);
  });

  test("add persists a card and survives a re-read", async () => {
    const card: AnkiCard = { front: "勉強", back: "study", notes: "n", context: "c" };
    const r = await fakeDeckAdd(card);
    expect(r.ok).toBe(true);
    expect(typeof r.noteId).toBe("number");
    const cards = fakeDeckList();
    expect(cards.length).toBe(1);
    expect(cards[0]!.front).toBe("勉強");
    // default tag applied
    expect(cards[0]!.tags).toEqual(["zehntage"]);
  });

  test("add overwrites a card with the same front (no duplicate)", async () => {
    await fakeDeckAdd({ front: "本", back: "old" });
    await fakeDeckAdd({ front: "本", back: "new" });
    const cards = fakeDeckList();
    expect(cards.length).toBe(1);
    expect(cards[0]!.back).toBe("new");
  });

  test("deleteByFront removes the card; idempotent on a miss", async () => {
    await fakeDeckAdd({ front: "図書館", back: "library" });
    const r1 = await fakeDeckDeleteByFront("図書館");
    expect(r1).toEqual({ ok: true, deleted: 1 });
    expect(fakeDeckList()).toEqual([]);
    const r2 = await fakeDeckDeleteByFront("図書館"); // already gone
    expect(r2).toEqual({ ok: true, deleted: 0 });
  });

  test("deleteById removes by synthetic noteId", async () => {
    const { noteId } = await fakeDeckAdd({ front: "友達", back: "friend" });
    const r = await fakeDeckDeleteById(noteId);
    expect(r).toEqual({ ok: true, deleted: 1 });
    expect(fakeDeckList()).toEqual([]);
  });

  test("a corrupt store reads as [] rather than throwing", async () => {
    await Bun.write(join(base, "fake-deck.json"), "{ not valid json");
    expect(fakeDeckList()).toEqual([]);
  });
});
