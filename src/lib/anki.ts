// Proxy to the anki-mcp /zehntage/* endpoints (same server as zehntage-chrome).

import { loadSecrets } from "./env.ts";

export interface AnkiCard {
  front: string;
  back: string;
  notes?: string;
  context?: string;
  /** data: URI, http(s) URL, or an upload-dir path returned by uploadImage(). */
  image?: string;
  /** Field the image renders into on the card (default "notes" server-side). */
  image_field?: string;
  /** Anki note id (= creation timestamp ms); only from the local path. */
  noteId?: number;
  /** Note tags ("zehntage" marks cards mined by this app); local path only. */
  tags?: string[];
  [key: string]: unknown;
}

// e2e fake mode: ANKI_FAKE=1 operates on an in-memory map, no network.
const ankiFake = () => process.env.ANKI_FAKE === "1";
const fakeCards = new Map<string, AnkiCard>();

// --- ANKI_FAKE review queue (e2e only) -------------------------------------
//
// In fake mode the real review flow (queue → reveal → grade) has no AnkiConnect
// to talk to, so we model a tiny in-memory FSRS-like queue. reviewQueue() serves
// it (available:true) and answerCard() records the grade + drops the card. This
// is ENTIRELY gated on ankiFake() — when ANKI_FAKE is unset every fake branch is
// skipped and the real AnkiConnect paths run unchanged.
//
// The queue is seeded lazily (first reviewQueue() call) from the fake-Anki note
// map if it carries any cards, else from a fixed couple of cards — so an e2e can
// either seed via addCard()/POST /api/anki/add first, or just hit #/review cold.

let fakeQueue: ReviewCard[] | null = null;
// cardId → ease, kept for test inspection after grading.
const fakeAnswers = new Map<number, number>();

/** Build a ReviewCard from a fake-Anki note. A stable cardId is derived from
 *  the note's noteId when present, else the front string's char codes. */
function fakeCardFromNote(card: AnkiCard, idx: number): ReviewCard {
  const front = typeof card.front === "string" ? card.front : `card-${idx}`;
  const back = typeof card.back === "string" ? card.back : "";
  const cardId =
    typeof card.noteId === "number"
      ? card.noteId
      : 9_000_000 + idx; // deterministic, collision-free for the fixed seeds
  return {
    cardId,
    question: `<div class="fake-q">${front}</div>`,
    answer: `<div class="fake-q">${front}</div><hr><div class="fake-a">${back || front}</div>`,
    front,
  };
}

/** The two fixed cards used when no fake notes have been added. */
function fakeSeedDefaults(): ReviewCard[] {
  return [
    {
      cardId: 9_000_001,
      question: `<div class="fake-q">勉強</div>`,
      answer: `<div class="fake-q">勉強</div><hr><div class="fake-a">benkyō — study</div>`,
      front: "勉強",
    },
    {
      cardId: 9_000_002,
      question: `<div class="fake-q">図書館</div>`,
      answer: `<div class="fake-q">図書館</div><hr><div class="fake-a">toshokan — library</div>`,
      front: "図書館",
    },
  ];
}

/**
 * Lazily seed (once) and return the live fake queue. Seeds from the fake-Anki
 * note map if any cards were added, else from a fixed couple of cards. Once
 * built the SAME array instance is mutated by grading (answerCard splices),
 * so a drained queue stays empty — which lets the client reach its done state
 * on the post-batch refetch (no surprise reseed mid-session).
 */
function fakeQueueEnsure(): ReviewCard[] {
  if (fakeQueue) return fakeQueue;
  const notes = [...fakeCards.values()];
  fakeQueue =
    notes.length > 0
      ? notes.map((c, i) => fakeCardFromNote(c, i))
      : fakeSeedDefaults();
  return fakeQueue;
}

/** Reset the fake review queue + recorded answers (e2e seeding helper).
 *  Also clears any cards mined by other specs (fakeCards), so the queue
 *  rebuilds from the fixed 2-card seed (勉強, 図書館) regardless of run order
 *  — otherwise a mining spec (e.g. wave12 adding 学校) would leave its card at
 *  the head of the re-seeded queue and break the review specs' FRONT_1 head. */
export function fakeResetQueue(): void {
  if (!ankiFake()) return;
  fakeQueue = null;
  fakeAnswers.clear();
  fakeCards.clear();
}

