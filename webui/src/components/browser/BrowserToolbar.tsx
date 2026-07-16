import { ArrowLeft, ArrowRight, RotateCw, Star, Lock, Globe, Search, Maximize, Minimize, Settings2, Trash2, HardDrive, Download, BookmarkPlus, Upload, ZoomIn, ZoomOut, Printer, Code, Search as FindIcon, Clock, Cookie, Volume2, VolumeX, Shield, ShieldOff, Eye, Terminal, Moon, Sun, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AgentLogo } from "@/components/AgentLogo";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  browserIsBookmarked,
  browserAddBookmark,
  browserRemoveBookmark,
  browserSearchSuggestions,
  browserClearHistory,
  browserClearCache,
  browserImportBookmarks,
  browserShowAddressSuggestions,
  browserHideAddressSuggestions,
  browserListenAddressSuggestionSelected,
  browserShowDownloads,
  type AddressBarSuggestion,
  type ImportBookmarkItem,
} from "@/lib/browser-ipc";
import { isTauri } from "@/lib/tauri";

interface ChromeBookmarkNode {
  type?: string;
  name?: string;
  url?: string;
  children?: ChromeBookmarkNode[];
}

interface ChromeBookmarksJson {
  roots?: Record<string, ChromeBookmarkNode | undefined>;
}

const DEFAULT_SEARCH_ENGINE = "https://www.google.com/search?q=";

function isLikelyUrl(input: string): boolean {
  // 包含协议
  if (/^https?:\/\//i.test(input)) return true;
  // 看起来像域名（example.com, sub.example.co.uk）
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/.*)?$/i.test(input)) return true;
  // localhost
  if (/^localhost(:\d+)?(\/.*)?$/i.test(input)) return true;
  // IP 地址
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?(\/.*)?$/.test(input)) return true;
  return false;
}

function normalizeUrlOrSearch(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  if (isLikelyUrl(trimmed)) {
    return trimmed.includes("://") ? trimmed : `https://${trimmed}`;
  }
  // 当作搜索查询
  return `${DEFAULT_SEARCH_ENGINE}${encodeURIComponent(trimmed)}`;
}

interface BrowserToolbarProps {
  tabId?: string;
  url: string;
  title: string;
  isAiControlled: boolean;
  isAiPanelOpen: boolean;
  isFullscreen?: boolean;
  bookmarkBarVisible: boolean;
  isIncognito?: boolean;
  isMuted?: boolean;
  adBlockEnabled?: boolean;
  isDarkMode?: boolean;
  onNavigate: (url: string) => void;
  onGoBack: () => void;
  onGoForward: () => void;
  onReload: () => void;
  onToggleAiPanel: () => void;
  onToggleBookmarkBar: () => void;
  onToggleFullscreen?: () => void;
  onExitFullscreen?: () => void;
  onFind?: () => void;
  onPrint?: () => void;
  onViewSource?: () => void;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  onZoomReset?: () => void;
  onOpenHistory?: () => void;
  onOpenCookieManager?: () => void;
  onToggleMute?: () => void;
  onToggleAdBlock?: () => void;
  onToggleDarkMode?: () => void;
  onOpenDevtools?: () => void;
  onShare?: () => void;
  onCreateNote?: () => void;
}

