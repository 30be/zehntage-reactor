// Minimal AnkiConnect client (the SAFE write path when Anki is OPEN).
//
// When the user has Anki running it holds the collection's WAL lock, so the
// direct-DB writer (ankidb.ts) refuses (canWrite → "anki-open"/"locked"). But
// the player's `a` hotkey must still mine/un-mine. AnkiConnect (a popular Anki
// add-on serving http://127.0.0.1:8765) lets us add/delete notes THROUGH the
// running Anki — never touching the DB file directly — so it is the correct
// channel while Anki is open. review.ts routes here first; if AnkiConnect is
// unreachable AND Anki is closed it falls back to the direct-DB writer.
//
// Card-shape parity: acAddNote MUST create the SAME note dbAddNote does — same
// model (Back+Front+Usage), deck (Mixed), tag (zehntage), field names
// (Front/Back/notes/context). We import those constants from ankidb.ts so the
// two paths can never drift.
//
// Robustness: every call is best-effort and NEVER throws uncaught. Connection
// refusal, timeout, malformed JSON, or an AnkiConnect `{error:!null}` body all
// map to a clean boolean / {ok:false,...} result. Disabled under ANKI_FAKE=1
// (tests stay hermetic) and under an explicit ZR_ANKICONNECT_DISABLE=1.

import { ZR_DECK_NAME, ZR_NOTETYPE_NAME, ZR_TAG } from "./ankidb.ts";

/** Base URL of the AnkiConnect endpoint; overridable for non-default setups. */
function baseUrl(): string {
  return process.env.ZR_ANKICONNECT_URL || "http://127.0.0.1:8765";
}

/** Whether the AnkiConnect path is permitted at all (off in fake/test mode). */
function enabled(): boolean {
  if (process.env.ANKI_FAKE === "1") return false;
  if (process.env.ZR_ANKICONNECT_DISABLE === "1") return false;
  return true;
}

/** Default probe/request timeout (ms); short so a closed Anki fails fast. */
const DEFAULT_TIMEOUT_MS = 1500;

interface AcResponse<T> {
  result: T | null;
  error: string | null;
}

/**
 * POST one AnkiConnect action and return a normalized result. NEVER throws:
 *   - connection refused / network error / timeout → { ok:false, transport:true }
 *   - AnkiConnect `{error: "..."}` (non-null)       → { ok:false, error }
 *   - success                                       → { ok:true, result }
 * `transport:true` distinguishes "AnkiConnect not reachable" (so callers can
 * fall back to the DB path) from "reachable but the action failed".
 */
