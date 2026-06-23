/** Schedule API client — calls /api/schedule/* on the gateway HTTP server. */

import { getGatewayHttpBase } from "@/lib/api";
import { httpFetch } from "@/lib/tauri";
import type { ScheduleItem, ScheduleItemInput, ScheduleItemListResponse } from "./types";

async function _jsonRequest<T>(
  path: string,
  init: RequestInit,
): Promise<T> {
  const base = await getGatewayHttpBase();
  const res = await httpFetch(`${base}${path}`, init);
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
    } catch {
      // ignore
    }
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

export async function listScheduleItems(
  fromMs?: number,
  toMs?: number,
): Promise<ScheduleItem[]> {
  const params = new URLSearchParams();
  if (fromMs != null) params.set("from", String(fromMs));
  if (toMs != null) params.set("to", String(toMs));
  const qs = params.toString();
  const data = await _jsonRequest<ScheduleItemListResponse>(
    `/api/schedule/items${qs ? `?${qs}` : ""}`,
    { method: "GET" },
  );
  return data.items;
}

export async function getScheduleItem(id: string): Promise<ScheduleItem | null> {
  try {
    return await _jsonRequest<ScheduleItem>(`/api/schedule/items/${id}`, { method: "GET" });
  } catch (err) {
    if (err instanceof Error && err.message.includes("not found")) return null;
    throw err;
  }
}

export async function createScheduleItem(
  input: ScheduleItemInput,
): Promise<ScheduleItem> {
  return _jsonRequest<ScheduleItem>(`/api/schedule/items`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function updateScheduleItem(
  id: string,
  input: ScheduleItemInput,
): Promise<ScheduleItem> {
  return _jsonRequest<ScheduleItem>(`/api/schedule/items/${id}/update`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function removeScheduleItem(id: string): Promise<void> {
  await _jsonRequest<{ ok: boolean }>(`/api/schedule/items/${id}/remove`, {
    method: "POST",
  });
}

export async function completeScheduleItem(id: string): Promise<void> {
  await _jsonRequest<{ ok: boolean }>(`/api/schedule/items/${id}/complete`, {
    method: "POST",
  });
}

export async function toggleScheduleItem(
  id: string,
  enabled: boolean,
): Promise<void> {
  await _jsonRequest<{ ok: boolean }>(`/api/schedule/items/${id}/toggle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
}
