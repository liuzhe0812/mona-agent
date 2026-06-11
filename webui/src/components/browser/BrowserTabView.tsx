import { useEffect, useRef, useCallback } from "react";
import { BrowserToolbar } from "./BrowserToolbar";
import { AiAssistantPanel } from "./AiAssistantPanel";
import type { Tab } from "@/hooks/useBrowserTabs";
import { isTauri } from "@/lib/tauri";

interface BrowserTabViewProps {
  tab: Tab;
  isVisible: boolean;
  onNavigate: (url: string) => void;
  onGoBack: () => void;
  onGoForward: () => void;
  onReload: () => void;
  onUrlChange?: (url: string) => void;
}

export function BrowserTabView({
  tab,
  isVisible,
  onNavigate,
  onGoBack,
  onGoForward,
  onReload,
  onUrlChange,
}: BrowserTabViewProps) {
  const webviewContainerRef = useRef<HTMLDivElement>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const lastBoundsRef = useRef<{ left: number; top: number; width: number; height: number } | null>(null);

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

      if (isVisible && webviewContainerRef.current) {
        const rect = webviewContainerRef.current.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        // 缓存最后已知的位置
        lastBoundsRef.current = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
        await webview.setPosition(new LogicalPosition(rect.left, rect.top));
        await webview.setSize(new LogicalSize(rect.width, rect.height));
      } else if (isAiActive && lastBoundsRef.current) {
        // AI 控制中但标签不可见：使用缓存的位置，不移到屏幕外
        // 这样 Playwright CDP 操作（click/screenshot）不会因 WebView 不可见而失败
        const { left, top, width, height } = lastBoundsRef.current;
        await webview.setPosition(new LogicalPosition(left, top));
        await webview.setSize(new LogicalSize(width, height));
      } else {
        // 非活跃且非 AI 控制：移到屏幕外
        await webview.setPosition(new LogicalPosition(-9999, -9999));
      }
    } catch (e) {
      console.debug("[BrowserTabView] updateWebviewBounds error:", e);
    }
  }, [tab.id, tab.webviewCreated, tab.isAiControlled, tab.aiStatus, isVisible]);

  // 当 WebView 创建后或可见性变化时，更新位置
  useEffect(() => {
    if (!tab.webviewCreated) return;

    const timer = setTimeout(() => {
      requestAnimationFrame(() => {
        updateWebviewBounds();
      });
    }, isVisible ? 100 : 0);

    return () => clearTimeout(timer);
  }, [tab.webviewCreated, isVisible, updateWebviewBounds]);

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

  const isAiActive = tab.isAiControlled || !!tab.aiStatus;

  return (
    <div
      className="flex h-full flex-col"
      style={{ display: isVisible ? "flex" : "none" }}
    >
      <BrowserToolbar
        url={tab.url ?? ""}
        isAiControlled={tab.isAiControlled}
        onNavigate={onNavigate}
        onGoBack={onGoBack}
        onGoForward={onGoForward}
        onReload={onReload}
      />
      <div ref={webviewContainerRef} className="flex-1 min-h-0 bg-white relative">
        {!tab.webviewCreated && (
          <div className="flex h-full items-center justify-center text-muted-foreground text-[13px]">
            在地址栏输入网址开始浏览
          </div>
        )}
      </div>
      <AiAssistantPanel
        isAiActive={isAiActive}
        onToggle={() => {
          // 面板展开/收起后，延迟一帧让布局生效再更新 WebView 大小
          setTimeout(() => requestAnimationFrame(() => updateWebviewBounds()), 50);
        }}
      />
    </div>
  );
}
