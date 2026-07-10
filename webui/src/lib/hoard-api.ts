/** Hoard API client — talks to Mona gateway HTTP server.
 *
 * Hoard is Agent's URL memory layer: browser star → auto-ingest (fetch + LLM summary/tags).
 * No management UI — hoard runs transparently. Only add/delete-by-url are exposed to frontend.
 *
 * Routes are registered on the gateway aiohttp app (port 17173), so we use
 * `getGatewayHttpBase()` per the project's port architecture rules.
 */

import { getGatewayHttpBase } from "./api";
import { httpFetch } from "./tauri";

async function fetchJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const base = await getGatewayHttpBase();
  const resp = await httpFetch(`${base}${url}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: resp.statusText }));
    throw new Error(err.error ?? resp.statusText);
  }
  return resp.json();
}

export interface HoardAddPayload {
  title: string;
  url?: string;
  content?: string;
  source?: string;
  sourceRef?: string;
  tags?: string[];
  sourceStrength?: number;
}

/** Add a URL to hoard (called on browser star click). */
export function hoardAdd(payload: HoardAddPayload): Promise<{ id: string; queued: boolean }> {
  return fetchJSON("/api/hoard", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

/** Remove hoard items by URL (called on browser star unclick). */
export function hoardDeleteByUrl(url: string): Promise<{ ok: boolean; url: string; deleted: number }> {
  const q = new URLSearchParams({ url });
  return fetchJSON(`/api/hoard-by-url?${q.toString()}`, { method: "DELETE" });
}
