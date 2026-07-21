import { useState, useRef, useCallback, useEffect } from "react";
import {
  Monitor,
  Terminal,
  Trash2,
  Activity,
  FolderOpen,
  FolderPlus,
  FilePlus,
  RotateCw,
  ClipboardPaste,
} from "lucide-react";
import type { DesktopIcon, AppType } from "./types";

const GRID_SIZE = 80;
const GRID_PADDING = 12;

const desktopIcons: DesktopIcon[] = [
  { id: "1", name: "此电脑", icon: "monitor", appType: "fileManager" },
  { id: "2", name: "终端", icon: "terminal", appType: "terminal" },
  { id: "3", name: "回收站", icon: "trash", appType: "recycleBin" },
  { id: "4", name: "任务管理器", icon: "activity", appType: "taskManager" },
];

function getIconComponent(iconName: string) {
  let tile = "from-sky-400 to-blue-600";
  let glyph = <Monitor className="h-6 w-6 text-white drop-shadow" />;
  switch (iconName) {
    case "monitor":
      break;
    case "terminal":
      tile = "from-zinc-600 to-zinc-900";
      glyph = <Terminal className="h-6 w-6 text-white drop-shadow" />;
      break;
    case "trash":
      tile = "from-zinc-400 to-zinc-600";
      glyph = <Trash2 className="h-6 w-6 text-white drop-shadow" />;
      break;
    case "activity":
      tile = "from-emerald-400 to-green-600";
      glyph = <Activity className="h-6 w-6 text-white drop-shadow" />;
      break;
  }
  return (
    <div
      className={`relative flex h-11 w-11 items-center justify-center overflow-hidden rounded-[12px] border border-white/25 bg-gradient-to-b ${tile} shadow-md`}
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 h-1/2 bg-gradient-to-b from-white/30 to-transparent" />
      {glyph}
    </div>
  );
}

