/** Notes knowledge base API client — talks to Mona gateway HTTP server.

 * Routes are registered on the gateway aiohttp app (port 17173), so we use
 * `getGatewayHttpBase()` per the project's port architecture rules.
 */

import { getGatewayHttpBase } from "./api";
import { httpFetch } from "./tauri";

let _token = "";

export function setNotesKbToken(token: string) {
  _token = token;
}

async function fetchJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const base = await getGatewayHttpBase();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (_token) {
    headers["Authorization"] = `Bearer ${_token}`;
  }
  const resp = await httpFetch(`${base}${url}`, { headers, ...init });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: resp.statusText }));
    throw new Error(err.error ?? resp.statusText);
  }
  return resp.json();
}

export interface NotesEmbedResult {
  indexed: number;
  failed: number;
  skipped: number;
  lastError: string | null;
}

export interface NotesEmbedStatus {
  chunkCount: number;
  lastError: string | null;
}

export interface NotesSearchResultItem {
  path: string;
  title: string;
  type?: string;
  tags?: string[];
  snippet: string;
  score: number;
  vectorScore?: number;
}

export interface NotesSearchResult {
  mode: "keyword" | "vector" | "hybrid";
  results: NotesSearchResultItem[];
}

export interface EmbeddingConfigPayload {
  enabled: boolean;
  endpoint: string;
  apiKey: string;
  model: string;
  outputDimensionality?: number;
  maxChunkChars?: number;
  overlapChunkChars?: number;
  extraHeaders?: Record<string, string>;
}

/** POST /api/notes-kb/embed — index entire vault. */
export async function indexVault(
  vaultPath: string,
  config: EmbeddingConfigPayload,
): Promise<NotesEmbedResult> {
  return fetchJSON<NotesEmbedResult>("/api/notes-kb/embed", {
    method: "POST",
    body: JSON.stringify({ vaultPath, ...config }),
  });
}

/** GET /api/notes-kb/embed/status?vaultPath=... — get chunk count. */
export async function getVaultEmbedStatus(vaultPath: string): Promise<NotesEmbedStatus> {
  const params = new URLSearchParams({ vaultPath });
  return fetchJSON<NotesEmbedStatus>(`/api/notes-kb/embed/status?${params}`);
}

/** POST /api/notes-kb/search — hybrid search notes. */
export async function searchNotes(
  vaultPath: string,
  query: string,
  count = 10,
): Promise<NotesSearchResult> {
  return fetchJSON<NotesSearchResult>("/api/notes-kb/search", {
    method: "POST",
    body: JSON.stringify({ vaultPath, query, count }),
  });
}

/** GET /api/notes-kb/related/{noteId}?vaultPath=...&count=... — find related notes. */
export async function findRelatedNotes(
  vaultPath: string,
  noteId: string,
  count = 5,
): Promise<NotesSearchResult> {
  const params = new URLSearchParams({ vaultPath, count: String(count) });
  return fetchJSON<NotesSearchResult>(
    `/api/notes-kb/related/${encodeURIComponent(noteId)}?${params}`,
  );
}
