// Gemini *Batch API* helper for bulk word lookups (file-based path).
//
// Single-call lookups live in ./gemini.ts. Batch is ~50% cheaper but async
// (minutes–hours, 48h SLA). We use the FILE-BASED workflow: a JSONL of N
// requests is uploaded via the Files API, then referenced by a batch job. The
// inline path caps at 20 MB; the Hyouka lookup prompt is ~700+ tokens each, so
// 10k requests (~30 MB) overflows inline — file-based supports up to 2 GB.
//
// Flow: buildBatchJsonl → submitLookupBatch (upload + create) → pollLookupBatch
// (until succeeded) → fetchLookupBatchResults (download + parse).
//
// Endpoints (all need header `x-goog-api-key`):
//   POST  https://generativelanguage.googleapis.com/upload/v1beta/files            (resumable upload)
//   POST  https://generativelanguage.googleapis.com/v1beta/models/<model>:batchGenerateContent
//   GET   https://generativelanguage.googleapis.com/v1beta/<batchName>
//   GET   https://generativelanguage.googleapis.com/download/v1beta/<file>:download?alt=media
//   POST  https://generativelanguage.googleapis.com/v1beta/<batchName>:cancel

import { loadSecrets } from "./env.ts";
import { WORD_SCHEMA, type WordLookup } from "./gemini.ts";

const MODEL = "gemini-3.1-flash-lite";
const BASE = "https://generativelanguage.googleapis.com";
const UPLOAD_URL = `${BASE}/upload/v1beta/files`;
const BATCH_CREATE_URL = `${BASE}/v1beta/models/${MODEL}:batchGenerateContent`;
const DISPLAY_NAME = "zr-word-lookup";

// --- public types ---

/** One request line: a stable key (for re-aligning results) and its prompt. */
export type BatchItem = { key: string; prompt: string };

/** Lowercased batch lifecycle state (mapped from the API's JOB_STATE_* enum). */
export type BatchState =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired";

// --- retry / backoff (same spirit as gemini.ts: timeout + 429/5xx backoff) ---

const RETRY_BACKOFF_MS = [2_000, 5_000, 15_000, 40_000]; // 4 retries, 5 attempts
const MAX_RETRY_DELAY_MS = 60_000;
const REQUEST_TIMEOUT_MS = 120_000; // generous: uploads can be large

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

class RetryableHttpError extends Error {
  constructor(message: string, readonly retryAfterMs?: number) {
    super(message);
  }
}

/** Parse a Retry-After header (delta-seconds or HTTP-date) into ms, else undefined. */
function parseRetryAfter(headerVal: string | null): number | undefined {
  if (!headerVal) return undefined;
  const secs = Number(headerVal);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(headerVal);
  if (Number.isFinite(when)) return Math.max(0, when - Date.now());
  return undefined;
}

/**
 * fetch with timeout + retry on transient (429/5xx) and network/timeout errors.
 * Non-retryable HTTP errors (other 4xx) throw immediately with the body text.
 * Returns the raw Response (caller decides json/text/bytes).
 */
