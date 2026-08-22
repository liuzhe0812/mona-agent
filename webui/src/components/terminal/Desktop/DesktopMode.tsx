import { useEffect, useState, useRef, createContext, useContext } from "react";
import {
  Wifi,
  Terminal,
  Folder,
  X,
  Minus,
} from "lucide-react";
import { AgentLogo } from "@/components/AgentLogo";
import { DesktopSurface } from "./Desktop";
import { Window } from "./Window";
import { Taskbar } from "./Taskbar";
import { DesktopLogin } from "./DesktopLogin";
import { FileManagerApp } from "./apps/FileManagerApp";
import { TerminalApp } from "./apps/TerminalApp";
import { TaskManagerApp } from "./apps/TaskManagerApp";
import { TextEditorApp } from "./apps/TextEditorApp";
import { RecycleBinApp } from "./apps/RecycleBinApp";
import { useWindowManager } from "./useWindowManager";
import { desktopDisconnect, desktopConnect, desktopExec } from "../ipc";
import { useTerminalStore } from "../store/terminalStore";
import type { ConnectionConfig } from "../types/terminal";
import type { AppType, WindowState } from "./types";

export const DesktopPortalContext = createContext<HTMLElement | null>(null);
export function useDesktopPortal() {
  return useContext(DesktopPortalContext);
}

const desktopStyles = `
  .desktop-mode-container {
    width: 100%;
    height: 100%;
    background-color: #1b1440;
    background-image:
      radial-gradient(60% 50% at 75% 12%, rgba(255, 148, 77, 0.50) 0%, rgba(255, 148, 77, 0) 70%),
      radial-gradient(55% 60% at 88% 68%, rgba(236, 72, 153, 0.45) 0%, rgba(236, 72, 153, 0) 70%),
      radial-gradient(70% 65% at 12% 85%, rgba(99, 60, 220, 0.55) 0%, rgba(99, 60, 220, 0) 70%),
      radial-gradient(80% 70% at 35% 30%, rgba(56, 89, 199, 0.45) 0%, rgba(56, 89, 199, 0) 75%);
    position: relative;
    overflow: hidden;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    color: #ffffff;
    user-select: none;
  }

  .desktop-mode-container ::-webkit-scrollbar {
    width: 8px;
    height: 8px;
  }

  .desktop-mode-container ::-webkit-scrollbar-track {
    background: transparent;
  }

  .desktop-mode-container ::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.22);
    border-radius: 9999px;
    border: 2px solid transparent;
    background-clip: padding-box;
  }

  .desktop-mode-container ::-webkit-scrollbar-thumb:hover {
    background: rgba(255, 255, 255, 0.35);
    border: 2px solid transparent;
    background-clip: padding-box;
  }

  .desktop-mode-container .mona-agent-logo * {
    animation: none !important;
  }
`;

type MenuId = "file" | "window";

interface MenuBarProps {
  activeTitle: string;
  hostLabel?: string;
  windows?: WindowState[];
  activeWindowId?: string | null;
  onOpenApp?: (type: AppType, title: string, data?: Record<string, unknown>) => void;
  onCloseWindow?: (id: string) => void;
  onMinimizeAll?: () => void;
  onActivateWindow?: (id: string, isMinimized: boolean) => void;
}

