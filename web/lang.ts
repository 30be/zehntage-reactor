// Language-code helpers shared by Player / ReadRoute / coverage.

export const isJaLang = (l: string): boolean =>
  l === "ja" || l === "jpn" || l.startsWith("ja");

export const isRuLang = (l: string): boolean =>
  l === "ru" || l === "rus" || l.startsWith("ru");

/**
 * Selectable languages for the Settings primary/secondary dropdowns. The stored
 * value is always the two-letter `code`; `name` is the human label shown in the
 * <option>. Ordering is roughly "most common for this app first" then alpha.
 */
export interface LanguageOption {
  code: string;
  name: string;
}

export const LANGUAGES: readonly LanguageOption[] = [
  { code: "ja", name: "Japanese" },
  { code: "en", name: "English" },
  { code: "ru", name: "Russian" },
  { code: "de", name: "German" },
  { code: "zh", name: "Chinese" },
  { code: "ko", name: "Korean" },
  { code: "es", name: "Spanish" },
  { code: "fr", name: "French" },
  { code: "it", name: "Italian" },
  { code: "pt", name: "Portuguese" },
  { code: "uk", name: "Ukrainian" },
  { code: "pl", name: "Polish" },
];

/** Human-readable name for a language code; falls back to the code itself. */
export const languageLabel = (code: string): string =>
  LANGUAGES.find((l) => l.code === code)?.name ?? code;
