// Lazy Japanese tokenizer wrapper around @sglkc/kuromoji.
// Dict assets are copied into public/dict/ during build.

import kuromoji from "@sglkc/kuromoji";

export interface KToken {
  surface_form: string;
  reading?: string;
  pos?: string;
  basic_form?: string;
}

type Tokenizer = { tokenize: (text: string) => KToken[] };

let tokenizerPromise: Promise<Tokenizer> | null = null;

export function getTokenizer(): Promise<Tokenizer> {
  if (!tokenizerPromise) {
    tokenizerPromise = new Promise((resolve, reject) => {
      kuromoji
        .builder({ dicPath: "/dict/" })
        .build((err: unknown, tok: Tokenizer) => {
          if (err) reject(err);
          else resolve(tok);
        });
    });
  }
  return tokenizerPromise;
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
