// Per-target-language default Gemini prompt profiles for the Settings page.
//
// The SERVER's built-in runtime default (used when a stored prompt is empty)
// still lives in src/lib/gemini.ts (DEFAULT_LOOKUP_PROMPT / DEFAULT_EXPLAIN_PROMPT,
// the Japanese←Russian Hyouka profile). THIS module is the CLIENT-side source of
// editable defaults: it powers the Settings "Reset to default" button and the
// "swap defaults when the language changes (unless the user customised the text)"
// logic, generalised across target/known language pairs.
//
// Each profile is templated with two placeholders that are filled in from the
// current dropdown selection BEFORE the text reaches the prompt editor:
//   {target}  — the target (studied) language name, e.g. "Japanese"
//   {known}   — the known (native) language name, e.g. "Russian"
// The runtime lookup/explain placeholders ({word} {context} {source} {sentence}
// {secondary}) are left intact for the server to substitute at call time.

import { languageLabel } from "./lang.ts";

export interface LangPromptProfile {
  /** Word-lookup prompt template ({target}/{known} interpolated by buildDefaults). */
  lookupPrompt: string;
  /** Sentence-explanation prompt template ({target}/{known} interpolated). */
  sentencePrompt: string;
}

// --- shared prompt fragments ---------------------------------------------

// CJK target languages carry a phonetic `reading` field (kana for Japanese,
// pinyin for Chinese, romanised hangul for Korean); European languages omit it.
const READING_BY_LANG: Record<string, string> = {
  ja: "reading: the reading of its DICTIONARY (base) form in kana — hiragana for native/Sino-Japanese words, katakana for loanwords.",
  zh: "reading: the Hanyu Pinyin (with tone marks) of the word in its dictionary form.",
  ko: "reading: the revised-romanisation of the word in its dictionary form.",
};

function lookupTemplate(targetCode: string): string {
  const reading = READING_BY_LANG[targetCode];
  const readingField = reading
    ? `- ${reading} Otherwise an empty string.\n`
    : "";
  const readingMention = reading
    ? `four fields`
    : `three fields`;
  return `The learner is a native {known} speaker learning {target}. They are studying the word "{word}". Subtitle lines are provided below: the line containing the word may be marked "(current)", with surrounding "(prev)"/"(next)" lines, and possibly a translation of the current line into a language the learner knows.

Use the context lines and translation line ONLY to (a) pick which SENSE of the word to define — its dominant/most-relevant sense for this usage — and (b) detect when the word is a quoted loanword, a proper name, or wordplay rather than its ordinary dictionary sense. If the translation line conflicts with the dictionary meaning, prefer the contextual sense and note the dictionary meaning briefly.

CRITICAL: write the entry as a STANDALONE, REUSABLE dictionary entry for that sense — valid in ANY context. Do NOT write "here", "in this line", "in this context", or "as used here". Give the most common 1 (at most 2) sense(s); do NOT dump every dictionary meaning. Keep every field concise and learner-useful.

Provide ${readingMention}:
${readingField}- translation: a natural {known} gloss of "{word}" — the dictionary base form, idiomatic, not a literal calque. Where it helps, prefix the part of speech briefly.
- notes: If the word is a proper noun naming a real person, place, work, or brand, give a one-sentence encyclopedic abstract (max ~30 words). Otherwise a short GENERAL definition (max ~25 words) that makes the word stick — what it actually means plus a memory hook (a cognate, a sound-alike, or a vivid image). Never leave this empty.
- context: a SHORT, natural, self-contained example sentence in {target} using "{word}" (invent a simple one), with the studied word wrapped in <b></b>. It must stand alone — do NOT copy the input line.

Source: {source}

Text:
{context}`;
}

function sentenceTemplate(targetCode: string): string {
  const reading = READING_BY_LANG[targetCode];
  const readingHint = reading
    ? " For non-obvious words, spell out contractions and casual forms and gloss them."
    : "";
  return `The learner is a native {known} speaker learning {target}. Explain the structure of this {target} subtitle sentence for them, in {known}. Pitch it at a learner — clear and concrete, not academic jargon. Be compact: no filler, no restating the obvious.

Note: words in the sentence may be quoted loanwords, names, or wordplay referenced from the surrounding lines — use the surrounding lines and any known-language translation to disambiguate; if the translation conflicts with a dictionary meaning, prefer the contextual reading and note the dictionary meaning briefly.

Provide three fields:
- breakdown: the sentence's grammar explained in {known}, in short lines — grammar points, particle/inflection usage, and a word gloss ONLY where non-obvious.${readingHint} Walk through the sentence in order; keep each line to one point.
- idioms: multiword idioms, set phrases, or collocations in the sentence with brief {known} meanings; empty string if none.
- translation: a natural, idiomatic {known} translation of the whole sentence (not a word-for-word calque).

Surrounding subtitle lines (the sentence is marked "(current)", may be empty):
{context}

An existing subtitle translation (may be loose or empty): {secondary}
Source: {source}

Sentence:
{sentence}`;
}

// --- per-target-language profiles ----------------------------------------
//
// Templates carry {target}/{known} placeholders; buildLangDefaults() fills them
// from the current dropdown selection. CJK profiles (ja/zh/ko) include the
// `reading` field; European profiles (de/en/...) omit kana/reading wording.

export const LANG_DEFAULTS: Record<string, LangPromptProfile> = {
  ja: { lookupPrompt: lookupTemplate("ja"), sentencePrompt: sentenceTemplate("ja") },
  zh: { lookupPrompt: lookupTemplate("zh"), sentencePrompt: sentenceTemplate("zh") },
  ko: { lookupPrompt: lookupTemplate("ko"), sentencePrompt: sentenceTemplate("ko") },
  de: { lookupPrompt: lookupTemplate("de"), sentencePrompt: sentenceTemplate("de") },
  en: { lookupPrompt: lookupTemplate("en"), sentencePrompt: sentenceTemplate("en") },
};

/** Fallback profile (European-style, no reading field) for codes not in the map. */
const GENERIC_PROFILE: LangPromptProfile = {
  lookupPrompt: lookupTemplate("__generic__"),
  sentencePrompt: sentenceTemplate("__generic__"),
};

/** Whether the `furigana` toggle is meaningful for a target language (ja only). */
export const supportsFurigana = (targetCode: string): boolean => targetCode === "ja";

/**
 * Resolve the default prompt pair for a given (target, known) language pair,
 * with {target}/{known} placeholders interpolated to their human names. The
 * runtime placeholders ({word} {context} {source} {sentence} {secondary}) are
 * left untouched for the server.
 */
export function buildLangDefaults(
  targetCode: string,
  knownCode: string,
): { lookupPrompt: string; sentencePrompt: string } {
  const profile = LANG_DEFAULTS[targetCode] ?? GENERIC_PROFILE;
  const target = languageLabel(targetCode);
  const known = languageLabel(knownCode);
  const fill = (s: string) => s.replaceAll("{target}", target).replaceAll("{known}", known);
  return {
    lookupPrompt: fill(profile.lookupPrompt),
    sentencePrompt: fill(profile.sentencePrompt),
  };
}
