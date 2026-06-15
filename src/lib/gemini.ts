// Gemini calls — prompts ported from zehntage-chrome/background.js,
// adapted for Japanese: no article, added `reading` (kana) field.

import { loadSecrets } from "./env.ts";
import { readSettings } from "./settings.ts";
import type { Cue } from "./subs.ts";

// e2e fake mode: GEMINI_FAKE=1 returns canned fixtures after ~50ms, no network.
const geminiFake = () => process.env.GEMINI_FAKE === "1";
const fakeDelay = () => new Promise<void>((r) => setTimeout(r, 50));

/** Fake-mode reading: the REAL hiragana reading via the server tokenizer, so
 * reading-aware deck matching (web/progress.ts matchFront) behaves in e2e the
 * same as with live Gemini. Falls back to a marker string on failure. */
async function fakeReading(word: string): Promise<string> {
  try {
    const { getServerTokenizer } = await import("./tokenindex.ts");
    const { kataToHira } = await import("./jatok.ts");
    const tokenize = await getServerTokenizer();
    const toks = tokenize(word);
    const reading = toks.map((t) => t.reading ?? t.surface_form).join("");
    return reading ? kataToHira(reading) : "ふぇいく";
  } catch {
    return "ふぇいく";
  }
}

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

// --- retry / backoff for transient Gemini failures (bulk runs) ---

const RETRY_BACKOFF_MS = [2_000, 5_000, 15_000, 40_000]; // 4 retries, 5 attempts
const MAX_RETRY_DELAY_MS = 60_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Transient HTTP status: 429 (rate limit) or any 5xx → retryable. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

/**
 * Parse a Retry-After header (delta-seconds or HTTP-date) into ms, or look for
 * a `retryDelay` (e.g. "12s") in the Gemini error body. Returns undefined if no
 * usable hint. Capped by the caller at MAX_RETRY_DELAY_MS.
 */
export function parseRetryAfter(headerVal: string | null, body: string): number | undefined {
  if (headerVal) {
    const secs = Number(headerVal);
    if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
    const when = Date.parse(headerVal);
    if (Number.isFinite(when)) return Math.max(0, when - Date.now());
  }
  // Gemini RetryInfo: "retryDelay": "12s" (or "12.5s")
  const m = body.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  if (m) return Math.max(0, Math.round(Number(m[1]) * 1000));
  return undefined;
}

// Marker so the retry loop knows a thrown error came from a retryable HTTP code.
class RetryableHttpError extends Error {
  constructor(message: string, readonly retryAfterMs?: number) {
    super(message);
  }
}

/**
 * Thrown when a Gemini batch returns a different number of items than were sent.
 * This is the failure mode the .ass-multiline bug produced; translateCues treats
 * it as recoverable (retry once, then keep originals) rather than fatal, so a
 * single count hiccup degrades gracefully instead of nuking the whole episode.
 */
export class TranslationCountError extends Error {}

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
  const body = JSON.stringify({
    contents: [{ parts }],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: "application/json",
      responseSchema: schema,
    },
  });

  const attempt = async (): Promise<unknown> => {
    const resp = await fetch(GEMINI_URL, {
      method: "POST",
      signal: AbortSignal.timeout(60_000),
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": geminiApiKey,
      },
      body,
    });
    if (!resp.ok) {
      const errText = await resp.text();
      const msg = `Gemini API error ${resp.status}: ${errText}`;
      if (isRetryableStatus(resp.status)) {
        const hint = parseRetryAfter(resp.headers.get("retry-after"), errText);
        throw new RetryableHttpError(msg, hint);
      }
      // 4xx (other than 429) is fatal — fail fast, no retry.
      throw new Error(msg);
    }
    const data = (await resp.json()) as {
      candidates?: { content: { parts: { text?: string }[] } }[];
    };
    const text = data.candidates?.[0]?.content?.parts[0]?.text;
    if (!text) throw new Error("Unexpected Gemini response");
    const cleaned = text.replace(/^```json\s*/, "").replace(/```\s*$/, "").trim();
    return JSON.parse(cleaned);
  };

  for (let i = 0; ; i++) {
    try {
      return await attempt();
    } catch (err) {
      const last = i >= RETRY_BACKOFF_MS.length;
      // Retry on retryable HTTP codes and on network/timeout errors (TypeError
      // / AbortError / DOMException from fetch). Do NOT retry the explicit
      // fatal-4xx Error thrown above, nor JSON.parse / shape errors.
      const retryable =
        err instanceof RetryableHttpError ||
        (err instanceof Error &&
          (err.name === "AbortError" ||
            err.name === "TimeoutError" ||
            err instanceof TypeError));
      if (last || !retryable) throw err;
      let delay = RETRY_BACKOFF_MS[i]!;
      if (err instanceof RetryableHttpError && err.retryAfterMs !== undefined) {
        delay = Math.min(err.retryAfterMs, MAX_RETRY_DELAY_MS);
      }
      delay += Math.floor(Math.random() * 500); // jitter
      await sleep(delay);
    }
  }
}

