import { useCallback, useEffect, useRef, useState } from "react";
import {
  browserCancelDownload,
  browserPauseDownload,
  browserResumeDownload,
  browserOpenDownload,
  browserRevealDownload,
  browserRemoveDownload,
  browserListDownloads,
  type DownloadInfo,
} from "@/lib/browser-ipc";
import { isTauri } from "@/lib/tauri";

export function useDownloads() {
  const [downloads, setDownloads] = useState<DownloadInfo[]>([]);
  const downloadsRef = useRef(downloads);
  downloadsRef.current = downloads;

  // 同步已有下载列表
  useEffect(() => {
    if (!isTauri()) return;
    browserListDownloads().then((list) => {
      setDownloads(list);
    }).catch(() => {});
  }, []);

  // 监听下载事件
  useEffect(() => {
    if (!isTauri()) return;
    let unlistenStarted: (() => void) | undefined;
    let unlistenProgress: (() => void) | undefined;
    let unlistenState: (() => void) | undefined;

    (async () => {
      const { listen } = await import("@tauri-apps/api/event");

      // 下载开始
      unlistenStarted = await listen<DownloadInfo>("browser-download-started", (event) => {
        const info = event.payload;
        setDownloads((prev) => {
          if (prev.some((d) => d.id === info.id)) return prev;
          return [...prev, info];
        });
      });

      // 下载进度
      unlistenProgress = await listen<{ id: string; receivedBytes: number; totalBytes: number }>(
        "browser-download-progress",
        (event) => {
          const { id, receivedBytes, totalBytes } = event.payload;
          setDownloads((prev) =>
            prev.map((d) =>
              d.id === id ? { ...d, receivedBytes, totalBytes } : d
            )
          );
        }
      );

      // 下载状态变化
      unlistenState = await listen<{ id: string; state: string }>(
        "browser-download-state-changed",
        (event) => {
          const { id, state } = event.payload;
          setDownloads((prev) =>
            prev.map((d) => (d.id === id ? { ...d, state } : d))
          );
        }
      );
    })();

    return () => {
      unlistenStarted?.();
      unlistenProgress?.();
      unlistenState?.();
    };
  }, []);

  const cancelDownload = useCallback(async (id: string) => {
    try {
      await browserCancelDownload(id);
      setDownloads((prev) =>
        prev.map((d) => (d.id === id ? { ...d, state: "cancelled" } : d))
      );
    } catch (e) {
      console.error("[useDownloads] cancel failed:", e);
    }
  }, []);

  const pauseDownload = useCallback(async (id: string) => {
    try {
      await browserPauseDownload(id);
    } catch (e) {
      console.error("[useDownloads] pause failed:", e);
    }
  }, []);

  const resumeDownload = useCallback(async (id: string) => {
    try {
      await browserResumeDownload(id);
    } catch (e) {
      console.error("[useDownloads] resume failed:", e);
    }
  }, []);

  const openDownload = useCallback(async (id: string) => {
    try {
      await browserOpenDownload(id);
    } catch (e) {
      console.error("[useDownloads] open failed:", e);
    }
  }, []);

  const revealDownload = useCallback(async (id: string) => {
    try {
      await browserRevealDownload(id);
    } catch (e) {
      console.error("[useDownloads] reveal failed:", e);
    }
  }, []);

  const removeDownload = useCallback(async (id: string) => {
    try {
      await browserRemoveDownload(id);
      setDownloads((prev) => prev.filter((d) => d.id !== id));
    } catch (e) {
      console.error("[useDownloads] remove failed:", e);
    }
  }, []);

  const clearCompleted = useCallback(() => {
    setDownloads((prev) => prev.filter((d) => d.state !== "completed" && d.state !== "cancelled"));
  }, []);

  // 是否有活跃下载
  const hasActiveDownloads = downloads.some(
    (d) => d.state === "in_progress" || d.state === "interrupted"
  );

  return {
    downloads,
    hasActiveDownloads,
    cancelDownload,
    pauseDownload,
    resumeDownload,
    openDownload,
    revealDownload,
    removeDownload,
    clearCompleted,
  };
}