function MenuBar({
  activeTitle,
  hostLabel,
  windows = [],
  activeWindowId,
  onOpenApp,
  onCloseWindow,
  onMinimizeAll,
  onActivateWindow,
}: MenuBarProps) {
  const [now, setNow] = useState(() => new Date());
  const [openMenu, setOpenMenu] = useState<MenuId | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 10000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!openMenu) return;
    const handleDown = (e: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) {
        setOpenMenu(null);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenMenu(null);
    };
    document.addEventListener("mousedown", handleDown);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleDown);
      document.removeEventListener("keydown", handleKey);
    };
  }, [openMenu]);

  const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const dateText = `${now.getMonth() + 1}月${now.getDate()}日 ${weekdays[now.getDay()]}`;
  const timeText = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

  const hasMenus = Boolean(onOpenApp);
  const visibleWindows = windows.filter((w) => !w.isMinimized);

  const menuButtonClass = (id: MenuId) =>
    `rounded px-2 py-0.5 transition-colors ${
      openMenu === id ? "bg-white/20" : "hover:bg-white/15"
    }`;

  const itemClass =
    "flex w-full items-center gap-2 rounded-md px-2.5 py-1 text-left text-[13px] text-white/90 transition-colors hover:bg-[#0a82ff] hover:text-white disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-white/90";

  const panelClass =
    "absolute left-0 top-full mt-1 min-w-[200px] rounded-xl border border-white/15 bg-[#2b2b2f]/85 p-1 shadow-[0_16px_48px_rgba(0,0,0,0.45)] backdrop-blur-2xl";

  return (
    <div
      ref={barRef}
      className="absolute inset-x-0 top-0 z-[100000] flex h-7 items-center gap-0.5 border-b border-white/10 bg-black/25 px-3 text-[13px] text-white/90 backdrop-blur-2xl"
    >
      <AgentLogo state="welcome" className="mr-1 h-[18px] w-[18px]" />
      <span className="mr-1 font-semibold">{activeTitle}</span>

      {hasMenus && (
        <>
          <div className="relative">
            <button
              className={menuButtonClass("file")}
              onClick={() => setOpenMenu(openMenu === "file" ? null : "file")}
              onMouseEnter={() => openMenu && setOpenMenu("file")}
            >
              文件
            </button>
            {openMenu === "file" && (
              <div className={panelClass}>
                <button
                  className={itemClass}
                  onClick={() => {
                    onOpenApp?.("terminal", "终端");
                    setOpenMenu(null);
                  }}
                >
                  <Terminal className="h-3.5 w-3.5" />
                  新建终端窗口
                </button>
                <button
                  className={itemClass}
                  onClick={() => {
                    onOpenApp?.("fileManager", "文件管理器");
                    setOpenMenu(null);
                  }}
                >
                  <Folder className="h-3.5 w-3.5" />
                  新建文件管理器
                </button>
                <div className="mx-2 my-1 border-t border-white/10" />
                <button
                  className={itemClass}
                  disabled={!activeWindowId}
                  onClick={() => {
                    if (activeWindowId) onCloseWindow?.(activeWindowId);
                    setOpenMenu(null);
                  }}
                >
                  <X className="h-3.5 w-3.5" />
                  关闭窗口
                </button>
              </div>
            )}
          </div>

          <div className="relative">
            <button
              className={menuButtonClass("window")}
              onClick={() => setOpenMenu(openMenu === "window" ? null : "window")}
              onMouseEnter={() => openMenu && setOpenMenu("window")}
            >
              窗口
            </button>
            {openMenu === "window" && (
              <div className={panelClass}>
                <button
                  className={itemClass}
                  disabled={visibleWindows.length === 0}
                  onClick={() => {
                    onMinimizeAll?.();
                    setOpenMenu(null);
                  }}
                >
                  <Minus className="h-3.5 w-3.5" />
                  最小化全部
                </button>
                {windows.length > 0 && (
                  <div className="mx-2 my-1 border-t border-white/10" />
                )}
                {windows.map((w) => (
                  <button
                    key={w.id}
                    className={itemClass}
                    onClick={() => {
                      onActivateWindow?.(w.id, w.isMinimized);
                      setOpenMenu(null);
                    }}
                  >
                    <span
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                        w.id === activeWindowId && !w.isMinimized
                          ? "bg-[#0a82ff]"
                          : "bg-transparent"
                      }`}
                    />
                    <span className="truncate">{w.title}</span>
                    {w.isMinimized && (
                      <span className="ml-auto shrink-0 text-xs text-white/40">
                        已最小化
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      <div className="flex-1" />
      <div className="flex items-center gap-3.5 pr-1 text-white/90">
        {hostLabel && (
          <div className="flex items-center gap-1.5">
            <Wifi className="h-4 w-4" />
            <span className="text-[13px]">{hostLabel}</span>
          </div>
        )}
        <span className="text-[13px]">
          {dateText} {timeText}
        </span>
      </div>
    </div>
  );
}

interface DesktopModeProps {
  sessionId: string;
  aiEnabled: boolean;
}

export function DesktopMode({ sessionId, aiEnabled }: DesktopModeProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const [containerSize, setContainerSize] = useState({ width: 1200, height: 800 });

  const session = useTerminalStore((s) =>
    s.sessions.find((s) => s.id === sessionId),
  );
  const removeSession = useTerminalStore((s) => s.removeSession);
  const updateSessionStatus = useTerminalStore((s) => s.updateSessionStatus);
  const updateSessionTitle = useTerminalStore((s) => s.updateSessionTitle);
  const addConnection = useTerminalStore((s) => s.addConnection);

  const [backendSessionId, setBackendSessionId] = useState<string | null>(null);
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [disconnected, setDisconnected] = useState(false);

  const effectiveSessionId = backendSessionId ?? sessionId;
  const effectiveSessionIdRef = useRef(effectiveSessionId);
  effectiveSessionIdRef.current = effectiveSessionId;

  const showLogin = session?.status !== "connected" && !backendSessionId;

  useEffect(() => {
    const updateSize = () => {
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        setContainerSize({ width: rect.width, height: rect.height });
      }
    };
    updateSize();
    setPortalTarget(containerRef.current);
    const observer = new ResizeObserver(updateSize);
    if (containerRef.current) {
      observer.observe(containerRef.current);
    }
    return () => observer.disconnect();
  }, []);

  const {
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
  } = useWindowManager(containerSize);

  useEffect(() => {
    return () => {
      desktopDisconnect(effectiveSessionIdRef.current).catch(() => {});
    };
  }, []);

  const handleLogin = async (loginConfig: {
    host: string;
    port: number;
    username: string;
    auth: { type: "password"; password: string };
  }) => {
    setLoginLoading(true);
    setLoginError(null);
    try {
      const connConfig: ConnectionConfig = {
        id: crypto.randomUUID(),
        name: `${loginConfig.username}@${loginConfig.host}`,
        protocol: "ssh",
        host: loginConfig.host,
        port: loginConfig.port,
        username: loginConfig.username,
        auth: loginConfig.auth,
      };
      addConnection(connConfig);
      const newSessionId = await desktopConnect(connConfig);
      setBackendSessionId(newSessionId);
      updateSessionStatus(sessionId, "connected");
      updateSessionTitle(
        sessionId,
        `${loginConfig.username}@${loginConfig.host} (桌面)`,
      );
    } catch (err) {
      setLoginError(String(err));
    } finally {
      setLoginLoading(false);
    }
  };

  const handleOpenApp = (
    type: AppType,
    title: string,
    data?: Record<string, unknown>,
  ) => {
    const existingWindow = windows.find((w) => {
      if (w.type !== type || w.isMinimized) return false;
      if (type === "textEditor") {
        return w.data?.filePath === data?.filePath;
      }
      return true;
    });

    if (existingWindow) {
      activateWindow(existingWindow.id);
      return;
    }
    openWindow(type, title, data);
  };

  const renderWindowContent = (window: WindowState) => {
    switch (window.type) {
      case "fileManager":
        return (
          <FileManagerApp
            sessionId={effectiveSessionId}
            onOpenTextEditor={(path) =>
              handleOpenApp("textEditor", path, { filePath: path })
            }
            initialPath={
              (window.data?.path as string) ?? ""
            }
          />
        );
      case "taskManager":
        return <TaskManagerApp sessionId={effectiveSessionId} />;
      case "terminal":
        return <TerminalApp sessionId={effectiveSessionId} aiEnabled={aiEnabled} />;
      case "textEditor":
        return (
          <TextEditorApp
            sessionId={effectiveSessionId}
            filePath={window.data?.filePath as string}
          />
        );
      case "recycleBin":
        return <RecycleBinApp sessionId={effectiveSessionId} />;
      default:
        return null;
    }
  };

  const handleDisconnect = async () => {
    try {
      await desktopDisconnect(effectiveSessionId);
    } catch {}
    setDisconnected(true);
    removeSession(sessionId);
  };

  const handleDesktopContextMenu = async (
    action: string,
    data?: Record<string, unknown>,
  ) => {
    try {
      switch (action) {
        case "newFile": {
          const name = (data?.name as string) || "新建文件.txt";
          await desktopExec(effectiveSessionId, `touch ~/Desktop/'${name}'`);
          break;
        }
        case "newFolder": {
          const name = (data?.name as string) || "新建文件夹";
          await desktopExec(effectiveSessionId, `mkdir -p ~/Desktop/'${name}'`);
          break;
        }
        case "refresh":
          break;
        case "paste":
          break;
      }
    } catch (err) {
      console.error("Desktop context menu action failed:", String(err));
    }
  };

  if (disconnected) {
    return (
      <div className="flex h-full items-center justify-center bg-[#1b1440] text-white/50">
        连接已断开
      </div>
    );
  }

  if (showLogin) {
    return (
      <div className="desktop-mode-container" ref={containerRef}>
        <style>{desktopStyles}</style>
        <MenuBar activeTitle="登录" />
        <DesktopLogin
          onLogin={handleLogin}
          loading={loginLoading}
          error={loginError}
        />
      </div>
    );
  }

  const activeWindow = windows.find((w) => w.id === activeWindowId);
  const hostLabel = session?.title
    ? session.title.replace(/\s*\(桌面\)\s*$/, "")
    : undefined;

  const handleMinimizeAll = () => {
    windows.forEach((w) => {
      if (!w.isMinimized) minimizeWindow(w.id);
    });
  };

  const handleActivateFromMenu = (id: string, isMinimized: boolean) => {
    if (isMinimized) {
      restoreWindow(id);
    } else {
      activateWindow(id);
    }
  };

  return (
    <DesktopPortalContext.Provider value={portalTarget}>
      <div className="desktop-mode-container" ref={containerRef}>
        <style>{desktopStyles}</style>

        <MenuBar
          activeTitle={activeWindow?.title ?? "桌面"}
          hostLabel={hostLabel}
          windows={windows}
          activeWindowId={activeWindowId}
          onOpenApp={handleOpenApp}
          onCloseWindow={closeWindow}
          onMinimizeAll={handleMinimizeAll}
          onActivateWindow={handleActivateFromMenu}
        />

        <DesktopSurface onOpenApp={handleOpenApp} onDesktopContextMenu={handleDesktopContextMenu} />

        {windows.map((window) => (
          <Window
            key={window.id}
            window={window}
            isActive={activeWindowId === window.id}
            onClose={() => closeWindow(window.id)}
            onMinimize={() => minimizeWindow(window.id)}
            onMaximize={() => toggleMaximize(window.id)}
            onActivate={() => activateWindow(window.id)}
            onUpdatePosition={(pos) => updateWindowPosition(window.id, pos)}
            onUpdateSize={(size) => updateWindowSize(window.id, size)}
            containerBounds={containerSize}
          >
            {renderWindowContent(window)}
          </Window>
        ))}

        <Taskbar
          windows={windows}
          activeWindowId={activeWindowId}
          onRestoreWindow={restoreWindow}
          onMinimizeWindow={minimizeWindow}
          onOpenApp={handleOpenApp}
          onDisconnect={handleDisconnect}
        />
      </div>
    </DesktopPortalContext.Provider>
  );
}