/**
 * HYOUKA (氷菓) cast/place glossary for consistent Japanese→Russian name
 * transliteration. Surnames follow community-standard forms (Читанда), given
 * names use a fused readable form; everything else is plain Polivanov. Reused
 * across the translate batch prompt and the learner-facing lookup/explain/ask
 * prompts so a name renders the SAME way everywhere. Kept deliberately short
 * (main cast + a couple of places) so it doesn't bloat per-request token usage.
 */
const HYOUKA_RU_GLOSSARY = [
  "折木奉太郎 → Ореки Хотаро",
  "千反田 (фамилия) → Читанда; 千反田える → Читанда Эру (личное имя える = Эру). Когда в реплике только фамилия 千反田/チタンダ — это ВСЕГДА «Читанда», НИКОГДА не «Тиэру».",
  "福部里志 → Фукубэ Сатоси",
  "伊原摩耶花 → Ибара Маяка",
  "古典部 → клуб классической литературы",
  "神山高校 → старшая школа Камияма",
  "Склоняй японские имена по правилам русского языка там, где это естественно (напр. «с Читандой», «у Ореки»), но никогда не меняй саму транслитерацию основы имени.",
].join("\n");

/**
 * Shared note for the single-item learner prompts (lookup/explain/ask): these
 * subtitles are from Hyouka, so render proper names consistently. We fold the
 * cast glossary in only where names actually matter, keeping the DRY source of
 * truth in HYOUKA_RU_GLOSSARY.
 */
const HYOUKA_NAME_NOTE = `These subtitles are from the anime "Hyouka" (氷菓). Keep character and place names CONSISTENT with this glossary; transliterate any OTHER Japanese proper name with standard Polivanov rules (do NOT anglicize or invent names):
${HYOUKA_RU_GLOSSARY}`;

/**
 * Built-in word-lookup prompt template. Placeholders {word} {context} {source}
 * are substituted. Exported so the settings page can prefill / restore it.
 */
export const DEFAULT_LOOKUP_PROMPT = `The learner is a native Russian speaker, fluent in English, learning Japanese. They are studying the word "{word}", which appeared in the subtitle lines below. The line containing the word may be marked "(current)", with the surrounding "(prev)"/"(next)" lines included for context; a translation of the current line into a language the learner knows may also be included.

${HYOUKA_NAME_NOTE}

Important: the word may be a quoted loanword, a proper name, or wordplay rather than its ordinary dictionary sense (e.g. もっと quoted as the loanword "motto" = девиз). Use the surrounding lines and the known-language translation line to disambiguate. If the translation line conflicts with the dictionary meaning, prefer the contextual reading and note the dictionary meaning briefly.

Give the most common meaning(s) of the word AS USED HERE — usually one, at most two senses. Do NOT dump an exhaustive list of every dictionary meaning. Keep every field concise and learner-useful; never produce word-salad.

Provide four fields:
- reading: if "{word}" is Japanese, the reading of its DICTIONARY (base) form in kana — hiragana for native/Sino-Japanese words, katakana for loanwords. Otherwise an empty string.
- translation: a natural Russian gloss of "{word}" as used here (English if the word is itself Russian) — the dictionary base form, idiomatic, not a literal calque. Expand abbreviations using the text. Where it helps, prefix the part of speech briefly (e.g. "гл." / "сущ. — ").
- notes: If the studied word is a proper noun naming a real person, place, work, or brand, give a one-sentence encyclopedic abstract — who or what it is and what it is best known for (max ~30 words). Otherwise a short explanation (max ~25 words) that makes the word stick: when the translation loses nuance say what it actually means, and add a memory hook — a kanji breakdown, a genuine cognate or known loanword, a sound-alike, or a vivid image. Never leave this empty.
- context: the single sentence from the text below that best shows the word in use, trimmed to just that sentence, with the studied word wrapped in <b></b>. If the text below has no usable sentence, invent a short natural one.

Examples:
- "図書館" → reading: "としょかん", translation: "сущ. — библиотека", notes: "図 (рисунок/план) + 書 (книга) + 館 (здание) — 'здание для книг и документов'."
- "気になる" → reading: "きになる", translation: "гл. — беспокоить, интересовать", notes: "буквально 'становиться ки (духом/вниманием)' — что-то засело в голове, фирменная фраза Читанды из «Хёки»."

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
      reading: await fakeReading(word),
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

/**
 * Built-in sentence-explain prompt template. Placeholders {sentence} {context}
 * {secondary} {source} are substituted. Exported so the settings page can
 * prefill / restore it (same pattern as DEFAULT_LOOKUP_PROMPT).
 */
export const DEFAULT_EXPLAIN_PROMPT = `The learner is a native Russian speaker, fluent in English, learning Japanese. Explain the structure of this Japanese subtitle sentence for them, in Russian. Pitch it at a learner — clear and concrete, not academic jargon. Be compact: no filler, no restating the obvious.

