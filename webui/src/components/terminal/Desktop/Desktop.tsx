import { useState } from "react";
import { Monitor, Terminal, Trash2, Activity } from "lucide-react";
import type { DesktopIcon, AppType } from "./types";

const GRID_SIZE = 80;
const GRID_PADDING = 12;

const desktopIcons: DesktopIcon[] = [
  { id: "1", name: "此电脑", icon: "monitor", appType: "fileManager" },
  { id: "2", name: "终端", icon: "terminal", appType: "terminal" },
  { id: "3", name: "回收站", icon: "trash", appType: null },
  { id: "4", name: "任务管理器", icon: "activity", appType: "taskManager" },
];

function getIconComponent(iconName: string, size: number) {
  const props = { size, className: "drop-shadow-md" };
  switch (iconName) {
    case "monitor":
      return <Monitor {...props} className="text-blue-400 drop-shadow-md" />;
    case "terminal":
      return <Terminal {...props} className="text-green-400 drop-shadow-md" />;
    case "trash":
      return <Trash2 {...props} className="text-gray-400 drop-shadow-md" />;
    case "activity":
      return <Activity {...props} className="text-orange-400 drop-shadow-md" />;
    default:
      return <Monitor {...props} />;
  }
}

interface DesktopSurfaceProps {
  onOpenApp: (type: AppType, title: string, data?: Record<string, unknown>) => void;
}

export function DesktopSurface({ onOpenApp }: DesktopSurfaceProps) {
  const [selectedIcon, setSelectedIcon] = useState<string | null>(null);

  const handleIconClick = (icon: DesktopIcon) => {
    setSelectedIcon(icon.id);
  };

  const handleIconDoubleClick = (icon: DesktopIcon) => {
    if (icon.appType) {
      const titles: Record<string, string> = {
        fileManager: icon.name === "此电脑" ? "此电脑" : "文件",
        taskManager: "任务管理器",
        terminal: "终端",
      };
      const data: Record<string, unknown> | undefined =
        icon.name === "此电脑" ? { path: "" } : undefined;
      onOpenApp(icon.appType, titles[icon.appType] || icon.name, data);
    }
  };

  return (
    <div className="absolute inset-0 overflow-hidden p-3 pt-4">
      <div className="relative h-full w-full">
        {desktopIcons.map((icon, index) => {
          const row = index % 8;
          const col = Math.floor(index / 8);
          return (
            <div
              key={icon.id}
              className={`absolute flex h-20 w-20 cursor-pointer flex-col items-center justify-center gap-1 rounded p-1 transition-colors hover:bg-white/10 ${
                selectedIcon === icon.id
                  ? "border-white/30 bg-white/20 border"
                  : "border border-transparent"
              }`}
              style={{
                left: GRID_PADDING + col * GRID_SIZE,
                top: GRID_PADDING + row * GRID_SIZE,
              }}
              onClick={() => handleIconClick(icon)}
              onDoubleClick={() => handleIconDoubleClick(icon)}
            >
              <div className="flex h-10 w-10 items-center justify-center">
                {getIconComponent(icon.icon, 32)}
              </div>
              <span className="w-full break-words px-1 text-center text-[11px] leading-tight text-white/90 drop-shadow-md line-clamp-2">
                {icon.name}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
