import { isTauri } from "./tauri";

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) {
    throw new Error("Not running in Tauri environment");
  }
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return tauriInvoke<T>(cmd, args);
}

export interface BrowserTabInfo {
  id: string;
  title: string;
  url: string;
  cdp_port: number;
  webview_label: string;
  is_ai_controlled: boolean;
}

export interface CreateTabResult {
  id: string;
  cdp_port: number;
}

/** 创建浏览器标签（Rust 侧创建 WebView） */
export async function browserCreateTab(id: string, url: string): Promise<CreateTabResult> {
  return invoke<CreateTabResult>("browser_create_tab", { id, url });
}

/** 关闭标签 */
export async function browserCloseTab(id: string): Promise<void> {
  return invoke<void>("browser_close_tab", { id });
}

/** 更新标签 URL */
export async function browserUpdateTabUrl(id: string, url: string): Promise<void> {
  return invoke<void>("browser_update_tab_url", { id, url });
}

/** 更新标签标题 */
export async function browserUpdateTabTitle(id: string, title: string): Promise<void> {
  return invoke<void>("browser_update_tab_title", { id, title });
}

/** 列出所有标签 */
export async function browserListTabs(): Promise<BrowserTabInfo[]> {
  return invoke<BrowserTabInfo[]>("browser_list_tabs");
}

/** 获取标签的 CDP 端口 */
export async function browserGetCdpPort(id: string): Promise<number> {
  return invoke<number>("browser_get_cdp_port", { id });
}

/** 设置 AI 控制状态 */
export async function browserSetAiStatus(id: string, controlled: boolean): Promise<void> {
  return invoke<void>("browser_set_ai_status", { id, controlled });
}

/** 导航标签到指定 URL（用于地址栏输入、target="_blank" 等场景） */
export async function browserNavigateTab(id: string, url: string): Promise<void> {
  return invoke<void>("browser_navigate_tab", { id, url });
}

/** 后退 */
export async function browserGoBack(id: string): Promise<void> {
  return invoke<void>("browser_go_back", { id });
}

/** 前进 */
export async function browserGoForward(id: string): Promise<void> {
  return invoke<void>("browser_go_forward", { id });
}

/** 刷新 */
export async function browserReload(id: string): Promise<void> {
  return invoke<void>("browser_reload", { id });
}

// ── Browser Storage (Bookmarks & History) ──

export interface Bookmark {
  id: number;
  url: string;
  title: string;
  folder: string;
  createdAt: string;
}

export interface ImportBookmarkItem {
  url: string;
  title: string;
  folder: string;
}

export interface AddressBarSuggestion {
  url: string;
  title: string;
  isBookmark: boolean;
  visitCount: number;
  lastVisitedAt: string;
}

/** 添加收藏 */
export async function browserAddBookmark(url: string, title: string, folder?: string): Promise<Bookmark> {
  return invoke<Bookmark>("browser_add_bookmark", { url, title, folder: folder || null });
}

/** 移除收藏 */
export async function browserRemoveBookmark(url: string): Promise<void> {
  return invoke<void>("browser_remove_bookmark", { url });
}

/** 更新收藏（标题或文件夹） */
export async function browserUpdateBookmark(url: string, title?: string, folder?: string): Promise<void> {
  return invoke<void>("browser_update_bookmark", { url, title: title ?? null, folder: folder ?? null });
}

/** 检查是否已收藏 */
export async function browserIsBookmarked(url: string): Promise<boolean> {
  return invoke<boolean>("browser_is_bookmarked", { url });
}

/** 列出所有收藏 */
export async function browserListBookmarks(): Promise<Bookmark[]> {
  return invoke<Bookmark[]>("browser_list_bookmarks");
}

/** 批量导入收藏（如从 Chrome 导出的 Bookmarks JSON） */
export async function browserImportBookmarks(items: ImportBookmarkItem[]): Promise<number> {
  return invoke<number>("browser_import_bookmarks", { items });
}

/** 记录访问历史 */
export async function browserRecordVisit(url: string, title: string): Promise<void> {
  return invoke<void>("browser_record_visit", { url, title });
}

/** 清空历史记录 */
export async function browserClearHistory(): Promise<void> {
  return invoke<void>("browser_clear_history");
}

/** 清理浏览器缓存 */
export async function browserClearCache(): Promise<void> {
  return invoke<void>("browser_clear_cache");
}

/** 搜索地址栏建议（收藏+历史） */
export async function browserSearchSuggestions(query: string, limit?: number): Promise<AddressBarSuggestion[]> {
  return invoke<AddressBarSuggestion[]>("browser_search_suggestions", { query, limit });
}
