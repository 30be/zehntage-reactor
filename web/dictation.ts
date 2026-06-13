// Pure echo-dictation diff helpers (DOM-free, bun-testable).
//
// Echo mode hides the subtitle, replays the cue audio, the user types what
// they heard, then self-checks: we kana-normalize both sides and char-diff.

/** Katakana → hiragana (full-width block U+30A1–U+30F6). */
function kataToHira(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    out += c >= 0x30a1 && c <= 0x30f6 ? String.fromCodePoint(c - 0x60) : ch;
  }
  return out;
}

/**
 * Normalize a Japanese line for comparison: drop whitespace and common
 * punctuation, fold katakana to hiragana. Latin/CJK letters are kept as-is.
 */
export function normalizeJa(s: string): string {
  const stripped = s
    .replace(/\s+/g, "")
    // ascii + common JP punctuation / brackets / marks
    .replace(/[、。，．！？!?「」『』（）()【】［］\[\]…‥・〜~ーｰ"'"'.,]/g, "");
  return kataToHira(stripped);
}

export interface DiffCell {
  ch: string;
  ok: boolean;
}

/**
 * LCS-based char diff of expected vs got (both pre-normalized by the caller or
 * not — this works on raw chars). Returns one cell per EXPECTED char: ok=true
 * when that char is matched (in order) by the user's input, false otherwise.
 * O(n*m), fine for ≤~60-char cues.
 */
export function diffChars(expected: string, got: string): DiffCell[] {
  const a = [...expected];
  const b = [...got];
  const n = a.length;
  const m = b.length;
  // lcs[i][j] = LCS length of a[i..] and b[j..]
  const lcs: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j]
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: DiffCell[] = [];
  let i = 0;
  let j = 0;
  while (i < n) {
    if (j < m && a[i] === b[j]) {
      out.push({ ch: a[i]!, ok: true });
      i++;
      j++;
    } else if (j < m && lcs[i + 1]![j]! < lcs[i]![j + 1]!) {
      // advancing j (skipping an extra got char) keeps a longer match → skip it
      j++;
    } else {
      out.push({ ch: a[i]!, ok: false });
      i++;
    }
  }
  return out;
}

/** {correct, total} score over an expected/got pair, kana-normalized. */
export function scoreDictation(
  expected: string,
  got: string,
): { correct: number; total: number; cells: DiffCell[] } {
  const exp = normalizeJa(expected);
  const cells = diffChars(exp, normalizeJa(got));
  return {
    correct: cells.filter((c) => c.ok).length,
    total: cells.length,
    cells,
  };
}

/**
 * Cues too short or kana-only interjections aren't worth dictating — echo mode
 * skips pausing on them. Threshold: < 2 normalized chars.
 */
export function tooShortForEcho(text: string): boolean {
  return normalizeJa(text).length < 2;
}
