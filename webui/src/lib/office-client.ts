import { getServicesHttpBase } from "@/lib/api";
import { httpFetch } from "@/lib/tauri";
import type {
  DocumentVersion,
  OfficeCheckpointReceipt,
  OfficeExportRequest,
  OfficeEngineRangeRequest,
  OfficeSaveRequest,
  OfficeSessionCreateRequest,
  OfficeSessionState,
  OfficeSocketTicketRequest,
  OfficeSocketTicketResponse,
} from "@/components/office/types";

const OWNER_HEADER = "X-Mona-Session-Key";

export class OfficeClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

async function officeRequest<T>(
  path: string,
  ownerSessionKey: string,
  init?: RequestInit,
): Promise<T> {
  const base = await getServicesHttpBase();
  if (!base) throw new OfficeClientError("EDITOR_UNAVAILABLE", "文档编辑服务未启动。", true);
  const headers = new Headers(init?.headers);
  headers.set(OWNER_HEADER, ownerSessionKey);
  if (init?.body && !(init.body instanceof ArrayBuffer) && !ArrayBuffer.isView(init.body)) {
    headers.set("Content-Type", "application/json");
  }
  const response = await httpFetch(`${base}${path}`, { ...init, headers });
  if (response.ok) {
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }
  let payload: { error?: { code?: string; message?: string; retryable?: boolean } } = {};
  try {
    payload = await response.json();
  } catch {
    // The structured fallback below remains actionable without exposing response bodies.
  }
  throw new OfficeClientError(
    payload.error?.code ?? "EDITOR_UNAVAILABLE",
    payload.error?.message ?? `文档编辑请求失败（${response.status}）`,
    payload.error?.retryable ?? response.status >= 500,
  );
}

export async function createOfficeSession(
  request: OfficeSessionCreateRequest,
): Promise<OfficeSessionState> {
  return officeRequest("/api/office/sessions", request.ownerSessionKey, {
    method: "POST",
    body: JSON.stringify(request),
  });
}

export async function importOfficeSession(
  request: { filename: string; sourceIdentity: string; ownerSessionKey: string },
  file: ArrayBuffer,
): Promise<OfficeSessionState> {
  const query = new URLSearchParams({
    filename: request.filename,
    sourceIdentity: request.sourceIdentity,
  });
  return officeRequest(`/api/office/import?${query}`, request.ownerSessionKey, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: file,
  });
}

export async function getOfficeSession(
  sessionId: string,
  ownerSessionKey: string,
): Promise<OfficeSessionState> {
  return officeRequest(`/api/office/sessions/${encodeURIComponent(sessionId)}`, ownerSessionKey);
}

export async function getOfficeWorkingFile(
  sessionId: string,
  ownerSessionKey: string,
): Promise<ArrayBuffer> {
  const base = await getServicesHttpBase();
  if (!base) throw new OfficeClientError("EDITOR_UNAVAILABLE", "文档编辑服务未启动。", true);
  const response = await httpFetch(
    `${base}/api/office/sessions/${encodeURIComponent(sessionId)}/file`,
    { headers: { [OWNER_HEADER]: ownerSessionKey } },
  );
  if (!response.ok) throw new OfficeClientError("CHECKPOINT_FAILED", "无法读取文档工作副本。", true);
  return response.arrayBuffer();
}

export async function createOfficeSocketTicket(
  sessionId: string,
  ownerSessionKey: string,
  request: OfficeSocketTicketRequest,
): Promise<OfficeSocketTicketResponse> {
  return officeRequest(
    `/api/office/sessions/${encodeURIComponent(sessionId)}/socket-ticket`,
    ownerSessionKey,
    { method: "POST", body: JSON.stringify(request) },
  );
}

export async function openOfficeEngine(
  sessionId: string,
  ownerSessionKey: string,
): Promise<unknown> {
  return officeRequest(
    `/api/office/sessions/${encodeURIComponent(sessionId)}/engine/open`,
    ownerSessionKey,
    { method: "POST" },
  );
}

export async function readOfficeEngineRange(
  sessionId: string,
  ownerSessionKey: string,
  request: OfficeEngineRangeRequest,
): Promise<unknown> {
  return officeRequest(
    `/api/office/sessions/${encodeURIComponent(sessionId)}/engine/range`,
    ownerSessionKey,
    { method: "POST", body: JSON.stringify(request) },
  );
}

export async function uploadOfficeCheckpoint(
  sessionId: string,
  ownerSessionKey: string,
  version: DocumentVersion,
  file: ArrayBuffer,
): Promise<OfficeCheckpointReceipt> {
  const digest = await crypto.subtle.digest("SHA-256", file);
  const sha256 = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
  const upload = await officeRequest<{ uploadId: string; chunkBytes: number }>(
    `/api/office/sessions/${encodeURIComponent(sessionId)}/checkpoint-uploads`,
    ownerSessionKey,
    {
      method: "POST",
      body: JSON.stringify({ version, size: file.byteLength, sha256 }),
    },
  );
  for (let offset = 0; offset < file.byteLength; offset += upload.chunkBytes) {
    const chunk = file.slice(offset, Math.min(file.byteLength, offset + upload.chunkBytes));
    await officeRequest(
      `/api/office/checkpoint-uploads/${encodeURIComponent(upload.uploadId)}?offset=${offset}`,
      ownerSessionKey,
      {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: chunk,
      },
    );
  }
  return officeRequest(
    `/api/office/checkpoint-uploads/${encodeURIComponent(upload.uploadId)}/finish`,
    ownerSessionKey,
    { method: "POST" },
  );
}

export async function saveOfficeSession(
  sessionId: string,
  ownerSessionKey: string,
  request: OfficeSaveRequest,
): Promise<{ ok: true; fileName: string; version: DocumentVersion }> {
  return officeRequest(
    `/api/office/sessions/${encodeURIComponent(sessionId)}/save`,
    ownerSessionKey,
    { method: "POST", body: JSON.stringify(request) },
  );
}

export async function exportOfficeSession(
  sessionId: string,
  ownerSessionKey: string,
  request: OfficeExportRequest,
): Promise<{ ok: true; fileName: string; version: DocumentVersion }> {
  return officeRequest(
    `/api/office/sessions/${encodeURIComponent(sessionId)}/export`,
    ownerSessionKey,
    { method: "POST", body: JSON.stringify(request) },
  );
}

export async function closeOfficeSession(
  sessionId: string,
  ownerSessionKey: string,
): Promise<void> {
  await officeRequest(
    `/api/office/sessions/${encodeURIComponent(sessionId)}`,
    ownerSessionKey,
    { method: "DELETE" },
  );
}

export async function getOfficeSocketUrl(ticket: string): Promise<string> {
  const base = await getServicesHttpBase();
  if (!base) throw new OfficeClientError("EDITOR_UNAVAILABLE", "文档编辑服务未启动。", true);
  const url = new URL("/api/office/ws", base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("ticket", ticket);
  return url.toString();
}