export function BrowserToolbar({
  tabId,
  url,
  title,
  isAiControlled,
  isAiPanelOpen,
  isFullscreen = false,
  bookmarkBarVisible,
  isIncognito = false,
  isMuted = false,
  adBlockEnabled = true,
  isDarkMode = false,
  onNavigate,
  onGoBack,
  onGoForward,
  onReload,
  onToggleAiPanel,
  onToggleBookmarkBar,
  onToggleFullscreen,
  onExitFullscreen,
  onFind,
  onPrint,
  onViewSource,
  onZoomIn,
  onZoomOut,
  onZoomReset,
  onOpenHistory,
  onOpenCookieManager,
  onToggleMute,
  onToggleAdBlock,
  onToggleDarkMode,
  onOpenDevtools,
  onShare,
  onCreateNote,
}: BrowserToolbarProps) {
  const [inputUrl, setInputUrl] = useState(url);
  const [isFocused, setIsFocused] = useState(false);
  const [isBookmarked, setIsBookmarked] = useState(false);
  const [suggestions, setSuggestions] = useState<AddressBarSuggestion[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(-1);
  const suggestionsRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const inputRef = useRef<HTMLInputElement>(null);
  const downloadButtonRef = useRef<HTMLButtonElement>(null);

  // 监听 Ctrl+L 聚焦地址栏事件
  useEffect(() => {
    const handleFocusAddressBar = () => {
      const input = inputRef.current;
      if (input) {
        input.focus();
        input.select();
      }
    };
    window.addEventListener("mona-focus-address-bar", handleFocusAddressBar);
    return () => window.removeEventListener("mona-focus-address-bar", handleFocusAddressBar);
  }, []);

  // 同步外部 url 到输入框（仅未聚焦时）
  useEffect(() => {
    if (!isFocused) {
      setInputUrl(url);
    }
  }, [url, isFocused]);

  // 检查收藏状态
  useEffect(() => {
    if (url && url.startsWith("http")) {
      browserIsBookmarked(url).then(setIsBookmarked).catch(() => setIsBookmarked(false));
    } else {
      setIsBookmarked(false);
    }
  }, [url]);

  // 点击外部关闭下拉
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (isTauri()) {
        if (!inputRef.current?.contains(e.target as Node)) {
          setShowSuggestions(false);
          if (tabId) void browserHideAddressSuggestions(tabId);
        }
        return;
      }
      if (suggestionsRef.current && !suggestionsRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [tabId]);

  useEffect(() => {
    if (!isTauri() || !tabId) return;
    let unlisten: (() => void) | undefined;
    void browserListenAddressSuggestionSelected(({ tabId: selectedTabId, url: selectedUrl }) => {
      if (selectedTabId !== tabId) return;
      setInputUrl(selectedUrl);
      setShowSuggestions(false);
      onNavigate(selectedUrl);
    }).then((dispose) => { unlisten = dispose; });
    return () => {
      unlisten?.();
      void browserHideAddressSuggestions(tabId);
    };
  }, [onNavigate, tabId]);

  // 搜索建议（防抖）
  const fetchSuggestions = useCallback((query: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!query.trim()) {
      setSuggestions([]);
      setShowSuggestions(false);
      if (isTauri() && tabId) void browserHideAddressSuggestions(tabId);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      try {
        const results = await browserSearchSuggestions(query, 8);
        setSuggestions(results);
        setShowSuggestions(results.length > 0);
        setSelectedIdx(-1);
        if (isTauri() && tabId && inputRef.current && results.length > 0) {
          const rect = inputRef.current.getBoundingClientRect();
          void browserShowAddressSuggestions({
            tabId,
            left: rect.left,
            top: rect.bottom + 4,
            width: rect.width,
            suggestions: results,
          });
        } else if (isTauri() && tabId) {
          void browserHideAddressSuggestions(tabId);
        }
      } catch {
        setSuggestions([]);
        setShowSuggestions(false);
        if (isTauri() && tabId) void browserHideAddressSuggestions(tabId);
      }
    }, 150);
  }, [tabId]);

  const handleFocus = () => {
    setIsFocused(true);
    if (inputUrl.trim()) {
      fetchSuggestions(inputUrl);
    }
  };

  const handleBlur = () => {
    setTimeout(() => {
      setIsFocused(false);
      setShowSuggestions(false);
      if (isTauri() && tabId) void browserHideAddressSuggestions(tabId);
    }, 200);
  };

  const handleInputChange = (value: string) => {
    setInputUrl(value);
    fetchSuggestions(value);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = inputUrl.trim();
    if (!trimmed) return;
    const finalUrl = normalizeUrlOrSearch(trimmed);
    onNavigate(finalUrl);
    setShowSuggestions(false);
    if (isTauri() && tabId) void browserHideAddressSuggestions(tabId);
  };

  const handleSelectSuggestion = (suggestion: AddressBarSuggestion) => {
    setInputUrl(suggestion.url);
    onNavigate(suggestion.url);
    setShowSuggestions(false);
    if (isTauri() && tabId) void browserHideAddressSuggestions(tabId);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!showSuggestions || suggestions.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIdx((prev) => (prev < suggestions.length - 1 ? prev + 1 : prev));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIdx((prev) => (prev > 0 ? prev - 1 : -1));
    } else if (e.key === "Enter" && selectedIdx >= 0) {
      e.preventDefault();
      handleSelectSuggestion(suggestions[selectedIdx]);
    } else if (e.key === "Escape") {
      setShowSuggestions(false);
      if (isTauri() && tabId) void browserHideAddressSuggestions(tabId);
    }
  };

  const toggleBookmark = async () => {
    try {
      if (isBookmarked) {
        await browserRemoveBookmark(url);
        setIsBookmarked(false);
        // 同步删除 hoard 记忆（非阻塞，失败不影响书签删除）
        try {
          const { hoardDeleteByUrl } = await import("@/lib/hoard-api");
          await hoardDeleteByUrl(url);
          window.dispatchEvent(new Event("hoard-changed"));
        } catch (hoardErr) {
          console.error("[BrowserToolbar] delete from hoard failed:", hoardErr);
        }
      } else {
        await browserAddBookmark(url, title || url);
        setIsBookmarked(true);
        // 同步到收藏记忆（非阻塞，失败不影响书签添加）
        try {
          const { hoardAdd } = await import("@/lib/hoard-api");
          await hoardAdd({
            title: title || url,
            url,
            source: "browser",
            sourceRef: url,
          });
          window.dispatchEvent(new Event("hoard-changed"));
        } catch (hoardErr) {
          console.error("[BrowserToolbar] sync to hoard failed:", hoardErr);
        }
      }
      window.dispatchEvent(new Event("bookmark-changed"));
    } catch (e) {
      console.error("[BrowserToolbar] toggle bookmark failed:", e);
    }
  };

  const handleClearHistory = async () => {
    try {
      await browserClearHistory();
    } catch (e) {
      console.error("[BrowserToolbar] clear history failed:", e);
    }
  };

  const handleClearCache = async () => {
    try {
      await browserClearCache();
    } catch (e) {
      console.error("[BrowserToolbar] clear cache failed:", e);
    }
  };

  const collectChromeBookmarks = useCallback((
    node: ChromeBookmarkNode,
    folderPath: string,
    out: ImportBookmarkItem[],
  ) => {
    if (node.type === "url" && node.url) {
      out.push({
        url: node.url,
        title: node.name || node.url,
        folder: folderPath,
      });
    } else if (node.type === "folder" && node.children) {
      const nextPath = folderPath ? `${folderPath}/${node.name || "未命名文件夹"}` : (node.name || "");
      for (const child of node.children) {
        collectChromeBookmarks(child, nextPath, out);
      }
    }
  }, []);

  const handleImportChromeBookmarks = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [
          { name: "Chrome 书签", extensions: ["json"] },
          { name: "所有文件", extensions: ["*"] },
        ],
      });
      if (!selected || Array.isArray(selected)) return;

      const { readTextFile } = await import("@tauri-apps/plugin-fs");
      const content = await readTextFile(selected);
      const data: ChromeBookmarksJson = JSON.parse(content);

      const items: ImportBookmarkItem[] = [];
      if (data.roots) {
        for (const root of Object.values(data.roots)) {
          if (root) collectChromeBookmarks(root, "", items);
        }
      }

      if (items.length === 0) {
        // eslint-disable-next-line no-alert
        alert("未找到可导入的书签，请确认选择的是 Chrome 的 Bookmarks 文件。");
        return;
      }

      const imported = await browserImportBookmarks(items);
      window.dispatchEvent(new Event("bookmark-changed"));
      // eslint-disable-next-line no-alert
      alert(`成功导入 ${imported} 条书签。`);
    } catch (e) {
      console.error("[BrowserToolbar] import Chrome bookmarks failed:", e);
      // eslint-disable-next-line no-alert
      alert(`导入失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleOpenDownloads = () => {
    const rect = downloadButtonRef.current?.getBoundingClientRect();
    if (!rect) return;
    void browserShowDownloads({
      left: Math.max(8, rect.right - 360),
      top: rect.bottom + 6,
    });
  };

  const handleOpenOptions = async () => {
    try {
      const { Menu } = await import("@tauri-apps/api/menu");
      const menu = await Menu.new({
        items: [
          { text: "书签栏", checked: bookmarkBarVisible, action: onToggleBookmarkBar },
          { item: "Separator" },
          ...(onFind ? [{ text: "查找 (Ctrl+F)", action: onFind }] : []),
          ...(onPrint ? [{ text: "打印", action: onPrint }] : []),
          ...(onViewSource ? [{ text: "查看源码", action: onViewSource }] : []),
          ...((onZoomIn || onZoomOut || onZoomReset) ? [
            { item: "Separator" as const },
            ...(onZoomIn ? [{ text: "放大", action: onZoomIn }] : []),
            ...(onZoomOut ? [{ text: "缩小", action: onZoomOut }] : []),
            ...(onZoomReset ? [{ text: "重置缩放", action: onZoomReset }] : []),
          ] : []),
          { item: "Separator" },
          { text: "清理历史记录", action: handleClearHistory },
          ...(onOpenHistory ? [{ text: "历史记录", action: onOpenHistory }] : []),
          { text: "下载记录", action: handleOpenDownloads },
          { text: "清理缓存", action: handleClearCache },
          { item: "Separator" },
          ...(onToggleMute ? [{ text: isMuted ? "取消静音" : "静音标签", action: onToggleMute }] : []),
          ...(onToggleAdBlock ? [{ text: adBlockEnabled ? "关闭广告拦截" : "开启广告拦截", action: onToggleAdBlock }] : []),
          ...(onOpenCookieManager ? [{ text: "Cookie 管理器", action: onOpenCookieManager }] : []),
          ...(onToggleDarkMode ? [{ text: isDarkMode ? "关闭暗色模式" : "开启暗色模式", action: onToggleDarkMode }] : []),
          ...(onShare ? [{ text: "分享 / 二维码", action: onShare }] : []),
          ...(onCreateNote ? [{ text: "生成 Markdown 笔记", action: onCreateNote }] : []),
          { item: "Separator" },
          ...(onOpenDevtools ? [{ text: "开发者工具", action: onOpenDevtools }] : []),
          { item: "Separator" },
          { text: "导入 Chrome 书签", action: handleImportChromeBookmarks },
        ],
      });
      try {
        await menu.popup();
      } finally {
        await menu.close();
      }
    } catch (e) {
      console.error("[BrowserToolbar] open options menu failed:", e);
    }
  };

  return (
    <div className="flex h-8 items-center gap-1.5 border-b border-border/50 bg-background/95 px-2">
      <Button variant="ghost" size="icon" className="h-6 w-6" title="后退" onClick={onGoBack}>
        <ArrowLeft className="h-3 w-3" />
      </Button>
      <Button variant="ghost" size="icon" className="h-6 w-6" title="前进" onClick={onGoForward}>
        <ArrowRight className="h-3 w-3" />
      </Button>
      <Button variant="ghost" size="icon" className="h-6 w-6" title="刷新" onClick={onReload}>
        <RotateCw className="h-3 w-3" />
      </Button>
      <form onSubmit={handleSubmit} className="flex-1 relative">
        <div className="flex items-center gap-1.5">
          {url.startsWith("https://") ? (
            <Lock className="h-3 w-3 shrink-0 text-muted-foreground" />
          ) : (
            <Globe className="h-3 w-3 shrink-0 text-muted-foreground" />
          )}
          <Input
            ref={inputRef}
            value={inputUrl}
            onChange={(e) => handleInputChange(e.target.value)}
            onFocus={handleFocus}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            className="h-6 rounded-full border-0 bg-muted/50 text-[12px] px-2"
            placeholder="输入网址或搜索..."
          />
        </div>

        {/* 地址栏下拉建议 */}
        {!isTauri() && showSuggestions && suggestions.length > 0 && (
          <div
            ref={suggestionsRef}
            className="absolute left-0 right-0 top-full z-50 mt-1 overflow-hidden rounded-lg border border-border bg-popover shadow-md"
          >
            {suggestions.map((s, i) => (
              <button
                key={s.url}
                type="button"
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-accent transition-colors ${
                  i === selectedIdx ? "bg-accent" : ""
                }`}
                onMouseDown={() => handleSelectSuggestion(s)}
                onMouseEnter={() => setSelectedIdx(i)}
              >
                {s.isBookmark ? (
                  <Star className="h-3 w-3 shrink-0 fill-yellow-500 text-yellow-500" />
                ) : (
                  <Search className="h-3 w-3 shrink-0 text-muted-foreground" />
                )}
                <div className="flex-1 min-w-0">
                  <div className="truncate font-medium">{s.title || s.url}</div>
                  <div className="truncate text-muted-foreground">{s.url}</div>
                </div>
              </button>
            ))}
          </div>
        )}
      </form>

      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6"
        title={isBookmarked ? "取消收藏" : "收藏"}
        onClick={toggleBookmark}
      >
        <Star
          className={`h-3 w-3 ${isBookmarked ? "fill-yellow-500 text-yellow-500" : ""}`}
        />
      </Button>

      <Button
        ref={downloadButtonRef}
        variant="ghost"
        size="icon"
        className="h-6 w-6"
        title="下载"
        onClick={handleOpenDownloads}
      >
        <Download className="h-3 w-3" />
      </Button>

      {/* 全屏按钮 - AI 按钮左边 */}
      {onToggleFullscreen && (
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          title={isFullscreen ? "退出全屏 (F11)" : "全屏 (F11)"}
          onClick={isFullscreen ? onExitFullscreen : onToggleFullscreen}
        >
          {isFullscreen ? (
            <Minimize className="h-3 w-3" />
          ) : (
            <Maximize className="h-3 w-3" />
          )}
        </Button>
      )}

      {/* 选项按钮 - 下拉菜单 */}
      {isTauri() ? (
        <Button variant="ghost" size="icon" className="h-6 w-6" title="选项" onClick={handleOpenOptions}>
          <Settings2 className="h-3 w-3" />
        </Button>
      ) : (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="h-6 w-6" title="选项">
            <Settings2 className="h-3 w-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" side="top" className="w-48">
          <DropdownMenuCheckboxItem
            checked={bookmarkBarVisible}
            onCheckedChange={() => onToggleBookmarkBar()}
          >
            <BookmarkPlus className="mr-2 h-3.5 w-3.5" />
            书签栏
          </DropdownMenuCheckboxItem>
          <DropdownMenuSeparator />
          {onFind && (
            <DropdownMenuItem onClick={onFind}>
              <FindIcon className="mr-2 h-3.5 w-3.5" />
              查找 (Ctrl+F)
            </DropdownMenuItem>
          )}
          {onPrint && (
            <DropdownMenuItem onClick={onPrint}>
              <Printer className="mr-2 h-3.5 w-3.5" />
              打印
            </DropdownMenuItem>
          )}
          {onViewSource && (
            <DropdownMenuItem onClick={onViewSource}>
              <Code className="mr-2 h-3.5 w-3.5" />
              查看源码
            </DropdownMenuItem>
          )}
          {(onZoomIn || onZoomOut || onZoomReset) && (
            <>
              <DropdownMenuSeparator />
              {onZoomIn && (
                <DropdownMenuItem onClick={onZoomIn}>
                  <ZoomIn className="mr-2 h-3.5 w-3.5" />
                  放大
                </DropdownMenuItem>
              )}
              {onZoomOut && (
                <DropdownMenuItem onClick={onZoomOut}>
                  <ZoomOut className="mr-2 h-3.5 w-3.5" />
                  缩小
                </DropdownMenuItem>
              )}
              {onZoomReset && (
                <DropdownMenuItem onClick={onZoomReset}>
                  <RotateCw className="mr-2 h-3.5 w-3.5" />
                  重置缩放
                </DropdownMenuItem>
              )}
            </>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={handleClearHistory}>
            <Trash2 className="mr-2 h-3.5 w-3.5" />
            清理历史记录
          </DropdownMenuItem>
          {onOpenHistory && (
            <DropdownMenuItem onClick={onOpenHistory}>
              <Clock className="mr-2 h-3.5 w-3.5" />
              历史记录
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={handleOpenDownloads}>
            <Download className="mr-2 h-3.5 w-3.5" />
            下载记录
          </DropdownMenuItem>
          <DropdownMenuItem onClick={handleClearCache}>
            <HardDrive className="mr-2 h-3.5 w-3.5" />
            清理缓存
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {/* 隐私安全 */}
          {onToggleMute && (
            <DropdownMenuItem onClick={onToggleMute}>
              {isMuted ? (
                <VolumeX className="mr-2 h-3.5 w-3.5" />
              ) : (
                <Volume2 className="mr-2 h-3.5 w-3.5" />
              )}
              {isMuted ? "取消静音" : "静音标签"}
            </DropdownMenuItem>
          )}
          {onToggleAdBlock && (
            <DropdownMenuItem onClick={onToggleAdBlock}>
              {adBlockEnabled ? (
                <Shield className="mr-2 h-3.5 w-3.5" />
              ) : (
                <ShieldOff className="mr-2 h-3.5 w-3.5" />
              )}
              {adBlockEnabled ? "关闭广告拦截" : "开启广告拦截"}
            </DropdownMenuItem>
          )}
          {onOpenCookieManager && (
            <DropdownMenuItem onClick={onOpenCookieManager}>
              <Cookie className="mr-2 h-3.5 w-3.5" />
              Cookie 管理器
            </DropdownMenuItem>
          )}
          {onToggleDarkMode && (
            <DropdownMenuItem onClick={onToggleDarkMode}>
              {isDarkMode ? (
                <Sun className="mr-2 h-3.5 w-3.5" />
              ) : (
                <Moon className="mr-2 h-3.5 w-3.5" />
              )}
              {isDarkMode ? "关闭暗色模式" : "开启暗色模式"}
            </DropdownMenuItem>
          )}
          {onShare && (
            <DropdownMenuItem onClick={onShare}>
              <Share2 className="mr-2 h-3.5 w-3.5" />
              分享 / 二维码
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          {onOpenDevtools && (
            <DropdownMenuItem onClick={onOpenDevtools}>
              <Terminal className="mr-2 h-3.5 w-3.5" />
              开发者工具
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={handleImportChromeBookmarks}>
            <Upload className="mr-2 h-3.5 w-3.5" />
            导入 Chrome 书签
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      )}

      {/* 无痕模式指示器 */}
      {isIncognito && (
        <div className="flex items-center gap-1 px-2 text-xs text-muted-foreground" title="无痕模式">
          <Eye className="h-3.5 w-3.5" />
        </div>
      )}

      {/* AI 按钮 */}
      <button
        type="button"
        onClick={onToggleAiPanel}
        title="Mona"
        className={`flex h-6 w-6 items-center justify-center rounded-md transition-colors ${
          isAiPanelOpen ? "bg-primary/15" : "hover:bg-muted/60"
        }`}
      >
        <AgentLogo state={isAiControlled ? "working" : "idle"} className="h-5 w-5" />
      </button>
    </div>
  );
}
