import { useState } from "react";
import { FileText, X, Pin, PinOff, Copy, CopyX, ArrowRightToLine, Clock, VolumeX, Volume2, Eye, Moon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Tab } from "@/hooks/useBrowserTabs";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

function getFaviconUrl(url: string): string | null {
  try {
    const { hostname } = new URL(url);
    if (!hostname) return null;
    return `https://www.google.com/s2/favicons?domain=${hostname}&sz=16`;
  } catch {
    return null;
  }
}

interface BrowserTabProps {
  tab: Tab;
  active: boolean;
  onClick: () => void;
  onClose?: () => void;
  onPinToggle?: () => void;
  onDuplicate?: () => void;
  onCloseOthers?: () => void;
  onCloseRight?: () => void;
  onReorder?: (fromId: string, toId: string) => void;
  onToggleMute?: () => void;
}

export function BrowserTabItem({
  tab,
  active,
  onClick,
  onClose,
  onPinToggle,
  onDuplicate,
  onCloseOthers,
  onCloseRight,
  onReorder,
  onToggleMute,
}: BrowserTabProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const faviconUrl = tab.type === "browser" && tab.url ? getFaviconUrl(tab.url) : null;
  const isPinned = tab.isPinned;

  const handleDragStart = (e: React.DragEvent) => {
    if (tab.type === "mona") {
      e.preventDefault();
      return;
    }
    e.dataTransfer.setData("text/tab-id", tab.id);
    e.dataTransfer.effectAllowed = "move";
  };

  const handleDragOver = (e: React.DragEvent) => {
    if (tab.type === "mona") return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (!isDragOver) setIsDragOver(true);
  };

  const handleDragLeave = () => {
    setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const fromId = e.dataTransfer.getData("text/tab-id");
    if (fromId && fromId !== tab.id && onReorder) {
      onReorder(fromId, tab.id);
    }
  };

  const tabContent = (
    <button
      type="button"
      onClick={onClick}
      draggable={tab.type !== "mona"}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={cn(
        "group flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] transition-colors",
        isPinned ? "max-w-[40px] justify-center" : "max-w-[180px]",
        active
          ? "bg-primary/15 text-foreground font-medium"
          : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground",
        isDragOver && "ring-2 ring-primary/40 ring-offset-1"
      )}
      title={isPinned ? tab.title : undefined}
    >
      {faviconUrl ? (
        <img src={faviconUrl} alt="" className="shrink-0 h-4 w-4 rounded-sm" onError={(e) => { e.currentTarget.style.display = "none"; }} />
      ) : tab.type === "md-reader" ? (
        <FileText className="shrink-0 h-3.5 w-3.5 text-[#eba45d]" />
      ) : tab.type === "history" ? (
        <Clock className="shrink-0 h-3.5 w-3.5 text-muted-foreground" />
      ) : tab.type !== "mona" ? (
        <span className="shrink-0 text-[11px]">{tab.isAiControlled ? "🤖" : "🌐"}</span>
      ) : null}
      {!isPinned && <span className="truncate">{tab.title}</span>}
      {!isPinned && tab.isIncognito && (
        <Eye className="shrink-0 h-3 w-3 text-muted-foreground" />
      )}
      {!isPinned && tab.isMuted && (
        <VolumeX className="shrink-0 h-3 w-3 text-muted-foreground" />
      )}
      {!isPinned && tab.isDarkMode && (
        <Moon className="shrink-0 h-3 w-3 text-muted-foreground" />
      )}
      {!isPinned && tab.type !== "mona" && onClose && (
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.stopPropagation(); onClose(); }
          }}
          className="ml-auto shrink-0 flex items-center justify-center w-4 h-4 rounded-sm hover:bg-destructive/20"
        >
          <X className="h-2.5 w-2.5" />
        </span>
      )}
    </button>
  );

  // Mona 标签或无上下文菜单处理器时直接返回
  if (tab.type === "mona" || !onPinToggle) {
    return tabContent;
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        {tabContent}
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuItem onClick={onPinToggle}>
          {isPinned ? (
            <>
              <PinOff className="mr-2 h-3.5 w-3.5" />
              取消固定
            </>
          ) : (
            <>
              <Pin className="mr-2 h-3.5 w-3.5" />
              固定标签
            </>
          )}
        </ContextMenuItem>
        <ContextMenuItem onClick={onDuplicate}>
          <Copy className="mr-2 h-3.5 w-3.5" />
          复制标签
        </ContextMenuItem>
        {onToggleMute && (
          <ContextMenuItem onClick={onToggleMute}>
            {tab.isMuted ? (
              <VolumeX className="mr-2 h-3.5 w-3.5" />
            ) : (
              <Volume2 className="mr-2 h-3.5 w-3.5" />
            )}
            {tab.isMuted ? "取消静音" : "静音标签"}
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onClick={onClose}>
          <X className="mr-2 h-3.5 w-3.5" />
          关闭
        </ContextMenuItem>
        {onCloseOthers && (
          <ContextMenuItem onClick={onCloseOthers}>
            <CopyX className="mr-2 h-3.5 w-3.5" />
            关闭其他
          </ContextMenuItem>
        )}
        {onCloseRight && (
          <ContextMenuItem onClick={onCloseRight}>
            <ArrowRightToLine className="mr-2 h-3.5 w-3.5" />
            关闭右侧标签
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
