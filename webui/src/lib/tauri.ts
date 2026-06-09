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

export function httpFetch(url: string, init?: RequestInit): Promise<Response> {
  if (isTauri()) {
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
}

export async function searchNotebookNotes(
  notebookId: string,
  query: string,
  limit?: number,
): Promise<NoteSearchResult[]> {
  return invoke<NoteSearchResult[]>("notes_search", { notebookId, query, limit });
}

export async function saveNoteImage(
  fileName: string,
  imageData: number[],
): Promise<string> {
  return invoke<string>("notes_save_image", { fileName, imageData });
}

export async function getNotesAssetsDir(): Promise<string> {
  return invoke<string>("notes_get_assets_dir");
}

export async function readNoteImage(fileName: string): Promise<string> {
  return invoke<string>("notes_read_image", { fileName });
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
