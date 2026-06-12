// Server-side pitch-accent lookup over the same public/accents.json the web
// client uses. Pure lookup helpers (kataToHira, accentOf, accentPattern,
// morae) are shared from web/accent.ts — they have no browser dependencies.

import { join } from "node:path";
import { accentOf, kataToHira } from "../../web/accent.ts";

export { accentOf, accentPattern, kataToHira, morae } from "../../web/accent.ts";

const ACCENTS_PATH = join(import.meta.dir, "..", "..", "public", "accents.json");

let accentPromise: Promise<Map<string, number>> | null = null;

/** Load public/accents.json from disk (cached). */
export function loadAccents(): Promise<Map<string, number>> {
  if (!accentPromise) {
    accentPromise = Bun.file(ACCENTS_PATH)
      .json()
      .then((obj: Record<string, number>) => new Map(Object.entries(obj)))
      .catch((e) => {
        accentPromise = null;
        throw e;
      });
  }
  return accentPromise;
}
