import { useEffect, useRef, useCallback, useState } from "react";
import { BrowserToolbar } from "./BrowserToolbar";
import { AiAssistantPanel } from "./AiAssistantPanel";
import { BookmarkBar } from "./BookmarkBar";
import type { Tab } from "@/hooks/useBrowserTabs";
import type { ChatSummary } from "@/lib/types";
import { isTauri } from "@/lib/tauri";

interface BrowserTabViewProps {
  tab: Tab;
  isVisible: boolean;
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
  onExitFullscreen?: () => void;
  session: ChatSummary | null;
  onNavigate: (url: string) => void;
  onGoBack: () => void;
  onGoForward: () => void;
  onReload: () => void;
  onUrlChange?: (url: string) => void;
}

export function BrowserTabView({
  tab,
  isVisible,
  isFullscreen = false,
  onToggleFullscreen,
  onExitFullscreen,
  session,
  onNavigate,
  onGoBack,
  onGoForward,
  onReload,
  onUrlChange,
}: BrowserTabViewProps) {
  const webviewContainerRef = useRef<HTMLDivElement>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const lastBoundsRef = useRef<{ left: number; top: number; width: number; height: number } | null>(null);
  const [isAiPanelOpen, setIsAiPanelOpen] = useState(false);
  const [bookmarkBarVisible, setBookmarkBarVisible] = useState(true);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  // 全屏模式下鼠标悬停顶部时显示工具栏
  const [showFullscreenToolbar, setShowFullscreenToolbar] = useState(false);
  const toolbarHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 更新子 WebView 位置和大小
  const updateWebviewBounds = useCallback(async () => {
    if (!isTauri() || !tab.webviewCreated) return;

    try {
      const { Webview } = await import("@tauri-apps/api/webview");
      const { LogicalPosition, LogicalSize } = await import("@tauri-apps/api/dpi");
      const webviewLabel = `browser-${tab.id}`;
      const webview = await Webview.getByLabel(webviewLabel);
      if (!webview) return;

      const isAiActive = tab.isAiControlled || !!tab.aiStatus;

      // When a dropdown is open (address bar suggestions, bookmark folder),
      // hide the native WebView so the HTML dropdown can appear on top.
      // The container div will show a white background as placeholder.
      if (dropdownOpen) {
        await webview.hide();
        return;
      }

      if (isVisible && webviewContainerRef.current) {
        const rect = webviewContainerRef.current.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) {
          await webview.hide();
          return;
        }
        // 缓存最后已知的位置
        lastBoundsRef.current = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
        await webview.setPosition(new LogicalPosition(rect.left, rect.top));
        await webview.setSize(new LogicalSize(rect.width, rect.height));
        await webview.show();
      } else if (isAiActive && lastBoundsRef.current) {
        // AI 控制中但标签不可见：使用缓存的位置并隐藏
        // 这样 Playwright CDP 操作（click/screenshot）不会因 WebView 不可见而失败
        const { left, top, width, height } = lastBoundsRef.current;
        await webview.setPosition(new LogicalPosition(left, top));
        await webview.setSize(new LogicalSize(width, height));
        await webview.hide();
      } else {
        // 非活跃且非 AI 控制：隐藏并移到屏幕外
        await webview.hide();
        await webview.setPosition(new LogicalPosition(-9999, -9999));
      }
    } catch (e) {
      console.debug("[BrowserTabView] updateWebviewBounds error:", e);
    }
  }, [tab.id, tab.webviewCreated, tab.isAiControlled, tab.aiStatus, isVisible, dropdownOpen]);

  // 下拉菜单开关时立即更新 WebView 位置（无延迟）
  useEffect(() => {
    if (!tab.webviewCreated) return;
    updateWebviewBounds();
  }, [dropdownOpen, tab.webviewCreated, updateWebviewBounds]);

  // 当 WebView 创建后或可见性变化时，更新位置
  useEffect(() => {
    if (!tab.webviewCreated) return;

    // 标签变为可见时立即显示 WebView，避免下方视图（如终端）的残影透出
    let rafId: number | undefined;
    if (isVisible) {
      rafId = requestAnimationFrame(() => {
        updateWebviewBounds();
      });
    }

    const timer = setTimeout(() => {
      requestAnimationFrame(() => {
        updateWebviewBounds();
      });
    }, isVisible ? 50 : 0);

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      clearTimeout(timer);
    };
  }, [tab.webviewCreated, isVisible, isAiPanelOpen, isFullscreen, showFullscreenToolbar, updateWebviewBounds]);

  // AI Panel 开关时，延迟再次更新 WebView 位置（确保 DOM 已完成布局）
  useEffect(() => {
    if (!tab.webviewCreated || !isVisible) return;
    const timer = setTimeout(() => {
      updateWebviewBounds();
    }, 200);
    return () => clearTimeout(timer);
  }, [isAiPanelOpen, tab.webviewCreated, isVisible, updateWebviewBounds]);

  // 监听容器大小变化
  useEffect(() => {
    if (!webviewContainerRef.current) return;

    const observer = new ResizeObserver(() => {
      updateWebviewBounds();
    });
    observer.observe(webviewContainerRef.current);
    resizeObserverRef.current = observer;

    const handleResize = () => updateWebviewBounds();
    window.addEventListener("resize", handleResize, { passive: true });

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", handleResize);
      resizeObserverRef.current = null;
    };
  }, [updateWebviewBounds]);

  // 监听 WebView URL 变化（通过 Rust 侧 emit 事件）
  useEffect(() => {
    if (!isTauri() || !tab.webviewCreated) return;

    let unlisten: (() => void) | undefined;

    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      unlisten = await listen<{ id: string; url: string; title: string }>(
        "browser-url-changed",
        (event) => {
          if (event.payload.id === tab.id && onUrlChange) {
            onUrlChange(event.payload.url);
          }
        }
      );
    })();

    return () => {
      unlisten?.();
    };
  }, [tab.id, tab.webviewCreated, onUrlChange]);

  // 全屏模式下鼠标移到顶部区域显示工具栏，移开后自动隐藏
  const handleFullscreenMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isFullscreen) return;
    if (e.clientY < 50) {
      setShowFullscreenToolbar(true);
      // 重置隐藏计时器
      if (toolbarHideTimerRef.current) clearTimeout(toolbarHideTimerRef.current);
    }
  }, [isFullscreen]);

  const handleFullscreenToolbarLeave = useCallback(() => {
    if (!isFullscreen) return;
    toolbarHideTimerRef.current = setTimeout(() => {
      setShowFullscreenToolbar(false);
    }, 800);
  }, [isFullscreen]);

  // 清理计时器
  useEffect(() => {
    return () => {
      if (toolbarHideTimerRef.current) clearTimeout(toolbarHideTimerRef.current);
    };
  }, []);

  const isAiActive = tab.isAiControlled || !!tab.aiStatus;

  // 全屏模式：工具栏悬浮在 WebView 上方
  if (isFullscreen) {
    return (
      <div
        className="flex h-full flex-col relative"
        style={{ display: isVisible ? "flex" : "none" }}
        onMouseMove={handleFullscreenMouseMove}
      >
        {/* WebView 占满整个区域 */}
        <div ref={webviewContainerRef} className="flex-1 min-h-0 bg-white" />

        {/* 悬浮工具栏：鼠标移到顶部时显示 */}
        {showFullscreenToolbar && (
          <div
            className="absolute top-0 left-0 right-0 z-50"
            onMouseLeave={handleFullscreenToolbarLeave}
          >
            <BrowserToolbar
              url={tab.url ?? ""}
              title={tab.title ?? ""}
              isAiControlled={tab.isAiControlled}
              isAiPanelOpen={isAiPanelOpen}
              isFullscreen={true}
              bookmarkBarVisible={false}
              onNavigate={onNavigate}
              onGoBack={onGoBack}
              onGoForward={onGoForward}
              onReload={onReload}
              onToggleAiPanel={() => setIsAiPanelOpen((prev) => !prev)}
              onToggleBookmarkBar={() => setBookmarkBarVisible((prev) => !prev)}
              onToggleFullscreen={onToggleFullscreen}
              onExitFullscreen={onExitFullscreen}
            />
          </div>
        )}
      </div>
    );
  }

  // 正常模式
  return (
    <div
      className="flex h-full flex-col"
      style={{ display: isVisible ? "flex" : "none" }}
    >
      <BrowserToolbar
        url={tab.url ?? ""}
        title={tab.title ?? ""}
        isAiControlled={tab.isAiControlled}
        isAiPanelOpen={isAiPanelOpen}
        bookmarkBarVisible={bookmarkBarVisible}
        onNavigate={onNavigate}
        onGoBack={onGoBack}
        onGoForward={onGoForward}
        onReload={onReload}
        onToggleAiPanel={() => setIsAiPanelOpen((prev) => !prev)}
        onToggleBookmarkBar={() => setBookmarkBarVisible((prev) => !prev)}
        onToggleFullscreen={onToggleFullscreen}
        onDropdownOpenChange={setDropdownOpen}
      />
      <BookmarkBar onNavigate={onNavigate} visible={bookmarkBarVisible} onDropdownOpenChange={setDropdownOpen} />
      <div className="flex flex-1 min-h-0">
        <div ref={webviewContainerRef} className="flex-1 min-w-0 bg-white relative">
          {!tab.webviewCreated && (
            <div className="flex h-full items-center justify-center text-muted-foreground text-[13px]">
              在地址栏输入网址开始浏览
            </div>
          )}
        </div>
        {isAiPanelOpen && (
          <AiAssistantPanel
            session={session}
            isAiActive={isAiActive}
            pageUrl={tab.url}
            pageTitle={tab.title}
            onClose={() => setIsAiPanelOpen(false)}
            onToggle={() => {
              setTimeout(() => requestAnimationFrame(() => updateWebviewBounds()), 50);
            }}
          />
        )}
      </div>
    </div>
  );
}
