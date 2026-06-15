// Lazy Japanese tokenizer wrapper around @sglkc/kuromoji.
// Dict assets are copied into public/dict/ during build.
//
// The pure token helpers (mergeTokens / isLexical / kataToHira / lemmaOf /
// vocabKey + the KToken type) live in the environment-neutral module
// src/lib/jatok-core.ts and are re-exported below unchanged, so this file's
// public surface is identical to before. Sharing that single source is what
// keeps the browser vocabKey byte-identical to the server's (src/lib/jatok.ts
// re-exports the same core) — coloring correctness depends on that parity.
//
// Only the kuromoji loader (getTokenizer) is web-specific and stays here: it
// fetches the dict over HTTP, which the Bun server never does.

import kuromoji from "@sglkc/kuromoji";
import { mergeTokens } from "../src/lib/jatok-core.ts";
import type { KToken } from "../src/lib/jatok-core.ts";

export {
  mergeTokens,
  kataToHira,
  isLexical,
  lemmaOf,
  vocabKey,
} from "../src/lib/jatok-core.ts";
export type { KToken } from "../src/lib/jatok-core.ts";

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