// --- local AnkiConnect (still used by the mining/delete server paths) -------
//
// After the Stage 2b cutover the REVIEW flow no longer touches AnkiConnect
// (review.ts routes reads/writes through the DB engine, and only its
// ANKI_FAKE branch hits the in-memory fake below). What REMAINS live here is
// the mining/delete server path (server/index.ts): ankiLocalAvailable() probes
// a running Anki, storeMedia() writes frame/audio media into the open
// collection, and deleteCard()/addCard() (via resolveMediaName) still use the
// local AnkiConnect when reachable, falling back to the remote anki-mcp.

const AC_URL = process.env.ANKICONNECT_URL ?? "http://127.0.0.1:8765";
const AC_DECK = "Mixed";
const AC_MODEL = "Back+Front+Usage";
const AC_PROBE_TTL_MS = 60_000;
const AC_PROBE_TIMEOUT_MS = 300;

let acProbe: { at: number; ok: boolean } | null = null;

async function acRaw<T>(action: string, params?: unknown, timeoutMs?: number): Promise<T> {
  const resp = await fetch(AC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, version: 6, ...(params != null ? { params } : {}) }),
    ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
  });
  if (!resp.ok) throw new Error(`AnkiConnect ${action} → HTTP ${resp.status}`);
  const data = (await resp.json()) as { result?: T; error?: string | null };
  if (data.error) throw new Error(`AnkiConnect ${action}: ${data.error}`);
  return data.result as T;
}

/** Is a local AnkiConnect reachable? Probed lazily, cached for 60s. */
export async function ankiLocalAvailable(): Promise<boolean> {
  if (ankiFake()) return false;
  const now = Date.now();
  if (acProbe && now - acProbe.at < AC_PROBE_TTL_MS) return acProbe.ok;
  let ok = false;
  try {
    const v = await acRaw<number>("version", undefined, AC_PROBE_TIMEOUT_MS);
    ok = typeof v === "number" && v >= 6;
  } catch {
    ok = false;
  }
  acProbe = { at: now, ok };
  return ok;
}

// Model field mapping: the model is named "Back+Front+Usage" — resolve its
// actual field names once and map them onto our front/back/notes/context.
interface AcFieldMap {
  front: string;
  back: string;
  notes?: string;
  context?: string;
}
let acFieldsPromise: Promise<AcFieldMap> | null = null;

function acFieldMap(): Promise<AcFieldMap> {
  if (!acFieldsPromise) {
    acFieldsPromise = acRaw<string[]>("modelFieldNames", { modelName: AC_MODEL })
      .then((names) => {
        const find = (re: RegExp) => names.find((n) => re.test(n));
        const front = find(/front/i) ?? names[0] ?? "Front";
        const back = find(/back/i) ?? names[1] ?? "Back";
        const map: AcFieldMap = { front, back };
        const notes = find(/note/i);
        if (notes) map.notes = notes;
        const context = names.find(
          (n) => /usage|context/i.test(n) && n !== notes,
        );
        if (context) map.context = context;
        return map;
      })
      .catch((e) => {
        acFieldsPromise = null; // retry next time
        throw e;
      });
  }
  return acFieldsPromise;
}

interface AcNoteInfo {
  noteId: number;
  tags?: string[];
  fields: Record<string, { value: string; order: number }>;
}

async function acListCards(): Promise<AnkiCard[]> {
  const [fm, ids] = await Promise.all([
    acFieldMap(),
    acRaw<number[]>("findNotes", { query: `deck:${AC_DECK}` }),
  ]);
  if (ids.length === 0) return [];
  const infos = await acRaw<AcNoteInfo[]>("notesInfo", { notes: ids });
  return infos.map((n) => ({
    front: n.fields[fm.front]?.value ?? "",
    back: n.fields[fm.back]?.value ?? "",
    notes: fm.notes ? n.fields[fm.notes]?.value ?? "" : "",
    context: fm.context ? n.fields[fm.context]?.value ?? "" : "",
    noteId: n.noteId,
    tags: Array.isArray(n.tags) ? n.tags : [],
  }));
}

/** Subset of an Anki card's fields needed to estimate days-overdue. */
export interface DaysOverdueCard {
  interval: number;
  queue: number;
  mod: number;
}

