import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Folder, Globe, Pencil, Trash2 } from "lucide-react";
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
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  browserListBookmarks,
  browserRemoveBookmark,
  browserUpdateBookmark,
  type Bookmark,
} from "@/lib/browser-ipc";
import { cn } from "@/lib/utils";

interface BookmarkBarProps {
  onNavigate: (url: string) => void;
  visible: boolean;
  onDropdownOpenChange?: (open: boolean) => void;
}

/** Group bookmarks by folder, preserving insertion order. */
function groupByFolder(bookmarks: Bookmark[]): { folder: string; items: Bookmark[] }[] {
  const map = new Map<string, Bookmark[]>();
  for (const b of bookmarks) {
    const key = b.folder || "";
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(b);
  }
  return Array.from(map.entries()).map(([folder, items]) => ({ folder, items }));
}

export function BookmarkBar({ onNavigate, visible, onDropdownOpenChange }: BookmarkBarProps) {
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [editTarget, setEditTarget] = useState<Bookmark | null>(null);
  const [editFolderTarget, setEditFolderTarget] = useState<string | null>(null);
  const [editFolderName, setEditFolderName] = useState("");
  const [editTitle, setEditTitle] = useState("");
  const [editFolder, setEditFolder] = useState("");
  const [rootDragOver, setRootDragOver] = useState(false);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout>>();

  const refresh = useCallback(() => {
    browserListBookmarks()
      .then(setBookmarks)
      .catch(() => setBookmarks([]));
  }, []);

  useEffect(() => {
    if (visible) refresh();
  }, [visible, refresh]);

  useEffect(() => {
    const handler = () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = setTimeout(refresh, 100);
    };
    window.addEventListener("bookmark-changed", handler);
    return () => {
      window.removeEventListener("bookmark-changed", handler);
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
  }, [refresh]);

  const groups = useMemo(() => groupByFolder(bookmarks), [bookmarks]);
  const rootItems = groups.find((g) => g.folder === "")?.items ?? [];
  const folderGroups = groups.filter((g) => g.folder !== "");

  const allFolderNames = useMemo(
    () => [...new Set(bookmarks.map((b) => b.folder).filter(Boolean))],
    [bookmarks],
  );

  const handleDelete = useCallback(
    async (url: string) => {
      try {
        await browserRemoveBookmark(url);
        refresh();
        window.dispatchEvent(new Event("bookmark-changed"));
      } catch (e) {
        console.error("[BookmarkBar] delete failed:", e);
      }
    },
    [refresh],
  );

  const handleDeleteFolder = useCallback(
    async (folderName: string) => {
      const folderBookmarks = bookmarks.filter((b) => b.folder === folderName);
      try {
        for (const b of folderBookmarks) {
          await browserRemoveBookmark(b.url);
        }
        refresh();
        window.dispatchEvent(new Event("bookmark-changed"));
      } catch (e) {
        console.error("[BookmarkBar] delete folder failed:", e);
      }
    },
    [bookmarks, refresh],
  );

  const handleMoveBookmark = useCallback(
    async (url: string, targetFolder: string) => {
      const b = bookmarks.find((x) => x.url === url);
      if (!b || b.folder === targetFolder) return;
      try {
        await browserUpdateBookmark(url, undefined, targetFolder);
        refresh();
        window.dispatchEvent(new Event("bookmark-changed"));
      } catch (e) {
        console.error("[BookmarkBar] move bookmark failed:", e);
      }
    },
    [bookmarks, refresh],
  );

  const handleEdit = useCallback((bookmark: Bookmark) => {
    setEditTarget(bookmark);
    setEditTitle(bookmark.title);
    setEditFolder(bookmark.folder);
  }, []);

  const handleEditSave = useCallback(async () => {
    if (!editTarget) return;
    try {
      await browserUpdateBookmark(editTarget.url, editTitle, editFolder);
      setEditTarget(null);
      refresh();
      window.dispatchEvent(new Event("bookmark-changed"));
    } catch (e) {
      console.error("[BookmarkBar] update failed:", e);
    }
  }, [editTarget, editTitle, editFolder, refresh]);

  const handleRenameFolder = useCallback(
    async () => {
      if (!editFolderTarget || !editFolderName.trim()) return;
      const folderBookmarks = bookmarks.filter((b) => b.folder === editFolderTarget);
      try {
        for (const b of folderBookmarks) {
          await browserUpdateBookmark(b.url, undefined, editFolderName.trim());
        }
        setEditFolderTarget(null);
        refresh();
        window.dispatchEvent(new Event("bookmark-changed"));
      } catch (e) {
        console.error("[BookmarkBar] rename folder failed:", e);
      }
    },
    [editFolderTarget, editFolderName, bookmarks, refresh],
  );

  if (!visible) return null;

  return (
    <>
      <div
        className={cn(
          "flex h-6 items-center gap-0.5 overflow-x-auto border-b border-border/40 bg-muted/30 px-2 scrollbar-none transition-colors",
          rootDragOver && "ring-1 ring-inset ring-primary/50 bg-accent/40",
        )}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("text/bookmark-url")) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            if (!rootDragOver) setRootDragOver(true);
          }
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) {
            setRootDragOver(false);
          }
        }}
        onDrop={(e) => {
          e.preventDefault();
          setRootDragOver(false);
          const url = e.dataTransfer.getData("text/bookmark-url");
          if (url) handleMoveBookmark(url, "");
        }}
      >
        {rootItems.map((b) => (
          <BookmarkItem
            key={b.url}
            bookmark={b}
            onNavigate={onNavigate}
            onDelete={handleDelete}
            onEdit={handleEdit}
            folderNames={allFolderNames}
            onDropdownOpenChange={onDropdownOpenChange}
            onMoveBookmark={handleMoveBookmark}
          />
        ))}
        {folderGroups.map((g) => (
          <FolderItem
            key={g.folder}
            folder={g.folder}
            items={g.items}
            onNavigate={onNavigate}
            onDelete={handleDelete}
            onDeleteFolder={handleDeleteFolder}
            onEdit={handleEdit}
            onRenameFolder={(name) => {
              setEditFolderTarget(name);
              setEditFolderName(name);
            }}
            folderNames={allFolderNames}
            onDropdownOpenChange={onDropdownOpenChange}
            onMoveBookmark={handleMoveBookmark}
          />
        ))}
        {bookmarks.length === 0 && (
          <span className="text-[11px] text-muted-foreground/60 select-none">
            收藏栏为空
          </span>
        )}
      </div>

      {/* Edit bookmark dialog */}
      <Dialog open={!!editTarget} onOpenChange={(open) => !open && setEditTarget(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>编辑收藏</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 py-2">
            <div className="grid gap-1">
              <label className="text-[12px] text-muted-foreground">标题</label>
              <Input
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                className="h-8 text-[13px]"
              />
            </div>
            <div className="grid gap-1">
              <label className="text-[12px] text-muted-foreground">文件夹</label>
              <Input
                value={editFolder}
                onChange={(e) => setEditFolder(e.target.value)}
                placeholder="留空为根目录"
                className="h-8 text-[13px]"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setEditTarget(null)}>
              取消
            </Button>
            <Button size="sm" onClick={handleEditSave}>
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rename folder dialog */}
      <Dialog open={!!editFolderTarget} onOpenChange={(open) => !open && setEditFolderTarget(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>重命名文件夹</DialogTitle>
          </DialogHeader>
          <div className="grid gap-1 py-2">
            <Input
              value={editFolderName}
              onChange={(e) => setEditFolderName(e.target.value)}
              className="h-8 text-[13px]"
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setEditFolderTarget(null)}>
              取消
            </Button>
            <Button size="sm" onClick={handleRenameFolder}>
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ── Bookmark item (in bookmark bar) ──

function BookmarkItem({
  bookmark,
  onNavigate,
  onDelete,
  onEdit,
  folderNames,
  onDropdownOpenChange,
  onMoveBookmark: _onMoveBookmark,
}: {
  bookmark: Bookmark;
  onNavigate: (url: string) => void;
  onDelete: (url: string) => void;
  onEdit: (b: Bookmark) => void;
  folderNames: string[];
  onDropdownOpenChange?: (open: boolean) => void;
  onMoveBookmark: (url: string, targetFolder: string) => void;
}) {
  return (
    <ContextMenu onOpenChange={onDropdownOpenChange}>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData("text/bookmark-url", bookmark.url);
            e.dataTransfer.effectAllowed = "move";
          }}
          className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] hover:bg-accent transition-colors max-w-[140px] cursor-grab active:cursor-grabbing"
          onClick={() => onNavigate(bookmark.url)}
          title={bookmark.url}
        >
          <Globe className="h-3 w-3 shrink-0 text-muted-foreground" />
          <span className="truncate">{bookmark.title || bookmark.url}</span>
        </button>
      </ContextMenuTrigger>
      <BookmarkContextMenu
        bookmark={bookmark}
        onDelete={onDelete}
        onEdit={onEdit}
        folderNames={folderNames}
      />
    </ContextMenu>
  );
}

