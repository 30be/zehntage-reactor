// zr.blacklist: lemmas the user never wants counted as "unknown" (names,
// onomatopoeia…). Stored as an OR-Set (web/orset.ts) under "zr.blacklist" so
// concurrent edits across tabs/devices UNION instead of clobbering, and synced
// to the server with the rest of the zr.* namespace (web/sync.ts).

import {
  parseOrSet,
  orSetMembers,
  orSetAdd,
  orSetRemove,
  serializeOrSet,
} from "./orset.ts";
import { emitVocabChanged } from "./sync.ts";

const KEY = "zr.blacklist";

function readRaw(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function readBlacklist(): Set<string> {
  return orSetMembers(parseOrSet(readRaw(), Date.now()));
}

/**
 * Add or remove a single lemma, preserving the OR-Set tombstones so a stale
 * concurrent add can't resurrect a word the user just removed (and a later
 * re-add still wins). Writes through localStorage (sync picks it up).
 */
export function markBlacklist(key: string, on: boolean): void {
  try {
    const now = Date.now();
    let o = parseOrSet(readRaw(), now);
    o = on ? orSetAdd(o, key, now) : orSetRemove(o, key, now);
    localStorage.setItem(KEY, serializeOrSet(o));
    emitVocabChanged([KEY]);
  } catch {
    /* private mode */
  }
}

/**
 * Back-compat shim: callers that hold a desired final Set diff it against the
 * stored members and emit the minimal add/remove ops (so tombstones survive).
 */
export function writeBlacklist(set: Set<string>): void {
  try {
    const now = Date.now();
    let o = parseOrSet(readRaw(), now);
    const cur = orSetMembers(o);
    for (const m of set) if (!cur.has(m)) o = orSetAdd(o, m, now);
    for (const m of cur) if (!set.has(m)) o = orSetRemove(o, m, now);
    localStorage.setItem(KEY, serializeOrSet(o));
    emitVocabChanged([KEY]);
  } catch {
    /* private mode */
  }
}
