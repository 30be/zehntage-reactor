// Proxy to the anki-mcp /zehntage/* endpoints (same server as zehntage-chrome).

import { loadSecrets } from "./env.ts";

export interface AnkiCard {
  front: string;
  back: string;
  notes?: string;
  context?: string;
  image?: string;
  [key: string]: unknown;
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
