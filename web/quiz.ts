// Pure comprehension-quiz generation. DOM-free and network-free so bun test
// covers it fully; the player overlay (web/player/QuizPanel.tsx) only renders
// the items this module produces and reports the score back via telemetry.
//
// Two item kinds, both built from the cues the user just watched — no Gemini:
//   - "cloze": blank one content word in a JP line; the user recalls it.
//     The blanked word is preferably one the user is learning (in `deck`) or
//     an unknown content word, so the check probes the right vocabulary.
//   - "mc": show a JP line, pick its meaning; the correct option is that cue's
//     RU translation, distractors are OTHER watched cues' translations.
//
// Selection is deterministic given a seed (default 1) so tests + replays are
// stable. We avoid Gemini entirely; only the caller may enrich later behind
// the existing GEMINI_FAKE guard if it ever wants richer distractors.

export interface QuizCue {
  /** Japanese line (primary track). */
  text: string;
  /** Aligned translation (secondary track), if any. */
  translation?: string;
  /** Content lemmas in `text`, in surface order (caller tokenizes). Each entry
   *  is { surface, lemma }: surface is what appears in `text` to blank out;
   *  lemma is the dictionary form used to match deck/known sets. */
  words?: { surface: string; lemma: string }[];
}

export interface ClozeItem {
  kind: "cloze";
  /** JP line with the answer replaced by BLANK. */
  prompt: string;
  /** the surface string the user must recall. */
  answer: string;
  /** the cue's translation, shown as a hint after answering (if available). */
  translation?: string;
}

export interface McItem {
  kind: "mc";
  /** JP line whose meaning is asked. */
  prompt: string;
  /** shuffled translation options. */
  options: string[];
  /** index into `options` of the correct translation. */
  answer: number;
}

export type QuizItem = ClozeItem | McItem;

export const BLANK = "＿＿＿";

// Small deterministic PRNG (mulberry32) so generation is seedable + testable.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** In-place-free Fisher–Yates using the supplied rng. */
function shuffle<T>(arr: T[], rand: () => number): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export interface QuizOptions {
  /** how many items to produce (capped by available material). */
  count?: number;
  /** dictionary forms the user is actively learning — preferred cloze blanks. */
  deck?: Set<string>;
  /** dictionary forms the user already knows — avoided as cloze blanks. */
  known?: Set<string>;
  /** seed for deterministic selection/shuffle. */
  seed?: number;
}

/** Pick the best word to blank in a cue: prefer a deck (learning) word, then
 *  an unknown content word, else the longest content word. Returns null when
 *  the cue has no usable content word. */
export function pickClozeWord(
  cue: QuizCue,
  deck: Set<string>,
  known: Set<string>,
): { surface: string; lemma: string } | null {
  const words = (cue.words ?? []).filter((w) => w.surface.length > 0);
  if (words.length === 0) return null;
  const inDeck = words.find((w) => deck.has(w.lemma));
  if (inDeck) return inDeck;
  const unknown = words.find((w) => !known.has(w.lemma));
  // longest surface as a stable fallback (more "contentful" to recall)
  const longest = words.reduce((a, b) =>
    b.surface.length > a.surface.length ? b : a,
  );
  return unknown ?? longest;
}

/** Replace the FIRST occurrence of `surface` in `text` with BLANK. */
export function blankOut(text: string, surface: string): string {
  const i = text.indexOf(surface);
  if (i < 0) return text;
  return text.slice(0, i) + BLANK + text.slice(i + surface.length);
}

/**
 * Build a comprehension quiz from watched cues. Deterministic per `seed`.
 *
 * Strategy per cue (in shuffled cue order, until `count` reached):
 *   - if the cue has a translation AND >=2 other cues have distinct
 *     translations → an MC item (cheap, robust comprehension check);
 *   - else if the cue has a usable content word → a cloze item;
 *   - else skip.
 * We alternate-prefer MC when possible so a quiz isn't all-cloze, but never
 * fail to produce items when only one kind is viable.
 */
export function buildQuiz(cues: QuizCue[], opts: QuizOptions = {}): QuizItem[] {
  const count = opts.count ?? 5;
  const deck = opts.deck ?? new Set<string>();
  const known = opts.known ?? new Set<string>();
  const rand = rng(opts.seed ?? 1);

  const usable = cues.filter((c) => c.text.trim().length > 0);
  // pool of distinct, non-empty translations for MC distractors
  const allTranslations = Array.from(
    new Set(
      usable
        .map((c) => c.translation?.trim())
        .filter((t): t is string => !!t),
    ),
  );

  const order = shuffle(usable, rand);
  const items: QuizItem[] = [];

  for (const cue of order) {
    if (items.length >= count) break;
    const tr = cue.translation?.trim();
    const distractorPool = allTranslations.filter((t) => t !== tr);

    if (tr && distractorPool.length >= 2) {
      const distractors = shuffle(distractorPool, rand).slice(0, 3);
      const options = shuffle([tr, ...distractors], rand);
      items.push({
        kind: "mc",
        prompt: cue.text,
        options,
        answer: options.indexOf(tr),
      });
      continue;
    }

    const word = pickClozeWord(cue, deck, known);
    if (word) {
      items.push({
        kind: "cloze",
        prompt: blankOut(cue.text, word.surface),
        answer: word.surface,
        translation: tr,
      });
    }
  }

  return items;
}

/** Normalize a free-text cloze answer for tolerant comparison. */
export function normalizeAnswer(s: string): string {
  return s.trim().replace(/\s+/g, "").toLowerCase();
}

/** True if a typed cloze answer matches the expected surface. */
export function checkCloze(typed: string, answer: string): boolean {
  return normalizeAnswer(typed) === normalizeAnswer(answer);
}
