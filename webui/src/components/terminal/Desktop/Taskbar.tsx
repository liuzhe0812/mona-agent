import { useState, useMemo } from "react";
import {
  Monitor,
  Terminal,
  Activity,
  Trash2,
  Folder,
  Unplug,
} from "lucide-react";
import type { WindowState, AppType } from "./types";

interface TaskbarProps {
  windows: WindowState[];
  activeWindowId: string | null;
  onRestoreWindow: (id: string) => void;
  onMinimizeWindow: (id: string) => void;
  onOpenApp: (type: AppType, title: string, data?: Record<string, unknown>) => void;
  onDisconnect: () => void;
}

const DOCK_APPS: {
  type: AppType;
  name: string;
  icon: typeof Monitor;
}[] = [
  { type: "fileManager", name: "文件管理器", icon: Folder },
  { type: "terminal", name: "终端", icon: Terminal },
  { type: "taskManager", name: "任务管理器", icon: Activity },
  { type: "recycleBin", name: "回收站", icon: Trash2 },
];

function DockIcon({
  children,
  onClick,
  isActive,
  tooltip,
  isRunning,
}: {
  children: React.ReactNode;
  onClick: () => void;
  isActive?: boolean;
  tooltip?: string;
  isRunning?: boolean;
}) {
  const [isHovered, setIsHovered] = useState(false);

  return (
    <div
      className="relative flex flex-col items-center"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      style={{
        transform: isHovered ? "scale(1.3) translateY(-8px)" : "scale(1)",
        transition: "transform 0.2s cubic-bezier(0.25, 0.46, 0.45, 0.94)",
      }}
    >
      {tooltip && isHovered && (
        <div className="absolute -top-10 left-1/2 z-50 -translate-x-1/2 whitespace-nowrap rounded-md bg-gray-800/95 px-2.5 py-1 text-xs text-white shadow-lg">
          {tooltip}
        </div>
      )}
      <button
        onClick={onClick}
        className={`relative flex h-8 w-8 items-center justify-center transition-opacity duration-200 ${
          isActive ? "opacity-100" : "opacity-80 hover:opacity-100"
        }`}
      >
        {children}
      </button>
      {isRunning && (
        <div className="absolute -bottom-0.5 h-1 w-1 rounded-full bg-white/70" />
      )}
      {isActive && (
        <div className="absolute -bottom-0.5 h-1.5 w-1.5 rounded-full bg-white" />
      )}
    </div>
  );
}

export function Taskbar({
  windows,
  activeWindowId,
  onRestoreWindow,
  onMinimizeWindow,
  onOpenApp,
  onDisconnect,
}: TaskbarProps) {
  const runningApps = useMemo(() => {
    const apps = new Set<AppType>();
    windows.forEach((w) => {
      if (!w.isMinimized) {
        apps.add(w.type);
      }
    });
    return apps;
  }, [windows]);

  const activeApp = useMemo(() => {
    const activeWindow = windows.find(
      (w) => w.id === activeWindowId && !w.isMinimized,
    );
    return activeWindow?.type;
  }, [windows, activeWindowId]);

  const handleWindowClick = (windowId: string, isMinimized: boolean) => {
    if (activeWindowId === windowId && !isMinimized) {
      onMinimizeWindow(windowId);
    } else {
      onRestoreWindow(windowId);
    }
  };

  return (
    <div className="absolute bottom-2 left-1/2 z-[9999] -translate-x-1/2">
      <div className="flex items-center gap-1 rounded-xl border border-white/20 bg-white/15 px-2 py-1.5 shadow-2xl shadow-black/50 backdrop-blur-2xl">
        {DOCK_APPS.map((app) => {
          const isActive = activeApp === app.type;
          const isRunning = runningApps.has(app.type);

          const handleClick = () => {
            if (app.type === null) return;
            const existingWindow = windows.find((w) => w.type === app.type);
            if (existingWindow) {
              handleWindowClick(existingWindow.id, existingWindow.isMinimized);
            } else {
              onOpenApp(app.type, app.name);
            }
          };

          const IconComp = app.icon;

          return (
            <DockIcon
              key={app.name}
              onClick={handleClick}
              isActive={isActive}
              isRunning={isRunning}
              tooltip={app.name}
            >
              <div className="text-white drop-shadow-lg">
                <IconComp className="h-6 w-6" />
              </div>
            </DockIcon>
          );
        })}

        <div className="mx-0.5 h-6 w-px self-center bg-white/20" />

        <DockIcon onClick={onDisconnect} tooltip="断开连接">
          <div className="text-red-400/90 hover:text-red-300 drop-shadow-lg">
            <Unplug className="h-5 w-5" />
          </div>
        </DockIcon>
      </div>
    </div>
  );
}
