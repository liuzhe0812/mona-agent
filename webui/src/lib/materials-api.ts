/** Materials API client — talks to Mona gateway HTTP server.
 *
 * 资料库 HTTP 接口：目录、读取、删除、后台提取状态、Wiki 读写、搜索。
 * 路由注册在 services 进程（端口 17174），按项目端口架构规则使用
 * `getServicesHttpBase()`。
 */

import { getServicesHttpBase } from "./api";
import { httpFetch } from "./tauri";

async function fetchJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const base = await getServicesHttpBase();
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
  status: "queued" | "running" | "ok" | "error" | "unsupported" | "stale";
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
  /** Wiki 入库状态（仅 file） */
  ingestStatus?: "not_ingested" | "ingested" | "stale";
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
  /** 引用的原始资料已缺失或内容已变化（由 reconcile 标记） */
  stale?: boolean;
  mtime: number;
}

export interface WikiPageDetail {
  path: string;
  content: string;
}

export interface MaterialsSearchResult {
  kind: "material_source" | "material_wiki";
  title: string;
  /** source 为相对 raw/ 的路径；wiki 为相对 wiki/ 的路径 */
  path: string;
  snippet: string;
  score: number;
  /** 位置标签（如 "Page 12"），点击跳转时用于预览内滚动定位 */
  locationLabel?: string | null;
  /** 引用的原始资料已缺失或内容已变化 */
  stale?: boolean;
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
  rawRoot?: string;
  vaultRoot?: string;
}

// ---------------------------------------------------------------------------
// Lint（LLM Wiki 质量检查）
// ---------------------------------------------------------------------------

export interface MaterialsLintIssue {
  /** 规则 ID：frontmatter-schema / broken-wikilink / dangling-source /
   *  duplicate-title / orphan-page / thin-page / text-extract-error / stale-page */
  rule: string;
  severity: "error" | "warning";
  /** wiki 问题为相对 wiki/ 的路径；提取问题为 text/ 前缀路径 */
  path: string;
  message: string;
  /** 规则中文标签，直接展示 */
  label: string;
  details: Record<string, unknown>;
}

export interface MaterialsLintReport {
  issues: MaterialsLintIssue[];
  summary: {
    errors: number;
    warnings: number;
    wikiPages: number;
    textFiles: number;
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

/** 轻量对账 raw/text/wiki 一致性并同步检索索引（进入资料页/手动刷新时调用）。 */
export function reconcileMaterials(): Promise<{
  requeued: string[];
  removedOrphans: string[];
  staleWiki: string[];
}> {
  return fetchJSON(`/api/materials/reconcile`, { method: "POST" });
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
// Wiki compile（后端任务：候选化 → 合并 → 事务写入）
// ---------------------------------------------------------------------------

export interface WikiCompileStatus {
  taskId: string;
  /** running | done | error | cancelled */
  state: "running" | "done" | "error" | "cancelled";
  currentFile: string;
  totalFiles: number;
  completedFiles: number;
  errors: string[];
  pagesWritten: number;
  writtenPaths: string[];
}

/** 启动 Wiki 编译任务。paths 相对 raw/，可为文件或目录（目录递归展开）。 */
export function startWikiCompile(
  paths: string[],
): Promise<{ taskId: string; totalFiles: number }> {
  return fetchJSON(`/api/materials/wiki/compile`, {
    method: "POST",
    body: JSON.stringify({ paths }),
  });
}

/** 查询编译任务状态。 */
export function getWikiCompileStatus(taskId: string): Promise<WikiCompileStatus> {
  return fetchJSON<WikiCompileStatus>(
    `/api/materials/wiki/compile/${encodeURIComponent(taskId)}`,
  );
}

/** 取消编译任务。 */
export function cancelWikiCompile(taskId: string): Promise<{ cancelled: boolean }> {
  return fetchJSON(`/api/materials/wiki/compile/${encodeURIComponent(taskId)}/cancel`, {
    method: "POST",
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

/** 对 LLM Wiki 产物跑确定性质量检查（只报告不修复）。 */
export function lintMaterials(): Promise<MaterialsLintReport> {
  return fetchJSON<MaterialsLintReport>(`/api/materials/lint`, { method: "POST" });
}
