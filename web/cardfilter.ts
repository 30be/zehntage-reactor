// Pure card-filtering helpers for the Cards tab — kept DOM-free so the
// 10k-card load test (tests/load.test.ts) can exercise them directly.

export interface CardLite {
  front: string;
  back: string;
  notes: string;
  context: string;
  /** Anki note id (= creation timestamp ms); absent on the remote backend. */
  noteId?: number;
}

export type DateRange = "today" | "7d" | "30d" | "all";
export type Stage = "all" | "new" | "learning" | "mature";
export type Rarity = "all" | "top 1k" | "top 3k" | "top 10k" | "top 30k" | "rare";

export const MATURE_INTERVAL_DAYS = 21;

/** Learning stage from the SRS interval (days). */
export function cardStage(interval: number | undefined): Exclude<Stage, "all"> {
  const d = interval ?? 0;
  if (d <= 0) return "new";
  return d >= MATURE_INTERVAL_DAYS ? "mature" : "learning";
}

/** Bare word of a front ("word [reading]" → "word"). */
export function frontWord(front: string): string {
  return front.replace(/\s*\[.*$/, "").trim();
}

function rarityOf(rank: number | null | undefined): Exclude<Rarity, "all"> {
  if (rank == null) return "rare";
  if (rank <= 1000) return "top 1k";
  if (rank <= 3000) return "top 3k";
  if (rank <= 10_000) return "top 10k";
  if (rank <= 30_000) return "top 30k";
  return "rare";
}

export interface CardFilterOpts {
  q?: string;
  range?: DateRange;
  stage?: Stage;
  rarity?: Rarity;
  /** front -> interval days (from Anki progress). */
  intervals?: ReadonlyMap<string, number>;
  /** word -> frequency rank (from freq.json). */
  freq?: ReadonlyMap<string, number> | null;
  now?: number;
}

/**
 * Filter + sort (date-added desc when noteIds exist; stable otherwise).
 * One pass, no per-row I/O — stays fast at 10k cards.
 */
export function filterCards(cards: readonly CardLite[], opts: CardFilterOpts): CardLite[] {
  const q = (opts.q ?? "").trim().toLowerCase();
  const range = opts.range ?? "all";
  const stage = opts.stage ?? "all";
  const rarity = opts.rarity ?? "all";
  const now = opts.now ?? Date.now();
  let minTs = 0;
  if (range === "today") {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    minTs = d.getTime();
  } else if (range === "7d") minTs = now - 7 * 86_400_000;
  else if (range === "30d") minTs = now - 30 * 86_400_000;

  const out: CardLite[] = [];
  for (const c of cards) {
    if (q && !(c.front.toLowerCase().includes(q) || c.back.toLowerCase().includes(q)))
      continue;
    // No noteId (remote backend) → date unknown, range filter can't apply.
    if (minTs > 0 && typeof c.noteId === "number" && c.noteId < minTs) continue;
    if (stage !== "all" && cardStage(opts.intervals?.get(c.front)) !== stage) continue;
    if (rarity !== "all") {
      const rank = opts.freq?.get(frontWord(c.front)) ?? null;
      if (rarityOf(rank) !== rarity) continue;
    }
    out.push(c);
  }
  // newest first when note ids are known; cards without ids sink to the end.
  // Remote backend (no ids at all): the list arrives oldest-first — reverse.
  if (out.some((c) => typeof c.noteId === "number"))
    out.sort((a, b) => (b.noteId ?? -1) - (a.noteId ?? -1));
  else out.reverse();
  return out;
}
