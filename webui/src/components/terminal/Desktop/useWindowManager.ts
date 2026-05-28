import { useState, useCallback } from "react";
import type { WindowState, AppType } from "./types";

const generateId = () => Math.random().toString(36).substr(2, 9);

export function useWindowManager(containerSize: { width: number; height: number }) {
  const [windows, setWindows] = useState<WindowState[]>([]);
  const [activeWindowId, setActiveWindowId] = useState<string | null>(null);
  const [zIndexCounter, setZIndexCounter] = useState(100);

  const openWindow = useCallback(
    (type: AppType, title: string, data?: Record<string, unknown>) => {
      const id = generateId();

      const width = type === "terminal" ? 800 : type === "textEditor" ? 800 : 900;
      const height =
        type === "terminal" ? 500 : type === "textEditor" ? 600 : 600;

      const x = Math.max(0, (containerSize.width - width) / 2);
      const y = Math.max(0, (containerSize.height - height) / 2 - 40);

      const newWindow: WindowState = {
        id,
        type,
        title,
        isMinimized: false,
        isMaximized: false,
        zIndex: zIndexCounter + 1,
        position: { x, y },
        size: { width, height },
        data,
      };

      setWindows((prev) => [...prev, newWindow]);
      setActiveWindowId(id);
      setZIndexCounter((prev) => prev + 1);
      return id;
    },
    [zIndexCounter, containerSize],
  );

  const closeWindow = useCallback(
    (id: string) => {
      setWindows((prev) => prev.filter((w) => w.id !== id));
      if (activeWindowId === id) {
        setWindows((prev) => {
          const remaining = prev.filter((w) => w.id !== id);
          setActiveWindowId(
            remaining.length > 0
              ? remaining[remaining.length - 1].id
              : null,
          );
          return prev;
        });
      }
    },
    [activeWindowId],
  );

  const minimizeWindow = useCallback(
    (id: string) => {
      setWindows((prev) =>
        prev.map((w) => (w.id === id ? { ...w, isMinimized: true } : w)),
      );
      if (activeWindowId === id) {
        setWindows((prev) => {
          const remaining = prev.filter(
            (w) => w.id !== id && !w.isMinimized,
          );
          setActiveWindowId(
            remaining.length > 0
              ? remaining[remaining.length - 1].id
              : null,
          );
          return prev;
        });
      }
    },
    [activeWindowId],
  );

  const restoreWindow = useCallback(
    (id: string) => {
      setWindows((prev) =>
        prev.map((w) => (w.id === id ? { ...w, isMinimized: false } : w)),
      );
      setActiveWindowId(id);
      setZIndexCounter((prev) => prev + 1);
      setWindows((prev) =>
        prev.map((w) =>
          w.id === id ? { ...w, zIndex: zIndexCounter + 1 } : w,
        ),
      );
    },
    [zIndexCounter],
  );

  const activateWindow = useCallback(
    (id: string) => {
      setActiveWindowId(id);
      setZIndexCounter((prev) => prev + 1);
      setWindows((prev) =>
        prev.map((w) =>
          w.id === id ? { ...w, zIndex: zIndexCounter + 1 } : w,
        ),
      );
    },
    [zIndexCounter],
  );

  const updateWindowPosition = useCallback(
    (id: string, position: { x: number; y: number }) => {
      setWindows((prev) =>
        prev.map((w) => (w.id === id ? { ...w, position } : w)),
      );
    },
    [],
  );

  const updateWindowSize = useCallback(
    (id: string, size: { width: number; height: number }) => {
      setWindows((prev) =>
        prev.map((w) => (w.id === id ? { ...w, size } : w)),
      );
    },
    [],
  );

  const toggleMaximize = useCallback((id: string) => {
    setWindows((prev) =>
      prev.map((w) => (w.id === id ? { ...w, isMaximized: !w.isMaximized } : w)),
    );
  }, []);

  return {
    windows,
    activeWindowId,
    openWindow,
    closeWindow,
    minimizeWindow,
    restoreWindow,
    activateWindow,
    updateWindowPosition,
    updateWindowSize,
    toggleMaximize,
  };
}
