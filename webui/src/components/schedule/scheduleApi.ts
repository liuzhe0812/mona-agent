/** Schedule API client — calls /api/schedule/* on the gateway HTTP server. */

import { getGatewayHttpBase } from "@/lib/api";
import { httpFetch } from "@/lib/tauri";
import type { ScheduleItem, ScheduleItemInput, ScheduleItemListResponse } from "./types";

async function _jsonRequest<T>(
  path: string,
  init: RequestInit,
): Promise<T> {
  const base = await getGatewayHttpBase();
  if (!base) {
    throw new Error("Gateway 未就绪，请稍后重试");
  }
  const url = `${base}${path}`;
  let res: Response;
  try {
    res = await httpFetch(url, init);
  } catch (err) {
    throw new Error(
      `请求失败: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
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
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new Error(`Gateway 返回了非 JSON 响应 (${contentType})`);
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

// ---------------------------------------------------------------------------
// 邮件 AI 日程提取 - 待确认列表
// ---------------------------------------------------------------------------

/** 待确认的邮件提取日程项（来自 gateway /api/email/schedule/pending） */
export interface PendingScheduleItem {
  id: string;
  item: ScheduleItem;
  emailSubject: string;
  emailFrom: string;
  emailUid: string;
  emailAccountId: string;
  emailFolder: string;
  createdAtMs: number;
}

export interface PendingScheduleListResponse {
  items: PendingScheduleItem[];
}

/** 获取待确认的邮件提取日程列表。 */
export async function listPendingSchedules(): Promise<PendingScheduleItem[]> {
  const data = await _jsonRequest<PendingScheduleListResponse>(
    `/api/email/schedule/pending`,
    { method: "GET" },
  );
  return data.items;
}

/** 确认创建待确认的日程。返回确认后的日程项（已写入 schedule store）。 */
export async function confirmPendingSchedule(
  id: string,
): Promise<{ ok: boolean }> {
  return _jsonRequest<{ ok: boolean }>(`/api/email/schedule/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
}

/** 丢弃待确认的日程。 */
export async function discardPendingSchedule(
  id: string,
): Promise<{ ok: boolean }> {
  return _jsonRequest<{ ok: boolean }>(`/api/email/schedule/discard`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
}
