import { useState, useMemo } from "react";
import {
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
  icon: typeof Folder;
  tile: string;
}[] = [
  { type: "fileManager", name: "文件管理器", icon: Folder, tile: "from-sky-400 to-blue-600" },
  { type: "terminal", name: "终端", icon: Terminal, tile: "from-zinc-600 to-zinc-900" },
  { type: "taskManager", name: "任务管理器", icon: Activity, tile: "from-emerald-400 to-green-600" },
  { type: "recycleBin", name: "回收站", icon: Trash2, tile: "from-zinc-400 to-zinc-600" },
];

function AppIconTile({
  icon: IconComp,
  tile,
  size = "h-11 w-11",
  iconSize = "h-6 w-6",
}: {
  icon: typeof Folder;
  tile: string;
  size?: string;
  iconSize?: string;
}) {
  return (
    <div
      className={`relative flex ${size} items-center justify-center overflow-hidden rounded-[12px] border border-white/25 bg-gradient-to-b ${tile} shadow-md`}
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 h-1/2 bg-gradient-to-b from-white/30 to-transparent" />
      <IconComp className={`${iconSize} text-white drop-shadow`} />
    </div>
  );
}

function DockIcon({
  children,
  onClick,
  tooltip,
  isRunning,
}: {
  children: React.ReactNode;
  onClick: () => void;
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
        transform: isHovered ? "scale(1.35) translateY(-10px)" : "scale(1)",
        transition: "transform 0.18s cubic-bezier(0.22, 1, 0.36, 1)",
        transformOrigin: "bottom center",
      }}
    >
      {tooltip && isHovered && (
        <div className="absolute -top-9 left-1/2 z-50 -translate-x-1/2 whitespace-nowrap rounded-md border border-white/10 bg-[#1e1e22]/90 px-2.5 py-1 text-xs text-white shadow-lg backdrop-blur">
          {tooltip}
        </div>
      )}
      <button onClick={onClick} className="relative flex items-center justify-center">
        {children}
      </button>
      <div
        className={`mt-0.5 h-1 w-1 rounded-full ${
          isRunning ? "bg-black/60" : "bg-transparent"
        }`}
      />
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

  const handleWindowClick = (windowId: string, isMinimized: boolean) => {
    if (activeWindowId === windowId && !isMinimized) {
      onMinimizeWindow(windowId);
    } else {
      onRestoreWindow(windowId);
    }
  };

  return (
    <div className="absolute bottom-2 left-1/2 z-[100000] -translate-x-1/2">
      <div className="flex items-end gap-1.5 rounded-[20px] border border-white/25 bg-white/15 p-1.5 shadow-[0_16px_48px_rgba(0,0,0,0.4)] backdrop-blur-2xl">
        {DOCK_APPS.map((app) => {
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

          return (
            <DockIcon
              key={app.name}
              onClick={handleClick}
              isRunning={isRunning}
              tooltip={app.name}
            >
              <AppIconTile icon={app.icon} tile={app.tile} />
            </DockIcon>
          );
        })}

        <div className="mx-1 h-10 w-px self-center bg-white/25" />

        <DockIcon onClick={onDisconnect} tooltip="断开连接">
          <AppIconTile icon={Unplug} tile="from-rose-400 to-red-600" iconSize="h-5 w-5" />
        </DockIcon>
      </div>
    </div>
  );
}
