/** Materials API client — talks to Mona gateway HTTP server.
 *
 * 资料库 HTTP 接口：目录、读取、删除、后台提取状态、Wiki 读写、搜索。
 * 路由注册在 gateway aiohttp app（端口 17173），按项目端口架构规则使用
 * `getGatewayHttpBase()`。
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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MaterialsExtractStatus {
  status: "pending" | "ok" | "error";
  truncated?: boolean;
  chars?: number;
  error?: string;
}

export interface MaterialsFileEntry {
  name: string;
  /** 相对于 materials 根的路径，如 "raw/docs/foo.pdf" */
  path: string;
  type: "directory" | "file";
  size?: number;
  mtime?: number;
  /** 目录下文件数（仅 directory） */
  fileCount?: number;
  /** 提取状态（仅 file） */
  extractStatus?: MaterialsExtractStatus;
}

export interface MaterialsTextContent {
  path: string;
  content: string;
}

export interface WikiPageSummary {
  path: string;
  title: string;
  id: string;
  sources?: string[];
  mtime: number;
}

export interface WikiPageDetail {
  path: string;
  content: string;
}

export interface MaterialsSearchResult {
  kind: "material_text" | "material_wiki";
  title: string;
  path: string;
  snippet: string;
  score: number;
  sources?: string[];
}

export interface MaterialsStatus {
  rawFiles: number;
  textFiles: number;
  wikiFiles: number;
  extract: {
    pending: number;
    ok: number;
    error: number;
  };
}

// ---------------------------------------------------------------------------
// Files (raw/)
// ---------------------------------------------------------------------------

/** 列出 raw 目录下所有文件（递归），含提取状态。 */
export async function listMaterialsFiles(subdir?: string): Promise<MaterialsFileEntry[]> {
  const q = subdir ? `?subdir=${encodeURIComponent(subdir)}` : "";
  const data = await fetchJSON<{ entries: MaterialsFileEntry[] }>(`/api/materials/files${q}`);
  return data.entries ?? [];
}

/** 在 raw 下创建子目录。 */
export function createMaterialsDirectory(path: string): Promise<{ created: string }> {
  return fetchJSON(`/api/materials/directory`, {
    method: "POST",
    body: JSON.stringify({ path }),
  });
}

/** 删除 raw 下的文件或目录。 */
export function deleteMaterialsFile(path: string): Promise<{ deleted: string }> {
  return fetchJSON(`/api/materials/files/${encodeURIComponent(path)}`, {
    method: "DELETE",
  });
}

/** 移动 raw 下的文件或目录。 */
export function moveMaterialsFile(
  source: string,
  targetDir: string,
): Promise<{ source: string; target: string }> {
  return fetchJSON(`/api/materials/move`, {
    method: "POST",
    body: JSON.stringify({ source, targetDir }),
  });
}

// ---------------------------------------------------------------------------
// Text extraction
// ---------------------------------------------------------------------------

/** 触发后台文本提取（异步）。 */
export function extractMaterialsText(path: string): Promise<{
  queued: number;
  root: string;
}> {
  return fetchJSON(`/api/materials/extract`, {
    method: "POST",
    body: JSON.stringify({ path }),
  });
}

/** 读取提取的文本内容。 */
export function getMaterialsText(path: string): Promise<MaterialsTextContent> {
  return fetchJSON<MaterialsTextContent>(`/api/materials/text/${encodeURIComponent(path)}`);
}

/** 读取 raw 原始文件内容（仅文本格式：md/html/txt 等）。 */
export function getMaterialsRawFile(path: string): Promise<MaterialsTextContent & { ext: string }> {
  return fetchJSON<MaterialsTextContent & { ext: string }>(`/api/materials/raw/${encodeURIComponent(path)}`);
}

// ---------------------------------------------------------------------------
// Wiki
// ---------------------------------------------------------------------------

/** 列出所有 Wiki 页面。 */
export async function listWikiPages(): Promise<WikiPageSummary[]> {
  const data = await fetchJSON<{ pages: WikiPageSummary[] }>(`/api/materials/wiki`);
  return data.pages ?? [];
}

/** 读取单个 Wiki 页面详情。 */
export function getWikiPage(path: string): Promise<WikiPageDetail> {
  return fetchJSON<WikiPageDetail>(`/api/materials/wiki/${encodeURIComponent(path)}`);
}

/** 写入/更新 Wiki 页面。 */
export function writeWikiPage(payload: {
  path: string;
  content: string;
}): Promise<{ path: string; bytes: number }> {
  return fetchJSON(`/api/materials/wiki/write`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

/** 删除 Wiki 页面。 */
export function deleteWikiPage(path: string): Promise<{ deleted: string }> {
  return fetchJSON(`/api/materials/wiki/${encodeURIComponent(path)}`, {
    method: "DELETE",
  });
}

// ---------------------------------------------------------------------------
// Search & Status
// ---------------------------------------------------------------------------

export interface MaterialsSearchParams {
  query: string;
  count?: number;
  /** "all" | "text" | "wiki" */
  scope?: "all" | "text" | "wiki";
}

export async function searchMaterials(
  params: MaterialsSearchParams,
): Promise<MaterialsSearchResult[]> {
  const q = new URLSearchParams({ q: params.query });
  if (params.count != null) q.set("count", String(params.count));
  if (params.scope) q.set("scope", params.scope);
  const data = await fetchJSON<{ results: MaterialsSearchResult[] }>(
    `/api/materials/search?${q.toString()}`,
  );
  return data.results ?? [];
}

export function getMaterialsStatus(): Promise<MaterialsStatus> {
  return fetchJSON<MaterialsStatus>(`/api/materials/status`);
}
