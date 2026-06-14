// Global cross-episode subtitle search → jump to any line.
// Consumes the existing GET /api/search?q=… endpoint ({mediaId,name,start,text},
// JA+RU, max 100 hits) and surfaces it as a real page: debounced query,
// results grouped by episode, keyboard nav (↑/↓ move, Enter open, Esc clear),
// click → deep-link into the player at the cue (#/play/<id>@<start>).
// Monochrome/laconic; the matched substring is the only emphasized ink.
//
// TODO(server): #3 truncated flag — show "Showing first 100 results" warning when
//   server returns truncated:true (requires server/index.ts change).
// TODO(server): #4 skip/cache library.refresh() on search (server/index.ts).
// TODO(server): #9 add .normalize("NFC") to searchNorm*/searchNormRu (server/index.ts).
// TODO(server): #10 background preload of search index on startup (server/index.ts).

import { useEffect, useMemo, useRef, useState } from "react";
import { api, type SearchHit } from "./api.ts";
import {
  groupByEpisode,
  highlightHit,
  type HighlightSegment,
  displayName,
  fmtTimestamp,
  cueLink,
  flatHits,
} from "./searchquery.ts";

/** Render highlighted segments; matched substring → <mark>. */
function renderSegments(segs: HighlightSegment[]) {
  return segs.map((seg, i) =>
    seg.match ? <mark key={i}>{seg.text}</mark> : <span key={i}>{seg.text}</span>,
  );
}

export function Search({ go }: { go: (h: string) => void }) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [searchErr, setSearchErr] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  // #1: ref map from flat index → button element, used for scrollIntoView on arrow-key nav
  const hitRefs = useRef<Map<number, HTMLButtonElement>>(new Map());

  // autofocus the box on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // debounced query → /api/search (300ms, mirrors LibraryRoute's filter box)
  useEffect(() => {
    const q = query.trim();
    // #6: client-side min-length guard — don't fire request for very short queries
    if (!q || q.length < 2) {
      setHits(null);
      setLoading(false);
      setSearchErr(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setSearchErr(false);
    const t = window.setTimeout(() => {
      api
        .search(q)
        .then((res) => {
          if (cancelled) return;
          setHits(res);
          setLoading(false);
          setSel(0);
        })
        .catch(() => {
          if (cancelled) return;
          setSearchErr(true);
          setHits(null);
          setLoading(false);
        });
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [query, retryKey]);

  const groups = useMemo(() => groupByEpisode(hits ?? []), [hits]);
  const flat = useMemo(() => flatHits(groups), [groups]);

  // keep selection in range as results change
  useEffect(() => {
    setSel((s) => Math.min(s, Math.max(0, flat.length - 1)));
  }, [flat.length]);

  // #1: scroll selected row into view when sel changes via arrow keys
  useEffect(() => {
    hitRefs.current.get(sel)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const open = (h: SearchHit) => go(cueLink(h.mediaId, h.start));

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(flat.length - 1, s + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(0, s - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const h = flat[sel];
      if (h) open(h);
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (query) {
        setQuery("");
        setHits(null);
      }
    }
  };

  // running index across groups so a single selection threads the flat list
  let flatIdx = -1;

  return (
    <div className="search-route">
      <div className="search-route-head">
        <h1 className="search-route-title">Search subtitles</h1>
        <input
          ref={inputRef}
          className="search-route-input"
          type="text"
          placeholder="search subtitles (Japanese or Russian) across every episode…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          aria-label="Search subtitles"
        />
      </div>

      {query.trim() === "" && (
        <p className="search-route-empty muted">
          Type to search every episode's subtitles — Japanese or Russian.
        </p>
      )}

      {/* #6: gentle hint when query is non-empty but too short to search */}
      {query.trim().length > 0 && query.trim().length < 2 && (
        <p className="search-route-empty muted">type at least 2 characters to search</p>
      )}

      {query.trim() !== "" && loading && (
        <p className="search-route-status muted">searching…</p>
      )}

      {query.trim() !== "" && !loading && !searchErr && hits != null && flat.length === 0 && (
        <p className="search-route-status muted">no matches</p>
      )}

      {query.trim() !== "" && !loading && searchErr && (
        <p className="search-route-status search-route-error">
          Search failed — server may be unavailable.{" "}
          <button
            type="button"
            className="search-route-retry"
            onClick={() => setRetryKey((k) => k + 1)}
          >
            Retry
          </button>
        </p>
      )}

      {flat.length > 0 && (
        <div className="search-route-results">
          {groups.map((g) => (
            <section key={g.mediaId} className="search-route-group">
              {/* #7: show hit count per episode */}
              <h2 className="search-route-episode">{displayName(g.name)} ({g.hits.length})</h2>
              {g.hits.map((h) => {
                flatIdx += 1;
                const active = flatIdx === sel;
                const myIdx = flatIdx; // capture for ref callback
                const hl = highlightHit(h, query);
                const ruMatch = h.matchedLang === "ru";
                return (
                  <button
                    key={`${h.mediaId}:${h.start}`}
                    type="button"
                    className={`search-route-hit${active ? " sel" : ""}`}
                    ref={(el) => {
                      // #1: register/unregister button in hitRefs map for scrollIntoView
                      if (el) hitRefs.current.set(myIdx, el);
                      else hitRefs.current.delete(myIdx);
                    }}
                    onMouseEnter={() => setSel(flat.indexOf(h))}
                    onClick={() => open(h)}
                  >
                    <span className="search-route-time">
                      ▶ {fmtTimestamp(h.start)}
                    </span>
                    <span className="search-route-lines">
                      <span className="search-route-text">
                        {ruMatch && <span className="search-route-tag">JA</span>}
                        {renderSegments(hl.ja)}
                      </span>
                      {hl.ru != null && (
                        <span className="search-route-text-ru muted">
                          {ruMatch && <span className="search-route-tag">RU</span>}
                          {renderSegments(hl.ru)}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

export default Search;
