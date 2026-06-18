// OR-Set / 2P-Set CRDT for the two membership-style zr.* keys (zr.known,
// zr.blacklist). These are edited concurrently across tabs/devices, so whole-
// array last-write-wins silently erased one side's additions. Instead we store
// each as { adds: {member: ts}, removes: {member: ts} } and define membership
// as "members whose add-ts is strictly greater than their remove-ts". Merge is
// element-wise max(ts) per side, which is commutative/associative/idempotent —
// so the client (web/sync.ts) and server (src/lib/state.ts) converge identically
// regardless of push order.
//
// This module is DEPENDENCY-FREE (no DOM, no localStorage) so the server can
// import the exact same merge code — one source of truth, no shape drift.

export interface OrSet {
  /** member -> latest add timestamp (ms epoch). */
  adds: Record<string, number>;
  /** member -> latest remove (tombstone) timestamp (ms epoch). */
  removes: Record<string, number>;
}

/** The only two zr.* keys that use the OR-Set merge; everything else stays LWW. */
export const SET_KEYS: ReadonlySet<string> = new Set(["zr.known", "zr.blacklist"]);

export function isSetKey(k: string): boolean {
  return SET_KEYS.has(k);
}

function tsMap(x: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof x !== "object" || x === null) return out;
  for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/**
 * Parse a stored value into an OrSet. Accepts BOTH the new shape and a legacy
 * plain string[] (migration). `fallbackTs` is the add-ts assigned to legacy
 * array members (and is otherwise unused). Garbage -> empty set.
 */
export function parseOrSet(raw: string | null, fallbackTs: number): OrSet {
  if (raw == null) return { adds: {}, removes: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { adds: {}, removes: {} };
  }
  // legacy plain array -> all members added at fallbackTs
  if (Array.isArray(parsed)) {
    const adds: Record<string, number> = {};
    for (const m of parsed) if (typeof m === "string") adds[m] = fallbackTs;
    return { adds, removes: {} };
  }
  if (typeof parsed === "object" && parsed !== null) {
    const o = parsed as { adds?: unknown; removes?: unknown };
    return { adds: tsMap(o.adds), removes: tsMap(o.removes) };
  }
  return { adds: {}, removes: {} };
}

/** Serialize an OrSet for localStorage / the sync wire. */
export function serializeOrSet(o: OrSet): string {
  return JSON.stringify({ adds: o.adds, removes: o.removes });
}

/** Convert a legacy plain-array string into the serialized OrSet shape. */
export function migrateLegacyArray(raw: string | null, ts: number): string {
  return serializeOrSet(parseOrSet(raw, ts));
}

/** Members currently present: add-ts STRICTLY greater than remove-ts. */
export function orSetMembers(o: OrSet): Set<string> {
  const out = new Set<string>();
  for (const [m, addTs] of Object.entries(o.adds)) {
    const rmTs = o.removes[m];
    if (rmTs === undefined || addTs > rmTs) out.add(m);
  }
  return out;
}

/** Record an add at `ts` (use a fresh ts so it can win over a stale remove). */
export function orSetAdd(o: OrSet, member: string, ts: number): OrSet {
  const prev = o.adds[member];
  return {
    adds: { ...o.adds, [member]: prev === undefined ? ts : Math.max(prev, ts) },
    removes: o.removes,
  };
}

/** Record a tombstone at `ts` (un-marking a word). */
export function orSetRemove(o: OrSet, member: string, ts: number): OrSet {
  const prev = o.removes[member];
  return {
    adds: o.adds,
    removes: {
      ...o.removes,
      [member]: prev === undefined ? ts : Math.max(prev, ts),
    },
  };
}

function mergeTsMaps(
  a: Record<string, number>,
  b: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const cur = out[k];
    out[k] = cur === undefined ? v : Math.max(cur, v);
  }
  return out;
}

/** Element-wise max-ts merge of two OrSets (commutative/associative/idempotent). */
export function mergeOrSet(a: OrSet, b: OrSet): OrSet {
  return {
    adds: mergeTsMaps(a.adds, b.adds),
    removes: mergeTsMaps(a.removes, b.removes),
  };
}

/**
 * Merge two SERIALIZED set values (the wire/localStorage strings). Returns the
 * serialized merged value. `fallbackTs` migrates any legacy-array operand.
 */
export function mergeSerialized(
  localRaw: string | null,
  remoteRaw: string | null,
  fallbackTs: number,
): string {
  return serializeOrSet(
    mergeOrSet(
      parseOrSet(localRaw, fallbackTs),
      parseOrSet(remoteRaw, fallbackTs),
    ),
  );
}
