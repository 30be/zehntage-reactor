# Windowless Review Client — Operator Guide

## What it is

`#/review` is a hotkey-driven Anki review client embedded in zehntage-reactor.
It reviews one card at a time against your own Anki collection directly on disk
— **no AnkiConnect, no running Anki required**. All SRS parameters (FSRS
weights, desired retention, learning steps, daily limits) live in the collection;
the client never re-invents scheduling.

**Hotkeys**

- `Space` — reveal answer (also unblocks answer audio autoplay)
- `1` Again / `2` Hard / `3` Good / `4` Easy
- `R` — replay the answer audio
- `Delete` — delete the current note from Anki (available on question and answer phase)
- Two-column toggle (header checkbox, persisted in `localStorage` as `zr.review.twocol`)

All hotkeys use `e.code` (physical key position), so they work on any keyboard
layout (e.g. Cyrillic `к` still triggers replay because it maps to `KeyR`).

The UI always fetches scope `"all"` (Anki's full due queue for the Mixed deck).

**When Anki is OPEN**: reads proceed against the on-disk snapshot (may lag Anki's
WAL-buffered edits); writes (grade, delete, add) are REFUSED — the UI tells the
user to close Anki and retry. This is an intentional inversion from the previous
AnkiConnect-first design: the app no longer requires Anki to be open.

---

## Routing — how grading reaches the collection

`src/lib/review.ts` owns the backend selector. The real backend is **always
DB-direct** (`src/lib/ankidb.ts`). AnkiConnect (localhost:8765) is no longer
called for any real read or write.

**Reads** (queue, counts, card list, progress/coloring, media) use the DB
snapshot unconditionally. While Anki is open the snapshot may lag — acceptable
and safe because writes fail-closed (no write occurs, no infinite loop).

**Writes** (`answerCardAuto` / `deleteNoteAuto` / `addNoteAuto`) always route to
the DB-direct path. They fail-closed when Anki holds the collection:

| Condition | Route |
|---|---|
| Anki closed, DB available | DB-direct write (`dbAnswerCard` / `dbDeleteNote` / `dbAddNote`) |
| Anki OPEN | refuse — `{ok:false, reason:"anki-open"}` or `"locked"` |
| DB unavailable | refuse — `{ok:false, reason:"no-backend"}` |

In fake/e2e mode (`ANKI_FAKE=1`) the DB-direct path is suppressed entirely; all
traffic goes to the **in-memory fake** (not AnkiConnect). This branch must stay
or all review e2e specs break.

---

## Windowless DB write — safety invariants (`src/lib/ankidb.ts`)

All write functions (`dbAnswerCard`, `dbDeleteNote`, `dbAddNote`, `dbStoreMedia`)
share the same fail-closed posture:

1. **Anki must be closed.** `canWrite()` (`src/lib/ankilock.ts`) checks:
   - collection file present
   - no running Anki process (scans `/proc` cmdlines + `pgrep` fallback)
   - no hot WAL (`collection.anki2-wal` size > 0) and no hot journal
   - schema version is in the supported set (`{18}`)
   If any check fails, the function returns `{ok:false, reason}` without
   touching the DB.

2. **Backup before any byte is written.** `backupCollection` copies
   `collection.anki2` (+ `-wal`/`-shm` if present) to a timestamped directory
   under `~/.local/share/zehntage/anki-backups/` (override: `ZR_ANKI_BACKUP_DIR`).
   A backup failure aborts the write. (`dbStoreMedia` is backup-free — it is
   additive-only and treated as best-effort / non-fatal by its callers.)

3. **Single atomic transaction.** The real collection is opened read-write once.
   `BEGIN IMMEDIATE` grabs the write lock up front (returns `reason:"locked"` on
   `SQLITE_BUSY`). All mutations happen inside the transaction; any error
   triggers `ROLLBACK`.

4. **Metadata conventions.**
   - `cards.usn = -1` / `notes.usn = -1` / `revlog.usn = -1` — marks rows
     pending sync to AnkiWeb.
   - `col.mod` is bumped to `Date.now()` (milliseconds).
   - `col.scm` is NEVER touched (changing it would force a full collection sync).
   - `dbDeleteNote` inserts graves (`type 0` per card, `type 1` for the note,
     all `usn=-1`) so the next AnkiWeb sync propagates the deletion.
   - `dbAddNote` resolves guid, csum, fields, and notetype from the DB — the
     same logic Anki uses — so cards are faithful to the real notetype.

5. **Post-commit integrity check.** After `COMMIT`, a `PRAGMA foreign_key_check`
   runs (rollback if it fires), then a WAL checkpoint and `PRAGMA integrity_check`
   after close. A non-`"ok"` result is surfaced as an error (the backup is the
   recovery point).

6. **FSRS-6 scheduling** (`dbAnswerCard`). Intervals are computed by
   `src/lib/fsrs.ts` using deck FSRS weights decoded from `deck_config`. The
   interval stored is `round(I(S))` — deterministic, no fuzz. Anki applies ±5-day
   fuzz on its own next sync; the discrepancy is harmless.

### Media (`dbStoreMedia`)

Audio is stored into `collection.media/` and registered in `collection.media.db2`
so it syncs to AnkiWeb. Dedup by filename + content: identical bytes under the
same name are reused; different bytes under a taken name get a `-<n>` suffix.
Images are embedded as `data:URI` inline in the card fields rather than written
to media. `dbStoreMedia` is fail-closed (Anki must be closed) but best-effort —
callers drop audio rather than failing the whole add.

---

## Auth — `ZEHNTAGE_DB_TOKEN`

The token is read once from `~/.env` (key `ZEHNTAGE_DB_TOKEN`), falling back to
the process environment. When **unset** the gate is open — no token required.
When **set**, all write endpoints require:

```
X-Zehntage-Token: <token>
```

or `Authorization: Bearer <token>`. The comparison is constant-time
(`timingSafeEqual`). Read-only endpoints (`/queue`, `/counts`, `/status`) are
never gated.

---

## API endpoints

All under `/api/review/`.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/review/queue` | Due card queue. Query param `scope=zehntage\|all` (default `zehntage`). Returns `{available, due, cards[]}`. |
| `GET` | `/api/review/counts` | `{new, learning, review}` due counts. Same `scope` param. |
| `GET` | `/api/review/status` | Capability snapshot: `{dbPresent, ankiOpen, schemaOk, canQueue, canAnswer}`. |
| `POST` | `/api/review/answer` | Grade a card. Body: `{cardId: number, ease: 1\|2\|3\|4}`. Returns `{ok, error?, reason?}`. Auth-gated when token set. |
| `POST` | `/api/review/delete` | Delete the note for a card. Body: `{cardId: number}`. Returns `{ok, error?, reason?}`. Auth-gated when token set. |

Mining (add note) goes through `POST /api/anki/add` (same DB-direct backend,
same auth gate, same fail-closed posture). Card list / progress / media are
served by `GET /api/anki/cards`, `GET /api/anki/words`, and
`GET /api/anki/media/<name>` respectively.

---

## Known caveats

**Interval fuzz.** The windowless writer computes `round(I(S))` without fuzz.
When Anki later syncs the card, it does not re-fuzz already-scheduled reviews,
so intervals may land 0–4 days off what Anki would have chosen natively.
This is harmless.

**Stale read while Anki is open.** The review queue is read from the on-disk
snapshot even when Anki is running. Edits Anki has buffered in the WAL (but
not yet checkpointed) will not appear. This is safe — writes are still refused —
but you may see cards you just graded in Anki appear again in the queue until
Anki checkpoints.

**Stale `-shm` after crash.** A lone `collection.anki2-shm` left by a non-clean
shutdown does NOT block windowless grading — only a non-empty `-wal` or a live
Anki process counts as "open" (hardened in `dbStatus`). If you hit an
unexpected "Anki open" refusal after a crash and both `-wal` is absent/empty and
no Anki process is running, remove the stale sidecar while Anki is closed:

```sh
rm "$HOME/.local/share/Anki2/User 1/collection.anki2-shm"
```

**Audio on windowless-added cards.** Audio files written by `dbStoreMedia` land
in `collection.media/` and are immediately playable via `/api/anki/media/<name>`.
Images are embedded as `data:URI` and need no media file.
