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
export async function browserCreateTab(id: string, url: string, isIncognito?: boolean, adBlockEnabled?: boolean): Promise<CreateTabResult> {
  return invoke<CreateTabResult>("browser_create_tab", { id, url, isIncognito: isIncognito ?? false, adBlockEnabled: adBlockEnabled ?? true });
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
export async function browserSetTabBounds(
  id: string,
  left: number,
  top: number,
  width: number,
  height: number,
  visible: boolean,
): Promise<void> {
  return invoke<void>("browser_set_tab_bounds", { id, left, top, width, height, visible });
}

/** 隐藏除当前活动标签外的所有原生浏览器子视图。 */
export async function browserHideTabsExcept(activeId?: string): Promise<void> {
  return invoke<void>("browser_hide_tabs_except", { activeId: activeId ?? null });
}

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

export interface AddressSuggestionPopup {
  tabId: string;
  left: number;
  top: number;
  width: number;
  suggestions: AddressBarSuggestion[];
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

/** 历史记录条目 */
export interface HistoryRecord {
  id: number;
  url: string;
  title: string;
  visitCount: number;
  lastVisitedAt: string;
}

/** 获取历史记录列表 */
export async function browserListHistory(limit?: number): Promise<HistoryRecord[]> {
  return invoke<HistoryRecord[]>("browser_list_history", { limit });
}

/** 删除单条历史记录 */
export async function browserDeleteHistory(id: number): Promise<void> {
  return invoke<void>("browser_delete_history", { id });
}

/** 清理浏览器缓存 */
export async function browserClearCache(): Promise<void> {
  return invoke<void>("browser_clear_cache");
}

/** 搜索地址栏建议（收藏+历史） */
export async function browserSearchSuggestions(query: string, limit?: number): Promise<AddressBarSuggestion[]> {
  return invoke<AddressBarSuggestion[]>("browser_search_suggestions", { query, limit });
}

export async function browserShowAddressSuggestions(popup: AddressSuggestionPopup): Promise<void> {
  return invoke<void>("browser_show_address_suggestions", { popup });
}

export async function browserHideAddressSuggestions(tabId: string): Promise<void> {
  return invoke<void>("browser_hide_address_suggestions", { tabId });
}

export async function browserSelectAddressSuggestion(tabId: string, url: string): Promise<void> {
  return invoke<void>("browser_select_address_suggestion", { tabId, url });
}

export async function browserListenAddressSuggestionSelected(
  callback: (payload: { tabId: string; url: string }) => void,
): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<{ tabId: string; url: string }>("browser-address-suggestion-selected", (event) => callback(event.payload));
}

export interface DownloadPopupAnchor {
  left: number;
  top: number;
}

export async function browserShowDownloads(anchor: DownloadPopupAnchor): Promise<void> {
  return invoke<void>("browser_show_downloads", { anchor });
}

export async function browserToggleDownloads(anchor: DownloadPopupAnchor): Promise<void> {
  return invoke<void>("browser_toggle_downloads", { anchor });
}

export async function browserHideDownloads(): Promise<void> {
  return invoke<void>("browser_hide_downloads");
}

// ── Download Management ──

export interface DownloadInfo {
  id: string;
  url: string;
  filename: string;
  mimeType: string;
  totalBytes: number;
  receivedBytes: number;
  state: string; // "in_progress" | "interrupted" | "completed" | "cancelled"
  savePath: string;
  /** 前端估算的下载速度（字节/秒），用于剩余时间显示 */
  bytesPerSecond?: number;
}

/** 取消下载 */
export async function browserCancelDownload(id: string): Promise<void> {
  return invoke<void>("browser_cancel_download", { id });
}

/** 暂停下载 */
export async function browserPauseDownload(id: string): Promise<void> {
  return invoke<void>("browser_pause_download", { id });
}

/** 恢复下载 */
export async function browserResumeDownload(id: string): Promise<void> {
  return invoke<void>("browser_resume_download", { id });
}

/** 列出所有下载 */
export async function browserListDownloads(): Promise<DownloadInfo[]> {
  return invoke<DownloadInfo[]>("browser_list_downloads");
}

/** 打开下载的文件 */
export async function browserOpenDownload(id: string): Promise<void> {
  return invoke<void>("browser_open_download", { id });
}

/** 在文件管理器中显示 */
export async function browserRevealDownload(id: string): Promise<void> {
  return invoke<void>("browser_reveal_download", { id });
}

/** 移除下载记录 */
export async function browserRemoveDownload(id: string): Promise<void> {
  return invoke<void>("browser_remove_download", { id });
}

// ── Navigation Enhancements ──

/** 设置页面缩放（0.25 ~ 5.0） */
export async function browserSetZoom(id: string, zoomFactor: number): Promise<void> {
  return invoke<void>("browser_set_zoom", { id, zoomFactor });
}

/** 获取当前缩放 */
export async function browserGetZoom(id: string): Promise<number> {
  return invoke<number>("browser_get_zoom", { id });
}

/** 打印当前页面 */
export async function browserPrintPage(id: string): Promise<void> {
  return invoke<void>("browser_print_page", { id });
}

/** 在 WebView 中执行 JS 代码 */
export async function browserEvalScript(id: string, script: string): Promise<void> {
  return invoke<void>("browser_eval_script", { id, script });
}

export async function browserEvalScriptResult<T>(id: string, script: string): Promise<T> {
  return invoke<T>("browser_eval_script_result", { id, script });
}

// ── Privacy & Security ──

/** Cookie 信息 */
export interface CookieInfo {
  name: string;
  value: string;
  domain: string;
  path: string;
}

/** 获取当前页面的 Cookie（结果通过 browser-cookies-result 事件回传） */
export async function browserGetCookies(id: string): Promise<void> {
  return invoke<void>("browser_get_cookies", { id });
}

/** 清除当前页面的 Cookie */
export async function browserClearCookies(id: string): Promise<void> {
  return invoke<void>("browser_clear_cookies", { id });
}

/** 切换广告拦截状态 */
export async function browserSetAdBlock(id: string, enabled: boolean): Promise<void> {
  return invoke<void>("browser_set_ad_block", { id, enabled });
}

/** 切换标签静音 */
export async function browserSetMuted(id: string, muted: boolean): Promise<void> {
  return invoke<void>("browser_set_muted", { id, muted });
}

/** 获取标签静音状态 */
export async function browserIsMuted(id: string): Promise<boolean> {
  return invoke<boolean>("browser_is_muted", { id });
}

/** 获取标签无痕状态 */
export async function browserIsIncognito(id: string): Promise<boolean> {
  return invoke<boolean>("browser_is_incognito", { id });
}

// ── Advanced Features ──

/** 页面元信息 */
export interface PageInfo {
  url: string;
  title: string;
  description: string;
  ogImage: string;
}

/** 打开开发者工具 */
export async function browserOpenDevtools(id: string): Promise<void> {
  return invoke<void>("browser_open_devtools", { id });
}

/** 切换暗色模式 */
export async function browserSetDarkMode(id: string, enabled: boolean): Promise<void> {
  return invoke<void>("browser_set_dark_mode", { id, enabled });
}

/** 获取页面元信息（结果通过 browser-page-info-result 事件回传） */
export async function browserGetPageInfo(id: string): Promise<void> {
  return invoke<void>("browser_get_page_info", { id });
}
