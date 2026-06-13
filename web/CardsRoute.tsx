// #/cards — Cards browser: Anki cards mined from the player (their context
// carries a captured frame). Search/filter bar (text, date range, learning
// stage, rarity) over a `.cards-grid` of tiles with rewatch + delete actions.
// Extracted verbatim from App.tsx (behavior-preserving).

import { useCallback, useEffect, useMemo, useState } from "react";
import { Play, Trash2 } from "lucide-react";
import { api, type LibraryEntry } from "./api.ts";
import { loadFreq } from "./freq.ts";
import { fmtCueTime } from "./App.tsx";
import {
  filterCards,
  type DateRange,
  type Rarity,
  type Stage,
} from "./cardfilter.ts";

interface FullCard {
  front: string;
  back: string;
  notes: string;
  context: string;
  noteId?: number;
}

/** <img src="..."> inside the context HTML, or null. Bare Anki media
 * filenames are rewritten to the /api/anki/media proxy. */
function cardImgSrc(context: string): string | null {
  const m = context.match(/<img[^>]*\bsrc="([^"]+)"/i);
  const src = m?.[1];
  if (!src) return null;
  // absolute URL / data URI / server path → use as-is
  if (/^(https?:|data:|blob:|\/)/i.test(src)) return src;
  // bare Anki collection filename → local AnkiConnect media proxy
  return `/api/anki/media/${encodeURIComponent(src)}`;
}

/** Parse "<episode name> @ mm:ss" out of the context HTML. */
function cardEpisodeRef(context: string): { name: string; sec: number } | null {
  for (const part of context.split(/<br\s*\/?>/i)) {
    const m = part.trim().match(/^(.+?) @ (\d+):(\d{2})$/);
    if (m) return { name: m[1]!, sec: parseInt(m[2]!, 10) * 60 + parseInt(m[3]!, 10) };
  }
  return null;
}

const PAGE_SIZE = 50;

