// Subtitle parsing (SRT / VTT / ASS) and embedded track extraction via ffmpeg.

import { stat } from "node:fs/promises";

export interface Cue {
  /** seconds */
  start: number;
  /** seconds */
  end: number;
  text: string;
}

export interface SubTrack {
  /** "embedded:<index>" or "sidecar:<lang>" */
  id: string;
  kind: "embedded" | "sidecar";
  lang: string;
  title?: string;
  codec?: string;
  path?: string;
  /** sidecar provenance: auto-generated (subs/ dir) vs user-provided file */
  origin?: "generated" | "external";
  /** stream index for embedded tracks */
  index?: number;
  /** friendly UI label, e.g. "Japanese · Whisper" */
  label?: string;
}

/** Map a raw language code to a friendly display name. */
export function languageName(code: string): string {
  switch (code.toLowerCase()) {
    case "ja":
    case "jpn":
      return "Japanese";
    case "ru":
    case "rus":
      return "Russian";
    case "en":
    case "eng":
      return "English";
    case "de":
    case "ger":
      return "German";
    default:
      return code.toUpperCase();
  }
}

/** Build the friendly "${LanguageName} · ${source}" label for a track. */
export function trackLabel(track: SubTrack): string {
  let source: string;
  if (track.kind === "embedded") {
    const title = track.title ?? "";
    source = /whisper/i.test(title) ? "Whisper" : "embedded";
  } else {
    source = track.origin === "generated" ? "generated" : "file";
  }
  return `${languageName(track.lang)} · ${source}`;
}

// --- sidecar track ids ---

export interface SidecarTrackRef {
  generated: boolean;
  lang: string;
  /** extension without dot, e.g. "srt"; undefined for legacy ids like "sidecar:ru" */
  ext?: string;
}

/**
 * Parse a sidecar track id.
 *   "sidecar:ru.srt"  → { generated: false, lang: "ru", ext: "srt" }
 *   "sidecar:ru"      → { generated: false, lang: "ru" }   (legacy, pre-ext ids)
 *   "sidecar:gen:ja"  → { generated: true, lang: "ja" }
 */
export function parseSidecarTrackId(id: string): SidecarTrackRef | null {
  if (!id.startsWith("sidecar:")) return null;
  const generated = id.startsWith("sidecar:gen:");
  const rest = id.slice(generated ? "sidecar:gen:".length : "sidecar:".length);
  const m = rest.match(/^(.+)\.(srt|vtt|ass|ssa)$/i);
  if (m) return { generated, lang: m[1]!, ext: m[2]!.toLowerCase() };
  return { generated, lang: rest };
}

// --- timestamp helpers ---

export function parseTimestamp(ts: string): number {
  // "HH:MM:SS,mmm" (srt) | "HH:MM:SS.mmm" (vtt/ass, hours optional in vtt, cs in ass)
  const m = ts.trim().match(/^(?:(\d+):)?(\d+):(\d+)[.,](\d+)$/);
  if (!m) return NaN;
  const h = m[1] ? parseInt(m[1], 10) : 0;
  const min = parseInt(m[2]!, 10);
  const s = parseInt(m[3]!, 10);
  const fracStr = m[4]!;
  const frac = parseInt(fracStr, 10) / 10 ** fracStr.length;
  return h * 3600 + min * 60 + s + frac;
}

