// Language-code helpers shared by Player / ReadRoute / coverage.

export const isJaLang = (l: string): boolean =>
  l === "ja" || l === "jpn" || l.startsWith("ja");

export const isRuLang = (l: string): boolean =>
  l === "ru" || l === "rus" || l.startsWith("ru");
