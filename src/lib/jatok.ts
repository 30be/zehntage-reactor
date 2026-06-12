// Pure Japanese-token helpers shared by server-side indexing.
//
// NOTE: these are COPIED from web/tokenizer.ts (mergeTokens / isLexical /
// kataToHira) because that file is web-only (loads dict over HTTP) and owned
// by another change in flight. TODO: unify — make web/tokenizer.ts re-export
// from here once both waves land.

export interface KToken {
  surface_form: string;
  reading?: string;
  pos?: string;
  pos_detail_1?: string;
  basic_form?: string;
}

const SINGLE_KANJI = /^[一-龯々]$/;
const SINGLE_HIRAGANA = /^[ぁ-ゟ]$/;
const ALL_HIRAGANA = /^[ぁ-ゟ]+$/;

function isNoun(t: KToken): boolean {
  return t.pos === "名詞";
}
function isDependent(t: KToken): boolean {
  return t.pos_detail_1 === "非自立";
}
/**
 * A single-kanji content token that kuromoji failed to fold into a compound.
 * The bundled @sglkc IPADIC is missing some common entries (e.g. 姉貴), so it
 * greedily emits per-kanji tokens; we re-glue adjacent content kanji.
 */
function isContentKanji(t: KToken): boolean {
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
 */
export function mergeTokens(raw: KToken[]): KToken[] {
  const out: KToken[] = [];
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
      prev!.surface_form += t.surface_form;
      prev!.reading = (prev!.reading ?? "") + (t.reading ?? "");
      prev!.basic_form = prev!.surface_form;
      if (isNoun(t)) prev!.pos = "名詞";
    } else {
      out.push({ ...t });
    }
  }
  return out;
}

/** katakana reading -> hiragana, for matching "word [reading]" fronts. */
export function kataToHira(s: string): string {
  return s.replace(/[ァ-ヶ]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) - 0x60),
  );
}

/** Skip pure punctuation / symbols. */
export function isLexical(tok: KToken): boolean {
  if (!tok.surface_form.trim()) return false;
  if (tok.pos === "記号") return false;
  return true;
}

/** Lemma key for indexing: basic_form when kuromoji has one, else surface. */
export function lemmaOf(tok: KToken): string {
  const b = tok.basic_form;
  return b && b !== "*" ? b : tok.surface_form;
}