/**
 * Estimate how many whole days a review card is overdue (>= 0).
 *
 * Anki's `due` column is queue-dependent (a day-number for review cards, but
 * epoch-seconds / position for learn/new), and AnkiConnect doesn't hand us the
 * collection's "today" day-count to subtract against — so decoding `due`
 * directly is ambiguous. Instead we use a queue-independent, self-contained
 * signal: a review card (queue 2) was last reviewed at `mod` (epoch seconds)
 * and its next due moment is `mod + interval*86400`. Days overdue is then
 * `floor((now - nextDue) / 86400)`, clamped to >= 0.
 *
 * Defensive: returns 0 for non-review cards, missing/garbage `mod`/`interval`,
 * or any non-finite result — so an undecidable card behaves like the old
 * interval-proxy (never mis-colored as heavily rotten).
 *
 * @param now epoch MILLISECONDS reference (injectable for tests).
 */
export function decodeDaysOverdue(
  card: DaysOverdueCard,
  now: number = Date.now(),
): number {
  // Only review cards (queue 2) carry an interval-based due date we can trust.
  if (card.queue !== 2) return 0;
  const interval = card.interval;
  const mod = card.mod;
  if (
    typeof interval !== "number" ||
    typeof mod !== "number" ||
    !Number.isFinite(interval) ||
    !Number.isFinite(mod) ||
    interval < 0 ||
    mod <= 0
  ) {
    return 0;
  }
  const DAY_MS = 86_400_000;
  const nextDueMs = mod * 1000 + interval * DAY_MS;
  const overdue = Math.floor((now - nextDueMs) / DAY_MS);
  if (!Number.isFinite(overdue) || overdue < 0) return 0;
  return overdue;
}

async function acAddCard(card: AnkiCard): Promise<void> {
  const fm = await acFieldMap();
  const fields: Record<string, string> = {
    [fm.front]: card.front,
    [fm.back]: card.back,
  };
  if (fm.notes) fields[fm.notes] = typeof card.notes === "string" ? card.notes : "";
  if (fm.context)
    fields[fm.context] = typeof card.context === "string" ? card.context : "";
  await acRaw("addNote", {
    note: {
      deckName: AC_DECK,
      modelName: AC_MODEL,
      fields,
      tags: Array.isArray(card.tags) ? card.tags : [],
      options: { allowDuplicate: false, duplicateScope: "deck" },
    },
  }, 15_000);
}

async function acDeleteCard(front: string): Promise<void> {
  const all = await acListCards();
  const ids = all
    .filter((c) => c.front === front)
    .map((c) => c.noteId)
    .filter((id): id is number => typeof id === "number");
  if (ids.length) await acRaw("deleteNotes", { notes: ids });
}

/**
 * Store raw media bytes in the LOCAL Anki collection under a meaningful
 * filename (AnkiConnect dedups by renaming, the actual stored name is
 * returned). Only valid when ankiLocalAvailable().
 */
export async function storeMedia(bytes: Uint8Array, filename: string): Promise<string> {
  const data = Buffer.from(bytes).toString("base64");
  const stored = await acRaw<string>("storeMediaFile", {
    filename,
    data,
    deleteExisting: false,
  });
  return stored || filename;
}

// ===========================================================================
// FAKE AnkiConnect test double — review flow (ANKI_FAKE=1, e2e only)
// ===========================================================================
//
// The REAL review flow (queue → reveal → grade → delete) no longer lives here:
// after the Stage 2b cutover review.ts drives all real reads/writes through the
// DB engine and only calls these functions inside its `ANKI_FAKE === "1"`
// branch. So reviewQueue / answerCard / deleteNote below are now FAKE-ONLY: each
// operates purely on the in-memory fake queue/map above. The previous real
// AnkiConnect (localhost:8765) machinery for these — findCards/cardsInfo +
// answerCards + cardsToNotes/deleteNotes, plus the HTML helpers (stripHtml,
// rewriteAnkiMedia), the AcReviewCardInfo shape and queueRank sorter — was dead
// after 2b-1 and has been deleted. DO NOT reintroduce a real branch here; the
// real path is ankidb.ts (dbReviewQueue/dbAnswerCard/dbDeleteNote).
//
// review.ts imports these under ac* aliases (acReviewQueue/acAnswerCard/
// acDeleteNote), so the export NAMES must stay even though the behavior is fake.

export interface ReviewCard {
  cardId: number;
  question: string;
  answer: string;
  front: string;
}