async function fetchRetry(url: string, init: RequestInit): Promise<Response> {
  for (let i = 0; ; i++) {
    try {
      const resp = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!resp.ok) {
        const errText = await resp.text();
        const msg = `Gemini batch API error ${resp.status}: ${errText}`;
        if (isRetryableStatus(resp.status)) {
          throw new RetryableHttpError(msg, parseRetryAfter(resp.headers.get("retry-after")));
        }
        throw new Error(msg); // fatal 4xx — fail fast
      }
      return resp;
    } catch (err) {
      const last = i >= RETRY_BACKOFF_MS.length;
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

async function apiKey(): Promise<string> {
  const { geminiApiKey } = await loadSecrets();
  if (!geminiApiKey) throw new Error("GEMINI_API_KEY not set in ~/.env");
  return geminiApiKey;
}

// --- JSONL builder (pure, unit-testable) ---

/**
 * Build the batch input as JSONL — one request per line. Each line carries the
 * stable `key` (echoed back in results so we can re-align) and a `request` with
 * JSON-mode generation constrained to WORD_SCHEMA. Returns the full JSONL text
 * (newline-separated, no trailing newline). Pure: no I/O, exported for tests.
 */
export function buildBatchJsonl(items: BatchItem[]): string {
  return items
    .map((it) =>
      JSON.stringify({
        key: it.key,
        request: {
          contents: [{ parts: [{ text: it.prompt }] }],
          generation_config: {
            response_mime_type: "application/json",
            response_schema: WORD_SCHEMA,
          },
        },
      }),
    )
    .join("\n");
}

// --- submit: upload JSONL via Files API, then create the batch job ---

/**
 * Upload `jsonl` bytes via the resumable Files API and return the file resource
 * name (e.g. "files/abc123"). Two-step: a `start` request returns an upload URL
 * in the `x-goog-upload-url` response header; the `upload, finalize` request
 * sends the bytes and returns the file resource.
 */
async function uploadJsonl(jsonl: string): Promise<string> {
  const key = await apiKey();
  const bytes = Buffer.from(jsonl, "utf-8");
  const numBytes = String(bytes.byteLength);

  // 1. start resumable upload
  const startResp = await fetchRetry(UPLOAD_URL, {
    method: "POST",
    headers: {
      "x-goog-api-key": key,
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": numBytes,
      "X-Goog-Upload-Header-Content-Type": "application/jsonl",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ file: { display_name: DISPLAY_NAME } }),
  });
  const uploadUrl =
    startResp.headers.get("x-goog-upload-url") ?? startResp.headers.get("X-Goog-Upload-URL");
  if (!uploadUrl) throw new Error("Files API: no x-goog-upload-url header in start response");

  // 2. upload bytes + finalize
  const upResp = await fetchRetry(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Length": numBytes,
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize",
    },
    body: bytes,
  });
  const data = (await upResp.json()) as { file?: { name?: string; uri?: string } };
  const name = data.file?.name;
  if (!name) throw new Error(`Files API: no file.name in upload response: ${JSON.stringify(data)}`);
  return name;
}

/**
 * Submit a word-lookup batch: builds JSONL, uploads it, creates the batch job.
 * Returns the batch resource name ("batches/{id}") for polling and the uploaded
 * input file name. Throws on any hard failure.
 */
export async function submitLookupBatch(
  items: BatchItem[],
): Promise<{ batchName: string; fileName: string }> {
  if (items.length === 0) throw new Error("submitLookupBatch: no items");
  const key = await apiKey();

  const fileName = await uploadJsonl(buildBatchJsonl(items));

  const resp = await fetchRetry(BATCH_CREATE_URL, {
    method: "POST",
    headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      batch: {
        display_name: DISPLAY_NAME,
        input_config: { file_name: fileName },
      },
    }),
  });
  const data = (await resp.json()) as { name?: string };
  if (!data.name) throw new Error(`batchGenerateContent: no batch name: ${JSON.stringify(data)}`);
  return { batchName: data.name, fileName };
}

// --- poll ---

const STATE_MAP: Record<string, BatchState> = {
  JOB_STATE_PENDING: "pending",
  JOB_STATE_RUNNING: "running",
  JOB_STATE_SUCCEEDED: "succeeded",
  JOB_STATE_FAILED: "failed",
  JOB_STATE_CANCELLED: "cancelled",
  JOB_STATE_EXPIRED: "expired",
};

/** Map a JOB_STATE_* enum (or unknown) to our lowercase union; unknown → pending. */
function mapState(raw: string | undefined): BatchState {
  return (raw && STATE_MAP[raw]) || "pending";
}

/**
 * Poll a batch's status once. Returns the mapped state, the results file name
 * once SUCCEEDED (`dest.fileName`, checked both at top level and under
 * `metadata`/`response` to be robust to envelope variations), and the raw body.
 */
