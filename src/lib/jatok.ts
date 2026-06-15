// Pure Japanese-token helpers shared by server-side indexing.
//
// The actual implementation now lives in the environment-neutral module
// src/lib/jatok-core.ts, which is also imported by web/tokenizer.ts so the
// tokenizer + vocabKey logic stays byte-identical across the Bun server and the
// browser bundle (coloring correctness depends on server↔browser vocabKey
// parity). This file re-exports that surface unchanged so every server-side
// importer keeps working as before.

export {
  mergeTokens,
  kataToHira,
  isLexical,
  lemmaOf,
  vocabKey,
} from "./jatok-core.ts";
export type { KToken } from "./jatok-core.ts";
