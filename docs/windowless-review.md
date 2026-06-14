# Windowless Review Client — Operator Guide

## What it is

`#/review` is a hotkey-driven Anki review client embedded in zehntage-reactor.
It reviews one card at a time against your own Anki collection; all SRS
parameters (FSRS weights, desired retention, learning steps, daily limits) live
in Anki — the client never re-invents scheduling.

**Hotkeys**

- `Space` — reveal answer (also unblocks answer audio autoplay)
- `1` Again / `2` Hard / `3` Good / `4` Easy
- `R` — replay the answer audio
- Two-column toggle (header checkbox, persisted in `localStorage` as `zr.review.twocol`)

The UI always fetches scope `"all"` (Anki's full due queue for the Mixed deck).

---

## Routing — how grading reaches Anki

`src/lib/review.ts` owns the backend selector. Logic for both reads and writes:

**Read (queue + counts)**

The DB-direct snapshot (`dbReviewQueue` / `dbDeckCounts` in `src/lib/ankidb.ts`)
is preferred, but ONLY when Anki is closed (`!st.ankiOpen`). While Anki is open,
reading the on-disk file lags WAL-buffered writes, so a card graded through
AnkiConnect would re-appear in the snapshot — producing an infinite review loop.
When Anki is open, both read and write route through AnkiConnect.

**Write (`answerCardAuto`)**

| Condition | Route |
|---|---|
| AnkiConnect reachable | `acAnswerCard` via AnkiConnect |
| Anki closed, DB available | `dbAnswerCard` — windowless DB write |
| Neither | refuse, `{ok:false, reason:"no-backend"}` |

In fake/e2e mode (`ANKI_FAKE=1`) the DB-direct path is suppressed entirely; all
traffic goes to the in-memory fake AnkiConnect.

---

## Windowless DB write — safety invariants (`src/lib/ankidb.ts` `dbAnswerCard`)

The write path is fail-closed: every gate must pass or it refuses.

1. **Anki must be closed.** `canWrite()` (`src/lib/ankilock.ts`) checks:
   - collection file present
   - no running Anki process (scans `/proc` cmdlines + `pgrep` fallback)
   - no hot WAL (`collection.anki2-wal` size > 0) and no hot journal
   - schema version is in the supported set (`{18}`)
   If any check fails, `dbAnswerCard` returns `{ok:false, reason}` without
   touching the DB.

2. **Backup before any byte is written.** `backupCollection` copies
   `collection.anki2` (+ `-wal`/`-shm` if present) to a timestamped directory
   under `~/.local/share/zehntage/anki-backups/` (override: `ZR_ANKI_BACKUP_DIR`).
   A backup failure aborts the write.

3. **Single atomic transaction.** The real collection is opened read-write once.
   `BEGIN IMMEDIATE` grabs the write lock up front (returns `reason:"locked"` on
   `SQLITE_BUSY`). All mutations (`cards`, `revlog`, `col`) happen inside the
   transaction; any error triggers `ROLLBACK`.

4. **Metadata conventions.**
   - `cards.usn = -1` (marks the row as pending sync to AnkiWeb)
   - `col.mod` is bumped to `Date.now()` (milliseconds)
   - `col.scm` is NEVER touched (changing it would force a full collection sync)
   - `revlog.usn = -1`

5. **Post-commit integrity check.** After `COMMIT`, a `PRAGMA foreign_key_check`
   runs inside the transaction (rollback if it fires), then a WAL checkpoint and
   `PRAGMA integrity_check` after close. A non-`"ok"` result is surfaced as an
   error (the write already committed; the backup is the recovery point).

6. **FSRS-6 scheduling.** Intervals are computed by `src/lib/fsrs.ts` using deck
   FSRS weights decoded from `deck_config`. The interval stored is
   `round(I(S))` — deterministic, no fuzz. Anki applies ±5-day fuzz on its own
   next sync; the discrepancy is harmless.

---

## Auth — `ZEHNTAGE_DB_TOKEN`

The token is read once from `~/.env` (key `ZEHNTAGE_DB_TOKEN`), falling back to
the process environment. When **unset** the gate is open — no token required.
When **set**, `POST /api/review/answer` requires:

```
Authorization: Bearer <token>
```
or the custom header `X-Zehntage-Token: <token>`. The comparison is
constant-time (`timingSafeEqual`). Read-only endpoints (`/queue`, `/counts`,
`/status`) are never gated.

---

## API endpoints

All under `/api/review/`.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/review/queue` | Due card queue. Query param `scope=zehntage\|all` (default `zehntage`). Returns `{scope, available, due, cards[]}`. |
| `GET` | `/api/review/counts` | `{new, learning, review}` due counts. Same `scope` param. |
| `GET` | `/api/review/status` | Capability snapshot: `{dbPresent, ankiOpen, schemaOk, canQueue, canAnswer}`. |
| `POST` | `/api/review/answer` | Grade a card. Body: `{cardId: number, ease: 1\|2\|3\|4}`. Returns `{ok, error?, reason?}`. Auth-gated when token is set. |

---

## Known caveats

**Interval fuzz.** The windowless writer computes `round(I(S))` without fuzz.
When Anki later syncs the card, it does not re-fuzz already-scheduled reviews,
so intervals may land 0–4 days off what Anki would have chosen natively.
This is harmless.

**Stale `-shm` after crash.** A lone `collection.anki2-shm` left by a non-clean
shutdown does NOT block windowless grading — only a non-empty `-wal` or a live
Anki process counts as "open" (hardened in `dbStatus`). If you hit an
unexpected "Anki open" refusal after a crash and both `-wal` is absent/empty and
no Anki process is running, remove the stale sidecar while Anki is closed:

```sh
rm "$HOME/.local/share/Anki2/User 1/collection.anki2-shm"
```

**Remote media names.** Cards added while local AnkiConnect was unavailable may
carry `anki_*` image names pointing at the remote media server. The local
`/anki/media/<name>` proxy can't serve those. Re-add the affected cards through
the normal local flow.