${HYOUKA_NAME_NOTE}

Note: words in the sentence may be quoted loanwords, names, or wordplay referenced from the surrounding lines — use the surrounding lines and any known-language translation to disambiguate; if the translation conflicts with a dictionary meaning, prefer the contextual reading and note the dictionary meaning briefly.

Provide three fields:
- breakdown: the sentence's grammar explained in Russian, in short lines — grammar points, particle usage (что делает каждая частица), conjugations and contractions (spell out what casual/contracted forms expand to, e.g. "〜ちゃった = 〜てしまった — завершённость/сожаление"), plus a word gloss ONLY where non-obvious. Walk through the sentence in order; keep each line to one point.
- idioms: multiword idioms, set phrases, or collocations in the sentence with brief Russian meanings; empty string if none.
- translation: a natural, idiomatic Russian translation of the whole sentence (not a word-for-word calque).

Surrounding subtitle lines (the sentence is marked "(current)", may be empty):
{context}

An existing subtitle translation (may be loose or empty): {secondary}
Source: {source}

Sentence:
{sentence}`;

export function buildExplainPrompt(
  sentence: string,
  secondary: string,
  source: string,
  context = "",
  template?: string,
): string {
  const tpl = template && template.trim() ? template : DEFAULT_EXPLAIN_PROMPT;
  return tpl
    .replaceAll("{sentence}", sentence)
    .replaceAll("{context}", context)
    .replaceAll("{secondary}", secondary)
    .replaceAll("{source}", source);
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
  const settings = await readSettings();
  const template =
    typeof settings.explainPrompt === "string" ? settings.explainPrompt : "";
  return (await callGemini(
    buildExplainPrompt(sentence, secondary, source, context, template),
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
  return `The learner is a native Russian speaker, fluent in English, learning Japanese. They have a follow-up question about the material below. Answer concisely and naturally (a few sentences max), grounded in the given word and sentence context — do not drift off topic. Reply in Russian by default; if the question is clearly written in another language, reply in that language instead. When mentioning Japanese names, keep them consistent with the Hyouka glossary below.

${HYOUKA_NAME_NOTE}

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

/**
 * Collapse a cue's text into a SINGLE physical line for the numbered batch wire
 * format. ASS dialogue cues can carry INTERNAL line breaks (real `\r\n`/`\n`/`\r`
 * characters) as well as the literal ASS hard-break markers `\N` / `\n`
 * (backslash followed by N/n, as they appear inside the .ass text). If any of
 * these survive into the prompt, a single cue becomes MULTIPLE lines on the wire
 * and Gemini returns a different line count than the input cue count, which
 * trips assertTranslationCount and fails the whole episode. We replace all of
 * them (and any run of whitespace) with a single space. Exported for testing.
 */
export function sanitizeCueLine(text: string): string {
  return text
    // literal ASS hard-break markers: backslash + N or n
    .replace(/\\[Nn]/g, " ")
    // real line breaks
    .replace(/\r\n|\r|\n/g, " ")
    // collapse runs of whitespace into one space
    .replace(/\s+/g, " ")
    .trim();
}

