// Shared request-parsing / response-shaping helpers for the HTTP server.
// Behavior-preserving extractions of patterns repeated across index.ts routes.

/** Parse the JSON body, returning `fallback` on any parse error (the common
 * `await req.json().catch(() => ({}))` shape used by tolerant POST routes). */
export async function bodyJson<T>(req: Request, fallback: T): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    return fallback;
  }
}

/** Trimmed query param (`url.searchParams.get(name) ?? "").trim()`). */
export function q(url: URL, name: string): string {
  return (url.searchParams.get(name) ?? "").trim();
}

/** Comma-split query param into a deduped, trimmed, non-empty token list. */
export function qList(url: URL, name: string): string[] {
  return (url.searchParams.get(name) ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Content-Disposition attachment header value for a download filename. */
export function attachment(filename: string): string {
  return `attachment; filename="${filename}"`;
}