export function formatSrtTimestamp(t: number): string {
  const ms = Math.round(t * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const rem = ms % 1000;
  const p = (n: number, w: number) => String(n).padStart(w, "0");
  return `${p(h, 2)}:${p(m, 2)}:${p(s, 2)},${p(rem, 3)}`;
}

// --- fansub credit / signature filtering -----------------------------------

/**
 * ASS Style names that are PURE fansub credits / signatures (the whole style is
 * a watermark — every Dialogue line under it is a credit, never real dialogue).
 * Matched case-insensitively as whole tokens against the Style name.
 *
 * Hyouka (Kamigami BD) uses `staff` for the "KamiGami" logo + translator-handle
 * lines. We DELIBERATELY do NOT list `Title` here: in these files `Title` carries
 * real on-screen sign translations (episode arc titles like 「绕远的偶人」) AND the
 * single end-card credit (诸神字幕组…kamigami.org). The end-card is caught by the
 * content filter (isFansubCreditCue) instead, so the real signs survive.
 */
const CREDIT_STYLE_RE =
  /^(?:staff|credits?|logo|watermark|group|fansub|fx[-_]?credit|credit[-_].*|.*[-_]credits?)$/i;

function isCreditStyle(style: string): boolean {
  return CREDIT_STYLE_RE.test(style.trim());
}

/**
 * Content-based detector for fansub SIGNATURE cues that must never reach the
 * viewer. Conservative by design: a cue is only a credit if it is DOMINATED by
 * the signature (essentially the whole cue is one). A normal dialogue line that
 * merely mentions a name, number, or URL is NOT dropped.
 *
 * Catches, on the already-stripped cue text (no ASS override tags):
 *   - the bare group logo, e.g. "KamiGami", "诸神字幕组", "XKsub", "Kamigami"
 *   - translator-handle lists: `@`-prefixed or `／`/`·`-separated handle chains
 *     (incl. the romanized/RU variants leaked into the generated .srt)
 *   - a cue that is essentially just a URL (http… / www.…)
 *   - the "字幕组 … kamigami.org" end-card credit
 *   - "Original Script / Translation / Timing …" style credit headers
 *
 * KEEPS: real dialogue, on-screen signs, and ♪ music cues (benign per QA).
 */
export function isFansubCreditCue(text: string): boolean {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return false;

  // Bare group logo: the entire cue is just a known group name.
  if (/^(?:kamigami|诸神字幕组|诸神|xksub|x-?ks|kamigami\.org)$/i.test(t)) return true;

  // Translator-handle list: starts with "@" OR is built from "·"/"／"-joined
  // handles. Require it to be (essentially) the whole cue — at least two
  // segments — so an ordinary line containing a middle dot isn't dropped.
  const handleBody = t.replace(/^@\s*/, "");
  const looksLikeHandleList =
    /[／/·]/.test(handleBody) &&
    handleBody.split(/[／/·]/).filter((s) => s.trim().length > 0).length >= 2;
  if (t.startsWith("@") && looksLikeHandleList) return true;
  // Even without "@": a pure handle chain like "湮·Molly／小然·酸菜／…" (≥3 segments,
  // no sentence-ending punctuation) is a credit.
  if (
    looksLikeHandleList &&
    handleBody.split(/[／/·]/).filter((s) => s.trim().length > 0).length >= 3 &&
    !/[。.!?！？…]/.test(t)
  ) {
    return true;
  }

  // Cue that is essentially just a URL.
  if (/^(?:https?:\/\/|www\.)\S+$/i.test(t)) return true;

  // Fansub-group end-card: any cue that cites the group's watermark domain
  // (kamigami.org) is a credit, in every localization (CN/RU/EN end-cards all
  // carry it). The domain never appears in legitimate Hyouka dialogue.
  if (/kamigami\.org/i.test(t)) return true;
  // Generic 字幕组 / fansub credit sentence that carries a URL.
  if (/字幕组/.test(t) && /(kamigami|www\.|https?:\/\/)/i.test(t)) return true;
  if (/^(?:original\s+(?:script|translation|timing)|translated\s+by|timing\s+by|encode(?:d)?\s+by)\b/i.test(t)) {
    return true;
  }

  return false;
}

// --- parsers ---

function stripHtmlishTags(text: string): string {
  return text.replace(/<\/?(?:b|i|u|font|ruby|rt|c)[^>]*>/gi, "").trim();
}

export function parseSrt(text: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = text.replace(/^﻿/, "").replace(/\r/g, "").split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.length > 0);
    if (lines.length < 2) continue;
    let i = 0;
    if (/^\d+$/.test(lines[0]!.trim())) i = 1;
    const timing = lines[i]?.match(/(\S+)\s*-->\s*(\S+)/);
    if (!timing) continue;
    const start = parseTimestamp(timing[1]!);
    const end = parseTimestamp(timing[2]!);
    if (Number.isNaN(start) || Number.isNaN(end)) continue;
    const body = lines.slice(i + 1).join("\n");
    const cleaned = stripHtmlishTags(body);
    if (cleaned && !isFansubCreditCue(cleaned)) cues.push({ start, end, text: cleaned });
  }
  return cues.sort((a, b) => a.start - b.start);
}

