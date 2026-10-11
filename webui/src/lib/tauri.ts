import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
    __TAURI__?: unknown;
  }
}

export function isTauri(): boolean {
  return !!window.__TAURI_INTERNALS__ || !!window.__TAURI__;
}

interface LocalHttpBridgeResponse {
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
  body: number[];
}

function isLoopbackHttpUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    return (
      host === "localhost" ||
      host.startsWith("127.") ||
      host === "::1" ||
      host === "[::1]"
    );
  } catch {
    return false;
  }
}

type SerializedBody =
  | { supported: true; body: number[] | null }
  | { supported: false };

async function serializeRequestBody(body: BodyInit | null | undefined): Promise<SerializedBody> {
  if (body == null) return { supported: true, body: null };
  if (typeof body === "string") {
    return { supported: true, body: Array.from(new TextEncoder().encode(body)) };
  }
  if (body instanceof URLSearchParams) {
    return { supported: true, body: Array.from(new TextEncoder().encode(body.toString())) };
  }
  if (body instanceof Blob) {
    return { supported: true, body: Array.from(new Uint8Array(await body.arrayBuffer())) };
  }
  if (body instanceof ArrayBuffer) {
    return { supported: true, body: Array.from(new Uint8Array(body)) };
  }
  if (ArrayBuffer.isView(body)) {
    return {
      supported: true,
      body: Array.from(
        new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
      ),
    };
  }
  return { supported: false };
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

function withAbortSignal<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

export async function httpFetch(url: string, init?: RequestInit): Promise<Response> {
  if (isTauri()) {
    if (isLoopbackHttpUrl(url)) {
      if (init?.signal?.aborted) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }

      const serializedBody = await serializeRequestBody(init?.body);
      if (init?.signal?.aborted) throw abortError(init.signal);
      if (serializedBody.supported) {
        const headers = Array.from(new Headers(init?.headers).entries());
        const result = await withAbortSignal(
          invoke<LocalHttpBridgeResponse>("local_http_request", {
            method: init?.method ?? "GET",
            url,
            headers,
            body: serializedBody.body,
          }),
          init?.signal ?? undefined,
        );
        const responseBody =
          result.status === 204 || result.status === 304
            ? null
            : new Uint8Array(result.body);
        return new Response(responseBody, {
          status: result.status,
          statusText: result.statusText,
          headers: new Headers(result.headers),
        });
      }
    }
    return tauriFetch(url, init);
  }
  return window.fetch(url, init);
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) {
    throw new Error("Not running in Tauri environment");
  }
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return tauriInvoke<T>(cmd, args);
}

