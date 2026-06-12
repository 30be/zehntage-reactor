// Gemini calls — prompts ported from zehntage-chrome/background.js,
// adapted for Japanese: no article, added `reading` (kana) field.

import { loadSecrets } from "./env.ts";
import { readSettings } from "./settings.ts";
import type { Cue } from "./subs.ts";

// e2e fake mode: GEMINI_FAKE=1 returns canned fixtures after ~50ms, no network.
const geminiFake = () => process.env.GEMINI_FAKE === "1";
const fakeDelay = () => new Promise<void>((r) => setTimeout(r, 50));

const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent";

export const WORD_SCHEMA = {
  type: "OBJECT",
  properties: {
    reading: { type: "STRING" },
    translation: { type: "STRING" },
    notes: { type: "STRING" },
    context: { type: "STRING" },
  },
  required: ["reading", "translation", "notes", "context"],
} as const;

const TRANSLATE_BATCH_SCHEMA = {
  type: "OBJECT",
  properties: {
    translations: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: ["translations"],
} as const;

export interface WordLookup {
  reading: string;
  translation: string;
  notes: string;
  context: string;
}

export interface GeminiImage {
  bytes: Uint8Array;
  mimeType: string;
}

async function callGemini(
  prompt: string,
  schema: unknown,
  image?: GeminiImage,
): Promise<unknown> {
  const { geminiApiKey } = await loadSecrets();
  if (!geminiApiKey) throw new Error("GEMINI_API_KEY not set in ~/.env");

  const parts: unknown[] = [{ text: prompt }];
  if (image) {
    parts.push({
      inlineData: {
        mimeType: image.mimeType,
        data: Buffer.from(image.bytes).toString("base64"),
      },
    });
  }

  const resp = await fetch(GEMINI_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": geminiApiKey,
    },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: "application/json",
        responseSchema: schema,
      },
    }),
  });
  if (!resp.ok) {
    throw new Error(`Gemini API error ${resp.status}: ${await resp.text()}`);
  }
  const data = (await resp.json()) as {
    candidates?: { content: { parts: { text?: string }[] } }[];
  };
  const text = data.candidates?.[0]?.content.parts[0]?.text;
  if (!text) throw new Error("Unexpected Gemini response");
  const cleaned = text.replace(/^```json\s*/, "").replace(/```\s*$/, "").trim();
  return JSON.parse(cleaned);
}

/**
 * Built-in word-lookup prompt template. Placeholders {word} {context} {source}
 * are substituted. Exported so the settings page can prefill / restore it.
 */
export const DEFAULT_LOOKUP_PROMPT = `The learner is a native Russian speaker, fluent in English, learning Japanese. They are studying the word "{word}", which appeared in the subtitle lines below. The line containing the word may be marked "(current)", with the surrounding "(prev)"/"(next)" lines included for context; a translation of the current line into a language the learner knows may also be included.

Important: the word may be a quoted loanword, a proper name, or wordplay rather than its ordinary dictionary sense (e.g. もっと quoted as the loanword "motto" = девиз). Use the surrounding lines and the known-language translation line to disambiguate. If the translation line conflicts with the dictionary meaning, prefer the contextual reading and note the dictionary meaning briefly.

Provide four fields:
- reading: if "{word}" is Japanese, its reading in kana (hiragana for native/Sino-Japanese words, katakana for loanwords). Otherwise an empty string.
- translation: "{word}" translated into Russian — or into English if the word is itself Russian. Expand abbreviations using the text.
- notes: If the studied word is a proper noun naming a real person, place, work, or brand, give a one-sentence encyclopedic abstract — who or what it is and what it is best known for (max ~30 words). Otherwise a short explanation (max ~25 words) that makes the word stick: when the translation loses nuance say what it actually means, and add a memory hook — a kanji breakdown, a genuine cognate or known loanword, a sound-alike, or a vivid image. Never leave this empty.
- context: the single sentence from the text below that best shows the word in use, trimmed to just that sentence, with the studied word wrapped in <b></b>. If the text below has no usable sentence, invent a short natural one.

Examples:
- "図書館" → reading: "としょかん", translation: "библиотека", notes: "図 (рисунок/план) + 書 (книга) + 館 (здание) — 'здание для книг и документов'."
- "気になる" → reading: "きになる", translation: "беспокоить, интересовать", notes: "буквально 'становиться ки (духом/вниманием)' — что-то засело в голове, фирменная фраза Читанды из «Хёки»."

Source: {source}

Text:
{context}`;

/** Substitute {word} {context} {source} placeholders in a prompt template. */
function fillTemplate(
  template: string,
  word: string,
  context: string,
  source: string,
): string {
  return template
    .replaceAll("{word}", word)
    .replaceAll("{context}", context)
    .replaceAll("{source}", source);
}

export function buildWordPrompt(
  word: string,
  context: string,
  source: string,
  template?: string,
): string {
  const tpl = template && template.trim() ? template : DEFAULT_LOOKUP_PROMPT;
  return fillTemplate(tpl, word, context, source);
}

export async function lookupWord(
  word: string,
  context: string,
  source: string,
  image?: GeminiImage,
  secondary?: string,
): Promise<WordLookup> {
  if (geminiFake()) {
    await fakeDelay();
    return {
      reading: "フェイク",
      translation: `перевод(${word})`,
      notes: `fake-notes(${word})`,
      context: `<b>${word}</b>のテスト文です。`,
    };
  }
  const settings = await readSettings();
  const template = typeof settings.lookupPrompt === "string" ? settings.lookupPrompt : "";
  const ctx = secondary
    ? `${context}\n(translation of the current line) ${secondary}`
    : context;
  const prompt = buildWordPrompt(word, ctx, source, template);
  return (await callGemini(prompt, WORD_SCHEMA, image)) as WordLookup;
}

