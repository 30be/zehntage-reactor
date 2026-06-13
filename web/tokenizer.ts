// Lazy Japanese tokenizer wrapper around @sglkc/kuromoji.
// Dict assets are copied into public/dict/ during build.

import kuromoji from "@sglkc/kuromoji";

export interface KToken {
  surface_form: string;
  reading?: string;
  pos?: string;
  pos_detail_1?: string;
  pos_detail_2?: string;
  basic_form?: string;
}

// Raw kuromoji token (richer than KToken; only the fields we touch are typed).
interface RawToken {
  surface_form: string;
  reading?: string;
  pos?: string;
  pos_detail_1?: string;
  pos_detail_2?: string;
  basic_form?: string;
}

type RawTokenizer = { tokenize: (text: string) => RawToken[] };
type Tokenizer = { tokenize: (text: string) => KToken[] };

let tokenizerPromise: Promise<Tokenizer> | null = null;

export function getTokenizer(): Promise<Tokenizer> {
  if (!tokenizerPromise) {
    tokenizerPromise = new Promise<Tokenizer>((resolve, reject) => {
      kuromoji
        .builder({ dicPath: "/dict/" })
        .build((err: unknown, tok: RawTokenizer) => {
          if (err) reject(err);
          else resolve({ tokenize: (text) => mergeTokens(tok.tokenize(text)) });
        });
    });
  }
  return tokenizerPromise;
}

const SINGLE_KANJI = /^[一-龯々]$/;
const SINGLE_HIRAGANA = /^[ぁ-ゟ]$/;
const ALL_HIRAGANA = /^[ぁ-ゟ]+$/;

function isNoun(t: RawToken): boolean {
  return t.pos === "名詞";
}
function isDependent(t: RawToken): boolean {
  return t.pos_detail_1 === "非自立";
}
/** A person-name proper noun (名詞/固有名詞/人名), e.g. a name kanji chunk. */
function isPersonName(t: RawToken): boolean {
  return (
    t.pos === "名詞" &&
    t.pos_detail_1 === "固有名詞" &&
    t.pos_detail_2 === "人名"
  );
}
/**
 * A single-kanji content token that kuromoji failed to fold into a compound.
 * The bundled @sglkc IPADIC is missing some common entries (e.g. 姉貴), so it
 * greedily emits per-kanji tokens; we re-glue adjacent content kanji.
 */
function isContentKanji(t: RawToken): boolean {
  if (!SINGLE_KANJI.test(t.surface_form)) return false;
  return (
    t.pos === "名詞" ||
    t.pos === "形容詞" ||
    t.pos === "接頭詞" ||
    t.pos === "接尾"
  );
}

/**
 * Post-process kuromoji output to undo over-segmentation caused by gaps in the
 * bundled IPADIC. Two narrow rules:
 *   1. Glue adjacent single-kanji content tokens (姉 + 貴 -> 姉貴).
 *   2. Re-attach a single-kana dependent noun (ん) onto a preceding all-kana
 *      token so の-da contractions don't explode (な + ん -> なん, then + だ).
 *   3. Glue consecutive person-name proper-noun tokens (折木 + 奉太郎 ->
 *      折木奉太郎) so a character name is one markable lexical unit instead of
 *      N name-parts. Only fires when BOTH parts are 固有名詞/人名, so a place
 *      (東京) followed by a person (折木) is never glued.
 * Legitimate compounds (日本語, 勉強, 学生) are already whole and untouched.
 */
export function mergeTokens(raw: RawToken[]): KToken[] {
  const out: RawToken[] = [];
  for (const t of raw) {
    const prev = out[out.length - 1];
    const glueKanji =
      prev != null &&
      isContentKanji(prev) &&
      isContentKanji(t) &&
      !isDependent(prev);
    const attachDependent =
      prev != null &&
      isNoun(t) &&
      isDependent(t) &&
      SINGLE_HIRAGANA.test(t.surface_form) &&
      ALL_HIRAGANA.test(prev.surface_form);
    const gluePersonName =
      prev != null && isPersonName(prev) && isPersonName(t);
    const attachConditionalBa =
      prev != null &&
      t.pos === "助詞" &&
      t.pos_detail_1 === "接続助詞" &&
      t.surface_form === "ば" &&
      (prev.pos === "動詞" || prev.pos === "形容詞");
    if (glueKanji || attachDependent || gluePersonName || attachConditionalBa) {
      prev.surface_form += t.surface_form;
      if (prev.reading == null || t.reading == null) {
        prev.reading = undefined;
      } else {
        prev.reading = prev.reading + t.reading;
      }
      // Keep the verb/adjective lemma when gluing a conditional ば; otherwise
      // the surface (いえば) would clobber basic_form (いう) and break matching.
      if (!attachConditionalBa) prev.basic_form = prev.surface_form;
      if (isNoun(t)) prev.pos = "名詞";
      if (gluePersonName) {
        prev.pos_detail_1 = "固有名詞";
        prev.pos_detail_2 = "人名";
      }
    } else {
      out.push({ ...t });
    }
  }
  return out;
}

// katakana reading -> hiragana, for matching "word [reading]" fronts.
export function kataToHira(s: string): string {
  return s.replace(/[ァ-ヶ]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) - 0x60),
  );
}

export function isLexical(tok: KToken): boolean {
  // Skip pure punctuation / symbols for the "known word" underline + lookup.
  if (!tok.surface_form.trim()) return false;
  if (tok.pos === "記号") return false;
  return true;
}

/** Lemma key: basic_form when kuromoji has one, else surface. */
export function lemmaOf(tok: KToken): string {
  const b = tok.basic_form;
  return b && b !== "*" ? b : tok.surface_form;
}

// POS classes that INFLECT: their kuromoji `reading` is the SURFACE reading
// (食べた → タベタ, not the dictionary タベル), so folding it into the key would
// split every conjugation. For these we key on lemma|pos only — conjugations
// collapse, and same-lemma+same-pos verb homographs (rare) are accepted as a
// tolerable collision.
const INFLECTING_POS = new Set(["動詞", "形容詞", "助動詞"]);

/**
 * Homograph-aware vocabulary key. MUST stay byte-identical in logic with the
 * copy in src/lib/jatok.ts — server index keys and browser keys would diverge
 * otherwise. Key shape:
 *   - inflecting POS (動詞/形容詞/助動詞): `${lemma}|${pos}` (reading dropped so
 *     conjugations collapse to one key);
 *   - else reading present: `${lemma}|${hira(reading)}|${pos}` (reading is the
 *     primary homograph discriminator, POS the tiebreaker for は etc.);
 *   - else (OOV / no reading, non-inflecting): bare `${lemma}` — there's no
 *     reading to disambiguate on, so degrade to today's lemma-only behavior
 *     rather than over-splitting on POS.
 */
export function vocabKey(tok: KToken): string {
  const lemma = lemmaOf(tok);
  const pos = tok.pos ?? "";
  if (!pos) return lemma;
  if (INFLECTING_POS.has(pos)) return `${lemma}|${pos}`;
  const reading = tok.reading ? kataToHira(tok.reading) : "";
  return reading ? `${lemma}|${reading}|${pos}` : lemma;
}
