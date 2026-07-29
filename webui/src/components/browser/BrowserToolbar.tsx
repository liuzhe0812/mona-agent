import { ArrowLeft, ArrowRight, RotateCw, Star, Search, Maximize, Minimize, Settings2, Trash2, HardDrive, Download, FileText, Loader2, BookmarkPlus, Upload, ZoomIn, ZoomOut, Printer, Code, Search as FindIcon, Clock, Cookie, Volume2, VolumeX, Shield, ShieldOff, Eye, Terminal, Moon, Sun, Share2 } from "lucide-react";
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
  type AddressBarSuggestion,
  type ImportBookmarkItem,
} from "@/lib/browser-ipc";
import { isTauri } from "@/lib/tauri";
import { browserShowDownloads, browserToggleDownloads, browserHideDownloads, type DownloadPopupAnchor } from "@/lib/browser-ipc";
import { useDownloads } from "@/hooks/useDownloads";

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

/** 下载按钮上的环形进度：progress 为 null 时无限旋转（总大小未知） */
function DownloadProgressRing({ progress }: { progress: number | null }) {
  const r = 7.5;
  const c = 2 * Math.PI * r;
  return (
    <svg
      className={`pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 ${progress === null ? "animate-spin" : ""}`}
      width={18}
      height={18}
      viewBox="0 0 18 18"
    >
      <circle cx="9" cy="9" r={r} fill="none" className="stroke-muted-foreground/25" strokeWidth="1.5" />
      <circle
        cx="9"
        cy="9"
        r={r}
        fill="none"
        className="stroke-blue-500"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeDasharray={progress === null ? `${c * 0.3} ${c * 0.7}` : c}
        strokeDashoffset={progress === null ? 0 : c * (1 - progress)}
        transform="rotate(-90 9 9)"
      />
    </svg>
  );
}

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
  onEditorOpenChange?: (open: boolean) => void;
  onToggleFullscreen?: () => void;
  onExitFullscreen?: () => void;
  onFind?: () => void;
  onPrint?: () => void;
  onViewSource?: () => void;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  onZoomReset?: () => void;
  onOpenHistory?: () => void;
  onOpenDownloads?: () => void;
  onOpenCookieManager?: () => void;
  onToggleMute?: () => void;
  onToggleAdBlock?: () => void;
  onToggleDarkMode?: () => void;
  onOpenDevtools?: () => void;
  onShare?: () => void;
  onCreateNote?: () => void;
  isCreatingNote?: boolean;
}