// --- sentence-structure explain ---

export const EXPLAIN_SCHEMA = {
  type: "OBJECT",
  properties: {
    breakdown: { type: "STRING" },
    idioms: { type: "STRING" },
    translation: { type: "STRING" },
  },
  required: ["breakdown", "idioms", "translation"],
} as const;

export interface ExplainResult {
  breakdown: string;
  idioms: string;
  translation: string;
}

export function buildExplainPrompt(
  sentence: string,
  secondary: string,
  source: string,
  context = "",
): string {
  return `The learner is a native Russian speaker, fluent in English, learning Japanese. Explain the structure of this Japanese subtitle sentence for them. Be compact — no filler.

Note: words in the sentence may be quoted loanwords, names, or wordplay referenced from the surrounding lines — use the surrounding lines and any known-language translation to disambiguate; if the translation conflicts with a dictionary meaning, prefer the contextual reading and note the dictionary meaning briefly.

Provide three fields:
- breakdown: the sentence's grammar explained in short lines — grammar points, particle usage, conjugations and contractions (spell out what casual/contracted forms expand to, e.g. "〜ちゃった = 〜てしまった (completion/regret)"), plus a word gloss ONLY where non-obvious.
- idioms: multiword idioms, set phrases, or collocations in the sentence with brief meanings; empty string if none.
- translation: a natural Russian translation of the whole sentence.

${context ? `Surrounding subtitle lines (the sentence is marked "(current)"):\n${context}\n\n` : ""}${secondary ? `An existing subtitle translation (may be loose): ${secondary}\n` : ""}Source: ${source}

Sentence:
${sentence}`;
}

export async function explainSentence(
  sentence: string,
  secondary: string,
  source: string,
  context = "",
): Promise<ExplainResult> {
  if (geminiFake()) {
    await fakeDelay();
    return {
      breakdown: `fake-breakdown(${sentence})`,
      idioms: "fake-idioms",
      translation: `fake-перевод(${sentence})`,
    };
  }
  return (await callGemini(
    buildExplainPrompt(sentence, secondary, source, context),
    EXPLAIN_SCHEMA,
  )) as ExplainResult;
}

// --- free-form follow-up question ---

const ASK_SCHEMA = {
  type: "OBJECT",
  properties: { answer: { type: "STRING" } },
  required: ["answer"],
} as const;

export interface AskParams {
  question: string;
  word?: string;
  sentence?: string;
  priorAnswer?: string;
  source?: string;
}

export function buildAskPrompt(p: AskParams): string {
  const ctx: string[] = [];
  if (p.word) ctx.push(`Word being studied: ${p.word}`);
  if (p.sentence) ctx.push(`Sentence: ${p.sentence}`);
  if (p.priorAnswer) ctx.push(`Explanation already shown to the learner:\n${p.priorAnswer}`);
  if (p.source) ctx.push(`Source: ${p.source}`);
  return `The learner is a native Russian speaker, fluent in English, learning Japanese. They have a follow-up question about the material below. Answer concisely (a few sentences max), in the language the question was asked in.

${ctx.join("\n")}

Question: ${p.question}`;
}

export async function askQuestion(p: AskParams): Promise<{ answer: string }> {
  if (geminiFake()) {
    await fakeDelay();
    return { answer: `fake-answer(${p.question})` };
  }
  return (await callGemini(buildAskPrompt(p), ASK_SCHEMA)) as { answer: string };
}

// --- cue translation (batched, cheap) ---

const LANG_NAMES: Record<string, string> = {
  ru: "Russian",
  en: "English",
  de: "German",
  ja: "Japanese",
};

export function languageName(code: string): string {
  return LANG_NAMES[code.toLowerCase()] ?? code;
}

export function buildTranslateBatchPrompt(lines: string[], targetLang: string): string {
  const target = languageName(targetLang);
  const numbered = lines.map((l, i) => `${i + 1}. ${l.replace(/\n/g, " ")}`).join("\n");
  return `Translate the following numbered subtitle lines into ${target}. They are consecutive lines from one video — use the surrounding lines for context, but translate each line separately. Keep translations natural, concise, and suitable as subtitles. Return exactly ${lines.length} translations, in order, one per input line.

${numbered}`;
}

const BATCH_SIZE = 100;

export async function translateCues(
  cues: Cue[],
  targetLang: string,
  onProgress?: (done: number, total: number) => void,
): Promise<Cue[]> {
  if (geminiFake()) {
    await fakeDelay();
    onProgress?.(cues.length, cues.length);
    return cues.map((c) => ({ start: c.start, end: c.end, text: `[${targetLang}] ${c.text}` }));
  }
  const out: Cue[] = [];
  for (let i = 0; i < cues.length; i += BATCH_SIZE) {
    const batch = cues.slice(i, i + BATCH_SIZE);
    const result = (await callGemini(
      buildTranslateBatchPrompt(batch.map((c) => c.text), targetLang),
      TRANSLATE_BATCH_SCHEMA,
    )) as { translations: string[] };
    if (!Array.isArray(result.translations)) {
      throw new Error("Gemini returned no translations array");
    }
    batch.forEach((c, j) => {
      out.push({ start: c.start, end: c.end, text: result.translations[j] ?? c.text });
    });
    onProgress?.(Math.min(i + BATCH_SIZE, cues.length), cues.length);
  }
  return out;
}
