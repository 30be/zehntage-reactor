// Generate public/accents.json — Japanese pitch-accent lookup.
// Source: Kanjium accent data (https://github.com/mifunetoshiro/kanjium),
// data/source_files/raw/accents.txt — TSV: kanji \t reading(kana) \t accents.
// License: CC BY-SA 4.0 (per Kanjium README). Attribution requested:
//   "The pitch accent notation ... were provided by Uros O. through his free
//    database." (https://github.com/mifunetoshiro/kanjium)
//
// Output format: { "surface|reading": n, "reading": n, ... } where reading is
// hiragana-normalized and n is the FIRST accent number listed (most common).
// Kana-only words get a reading-only key as well so a lookup by reading works.
//
// To keep the file small (<2MB) we trim: keep an entry if its surface OR its
// reading appears in public/freq.json's 30k list, plus ALWAYS keep
// reading-only keys for kana words in freq. If untrimmed output is already
// <2MB, we keep everything.
//
// Run: bun run scripts/gen-accent.ts [path-to-downloaded-accents.txt]

import { join } from "node:path";

const URL =
  "https://raw.githubusercontent.com/mifunetoshiro/kanjium/master/data/source_files/raw/accents.txt";
const ROOT = join(import.meta.dir, "..");
const OUT = join(ROOT, "public", "accents.json");
const FREQ = join(ROOT, "public", "freq.json");
const LIMIT = 2 * 1024 * 1024;

/** katakana → hiragana (keeps ー and everything else as-is) */
export function kataToHira(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    out += c >= 0x30a1 && c <= 0x30f6 ? String.fromCodePoint(c - 0x60) : ch;
  }
  return out;
}

const isKanaOnly = (s: string) => /^[ぁ-ゟー]+$/.test(kataToHira(s));

const local = process.argv[2];
const text = local ? await Bun.file(local).text() : await (await fetch(URL)).text();

const full = new Map<string, number>();
for (const line of text.split("\n")) {
  const [surface, readingRaw, accentsRaw] = line.split("\t");
  if (!surface || !readingRaw || !accentsRaw) continue;
  const m = accentsRaw.match(/\d+/); // first accent only; "(...)" annotations possible
  if (!m) continue;
  const accent = parseInt(m[0], 10);
  const reading = kataToHira(readingRaw.trim());
  const key = `${surface.trim()}|${reading}`;
  if (!full.has(key)) full.set(key, accent);
  if (isKanaOnly(surface)) {
    if (!full.has(reading)) full.set(reading, accent);
  }
}

let obj = Object.fromEntries(full);
let json = JSON.stringify(obj);

if (json.length > LIMIT) {
  const freqWords: string[] = await Bun.file(FREQ).json();
  const freq = new Set(freqWords);
  const trimmed = new Map<string, number>();
  for (const [key, acc] of full) {
    const bar = key.indexOf("|");
    if (bar === -1) {
      // reading-only key: keep if the reading itself is a freq word
      if (freq.has(key)) trimmed.set(key, acc);
    } else {
      const surface = key.slice(0, bar);
      const reading = key.slice(bar + 1);
      if (freq.has(surface) || freq.has(reading)) trimmed.set(key, acc);
    }
  }
  obj = Object.fromEntries(trimmed);
  json = JSON.stringify(obj);
  console.log(`trimmed to freq-intersecting: ${trimmed.size} of ${full.size} entries`);
}

await Bun.write(OUT, json);
console.log(`wrote ${Object.keys(obj).length} entries, ${(json.length / 1024).toFixed(0)} KiB → ${OUT}`);