/** FAKE-ONLY: serve the in-memory fake review queue (e2e). */
export async function reviewQueue(
  _scope: "zehntage" | "all",
  limit = 50,
): Promise<{ available: boolean; due: number; cards: ReviewCard[] }> {
  if (!ankiFake()) return { available: false, due: 0, cards: [] };
  // `scope` is honored only insofar as the queue is a single shared deck —
  // the client always asks for "all" now (scope toggle removed).
  const q = fakeQueueEnsure();
  const cards = q.slice(0, limit);
  return { available: true, due: q.length, cards };
}

/** FAKE-ONLY: record the grade and drop the card from the fake queue (e2e). */
export async function answerCard(
  cardId: number,
  ease: 1 | 2 | 3 | 4,
): Promise<{ ok: boolean; error?: string }> {
  if (!ankiFake()) return { ok: false, error: "AnkiConnect not available" };
  // Mirrors how a real grade removes the card from today's due set.
  fakeAnswers.set(cardId, ease);
  const q = fakeQueueEnsure();
  const idx = q.findIndex((c) => c.cardId === cardId);
  if (idx >= 0) q.splice(idx, 1);
  bustListWordsCache();
  return { ok: true };
}

/** FAKE-ONLY: drain the card from the fake queue so the UI advances (e2e). */
export async function deleteNote(
  cardId: number,
): Promise<{ ok: boolean; error?: string }> {
  if (!ankiFake()) return { ok: false, error: "AnkiConnect not available" };
  // The note-map keyed by front is not touched — acceptable for tests; the
  // card just disappears from the review session.
  if (fakeQueue) {
    const idx = fakeQueue.findIndex((c) => c.cardId === cardId);
    if (idx >= 0) fakeQueue.splice(idx, 1);
  }
  bustListWordsCache();
  return { ok: true };
}

async function ankiBase(): Promise<{ base: string; key: string }> {
  const { ankiUrl, ankiKey } = await loadSecrets();
  if (!ankiUrl || !ankiKey) {
    throw new Error("ZEHNTAGE_ANKI_URL or ZEHNTAGE_ANKI_KEY not set in ~/.env");
  }
  return { base: ankiUrl, key: ankiKey };
}

/**
 * Upload raw image bytes to the anki-mcp unauthenticated `/upload` endpoint.
 * Returns the server-side path (under the upload dir) to pass as a card `image`,
 * so the frame becomes a real Anki media file instead of an inlined base64 blob.
 */
export async function uploadImage(
  bytes: Uint8Array,
  mimeType = "image/jpeg",
): Promise<string> {
  if (ankiFake()) return "fake/upload.jpg";
  const { base } = await ankiBase();
  const resp = await fetch(`${base}/upload`, {
    method: "POST",
    headers: { "Content-Type": mimeType },
    body: bytes,
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) {
    throw new Error(`anki-mcp upload error ${resp.status}: ${await resp.text()}`);
  }
  const data = (await resp.json()) as { ok?: boolean; path?: string };
  if (!data.path) throw new Error("anki-mcp upload returned no path");
  return data.path;
}

/**
 * Upload raw media bytes via multipart so the server keeps the file
 * EXTENSION (raw-body uploads of unknown MIME types get saved as ".bin",
 * and Anki clients pick the audio player by extension). Returns the
 * server-side upload path.
 */
export async function uploadMedia(
  bytes: Uint8Array,
  mimeType: string,
  filename: string,
): Promise<string> {
  if (ankiFake()) return `fake/${filename}`;
  const { base } = await ankiBase();
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: mimeType }), filename);
  const resp = await fetch(`${base}/upload`, { method: "POST", body: form, signal: AbortSignal.timeout(30_000) });
  if (!resp.ok) {
    throw new Error(`anki-mcp upload error ${resp.status}: ${await resp.text()}`);
  }
  const data = (await resp.json()) as { ok?: boolean; path?: string };
  if (!data.path) throw new Error("anki-mcp upload returned no path");
  return data.path;
}

/**
 * Resolve the name an uploaded file gets in Anki's media collection
 * (e.g. "anki_388b19310d1f.mp3") so it can be referenced via Anki's
 * `[sound:...]` syntax. The add endpoint only imports media through its
 * `image` mode (rendering an <img> tag — wrong for audio) and the media
 * name is random, so we: add a throwaway card with the upload as `image`,
 * read the generated <img src="..."> back from /zehntage/list, then delete
 * the throwaway card. The media file itself stays in the collection.
 */