export function buildTranslateBatchPrompt(lines: string[], targetLang: string): string {
  const target = languageName(targetLang);
  const numbered = lines.map((l, i) => `${i + 1}. ${sanitizeCueLine(l)}`).join("\n");
  const isRu = targetLang.toLowerCase() === "ru";
  const glossaryBlock = isRu
    ? `\nThese subtitles are from the anime "Hyouka" (氷菓). Use this glossary so character and place names stay CONSISTENT across every line and episode. Transliterate any OTHER Japanese proper name (people, places) using standard Polivanov romanization-to-Russian rules; do NOT invent or anglicize names.\n${HYOUKA_RU_GLOSSARY}\n`
    : "";
  return `Translate the following numbered subtitle lines into ${target}. They are consecutive lines from one video — use the surrounding lines for context, but translate each line separately. Produce natural, fluent, idiomatic ${target} that reads the way a person actually speaks — NOT a word-for-word calque. Preserve the speaker's register and tone (casual stays casual, formal stays formal, rude stays rude). Handle Japanese honorifics naturally for ${target}: do NOT transliterate "-san"/"-kun"/"-chan"/"-senpai" as a literal suffix on a name — convey the politeness through wording or simply drop it where it would sound unnatural. Keep each line concise and suitable as a subtitle.${glossaryBlock}
Return exactly ${lines.length} translations, in order, one per input line. Return ONLY the translated line text — do NOT include the line number or any prefix.

${numbered}`;
}

const BATCH_SIZE = 100;

// Process cues in fixed-size batches, concatenating each batch's output cues and
// reporting progress (done/total) after each batch.
async function runBatched(
  cues: Cue[],
  handleBatch: (batch: Cue[]) => Promise<Cue[]>,
  onProgress?: (done: number, total: number) => void,
): Promise<Cue[]> {
  const out: Cue[] = [];
  for (let i = 0; i < cues.length; i += BATCH_SIZE) {
    const batch = cues.slice(i, i + BATCH_SIZE);
    out.push(...(await handleBatch(batch)));
    onProgress?.(Math.min(i + BATCH_SIZE, cues.length), cues.length);
  }
  return out;
}

/** Exported for testing. Throws if translation count doesn't match cue count. */
export function assertTranslationCount(translations: string[], expected: number): void {
  if (translations.length !== expected) {
    throw new TranslationCountError(
      `Gemini returned ${translations.length} translations for ${expected} cues`,
    );
  }
}

/**
 * Defensively strip a leaked line-number enumerator the model may have echoed
 * back. Only strips a leading `${index + 1}.` / `${index + 1})` (the EXACT
 * expected number for this position) so legitimate text that happens to start
 * with a different number is left untouched. Exported for testing.
 */
export function stripEnumerator(line: string, index: number): string {
  const re = new RegExp(`^\\s*${index + 1}\\s*[.)]\\s*`);
  return line.replace(re, "");
}

// --- proper-noun correction pass for whisper-transcribed JP subs ---