export function parseVtt(text: string): Cue[] {
  // VTT is close enough to SRT after dropping the header and cue settings.
  const body = text
    .replace(/^﻿/, "")
    .replace(/\r/g, "")
    .replace(/^WEBVTT[^\n]*\n/, "")
    .replace(/-->\s*([\d:.]+)[^\n]*/g, "--> $1");
  return parseSrt(body);
}

/** Does a string contain any hiragana or katakana? */
function hasKana(text: string): boolean {
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c >= 0x3040 && c <= 0x30ff) return true;
  }
  return false;
}

/** Does a string contain any CJK ideograph (hanzi/kanji)? */
function hasCjk(text: string): boolean {
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf)) return true;
  }
  return false;
}

/**
 * Classify an ASS style name as Japanese-leaning, Chinese-leaning, or neither.
 * Token-based so we don't misfire on substrings (e.g. "Main" containing nothing
 * relevant). Returns "jp" | "cn" | "" (unknown).
 */
function classifyStyle(name: string): "jp" | "cn" | "" {
  const n = name.toLowerCase();
  // Japanese markers: ja / jp / jpn / 日 / 和
  const jp = /\b(ja|jp|jpn|jap|jpan|nihongo)\b/.test(n) || /日本|日語|和/.test(name) || /日/.test(name);
  // Chinese markers: cn / chs / cht / zh / sc / tc / 中 / 简 / 繁
  const cn =
    /\b(cn|chs|cht|zh|zhs|zht|sc|tc|chi|chn|chinese)\b/.test(n) ||
    /中文|中字|简体|繁體|繁体|简|繁|中/.test(name);
  if (jp && !cn) return "jp";
  if (cn && !jp) return "cn";
  return "";
}

interface RawDialogue {
  start: number;
  end: number;
  style: string;
  text: string;
}

export function parseAss(text: string): Cue[] {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  // ASS has multiple sections each with their own Format: line (Styles vs
  // Events). Track the current section so we read the EVENTS format for
  // Dialogue parsing, not the Styles one.
  let section = "";
  let eventsFormat: string[] | null = null;
  const dialogues: RawDialogue[] = [];

  for (const line of lines) {
    const sec = line.match(/^\[([^\]]+)\]\s*$/);
    if (sec) {
      section = sec[1]!.toLowerCase();
      continue;
    }
    if (line.startsWith("Format:")) {
      if (/event/.test(section)) {
        eventsFormat = line
          .slice("Format:".length)
          .split(",")
          .map((f) => f.trim());
      }
      continue;
    }
    if (line.startsWith("Dialogue:") && eventsFormat) {
      const format = eventsFormat;
      const parts = line.slice("Dialogue:".length).split(",");
      const textIdx = format.indexOf("Text");
      if (textIdx === -1 || parts.length <= textIdx) continue;
      const get = (field: string) => {
        const i = format.indexOf(field);
        return i >= 0 ? parts[i]?.trim() ?? "" : "";
      };
      const start = parseTimestamp(get("Start"));
      const end = parseTimestamp(get("End"));
      if (Number.isNaN(start) || Number.isNaN(end)) continue;
      const style = get("Style");
      // Drop credit/signature styles wholesale (e.g. `staff` = KamiGami logo +
      // translator handles). Real dialogue and sign styles are unaffected.
      if (isCreditStyle(style)) continue;
      // Text is everything from textIdx on (it may itself contain commas).
      const raw = parts.slice(textIdx).join(",");
      // Drop vector-drawing dialogue (\p1..\p0 blocks): signs/typesetting, not
      // speech. After stripping override tags the remaining body is just drawing
      // commands (m/l/b/s/p coords), which would otherwise dilute the kana guard.
      if (/\\p[1-9]/.test(raw)) continue;
      const body = raw
        .replace(/\{[^}]*\}/g, "") // override tags
        .replace(/\\N|\\n/g, "\n")
        .replace(/\\h/g, " ")
        .trim();
      // Leftover that is ONLY ASS drawing tokens (e.g. "m 0 0 l 10 0 b ...") —
      // no letters/CJK at all — is a drawing fragment; skip it.
      if (body && /^[\s\d.mlbspconMLBSPCON-]+$/.test(body) && /[a-z]/i.test(body)) {
        continue;
      }
      if (body) dialogues.push({ start, end, style, text: body });
    }
  }

  const kept = selectJapaneseDialogues(dialogues).filter(
    (d) => !isFansubCreditCue(d.text),
  );
  const cues = kept.map((d) => ({ start: d.start, end: d.end, text: d.text }));
  cues.sort((a, b) => a.start - b.start);
  return cues;
}

