import { useState, useEffect } from "react";
import { Minus, Square, X } from "lucide-react";
import type { WindowState } from "./types";

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
          y: Math.max(0, Math.min(newY, maxY)),
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
        top: 0,
        width: "100%",
        height: "100%",
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
      className={`absolute overflow-hidden rounded-lg shadow-2xl transition-shadow ${
        isActive
          ? "shadow-black/70 ring-1 ring-blue-500/30"
          : "shadow-black/50"
      } ${win.isMaximized ? "rounded-none" : ""}`}
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
        className="desktop-window-titlebar flex h-8 cursor-default select-none items-center justify-between px-3"
        style={{
          background:
            "linear-gradient(180deg, #323246 0%, #28283c 100%)",
          borderBottom: "1px solid rgba(255, 255, 255, 0.08)",
        }}
        onDoubleClick={onMaximize}
      >
        <span className="text-sm font-medium text-white/90">
          {win.title}
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={(e) => {
              e.stopPropagation();
              onMinimize();
            }}
            className="flex h-6 w-6 items-center justify-center rounded transition-colors hover:bg-white/10"
          >
            <Minus className="h-3.5 w-3.5 text-white/70" />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onMaximize();
            }}
            className="flex h-6 w-6 items-center justify-center rounded transition-colors hover:bg-white/10"
          >
            <Square className="h-3 w-3 text-white/70" />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            className="flex h-6 w-6 items-center justify-center rounded transition-colors hover:bg-red-500"
          >
            <X className="h-3.5 w-3.5 text-white/70 hover:text-white" />
          </button>
        </div>
      </div>

      <div className="h-[calc(100%-32px)] overflow-hidden bg-[#1e1e2e]">
        {children}
      </div>
    </div>
  );
}
