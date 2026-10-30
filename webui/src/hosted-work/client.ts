import { sha256 } from "@noble/hashes/sha2.js";

export type WorkModel = { id: string; label: string; source: string };
export type WorkSession = { id: string; title: string; created: number; updated: number };
export type WorkFile = { id: string; name: string; size: number; sha256: string };
export type TurnInput = { request_id: string; model_id: string; text: string; attachment_ids: string[] };
export type WorkRun = {
  id: string; session_id: string; status: string; input: TurnInput;
  result: { content?: string; message?: string; workspace_saved?: boolean };
};
export type SessionDetail = WorkSession & { runs: WorkRun[]; files: WorkFile[] };
export type WorkEvent = { seq: number; kind: string; data: { text?: string; message?: string; tools?: string[] } };
export type PendingTurn = { session_id: string; input: TurnInput };

export class WorkApiError extends Error {
  constructor(message: string, readonly status = 0, readonly code = "result_unknown") {
    super(message);
  }
}

export function newRequestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
}

async function checkedFetch(path: string, init: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(path, { ...init, credentials: "same-origin", redirect: "error", cache: "no-store" });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new WorkApiError("连接中断，操作结果尚未确认。请核对原请求，不要重复创建任务。");
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { message?: string; detail?: string; error?: string };
    const fallback = response.status === 401 ? "登录已失效，请重新登录。" : "操作未能完成，请稍后重试。";
    throw new WorkApiError(typeof body.message === "string" ? body.message : fallback, response.status,
      typeof body.error === "string" ? body.error : "request_failed");
  }
  return response;
}

export async function login(account: string, password: string): Promise<string> {
  const response = await checkedFetch("/api/work/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ account, password }),
  });
  const value = await response.json() as { access_token?: unknown; user?: { id?: unknown } };
  if (typeof value.access_token !== "string" || !value.access_token) {
    throw new WorkApiError("登录未返回有效结果，请重新登录。", 503, "invalid_login");
  }
  if (typeof value.user?.id === "string") sessionStorage.setItem("mona-website-session-v1", JSON.stringify({ token: value.access_token, user: value.user }));
  return value.access_token;
}

export class WorkClient {
  constructor(private readonly token: string) {}

  private headers(extra?: HeadersInit): Headers {
    const headers = new Headers(extra);
    headers.set("Authorization", `Bearer ${this.token}`);
    return headers;
  }

  private async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await checkedFetch(`/api/work${path}`, { ...init, headers: this.headers(init.headers) });
    return await response.json() as T;
  }

  async logout() {
    try { await this.json("/auth/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); }
    catch (error) { if (!(error instanceof WorkApiError) || error.status !== 401) throw error; }
  }

  models(signal?: AbortSignal) {
    return this.json<{ models: WorkModel[]; max_file_bytes: number }>("/models", { signal });
  }

  sessions(signal?: AbortSignal) {
    return this.json<{ sessions: WorkSession[] }>("/sessions", { signal });
  }

  createSession(id: string) {
    return this.json<WorkSession>("/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ request_id: id, title: "新任务" }),
    });
  }

  session(id: string, signal?: AbortSignal) {
    return this.json<SessionDetail>(`/sessions/${encodeURIComponent(id)}`, { signal });
  }

  submit(pending: PendingTurn) {
    return this.json<WorkRun>(`/sessions/${encodeURIComponent(pending.session_id)}/runs`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(pending.input),
    });
  }

  events(runId: string, after: number, signal?: AbortSignal) {
    return this.json<{ run: WorkRun; events: WorkEvent[]; has_more: boolean }>(
      `/runs/${encodeURIComponent(runId)}/events?after=${after}`, { signal });
  }

  stop(runId: string) {
    return this.json<WorkRun>(`/runs/${encodeURIComponent(runId)}/stop`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmed: true }),
    });
  }

  upload(sessionId: string, fileId: string, file: File) {
    return this.json<WorkFile>(`/sessions/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(fileId)}?name=${encodeURIComponent(file.name)}`, {
      method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: file,
    });
  }

  async download(sessionId: string, file: WorkFile) {
    const response = await checkedFetch(`/api/work/sessions/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(file.id)}`, {
      headers: this.headers(),
    });
    const data = await response.arrayBuffer();
    const digest = Array.from(sha256(new Uint8Array(data)), value => value.toString(16).padStart(2, "0")).join("");
    if (data.byteLength !== file.size || digest !== file.sha256) throw new WorkApiError("下载文件校验失败，请重新下载。", 409, "file_changed");
    return new Blob([data], { type: "application/octet-stream" });
  }
}