export async function invokeWithTimeout<T>(
  cmd: string,
  args: Record<string, unknown>,
  ms: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Command '${cmd}' timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([invoke<T>(cmd, args), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface GatewayStatus {
  running: boolean;
  port: number | null;
  ws_port: number;
}

export interface MonaConfigStatus {
  config_exists: boolean;
  has_provider: boolean;
  provider_name: string | null;
}

export interface SidebarShortcuts {
  mona: string;
  note: string;
  ssh: string;
  email: string;
  schedule: string;
  db: string;
}

export interface SidebarModuleConfig {
  key: string;
  visible: boolean;
  order: number;
}

export type SendMessageShortcut = "enter" | "ctrl_enter";
export const SEND_MESSAGE_SHORTCUT_EVENT = "mona:send-message-shortcut";

export interface DesktopAppSettings {
  run_in_background: boolean;
  auto_start_gateway: boolean;
  gateway_port: number;
  quick_ask_shortcut: string;
  quick_ask_mode: string;
  send_message_shortcut: SendMessageShortcut;
  sidebar_shortcuts: SidebarShortcuts;
  default_view: string;
  sidebar_modules: SidebarModuleConfig[];
  config_path: string | null;
  browser_automation_enabled: boolean;
  computer_use_enabled: boolean;
}

export async function getGatewayStatus(): Promise<GatewayStatus> {
  return invoke<GatewayStatus>("gateway_status");
}

export async function getMonaConfigStatus(): Promise<MonaConfigStatus> {
  return invoke<MonaConfigStatus>("mona_config_status");
}

export async function getDesktopSettings(): Promise<DesktopAppSettings> {
  return invoke<DesktopAppSettings>("get_settings");
}

export async function updateDesktopSettings(settings: DesktopAppSettings): Promise<DesktopAppSettings> {
  return invoke<DesktopAppSettings>("update_settings", { newSettings: settings });
}

export interface ManagedModelPrice {
  model: string;
  billing_type?: "token" | "image" | "video";
  rates?: Record<string, string>;
  input_amount_per_million?: string;
  cached_input_amount_per_million?: string;
  output_amount_per_million?: string;
  promotion_label?: string;
  promotion_name?: string;
  discount_percent?: number;
  original_input_amount_per_million?: string;
  original_cached_input_amount_per_million?: string;
  original_output_amount_per_million?: string;
}

export async function getManagedModelPrices(): Promise<{ prices: ManagedModelPrice[] }> {
  return invoke<{ prices: ManagedModelPrice[] }>("get_managed_model_prices");
}

export interface ManagedCreditUsageRecent {
  request_id: string;
  model: string;
  billing_type: "token" | "image" | "video";
  status: string;
  spent_amount: string | null;
  reserved_amount: string;
  usage?: Record<string, unknown> | null;
  result?: Record<string, unknown> | null;
  created_at: string;
  settled_at: string | null;
}

export interface ManagedCreditUsage {
  period_spent_amount: string;
  pending_reserved_amount: string;
  recent: ManagedCreditUsageRecent[];
}

export async function getCreditUsage(tzOffsetMinutes: number): Promise<ManagedCreditUsage> {
  return invoke<ManagedCreditUsage>("get_credit_usage", { tzOffsetMinutes });
}

export async function startGateway(): Promise<number> {
  return invoke<number>("start_gateway");
}

export async function stopGateway(): Promise<void> {
  return invoke<void>("stop_gateway");
}

export interface ServicesStatus {
  running: boolean;
  port: number | null;
}

export async function getServicesStatus(): Promise<ServicesStatus> {
  return invoke<ServicesStatus>("services_status");
}

export async function startServices(): Promise<number> {
  return invoke<number>("start_services");
}

export async function stopServices(): Promise<void> {
  return invoke<void>("stop_services");
}

export interface GatewayLog {
  path: string;
  exists: boolean;
  tail: string;
}

export async function readGatewayLog(maxLines?: number): Promise<GatewayLog> {
  return invoke<GatewayLog>("read_gateway_log", { maxLines: maxLines ?? null });
}

export async function writeMonaProviderConfig(
  provider: string,
  apiKey: string,
  apiBase?: string,
): Promise<void> {
  return invoke<void>("write_mona_provider_config", {
    provider,
    apiKey,
    apiBase: apiBase ?? null,
  });
}

export async function writeMonaModelConfig(
  model: string,
  provider: string,
): Promise<void> {
  return invoke<void>("write_mona_model_config", { model, provider });
}

// ---------------------------------------------------------------------------
// 邮件 AI 日程提取配置（config.json 中 tools.emailIntel.schedule 字段）
// ---------------------------------------------------------------------------

export interface EmailScheduleConfig {
  enabled: boolean;
  folders: string[];
  createMode: "auto" | "confirm";
  leadMinutes: number;
  skipSenders: string[];
  parseTimeoutSeconds: number;
}

export async function readEmailScheduleConfig(): Promise<EmailScheduleConfig> {
  return invoke<EmailScheduleConfig>("read_email_schedule_config");
}

export async function writeEmailScheduleConfig(
  config: EmailScheduleConfig,
): Promise<void> {
  return invoke<void>("write_email_schedule_config", { schedule: config });
}

/**
 * 同步主窗口背景色到当前主题，避免拖动调整大小时露出对比色残影。
 * 浅色主题传 (255,255,255,255)，深色主题传 (26,26,26,255)。
 */
export async function setWindowBackgroundColor(
  r: number,
  g: number,
  b: number,
  a: number,
): Promise<void> {
  return invoke<void>("set_window_background_color", { r, g, b, a });
}

export async function loadDesktopNotesState(): Promise<unknown | null> {
  return invoke<unknown>("notes_load_state");
}

export async function saveDesktopNotesState(state: unknown): Promise<void> {
  return invoke<void>("notes_save_state", { state });
}

export async function deleteDesktopNotes(noteIds: string[]): Promise<void> {
  return invoke<void>("notes_delete", { noteIds });
}

export interface WorkspaceCanvasDocument {
  version: 1;
  id: string;
  kind: "flowchart" | "mindmap";
  title: string;
  originChatId?: string;
  createdAt: string;
  updatedAt: string;
  contentMarkdown: string;
}

export interface SavedWorkspaceCanvas {
  canvas: WorkspaceCanvasDocument;
  path: string;
}

export async function saveWorkspaceCanvas(
  workspaceRoot: string,
  canvas: WorkspaceCanvasDocument,
): Promise<SavedWorkspaceCanvas> {
  const saved = await invoke<SavedWorkspaceCanvas>("workspace_canvas_save", { workspaceRoot, canvas });
  window.dispatchEvent(new CustomEvent("mona:workspace-canvas-changed", {
    detail: { canvasId: saved.canvas.id, path: saved.path },
  }));
  return saved;
}

export function listWorkspaceCanvases(
  workspaceRoot: string,
  chatId?: string,
): Promise<SavedWorkspaceCanvas[]> {
  return invoke<SavedWorkspaceCanvas[]>("workspace_canvas_list", {
    workspaceRoot,
    chatId: chatId || null,
  });
}

export function readWorkspaceCanvas(
  workspaceRoot: string,
  path: string,
): Promise<SavedWorkspaceCanvas> {
  return invoke<SavedWorkspaceCanvas>("workspace_canvas_read", { workspaceRoot, path });
}

export function openWorkspaceCanvasFile(path: string): Promise<SavedWorkspaceCanvas> {
  return invoke<SavedWorkspaceCanvas>("workspace_canvas_open_file", { path });
}

export async function writeWorkspaceCanvasFile(
  path: string,
  canvas: WorkspaceCanvasDocument,
): Promise<SavedWorkspaceCanvas> {
  const saved = await invoke<SavedWorkspaceCanvas>("workspace_canvas_write_file", { path, canvas });
  window.dispatchEvent(new CustomEvent("mona:workspace-canvas-changed", {
    detail: { canvasId: saved.canvas.id, path: saved.path },
  }));
  return saved;
}

export async function migrateLegacyCanvases(workspaceRoot: string): Promise<number> {
  const migrated = await invoke<number>("workspace_canvas_migrate_legacy", { workspaceRoot });
  if (migrated > 0) {
    window.dispatchEvent(new CustomEvent("mona:workspace-canvas-changed", {
      detail: { migrated },
    }));
  }
  return migrated;
}

export async function exportNoteTempFile(noteId: string, content: string): Promise<string> {
  return invoke<string>("notes_export_temp", { noteId, content });
}

export async function createNoteFromChat(
  title: string,
  contentMarkdown: string,
  notebookId?: string,
): Promise<string> {
  const noteId = await invoke<string>("notes_create_from_chat", {
    title,
    contentMarkdown,
    notebookId: notebookId ?? null,
  });
  window.dispatchEvent(new CustomEvent("mona:notes-changed"));
  return noteId;
}

export interface NoteSearchResult {
  noteId: string;
  title: string;
  snippet: string;
  rank: number;
  notebookId?: string;
  notebookName?: string;
}

export interface LinkNode {
  id: string;
  title: string;
  path: string;
  aliases: string[];
  noteType: string;
  /** "note"（笔记库）或 "wiki"（资料库 wiki 页面），Rust 侧 5 版缓存起返回。 */
  sourceKind?: string;
}

export interface LinkEdge {
  source: string;
  targetTitle: string;
  resolvedTarget: string | null;
  kind: "link" | "embed";
  anchor: string | null;
}

export interface LinkGraph {
  nodes: LinkNode[];
  edges: LinkEdge[];
  lastScanAt: string;
  /** Saved layout positions (note id -> [x, y]) for instant view restore. */
  positions?: Record<string, [number, number]>;
}

export async function searchNotebookNotes(
  notebookId: string,
  query: string,
  limit?: number,
): Promise<NoteSearchResult[]> {
  return invoke<NoteSearchResult[]>("notes_search", { notebookId, query, limit });
}

export async function searchAllNotes(
  query: string,
  limit?: number,
): Promise<NoteSearchResult[]> {
  return invoke<NoteSearchResult[]>("notes_search_all", { query, limit });
}

export async function getNotesAssetsDir(): Promise<string> {
  return invoke<string>("notes_get_assets_dir");
}

export async function saveNoteImageData(
  imageData: string,
  fileName: string,
): Promise<string> {
  return invoke<string>("notes_save_image_data", { imageData, fileName });
}

export async function getNotesVaultPath(): Promise<string | null> {
  if (!isTauri()) return null;
  return invoke<string | null>("notes_vault_get_path");
}

export async function setNotesVaultPath(path: string): Promise<void> {
  return invoke<void>("notes_vault_set_path", { path });
}

export async function pickNotesVaultDirectory(): Promise<string | null> {
  if (!isTauri()) return null;
  return invoke<string | null>("notes_vault_pick_directory");
}

// ---------------------------------------------------------------------------
// Agent search scope (notes / email exclusion lists)
// ---------------------------------------------------------------------------

export interface AgentSearchScope {
  notes: { mode: string; allowedNotebookIds: string[] };
  email: { mode: string; allowedFolders: string[] };
}

export async function getAgentSearchScope(): Promise<AgentSearchScope> {
  return invoke<AgentSearchScope>("get_agent_search_scope");
}

export async function setAgentSearchScope(scope: AgentSearchScope): Promise<void> {
  return invoke<void>("set_agent_search_scope", { scope });
}

// ---------------------------------------------------------------------------
// Notes bidirectional links (Obsidian-style [[wiki links]])
// ---------------------------------------------------------------------------

export async function getNotesLinkGraph(): Promise<LinkGraph | null> {
  if (!isTauri()) return null;
  return invoke<LinkGraph>("notes_links_get_graph");
}

export async function saveNotesLinkPositions(
  positions: Record<string, [number, number]>,
): Promise<void> {
  if (!isTauri()) return;
  return invoke<void>("notes_links_save_positions", { positions });
}

export async function getNoteBacklinks(noteId: string): Promise<unknown[]> {
  if (!isTauri()) return [];
  return invokeWithTimeout<unknown[]>("notes_links_get_backlinks", { noteId }, 15000);
}

export async function getNoteMentions(noteId: string): Promise<unknown[]> {
  if (!isTauri()) return [];
  return invokeWithTimeout<unknown[]>("notes_links_get_mentions", { noteId }, 15000);
}

export async function renameSyncWikiLinks(oldTitle: string, newTitle: string): Promise<{
  updatedFiles: number;
  updatedLinks: number;
}> {
  return invoke<{ updatedFiles: number; updatedLinks: number }>(
    "notes_links_rename_sync",
    { oldTitle, newTitle },
  );
}

export async function searchNoteMentions(query: string): Promise<unknown[]> {
  if (!isTauri()) return [];
  return invoke<unknown[]>("notes_links_search_mentions", { query });
}

export async function listMocNotes(): Promise<unknown[]> {
  if (!isTauri()) return [];
  return invoke<unknown[]>("notes_moc_list");
}

export async function openPathWithSystemApp(path: string): Promise<void> {
  if (!isTauri()) return;
  try {
    const { openPath } = await import("@tauri-apps/plugin-opener");
    await openPath(path);
  } catch (err) {
    console.warn("[tauri] opener.openPath failed, falling back to shell.open:", err);
    try {
      const { open } = await import("@tauri-apps/plugin-shell");
      await open(path);
    } catch (err2) {
      console.error("[tauri] shell.open also failed:", err2);
    }
  }
}

export async function quickAskHide(): Promise<void> {
  return invoke<void>("quick_ask_hide");
}

export async function quickAskFocusChat(chatId: string): Promise<void> {
  return invoke<void>("quick_ask_focus_chat", { chatId });
}

export async function quickAskOpenNote(): Promise<void> {
  return invoke<void>("quick_ask_open_note");
}

export async function quickAskOpenSsh(): Promise<void> {
  return invoke<void>("quick_ask_open_ssh");
}

export async function revealItemInDir(path: string): Promise<void> {
  if (!isTauri()) return;
  const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
  await revealItemInDir(path);
}

/** Move a file to the OS recycle bin (recoverable). Throws when the trash
 *  is unavailable — callers must surface the error, never fall back to a
 *  permanent delete. */
export async function moveToTrash(path: string): Promise<void> {
  if (!isTauri()) return;
  return invoke<void>("move_to_trash", { path });
}

/** Open an external http(s) URL in the user's default web browser.
 *  Falls back to ``window.open`` outside Tauri (browser/dev mode). */
export async function openExternalUrl(url: string): Promise<void> {
  if (!isTauri()) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } catch (err) {
    console.warn("[tauri] opener.openUrl failed, falling back to shell.open:", err);
    try {
      const { open } = await import("@tauri-apps/plugin-shell");
      await open(url);
    } catch (err2) {
      console.error("[tauri] shell.open also failed:", err2);
      window.open(url, "_blank", "noopener,noreferrer");
    }
  }
}

export async function saveMarkdownFile(title: string, content: string): Promise<boolean> {
  if (!isTauri()) {
    const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    const safeName = title.trim().replace(/[\\/:*?"<>|]/g, "_").slice(0, 64) || "未命名笔记";
    link.download = `${safeName}.md`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    return true;
  }
  const { save } = await import("@tauri-apps/plugin-dialog");
  const { writeFile } = await import("@tauri-apps/plugin-fs");
  const safeName = title.trim().replace(/[\\/:*?"<>|]/g, "_").slice(0, 64) || "未命名笔记";
  const filePath = await save({
    defaultPath: `${safeName}.md`,
    filters: [{ name: "Markdown", extensions: ["md"] }],
  });
  if (!filePath) return false;
  const encoder = new TextEncoder();
  await writeFile(filePath, encoder.encode(content));
  return true;
}

/** Convert a ``data:`` or ``http(s):`` media URL into a byte buffer. */
async function mediaUrlToBytes(url: string): Promise<Uint8Array> {
  if (url.startsWith("data:")) {
    const commaIdx = url.indexOf(",");
    if (commaIdx < 0) throw new Error("Invalid data URL");
    const meta = url.slice(5, commaIdx).toLowerCase();
    const payload = url.slice(commaIdx + 1);
    if (meta.includes(";base64")) {
      const binary = atob(payload);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return bytes;
    }
    return new TextEncoder().encode(decodeURIComponent(payload));
  }
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch media: ${resp.status}`);
  const buf = await resp.arrayBuffer();
  return new Uint8Array(buf);
}

/**
 * Save a media URL (data: or http(s):) to a local file via a native save
 * dialog. Returns the saved path, or ``null`` if the user cancelled. In
 * browser mode falls back to a synthetic ``<a download>`` click.
 */
export async function downloadMediaUrl(url: string, filename: string): Promise<string | null> {
  if (!isTauri()) {
    const blob = await (await fetch(url)).blob();
    const blobUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = blobUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(blobUrl);
    return null;
  }
  const { save } = await import("@tauri-apps/plugin-dialog");
  const { writeFile } = await import("@tauri-apps/plugin-fs");
  const filePath = await save({ defaultPath: filename });
  if (!filePath) return null;
  const bytes = await mediaUrlToBytes(url);
  await writeFile(filePath, bytes);
  return filePath;
}

// ---------------------------------------------------------------------------
// Updater
// ---------------------------------------------------------------------------

export interface UpdateCheckResult {
  has_update: boolean;
  current_version: string;
  latest_version: string;
  notes: string | null;
  size: number | null;
}

export interface UpdateProgress {
  stage: string;
  percent: number;
  message: string;
}

export async function checkForUpdates(): Promise<UpdateCheckResult> {
  return invoke<UpdateCheckResult>("check_for_updates");
}

export async function performUpdate(): Promise<void> {
  return invoke<void>("perform_update");
}

export async function getCurrentVersion(): Promise<string> {
  return invoke<string>("get_current_version");
}

export async function takeUpdateError(): Promise<string | null> {
  return invoke<string | null>("take_update_error");
}

// ---------------------------------------------------------------------------
// 全局右下角通知弹窗（独立 Tauri 窗口）
// ---------------------------------------------------------------------------

export interface NotificationActionInput {
  label: string;
  action: string;
  primary?: boolean;
}

export interface NotificationPayloadInput {
  id: string;
  title: string;
  body: string;
  /** mail / schedule / update / success / warning / error / info */
  icon?: string;
  actions?: NotificationActionInput[];
  /** 自动关闭毫秒，0 不自动关闭，默认 6000 */
  autoCloseMs?: number;
  /** 点击卡片本身触发的 action */
  clickAction?: string;
  /** 点击通知时携带的结构化数据，随 notification-action 事件一并 emit。
   *  例如邮件通知携带 { type: "mail", accountId, uid, folder, subject }，
   *  让监听方打开独立预览窗口而非主窗口。 */
  clickData?: unknown;
}

export async function showNotification(
  payload: NotificationPayloadInput,
): Promise<void> {
  return invoke<void>("show_notification", { payload });
}

export async function closeNotificationWindow(label: string): Promise<void> {
  return invoke<void>("close_notification_window", { label });
}

// ---------------------------------------------------------------------------
// Materials (资料库 Tauri 命令封装)
// ---------------------------------------------------------------------------

export interface MaterialsEntry {
  name: string;
  path: string;
  kind: "directory" | "file";
  size: number | null;
  mtime: number | null;
}

/** 复制用户选择的文件到资料库 raw 目录。 */
export function materialsImportFiles(
  sourcePaths: string[],
  targetDir: string,
  knowledgeBaseId?: string,
  agentId?: string,
): Promise<MaterialsEntry[]> {
  return invoke<MaterialsEntry[]>("materials_import_files", {
    sourcePaths,
    targetDir,
    knowledgeBaseId,
    agentId,
  });
}

/** 列出 raw 目录下的文件和文件夹（非递归）。 */
export function materialsListDir(
  subdir: string | null,
  knowledgeBaseId?: string,
): Promise<MaterialsEntry[]> {
  return invoke<MaterialsEntry[]>("materials_list_dir", { subdir, knowledgeBaseId });
}

/** 确保 .mona/materials/{raw,text,wiki}/ 存在。 */
export function materialsEnsureInitialized(knowledgeBaseId?: string): Promise<boolean> {
  return invoke<boolean>("materials_ensure_initialized", { knowledgeBaseId });
}

/** 返回 wiki 目录绝对路径。 */
export function materialsGetWikiDir(knowledgeBaseId?: string): Promise<string | null> {
  return invoke<string | null>("materials_get_wiki_dir", { knowledgeBaseId });
}
