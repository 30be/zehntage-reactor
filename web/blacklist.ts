// zr.blacklist: lemmas the user never wants counted as "unknown" (names,
// onomatopoeia…). Stored as a JSON string[] in localStorage so web/sync.ts
// ships it to the server with the rest of the zr.* namespace.

const KEY = "zr.blacklist";

export function readBlacklist(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return new Set(
      Array.isArray(raw) ? raw.filter((w): w is string => typeof w === "string") : [],
    );
  } catch {
    return new Set();
  }
}

export function writeBlacklist(set: Set<string>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify([...set]));
  } catch {
    /* private mode */
  }
}
