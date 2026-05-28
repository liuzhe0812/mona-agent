import { useEffect, useState, useRef } from "react";
import { DesktopSurface } from "./Desktop";
import { Window } from "./Window";
import { Taskbar } from "./Taskbar";
import { DesktopLogin } from "./DesktopLogin";
import { FileManagerApp } from "./apps/FileManagerApp";
import { TerminalApp } from "./apps/TerminalApp";
import { TaskManagerApp } from "./apps/TaskManagerApp";
import { TextEditorApp } from "./apps/TextEditorApp";
import { useWindowManager } from "./useWindowManager";
import { desktopDisconnect, desktopConnect } from "../ipc";
import { useTerminalStore } from "../store/terminalStore";
import type { ConnectionConfig } from "../types/terminal";
import type { AppType, WindowState } from "./types";

const desktopStyles = `
  .desktop-mode-container {
    width: 100%;
    height: 100%;
    background: linear-gradient(135deg, #1a1a2e 0%, #16213e 25%, #1a1a2e 50%, #2d1b4e 75%, #1a1a2e 100%);
    background-size: 400% 400%;
    animation: desktop-gradient-shift 15s ease infinite;
    position: relative;
    overflow: hidden;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    color: #ffffff;
  }

  @keyframes desktop-gradient-shift {
    0% { background-position: 0% 50%; }
    50% { background-position: 100% 50%; }
    100% { background-position: 0% 50%; }
  }

  .desktop-mode-container ::-webkit-scrollbar {
    width: 8px;
    height: 8px;
  }

  .desktop-mode-container ::-webkit-scrollbar-track {
    background: rgba(0, 0, 0, 0.2);
  }

  .desktop-mode-container ::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.2);
    border-radius: 4px;
  }

  .desktop-mode-container ::-webkit-scrollbar-thumb:hover {
    background: rgba(255, 255, 255, 0.3);
  }
`;

interface DesktopModeProps {
  sessionId: string;
}

export function DesktopMode({ sessionId }: DesktopModeProps) {
  const containerRef = useRef<HTMLDivElement>(null);
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
        return <TerminalApp sessionId={effectiveSessionId} />;
      case "textEditor":
        return (
          <TextEditorApp
            sessionId={effectiveSessionId}
            filePath={window.data?.filePath as string}
          />
        );
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

  if (disconnected) {
    return (
      <div className="flex h-full items-center justify-center bg-[#1a1a2e] text-white/50">
        连接已断开
      </div>
    );
  }

  if (showLogin) {
    return (
      <div className="desktop-mode-container" ref={containerRef}>
        <style>{desktopStyles}</style>
        <DesktopLogin
          onLogin={handleLogin}
          loading={loginLoading}
          error={loginError}
        />
      </div>
    );
  }

  return (
    <div className="desktop-mode-container" ref={containerRef}>
      <style>{desktopStyles}</style>

      <DesktopSurface onOpenApp={handleOpenApp} />

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
  );
}
