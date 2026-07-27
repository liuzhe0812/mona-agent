import { useState, useEffect } from "react";
import { Minus, Plus, X } from "lucide-react";
import type { WindowState } from "./types";

const MENU_BAR_HEIGHT = 28;

interface WindowProps {
  window: WindowState;
  isActive: boolean;
  onClose: () => void;
  onMinimize: () => void;
  onMaximize: () => void;
  onActivate: () => void;
  onUpdatePosition: (position: { x: number; y: number }) => void;
  onUpdateSize: (size: { width: number; height: number }) => void;
  containerBounds: { width: number; height: number };
  children: React.ReactNode;
}

export function Window({
  window: win,
  isActive,
  onClose,
  onMinimize,
  onMaximize,
  onActivate,
  onUpdatePosition,
  onUpdateSize,
  containerBounds,
  children,
}: WindowProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [resizeDir, setResizeDir] = useState<string | null>(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [containerOffset, setContainerOffset] = useState({ x: 0, y: 0 });
  const [initialResizeState, setInitialResizeState] = useState({
    mouse: { x: 0, y: 0 },
    window: { width: 0, height: 0, x: 0, y: 0 },
  });

  useEffect(() => {
    const timer = setTimeout(() => {
      globalThis.window.dispatchEvent(new Event("resize"));
    }, 400);
    return () => clearTimeout(timer);
  }, []);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (win.isMaximized) return;
    if (
      e.target === e.currentTarget ||
      (e.target as HTMLElement).closest(".desktop-window-titlebar")
    ) {
      onActivate();
      const container = (e.currentTarget as HTMLElement).closest(
        ".desktop-mode-container",
      );
      const containerRect = container?.getBoundingClientRect();
      const offsetX = containerRect?.left ?? 0;
      const offsetY = containerRect?.top ?? 0;
      setContainerOffset({ x: offsetX, y: offsetY });
      setIsDragging(true);
      setDragOffset({
        x: e.clientX - offsetX - win.position.x,
        y: e.clientY - offsetY - win.position.y,
      });
    }
  };

  const handleResizeStart = (e: React.MouseEvent, dir: string) => {
    e.stopPropagation();
    e.preventDefault();
    onActivate();
    setIsResizing(true);
    setResizeDir(dir);
    setInitialResizeState({
      mouse: { x: e.clientX, y: e.clientY },
      window: {
        width: win.size.width,
        height: win.size.height,
        x: win.position.x,
        y: win.position.y,
      },
    });
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (isDragging && !win.isMaximized) {
        const newX = e.clientX - containerOffset.x - dragOffset.x;
        const newY = e.clientY - containerOffset.y - dragOffset.y;

        const maxX = containerBounds.width - win.size.width;
        const maxY = containerBounds.height - win.size.height;

        onUpdatePosition({
          x: Math.max(0, Math.min(newX, maxX)),
          y: Math.max(MENU_BAR_HEIGHT, Math.min(newY, maxY)),
        });
      }

      if (isResizing && resizeDir) {
        const deltaX = e.clientX - initialResizeState.mouse.x;
        const deltaY = e.clientY - initialResizeState.mouse.y;

        let newWidth = initialResizeState.window.width;
        let newHeight = initialResizeState.window.height;
        let newX = initialResizeState.window.x;
        let newY = initialResizeState.window.y;

        if (resizeDir.includes("e")) newWidth += deltaX;
        if (resizeDir.includes("w")) {
          newWidth -= deltaX;
          newX += deltaX;
        }
        if (resizeDir.includes("s")) newHeight += deltaY;
        if (resizeDir.includes("n")) {
          newHeight -= deltaY;
          newY += deltaY;
        }

        if (newWidth < 400) {
          if (resizeDir.includes("w")) newX -= 400 - newWidth;
          newWidth = 400;
        }
        if (newHeight < 300) {
          if (resizeDir.includes("n")) newY -= 300 - newHeight;
          newHeight = 300;
        }

        if (resizeDir.includes("n") && newY < MENU_BAR_HEIGHT) {
          newHeight -= MENU_BAR_HEIGHT - newY;
          newY = MENU_BAR_HEIGHT;
        }

        if (resizeDir.includes("n") || resizeDir.includes("w")) {
          onUpdatePosition({ x: newX, y: newY });
        }
        onUpdateSize({ width: newWidth, height: newHeight });
      }
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      setIsResizing(false);
      setResizeDir(null);
    };

    if (isDragging || isResizing) {
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    }

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [
    isDragging,
    isResizing,
    dragOffset,
    containerOffset,
    win.size,
    win.isMaximized,
    resizeDir,
    initialResizeState,
    onUpdatePosition,
    onUpdateSize,
    containerBounds,
  ]);

  if (win.isMinimized) return null;

  const style = win.isMaximized
    ? {
        left: 0,
        top: MENU_BAR_HEIGHT,
        width: "100%",
        height: `calc(100% - ${MENU_BAR_HEIGHT}px)`,
        zIndex: 99999,
        borderRadius: 0,
      }
    : {
        left: win.position.x,
        top: win.position.y,
        width: win.size.width,
        height: win.size.height,
        zIndex: win.zIndex,
      };

  return (
    <div
      className={`absolute overflow-hidden ${
        win.isMaximized ? "rounded-none" : "rounded-[10px]"
      } ${
        isActive
          ? "shadow-[0_28px_80px_-12px_rgba(0,0,0,0.7)] ring-1 ring-white/15"
          : "shadow-[0_14px_44px_-10px_rgba(0,0,0,0.55)] ring-1 ring-white/10"
      }`}
      style={style}
      onMouseDown={handleMouseDown}
    >
      {!win.isMaximized && (
        <>
          <div
            className="absolute top-0 left-0 z-50 h-full w-1 cursor-w-resize"
            onMouseDown={(e) => handleResizeStart(e, "w")}
          />
          <div
            className="absolute top-0 right-0 z-50 h-full w-1 cursor-e-resize"
            onMouseDown={(e) => handleResizeStart(e, "e")}
          />
          <div
            className="absolute top-0 left-0 z-50 h-1 w-full cursor-n-resize"
            onMouseDown={(e) => handleResizeStart(e, "n")}
          />
          <div
            className="absolute bottom-0 left-0 z-50 h-1 w-full cursor-s-resize"
            onMouseDown={(e) => handleResizeStart(e, "s")}
          />
          <div
            className="absolute top-0 left-0 z-50 h-3 w-3 cursor-nw-resize"
            onMouseDown={(e) => handleResizeStart(e, "nw")}
          />
          <div
            className="absolute top-0 right-0 z-50 h-3 w-3 cursor-ne-resize"
            onMouseDown={(e) => handleResizeStart(e, "ne")}
          />
          <div
            className="absolute bottom-0 left-0 z-50 h-3 w-3 cursor-sw-resize"
            onMouseDown={(e) => handleResizeStart(e, "sw")}
          />
          <div
            className="absolute bottom-0 right-0 z-50 h-3 w-3 cursor-se-resize"
            onMouseDown={(e) => handleResizeStart(e, "se")}
          />
        </>
      )}

      <div
        className="desktop-window-titlebar relative flex h-8 cursor-default select-none items-center px-3"
        style={{
          background: isActive
            ? "linear-gradient(180deg, #3b3b40 0%, #333338 100%)"
            : "linear-gradient(180deg, #2e2e33 0%, #2a2a2f 100%)",
          borderBottom: "1px solid rgba(0, 0, 0, 0.35)",
        }}
        onDoubleClick={onMaximize}
      >
        <div className="group flex items-center gap-2">
          <button
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            className={`flex h-3 w-3 items-center justify-center rounded-full border ${
              isActive
                ? "border-[#d44b43] bg-[#ff5f57]"
                : "border-white/10 bg-white/20"
            }`}
          >
            {isActive && (
              <X
                className="h-2 w-2 text-[#7a1a12] opacity-0 transition-opacity group-hover:opacity-100"
                strokeWidth={3.5}
              />
            )}
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onMinimize();
            }}
            className={`flex h-3 w-3 items-center justify-center rounded-full border ${
              isActive
                ? "border-[#d89e24] bg-[#febc2e]"
                : "border-white/10 bg-white/20"
            }`}
          >
            {isActive && (
              <Minus
                className="h-2 w-2 text-[#8a5a00] opacity-0 transition-opacity group-hover:opacity-100"
                strokeWidth={3.5}
              />
            )}
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onMaximize();
            }}
            className={`flex h-3 w-3 items-center justify-center rounded-full border ${
              isActive
                ? "border-[#1dad2b] bg-[#28c840]"
                : "border-white/10 bg-white/20"
            }`}
          >
            {isActive && (
              <Plus
                className="h-2 w-2 text-[#0e5f16] opacity-0 transition-opacity group-hover:opacity-100"
                strokeWidth={3.5}
              />
            )}
          </button>
        </div>
        <span
          className={`absolute left-1/2 -translate-x-1/2 text-[13px] font-medium ${
            isActive ? "text-white/85" : "text-white/40"
          }`}
        >
          {win.title}
        </span>
      </div>

      <div className="h-[calc(100%-32px)] overflow-hidden bg-[#1d1d1f]">
        {children}
      </div>
    </div>
  );
}
