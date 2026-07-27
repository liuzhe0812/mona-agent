import {
  AppWindow,
  Crosshair,
  ExternalLink,
  FolderInput,
  FolderOpen,
  GitMerge,
  Pencil,
  Replace,
  Search,
  SplitSquareHorizontal,
  SplitSquareVertical,
  Star,
  X,
} from "lucide-react";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";

import type { Notebook, OperationNote } from "./notes-data";

interface NoteTabBarProps {
  tabs: OperationNote[];
  activeNoteId: string | null;
  notebooks?: Notebook[];
  allNotes?: OperationNote[];
  onSelect: (noteId: string) => void;
  onClose: (noteId: string) => void;
  onCloseOthers: (noteId: string) => void;
  onCloseAll: () => void;
  onSplit?: (direction: "horizontal" | "vertical") => void;
  onOpenInNewWindow?: (note: OperationNote) => void;
  onRename?: (note: OperationNote) => void;
  onMoveToNotebook?: (note: OperationNote, notebookId: string) => void;
  onToggleFavorite?: (note: OperationNote) => void;
  onMergeNote?: (note: OperationNote, targetNoteId: string) => void;
  onFind?: (note: OperationNote) => void;
  onReplace?: (note: OperationNote) => void;
  onOpenWithDefaultApp?: (note: OperationNote) => void;
  onRevealInExplorer?: (note: OperationNote) => void;
  onShowInFileList?: (note: OperationNote) => void;
}

export function NoteTabBar({
  tabs,
  activeNoteId,
  notebooks = [],
  allNotes = [],
  onSelect,
  onClose,
  onCloseOthers,
  onCloseAll,
  onSplit,
  onOpenInNewWindow,
  onRename,
  onMoveToNotebook,
  onToggleFavorite,
  onMergeNote,
  onFind,
  onReplace,
  onOpenWithDefaultApp,
  onRevealInExplorer,
  onShowInFileList,
}: NoteTabBarProps) {
  return (
    <>
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
            <ContextMenuContent className="w-52">
              <ContextMenuItem onSelect={() => onClose(note.id)}>
                <X className="mr-2 h-3.5 w-3.5" />
                关闭标签页
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => onCloseOthers(note.id)}>
                关闭其他标签页
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => onCloseAll()}>
                关闭全部标签页
              </ContextMenuItem>
              <ContextMenuSeparator />
              {onOpenInNewWindow ? (
                <>
                  <ContextMenuItem onSelect={() => onOpenInNewWindow(note)}>
                    <AppWindow className="mr-2 h-3.5 w-3.5" />
                    在新窗口中打开
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                </>
              ) : null}
              {onRename ? (
                <ContextMenuItem onSelect={() => onRename(note)}>
                  <Pencil className="mr-2 h-3.5 w-3.5" />
                  重命名
                </ContextMenuItem>
              ) : null}
              {onMoveToNotebook ? (
                <ContextMenuSub>
                  <ContextMenuSubTrigger
                    disabled={notebooks.length <= 1}
                    className="text-[13px]"
                  >
                    <FolderInput className="mr-2 h-3.5 w-3.5" />
                    将文件移动到...
                  </ContextMenuSubTrigger>
                  <ContextMenuSubContent className="w-44">
                    {note.notebookId !== "" ? (
                      <ContextMenuItem
                        onSelect={() => onMoveToNotebook(note, "")}
                        className="text-[13px]"
                      >
                        <FolderOpen className="mr-2 h-3.5 w-3.5" />
                        根目录
                      </ContextMenuItem>
                    ) : null}
                    {note.notebookId !== "" && notebooks.length > 0 ? (
                      <ContextMenuSeparator />
                    ) : null}
                    {notebooks
                      .filter((notebook) => notebook.id !== note.notebookId)
                      .map((notebook) => (
                        <ContextMenuItem
                          key={notebook.id}
                          onSelect={() => onMoveToNotebook(note, notebook.id)}
                          className="text-[13px]"
                        >
                          {notebook.name}
                        </ContextMenuItem>
                      ))}
                  </ContextMenuSubContent>
                </ContextMenuSub>
              ) : null}
              {onToggleFavorite ? (
                <ContextMenuItem onSelect={() => onToggleFavorite(note)}>
                  <Star
                    className={cn(
                      "mr-2 h-3.5 w-3.5",
                      note.favorite && "fill-current text-amber-500",
                    )}
                  />
                  {note.favorite ? "取消收藏" : "收藏"}
                </ContextMenuItem>
              ) : null}
              {onMergeNote ? (
                <ContextMenuSub>
                  <ContextMenuSubTrigger
                    disabled={allNotes.filter((n) => n.id !== note.id).length === 0}
                    className="text-[13px]"
                  >
                    <GitMerge className="mr-2 h-3.5 w-3.5" />
                    将该笔记合并到...
                  </ContextMenuSubTrigger>
                  <ContextMenuSubContent className="max-h-[260px] w-52 overflow-y-auto">
                    {allNotes
                      .filter((n) => n.id !== note.id)
                      .map((target) => (
                        <ContextMenuItem
                          key={target.id}
                          onSelect={() => onMergeNote(note, target.id)}
                          className="text-[13px]"
                        >
                          <span className="min-w-0 truncate">{target.title || "未命名笔记"}</span>
                        </ContextMenuItem>
                      ))}
                  </ContextMenuSubContent>
                </ContextMenuSub>
              ) : null}
              <ContextMenuSeparator />
              {onFind ? (
                <ContextMenuItem onSelect={() => onFind(note)}>
                  <Search className="mr-2 h-3.5 w-3.5" />
                  查找...
                </ContextMenuItem>
              ) : null}
              {onReplace ? (
                <ContextMenuItem onSelect={() => onReplace(note)}>
                  <Replace className="mr-2 h-3.5 w-3.5" />
                  替换...
                </ContextMenuItem>
              ) : null}
              <ContextMenuSeparator />
              {onOpenWithDefaultApp ? (
                <ContextMenuItem onSelect={() => onOpenWithDefaultApp(note)}>
                  <ExternalLink className="mr-2 h-3.5 w-3.5" />
                  使用默认应用打开
                </ContextMenuItem>
              ) : null}
              {onRevealInExplorer ? (
                <ContextMenuItem onSelect={() => onRevealInExplorer(note)}>
                  <FolderOpen className="mr-2 h-3.5 w-3.5" />
                  在系统资源管理器中显示
                </ContextMenuItem>
              ) : null}
              {onShowInFileList ? (
                <ContextMenuItem onSelect={() => onShowInFileList(note)}>
                  <Crosshair className="mr-2 h-3.5 w-3.5" />
                  在文件列表中显示当前文件
                </ContextMenuItem>
              ) : null}
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={() => onSplit?.("horizontal")}>
                <SplitSquareHorizontal className="mr-2 h-3.5 w-3.5" />
                左右分屏
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => onSplit?.("vertical")}>
                <SplitSquareVertical className="mr-2 h-3.5 w-3.5" />
                上下分屏
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        );
      })}
    </>
  );
}
