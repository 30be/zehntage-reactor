import { describe, test, expect } from "bun:test";
import {
  applyRemote,
  TOMBSTONE,
} from "../web/sync.ts";

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

describe("tsMap persistence bug - tombstone case", () => {
  test("Remote tombstone for non-existent key updates tsMap but doesn't persist it", () => {
    const ls = memStorage();
    
    // Setup: local has no zr.pos.x key
    ls.setItem("zr.sync.ts", JSON.stringify({}));
    
    // Remote sends a tombstone for a key that doesn't exist locally
    const remote = {
      "zr.pos.x": {
        v: TOMBSTONE,
        ts: 100,
      },
    };
    
    // Apply remote
    const changed = applyRemote(remote, ls);
    
    // No change because key didn't exist anyway
    expect(changed).toEqual([]);
    
    // BUT - the tsMap should have been updated to 100 to reflect that we've seen this removal
    const persisted = ls.getItem("zr.sync.ts");
    const tsMap = JSON.parse(persisted!);
    
    console.log("tsMap:", tsMap);
    console.log("Key zr.pos.x in tsMap:", tsMap["zr.pos.x"]);
    
    // This SHOULD be 100 (to know we've processed this tombstone)
    // But due to the bug, it's undefined
    expect(tsMap["zr.pos.x"]).toBe(100); // This will FAIL
  });
});
