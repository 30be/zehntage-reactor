// Headless Anki card renderer + protobuf config decoder (Wave 18).
//
// Anki schema ver >= 18 stores card templates and note-type CSS as protobuf
// blobs in `templates.config` / `notetypes.config`, and FSRS params + scheduling
// limits in `deck_config.config`. This module re-implements just enough of the
// protobuf wire format and Anki's mustache-subset templating to render the
// zehntage "Back+Front+Usage" notetype (and degrade gracefully on others)
// without a running Anki backend.
//
// References: see /tmp/wave18-card-render.md and /tmp/wave18-anki-db.md.

// ---------------------------------------------------------------------------
// 1. Minimal protobuf wire-format reader
// ---------------------------------------------------------------------------

/** Protobuf wire types we care about. */
export const WireType = {
  Varint: 0, // int32/64, uint, bool, enum
  Fixed64: 1, // double, fixed64, sfixed64
  LengthDelimited: 2, // string, bytes, embedded msg, packed repeated
  Fixed32: 5, // float, fixed32, sfixed32
} as const;

/** A decoded wire value: varints become `bigint`, fixed/len-delimited are raw bytes. */
export type ProtoValue = bigint | Uint8Array;

/**
 * Parse a protobuf message into a map of field-number -> list of raw values.
 * Repeated fields accumulate; callers pick the interpretation (string, packed
 * floats, etc.). Unknown group wire types (3/4, deprecated) are not supported
 * and cause a throw — none appear in Anki's config blobs.
 */
export function readProtoFields(buf: Uint8Array): Map<number, ProtoValue[]> {
  const out = new Map<number, ProtoValue[]>();
  let p = 0;
  const readVarint = (): bigint => {
    let result = 0n;
    let shift = 0n;
    while (p < buf.length) {
      const b = buf[p++]!;
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result;
      shift += 7n;
    }
    throw new Error("protobuf: truncated varint");
  };
  const push = (field: number, value: ProtoValue) => {
    const list = out.get(field);
    if (list) list.push(value);
    else out.set(field, [value]);
  };
  while (p < buf.length) {
    const tag = Number(readVarint());
    const field = tag >>> 3;
    const wire = tag & 0x7;
    switch (wire) {
      case WireType.Varint:
        push(field, readVarint());
        break;
      case WireType.Fixed64:
        if (p + 8 > buf.length)
          throw new Error(`protobuf: truncated fixed64 (field ${field})`);
        push(field, buf.slice(p, p + 8));
        p += 8;
        break;
      case WireType.LengthDelimited: {
        const len = Number(readVarint());
        if (len < 0 || p + len > buf.length)
          throw new Error(`protobuf: truncated length-delimited field ${field} (need ${len}, have ${buf.length - p})`);
        push(field, buf.slice(p, p + len));
        p += len;
        break;
      }
      case WireType.Fixed32:
        if (p + 4 > buf.length)
          throw new Error(`protobuf: truncated fixed32 (field ${field})`);
        push(field, buf.slice(p, p + 4));
        p += 4;
        break;
      default:
        throw new Error(`protobuf: unsupported wire type ${wire} (field ${field})`);
    }
  }
  return out;
}

const td = new TextDecoder();

/** Interpret a length-delimited field value as a UTF-8 string. */
export function protoString(v: ProtoValue | undefined): string {
  if (v == null) return "";
  if (v instanceof Uint8Array) return td.decode(v);
  return String(v);
}

// Little-endian DataView over a Uint8Array's exact byte range.
const dataView = (v: Uint8Array) => new DataView(v.buffer, v.byteOffset, v.byteLength);

/** Interpret a varint field value as a JS number. */
export function protoNumber(v: ProtoValue | undefined): number {
  if (v == null) return 0;
  if (typeof v === "bigint") return Number(v);
  // little-endian fixed32/64
  const dv = dataView(v);
  if (v.byteLength >= 8) return Number(dv.getBigUint64(0, true));
  if (v.byteLength >= 4) return dv.getUint32(0, true);
  return 0;
}

/** Decode a packed repeated float32 (little-endian) length-delimited field. */
export function protoPackedFloats(v: ProtoValue | undefined): number[] {
  if (!(v instanceof Uint8Array)) return [];
  const dv = dataView(v);
  const out: number[] = [];
  for (let i = 0; i + 4 <= v.byteLength; i += 4) out.push(dv.getFloat32(i, true));
  return out;
}

/** Decode a single fixed32 float field value. */
export function protoFloat(v: ProtoValue | undefined): number {
  if (!(v instanceof Uint8Array) || v.byteLength < 4) return 0;
  return dataView(v).getFloat32(0, true);
}

