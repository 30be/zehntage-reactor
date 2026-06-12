// Proxy to the anki-mcp /zehntage/* endpoints (same server as zehntage-chrome).

import { loadSecrets } from "./env.ts";

export interface AnkiCard {
  front: string;
  back: string;
  notes?: string;
  context?: string;
  /** data: URI, http(s) URL, or an upload-dir path returned by uploadImage(). */
  image?: string;
  /** Field the image renders into on the card (default "notes" server-side). */
  image_field?: string;
  [key: string]: unknown;
}

async function ankiBase(): Promise<{ base: string; key: string }> {
  const { ankiUrl, ankiKey } = await loadSecrets();
  if (!ankiUrl || !ankiKey) {
    throw new Error("ZEHNTAGE_ANKI_URL or ZEHNTAGE_ANKI_KEY not set in ~/.env");
  }
  return { base: ankiUrl, key: ankiKey };
}

/**
 * Upload raw image bytes to the anki-mcp unauthenticated `/upload` endpoint.
 * Returns the server-side path (under the upload dir) to pass as a card `image`,
 * so the frame becomes a real Anki media file instead of an inlined base64 blob.
 */
export async function uploadImage(
  bytes: Uint8Array,
  mimeType = "image/jpeg",
): Promise<string> {
  const { base } = await ankiBase();
  const resp = await fetch(`${base}/upload`, {
    method: "POST",
    headers: { "Content-Type": mimeType },
    body: bytes,
  });
  if (!resp.ok) {
    throw new Error(`anki-mcp upload error ${resp.status}: ${await resp.text()}`);
  }
  const data = (await resp.json()) as { ok?: boolean; path?: string };
  if (!data.path) throw new Error("anki-mcp upload returned no path");
  return data.path;
}

/**
 * Upload raw media bytes via multipart so the server keeps the file
 * EXTENSION (raw-body uploads of unknown MIME types get saved as ".bin",
 * and Anki clients pick the audio player by extension). Returns the
 * server-side upload path.
 */
export async function uploadMedia(
  bytes: Uint8Array,
  mimeType: string,
  filename: string,
): Promise<string> {
  const { base } = await ankiBase();
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: mimeType }), filename);
  const resp = await fetch(`${base}/upload`, { method: "POST", body: form });
  if (!resp.ok) {
    throw new Error(`anki-mcp upload error ${resp.status}: ${await resp.text()}`);
  }
  const data = (await resp.json()) as { ok?: boolean; path?: string };
  if (!data.path) throw new Error("anki-mcp upload returned no path");
  return data.path;
}

/**
 * Resolve the name an uploaded file gets in Anki's media collection
 * (e.g. "anki_388b19310d1f.mp3") so it can be referenced via Anki's
 * `[sound:...]` syntax. The add endpoint only imports media through its
 * `image` mode (rendering an <img> tag — wrong for audio) and the media
 * name is random, so we: add a throwaway card with the upload as `image`,
 * read the generated <img src="..."> back from /zehntage/list, then delete
 * the throwaway card. The media file itself stays in the collection.
 */
export async function resolveMediaName(uploadPath: string): Promise<string | null> {
  const front = `zr-tmp-media-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await addCard({ front, back: "tmp", image: uploadPath, image_field: "context" });
    const cards = await listWords();
    const tmp = cards.find((c) => c.front === front);
    const m = typeof tmp?.context === "string" ? tmp.context.match(/<img src="([^"]+)"/) : null;
    return m?.[1] ?? null;
  } catch {
    return null;
  } finally {
    await deleteCard(front).catch(() => {});
  }
}

async function zehntageRequest(
  path: string,
  method: "GET" | "POST",
  body?: unknown,
): Promise<unknown> {
  const { ankiUrl, ankiKey } = await loadSecrets();
  if (!ankiUrl || !ankiKey) {
    throw new Error("ZEHNTAGE_ANKI_URL or ZEHNTAGE_ANKI_KEY not set in ~/.env");
  }
  const headers: Record<string, string> = { "X-Zehntage-Key": ankiKey };
  const opts: RequestInit = { method, headers };
  if (method === "POST") {
    headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body ?? {});
  }
  const resp = await fetch(`${ankiUrl}${path}`, opts);
  if (!resp.ok) {
    throw new Error(`anki-mcp error ${resp.status}: ${await resp.text()}`);
  }
  return resp.json();
}

export async function listWords(): Promise<AnkiCard[]> {
  const list = await zehntageRequest("/zehntage/list", "GET");
  return Array.isArray(list) ? (list as AnkiCard[]) : [];
}

/** New endpoint; may not exist yet on the server — callers fall back gracefully. */
export async function getProgress(): Promise<Record<string, number> | null> {
  try {
    const data = await zehntageRequest("/zehntage/progress", "GET");
    return data && typeof data === "object" ? (data as Record<string, number>) : null;
  } catch {
    return null;
  }
}

export async function addCard(card: AnkiCard): Promise<void> {
  await zehntageRequest("/zehntage/add", "POST", card);
}

export async function deleteCard(front: string): Promise<void> {
  await zehntageRequest("/zehntage/delete", "POST", { front });
}