export async function resolveMediaName(uploadPath: string): Promise<string | null> {
  const front = `zr-tmp-media-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await addCard({ front, back: "tmp", image: uploadPath, image_field: "context" });
    // The throwaway card was just added; force a fresh list so the (possibly
    // <60s-old) listWords cache can't hide it and silently drop the [sound:...] ref.
    bustListWordsCache();
    const cards = await listWords();
    const tmp = cards.find((c) => c.front === front);
    const m = typeof tmp?.context === "string" ? tmp.context.match(/<img src="([^"]+)"/) : null;
    return m?.[1] ?? null;
  } catch {
    return null;
  } finally {
    await deleteCard(front).catch(() => {});
  }
}

async function zehntageRequest(
  path: string,
  method: "GET" | "POST",
  body?: unknown,
): Promise<unknown> {
  const { ankiUrl, ankiKey } = await loadSecrets();
  if (!ankiUrl || !ankiKey) {
    throw new Error("ZEHNTAGE_ANKI_URL or ZEHNTAGE_ANKI_KEY not set in ~/.env");
  }
  const headers: Record<string, string> = { "X-Zehntage-Key": ankiKey };
  const opts: RequestInit = { method, headers, signal: AbortSignal.timeout(15000) };
  if (method === "POST") {
    headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body ?? {});
  }
  const resp = await fetch(`${ankiUrl}${path}`, opts);
  if (!resp.ok) {
    throw new Error(`anki-mcp error ${resp.status}: ${await resp.text()}`);
  }
  return resp.json();
}

async function listWordsRaw(): Promise<AnkiCard[]> {
  if (ankiFake()) return [...fakeCards.values()];
  if (await ankiLocalAvailable()) return acListCards();
  const list = await zehntageRequest("/zehntage/list", "GET");
  return Array.isArray(list) ? (list as AnkiCard[]) : [];
}

// Shared short-TTL cache + in-flight de-dup for listWords(): both
// /api/anki/cards and /api/anki/words call this, often at the same mount,
// each triggering a findNotes+notesInfo roundtrip. Concurrent callers await
// one promise; results are reused for LIST_WORDS_TTL_MS so the two endpoints
// don't each pay the cost. Errors are NOT cached (the inflight clears and the
// cached value is left untouched).
const LIST_WORDS_TTL_MS = 60_000;
let listWordsCache: { at: number; cards: AnkiCard[] } | null = null;
let listWordsInflight: Promise<AnkiCard[]> | null = null;

export function bustListWordsCache(): void {
  listWordsCache = null;
  listWordsInflight = null;
}

export async function listWords(): Promise<AnkiCard[]> {
  // Fake mode reads a mutable in-memory map directly — never cache it.
  if (ankiFake()) return [...fakeCards.values()];
  const c = listWordsCache;
  if (c && Date.now() - c.at < LIST_WORDS_TTL_MS) return c.cards;
  if (listWordsInflight) return listWordsInflight;
  const p = listWordsRaw()
    .then((cards) => {
      listWordsCache = { at: Date.now(), cards };
      return cards;
    })
    .finally(() => {
      if (listWordsInflight === p) listWordsInflight = null;
    });
  listWordsInflight = p;
  return p;
}

/**
 * FAKE-ONLY: progress map for token coloring (e2e). The real per-word
 * scheduling/progress now comes from ankidb.ts (dbProgress), routed by
 * review.ts's progressAuto; this fake branch (returns {}) is all that's left.
 */
export async function getProgress(): Promise<Record<string, number> | null> {
  if (ankiFake()) return {};
  return null;
}

export async function addCard(card: AnkiCard): Promise<void> {
  if (ankiFake()) {
    // Mirror the real anki-mcp behavior: an `image` renders as an <img> tag
    // inside the target field (the Cards tab filters on this).
    const stored = { ...card };
    if (stored.image && stored.image_field === "context") {
      stored.context = [stored.context, `<img src="${stored.image}">`]
        .filter(Boolean)
        .join("<br>");
    }
    fakeCards.set(card.front, stored);
    return;
  }
  if (await ankiLocalAvailable()) {
    // The local path never uses the upload-dir `image` mechanism — the caller
    // inlines <img src="..."> into context via storeMedia() beforehand.
    await acAddCard(card);
    return;
  }
  await zehntageRequest("/zehntage/add", "POST", card);
}

export async function deleteCard(front: string): Promise<void> {
  if (ankiFake()) {
    fakeCards.delete(front);
    return;
  }
  if (await ankiLocalAvailable()) {
    await acDeleteCard(front);
    return;
  }
  await zehntageRequest("/zehntage/delete", "POST", { front });
}
