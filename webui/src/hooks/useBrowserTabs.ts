import { useCallback, useEffect, useRef, useState } from "react";
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
  type BrowserTabInfo,
} from "@/lib/browser-ipc";
import { isTauri } from "@/lib/tauri";

const SESSION_STORAGE_KEY = "mona-browser-session";

export function shouldPersistBrowserSession(_isDevelopment: boolean): boolean {
  return false;
}
const SESSION_RESTORE_DELAY = 800; // ms，等待主窗口初始化完成

export interface Tab {
  id: string;
  type: "mona" | "browser" | "md-reader" | "canvas-reader" | "history" | "downloads";
  title: string;
  url?: string;
  favicon?: string;
  isAiControlled: boolean;
  webviewCreated: boolean; // WebView 是否已在 Rust 侧创建
  mdFilePath?: string; // md-reader 类型标签的文件路径
  canvasFilePath?: string; // canvas-reader 类型标签的文件路径
  isLoading?: boolean; // 页面是否正在加载
  canGoBack?: boolean; // 是否可以后退
  canGoForward?: boolean; // 是否可以前进
  isPinned?: boolean; // 标签是否固定
  isMuted?: boolean; // 标签是否静音
  isIncognito?: boolean; // 是否为无痕模式
  adBlockEnabled?: boolean; // 是否启用广告拦截
  isDarkMode?: boolean; // 是否启用暗色模式
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

function tabFromServer(tab: BrowserTabInfo): Tab {
  return {
    id: tab.id,
    type: "browser",
    title: tab.title,
    url: tab.url,
    isAiControlled: tab.is_ai_controlled,
    webviewCreated: true,
  };
}

// The first Rust-side list can race with local session restoration or a newly
// created tab. Merge it instead of replacing local state so its native WebView
// never becomes orphaned from the UI state.
export function mergeServerTabs(currentTabs: Tab[], serverTabs: BrowserTabInfo[]): Tab[] {
  const serverById = new Map(serverTabs.map((tab) => [tab.id, tab]));
  const mergedTabs = currentTabs.map((tab) => {
    if (tab.type !== "browser") return tab;
    const serverTab = serverById.get(tab.id);
    return serverTab ? { ...tab, ...tabFromServer(serverTab) } : tab;
  });
  const currentIds = new Set(currentTabs.map((tab) => tab.id));

  return [
    ...mergedTabs,
    ...serverTabs.filter((tab) => !currentIds.has(tab.id)).map(tabFromServer),
  ];
}

function createTabId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function createBrowserTabId(): string {
  return createTabId("tab");
}

// 关闭标签后选择下一个激活标签：优先左侧相邻标签，避免直接跳回 mona
function pickNextActiveAfterClose(tabsList: Tab[], closedId: string): string {
  const idx = tabsList.findIndex((t) => t.id === closedId);
  if (idx === -1) return "mona";
  for (let i = idx - 1; i >= 0; i--) {
    if (tabsList[i].id !== "mona") return tabsList[i].id;
  }
  if (idx + 1 < tabsList.length) return tabsList[idx + 1].id;
  return "mona";
}

export function useBrowserTabs() {
  const [tabs, setTabs] = useState<Tab[]>([MONA_TAB]);
  const [activeTabId, setActiveTabId] = useState<string>("mona");
  const [browserFullscreen, setBrowserFullscreen] = useState(false);

  // 最近关闭的标签（用于 Ctrl+Shift+T 恢复）
  const recentlyClosedRef = useRef<Array<{ url: string; title: string }>>([]);
  const creatingTabIdsRef = useRef(new Set<string>());
  const backgroundTabIdsRef = useRef(new Set<string>());

  // tabs 的 ref，用于在事件监听器中访问最新状态（避免 stale closure）
  const tabsRef = useRef<Tab[]>([MONA_TAB]);
  tabsRef.current = tabs;

  // activeTabId 的 ref，用于在事件监听器中访问最新状态
  const activeTabIdRef = useRef("mona");
  activeTabIdRef.current = activeTabId;

  // ── 会话恢复 ──
  // 启动时恢复上次的标签页
  useEffect(() => {
    if (!isTauri() || !shouldPersistBrowserSession(import.meta.env.DEV)) return;
    let cancelled = false;

    const restoreSession = async () => {
      try {
        const saved = localStorage.getItem(SESSION_STORAGE_KEY);
        if (!saved) return;
        const session = JSON.parse(saved) as { tabs: Array<{ url: string; title: string }>; activeUrl?: string };
        if (!session.tabs || session.tabs.length === 0) return;

        // 等待主窗口完全初始化
        await new Promise((resolve) => setTimeout(resolve, SESSION_RESTORE_DELAY));
        if (cancelled) return;

        // 如果 Rust 侧已有标签（前端重载但 Rust 进程未退出的场景），
        // 路径 B 已从 Rust 侧同步了标签，跳过 localStorage 恢复避免重复
        if (tabsRef.current.some((t) => t.type === "browser")) return;

        // 按 URL 去重，清理 localStorage 中可能已被污染的重复数据
        const seenUrls = new Set<string>();
        const uniqueTabs = session.tabs.filter((t) => {
          if (!t.url || seenUrls.has(t.url)) return false;
          seenUrls.add(t.url);
          return true;
        });

        for (const savedTab of uniqueTabs.slice(0, 10)) {
          // 限制最多恢复 10 个标签
          if (cancelled) return;
          const id = createBrowserTabId();
          const newTab: Tab = {
            id,
            type: "browser",
            title: savedTab.title || savedTab.url,
            url: savedTab.url,
            isAiControlled: false,
            webviewCreated: false,
            isLoading: true,
            adBlockEnabled: true,
          };
          setTabs((prev) => [...prev, newTab]);
          try {
            await browserCreateTab(id, savedTab.url, false, true);
            if (cancelled) return;
            setTabs((prev) =>
              prev.map((t) => (t.id === id ? { ...t, webviewCreated: true } : t))
            );
          } catch (e) {
            console.error("[useBrowserTabs] restore session tab failed:", e);
          }
        }
      } catch (e) {
        console.error("[useBrowserTabs] restore session failed:", e);
      }
    };

    void restoreSession();
    return () => {
      cancelled = true;
    };
  }, []);

  // 定期保存会话（标签 URL 列表）
  useEffect(() => {
    if (!isTauri() || !shouldPersistBrowserSession(import.meta.env.DEV)) return;
    const saveSession = () => {
      try {
        const seenUrls = new Set<string>();
        const browserTabsList = tabs
          .filter((t) => t.type === "browser" && t.url && t.webviewCreated && !t.isIncognito)
          .filter((t) => {
            // 按 URL 去重，避免 localStorage 被污染后每次恢复都重复
            if (seenUrls.has(t.url!)) return false;
            seenUrls.add(t.url!);
            return true;
          })
          .map((t) => ({ url: t.url!, title: t.title }));
        const session = { tabs: browserTabsList, savedAt: Date.now() };
        localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
      } catch (e) {
        // ignore quota errors
      }
    };
    // 节流保存：标签变化后 1 秒保存
    const timer = setTimeout(saveSession, 1000);
    return () => clearTimeout(timer);
  }, [tabs]);

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
      setTabs((currentTabs) => mergeServerTabs(currentTabs, serverTabs));
    }).catch(() => {});

    // 监听 AI 通过 IPC 创建的标签
    let unlistenCreated: (() => void) | undefined;
    let unlistenClosed: (() => void) | undefined;
    let unlistenUrlChanged: (() => void) | undefined;
    let unlistenOpenNewTab: (() => void) | undefined;
    let unlistenNavStarted: (() => void) | undefined;
    let unlistenNavCompleted: (() => void) | undefined;
    let unlistenTitleChanged: (() => void) | undefined;
    let unlistenFaviconChanged: (() => void) | undefined;
    let unlistenHistoryChanged: (() => void) | undefined;
    const keepListener = (unlisten: () => void): boolean => {
      if (!cancelled) return true;
      unlisten();
      return false;
    };

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
              isLoading: true,
            }];
          });
          if (!backgroundTabIdsRef.current.has(id)) setActiveTabId(id);
        }
      );
      if (!keepListener(unlistenCreated)) return;

      unlistenClosed = await listen<string>("browser-tab-closed", (event) => {
        const id = event.payload;
        backgroundTabIdsRef.current.delete(id);
        const nextActive = pickNextActiveAfterClose(tabsRef.current, id);
        setTabs((prev) => prev.filter((t) => t.id !== id));
        setActiveTabId((current) => (current === id ? nextActive : current));
      });
      if (!keepListener(unlistenClosed)) return;

      unlistenUrlChanged = await listen<{ id: string; url: string }>(
        "browser-url-changed",
        (event) => {
          const { id, url } = event.payload;
          setTabs((prev) =>
            prev.map((t) => (t.id === id ? { ...t, url } : t))
          );
          // 记录访问历史（无痕模式跳过）
          const tab = tabsRef.current.find((t) => t.id === id);
          if (url && (url.startsWith("http://") || url.startsWith("https://")) && !tab?.isIncognito) {
            browserRecordVisit(url, "").catch(() => {});
          }
        }
      );
      if (!keepListener(unlistenUrlChanged)) return;

      // 监听 target="_blank" / window.open 的新标签请求
      unlistenOpenNewTab = await listen<{ sourceTabId?: string; url: string }>(
        "browser-open-new-tab",
        (event) => {
          const { sourceTabId, url } = event.payload;
          const id = createBrowserTabId();
          const sourceTab = tabsRef.current.find(
            (t) => t.id === (sourceTabId ?? activeTabIdRef.current),
          );
          const isIncognito = sourceTab?.isIncognito ?? false;
          const newTab: Tab = {
            id,
            type: "browser",
            title: url,
            url,
            isAiControlled: false,
            webviewCreated: false,
            isLoading: true,
            isIncognito,
            adBlockEnabled: sourceTab?.adBlockEnabled ?? true,
          };
          setTabs((prev) => [...prev, newTab]);
          setActiveTabId(id);
          // 创建 WebView
          browserCreateTab(id, url, isIncognito, newTab.adBlockEnabled).then(() => {
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
      if (!keepListener(unlistenOpenNewTab)) return;

      // 导航开始
      unlistenNavStarted = await listen<{ id: string; url: string }>(
        "browser-nav-started",
        (event) => {
          const { id } = event.payload;
          setTabs((prev) =>
            prev.map((t) => (t.id === id ? { ...t, isLoading: true } : t))
          );
        }
      );
      if (!keepListener(unlistenNavStarted)) return;

      // 导航完成
      unlistenNavCompleted = await listen<{ id: string; success: boolean }>(
        "browser-nav-completed",
        (event) => {
          const { id } = event.payload;
          setTabs((prev) =>
            prev.map((t) => (t.id === id ? { ...t, isLoading: false } : t))
          );
        }
      );
      if (!keepListener(unlistenNavCompleted)) return;

      // 标题变化
      unlistenTitleChanged = await listen<{ id: string; title: string }>(
        "browser-tab-title-changed",
        (event) => {
          const { id, title } = event.payload;
          setTabs((prev) =>
            prev.map((t) => (t.id === id ? { ...t, title } : t))
          );
          // 更新历史记录中的标题（无痕模式跳过）
          const tab = tabsRef.current.find((t) => t.id === id);
          if (tab?.url && title && !tab.isIncognito) {
            browserRecordVisit(tab.url, title).catch(() => {});
          }
        }
      );
      if (!keepListener(unlistenTitleChanged)) return;

      // Favicon 变化
      unlistenFaviconChanged = await listen<{ id: string; favicon: string }>(
        "browser-favicon-changed",
        (event) => {
          const { id, favicon } = event.payload;
          setTabs((prev) =>
            prev.map((t) => (t.id === id ? { ...t, favicon } : t))
          );
        }
      );
      if (!keepListener(unlistenFaviconChanged)) return;

      // 后退/前进状态变化
      unlistenHistoryChanged = await listen<{ id: string; canGoBack: boolean; canGoForward: boolean }>(
        "browser-history-changed",
        (event) => {
          const { id, canGoBack, canGoForward } = event.payload;
          setTabs((prev) =>
            prev.map((t) => (t.id === id ? { ...t, canGoBack, canGoForward } : t))
          );
        }
      );
      if (!keepListener(unlistenHistoryChanged)) return;
    })();

    return () => {
      cancelled = true;
      unlistenCreated?.();
      unlistenClosed?.();
      unlistenUrlChanged?.();
      unlistenOpenNewTab?.();
      unlistenNavStarted?.();
      unlistenNavCompleted?.();
      unlistenTitleChanged?.();
      unlistenFaviconChanged?.();
      unlistenHistoryChanged?.();
    };
  }, []);

  // 创建纯 UI 标签（不创建 WebView，等用户输入 URL 后再创建）
  const addEmptyTab = useCallback((opts?: { isIncognito?: boolean; activate?: boolean }) => {
    const id = createBrowserTabId();
    const newTab: Tab = {
      id,
      type: "browser",
      title: "New Tab",
      url: "",
      isAiControlled: false,
      webviewCreated: false,
      isIncognito: opts?.isIncognito ?? false,
      adBlockEnabled: true,
    };
    setTabs((prev) => [...prev, newTab]);
    if (opts?.activate === false) backgroundTabIdsRef.current.add(id);
    else setActiveTabId(id);
    return id;
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
    const t0 = performance.now();
    console.log("[useBrowserTabs] navigateToUrl tabId=", tabId, "webviewCreated=", tab?.webviewCreated, "creatingGuard=", creatingTabIdsRef.current.has(tabId), "url=", normalizedUrl);

    if (tab?.webviewCreated) {
      // WebView 已存在，导航到新 URL
      try {
        console.log("[useBrowserTabs] >>> browserNavigateTab begin");
        await browserNavigateTab(tabId, normalizedUrl);
        console.log("[useBrowserTabs] <<< browserNavigateTab done elapsed=", performance.now() - t0);
        setTabs((prev) =>
          prev.map((t) =>
            t.id === tabId ? { ...t, url: normalizedUrl, title: normalizedUrl, isLoading: true } : t
          )
        );
      } catch (e) {
        console.error("[useBrowserTabs] navigate tab failed:", e, "elapsed=", performance.now() - t0);
      }
    } else {
      // WebView 未创建，创建新 WebView（传入无痕和广告拦截标志）
      if (creatingTabIdsRef.current.has(tabId)) {
        console.log("[useBrowserTabs] tabId=", tabId, "already creating, skip");
        return;
      }
      creatingTabIdsRef.current.add(tabId);
      try {
        console.log("[useBrowserTabs] >>> browserCreateTab begin");
        await browserCreateTab(tabId, normalizedUrl, tab?.isIncognito ?? false, tab?.adBlockEnabled ?? true);
        console.log("[useBrowserTabs] <<< browserCreateTab done elapsed=", performance.now() - t0);
        setTabs((prev) =>
          prev.map((t) =>
            t.id === tabId
              ? { ...t, url: normalizedUrl, title: normalizedUrl, webviewCreated: true, isLoading: true }
              : t
          )
        );
      } catch (e) {
        console.error("[useBrowserTabs] create tab failed:", e, "elapsed=", performance.now() - t0);
      } finally {
        creatingTabIdsRef.current.delete(tabId);
      }
    }
  }, [tabs]);

  // 关闭标签
  const closeTab = useCallback(async (id: string) => {
    if (id === "mona") return;
    backgroundTabIdsRef.current.delete(id);

    const tab = tabs.find((t) => t.id === id);
    if (!tab) return;

    // 记录到最近关闭列表（供 Ctrl+Shift+T 恢复）
    if (tab.url && tab.type === "browser") {
      recentlyClosedRef.current.push({ url: tab.url, title: tab.title });
    }

    if (isTauri() && tab.webviewCreated) {
      try {
        await closeTabIpc(id);
      } catch (e) {
        console.error("Failed to close browser tab:", e);
      }
    }

    // 关闭 Markdown 阅读器标签时，清理 store 中的文件数据
    if (tab.type === "md-reader") {
      const { useMdReaderStore } = await import("@/components/md-reader/mdReaderStore");
      const store = useMdReaderStore.getState();
      const mdTab = store.tabs.find((t) => t.filePath === tab.mdFilePath);
      if (mdTab) {
        store.closeTab(mdTab.id);
      }
    }

    setTabs((prev) => prev.filter((t) => t.id !== id));
    setActiveTabId((current) => (current === id ? pickNextActiveAfterClose(tabs, id) : current));
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
    const existing = tabsRef.current.find((t) => t.type === "md-reader" && t.mdFilePath === filePath);
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    const id = createTabId("md");
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
  }, []);

  const addCanvasReaderTab = useCallback((filePath: string) => {
    const fileName = filePath.replace(/\\/g, "/").split("/").pop() || "untitled.mona-canvas";
    const existing = tabsRef.current.find((t) => t.type === "canvas-reader" && t.canvasFilePath === filePath);
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    const id = createTabId("canvas");
    const newTab: Tab = {
      id,
      type: "canvas-reader",
      title: fileName,
      canvasFilePath: filePath,
      isAiControlled: false,
      webviewCreated: false,
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(id);
  }, []);

  // 打开历史记录页面
  const openHistoryPage = useCallback(() => {
    // 检查是否已有历史记录标签
    const existing = tabs.find((t) => t.type === "history");
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    const id = createTabId("history");
    const newTab: Tab = {
      id,
      type: "history",
      title: "历史记录",
      isAiControlled: false,
      webviewCreated: false,
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(id);
  }, [tabs]);

  // 打开下载记录页面
  const openDownloadsPage = useCallback(() => {
    const existing = tabs.find((t) => t.type === "downloads");
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    const id = createTabId("downloads");
    const newTab: Tab = {
      id,
      type: "downloads",
      title: "下载记录",
      isAiControlled: false,
      webviewCreated: false,
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(id);
  }, [tabs]);

  // ── 标签管理增强 ──

  // 重排标签（拖拽排序）
  const reorderTabs = useCallback((fromId: string, toId: string) => {
    if (fromId === toId || fromId === "mona" || toId === "mona") return;
    setTabs((prev) => {
      const fromIdx = prev.findIndex((t) => t.id === fromId);
      const toIdx = prev.findIndex((t) => t.id === toId);
      if (fromIdx === -1 || toIdx === -1) return prev;
      const next = [...prev];
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      return next;
    });
  }, []);

  // 固定/取消固定标签
  const togglePinTab = useCallback((id: string) => {
    if (id === "mona") return;
    setTabs((prev) =>
      prev.map((t) => (t.id === id ? { ...t, isPinned: !t.isPinned } : t))
    );
  }, []);

  // 切换标签静音
  const toggleMute = useCallback(async (id: string) => {
    if (id === "mona" || !isTauri()) return;
    const tab = tabs.find((t) => t.id === id);
    if (!tab || !tab.webviewCreated) return;
    const newMuted = !tab.isMuted;
    try {
      const { browserSetMuted } = await import("@/lib/browser-ipc");
      await browserSetMuted(id, newMuted);
      setTabs((prev) =>
        prev.map((t) => (t.id === id ? { ...t, isMuted: newMuted } : t))
      );
    } catch (e) {
      console.error("[toggleMute]", e);
    }
  }, [tabs]);

  // 切换广告拦截
  const toggleAdBlock = useCallback(async (id: string) => {
    if (id === "mona" || !isTauri()) return;
    const tab = tabs.find((t) => t.id === id);
    if (!tab || !tab.webviewCreated) return;
    const newEnabled = !tab.adBlockEnabled;
    try {
      const { browserSetAdBlock } = await import("@/lib/browser-ipc");
      await browserSetAdBlock(id, newEnabled);
      setTabs((prev) =>
        prev.map((t) => (t.id === id ? { ...t, adBlockEnabled: newEnabled } : t))
      );
    } catch (e) {
      console.error("[toggleAdBlock]", e);
    }
  }, [tabs]);

  // 切换暗色模式
  const toggleDarkMode = useCallback(async (id: string) => {
    if (id === "mona" || !isTauri()) return;
    const tab = tabs.find((t) => t.id === id);
    if (!tab || !tab.webviewCreated) return;
    const newEnabled = !tab.isDarkMode;
    try {
      const { browserSetDarkMode } = await import("@/lib/browser-ipc");
      await browserSetDarkMode(id, newEnabled);
      setTabs((prev) =>
        prev.map((t) => (t.id === id ? { ...t, isDarkMode: newEnabled } : t))
      );
    } catch (e) {
      console.error("[toggleDarkMode]", e);
    }
  }, [tabs]);

  // 打开开发者工具
  const openDevtools = useCallback(async (id: string) => {
    if (id === "mona" || !isTauri()) return;
    const tab = tabs.find((t) => t.id === id);
    if (!tab || !tab.webviewCreated) return;
    try {
      const { browserOpenDevtools } = await import("@/lib/browser-ipc");
      await browserOpenDevtools(id);
    } catch (e) {
      console.error("[openDevtools]", e);
    }
  }, [tabs]);

  // 关闭其他标签
  const closeOtherTabs = useCallback(async (id: string) => {
    const toClose = tabs.filter((t) => t.id !== id && t.id !== "mona");
    for (const t of toClose) {
      if (t.webviewCreated && isTauri()) {
        try { await closeTabIpc(t.id); } catch (e) { console.error("[closeOtherTabs]", e); }
      }
      if (t.url) recentlyClosedRef.current.push({ url: t.url, title: t.title });
    }
    setTabs((prev) => prev.filter((t) => t.id === id || t.id === "mona"));
    setActiveTabId(id);
  }, [tabs]);

  // 关闭右侧标签
  const closeTabsToRight = useCallback(async (id: string) => {
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;
    const toClose = tabs.slice(idx + 1).filter((t) => t.id !== "mona");
    for (const t of toClose) {
      if (t.webviewCreated && isTauri()) {
        try { await closeTabIpc(t.id); } catch (e) { console.error("[closeTabsToRight]", e); }
      }
      if (t.url) recentlyClosedRef.current.push({ url: t.url, title: t.title });
    }
    setTabs((prev) => {
      const i = prev.findIndex((t) => t.id === id);
      return [...prev.slice(0, i + 1)];
    });
  }, [tabs]);

  // 复制标签
  const duplicateTab = useCallback(async (id: string) => {
    const tab = tabs.find((t) => t.id === id);
    if (!tab || tab.type !== "browser" || !tab.url) return;
    const newId = createBrowserTabId();
    const newTab: Tab = {
      id: newId,
      type: "browser",
      title: tab.title,
      url: tab.url,
      isAiControlled: false,
      webviewCreated: false,
      isLoading: true,
      isIncognito: tab.isIncognito,
      adBlockEnabled: tab.adBlockEnabled,
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newId);
    if (isTauri()) {
      try {
        await browserCreateTab(newId, tab.url, tab.isIncognito ?? false, tab.adBlockEnabled ?? true);
        setTabs((prev) =>
          prev.map((t) => (t.id === newId ? { ...t, webviewCreated: true } : t))
        );
      } catch (e) {
        console.error("[duplicateTab]", e);
      }
    }
  }, [tabs]);

  // 恢复最近关闭的标签
  const reopenClosedTab = useCallback(async () => {
    const last = recentlyClosedRef.current.pop();
    if (!last) return;
    const id = createBrowserTabId();
    const newTab: Tab = {
      id,
      type: "browser",
      title: last.title || last.url,
      url: last.url,
      isAiControlled: false,
      webviewCreated: false,
      isLoading: true,
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(id);
    if (isTauri()) {
      try {
        await browserCreateTab(id, last.url, false, true);
        setTabs((prev) =>
          prev.map((t) => (t.id === id ? { ...t, webviewCreated: true } : t))
        );
      } catch (e) {
        console.error("[reopenClosedTab]", e);
      }
    }
  }, []);

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? MONA_TAB;

  // ── 键盘快捷键 ──
  // 在 closeTab 中记录已关闭的标签，供 Ctrl+Shift+T 恢复
  const closeTabRef = useRef(closeTab);
  closeTabRef.current = closeTab;
  const openDevtoolsRef = useRef(openDevtools);
  openDevtoolsRef.current = openDevtools;

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // 仅在浏览器标签激活时响应（避免与聊天输入冲突）
      const isBrowserActive = activeTabId !== "mona";
      const ctrl = e.ctrlKey || e.metaKey;

      // Ctrl+T: 新标签
      if (ctrl && e.key === "t" && !e.shiftKey) {
        e.preventDefault();
        addEmptyTab();
        return;
      }

      // Ctrl+Shift+N: 新无痕标签
      if (ctrl && e.shiftKey && (e.key === "N" || e.key === "n")) {
        e.preventDefault();
        addEmptyTab({ isIncognito: true });
        return;
      }

      // Ctrl+Shift+T: 恢复关闭的标签
      if (ctrl && e.shiftKey && (e.key === "T" || e.key === "t")) {
        e.preventDefault();
        void reopenClosedTab();
        return;
      }

      // Ctrl+W: 关闭当前标签
      if (ctrl && e.key === "w" && !e.shiftKey) {
        if (isBrowserActive) {
          e.preventDefault();
          void closeTabRef.current(activeTabId);
        }
        return;
      }

      // Ctrl+Tab / Ctrl+Shift+Tab: 切换标签
      if (ctrl && e.key === "Tab") {
        const browserTabsList = tabs.filter(
          (tab) => (tab.id !== "mona" || tabs.length === 1) && !backgroundTabIdsRef.current.has(tab.id),
        );
        if (browserTabsList.length < 2) return;
        const currentIdx = browserTabsList.findIndex((t) => t.id === activeTabId);
        if (currentIdx === -1) return;
        e.preventDefault();
        const dir = e.shiftKey ? -1 : 1;
        const nextIdx = (currentIdx + dir + browserTabsList.length) % browserTabsList.length;
        setActiveTabId(browserTabsList[nextIdx].id);
        return;
      }

      // Ctrl+L: 聚焦地址栏（仅浏览器标签）
      if (ctrl && e.key === "l" && !e.shiftKey && isBrowserActive) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("mona-focus-address-bar"));
        return;
      }

      // Ctrl+R / F5: 刷新（仅浏览器标签）
      if ((ctrl && e.key === "r" && !e.shiftKey) || e.key === "F5") {
        if (isBrowserActive) {
          e.preventDefault();
          void reload(activeTabId);
        }
        return;
      }

      // F12: 开发者工具（仅浏览器标签）
      if (e.key === "F12" && isBrowserActive) {
        e.preventDefault();
        void openDevtoolsRef.current(activeTabId);
        return;
      }

      // Alt+Home: 回到 Mona 标签
      if (e.altKey && e.key === "Home") {
        e.preventDefault();
        setActiveTabId("mona");
        return;
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [tabs, activeTabId, addEmptyTab, reopenClosedTab, reload]);

  return {
    tabs,
    activeTabId,
    activeTab,
    addEmptyTab,
    addMdReaderTab,
    addCanvasReaderTab,
    openHistoryPage,
    openDownloadsPage,
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
    // 标签管理增强
    reorderTabs,
    togglePinTab,
    closeOtherTabs,
    closeTabsToRight,
    duplicateTab,
    reopenClosedTab,
    // 隐私安全
    toggleMute,
    toggleAdBlock,
    // 高级功能
    toggleDarkMode,
    openDevtools,
  };
}
