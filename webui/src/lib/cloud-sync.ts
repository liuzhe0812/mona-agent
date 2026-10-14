import { getGatewayHttpBase } from "@/lib/api";
import { httpFetch } from "@/lib/tauri";

export interface CloudCandidate { key: string; title: string }
export interface CloudStatus {
  available: boolean; enabled: boolean; phase: string;
  plan?: "free" | "pro";
  space?: { quota_bytes: number; used_bytes: number; reserved_bytes: number; object_count: number } | null;
  needs_key?: boolean;
  problem?: { code: string; message: string } | null;
  last_sync?: number | null; transferred_bytes?: number;
  selected_keys?: string[]; candidates?: CloudCandidate[];
  sync_new_conversations?: boolean;
  sync_planning?: boolean;
  sync_notes?: boolean;
  sync_preferences?: boolean;
  conversations?: CloudConversation[];
}
export interface CloudDraft { draft_id: string; new_space: boolean; candidates: CloudCandidate[] }
export interface CloudConversation { key: string; resource_id: string; version: number; conflict_copy: boolean; trashed?: boolean }
export interface CloudHistoryVersion { version: number; created_at: string; deleted: boolean }
export interface CloudHistoryPage { items: CloudHistoryVersion[]; has_more: boolean; next_before: number }
export interface CloudFile { id: string; name: string; size: number; local: boolean }
export interface CloudRestoreResult { restored: true; key: string; reused: boolean }
export interface CloudCleanupPreview {
  draft_id: string | null; count: number; bytes: number; has_more: boolean;
  expires_at: number; minimum_age_seconds: number;
}
export interface CloudCleanupResult {
  complete: boolean; removed: number; already_removed: number; retained: number;
  failed: number; pending: number; released_bytes: number;
}

export interface CloudRetentionPreview {
  draft_id: string | null; count: number; retention_days: number; has_more: boolean; expires_at: number;
}
export interface CloudRetentionResult {
  complete: true; retired: number; already_retired: number; retained: number; released_bytes: 0;
}

export type CloudTrashAction = "trash" | "restore" | "purge";
export type CloudTrashKind = "work_conversation" | "note" | "todo" | "calendar_event";
export interface CloudTrashItem { resource_id: string; kind: CloudTrashKind; version: number; title: string; deleted_at: string; recoverable: boolean }
export interface CloudTrashPage { items: CloudTrashItem[]; next_before: number; has_more: boolean }
export interface CloudTrashDraft { draft_id: string; resource_id: string; kind: CloudTrashKind; version: number; action: CloudTrashAction; expires_at: number }
export interface CloudTrashResult { complete: true; resource_id: string; kind: CloudTrashKind; version: number; action: CloudTrashAction; reused: boolean; released_bytes: 0 }
const trashKinds = ["work_conversation", "note", "todo", "calendar_event"];