// ── Folder item (in bookmark bar) ──
// Chrome-style: click opens dropdown, right-click shows context menu for the folder itself.

function FolderItem({
  folder,
  items,
  onNavigate,
  onDelete,
  onDeleteFolder,
  onEdit,
  onRenameFolder,
  folderNames,
  onDropdownOpenChange,
  onMoveBookmark,
}: {
  folder: string;
  items: Bookmark[];
  onNavigate: (url: string) => void;
  onDelete: (url: string) => void;
  onDeleteFolder: (name: string) => void;
  onEdit: (b: Bookmark) => void;
  onRenameFolder: (name: string) => void;
  folderNames: string[];
  onDropdownOpenChange?: (open: boolean) => void;
  onMoveBookmark: (url: string, targetFolder: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [dropdownPos, setDropdownPos] = useState({ left: 0, top: 0 });
  const contextMenuOpenRef = useRef(false);
  const [dragOver, setDragOver] = useState(false);

  const handleToggle = () => {
    const nextOpen = !open;
    if (nextOpen && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setDropdownPos({ left: rect.left, top: rect.bottom + 2 });
    }
    setOpen(nextOpen);
    onDropdownOpenChange?.(nextOpen || contextMenuOpenRef.current);
  };

  return (
    <ContextMenu onOpenChange={(ctxOpen) => {
      contextMenuOpenRef.current = ctxOpen;
      onDropdownOpenChange?.(ctxOpen || open);
    }}>
      <ContextMenuTrigger asChild>
        <button
          ref={triggerRef}
          type="button"
          className={cn(
            "flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-colors",
            dragOver
              ? "bg-accent ring-1 ring-primary/50"
              : "hover:bg-accent",
          )}
          onClick={handleToggle}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes("text/bookmark-url")) {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              if (!dragOver) setDragOver(true);
            }
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) {
              setDragOver(false);
            }
          }}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            const url = e.dataTransfer.getData("text/bookmark-url");
            if (url) onMoveBookmark(url, folder);
          }}
        >
          <Folder className="h-3 w-3 shrink-0 text-muted-foreground" />
          <span className="truncate">{folder}</span>
        </button>
      </ContextMenuTrigger>
      <FolderContextMenu
        onRename={() => onRenameFolder(folder)}
        onDelete={() => onDeleteFolder(folder)}
      />
      {open && (
        <>
          {/* Backdrop to close dropdown */}
          {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
          <div
            className="fixed inset-0 z-[9998]"
            onClick={() => {
              setOpen(false);
              onDropdownOpenChange?.(false || contextMenuOpenRef.current);
            }}
            onKeyDown={() => {
              setOpen(false);
              onDropdownOpenChange?.(false || contextMenuOpenRef.current);
            }}
          />
          {/* Dropdown menu */}
          <div
            className="fixed z-[9999] min-w-[180px] max-h-[320px] overflow-y-auto rounded-md border border-border bg-popover shadow-md py-0.5"
            style={{ left: dropdownPos.left, top: dropdownPos.top }}
          >
            {items.map((b) => (
              <DropdownBookmarkItem
                key={b.url}
                bookmark={b}
                onNavigate={(url) => {
                  onNavigate(url);
                  setOpen(false);
                  onDropdownOpenChange?.(false);
                }}
                onDelete={(url) => {
                  onDelete(url);
                  setOpen(false);
                  onDropdownOpenChange?.(false);
                }}
                onEdit={(bm) => {
                  onEdit(bm);
                  setOpen(false);
                  onDropdownOpenChange?.(false);
                }}
                folderNames={folderNames}
              />
            ))}
          </div>
        </>
      )}
    </ContextMenu>
  );
}