// ---------------------------------------------------------------------------
// 2. Targeted config decoders
// ---------------------------------------------------------------------------

/**
 * Decode a `templates.config` protobuf blob.
 * Wire layout (Anki `CardTemplateConfig`): f1=qfmt, f2=afmt (both UTF-8).
 */
export function decodeTemplate(configBlob: Uint8Array): { qfmt: string; afmt: string } {
  const f = readProtoFields(configBlob);
  return {
    qfmt: protoString(f.get(1)?.[0]),
    afmt: protoString(f.get(2)?.[0]),
  };
}

/**
 * Decode a `notetypes.config` protobuf blob.
 * Wire layout (Anki `NotetypeConfig`): f3=css (UTF-8). f5 holds the LaTeX
 * preamble (ignored).
 */
export function decodeNotetype(configBlob: Uint8Array): { css: string } {
  const f = readProtoFields(configBlob);
  return { css: protoString(f.get(3)?.[0]) };
}

export interface DeckConfigDecoded {
  /** FSRS weights/params — the current FSRS-5/6 array (wire field 6, 21 floats). */
  weights: number[];
  /** All historical weight arrays keyed by wire field (3, 5, 6, ...). */
  weightHistory: Record<number, number[]>;
  learningSteps: number[]; // minutes (wire f1)
  relearningSteps: number[]; // minutes (wire f2)
  desiredRetention: number; // wire f37
  newPerDay: number; // wire f9
  revPerDay: number; // wire f10
  maximumReviewInterval: number; // wire f16
  initialEase: number; // wire f11 (legacy, unused under FSRS)
  intervalMultiplier: number; // wire f15
}

/**
 * Decode a `deck_config.config` protobuf blob (Anki `DeckConfig.Config`).
 * The FSRS weight arrays accumulate historically; the highest-numbered present
 * (f6 = 21 FSRS-5/6 params) is the current one and is returned as `weights`.
 */
export function decodeDeckConfig(configBlob: Uint8Array): DeckConfigDecoded {
  const f = readProtoFields(configBlob);
  const weightHistory: Record<number, number[]> = {};
  for (const field of [3, 5, 6]) {
    const v = f.get(field)?.[0];
    if (v instanceof Uint8Array) weightHistory[field] = protoPackedFloats(v);
  }
  // Prefer the newest non-empty weight array (f6, else f5, else f3).
  const weights =
    [6, 5, 3].map((k) => weightHistory[k]).find((w) => w?.length) ?? [];
  // FSRS-5/6 schedules on exactly 21 weights; a malformed/truncated array would
  // silently corrupt write-back, so reject it here before any caller schedules.
  if (weights.length !== 21)
    throw new Error(
      `deck_config: expected 21 FSRS weights, got ${weights.length}`,
    );
  return {
    weights,
    weightHistory,
    learningSteps: protoPackedFloats(f.get(1)?.[0]),
    relearningSteps: protoPackedFloats(f.get(2)?.[0]),
    desiredRetention: protoFloat(f.get(37)?.[0]),
    newPerDay: protoNumber(f.get(9)?.[0]),
    revPerDay: protoNumber(f.get(10)?.[0]),
    maximumReviewInterval: protoNumber(f.get(16)?.[0]),
    initialEase: protoFloat(f.get(11)?.[0]),
    intervalMultiplier: protoFloat(f.get(15)?.[0]),
  };
}

// ---------------------------------------------------------------------------
// 3. Mustache-subset card renderer
// ---------------------------------------------------------------------------

/**
 * Expand `{{#Field}}...{{/Field}}` (non-empty) and `{{^Field}}...{{/Field}}`
 * (empty) conditionals. Innermost-first via a non-greedy scan so simple nesting
 * works for the common case. Returns the body kept/dropped per field emptiness.
 */