export function BrowserToolbar({
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
  onEditorOpenChange,
  onToggleFullscreen,
  onExitFullscreen,
  onFind,
  onPrint,
  onViewSource,
  onZoomIn,
  onZoomOut,
  onZoomReset,
  onOpenHistory,
  onOpenDownloads,
  onOpenCookieManager,
  onToggleMute,
  onToggleAdBlock,
  onToggleDarkMode,
  onOpenDevtools,
  onShare,
  onCreateNote,
  isCreatingNote = false,
}: BrowserToolbarProps) {
  const [inputUrl, setInputUrl] = useState(url);
  const [isFocused, setIsFocused] = useState(false);
  const [isBookmarked, setIsBookmarked] = useState(false);
  const [suggestions, setSuggestions] = useState<AddressBarSuggestion[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(-1);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorValue, setEditorValue] = useState("");
  const suggestionsRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const inputRef = useRef<HTMLInputElement>(null);
  const editorInputRef = useRef<HTMLInputElement>(null);
  const downloadButtonRef = useRef<HTMLButtonElement>(null);
  const { downloads, hasActiveDownloads } = useDownloads();
  const autoHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 活跃下载的总进度（0~1）；总大小未知时为 null（显示无限旋转）
  const activeProgress = (() => {
    if (!hasActiveDownloads) return null;
    const active = downloads.filter((d) => d.state === "in_progress" || d.state === "interrupted");
    const total = active.reduce((sum, d) => sum + (d.totalBytes > 0 ? d.totalBytes : 0), 0);
    if (total <= 0) return null;
    const received = active.reduce((sum, d) => sum + d.receivedBytes, 0);
    return Math.min(1, received / total);
  })();

  // 计算下载弹窗锚点（按钮右下对齐）；按钮不可见（隐藏 tab）时返回 null
  const getDownloadAnchor = useCallback((): DownloadPopupAnchor | null => {
    const rect = downloadButtonRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return null;
    return { left: Math.max(8, rect.right - 360), top: rect.bottom + 6 };
  }, []);

  const clearAutoHideTimer = useCallback(() => {
    if (autoHideTimerRef.current) {
      clearTimeout(autoHideTimerRef.current);
      autoHideTimerRef.current = null;
    }
  }, []);

  // 新下载启动时自动短暂弹出提示（悬浮窗，5 秒后自动隐藏）
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      unlisten = await listen("browser-download-started", () => {
        const anchor = getDownloadAnchor();
        if (!anchor) return;
        void browserShowDownloads(anchor);
        clearAutoHideTimer();
        autoHideTimerRef.current = setTimeout(() => {
          void browserHideDownloads();
        }, 5000);
      });
    })();
    return () => unlisten?.();
  }, [getDownloadAnchor, clearAutoHideTimer]);

  // 用户与弹窗交互后取消自动隐藏；组件卸载时清理 timer
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      unlisten = await listen("browser-downloads-interacted", () => {
        clearAutoHideTimer();
      });
    })();
    return () => {
      unlisten?.();
      clearAutoHideTimer();
    };
  }, [clearAutoHideTimer]);

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

  // 同步外部 url 到输入框（仅未聚焦且编辑器未打开时）
  useEffect(() => {
    if (!isFocused && !editorOpen) {
      setInputUrl(url);
    }
  }, [url, isFocused, editorOpen]);

  // 检查收藏状态
  useEffect(() => {
    if (url && url.startsWith("http")) {
      browserIsBookmarked(url).then(setIsBookmarked).catch(() => setIsBookmarked(false));
    } else {
      setIsBookmarked(false);
    }
  }, [url]);

  // 点击外部关闭编辑器
  useEffect(() => {
    if (!editorOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (suggestionsRef.current?.contains(e.target as Node)) return;
      if (inputRef.current?.contains(e.target as Node)) return;
      closeEditor();
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [editorOpen]);

  // 搜索建议（防抖）
  const fetchSuggestions = useCallback((query: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!query.trim()) {
      setSuggestions([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      try {
        const results = await browserSearchSuggestions(query, 8);
        setSuggestions(results);
        setSelectedIdx(-1);
      } catch {
        setSuggestions([]);
      }
    }, 150);
  }, []);

  const handleFocus = () => {
    setIsFocused(true);
    requestAnimationFrame(() => inputRef.current?.select());
  };

  const handleBlur = () => {
    setTimeout(() => {
      setIsFocused(false);
    }, 150);
  };

  const handleInputChange = (value: string) => {
    setInputUrl(value);
    openEditor(value);
  };

  // 打开内联编辑器浮层（输入第一个字符时触发）
  const openEditor = (initialValue: string) => {
    if (editorOpen) return;
    setEditorValue(initialValue);
    setEditorOpen(true);
    setSelectedIdx(-1);
    onEditorOpenChange?.(true);
    // 请求建议
    fetchSuggestions(initialValue);
    // 同步建议到编辑器
    requestAnimationFrame(() => {
      editorInputRef.current?.focus();
      const len = initialValue.length;
      editorInputRef.current?.setSelectionRange(len, len);
    });
  };

  const closeEditor = () => {
    setEditorOpen(false);
    setEditorValue("");
    setSuggestions([]);
    setSelectedIdx(-1);
    setInputUrl(url);
    onEditorOpenChange?.(false);
  };

  const commitEditor = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) {
      closeEditor();
      return;
    }
    const finalUrl = normalizeUrlOrSearch(trimmed);
    setInputUrl(finalUrl);
    setEditorOpen(false);
    setEditorValue("");
    setSuggestions([]);
    setSelectedIdx(-1);
    onEditorOpenChange?.(false);
    if (finalUrl) onNavigate(finalUrl);
  };

  const handleEditorChange = (value: string) => {
    setEditorValue(value);
    fetchSuggestions(value);
  };

  const handleEditorKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIdx((prev) => (suggestions.length > 0 ? (prev < suggestions.length - 1 ? prev + 1 : prev) : -1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIdx((prev) => (prev > 0 ? prev - 1 : -1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      commitEditor(selectedIdx >= 0 ? suggestions[selectedIdx].url : editorValue);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeEditor();
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (editorOpen) return;
    const trimmed = inputUrl.trim();
    if (!trimmed) return;
    const finalUrl = normalizeUrlOrSearch(trimmed);
    onNavigate(finalUrl);
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
    const anchor = getDownloadAnchor();
    if (!anchor) {
      console.warn("[BrowserToolbar] download anchor is null");
      return;
    }
    clearAutoHideTimer();
    void browserToggleDownloads(anchor).catch((e) => {
      console.error("[BrowserToolbar] browserToggleDownloads failed:", e);
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
          ...(onOpenDownloads ? [{ text: "下载记录", action: onOpenDownloads }] : []),
          { text: "清理缓存", action: handleClearCache },
          { item: "Separator" },
          ...(onToggleMute ? [{ text: isMuted ? "取消静音" : "静音标签", action: onToggleMute }] : []),
          ...(onToggleAdBlock ? [{ text: adBlockEnabled ? "关闭广告拦截" : "开启广告拦截", action: onToggleAdBlock }] : []),
          ...(onOpenCookieManager ? [{ text: "Cookie 管理器", action: onOpenCookieManager }] : []),
          ...(onToggleDarkMode ? [{ text: isDarkMode ? "关闭暗色模式" : "开启暗色模式", action: onToggleDarkMode }] : []),
          ...(onShare ? [{ text: "分享 / 二维码", action: onShare }] : []),
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
    <div className="relative z-50 flex h-8 items-center gap-1.5 border-b border-border/50 bg-background/95 px-2">
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
        {/* 地址栏（非编辑态） */}
        {!editorOpen && (
          <Input
            ref={inputRef}
            value={inputUrl}
            onChange={(e) => handleInputChange(e.target.value)}
            onFocus={handleFocus}
            onBlur={handleBlur}
            className="h-6 rounded-full border-0 bg-muted/50 text-[12px] px-2 focus-visible:ring-2 focus-visible:ring-blue-500/50 focus-visible:ring-offset-0"
            placeholder="输入网址或搜索..."
          />
        )}

        {/* 整体浮层：输入框 + 历史记录（编辑态，覆盖地址栏区域） */}
        {editorOpen && (
          <div
            ref={suggestionsRef}
            className="absolute left-0 right-0 top-0 z-50 -translate-y-4 rounded-lg border border-border bg-popover shadow-lg overflow-hidden"
          >
            <div className="flex items-center gap-1.5 px-2 h-8 border-b border-border/50">
              <Search className="h-3 w-3 shrink-0 text-muted-foreground" />
              <input
                ref={editorInputRef}
                value={editorValue}
                onChange={(e) => handleEditorChange(e.target.value)}
                onKeyDown={handleEditorKeyDown}
                onBlur={() => {
                  // 延迟关闭，让 onMouseDown 类事件先触发
                  setTimeout(() => {
                    if (!editorOpen) return;
                    closeEditor();
                  }, 150);
                }}
                autoFocus
                className="h-6 flex-1 bg-transparent text-[12px] outline-none border-0 px-0"
                placeholder="输入网址或搜索..."
              />
            </div>
            {suggestions.length > 0 && (
              <div className="overflow-y-auto scrollbar-thin max-h-[60vh]">
                {suggestions.map((s, i) => (
                  <button
                    key={s.url}
                    type="button"
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-accent transition-colors ${
                      i === selectedIdx ? "bg-accent" : ""
                    }`}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      commitEditor(s.url);
                    }}
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
        className="relative h-6 w-6"
        title="下载"
        onClick={() => onOpenDownloads?.() ?? handleOpenDownloads()}
      >
        <Download className="h-3 w-3" />
        {hasActiveDownloads && <DownloadProgressRing progress={activeProgress} />}
      </Button>

      {onCreateNote && (
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          title="提取为笔记"
          disabled={isCreatingNote}
          onClick={onCreateNote}
        >
          {isCreatingNote ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <FileText className="h-3 w-3" />
          )}
        </Button>
      )}

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
          {onOpenDownloads && (
            <DropdownMenuItem onClick={onOpenDownloads}>
              <Download className="mr-2 h-3.5 w-3.5" />
              下载记录
            </DropdownMenuItem>
          )}
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