/**
 * From a parsed set of ASS dialogue lines, select the Japanese ones — dropping
 * the Chinese half of a dual-language (e.g. Kamigami JP+CN) `.ass`. Two layers:
 *
 *  (a) STYLE-BASED (preferred): classify each line's Style name as JP- or
 *      CN-like. If the file has BOTH JP-styled and CN-styled lines it is
 *      dual-language → keep ONLY the JP-styled lines. (Lines with unknown
 *      styles are kept too, so signs / unnamed JP cues aren't lost.)
 *
 *  (b) PER-LINE KANA fallback (styles ambiguous/unnamed): a kana-bearing line
 *      is Japanese; a CJK line with zero kana is (probably) Chinese. Only when
 *      the file is a genuine mix (both kana lines AND hanzi-only-CJK lines) do
 *      we drop a hanzi-only-CJK line, and ONLY if it time-overlaps a kana line
 *      (its JP counterpart) — so kanji-only Japanese signs/short cues without a
 *      paired CN line survive.
 *
 * Pure-Japanese (all kana / single JP style) and pure-Chinese files pass through
 * unchanged from this stage; a pure-Chinese result then trips the downstream
 * `looksJapanese` guard and falls back to whisper.
 */
function selectJapaneseDialogues(dialogues: RawDialogue[]): RawDialogue[] {
  if (dialogues.length === 0) return dialogues;

  // --- (a) style-based ---
  let hasJpStyle = false;
  let hasCnStyle = false;
  for (const d of dialogues) {
    const cls = classifyStyle(d.style);
    if (cls === "jp") hasJpStyle = true;
    else if (cls === "cn") hasCnStyle = true;
  }
  if (hasJpStyle && hasCnStyle) {
    // Dual-language by style. Keep JP-styled + unknown-styled; drop CN-styled.
    return dialogues.filter((d) => classifyStyle(d.style) !== "cn");
  }

  // --- (b) per-line kana fallback ---
  const kanaLines = dialogues.filter((d) => hasKana(d.text));
  const hanziOnly = dialogues.filter((d) => !hasKana(d.text) && hasCjk(d.text));
  // Only treat as dual-language if there is a meaningful mix.
  if (kanaLines.length > 0 && hanziOnly.length > 0) {
    return dialogues.filter((d) => {
      if (hasKana(d.text) || !hasCjk(d.text)) return true; // JP or non-CJK → keep
      // hanzi-only line: drop only if it overlaps a kana-bearing (JP) line.
      const overlapsJp = kanaLines.some(
        (j) => d.start < j.end && j.start < d.end,
      );
      return !overlapsJp;
    });
  }

  // Pure-Japanese or pure-Chinese (or no CJK at all) → unchanged.
  return dialogues;
}

