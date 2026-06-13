// Pre-study (`w`) panel: unknown lemmas in the upcoming playback window with
// i+1 / muddy badges and sequential bulk add. Pure presentation — scanning
// and the add loop live in Player.tsx. Extracted from Player.tsx.

import { freqTier } from "../freq.ts";

// One unknown word in the pre-study (`w`) panel.
export interface PreStudyItem {
  lemma: string; // dictionary form (wordKey) — what gets added to Anki
  reading?: string; // hiragana
  rank: number | null; // frequency rank, null = not in the 30k list
  context: string; // cue text where the word first appears
  time: number; // first-occurrence cue midpoint in FILE time (for frame capture)
  checked: boolean;
  added: boolean;
  /** the only unknown in >=1 window cue — instantly minable (web/prestudy.ts) */
  iPlusOne?: boolean;
  /** every occurrence cue is unknown-heavy — demoted, unchecked by default */
  muddy?: boolean;
}

export interface PreStudyState {
  loading: boolean;
  items: PreStudyItem[];
}

export function PreStudyPanel({
  preStudy,
  prestudyMin,
  preFrames,
  preBusy,
  preProg,
  onToggleFrames,
  onToggleItem,
  onBulkAdd,
  onClose,
}: {
  preStudy: PreStudyState;
  prestudyMin: number;
  preFrames: boolean;
  preBusy: boolean;
  preProg: number;
  onToggleFrames: () => void;
  onToggleItem: (lemma: string) => void;
  onBulkAdd: () => void;
  onClose: () => void;
}) {
  const todo = preStudy.items.filter((i) => i.checked && !i.added);
  return (
    <div className="lookup prestudy">
      <div className="prestudy-head">
        <span className="word">pre-study</span>
        <span
          className="prestudy-sub"
          title="Unknown words in the upcoming playback window, most common first"
        >
          next {prestudyMin} min
          {!preStudy.loading && ` · ${preStudy.items.length} new`}
        </span>
        <label
          className="prestudy-frames"
          title="Also capture a video frame for each card (slower)"
        >
          <input
            type="checkbox"
            checked={preFrames}
            disabled={preBusy}
            onChange={onToggleFrames}
          />
          with frames
        </label>
      </div>
      <div className="prestudy-list">
        {preStudy.loading && <div className="spin">scanning…</div>}
        {!preStudy.loading && preStudy.items.length === 0 && (
          <div className="spin">nothing new</div>
        )}
        {preStudy.items.map((it) => (
          <label
            key={it.lemma}
            className={`prestudy-row${it.added ? " added" : ""}`}
          >
            <input
              type="checkbox"
              checked={it.checked}
              disabled={it.added || preBusy}
              onChange={() => onToggleItem(it.lemma)}
            />
            <span className="ps-word">{it.lemma}</span>
            {it.reading && it.reading !== it.lemma && (
              <span className="ps-reading">{it.reading}</span>
            )}
            <span
              className="freq-tag"
              title="How common this word is (rank in a 30k frequency list)"
            >
              {freqTier(it.rank)}
            </span>
            {it.iPlusOne && (
              <span
                className="badge iplus"
                title="The only unknown word in at least one upcoming line — makes a clean card"
              >
                i+1
              </span>
            )}
            {it.muddy && (
              <span
                className="badge muddy"
                title="Only appears in lines crowded with unknown words — unchecked by default"
              >
                muddy
              </span>
            )}
            {it.added && <span className="ps-added">✓</span>}
          </label>
        ))}
      </div>
      <div className="row">
        <button
          className="btn"
          disabled={preBusy || todo.length === 0}
          title="Create one Anki card per checked word (sequentially)"
          onClick={onBulkAdd}
        >
          {preBusy ? `Adding… ${preProg}` : `Add ${todo.length} to Anki`}
        </button>
        <button className="btn" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
