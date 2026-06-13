// Simple JSON export/import of zehntage-reactor user data.
//
// A bundle is a single JSON document:
//   { version, exportedAt, settings, state, events }
//     settings — parsed settings.json (or {} if absent)
//     state    — parsed state.json zr.* snapshot (or {})
//     events   — array of parsed events.jsonl lines (capped, see MAX_EVENTS;
//                `eventsTruncated` flags when older events were dropped)
//
// Unlike backup.ts (a tar archive incl. subs/), this is a portable, human-
// readable bundle meant for moving settings + progress between machines.
//
// Importing is deliberately conservative:
//   - settings  -> merged via writeSettings (patch semantics)
//   - state     -> merged via mergeIntoFile (the SAME LWW path /api/state uses)
//   - events    -> NOT imported by default (avoid telemetry pollution); only
//                  appended when importBundle({ importEvents: true }).

import { readSettings, writeSettings, type Settings } from "./settings.ts";
import { readState, mergeIntoFile, sanitize, type ZrState } from "./state.ts";
import { readEvents, logEvents, type TelemetryEvent } from "./telemetry.ts";
import { configDirPath } from "./backup.ts";

export const BUNDLE_VERSION = 1;
/** Cap exported events so a chatty log doesn't make a giant bundle. */
export const MAX_EVENTS = 50000;

export interface ExportBundle {
  version: number;
  exportedAt: string;
  settings: Record<string, unknown>;
  state: ZrState;
  events: TelemetryEvent[];
  /** true when older events were dropped to fit MAX_EVENTS. */
  eventsTruncated: boolean;
}

async function packageVersion(): Promise<string> {
  try {
    const pkg = (await Bun.file(new URL("../../package.json", import.meta.url)).json()) as {
      version?: string;
    };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** Build the export bundle from the current config dir / events log. */
export async function buildExportBundle(now: Date = new Date()): Promise<ExportBundle> {
  const [settings, state, allEvents] = await Promise.all([
    readSettings(),
    readState(),
    readEvents(),
  ]);
  const eventsTruncated = allEvents.length > MAX_EVENTS;
  const events = eventsTruncated ? allEvents.slice(-MAX_EVENTS) : allEvents;
  return {
    version: BUNDLE_VERSION,
    exportedAt: now.toISOString(),
    settings: settings as Record<string, unknown>,
    state,
    events,
    eventsTruncated,
  };
}

/** Suggested download filename, e.g. zehntage-export-2026-06-13.json. */
export function exportFileName(now: Date = new Date()): string {
  return `zehntage-export-${now.toISOString().slice(0, 10)}.json`;
}

export interface ImportOptions {
  /** Append bundle.events to the telemetry log (default false). */
  importEvents?: boolean;
}

export interface ImportResult {
  settingsImported: boolean;
  stateKeys: number;
  eventsImported: number;
  /** version reported by app metadata (informational). */
  appVersion: string;
}

/** Throws Error("…") with a clear message if shape is wrong. */
export function validateBundle(raw: unknown): ExportBundle {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Invalid bundle: expected a JSON object");
  }
  const b = raw as Record<string, unknown>;
  if (typeof b.version !== "number") {
    throw new Error("Invalid bundle: missing numeric `version`");
  }
  if (b.version > BUNDLE_VERSION) {
    throw new Error(
      `Unsupported bundle version ${b.version} (this build understands up to ${BUNDLE_VERSION})`,
    );
  }
  if (b.settings !== undefined && (typeof b.settings !== "object" || b.settings === null || Array.isArray(b.settings))) {
    throw new Error("Invalid bundle: `settings` must be an object");
  }
  if (b.state !== undefined && (typeof b.state !== "object" || b.state === null || Array.isArray(b.state))) {
    throw new Error("Invalid bundle: `state` must be an object");
  }
  if (b.events !== undefined && !Array.isArray(b.events)) {
    throw new Error("Invalid bundle: `events` must be an array");
  }
  return {
    version: b.version,
    exportedAt: typeof b.exportedAt === "string" ? b.exportedAt : "",
    settings: (b.settings as Record<string, unknown>) ?? {},
    state: (b.state as ZrState) ?? {},
    events: (b.events as TelemetryEvent[]) ?? [],
    eventsTruncated: b.eventsTruncated === true,
  };
}

/**
 * Apply a bundle. Settings are merged (writeSettings), state is merged via the
 * shared LWW path, events are skipped unless explicitly requested.
 */
export async function importBundle(
  raw: unknown,
  opts: ImportOptions = {},
): Promise<ImportResult> {
  const bundle = validateBundle(raw);

  // Write settings, but keep a snapshot so we can roll back if the subsequent
  // state merge fails — otherwise a disk error leaves settings half-applied.
  let settingsImported = false;
  let settingsSnapshot: Settings | null = null;
  if (bundle.settings && Object.keys(bundle.settings).length > 0) {
    settingsSnapshot = await readSettings();
    await writeSettings(bundle.settings as Partial<Settings>);
    settingsImported = true;
  }

  // Route through the SAME merge logic /api/state POST uses (sanitize + LWW).
  let merged: ZrState;
  try {
    merged = await mergeIntoFile(sanitize(bundle.state));
  } catch (err) {
    // best-effort rollback; never let a second fault mask the original error
    if (settingsSnapshot) {
      try {
        await writeSettings(settingsSnapshot);
      } catch {
        /* ignore — surface the original failure below */
      }
    }
    throw err;
  }

  let eventsImported = 0;
  if (opts.importEvents && bundle.events.length > 0) {
    // cap count (same ceiling as export) so a hostile bundle can't bloat the log
    const valid = bundle.events
      .filter((e) => e && typeof e.type === "string" && typeof e.ts === "number")
      .slice(-MAX_EVENTS);
    await logEvents(valid);
    eventsImported = valid.length;
  }

  return {
    settingsImported,
    stateKeys: Object.keys(merged).length,
    eventsImported,
    appVersion: await packageVersion(),
  };
}

/** Re-export for callers that want the config dir (parity with backup.ts). */
export { configDirPath };