async function acRaw<T>(
  action: string,
  params: Record<string, unknown> = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<
  | { ok: true; result: T }
  | { ok: false; error: string; transport: boolean }
> {
  if (!enabled()) {
    return { ok: false, error: "AnkiConnect disabled", transport: true };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(baseUrl(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, version: 6, params }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      return {
        ok: false,
        error: `AnkiConnect HTTP ${res.status}`,
        transport: false,
      };
    }
    let body: AcResponse<T>;
    try {
      body = (await res.json()) as AcResponse<T>;
    } catch {
      return { ok: false, error: "AnkiConnect bad JSON", transport: false };
    }
    if (body.error != null) {
      return { ok: false, error: String(body.error), transport: false };
    }
    return { ok: true, result: body.result as T };
  } catch (e) {
    // fetch rejects on connection-refused (Anki closed / add-on off) and on the
    // AbortController timeout. Both mean "not reachable" → transport failure.
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg, transport: true };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe whether AnkiConnect is reachable (the `version` action). Returns false
 * on connection refusal / timeout / any error — never throws. Use this to
 * decide the SAFE write path while Anki is open.
 */
export async function acAvailable(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<boolean> {
  if (!enabled()) return false;
  const r = await acRaw<number>("version", {}, timeoutMs);
  return r.ok && typeof r.result === "number";
}

/** Card fields accepted by acAddNote (matches dbAddNote's logical fields). */
export interface AcAddCard {
  front: string;
  back: string;
  notes?: string;
  context?: string;
  tags?: string[];
}

export interface AcAddResult {
  ok: boolean;
  error?: string;
  /** "duplicate" when the note already exists; "transport" when unreachable. */
  reason?: string;
  noteId?: number;
}

/**
 * Add a note via AnkiConnect, mirroring dbAddNote's card shape EXACTLY:
 *   modelName = "Back+Front+Usage", deckName = "Mixed", tags = ["zehntage"],
 *   fields = { Front, Back, notes, context }, options.allowDuplicate = false.
 *
 * Returns {ok:true, noteId} on success. AnkiConnect's addNote returns
 * `result:null` + a "duplicate" error when the card already exists with
 * allowDuplicate:false — surfaced as {ok:false, reason:"duplicate"} so the
 * routing/UI matches the DB path. Transport failures carry reason:"transport".
 */
export async function acAddNote(card: AcAddCard): Promise<AcAddResult> {
  const tags = Array.isArray(card.tags) && card.tags.length > 0 ? card.tags : [ZR_TAG];
  const r = await acRaw<number | null>("addNote", {
    note: {
      deckName: ZR_DECK_NAME,
      modelName: ZR_NOTETYPE_NAME,
      // Field names mirror the Back+Front+Usage notetype exactly. dbAddNote
      // maps the same logical values onto these fields case-insensitively.
      fields: {
        Front: card.front,
        Back: card.back,
        notes: typeof card.notes === "string" ? card.notes : "",
        context: typeof card.context === "string" ? card.context : "",
      },
      tags,
      options: { allowDuplicate: false },
    },
  });
  if (r.ok) {
    if (typeof r.result === "number") return { ok: true, noteId: r.result };
    // addNote returned no id without an error — treat as a soft failure.
    return { ok: false, error: "addNote returned no note id" };
  }
  // AnkiConnect reports duplicates as an error string containing "duplicate".
  if (!r.transport && /duplicate/i.test(r.error)) {
    return { ok: false, reason: "duplicate", error: r.error };
  }
  return {
    ok: false,
    error: r.error,
    reason: r.transport ? "transport" : undefined,
  };
}

export interface AcDeleteResult {
  ok: boolean;
  error?: string;
  /** "not-found" when no note matched the front; "transport" when unreachable. */
  reason?: string;
  /** How many notes were deleted (0 when not-found). */
  deleted?: number;
}

/**
 * Escape a value for use inside a quoted Anki search term. Anki search treats
 * backslash and double-quote specially; everything else is literal inside
 * `Front:"..."`. We backslash-escape both so e.g. `Käfig, der (-e)` matches.
 */
function escapeSearchValue(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Delete the note(s) whose Front field equals `front`, via AnkiConnect, mirroring
 * dbDeleteNoteByFront's semantics:
 *   - resolve front → note ids with findNotes (deck:Mixed, exact Front match),
 *   - deleteNotes(ids).
 * A front that matches nothing returns {ok:false, reason:"not-found"} — the
 * server route treats not-found as a successful no-op (already-absent). When
 * several notes share a front, all are removed (un-mine that word). Transport
 * failures carry reason:"transport".
 */
export async function acDeleteByFront(front: string): Promise<AcDeleteResult> {
  const query = `deck:${ZR_DECK_NAME} Front:"${escapeSearchValue(front)}"`;
  const found = await acRaw<number[]>("findNotes", { query });
  if (!found.ok) {
    return {
      ok: false,
      error: found.error,
      reason: found.transport ? "transport" : undefined,
    };
  }
  const ids = Array.isArray(found.result) ? found.result : [];
  if (ids.length === 0) return { ok: false, reason: "not-found", deleted: 0 };

  const del = await acRaw<null>("deleteNotes", { notes: ids });
  if (!del.ok) {
    return {
      ok: false,
      error: del.error,
      reason: del.transport ? "transport" : undefined,
    };
  }
  return { ok: true, deleted: ids.length };
}