export async function pollLookupBatch(
  batchName: string,
): Promise<{ state: BatchState; destFileName?: string; raw?: unknown }> {
  const key = await apiKey();
  const resp = await fetchRetry(`${BASE}/v1beta/${batchName}`, {
    method: "GET",
    headers: { "x-goog-api-key": key },
  });
  const raw = (await resp.json()) as Record<string, unknown>;

  // State and dest can live at the top level or wrapped in metadata/response.
  const envelopes = [raw, raw.metadata, raw.response].filter(
    (o): o is Record<string, unknown> => !!o && typeof o === "object",
  );
  let stateRaw: string | undefined;
  let destFileName: string | undefined;
  for (const env of envelopes) {
    if (!stateRaw && typeof env.state === "string") stateRaw = env.state;
    const dest = env.dest as { fileName?: string; file_name?: string } | undefined;
    if (!destFileName && dest) destFileName = dest.fileName ?? dest.file_name;
  }

  return { state: mapState(stateRaw), destFileName, raw };
}

// --- fetch results ---

/** Shape of a GenerateContentResponse we care about (the JSON-mode text part). */
type GenResponse = {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
};

/** One parsed results line: a key plus either the lookup or an error message. */
type BatchResult = { key: string; result?: WordLookup; error?: string };

/**
 * Download the results JSONL and parse each line into { key, result | error }.
 * Each line is `{"key":..., "response": <GenerateContentResponse>}` on success,
 * or carries an `error`/`status` object on failure. Throws only on download or
 * top-level JSON failures; per-line problems surface as that line's `error`.
 */
export async function fetchLookupBatchResults(destFileName: string): Promise<BatchResult[]> {
  const key = await apiKey();
  const resp = await fetchRetry(
    `${BASE}/download/v1beta/${destFileName}:download?alt=media`,
    { method: "GET", headers: { "x-goog-api-key": key } },
  );
  const text = await resp.text();

  const out: BatchResult[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: {
      key?: string;
      response?: GenResponse;
      error?: unknown;
      status?: unknown;
    };
    try {
      obj = JSON.parse(trimmed);
    } catch {
      out.push({ key: "", error: `unparseable results line: ${trimmed.slice(0, 200)}` });
      continue;
    }
    const k = obj.key ?? "";
    const errObj = obj.error ?? obj.status;
    if (errObj) {
      out.push({ key: k, error: errMsg(errObj) });
      continue;
    }
    const partText = obj.response?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!partText) {
      out.push({ key: k, error: "no candidate text in response" });
      continue;
    }
    try {
      const cleaned = partText.replace(/^```json\s*/, "").replace(/```\s*$/, "").trim();
      out.push({ key: k, result: JSON.parse(cleaned) as WordLookup });
    } catch (e) {
      out.push({ key: k, error: `bad JSON in response text: ${(e as Error).message}` });
    }
  }
  return out;
}

function errMsg(err: unknown): string {
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string") return m;
    return JSON.stringify(err);
  }
  return String(err);
}

// --- cancel (best-effort) ---

/** Request cancellation of a running batch. Best-effort: swallows failures. */
export async function cancelLookupBatch(batchName: string): Promise<void> {
  try {
    const key = await apiKey();
    await fetchRetry(`${BASE}/v1beta/${batchName}:cancel`, {
      method: "POST",
      headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
      body: "{}",
    });
  } catch {
    // best-effort: a failed cancel must not crash the caller
  }
}

// --- pricing / cost estimation ---

// Batch-tier rates for gemini-3.1-flash-lite (USD per 1M tokens). Batch is
// ~half the interactive price; update if Google revises the price sheet.
export const BATCH_INPUT_USD_PER_1M = 0.125;
export const BATCH_OUTPUT_USD_PER_1M = 0.75;

/**
 * Rough USD cost for a word-lookup batch. Defaults assume the leaner Hyouka
 * lookup prompt (~560 input tokens) and a compact JSON answer (~130 output
 * tokens) per word. Estimate only — actual billing is on real token counts.
 */
export function estimateBatchCostUsd(
  wordCount: number,
  avgInputTokens = 560,
  avgOutputTokens = 130,
): number {
  const inputCost = (wordCount * avgInputTokens * BATCH_INPUT_USD_PER_1M) / 1_000_000;
  const outputCost = (wordCount * avgOutputTokens * BATCH_OUTPUT_USD_PER_1M) / 1_000_000;
  return inputCost + outputCost;
}
