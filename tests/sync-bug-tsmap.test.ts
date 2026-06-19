import { describe, test, expect } from "bun:test";
import {
  applyRemote,
} from "../web/sync.ts";
import { serializeOrSet } from "../web/orset.ts";

function memStorage(): Storage {
  const m = new Map<string, string>();
  const s = {
    get length() {
      return m.size;
    },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
  };
  return s as Storage;
}

describe("tsMap persistence bug in applyRemote", () => {
  test("OR-Set merge with identical content should persist updated ts", () => {
    const ls = memStorage();
    
    // Setup: local has zr.known with ts=100
    ls.setItem("zr.known", serializeOrSet({ adds: { a: 100 }, removes: {} }));
    ls.setItem("zr.sync.ts", JSON.stringify({ "zr.known": 100 }));
    
    // Remote has identical content but newer ts=200
    const remote = {
      "zr.known": {
        v: serializeOrSet({ adds: { a: 100 }, removes: {} }),
        ts: 200,
      },
    };
    
    // Apply remote
    const changed = applyRemote(remote, ls);
    
    // The content didn't change
    expect(changed).toEqual([]);
    
    // BUT - the tsMap should have been updated to 200 to reflect the remote's ts
    // This is where the bug is: tsMap is NOT persisted when content is identical
    const persisted = ls.getItem("zr.sync.ts");
    const tsMap = JSON.parse(persisted!);
    
    console.log("tsMap in localStorage:", tsMap);
    console.log("Expected ts=200 to avoid re-syncing, but got:", tsMap["zr.known"]);
    
    // This SHOULD be 200 (the remote's ts) to avoid re-syncing
    // But due to the bug, it's still 100
    expect(tsMap["zr.known"]).toBe(200); // This will FAIL due to the bug
  });
});
