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
} from "@/lib/browser-ipc";
import { isTauri } from "@/lib/tauri";

export interface Tab {
  id: string;
  type: "mona" | "browser";
  title: string;
  url?: string;
  favicon?: string;
  isAiControlled: boolean;
  webviewCreated: boolean; // WebView 是否已在 Rust 侧创建
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
        }
      );
    })();

    return () => {
      cancelled = true;
      unlistenCreated?.();
      unlistenClosed?.();
      unlistenUrlChanged?.();
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
    if (!isTauri() || id === "mona") return;

    const tab = tabs.find((t) => t.id === id);
    if (!tab) return;

    if (tab.webviewCreated) {
      try {
        await closeTabIpc(id);
      } catch (e) {
        console.error("Failed to close browser tab:", e);
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

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? MONA_TAB;

  return {
    tabs,
    activeTabId,
    activeTab,
    addEmptyTab,
    navigateToUrl,
    closeTab,
    switchTab,
    updateTabTitle,
    updateTabUrl,
    setAiStatus,
    goBack,
    goForward,
    reload,
  };
}
