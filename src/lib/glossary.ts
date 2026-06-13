// Proper-noun glossary for the whisper-transcription correction pass
// (see correctNames in gemini.ts). The default covers the Hyouka cast and
// recurring place names; a per-folder `<videoDir>/names.txt` extends it.

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Bundled default Hyouka proper nouns (people + places + groups). */
export const DEFAULT_GLOSSARY: string[] = [
  // 古典部 main four
  "折木奉太郎",
  "千反田える",
  "福部里志",
  "伊原摩耶花",
  // other named characters
  "入須冬実",
  "遠垣内将司",
  "十文字",
  "陸山宗芳",
  "折木供恵",
  "糸魚川養子",
  "湯浅尚子",
  "田名辺治朗",
  "河内亜也子",
  "中城順子",
  "沢木口美崎",
  "大日向友子",
  "瀬之上",
  "鏑矢中学",
  // groups / places / works
  "古典部",
  "神山高校",
  "文化祭",
  "カンヤ祭",
  "氷菓",
  "壁新聞部",
  "総務委員会",
];

/**
 * Load the proper-noun glossary for a video directory: the bundled default
 * merged with an optional `<videoDir>/names.txt` (one entry per line; blank
 * lines and `#` comments ignored). De-duplicated, order-preserving.
 */
export function loadGlossary(videoDir: string): string[] {
  const extra: string[] = [];
  try {
    const raw = readFileSync(join(videoDir, "names.txt"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (t && !t.startsWith("#")) extra.push(t);
    }
  } catch {
    // no names.txt — default only
  }
  return [...new Set([...DEFAULT_GLOSSARY, ...extra])];
}
