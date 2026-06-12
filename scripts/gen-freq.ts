// Generate public/freq.json — Japanese word → frequency rank.
// Source: https://github.com/hingston/japanese (44492 most common Japanese
// words in frequency order, derived from the University of Leeds corpus
// frequency lists, which are CC BY 2.5; see corpus.leeds.ac.uk/list.html).
// Output: a compact JSON array of words; rank = index + 1. Capped at 30k.
//
// Run: bun run scripts/gen-freq.ts [path-to-downloaded-list]

import { join } from "node:path";

const URL =
  "https://raw.githubusercontent.com/hingston/japanese/master/44492-japanese-words-latin-lines-removed.txt";
const OUT = join(import.meta.dir, "..", "public", "freq.json");
const CAP = 30_000;

const local = process.argv[2];
const text = local ? await Bun.file(local).text() : await (await fetch(URL)).text();

const seen = new Set<string>();
const words: string[] = [];
for (const line of text.split("\n")) {
  const w = line.trim();
  if (!w || seen.has(w)) continue;
  seen.add(w);
  words.push(w);
  if (words.length >= CAP) break;
}

await Bun.write(OUT, JSON.stringify(words));
console.log(`wrote ${words.length} words → ${OUT}`);
