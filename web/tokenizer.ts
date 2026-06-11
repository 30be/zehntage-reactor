// Lazy Japanese tokenizer wrapper around @sglkc/kuromoji.
// Dict assets are copied into public/dict/ during build.

import kuromoji from "@sglkc/kuromoji";

export interface KToken {
  surface_form: string;
  reading?: string;
  pos?: string;
  pos_detail_1?: string;
  basic_form?: string;
}

// Raw kuromoji token (richer than KToken; only the fields we touch are typed).
interface RawToken {
  surface_form: string;
  reading?: string;
  pos?: string;
  pos_detail_1?: string;
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
    if (glueKanji || attachDependent) {
      prev.surface_form += t.surface_form;
      prev.reading = (prev.reading ?? "") + (t.reading ?? "");
      prev.basic_form = prev.surface_form;
      if (isNoun(t)) prev.pos = "名詞";
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