function expandConditionals(s: string, fields: Record<string, string>): string {
  const isEmpty = (name: string) => {
    const v = fields[name];
    return v == null || v.trim() === "";
  };
  // Repeatedly collapse the innermost section until none remain.
  const re = /\{\{([#^])([^}]+)\}\}((?:(?!\{\{[#^/])[\s\S])*?)\{\{\/\s*\2\s*\}\}/;
  let prev: string;
  let guard = 0;
  do {
    prev = s;
    s = s.replace(re, (_m, kind: string, rawName: string, body: string) => {
      const name = rawName.trim();
      const keep = kind === "#" ? !isEmpty(name) : isEmpty(name);
      return keep ? body : "";
    });
  } while (s !== prev && guard++ < 100);
  return s;
}

/**
 * Render one side of a card from a template against the note's fields.
 * Supports `{{Field}}` substitution (NOT HTML-escaped — Anki fields are HTML),
 * `{{#Field}}`/`{{^Field}}` conditionals, and graceful degradation of
 * `{{type:..}}` (dropped) / `{{hint:..}}` / `{{cloze:..}}` (field shown,
 * cloze markers stripped). `frontSide` substitutes `{{FrontSide}}`.
 */
function renderSide(
  template: string,
  fields: Record<string, string>,
  frontSide?: string,
): string {
  let s = template;
  // 1. FrontSide first (so its own braces aren't reparsed as fields).
  if (frontSide != null) s = s.replace(/\{\{\s*FrontSide\s*\}\}/g, frontSide);
  // 2. Conditionals.
  s = expandConditionals(s, fields);
  // 3. type-in box: no typing UI, drop entirely.
  s = s.replace(/\{\{\s*type:[^}]+\}\}/g, "");
  // 4. hint: just reveal the field value.
  s = s.replace(/\{\{\s*hint:\s*([^}]+?)\s*\}\}/g, (_m, name: string) =>
    stripCloze(fields[name.trim()] ?? ""),
  );
  // 5. cloze: reveal field, strip {{c1::text::hint}} markers to plain text.
  s = s.replace(/\{\{\s*cloze:\s*([^}]+?)\s*\}\}/g, (_m, name: string) =>
    stripCloze(fields[name.trim()] ?? ""),
  );
  // 6. Strip any remaining filter chains down to the bare field, then substitute
  //    known fields last. Iterate over actual field names so stray "{{" in
  //    values can't break parsing.
  for (const [name, value] of Object.entries(fields)) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // {{Field}} and {{filter:...:Field}} -> value
    const re = new RegExp(`\\{\\{\\s*(?:[^}]*:)?${esc}\\s*\\}\\}`, "g");
    s = s.replace(re, value);
  }
  return s;
}

/** Strip Anki cloze markers `{{c1::text::hint}}` -> `text`. */
function stripCloze(s: string): string {
  return s.replace(/\{\{c\d+::([\s\S]*?)(?:::[\s\S]*?)?\}\}/g, "$1");
}

/**
 * Render a full card (question + answer) from field values, the template's
 * qfmt/afmt, and the model CSS. Output for each side is wrapped as
 * `<style>${css}</style><div class="card">...</div>` (matching Anki, which
 * applies `.card` styling and renders the back's `{{FrontSide}}` as the
 * already-rendered front).
 */
export function renderCard(
  fields: Record<string, string>,
  qfmt: string,
  afmt: string,
  css: string,
): { question: string; answer: string } {
  const frontInner = renderSide(qfmt, fields);
  const backInner = renderSide(afmt, fields, frontInner);
  const wrap = (inner: string) =>
    `<style>${css}</style><div class="card">${inner}</div>`;
  return { question: wrap(frontInner), answer: wrap(backInner) };
}

// ---------------------------------------------------------------------------
// 4. Media rewriting
// ---------------------------------------------------------------------------

/**
 * Rewrite bare Anki media references so a browser can load them through the
 * `/api/anki/media/<name>` proxy:
 *  - `src="NAME"` / `src='NAME'` on img/audio/source whose value is a bare
 *    filename (not absolute, no http(s)/data scheme) -> proxy URL.
 *  - `[sound:NAME]` tokens -> `<audio controls src="...proxy...">`.
 * NAME is validated to contain no `/`, `\`, or `..` (skip rewrite if it does).
 *
 * NOTE: logic is intentionally duplicated from src/lib/anki.ts (do not import)
 * so this headless renderer has no server-coupling.
 */
export function rewriteAnkiMedia(html: string): string {
  const safe = (name: string) =>
    !name.includes("/") && !name.includes("\\") && !name.includes("..");
  let out = html.replace(
    /(\bsrc\s*=\s*)(["'])([^"']+)\2/gi,
    (m, pre: string, q: string, val: string) => {
      // Leave absolute / scheme-qualified / data URIs untouched.
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/)/i.test(val)) return m;
      if (!safe(val)) return m;
      return `${pre}${q}/api/anki/media/${encodeURIComponent(val)}${q}`;
    },
  );
  out = out.replace(/\[sound:([^\]]+)\]/gi, (m, name: string) => {
    const trimmed = name.trim();
    if (!safe(trimmed)) return m;
    return `<audio controls src="/api/anki/media/${encodeURIComponent(trimmed)}"></audio>`;
  });
  return out;
}

/** Split an Anki `notes.flds` value into a field-name map given ordered names. */
export function splitFields(flds: string, fieldNames: string[]): Record<string, string> {
  const parts = flds.split("\x1f");
  const out: Record<string, string> = {};
  fieldNames.forEach((name, i) => {
    out[name] = parts[i] ?? "";
  });
  return out;
}
