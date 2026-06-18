// Server-side persistence for the browser's zr.* localStorage namespace.
//
// Wired in src/server/index.ts:
//   GET  /api/state  -> 200 JSON ZrState           (readState())
//   POST /api/state  -> body ZrState (partial ok)  (mergeIntoFile(body)),
//                       responds 200 JSON with the merged full ZrState.
// The client (web/sync.ts) pushes only CHANGED keys, so POST bodies are
// partial maps; the server merges (last-write-wins per key via merge()),
// never replacing the file wholesale.
//   - File lives at $ZR_CONFIG_DIR/state.json (same override pattern as
//     settings.ts) — tests set ZR_CONFIG_DIR to a tmp dir.
//
// Shape: { "zr.known": { v: "[...]", ts: 1718000000000 }, ... }
//   v  = raw localStorage string value (opaque to the server)
//   ts = client-side write timestamp, ms epoch; ties resolve in favor of
//        the REMOTE (existing) value so a replayed push is a no-op.

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { isSetKey, mergeSerialized } from "../../web/orset.ts";

export interface ZrEntry {
  /** Raw localStorage string value. */
  v: string;
  /** Client write time, ms since epoch. */
  ts: number;
}

/** Full or partial snapshot of the zr.* namespace. */
export type ZrState = Record<string, ZrEntry>;

// ZR_CONFIG_DIR override keeps tests away from the user's real config
// (same pattern as settings.ts — read lazily so tests can set it up front).
function stateFile(): string {
  const dir =
    process.env.ZR_CONFIG_DIR || join(homedir(), ".config", "zehntage-reactor");
  return join(dir, "state.json");
}

function configDir(): string {
  return (
    process.env.ZR_CONFIG_DIR || join(homedir(), ".config", "zehntage-reactor")
  );
}

function isEntry(x: unknown): x is ZrEntry {
  return (
    typeof x === "object" &&
    x !== null &&
    typeof (x as ZrEntry).v === "string" &&
    typeof (x as ZrEntry).ts === "number" &&
    Number.isFinite((x as ZrEntry).ts)
  );
}

/** Drop malformed keys instead of failing the whole read. */
export function sanitize(raw: unknown): ZrState {
  const out: ZrState = {};
  if (typeof raw !== "object" || raw === null) return out;
  for (const [k, val] of Object.entries(raw as Record<string, unknown>)) {
    if (isEntry(val)) out[k] = { v: val.v, ts: val.ts };
  }
  return out;
}

export async function readState(): Promise<ZrState> {
  try {
    return sanitize(await Bun.file(stateFile()).json());
  } catch {
    return {};
  }
}

/**
 * Last-write-wins per key. Ties (equal ts) keep `base` so re-applying the
 * same patch is idempotent in both directions.
 */
export function merge(base: ZrState, incoming: ZrState): ZrState {
  const out: ZrState = { ...base };
  for (const [k, e] of Object.entries(incoming)) {
    const cur = out[k];
    // zr.known / zr.blacklist are OR-Sets: value-merge element-wise so two
    // devices' concurrent additions union instead of last-write-wins clobbering
    // (Fix 2). Same merge code as the client (web/orset.ts) -> identical
    // convergence. ts advances to max so a later push still re-merges cleanly.
    if (isSetKey(k)) {
      const v = mergeSerialized(cur?.v ?? null, e.v, cur?.ts ?? 0);
      out[k] = { v, ts: Math.max(cur?.ts ?? 0, e.ts) };
      continue;
    }
    if (!cur || e.ts > cur.ts) out[k] = e;
  }
  return out;
}

/** Merge a (possibly partial) client push into state.json; returns merged. */
export async function mergeIntoFile(incoming: ZrState): Promise<ZrState> {
  const merged = merge(await readState(), sanitize(incoming));
  await mkdir(configDir(), { recursive: true });
  await Bun.write(stateFile(), JSON.stringify(merged, null, 2));
  return merged;
}