// --- language detection (jimaku non-Japanese guard) -------------------------

/**
 * Fraction of hiragana+katakana among all "scriptful" chars (kana + CJK
 * ideographs). Japanese dialogue is kana-heavy (particles, okurigana,
 * inflections); Chinese (even Chinese fansubs of anime) is hanzi-only with a
 * kana ratio of ~0. Returns 0 when there are no kana/CJK chars at all.
 *
 *   Hiragana: U+3040–U+309F   Katakana: U+30A0–U+30FF
 *   CJK ideographs: U+4E00–U+9FFF (+ ext A U+3400–U+4DBF)
 */
export function kanaRatio(text: string): number {
  let kana = 0;
  let cjk = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if ((c >= 0x3040 && c <= 0x30ff)) kana++;
    else if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf)) cjk++;
  }
  const total = kana + cjk;
  return total === 0 ? 0 : kana / total;
}

/** Minimum kana ratio for a track to count as Japanese (rejects Chinese subs). */
export const JAPANESE_KANA_MIN = 0.06;

/**
 * Heuristic: does this cue set look like Japanese (vs. a Chinese fansub)?
 * Aggregates kana ratio over all cue text so a few katakana sign lines in an
 * otherwise-Chinese file don't flip the verdict. Empty input → false.
 */
export function looksJapanese(cues: Cue[], minRatio = JAPANESE_KANA_MIN): boolean {
  if (cues.length === 0) return false;
  const all = cues.map((c) => c.text).join("\n");
  return kanaRatio(all) >= minRatio;
}

export function parseSubtitleText(text: string, ext: string): Cue[] {
  switch (ext.replace(/^\./, "").toLowerCase()) {
    case "vtt":
      return parseVtt(text);
    case "ass":
    case "ssa":
      return parseAss(text);
    default:
      return parseSrt(text);
  }
}

// --- whisper anti-hallucination: collapse repeated-cue runs ---

