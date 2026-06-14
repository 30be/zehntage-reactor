// Global cross-episode subtitle search → jump to any line.
// Consumes the existing GET /api/search?q=… endpoint ({mediaId,name,start,text},
// JA-only, max 100 hits) and surfaces it as a real page: debounced query,
// results grouped by episode, keyboard nav (↑/↓ move, Enter open, Esc clear),
// click → deep-link into the player at the cue (#/play/<id>@<start>).
// Monochrome/laconic; the matched substring is the only emphasized ink.

import { useEffect, useMemo, useRef, useState } from "react";
import { api, type SearchHit } from "./api.ts";
import {
  groupByEpisode,
  highlightSplit,
  displayName,
  fmtTimestamp,
  cueLink,
  flatHits,
} from "./searchquery.ts";

export function Search({ go }: { go: (h: string) => void }) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // autofocus the box on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // debounced query → /api/search (300ms, mirrors LibraryRoute's filter box)
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setHits(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
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
          setHits([]);
          setLoading(false);
        });
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [query]);

  const groups = useMemo(() => groupByEpisode(hits ?? []), [hits]);
  const flat = useMemo(() => flatHits(groups), [groups]);

  // keep selection in range as results change
  useEffect(() => {
    setSel((s) => Math.min(s, Math.max(0, flat.length - 1)));
  }, [flat.length]);

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
          placeholder="find any line across every episode…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          aria-label="Search subtitles"
        />
      </div>

      {query.trim() === "" && (
        <p className="search-route-empty muted">
          Type to search every episode's Japanese transcript.
        </p>
      )}

      {query.trim() !== "" && loading && (
        <p className="search-route-status muted">searching…</p>
      )}

      {query.trim() !== "" && !loading && hits != null && flat.length === 0 && (
        <p className="search-route-status muted">no matches</p>
      )}

      {flat.length > 0 && (
        <div className="search-route-results">
          {groups.map((g) => (
            <section key={g.mediaId} className="search-route-group">
              <h2 className="search-route-episode">{displayName(g.name)}</h2>
              {g.hits.map((h) => {
                flatIdx += 1;
                const active = flatIdx === sel;
                return (
                  <button
                    key={`${h.mediaId}:${h.start}`}
                    type="button"
                    className={`search-route-hit${active ? " sel" : ""}`}
                    onMouseEnter={() => setSel(flat.indexOf(h))}
                    onClick={() => open(h)}
                  >
                    <span className="search-route-time">
                      ▶ {fmtTimestamp(h.start)}
                    </span>
                    <span className="search-route-text">
                      {highlightSplit(h.text, query).map((seg, i) =>
                        seg.match ? (
                          <mark key={i}>{seg.text}</mark>
                        ) : (
                          <span key={i}>{seg.text}</span>
                        ),
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