const id32 = /^[a-f0-9]{32}$/;
const id64 = /^[a-f0-9]{64}$/;
const workKey = /^websocket:[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
function invalidResponse(): never { throw new CloudSyncError("invalid_response", "云端记录返回异常，请刷新后重试。"); }
function requireResource(value: string) {
  if (!id32.test(value)) throw new CloudSyncError("invalid_resource", "请选择有效的云会话。");
}
async function readHistory(resource_id: string, before = 2_147_483_647, signal?: AbortSignal): Promise<CloudHistoryPage> {
  requireResource(resource_id);
  if (!Number.isSafeInteger(before) || before < 1 || before > 2_147_483_647) invalidResponse();
  const data = await request<CloudHistoryPage>("history", "POST", { resource_id, before }, signal);
  if (!Array.isArray(data.items) || data.items.length > 50 || typeof data.has_more !== "boolean"
    || !Number.isSafeInteger(data.next_before) || data.next_before < 1 || data.next_before > before) invalidResponse();
  let previous = before;
  for (const item of data.items) {
    if (!item || !Number.isSafeInteger(item.version) || item.version < 1 || item.version >= previous
      || typeof item.deleted !== "boolean" || typeof item.created_at !== "string" || !Number.isFinite(Date.parse(item.created_at))) invalidResponse();
    previous = item.version;
  }
  if (data.has_more && (!data.items.length || data.next_before !== previous)) invalidResponse();
  return data;
}
async function readFiles(resource_id: string, signal?: AbortSignal): Promise<CloudFile[]> {
  requireResource(resource_id);
  const data = await request<{ files: CloudFile[] }>("files", "POST", { resource_id }, signal);
  if (!Array.isArray(data.files) || data.files.length > 2048) invalidResponse();
  const seen = new Set<string>();
  for (const file of data.files) {
    if (!file || typeof file.id !== "string" || !id64.test(file.id) || seen.has(file.id)
      || typeof file.name !== "string" || !file.name || file.name.length > 2048
      || typeof file.local !== "boolean" || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > 10_000_000_000) invalidResponse();
    seen.add(file.id);
  }
  return data.files;
}
async function downloadFile(resource_id: string, file_id: string): Promise<void> {
  requireResource(resource_id);
  if (!id64.test(file_id)) invalidResponse();
  const data = await request<{ downloaded: boolean; file_id: string }>("download", "POST", { resource_id, file_id });
  if (data.downloaded !== true || data.file_id !== file_id) invalidResponse();
}
async function restoreVersion(resource_id: string, version: number, request_id: string): Promise<CloudRestoreResult> {
  requireResource(resource_id);
  if (!Number.isSafeInteger(version) || version < 1 || version > 2_000_000_000 || !id32.test(request_id)) invalidResponse();
  const data = await request<CloudRestoreResult>("restore", "POST", { resource_id, version, request_id, confirmed: true });
  if (data.restored !== true || typeof data.key !== "string" || !workKey.test(data.key) || typeof data.reused !== "boolean") invalidResponse();
  return data;
}

async function readTrash(before = Number.MAX_SAFE_INTEGER, signal?: AbortSignal): Promise<CloudTrashPage> {
  if (!Number.isSafeInteger(before) || before < 1) invalidResponse();
  const data = await request<CloudTrashPage>("trash", "POST", { before }, signal);
  if (!data || !Array.isArray(data.items) || data.items.length > 10 || typeof data.has_more !== "boolean"
    || !Number.isSafeInteger(data.next_before) || data.next_before < 1 || data.next_before > before
    || data.has_more && data.items.length !== 10 || data.items.length > 0 && data.next_before >= before
    || !data.items.length && data.next_before !== before) invalidResponse();
  const seen = new Set<string>();
  for (const item of data.items) {
    if (!item || typeof item.resource_id !== "string" || !id32.test(item.resource_id) || seen.has(item.resource_id)
      || !trashKinds.includes(item.kind) || !Number.isSafeInteger(item.version) || item.version < 1 || item.version > 2_000_000_000
      || typeof item.title !== "string" || !item.title || item.title.length > 4096
      || typeof item.recoverable !== "boolean" || typeof item.deleted_at !== "string" || !Number.isFinite(Date.parse(item.deleted_at))) invalidResponse();
    seen.add(item.resource_id);
  }
  return data;
}
async function previewTrash(resource_id: string, version: number, action: CloudTrashAction): Promise<CloudTrashDraft> {
  requireResource(resource_id);
  if (!Number.isSafeInteger(version) || version < 1 || version > 2_000_000_000 || !["trash", "restore", "purge"].includes(action)) invalidResponse();
  const data = await request<CloudTrashDraft>("trash-preview", "POST", { resource_id, version, action });
  if (!data || typeof data.draft_id !== "string" || !id32.test(data.draft_id) || data.resource_id !== resource_id
    || data.version !== version || data.action !== action || !trashKinds.includes(data.kind)
    || !Number.isSafeInteger(data.expires_at) || data.expires_at <= 0) invalidResponse();
  return data;
}
async function applyTrash(draft: CloudTrashDraft): Promise<CloudTrashResult> {
  if (!draft || !id32.test(draft.draft_id) || !id32.test(draft.resource_id)
    || !Number.isSafeInteger(draft.version) || draft.version < 1 || draft.version > 2_000_000_000
    || !["trash", "restore", "purge"].includes(draft.action) || !trashKinds.includes(draft.kind)) invalidResponse();
  const data = await request<CloudTrashResult>("trash-apply", "POST", { draft_id: draft.draft_id, confirmed: true });
  if (!data || data.complete !== true || data.resource_id !== draft.resource_id || data.kind !== draft.kind
    || data.action !== draft.action || data.version !== draft.version + (draft.action === "purge" ? 0 : 1)
    || typeof data.reused !== "boolean" || data.released_bytes !== 0) invalidResponse();
  return data;
}

async function retentionPreview(signal?: AbortSignal): Promise<CloudRetentionPreview> {
  const data = await request<CloudRetentionPreview>("retention-preview", "POST", {}, signal);
  if (!data || !Number.isSafeInteger(data.count) || data.count < 0 || data.count > 50
    || !Number.isSafeInteger(data.retention_days) || data.retention_days < 1 || data.retention_days > 3650
    || typeof data.has_more !== "boolean" || data.has_more && data.count !== 50
    || !Number.isSafeInteger(data.expires_at) || data.expires_at <= 0
    || (data.count ? typeof data.draft_id !== "string" || !id32.test(data.draft_id) : data.draft_id !== null)) invalidResponse();
  return data;
}
async function retireHistory(draft_id: string): Promise<CloudRetentionResult> {
  if (!id32.test(draft_id)) invalidResponse();
  const data = await request<CloudRetentionResult>("retention", "POST", { draft_id, confirmed: true });
  const counts = [data?.retired, data?.already_retired, data?.retained];
  if (!data || data.complete !== true || data.released_bytes !== 0
    || counts.some((count) => !Number.isSafeInteger(count) || count < 0)
    || counts.reduce((a, b) => a + b, 0) < 1 || counts.reduce((a, b) => a + b, 0) > 50) invalidResponse();
  return data;
}

async function cleanupPreview(signal?: AbortSignal): Promise<CloudCleanupPreview> {
  const data = await request<CloudCleanupPreview>("cleanup-preview", "POST", {}, signal);
  if (!data || !Number.isSafeInteger(data.count) || data.count < 0 || data.count > 10
    || !Number.isSafeInteger(data.bytes) || data.bytes < 0 || data.bytes > data.count * 8 * 1024 * 1024
    || typeof data.has_more !== "boolean" || data.has_more && data.count !== 10
    || !Number.isSafeInteger(data.expires_at) || data.expires_at <= 0
    || !Number.isSafeInteger(data.minimum_age_seconds) || data.minimum_age_seconds < 3600
    || data.minimum_age_seconds > 604800
    || (data.count === 0 ? data.draft_id !== null : typeof data.draft_id !== "string" || !id32.test(data.draft_id))) invalidResponse();
  return data;
}
async function cleanupUploads(draft_id: string): Promise<CloudCleanupResult> {
  if (!id32.test(draft_id)) invalidResponse();
  const data = await request<CloudCleanupResult>("cleanup", "POST", { draft_id, confirmed: true });
  const counts = [data?.removed, data?.already_removed, data?.retained, data?.failed, data?.pending];
  if (!data || typeof data.complete !== "boolean" || counts.some((value) => !Number.isSafeInteger(value) || value < 0)
    || counts.reduce((sum, value) => sum + value, 0) < 1 || counts.reduce((sum, value) => sum + value, 0) > 10
    || data.complete !== (data.failed === 0 && data.pending === 0)
    || !Number.isSafeInteger(data.released_bytes) || data.released_bytes < 0 || data.released_bytes > data.removed * 8 * 1024 * 1024) invalidResponse();
  return data;
}

export async function ensureCloudFile(path: string, sessionKey?: string | null, signal?: AbortSignal): Promise<void> {
  const normalized = path.replaceAll("\\", "/");
  // Ordinary local opens never contact the account or cloud service.
  if (!/(?:^|\/)cloud\/[a-f0-9]{32}\/[a-f0-9]{64}\/[^/]+$/.test(normalized)) return;
  if (!(/^[a-z]:\//i.test(normalized) || normalized.startsWith("/")) || normalized.split("/").includes("..")) invalidResponse();
  if (sessionKey != null && !workKey.test(sessionKey)) invalidResponse();
  if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
  const data = await request<{ available: boolean }>("ensure-file", "POST", { path, session_key: sessionKey ?? null }, signal);
  if (!data || data.available !== true) throw new CloudSyncError("file_unavailable", "云端文件尚未下载完成，请稍后重试。");
}

export class CloudSyncError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = "CloudSyncError"; }
}
async function request<T>(path: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<T> {
  try {
    const response = await httpFetch(`${await getGatewayHttpBase()}/api/cloud-sync/${path}`, {
      method, signal, headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = response.headers.get("content-type")?.includes("application/json") ? await response.json() : null;
    if (!response.ok || !data) {
      throw new CloudSyncError(data?.error?.code ?? "service_unavailable",
        typeof data?.error?.message === "string" ? data.error.message : "云同步服务尚未就绪，请稍后重试。");
    }
    return data as T;
  } catch (error) {
    if (error instanceof CloudSyncError || error instanceof Error && error.name === "AbortError") throw error;
    throw new CloudSyncError("service_unavailable", "暂时无法连接云同步，请稍后重试。");
  }
}
export const cloudSyncApi = {
  trash: readTrash,
  previewTrash,
  applyTrash,
  retentionPreview,
  retireHistory,
  cleanupPreview,
  cleanup: cleanupUploads,
  status: (signal?: AbortSignal) => request<CloudStatus>("status", "GET", undefined, signal),
  prepare: (recovery?: string) => request<CloudDraft>("prepare", "POST", { recovery: recovery || null }),
  enable: (draft_id: string, session_keys: string[], sync_new_conversations?: boolean, sync_planning?: boolean, sync_notes?: boolean, sync_preferences?: boolean) => request<{ enabled: boolean }>("enable", "POST", { draft_id, session_keys, confirmed: true,
    ...(sync_new_conversations === undefined ? {} : { sync_new_conversations }),
    ...(sync_planning === undefined ? {} : { sync_planning }),
    ...(sync_notes === undefined ? {} : { sync_notes }),
    ...(sync_preferences === undefined ? {} : { sync_preferences }) }),
  scope: (session_keys: string[], sync_new_conversations?: boolean, sync_planning?: boolean, sync_notes?: boolean, sync_preferences?: boolean) => request<{ selected_keys: string[]; sync_new_conversations: boolean; sync_planning: boolean; sync_preferences: boolean }>("scope", "POST", { session_keys,
    ...(sync_new_conversations === undefined ? {} : { sync_new_conversations }),
    ...(sync_planning === undefined ? {} : { sync_planning }),
    ...(sync_notes === undefined ? {} : { sync_notes }),
    ...(sync_preferences === undefined ? {} : { sync_preferences }) }),
  pause: () => request<{ enabled: boolean }>("pause", "POST", {}),
  sync: () => request<{ scheduled: boolean }>("sync", "POST", {}),
  history: readHistory,
  files: readFiles,
  download: downloadFile,
  restore: restoreVersion,
};
