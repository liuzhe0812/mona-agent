import { useCallback, useEffect, useState } from "react";
import {
  browserCreateTab,
  browserCloseTab as closeTabIpc,
  browserUpdateTabUrl as updateTabUrlIpc,
  browserUpdateTabTitle as updateTabTitleIpc,
  browserListTabs,
  browserNavigateTab,
  browserGoBack as goBackIpc,
  browserGoForward as goForwardIpc,
  browserReload as reloadIpc,
  browserRecordVisit,
} from "@/lib/browser-ipc";
import { isTauri } from "@/lib/tauri";

export interface Tab {
  id: string;
  type: "mona" | "browser" | "md-reader";
  title: string;
  url?: string;
  favicon?: string;
  isAiControlled: boolean;
  webviewCreated: boolean; // WebView 是否已在 Rust 侧创建
  mdFilePath?: string; // md-reader 类型标签的文件路径
  aiStatus?: {
    description: string;
    steps?: string[];
    needsConfirmation: boolean;
  };
}

const MONA_TAB: Tab = {
  id: "mona",
  type: "mona",
  title: "Mona",
  isAiControlled: false,
  webviewCreated: false,
};

let _tabCounter = 0;

export function useBrowserTabs() {
  const [tabs, setTabs] = useState<Tab[]>([MONA_TAB]);
  const [activeTabId, setActiveTabId] = useState<string>("mona");
  const [browserFullscreen, setBrowserFullscreen] = useState(false);

  // 全屏切换
  const toggleFullscreen = useCallback(async () => {
    if (!isTauri()) return;
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      const isFull = await win.isFullscreen();
      await win.setFullscreen(!isFull);
      setBrowserFullscreen(!isFull);
    } catch (e) {
      console.error("[useBrowserTabs] toggle fullscreen failed:", e);
    }
  }, []);

  const exitFullscreen = useCallback(async () => {
    if (!isTauri()) return;
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      await win.setFullscreen(false);
      setBrowserFullscreen(false);
    } catch (e) {
      console.error("[useBrowserTabs] exit fullscreen failed:", e);
    }
  }, []);

  // F11 切换全屏，Escape 退出全屏
  useEffect(() => {
    if (!isTauri()) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "F11") {
        e.preventDefault();
        void toggleFullscreen();
      } else if (e.key === "Escape" && browserFullscreen) {
        e.preventDefault();
        void exitFullscreen();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [toggleFullscreen, exitFullscreen, browserFullscreen]);

  // 全屏时 WebView 会捕获键盘事件，监听 WebView 内部透传出来的 ESC/F11
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      unlisten = await listen<{ key: string }>("browser-fullscreen-key", (event) => {
        if (cancelled) return;
        if (event.payload.key === "F11") {
          void toggleFullscreen();
        } else if (event.payload.key === "Escape" && browserFullscreen) {
          void exitFullscreen();
        }
      });
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [toggleFullscreen, exitFullscreen, browserFullscreen]);

  // 监听 Tauri 窗口 resize 事件来检测全屏状态变化
  // 视频全屏按钮通过 wry runtime 的 ContainsFullScreenElementChanged 直接设置窗口全屏
  // 前端需要通过窗口事件来同步全屏状态
  useEffect(() => {
    if (!isTauri()) return;
    let mounted = true;
    let unlisten: (() => void) | undefined;

    (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const win = getCurrentWindow();
        unlisten = await win.onResized(async () => {
          if (!mounted) return;
          try {
            const isFull = await win.isFullscreen();
            if (mounted) {
              setBrowserFullscreen((prev) => (prev !== isFull ? isFull : prev));
            }
          } catch {
            // ignore
          }
        });
      } catch {
        // ignore - Tauri API not available
      }
    })();

    return () => {
      mounted = false;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;

    // 同步已有的 Rust 侧标签
    browserListTabs().then((serverTabs) => {
      if (cancelled) return;
      const browserTabs: Tab[] = serverTabs.map((t) => ({
        id: t.id,
        type: "browser" as const,
        title: t.title,
        url: t.url,
        isAiControlled: t.is_ai_controlled,
        webviewCreated: true,
      }));
      setTabs([MONA_TAB, ...browserTabs]);
    }).catch(() => {});

    // 监听 AI 通过 IPC 创建的标签
    let unlistenCreated: (() => void) | undefined;
    let unlistenClosed: (() => void) | undefined;
    let unlistenUrlChanged: (() => void) | undefined;
    let unlistenOpenNewTab: (() => void) | undefined;

    (async () => {
      const { listen } = await import("@tauri-apps/api/event");

      unlistenCreated = await listen<{ id: string; url: string; title: string; cdp_port: number }>(
        "browser-tab-created",
        (event) => {
          const { id, url, title } = event.payload;
          setTabs((prev) => {
            // 避免重复添加
            if (prev.some((t) => t.id === id)) return prev;
            return [...prev, {
              id,
              type: "browser" as const,
              title: title || url,
              url,
              isAiControlled: false,
              webviewCreated: true,
            }];
          });
          setActiveTabId(id);
        }
      );

      unlistenClosed = await listen<string>("browser-tab-closed", (event) => {
        const id = event.payload;
        setTabs((prev) => prev.filter((t) => t.id !== id));
        setActiveTabId((current) => (current === id ? "mona" : current));
      });

      unlistenUrlChanged = await listen<{ id: string; url: string }>(
        "browser-url-changed",
        (event) => {
          const { id, url } = event.payload;
          setTabs((prev) =>
            prev.map((t) => (t.id === id ? { ...t, url } : t))
          );
          // 记录访问历史
          if (url && (url.startsWith("http://") || url.startsWith("https://"))) {
            browserRecordVisit(url, "").catch(() => {});
          }
        }
      );

      // 监听 target="_blank" / window.open 的新标签请求
      unlistenOpenNewTab = await listen<{ url: string }>(
        "browser-open-new-tab",
        (event) => {
          const { url } = event.payload;
          _tabCounter++;
          const id = `tab-${_tabCounter}`;
          const newTab: Tab = {
            id,
            type: "browser",
            title: url,
            url,
            isAiControlled: false,
            webviewCreated: false,
          };
          setTabs((prev) => [...prev, newTab]);
          setActiveTabId(id);
          // 创建 WebView
          browserCreateTab(id, url).then(() => {
            setTabs((prev) =>
              prev.map((t) =>
                t.id === id ? { ...t, webviewCreated: true } : t
              )
            );
          }).catch((e) => {
            console.error("[useBrowserTabs] create tab for new-tab request failed:", e);
          });
        }
      );
    })();

    return () => {
      cancelled = true;
      unlistenCreated?.();
      unlistenClosed?.();
      unlistenUrlChanged?.();
      unlistenOpenNewTab?.();
    };
  }, []);

  // 创建纯 UI 标签（不创建 WebView，等用户输入 URL 后再创建）
  const addEmptyTab = useCallback(() => {
    _tabCounter++;
    const id = `tab-${_tabCounter}`;
    const newTab: Tab = {
      id,
      type: "browser",
      title: "New Tab",
      url: "",
      isAiControlled: false,
      webviewCreated: false,
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(id);
  }, []);

  // 导航到 URL：如果 WebView 已创建则用 navigate，否则创建新 WebView
  const navigateToUrl = useCallback(async (tabId: string, url: string) => {
    if (!isTauri()) return;

    // 确保 URL 有协议前缀
    let normalizedUrl = url;
    if (!/^https?:\/\//i.test(normalizedUrl)) {
      normalizedUrl = `https://${normalizedUrl}`;
    }

    // 查找当前标签状态
    const tab = tabs.find((t) => t.id === tabId);

    if (tab?.webviewCreated) {
      // WebView 已存在，导航到新 URL
      try {
        await browserNavigateTab(tabId, normalizedUrl);
        setTabs((prev) =>
          prev.map((t) =>
            t.id === tabId ? { ...t, url: normalizedUrl, title: normalizedUrl } : t
          )
        );
      } catch (e) {
        console.error("[useBrowserTabs] navigate tab failed:", e);
      }
    } else {
      // WebView 未创建，创建新 WebView
      try {
        await browserCreateTab(tabId, normalizedUrl);
        setTabs((prev) =>
          prev.map((t) =>
            t.id === tabId
              ? { ...t, url: normalizedUrl, title: normalizedUrl, webviewCreated: true }
              : t
          )
        );
      } catch (e) {
        console.error("[useBrowserTabs] create tab failed:", e);
      }
    }
  }, [tabs]);

  // 关闭标签
  const closeTab = useCallback(async (id: string) => {
    if (id === "mona") return;

    const tab = tabs.find((t) => t.id === id);
    if (!tab) return;

    if (isTauri() && tab.webviewCreated) {
      try {
        await closeTabIpc(id);
      } catch (e) {
        console.error("Failed to close browser tab:", e);
      }
    }

    // 关闭 md-reader 标签时，清理 store 中的文件数据
    if (tab.type === "md-reader") {
      const { useMdReaderStore } = await import("@/components/md-reader/mdReaderStore");
      const store = useMdReaderStore.getState();
      const mdTab = store.tabs.find((t) => t.filePath === tab.mdFilePath);
      if (mdTab) {
        store.closeTab(mdTab.id);
      }
    }

    setTabs((prev) => prev.filter((t) => t.id !== id));
    setActiveTabId((current) => (current === id ? "mona" : current));
  }, [tabs]);

  const switchTab = useCallback((id: string) => {
    setActiveTabId(id);
  }, []);

  const updateTabTitle = useCallback((id: string, title: string) => {
    setTabs((prev) =>
      prev.map((t) => (t.id === id ? { ...t, title } : t))
    );
    if (isTauri()) {
      updateTabTitleIpc(id, title).catch(() => {});
    }
  }, []);

  const updateTabUrl = useCallback((id: string, url: string) => {
    setTabs((prev) =>
      prev.map((t) => (t.id === id ? { ...t, url } : t))
    );
    if (isTauri()) {
      updateTabUrlIpc(id, url).catch(() => {});
    }
  }, []);

  const setAiStatus = useCallback(
    (id: string, status: Tab["aiStatus"] | undefined) => {
      setTabs((prev) =>
        prev.map((t) =>
          t.id === id
            ? {
                ...t,
                isAiControlled: !!status,
                aiStatus: status,
              }
            : t
        )
      );
    },
    []
  );

  const goBack = useCallback(async (id: string) => {
    if (!isTauri()) return;
    try {
      await goBackIpc(id);
    } catch (e) {
      console.debug("[useBrowserTabs] go back failed:", e);
    }
  }, []);

  const goForward = useCallback(async (id: string) => {
    if (!isTauri()) return;
    try {
      await goForwardIpc(id);
    } catch (e) {
      console.debug("[useBrowserTabs] go forward failed:", e);
    }
  }, []);

  const reload = useCallback(async (id: string) => {
    if (!isTauri()) return;
    try {
      await reloadIpc(id);
    } catch (e) {
      console.debug("[useBrowserTabs] reload failed:", e);
    }
  }, []);

  // 创建 md-reader 标签
  const addMdReaderTab = useCallback((filePath: string) => {
    const fileName = filePath.replace(/\\/g, "/").split("/").pop() || "untitled.md";
    // 检查是否已有该文件的标签
    const existing = tabs.find((t) => t.type === "md-reader" && t.mdFilePath === filePath);
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    _tabCounter++;
    const id = `md-${_tabCounter}`;
    const newTab: Tab = {
      id,
      type: "md-reader",
      title: fileName,
      mdFilePath: filePath,
      isAiControlled: false,
      webviewCreated: false,
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(id);
  }, [tabs]);

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? MONA_TAB;

  return {
    tabs,
    activeTabId,
    activeTab,
    addEmptyTab,
    addMdReaderTab,
    navigateToUrl,
    closeTab,
    switchTab,
    updateTabTitle,
    updateTabUrl,
    setAiStatus,
    goBack,
    goForward,
    reload,
    browserFullscreen,
    toggleFullscreen,
    exitFullscreen,
  };
}
