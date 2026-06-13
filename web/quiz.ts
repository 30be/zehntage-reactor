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

// Bracket/quote/musical wrappers mark non-speech subtitle annotations
// ([音楽], （笑）, ♪, (applause), 「…」 …): "[]【】（）()「」『』♪〜~" and friends.
// We never blank these out and a cue made up entirely of them (or other
// punctuation) carries no lexical content to quiz on.
// Anything that is NOT a "real word" character: brackets, punctuation, spaces.
// Used to reject punctuation-only guesses and punctuation-only surfaces. We
// keep letters/digits of any script (Unicode \p{L}\p{N}) plus the JP long mark.
const NON_LEXICAL = /[^\p{L}\p{N}ー]+/gu;

/** A surface is lexical if it contains at least one letter/digit (i.e. there's
 *  something to recall once brackets/punctuation are stripped). */
function hasLexicalContent(s: string): boolean {
  return s.replace(NON_LEXICAL, "").length > 0;
}

// Recognized open→close bracket pairs for non-speech annotations.
const BRACKET_PAIRS: Record<string, string> = {
  "[": "]", "【": "】", "（": "）", "(": ")",
  "「": "」", "『": "』",
};

/** True if the whole cue is a non-speech bracketed annotation ([音楽], （笑）,
 *  (applause), 「…」, ♪ …) — i.e. nothing but a single wrapped span or pure
 *  musical/ornamental marks, with no speech around it. */
function isNonSpeechAnnotation(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) return false;
  // pure musical/ornamental marks (♪, 〜, ~) with no lexical content
  if (!hasLexicalContent(t)) return true;
  // a single fully-wrapped span: opens with a bracket, closes with its match,
  // and the inside contains no further closing bracket of that pair.
  const close = BRACKET_PAIRS[t[0]!];
  if (close && t.endsWith(close)) {
    const inner = t.slice(1, -1);
    if (!inner.includes(close)) return true;
  }
  return false;
}

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
  // Only real words are eligible: a surface that is purely brackets/punctuation
  // (e.g. a "[" token, or a 「 from a wrapped annotation) carries no content.
  const words = (cue.words ?? []).filter((w) => hasLexicalContent(w.surface));
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

/** Replace the FIRST occurrence of `surface` in `text` with BLANK. Only the
 *  lexical core of `surface` is blanked: leading/trailing wrapper or punctuation
 *  characters stay in the prompt so we never leave a dangling bracket and never
 *  blank a non-word. Returns the text unchanged if there's nothing to blank. */
export function blankOut(text: string, surface: string): string {
  // strip wrapper/punctuation off the ends so we blank the word, not its frame
  const core = trimWrappers(surface);
  if (core.length === 0 || !hasLexicalContent(core)) return text;
  const i = text.indexOf(core);
  if (i < 0) return text;
  return text.slice(0, i) + BLANK + text.slice(i + core.length);
}

/** Strip leading/trailing wrapper + punctuation characters from a surface. */
function trimWrappers(s: string): string {
  return s.replace(/^[^\p{L}\p{N}ー]+/u, "").replace(/[^\p{L}\p{N}ー]+$/u, "");
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

    // A cue that is purely a bracketed non-speech annotation ([音楽], （笑）, ♪,
    // (applause)) is not real speech → never a cloze.
    if (isNonSpeechAnnotation(cue.text)) continue;
    const word = pickClozeWord(cue, deck, known);
    if (word) {
      const answer = trimWrappers(word.surface);
      const prompt = blankOut(cue.text, word.surface);
      // only emit if we actually blanked something out (prompt changed)
      if (answer.length > 0 && prompt !== cue.text) {
        items.push({ kind: "cloze", prompt, answer, translation: tr });
      }
    }
  }

  return items;
}

/** Normalize a free-text cloze answer for tolerant comparison. Strips all
 *  whitespace, brackets and punctuation so only lexical characters remain; a
 *  punctuation-only guess (e.g. "[") normalizes to the empty string. */
export function normalizeAnswer(s: string): string {
  return s.replace(NON_LEXICAL, "").toLowerCase();
}

/** True if a typed cloze answer matches the expected surface. An empty
 *  normalized guess (whitespace/punctuation only) is never correct. */
export function checkCloze(typed: string, answer: string): boolean {
  const t = normalizeAnswer(typed);
  if (t.length === 0) return false;
  return t === normalizeAnswer(answer);
}