const CORRECT_BATCH_SCHEMA = {
  type: "OBJECT",
  properties: {
    corrected: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: ["corrected"],
} as const;

export function buildCorrectBatchPrompt(lines: string[], glossary: string[]): string {
  const numbered = lines.map((l, i) => `${i + 1}. ${sanitizeCueLine(l)}`).join("\n");
  const gloss = glossary.join("、");
  return `The following ${lines.length} numbered lines are Japanese subtitles produced by automatic speech recognition (whisper). They may contain MISHEARD or garbled PROPER NOUNS (names of people and places). Using ONLY the glossary of correct proper nouns below, fix any garbled proper noun to its correct form. DO NOT change any other words, grammar, kana, conjugations, or punctuation. If a line contains no glossary proper noun, return it completely unchanged. Return EXACTLY ${lines.length} lines, in the same order, one per input line. Return ONLY the corrected line text — do NOT include the line number or any prefix.

Glossary of correct proper nouns: ${gloss}

${numbered}`;
}

/**
 * Levenshtein edit distance. Exported for testing the correction safety guard.
 */
export function editDistance(a: string, b: string): number {
  const ac = [...a];
  const bc = [...b];
  const m = ac.length;
  const n = bc.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let cur = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = ac[i - 1] === bc[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n]!;
}

/**
 * Decide whether a proposed correction is safe to accept. A correction that
 * changes too much of the line (relative to its length) suggests the model
 * rewrote non-name text, so we reject it and keep the original. Exported for
 * testing.
 *
 * Budget formula (code-point length):
 *   len <= 6  → max 1 edit  (short lines: very conservative)
 *   len > 6   → floor(0.4 * len)  (existing ~40% rule, minimum 1)
 *
 * Being stricter on short lines is safe: it just means keeping the original
 * more often, which is the fail-safe direction.
 */
export function acceptCorrection(original: string, corrected: string): boolean {
  if (corrected === original) return true;
  if (!corrected.trim()) return false;
  const dist = editDistance(original, corrected);
  const len = [...original].length;
  const limit = len <= 6 ? 1 : Math.max(1, Math.floor(len * 0.4));
  return dist <= limit;
}

/**
 * Gemini-based proper-noun correction pass for whisper-transcribed Japanese
 * cues. Only `.text` is touched; timings are preserved. Fail-safe: on any
 * error, count mismatch, or an over-large "correction", the ORIGINAL cue text
 * is kept — this pass must never worsen subtitles.
 */
export async function correctNames(
  cues: Cue[],
  glossary: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<Cue[]> {
  if (geminiFake()) {
    await fakeDelay();
    onProgress?.(cues.length, cues.length);
    return cues.map((c) => ({ start: c.start, end: c.end, text: c.text }));
  }
  if (glossary.length === 0) return cues.map((c) => ({ ...c }));

  return runBatched(cues, async (batch) => {
    try {
      const result = (await callGemini(
        buildCorrectBatchPrompt(batch.map((c) => c.text), glossary),
        CORRECT_BATCH_SCHEMA,
      )) as { corrected: string[] };
      if (!Array.isArray(result.corrected)) {
        throw new Error("Gemini returned no corrected array");
      }
      assertTranslationCount(result.corrected, batch.length);
      return batch.map((c, j) => {
        const proposed = stripEnumerator(result.corrected[j]!, j);
        const text = acceptCorrection(c.text, proposed) ? proposed : c.text;
        return { start: c.start, end: c.end, text };
      });
    } catch {
      // fail safe: keep the originals for this batch
      return batch.map((c) => ({ start: c.start, end: c.end, text: c.text }));
    }
  }, onProgress);
}

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
  // Translate ONE batch, throwing on any error / count mismatch. Returns the
  // translated texts in order. Sanitization in buildTranslateBatchPrompt should
  // keep the wire count == batch length, so a mismatch here is exceptional.
  const translateBatch = async (batch: Cue[]): Promise<string[]> => {
    const result = (await callGemini(
      buildTranslateBatchPrompt(batch.map((c) => c.text), targetLang),
      TRANSLATE_BATCH_SCHEMA,
    )) as { translations: string[] };
    if (!Array.isArray(result.translations)) {
      throw new TranslationCountError("Gemini returned no translations array");
    }
    assertTranslationCount(result.translations, batch.length);
    return result.translations.map((t, j) => stripEnumerator(t, j));
  };

  // Translate a batch, recovering from COUNT mismatches by retrying once at the
  // same size, then SPLITTING into halves (down to a single cue) so a structural
  // quirk in ONE cue can't drag its whole batch into untranslated passthrough.
  // Only at the per-cue floor — where a mismatch can no longer be isolated — do
  // we keep the original (Japanese) text, so at most that single cue stays
  // untranslated instead of the entire batch. Bounded: each level retries once
  // and halves, so the call count is linear in the offending region, not runaway.
  // Returns translated texts aligned 1:1 with `batch`.
  const translateBatchResilient = async (batch: Cue[]): Promise<string[]> => {
    if (batch.length === 0) return [];
    try {
      return await translateBatch(batch);
    } catch (e1) {
      // Only a COUNT mismatch is recoverable here. Fatal errors (bad API key /
      // 4xx, exhausted transient retries, network) still propagate so a real
      // failure isn't silently turned into an untranslated sidecar.
      if (!(e1 instanceof TranslationCountError)) throw e1;
      // Retry once at the same size — transient count hiccups often clear.
      try {
        return await translateBatch(batch);
      } catch (e2) {
        if (!(e2 instanceof TranslationCountError)) throw e2;
        if (batch.length === 1) {
          // Per-cue floor: this single cue deterministically mismatches. Keep
          // its ORIGINAL text — graceful degradation limited to ONE cue, not a
          // whole batch (the ep11/ep17 untranslated-passthrough bug).
          console.warn(
            `translateCues: single cue still mismatched (${e2.message}); ` +
              `keeping original text for 1 cue`,
          );
          return [batch[0]!.text];
        }
        // Split in half and recurse — isolates the offending cue(s) so the rest
        // of the batch still gets translated.
        console.warn(
          `translateCues: batch of ${batch.length} still mismatched (${e2.message}); ` +
            `splitting into halves`,
        );
        const mid = Math.ceil(batch.length / 2);
        const left = await translateBatchResilient(batch.slice(0, mid));
        const right = await translateBatchResilient(batch.slice(mid));
        return [...left, ...right];
      }
    }
  };

  return runBatched(cues, async (batch) => {
    const texts = await translateBatchResilient(batch);
    return batch.map((c, j) => ({ start: c.start, end: c.end, text: texts[j]! }));
  }, onProgress);
}
