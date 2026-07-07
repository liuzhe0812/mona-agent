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

export async function httpFetch(url: string, init?: RequestInit): Promise<Response> {
  if (isTauri()) {
    if (isLoopbackHttpUrl(url)) {
      if (init?.signal?.aborted) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }

      const serializedBody = await serializeRequestBody(init?.body);
      if (serializedBody.supported) {
        const headers = Array.from(new Headers(init?.headers).entries());
        const result = await invoke<LocalHttpBridgeResponse>("local_http_request", {
          method: init?.method ?? "GET",
          url,
          headers,
          body: serializedBody.body,
        });
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
  db: string;
  kb: string;
  ppt: string;
}

export interface DesktopAppSettings {
  run_in_background: boolean;
  auto_start_gateway: boolean;
  gateway_port: number;
  quick_ask_shortcut: string;
  quick_ask_mode: string;
  sidebar_shortcuts: SidebarShortcuts;
  config_path: string | null;
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

export async function startGateway(): Promise<number> {
  return invoke<number>("start_gateway");
}

export async function stopGateway(): Promise<void> {
  return invoke<void>("stop_gateway");
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

export async function loadDesktopNotesState(): Promise<unknown | null> {
  return invoke<unknown>("notes_load_state");
}

export async function saveDesktopNotesState(state: unknown): Promise<void> {
  return invoke<void>("notes_save_state", { state });
}

export async function exportNoteTempFile(noteId: string, content: string): Promise<string> {
  return invoke<string>("notes_export_temp", { noteId, content });
}

export async function createNoteFromChat(
  title: string,
  contentMarkdown: string,
  notebookId?: string,
): Promise<string> {
  return invoke<string>("notes_create_from_chat", {
    title,
    contentMarkdown,
    notebookId: notebookId ?? null,
  });
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
// Notes bidirectional links (Obsidian-style [[wiki links]])
// ---------------------------------------------------------------------------

export async function getNotesLinkGraph(): Promise<LinkGraph | null> {
  if (!isTauri()) return null;
  return invoke<LinkGraph>("notes_links_get_graph");
}

export async function getNoteBacklinks(noteId: string): Promise<unknown[]> {
  if (!isTauri()) return [];
  return invoke<unknown[]>("notes_links_get_backlinks", { noteId });
}

export async function getNoteMentions(noteId: string): Promise<unknown[]> {
  if (!isTauri()) return [];
  return invoke<unknown[]>("notes_links_get_mentions", { noteId });
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

export interface TemplateItem {
  id: string;
  title: string;
  notebookId: string;
  preview: string;
}

export async function listNoteTemplates(): Promise<TemplateItem[]> {
  if (!isTauri()) return [];
  return invoke<TemplateItem[]>("notes_list_templates");
}

export async function createNoteFromTemplate(
  templateId: string,
  title: string,
  notebookId?: string,
): Promise<string> {
  return invoke<string>("notes_create_from_template", {
    templateId,
    title,
    notebookId: notebookId ?? null,
  });
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
}

export async function showNotification(
  payload: NotificationPayloadInput,
): Promise<void> {
  return invoke<void>("show_notification", { payload });
}

export async function closeNotificationWindow(label: string): Promise<void> {
  return invoke<void>("close_notification_window", { label });
}