export function Cards({ go, toast }: { go: (h: string) => void; toast: (m: string) => void }) {
  const [cards, setCards] = useState<FullCard[] | null>(null);
  const [cardsErr, setCardsErr] = useState<string | null>(null);
  const [entries, setEntries] = useState<LibraryEntry[]>([]);
  // double-click-to-confirm delete: front of the card in "sure?" state
  const [confirmFront, setConfirmFront] = useState<string | null>(null);
  // one progress map + one freq map for the whole list — no per-row fetches
  const [intervals, setIntervals] = useState<Map<string, number>>(() => new Map());
  const [freq, setFreq] = useState<Map<string, number> | null>(null);
  // filters (laconic): text, date range, learning stage, rarity
  const [q, setQ] = useState("");
  const [range, setRange] = useState<DateRange>("all");
  const [stage, setStage] = useState<Stage>("all");
  const [rarity, setRarity] = useState<Rarity>("all");
  const [visible, setVisible] = useState(PAGE_SIZE);

  const loadCards = useCallback(() => {
    setCardsErr(null);
    // keep previous cards visible during retry — avoids null→data double-memo pass
    void fetch("/api/anki/cards")
      .then((r) => (r.ok ? (r.json() as Promise<FullCard[]>) : Promise.reject(r.status)))
      .then((data) => {
        setCards(data);
      })
      .catch((e) => {
        setCardsErr(`anki/cards → ${e instanceof Error ? e.message : e}`);
        // leave cards as-is (or empty on first load — setCards([]) only when null)
        setCards((prev) => prev ?? []);
      });
  }, []);

  useEffect(() => {
    loadCards();
    void api.library().then(setEntries).catch(() => {});
    void api
      .ankiWords()
      .then((a) =>
        setIntervals(
          new Map(
            Object.entries(a.progress).map(([front, p]) => [front, p.interval]),
          ),
        ),
      )
      .catch(() => {});
    void loadFreq().then(setFreq).catch(() => {});
  }, []);

  // reset paging whenever a filter changes
  useEffect(() => {
    setVisible(PAGE_SIZE);
  }, [q, range, stage, rarity]);

  // The Cards tab shows cards mined from the player (their context carries a
  // frame). Filtering + sorting is memoized and pure — smooth at 10k cards.
  const frameCards = useMemo(
    () => (cards ?? []).filter((c) => /<img/i.test(c.context)),
    [cards],
  );
  const filtered = useMemo(
    () => filterCards(frameCards, { q, range, stage, rarity, intervals, freq }),
    [frameCards, q, range, stage, rarity, intervals, freq],
  );
  // O(1) name→entry lookup for the rewatch button (avoids per-card .find()).
  const entryByName = useMemo(
    () => new Map(entries.map((e) => [e.name, e])),
    [entries],
  );

  const onDelete = async (front: string) => {
    if (confirmFront !== front) {
      setConfirmFront(front);
      return;
    }
    setConfirmFront(null);
    // optimistic removal — capture the removed card for rollback
    let removed: FullCard | undefined;
    setCards((prev) => {
      if (!prev) return prev;
      removed = prev.find((c) => c.front === front);
      return prev.filter((c) => c.front !== front);
    });
    try {
      await api.ankiDelete(front);
    } catch (e) {
      toast(`Delete failed: ${e instanceof Error ? e.message : e}`);
      // rollback: re-insert the card in its original position
      if (removed) {
        const r = removed;
        setCards((prev) => {
          if (!prev) return prev;
          // insert back sorted by noteId desc (same order as filterCards sort)
          const idx = prev.findIndex((c) => (c.noteId ?? -1) < (r.noteId ?? -1));
          if (idx === -1) return [...prev, r];
          return [...prev.slice(0, idx), r, ...prev.slice(idx)];
        });
      }
    }
  };

  return (
    <>
      <div className="cards-filters">
        <input
          className="search-input cards-search"
          type="text"
          aria-label="Filter cards by text"
          placeholder="search…"
          title="Filter by front or translation text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setQ("");
          }}
        />
        <select
          aria-label="Filter by date added"
          title="Filter by when the card was added (needs local Anki)"
          value={range}
          onChange={(e) => setRange(e.target.value as DateRange)}
        >
          <option value="all">any time</option>
          <option value="today">today</option>
          <option value="7d">7 days</option>
          <option value="30d">30 days</option>
        </select>
        <select
          aria-label="Filter by learning stage"
          title="Filter by learning stage (from the SRS interval)"
          value={stage}
          onChange={(e) => setStage(e.target.value as Stage)}
        >
          <option value="all">any stage</option>
          <option value="new">new</option>
          <option value="learning">learning</option>
          <option value="mature">mature</option>
        </select>
        <select
          aria-label="Filter by word rarity"
          title="Filter by word rarity (frequency tier)"
          value={rarity}
          onChange={(e) => setRarity(e.target.value as Rarity)}
        >
          <option value="all">any rarity</option>
          <option value="top 1k">top 1k</option>
          <option value="top 3k">top 3k</option>
          <option value="top 10k">top 10k</option>
          <option value="top 30k">top 30k</option>
          <option value="rare">rare</option>
        </select>
        {cards != null && (
          <span className="cards-count muted" title="Matching / total mined cards">
            {filtered.length} / {frameCards.length}
          </span>
        )}
      </div>
      {cards == null && (
        <div className="state" role="status">
          <span className="spinner" aria-hidden /> Loading…
        </div>
      )}
      {cardsErr != null && (
        <div className="state error" role="alert">
          Couldn’t load cards.
          <span className="state-detail">{cardsErr}</span>
          <button className="btn sm retry" onClick={loadCards}>
            Retry
          </button>
        </div>
      )}
      {cards != null && cardsErr == null && frameCards.length === 0 && (
        <div className="empty">No cards with frames yet.</div>
      )}
      {cards != null && frameCards.length > 0 && filtered.length === 0 && (
        <div className="empty">No cards match the filters.</div>
      )}
      <div className="cards-grid">
        {filtered.slice(0, visible).map((c) => {
          const img = cardImgSrc(c.context);
          const ref = cardEpisodeRef(c.context);
          const entry = ref ? entryByName.get(ref.name) : undefined;
          const m = /^(.*?)\s*\[(.*)\]\s*$/.exec(c.front);
          const word = m ? m[1] : c.front;
          const reading = m ? m[2] : "";
          return (
            <div key={c.front} className="card-tile" title={c.back}>
              {img ? (
                <img
                  className="card-frame"
                  src={img}
                  alt=""
                  loading="lazy"
                  width={144}
                  height={96}
                />
              ) : (
                <span className="card-frame placeholder" />
              )}
              <div className="card-word">
                {word}
                {reading && ` [${reading}]`}
              </div>
              <div className="card-actions">
                <button
                  className="card-play"
                  disabled={!entry || !ref}
                  title={
                    entry && ref
                      ? `Rewatch ${ref.name} @ ${fmtCueTime(ref.sec)}`
                      : "Source episode not in the library"
                  }
                  aria-label="rewatch"
                  onClick={() => entry && ref && go(`#/play/${entry.id}@${ref.sec}`)}
                >
                  <Play size={16} strokeWidth={1.75} aria-hidden />
                </button>
                <button
                  className={`card-del${confirmFront === c.front ? " confirm" : ""}`}
                  title={confirmFront === c.front ? "click again to confirm" : "delete"}
                  aria-label="delete"
                  onClick={() => void onDelete(c.front)}
                  onBlur={() => setConfirmFront((f) => (f === c.front ? null : f))}
                >
                  <Trash2 size={16} strokeWidth={1.75} aria-hidden />
                </button>
              </div>
            </div>
          );
        })}
      </div>
      {filtered.length > visible && (
        <button
          className="btn sm cards-more"
          title="Render the next 50 matching cards"
          onClick={() => setVisible((v) => v + PAGE_SIZE)}
        >
          show more ({filtered.length - visible} left)
        </button>
      )}
    </>
  );
}

export default Cards;