interface SelectionBox {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

interface ContextMenuState {
  x: number;
  y: number;
  iconId: string | null;
}

interface DesktopSurfaceProps {
  onOpenApp: (type: AppType, title: string, data?: Record<string, unknown>) => void;
  onDesktopContextMenu?: (action: string, data?: Record<string, unknown>) => void;
}

function isIntersecting(
  rect: DOMRect,
  box: SelectionBox,
): boolean {
  const left = Math.min(box.startX, box.endX);
  const right = Math.max(box.startX, box.endX);
  const top = Math.min(box.startY, box.endY);
  const bottom = Math.max(box.startY, box.endY);
  return !(rect.right < left || rect.left > right || rect.bottom < top || rect.top > bottom);
}

export function DesktopSurface({ onOpenApp, onDesktopContextMenu }: DesktopSurfaceProps) {
  const [selectedIcon, setSelectedIcon] = useState<string | null>(null);
  const [selectedIcons, setSelectedIcons] = useState<Set<string>>(new Set());
  const [selectionBox, setSelectionBox] = useState<SelectionBox | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const isSelectingRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = () => setContextMenu(null);
    window.addEventListener("click", handleClick);
    return () => window.removeEventListener("click", handleClick);
  }, []);

  const handleIconClick = (icon: DesktopIcon) => {
    setSelectedIcon(icon.id);
    setSelectedIcons(new Set([icon.id]));
    setContextMenu(null);
  };

  const handleIconDoubleClick = (icon: DesktopIcon) => {
    if (icon.appType) {
      const titles: Record<string, string> = {
        fileManager: icon.name === "此电脑" ? "此电脑" : "文件",
        taskManager: "任务管理器",
        terminal: "终端",
        recycleBin: "回收站",
      };
      const data: Record<string, unknown> | undefined =
        icon.name === "此电脑" ? { path: "" } : undefined;
      onOpenApp(icon.appType, titles[icon.appType] || icon.name, data);
    }
  };

  const handleIconContextMenu = (e: React.MouseEvent, icon: DesktopIcon) => {
    e.preventDefault();
    e.stopPropagation();
    setSelectedIcon(icon.id);
    setSelectedIcons(new Set([icon.id]));
    setContextMenu({ x: e.clientX, y: e.clientY, iconId: icon.id });
  };

  const handleDesktopContextMenu = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest(".desktop-icon")) return;
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, iconId: null });
    setSelectedIcons(new Set());
    setSelectedIcon(null);
  };

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest(".desktop-icon")) return;

    const containerRect = containerRef.current?.getBoundingClientRect();
    if (!containerRect) return;

    isSelectingRef.current = true;
    const x = e.clientX - containerRect.left;
    const y = e.clientY - containerRect.top;
    setSelectionBox({ startX: x, startY: y, endX: x, endY: y });
    setSelectedIcons(new Set());
    setSelectedIcon(null);
    setContextMenu(null);
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isSelectingRef.current) return;

    const containerRect = containerRef.current?.getBoundingClientRect();
    if (!containerRect) return;

    const endX = e.clientX - containerRect.left;
    const endY = e.clientY - containerRect.top;

    setSelectionBox((prev) => (prev ? { ...prev, endX, endY } : null));

    const currentBox = selectionBox
      ? { ...selectionBox, endX, endY }
      : null;

    if (currentBox) {
      const newSelected = new Set<string>();
      desktopIcons.forEach((icon) => {
        const el = document.getElementById(`desktop-icon-${icon.id}`);
        if (el) {
          const rect = el.getBoundingClientRect();
          const adjustedBox: SelectionBox = {
            startX: currentBox.startX + containerRect.left,
            startY: currentBox.startY + containerRect.top,
            endX: endX + containerRect.left,
            endY: endY + containerRect.top,
          };
          if (isIntersecting(rect, adjustedBox)) {
            newSelected.add(icon.id);
          }
        }
      });
      setSelectedIcons(newSelected);
    }
  }, [selectionBox]);

  const handleMouseUp = useCallback(() => {
    isSelectingRef.current = false;
    setSelectionBox(null);
  }, []);

  const isIconSelected = (iconId: string) => {
    return selectedIcon === iconId || selectedIcons.has(iconId);
  };

  const getIconById = (id: string) => desktopIcons.find((i) => i.id === id);

  const handleMenuOpen = (icon: DesktopIcon) => {
    handleIconDoubleClick(icon);
    setContextMenu(null);
  };

  return (
    <div
      className="absolute inset-0 overflow-hidden p-3 pt-9"
      ref={containerRef}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onContextMenu={handleDesktopContextMenu}
    >
      <div className="relative h-full w-full">
        {desktopIcons.map((icon, index) => {
          const row = index % 8;
          const col = Math.floor(index / 8);
          return (
            <div
              key={icon.id}
              id={`desktop-icon-${icon.id}`}
              className={`desktop-icon absolute flex h-20 w-20 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg p-1 transition-colors hover:bg-white/10 ${
                isIconSelected(icon.id)
                  ? "border-white/25 bg-white/20 border"
                  : "border border-transparent"
              }`}
              style={{
                right: GRID_PADDING + col * GRID_SIZE,
                top: GRID_PADDING + row * GRID_SIZE,
              }}
              onClick={() => handleIconClick(icon)}
              onDoubleClick={() => handleIconDoubleClick(icon)}
              onContextMenu={(e) => handleIconContextMenu(e, icon)}
            >
              <div className="flex h-11 w-11 items-center justify-center">
                {getIconComponent(icon.icon)}
              </div>
              <span
                className={`w-full break-words rounded-sm px-1 text-center text-[11px] leading-tight drop-shadow-md line-clamp-2 ${
                  isIconSelected(icon.id)
                    ? "bg-[#0a82ff]/90 text-white"
                    : "text-white/90"
                }`}
              >
                {icon.name}
              </span>
            </div>
          );
        })}
      </div>

      {selectionBox && (
        <div
          className="pointer-events-none absolute border border-[#0a82ff]/60 bg-[#0a82ff]/15"
          style={{
            left: Math.min(selectionBox.startX, selectionBox.endX),
            top: Math.min(selectionBox.startY, selectionBox.endY),
            width: Math.abs(selectionBox.endX - selectionBox.startX),
            height: Math.abs(selectionBox.endY - selectionBox.startY),
          }}
        />
      )}

      {contextMenu && (
        <div
          ref={menuRef}
          className="fixed z-[99999] min-w-[180px] rounded-xl border border-white/15 bg-[#2b2b2f]/80 p-1 shadow-[0_16px_48px_rgba(0,0,0,0.45)] backdrop-blur-2xl"
          style={{
            top: Math.min(contextMenu.y, window.innerHeight - 250),
            left: Math.min(contextMenu.x, window.innerWidth - 180),
          }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          {contextMenu.iconId ? (
            <>
              {(() => {
                const icon = getIconById(contextMenu.iconId!);
                if (!icon) return null;
                return (
                  <>
                    <button
                      onClick={() => handleMenuOpen(icon)}
                      className="flex w-full items-center gap-2 rounded-md px-2.5 py-1 text-left text-[13px] text-white/90 transition-colors hover:bg-[#0a82ff] hover:text-white"
                    >
                      <FolderOpen className="h-3.5 w-3.5" />
                      打开
                    </button>
                  </>
                );
              })()}
            </>
          ) : (
            <>
              <button
                onClick={() => {
                  onDesktopContextMenu?.("paste");
                  setContextMenu(null);
                }}
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-1 text-left text-[13px] text-white/90 transition-colors hover:bg-[#0a82ff] hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                <ClipboardPaste className="h-3.5 w-3.5" />
                粘贴
              </button>

              <div className="mx-2 my-1 border-t border-white/10" />

              <button
                onClick={() => {
                  onDesktopContextMenu?.("newFile");
                  setContextMenu(null);
                }}
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-1 text-left text-[13px] text-white/90 transition-colors hover:bg-[#0a82ff] hover:text-white"
              >
                <FilePlus className="h-3.5 w-3.5" />
                新建文件
              </button>

              <button
                onClick={() => {
                  onDesktopContextMenu?.("newFolder");
                  setContextMenu(null);
                }}
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-1 text-left text-[13px] text-white/90 transition-colors hover:bg-[#0a82ff] hover:text-white"
              >
                <FolderPlus className="h-3.5 w-3.5" />
                新建文件夹
              </button>

              <div className="mx-2 my-1 border-t border-white/10" />

              <button
                onClick={() => {
                  onOpenApp("terminal", "终端");
                  setContextMenu(null);
                }}
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-1 text-left text-[13px] text-white/90 transition-colors hover:bg-[#0a82ff] hover:text-white"
              >
                <Terminal className="h-3.5 w-3.5" />
                打开终端
              </button>

              <button
                onClick={() => {
                  onOpenApp("fileManager", "此电脑", { path: "" });
                  setContextMenu(null);
                }}
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-1 text-left text-[13px] text-white/90 transition-colors hover:bg-[#0a82ff] hover:text-white"
              >
                <Monitor className="h-3.5 w-3.5" />
                文件管理器
              </button>

              <div className="mx-2 my-1 border-t border-white/10" />

              <button
                onClick={() => {
                  onDesktopContextMenu?.("refresh");
                  setContextMenu(null);
                }}
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-1 text-left text-[13px] text-white/90 transition-colors hover:bg-[#0a82ff] hover:text-white"
              >
                <RotateCw className="h-3.5 w-3.5" />
                刷新
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