// ── Bookmark item inside folder dropdown ──
// Same as BookmarkItem but rendered in the dropdown popup.

function DropdownBookmarkItem({
  bookmark,
  onNavigate,
  onDelete,
  onEdit,
  folderNames,
}: {
  bookmark: Bookmark;
  onNavigate: (url: string) => void;
  onDelete: (url: string) => void;
  onEdit: (b: Bookmark) => void;
  folderNames: string[];
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData("text/bookmark-url", bookmark.url);
            e.dataTransfer.effectAllowed = "move";
          }}
          className="flex w-full items-center gap-1.5 px-2.5 py-1 text-[11px] hover:bg-accent transition-colors text-left cursor-grab active:cursor-grabbing"
          onClick={() => onNavigate(bookmark.url)}
          title={bookmark.url}
        >
          <Globe className="h-3 w-3 shrink-0 text-muted-foreground" />
          <span className="truncate">{bookmark.title || bookmark.url}</span>
        </button>
      </ContextMenuTrigger>
      <BookmarkContextMenu
        bookmark={bookmark}
        onDelete={onDelete}
        onEdit={onEdit}
        folderNames={folderNames}
      />
    </ContextMenu>
  );
}

// ── Context menu for a bookmark (edit, move to folder, delete) ──

function BookmarkContextMenu({
  bookmark,
  onDelete,
  onEdit,
  folderNames,
}: {
  bookmark: Bookmark;
  onDelete: (url: string) => void;
  onEdit: (b: Bookmark) => void;
  folderNames: string[];
}) {
  return (
    <ContextMenuContent className="w-48 z-[9999]">
      <ContextMenuItem
        className="text-[12px] gap-2"
        onClick={() => onEdit(bookmark)}
      >
        <Pencil className="h-3.5 w-3.5" />
        编辑
      </ContextMenuItem>
      <ContextMenuSeparator />
      {folderNames.length > 0 && (
        <ContextMenuSub>
          <ContextMenuSubTrigger className="text-[12px] gap-2">
            <Folder className="h-3.5 w-3.5" />
            移动到文件夹
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuItem
              className="text-[12px]"
              onClick={() => {
                browserUpdateBookmark(bookmark.url, undefined, "");
                window.dispatchEvent(new Event("bookmark-changed"));
              }}
            >
              根目录
            </ContextMenuItem>
            {folderNames
              .filter((f) => f !== bookmark.folder)
              .map((f) => (
                <ContextMenuItem
                  key={f}
                  className="text-[12px]"
                  onClick={() => {
                    browserUpdateBookmark(bookmark.url, undefined, f);
                    window.dispatchEvent(new Event("bookmark-changed"));
                  }}
                >
                  {f}
                </ContextMenuItem>
              ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem
        className="text-[12px] gap-2 text-destructive focus:text-destructive"
        onClick={() => onDelete(bookmark.url)}
      >
        <Trash2 className="h-3.5 w-3.5" />
        删除
      </ContextMenuItem>
    </ContextMenuContent>
  );
}

// ── Context menu for a folder (rename, delete) ──

function FolderContextMenu({
  onRename,
  onDelete,
}: {
  onRename: () => void;
  onDelete: () => void;
}) {
  return (
    <ContextMenuContent className="w-48 z-[9999]">
      <ContextMenuItem className="text-[12px] gap-2" onClick={onRename}>
        <Pencil className="h-3.5 w-3.5" />
        重命名
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem
        className="text-[12px] gap-2 text-destructive focus:text-destructive"
        onClick={onDelete}
      >
        <Trash2 className="h-3.5 w-3.5" />
        删除文件夹
      </ContextMenuItem>
    </ContextMenuContent>
  );
}
