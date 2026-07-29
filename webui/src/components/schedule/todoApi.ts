/** Todo API client — calls /api/schedule/todos/* on the services process. */

import { getServicesHttpBase } from "@/lib/api";
import { httpFetch } from "@/lib/tauri";
import type {
  TodoBriefing,
  TodoFromEmailInput,
  TodoItem,
  TodoItemInput,
  TodoItemListResponse,
  TodoState,
} from "./todoTypes";

async function _jsonRequest<T>(
  path: string,
  init: RequestInit,
): Promise<T> {
  const base = await getServicesHttpBase();
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

export async function listTodos(
  state?: TodoState,
  bucket?: string,
  sourceType?: string,
): Promise<TodoItem[]> {
  const params = new URLSearchParams();
  if (state != null) params.set("state", state);
  if (bucket != null) params.set("bucket", bucket);
  if (sourceType != null) params.set("sourceType", sourceType);
  const qs = params.toString();
  const data = await _jsonRequest<TodoItemListResponse>(
    `/api/schedule/todos${qs ? `?${qs}` : ""}`,
    { method: "GET" },
  );
  return data.items;
}

export async function getTodo(id: string): Promise<TodoItem | null> {
  try {
    return await _jsonRequest<TodoItem>(`/api/schedule/todos/${id}`, {
      method: "GET",
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes("not found")) return null;
    throw err;
  }
}

export async function createTodo(input: TodoItemInput): Promise<TodoItem> {
  return _jsonRequest<TodoItem>(`/api/schedule/todos`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function updateTodo(
  id: string,
  patch: Record<string, unknown>,
): Promise<TodoItem> {
  return _jsonRequest<TodoItem>(`/api/schedule/todos/${id}/update`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}

export async function removeTodo(id: string): Promise<void> {
  await _jsonRequest<{ ok: boolean }>(`/api/schedule/todos/${id}/remove`, {
    method: "POST",
  });
}

export async function createTodoFromEmail(
  input: TodoFromEmailInput,
): Promise<TodoItem> {
  return _jsonRequest<TodoItem>(`/api/schedule/todos/from-email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function arrangeTodoOnCalendar(
  id: string,
  startAtMs: number,
  endAtMs?: number,
  allDay?: boolean,
): Promise<{ scheduleId: string; todoId: string }> {
  return _jsonRequest<{ scheduleId: string; todoId: string }>(
    `/api/schedule/todos/${id}/to-schedule`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ startAtMs, endAtMs, allDay }),
    },
  );
}

export async function getBriefing(): Promise<TodoBriefing> {
  return _jsonRequest<TodoBriefing>(`/api/schedule/briefing`, {
    method: "GET",
  });
}
