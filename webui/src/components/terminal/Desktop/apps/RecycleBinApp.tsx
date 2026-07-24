import { useState, useEffect, useCallback } from "react";
import {
  Trash2,
  RotateCcw,
  Folder,
  File,
  AlertTriangle,
  Loader2,
} from "lucide-react";
import { desktopExec } from "../../ipc";

interface TrashItem {
  name: string;
  trashName: string;
  originalPath: string;
  deletedDate: string;
  isDir: boolean;
  size: string;
}

interface ContextMenuState {
  x: number;
  y: number;
  targetItem: TrashItem | null;
}

interface RecycleBinAppProps {
  sessionId: string;
}

function parseTrashInfo(content: string): {
  originalPath: string;
  deletedDate: string;
} {
  let originalPath = "";
  let deletedDate = "";
  const lines = content.split("\n");
  for (const line of lines) {
    if (line.startsWith("Path=")) {
      originalPath = line.slice(5).trim();
    } else if (line.startsWith("DeletionDate=")) {
      deletedDate = line.slice(13).trim();
    }
  }
  return { originalPath, deletedDate };
}

export function RecycleBinApp({ sessionId }: RecycleBinAppProps) {
  const [items, setItems] = useState<TrashItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [confirmEmpty, setConfirmEmpty] = useState(false);

  const trashBase = "~/.local/share/Trash";
  const trashFiles = `${trashBase}/files`;
  const trashInfo = `${trashBase}/info`;

  const ensureTrashDir = useCallback(async () => {
    await desktopExec(sessionId, `mkdir -p '${trashFiles}' '${trashInfo}'`);
  }, [sessionId, trashFiles, trashInfo]);

  const loadTrashItems = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await ensureTrashDir();
      const listResult = await desktopExec(
        sessionId,
        `ls -1 '${trashFiles}' 2>/dev/null`,
      );
      const names = listResult
        .split("\n")
        .map((n) => n.trim())
        .filter(Boolean);

      if (names.length === 0) {
        setItems([]);
        return;
      }

      const trashItems: TrashItem[] = [];
      for (const name of names) {
        try {
          const infoContent = await desktopExec(
            sessionId,
            `cat '${trashInfo}/${name}.trashinfo' 2>/dev/null`,
          );
          const { originalPath, deletedDate } = parseTrashInfo(infoContent);

          const typeResult = await desktopExec(
            sessionId,
            `test -d '${trashFiles}/${name}' && echo "dir" || echo "file"`,
          );
          const isDir = typeResult.trim() === "dir";

          let size = "-";
          if (!isDir) {
            try {
              const sizeResult = await desktopExec(
                sessionId,
                `stat -c %s '${trashFiles}/${name}' 2>/dev/null`,
              );
              const bytes = parseInt(sizeResult.trim());
              if (!isNaN(bytes)) {
                size = formatBytes(bytes);
              }
            } catch {}
          }

          trashItems.push({
            name: originalPath.split("/").pop() || name,
            trashName: name,
            originalPath,
            deletedDate,
            isDir,
            size,
          });
        } catch {
          trashItems.push({
            name,
            trashName: name,
            originalPath: "",
            deletedDate: "",
            isDir: false,
            size: "-",
          });
        }
      }
      setItems(trashItems);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [sessionId, trashFiles, trashInfo, ensureTrashDir]);

  useEffect(() => {
    loadTrashItems();
  }, [loadTrashItems]);

  useEffect(() => {
    const handleClick = () => setContextMenu(null);
    window.addEventListener("click", handleClick);
    return () => window.removeEventListener("click", handleClick);
  }, []);

  const handleRestore = async (item: TrashItem) => {
    try {
      const restorePath = item.originalPath || `~/${item.name}`;
      await desktopExec(
        sessionId,
        `mkdir -p "$(dirname '${restorePath}')" && mv '${trashFiles}/${item.trashName}' '${restorePath}' && rm -f '${trashInfo}/${item.trashName}.trashinfo'`,
      );
      loadTrashItems();
    } catch (err) {
      setError(String(err));
    }
    setContextMenu(null);
  };

  const handlePermanentDelete = async (item: TrashItem) => {
    if (!confirm(`确定要永久删除 "${item.name}" 吗？此操作不可恢复。`)) return;
    try {
      const rmCmd = item.isDir
        ? `rm -rf '${trashFiles}/${item.trashName}'`
        : `rm -f '${trashFiles}/${item.trashName}'`;
      await desktopExec(
        sessionId,
        `${rmCmd} && rm -f '${trashInfo}/${item.trashName}.trashinfo'`,
      );
      loadTrashItems();
    } catch (err) {
      setError(String(err));
    }
    setContextMenu(null);
  };

  const handleRestoreSelected = async () => {
    const selectedItems = items.filter((i) => selectedIds.has(i.trashName));
    for (const item of selectedItems) {
      await handleRestore(item);
    }
    setSelectedIds(new Set());
  };

  const handleDeleteSelected = async () => {
    const selectedItems = items.filter((i) => selectedIds.has(i.trashName));
    if (!confirm(`确定要永久删除 ${selectedItems.length} 个项目吗？此操作不可恢复。`))
      return;
    try {
      for (const item of selectedItems) {
        const rmCmd = item.isDir
          ? `rm -rf '${trashFiles}/${item.trashName}'`
          : `rm -f '${trashFiles}/${item.trashName}'`;
        await desktopExec(
          sessionId,
          `${rmCmd} && rm -f '${trashInfo}/${item.trashName}.trashinfo'`,
        );
      }
      setSelectedIds(new Set());
      loadTrashItems();
    } catch (err) {
      setError(String(err));
    }
  };

  const handleEmptyTrash = async () => {
    try {
      await desktopExec(
        sessionId,
        `rm -rf '${trashFiles}'/* '${trashInfo}'/* 2>/dev/null; rm -rf '${trashFiles}'/.[!.]* '${trashInfo}'/.[!.]* 2>/dev/null`,
      );
      setConfirmEmpty(false);
      loadTrashItems();
    } catch (err) {
      setError(String(err));
    }
  };

  const handleContextMenu = (
    e: React.MouseEvent,
    item: TrashItem | null,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    if (item) {
      setSelectedIds(new Set([item.trashName]));
    }
    setContextMenu({ x: e.clientX, y: e.clientY, targetItem: item });
  };

  return (
    <div className="flex h-full flex-col" onClick={() => setContextMenu(null)}>
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-white/5 px-3">
        <Trash2 className="h-4 w-4 text-gray-400" />
        <span className="text-sm text-white/80">回收站</span>
        <span className="text-xs text-white/40">({items.length} 个项目)</span>
        <div className="flex-1" />
        {selectedIds.size > 0 && (
          <>
            <button
              onClick={handleRestoreSelected}
              className="flex items-center gap-1 rounded px-2 py-1 text-xs text-white/70 hover:bg-white/10 hover:text-white"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              还原所选
            </button>
            <button
              onClick={handleDeleteSelected}
              className="flex items-center gap-1 rounded px-2 py-1 text-xs text-red-400/80 hover:bg-red-500/10 hover:text-red-300"
            >
              <Trash2 className="h-3.5 w-3.5" />
              永久删除
            </button>
          </>
        )}
        {items.length > 0 && (
          <button
            onClick={() => setConfirmEmpty(true)}
            className="flex items-center gap-1 rounded px-2 py-1 text-xs text-red-400/80 hover:bg-red-500/10 hover:text-red-300"
          >
            <AlertTriangle className="h-3.5 w-3.5" />
            清空回收站
          </button>
        )}
        <button
          onClick={loadTrashItems}
          className="rounded p-1.5 text-white/60 hover:bg-white/5"
          title="刷新"
        >
          <RotateCcw className="h-4 w-4" />
        </button>
      </div>

      <div
        className="flex-1 overflow-auto"
        onContextMenu={(e) => handleContextMenu(e, null)}
      >
        {loading && (
          <div className="flex h-full items-center justify-center text-white/50">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" />
            加载中...
          </div>
        )}
        {error && (
          <div className="flex h-full items-center justify-center text-red-400">
            {error}
          </div>
        )}
        {!loading && !error && items.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center text-white/40">
            <Trash2 className="mb-4 h-16 w-16 opacity-30" />
            <div className="text-sm">回收站为空</div>
          </div>
        )}
        {!loading && !error && items.length > 0 && (
          <div>
            <div className="grid grid-cols-[1fr_100px_80px_180px] border-b border-white/10 bg-white/5 text-left text-xs font-medium text-white/50">
              <div className="px-3 py-1.5">文件名</div>
              <div className="px-3 py-1.5">大小</div>
              <div className="px-3 py-1.5">类型</div>
              <div className="px-3 py-1.5">删除时间</div>
            </div>
            {items.map((item) => (
              <div
                key={item.trashName}
                className={`grid grid-cols-[1fr_100px_80px_180px] cursor-default items-center ${
                  selectedIds.has(item.trashName)
                    ? "bg-blue-500/20 hover:bg-blue-500/30"
                    : "hover:bg-white/5"
                }`}
                onClick={(e) => {
                  if (e.ctrlKey || e.metaKey) {
                    const newSet = new Set(selectedIds);
                    if (newSet.has(item.trashName)) newSet.delete(item.trashName);
                    else newSet.add(item.trashName);
                    setSelectedIds(newSet);
                  } else {
                    setSelectedIds(new Set([item.trashName]));
                  }
                }}
                onContextMenu={(e) => handleContextMenu(e, item)}
              >
                <div className="flex items-center gap-2 overflow-hidden px-3 py-1.5">
                  {item.isDir ? (
                    <Folder className="h-4 w-4 shrink-0 text-yellow-400" />
                  ) : (
                    <File className="h-4 w-4 shrink-0 text-blue-400" />
                  )}
                  <span className="truncate text-sm text-white/80">
                    {item.name}
                  </span>
                </div>
                <div className="px-3 py-1.5 text-xs text-white/60">
                  {item.size}
                </div>
                <div className="px-3 py-1.5 text-xs text-white/60">
                  {item.isDir ? "文件夹" : "文件"}
                </div>
                <div className="px-3 py-1.5 text-xs text-white/60">
                  {item.deletedDate
                    ? new Date(item.deletedDate).toLocaleString()
                    : "-"}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {contextMenu && (
        <div
          className="fixed z-[100001] w-48 rounded-lg border border-white/10 bg-[#252526] py-1 shadow-2xl"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          {contextMenu.targetItem ? (
            <>
              <button
                onClick={() =>
                  contextMenu.targetItem && handleRestore(contextMenu.targetItem)
                }
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-white/80 hover:bg-[#37373d] hover:text-white"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                还原
              </button>
              <div className="my-0.5 border-t border-white/10" />
              <button
                onClick={() =>
                  contextMenu.targetItem &&
                  handlePermanentDelete(contextMenu.targetItem)
                }
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-red-400 hover:bg-red-500/10"
              >
                <Trash2 className="h-3.5 w-3.5" />
                永久删除
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => {
                  loadTrashItems();
                  setContextMenu(null);
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-white/80 hover:bg-[#37373d] hover:text-white"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                刷新
              </button>
              {items.length > 0 && (
                <button
                  onClick={() => {
                    setConfirmEmpty(true);
                    setContextMenu(null);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-red-400 hover:bg-red-500/10"
                >
                  <AlertTriangle className="h-3.5 w-3.5" />
                  清空回收站
                </button>
              )}
            </>
          )}
        </div>
      )}

      {confirmEmpty && (
        <div
          className="fixed inset-0 z-[100001] flex items-center justify-center bg-black/50"
          onClick={() => setConfirmEmpty(false)}
        >
          <div
            className="w-80 rounded-lg border border-white/10 bg-[#252526] p-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center gap-3">
              <AlertTriangle className="h-6 w-6 text-red-400" />
              <h3 className="text-sm font-medium text-white">清空回收站</h3>
            </div>
            <p className="mb-4 text-sm text-white/60">
              确定要永久删除回收站中的所有项目吗？此操作不可恢复。
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setConfirmEmpty(false)}
                className="rounded px-3 py-1.5 text-sm text-white/80 hover:bg-white/10"
              >
                取消
              </button>
              <button
                onClick={handleEmptyTrash}
                className="rounded bg-red-600 px-3 py-1.5 text-sm text-white hover:bg-red-500"
              >
                清空
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}
