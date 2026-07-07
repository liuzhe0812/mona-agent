import { X } from "lucide-react";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";

import type { OperationNote } from "./notes-data";

interface NoteTabBarProps {
  tabs: OperationNote[];
  activeNoteId: string | null;
  onSelect: (noteId: string) => void;
  onClose: (noteId: string) => void;
  onCloseOthers: (noteId: string) => void;
  onCloseAll: () => void;
}

export function NoteTabBar({
  tabs,
  activeNoteId,
  onSelect,
  onClose,
  onCloseOthers,
  onCloseAll,
}: NoteTabBarProps) {
  if (tabs.length === 0) return null;

  return (
    <div className="flex h-8 shrink-0 items-stretch overflow-x-auto border-b border-border/55 bg-background/50 scrollbar-thin">
      {tabs.map((note) => {
        const isActive = note.id === activeNoteId;
        return (
          <ContextMenu key={note.id}>
            <ContextMenuTrigger asChild>
              <button
                type="button"
                onClick={() => onSelect(note.id)}
                className={cn(
                  "group relative flex h-full w-[140px] shrink-0 items-center gap-1.5 border-r border-border/40 px-3 text-[12px] transition-colors",
                  isActive
                    ? "bg-background text-foreground"
                    : "bg-transparent text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                )}
              >
                {isActive ? (
                  <span className="absolute inset-x-0 top-0 h-[2px] bg-primary" />
                ) : null}
                <span className="min-w-0 flex-1 truncate text-left">{note.title || "未命名笔记"}</span>
                <span
                  role="button"
                  tabIndex={-1}
                  onClick={(e) => {
                    e.stopPropagation();
                    onClose(note.id);
                  }}
                  className="grid h-4 w-4 shrink-0 place-items-center rounded hover:bg-accent"
                >
                  <X className="h-3 w-3" />
                </span>
              </button>
            </ContextMenuTrigger>
            <ContextMenuContent className="w-40">
              <ContextMenuItem onSelect={() => onClose(note.id)}>
                <X className="mr-2 h-3.5 w-3.5" />
                关闭标签页
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => onCloseOthers(note.id)}>
                关闭其他标签页
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={onCloseAll}>
                关闭全部标签页
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        );
      })}
    </div>
  );
}