/** Normalization for repeat detection: trim + strip JP/ASCII punctuation. */
function repeatNorm(text: string): string {
  const norm = text
    .replace(/[。、．，！？!?…‥・「」『』（）()\[\]【】《》〈〉“”"'’〜~ー―\-—♪♫♬♩〽\s]/g, "")
    .trim();
  // Pure punctuation/music cues (♪~) normalize to "": fall back to the trimmed
  // text so note-spam loops are still detected as runs.
  return norm !== "" ? norm : text.trim();
}

/** Near-duplicate check for hallucination runs: identical after punctuation
 * stripping, or one is a substring of the other (whisper loops often drift by
 * a trailing particle / honorific, e.g. おれきほうたろお vs おれきほうたろお殿). */
function repeatNear(a: string, b: string): boolean {
  if (a === "" || b === "") return a === b;
  return a === b || a.includes(b) || b.includes(a);
}

/** Cap for the single cue kept from a collapsed hallucination run. The old
 * behavior merged the whole run into one cue spanning minutes, which papered
 * over the fact that the underlying audio was never really transcribed. */
const COLLAPSED_CUE_MAX_SEC = 10;

/**
 * Whisper hallucinates on music/silence by repeating the same phrase as many
 * consecutive cues. Collapse a run of consecutive identically-normalized cues
 * into ONE cue spanning the whole run — but only when the run looks like a
 * hallucination: length >= `minRun` (default 4), or a 3-run stretching over
 * `spanSec` (default 20s) of wall time. Short 3-runs are kept, because real
 * dialogue legitimately repeats (待って！待って！待って！).
 */
export function collapseRepeatedCues(cues: Cue[], minRun = 4, spanSec = 20): Cue[] {
  const out: Cue[] = [];
  let i = 0;
  while (i < cues.length) {
    const norm = repeatNorm(cues[i]!.text);
    let j = i + 1;
    while (j < cues.length && norm !== "" && repeatNear(repeatNorm(cues[j]!.text), norm)) j++;
    const run = j - i;
    const span = cues[j - 1]!.end - cues[i]!.start;
    if (run >= minRun || (run >= 3 && span > spanSec)) {
      // Keep only the first occurrence, duration-capped. Do NOT stretch it over
      // the whole run: a loop spanning minutes means whisper never transcribed
      // that audio — leave a visible gap so findCoverageHoles() can trigger a
      // repair pass instead of hiding an 11-minute hole inside one mega-cue.
      const first = cues[i]!;
      out.push({
        start: first.start,
        end: Math.min(first.end, first.start + COLLAPSED_CUE_MAX_SEC),
        text: first.text,
      });
    } else {
      for (let k = i; k < j; k++) out.push(cues[k]!);
    }
    i = j;
  }
  return out;
}

/**
 * Detect and drop repeating multi-cue CYCLES (period > 1) that
 * `collapseRepeatedCues` misses: whisper sometimes loops a whole N-line passage
 * several times (e.g. a letter read once but transcribed 3×). For each position
 * we look for the longest period `p` (1..maxPeriod) whose block of `p` cues is
 * immediately followed by `>= minReps-1` near-identical copies, and keep only
 * the FIRST block, dropping the rest. Kept cues retain their original
 * timestamps; the dropped repeats simply leave a gap (no fabricated timings).
 *
 * Guards against eating legitimate repeated dialogue:
 *  - period 1 (a single cue repeating) is left to collapseRepeatedCues, which
 *    has the run-length / span heuristics; here we only act on period 1 when the
 *    cycle is long (>= singleMinReps) so we don't clip a genuine はい／はい.
 *  - period >= 2 needs only minReps repetitions, since a whole multi-cue block
 *    repeating verbatim is virtually always a hallucination loop.
 */
export function dropRepeatingCycles(
  cues: Cue[],
  maxPeriod = 8,
  minReps = 2,
  singleMinReps = 4,
): Cue[] {
  const norm = cues.map((c) => repeatNorm(c.text));
  const keep = new Array<boolean>(cues.length).fill(true);

  let i = 0;
  while (i < cues.length) {
    if (!keep[i]) {
      i++;
      continue;
    }
    let bestPeriod = 0;
    let bestEnd = i; // exclusive index past the last repeated block
    // Prefer the LONGEST period that still repeats, so a 4-line cycle is
    // detected as period 4 rather than collapsing on a coincidental sub-period.
    for (let p = Math.min(maxPeriod, cues.length - i); p >= 1; p--) {
      if (i + 2 * p > cues.length) continue;
      let reps = 1;
      let base = i;
      while (base + p + p <= cues.length && blocksMatch(norm, base, base + p, p)) {
        reps++;
        base += p;
      }
      if (reps < minReps) continue;
      const required = p === 1 ? singleMinReps : minReps;
      if (reps < required) continue;
      bestPeriod = p;
      bestEnd = base + p; // base points at last matching block's start
      break;
    }
    if (bestPeriod > 0) {
      // Extend over a PARTIAL trailing repeat: after the last full block, keep
      // consuming cues that still match the cycle position-for-position (a loop
      // often drifts mid-way through its final pass, e.g. cue 14 in Hyouka 02).
      let tail = bestEnd;
      while (tail < cues.length && repeatNear(norm[tail]!, norm[i + ((tail - i) % bestPeriod)]!)) {
        tail++;
      }
      // Keep the first block [i, i+bestPeriod); drop the rest of the cycle.
      for (let k = i + bestPeriod; k < tail; k++) keep[k] = false;
      // Drop a LEADING preamble: whisper sometimes emits a degraded preview of
      // the looped passage just before the real loop. Scan backward over kept,
      // contiguous cues and drop any that are a drifted echo of the matching
      // position in the confirmed first block. Stop at the first non-echo so we
      // never eat unrelated dialogue that happens to sit before the loop.
      // The preamble is often a short, mis-phased partial pass of the same
      // passage (A B A vs the real A B C D), so we match each head cue against
      // ANY line of the confirmed first block rather than a fixed phase. Bounded
      // to the contiguous head and broken on the first non-echo, this stays safe.
      for (let k = i - 1; k >= 0 && keep[k]; k--) {
        let echo = false;
        for (let j = i; j < i + bestPeriod; j++) {
          if (prefixSimilar(norm[k]!, norm[j]!)) {
            echo = true;
            break;
          }
        }
        if (echo) keep[k] = false;
        else break;
      }
      i = tail;
    } else {
      i++;
    }
  }
  return cues.filter((_, idx) => keep[idx]);
}

/**
 * Looser near-match used ONLY for the leading-preamble scan: whisper often emits
 * a degraded *preview* of the first looped line before the real loop starts
 * (Hyouka 02: "おれきほうたろお殿" previews the letter's real opener
 * "おれきほうたろうどの"). These share a long common prefix but diverge at the
 * tail (name/honorific drift), so substring matching misses them. We require a
 * substantial shared prefix relative to the shorter string. This is deliberately
 * NOT used for cycle equality (where it would risk eating distinct dialogue) —
 * only to recognise preamble echoes of an already-confirmed downstream cycle.
 */
function prefixSimilar(a: string, b: string): boolean {
  if (a === "" || b === "") return false;
  if (repeatNear(a, b)) return true;
  const shorter = Math.min(a.length, b.length);
  if (shorter < 4) return false;
  let common = 0;
  while (common < shorter && a[common] === b[common]) common++;
  // ≥5 shared chars AND ≥45% of the shorter line — enough to flag a drifted
  // echo (incl. long lines that diverge only at the very end, e.g.
  // "全略私は今を…" vs "全略私は今ヴェナレス…"), strict enough that genuinely
  // different lines (which rarely share a 5-char run-in) are left alone.
  return common >= 5 && common / shorter >= 0.45;
}

/** Two blocks of `p` cues starting at a and b are a near-match (per-cue
 * repeatNear over normalized text). Empty-normalized cues must match exactly. */
function blocksMatch(norm: string[], a: number, b: number, p: number): boolean {
  for (let k = 0; k < p; k++) {
    if (!repeatNear(norm[a + k]!, norm[b + k]!)) return false;
  }
  return true;
}

/**
 * Full anti-hallucination post-processing pipeline used for both freshly
 * transcribed cues and re-cleaning existing sidecars: first collapse
 * consecutive single-cue runs, then drop periodic multi-cue cycles. Idempotent.
 */
export function cleanCues(cues: Cue[]): Cue[] {
  return dropRepeatingCycles(collapseRepeatedCues(cues));
}

export interface CoverageHole {
  start: number;
  end: number;
}

/**
 * Find stretches of `minGapSec`+ seconds with no cues, including a hole at the
 * head and (minus `tailSlackSec` for credits/ED) at the tail. Input cues must
 * be in start order (whisper output is).
 */
export function findCoverageHoles(
  cues: Cue[],
  durationSec: number,
  minGapSec = 45,
  tailSlackSec = 30,
): CoverageHole[] {
  const holes: CoverageHole[] = [];
  let covered = 0;
  for (const c of cues) {
    if (c.start - covered >= minGapSec) holes.push({ start: covered, end: c.start });
    covered = Math.max(covered, c.end);
  }
  const tail = durationSec - tailSlackSec;
  if (tail - covered >= minGapSec) holes.push({ start: covered, end: durationSec });
  return holes;
}

export function cuesToSrt(cues: Cue[]): string {
  return (
    cues
      .map(
        (c, i) =>
          `${i + 1}\n${formatSrtTimestamp(c.start)} --> ${formatSrtTimestamp(c.end)}\n${c.text}`,
      )
      .join("\n\n") + "\n"
  );
}

// --- embedded tracks via ffmpeg/ffprobe ---

interface FfprobeStream {
  index: number;
  codec_type: string;
  codec_name?: string;
  tags?: Record<string, string>;
}

// Run a subprocess to completion, draining both pipes (avoids deadlock) and
// returning captured stdout/stderr text plus the exit code.
async function spawnText(argv: string[]): Promise<{ out: string; err: string; code: number }> {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { out, err, code: await proc.exited };
}

export async function probeStreams(file: string): Promise<FfprobeStream[]> {
  const { out, code } = await spawnText([
    "ffprobe", "-v", "error", "-print_format", "json", "-show_streams", file,
  ]);
  if (code !== 0) throw new Error(`ffprobe failed for ${file}`);
  const data = JSON.parse(out) as { streams?: FfprobeStream[] };
  return data.streams ?? [];
}

// In-memory cache of probed embedded sub-track lists, keyed by path+size+mtime
// — `ffprobe` costs ~100ms per call and /api/subs probes on every request.
// Invalidated automatically when the file's size or mtime changes (new key).
// Mirrors the `extractCache` scheme below and `embeddedLangCache` in library.ts.
const embeddedTracksCache = new Map<string, SubTrack[]>();
const EMBEDDED_TRACKS_CACHE_MAX = 64;

export async function listEmbeddedSubTracks(file: string): Promise<SubTrack[]> {
  let key: string | null = null;
  try {
    const st = await stat(file);
    key = `${file}:${st.size}:${st.mtimeMs}`;
    const hit = embeddedTracksCache.get(key);
    if (hit !== undefined) return hit;
  } catch {
    // unstatable — probe uncached (probeStreams throws on a real failure,
    // matching the previous always-probe behavior).
  }
  const tracks = await listEmbeddedSubTracksUncached(file);
  if (key != null) fifoSet(embeddedTracksCache, key, tracks, EMBEDDED_TRACKS_CACHE_MAX);
  return tracks;
}

// Insert into a FIFO-capped Map, evicting oldest entries until under `max`.
function fifoSet<V>(cache: Map<string, V>, key: string, value: V, max: number): void {
  while (cache.size >= max) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  cache.set(key, value);
}

async function listEmbeddedSubTracksUncached(file: string): Promise<SubTrack[]> {
  const streams = await probeStreams(file);
  return streams
    .filter((s) => s.codec_type === "subtitle")
    .map((s) => {
      const lang = (s.tags?.language ?? s.tags?.LANGUAGE ?? "und").toLowerCase();
      const t: SubTrack = {
        id: `embedded:${s.index}`,
        kind: "embedded",
        lang,
        index: s.index,
      };
      const title = s.tags?.title ?? s.tags?.TITLE;
      if (title !== undefined) t.title = title;
      if (s.codec_name !== undefined) t.codec = s.codec_name;
      return t;
    });
}

// In-memory cache of extracted embedded tracks, keyed by path+index+size+mtime
// — demuxing the whole MKV on every track switch is slow. Small FIFO cap.
const extractCache = new Map<string, string>();
const EXTRACT_CACHE_MAX = 20;

/** Extract an embedded subtitle stream as SRT text (cached). */
export async function extractEmbeddedTrack(
  file: string,
  streamIndex: number,
): Promise<string> {
  let key: string | null = null;
  try {
    const st = await stat(file);
    key = `${file}:${streamIndex}:${st.size}:${st.mtimeMs}`;
    const hit = extractCache.get(key);
    if (hit !== undefined) return hit;
  } catch {
    // unstatable — extract uncached (ffmpeg will report the real error)
  }
  const { out, err, code } = await spawnText([
    "ffmpeg", "-v", "error", "-i", file, "-map", `0:${streamIndex}`, "-f", "srt", "-",
  ]);
  if (code !== 0) {
    throw new Error(`ffmpeg subtitle extraction failed: ${err.slice(0, 300)}`);
  }
  if (key != null) fifoSet(extractCache, key, out, EXTRACT_CACHE_MAX);
  return out;
}
