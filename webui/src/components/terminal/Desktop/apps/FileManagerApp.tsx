import { useState, useEffect, useCallback, useRef } from "react";
import {
  Folder,
  File,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  RotateCw,
  FolderPlus,
  FilePlus,
  Trash2,
  Monitor,
  HardDrive,
  Home,
  LayoutGrid,
  List,
  Star,
  Scissors,
  Copy,
  ClipboardPaste,
  Edit3,
  Archive,
  X,
} from "lucide-react";
import {
  desktopListFiles,
  desktopExec,
  desktopGetDisks,
} from "../../ipc";
import type { DesktopFileItem, DesktopDiskInfo } from "../../ipc";

interface FileManagerAppProps {
  sessionId: string;
  onOpenTextEditor?: (path: string) => void;
  initialPath?: string;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

interface ContextMenuState {
  x: number;
  y: number;
  targetIds: string[];
}

interface ClipboardState {
  op: "copy" | "cut";
  files: { path: string; name: string; isDir: boolean }[];
  sourcePath: string;
}

export function FileManagerApp({
  sessionId,
  onOpenTextEditor,
  initialPath,
}: FileManagerAppProps) {
  const [currentPath, setCurrentPath] = useState(initialPath || "");
  const [files, setFiles] = useState<DesktopFileItem[]>([]);
  const [disks, setDisks] = useState<DesktopDiskInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [viewMode, setViewMode] = useState<"grid" | "list">("list");
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [clipboard, setClipboard] = useState<ClipboardState | null>(null);
  const [currentUser, setCurrentUser] = useState<string>("root");
  const [favorites, setFavorites] = useState<{ name: string; path: string }[]>([]);
  const [renameState, setRenameState] = useState<{ id: string; name: string } | null>(null);
  const [newState, setNewState] = useState<{ type: "folder" | "file"; name: string } | null>(null);
  const [archiveState, setArchiveState] = useState<{ files: string[]; name: string } | null>(null);
  const [isEditingPath, setIsEditingPath] = useState(false);
  const [tempPath, setTempPath] = useState("");
  const contextMenuRef = useRef<HTMLDivElement>(null);

  const getUserHome = useCallback(() => {
    return currentUser === "root" ? "/root" : `/home/${currentUser}`;
  }, [currentUser]);

  const quickAccessFolders = [
    { name: "主目录", path: getUserHome() },
    { name: "根目录", path: "/" },
    { name: "日志", path: "/var/log" },
  ];

  const loadDisks = useCallback(async () => {
    try {
      const data = await desktopGetDisks(sessionId);
      setDisks(data);
    } catch {
      setDisks([]);
    }
  }, [sessionId]);

  const loadDirectory = useCallback(
    async (path: string) => {
      if (path === "") {
        setCurrentPath("");
        setError(null);
        setFiles([]);
        setSelectedIds(new Set());
        setLoading(true);
        await loadDisks();
        setLoading(false);
        return;
      }
      setLoading(true);
      setError(null);
      setSelectedIds(new Set());
      try {
        const result = await desktopListFiles(sessionId, path);
        setFiles(result.files);
        setCurrentPath(result.path);
      } catch (err) {
        setError(String(err));
        setFiles([]);
      } finally {
        setLoading(false);
      }
    },
    [sessionId, loadDisks],
  );

  useEffect(() => {
    desktopExec(sessionId, "whoami").then((user) => {
      setCurrentUser(user.trim() || "root");
    }).catch(() => {});
  }, [sessionId]);

  useEffect(() => {
    if (initialPath) {
      loadDirectory(initialPath);
    } else {
      loadDirectory("");
    }
  }, [initialPath, loadDirectory]);

  useEffect(() => {
    const handleClick = () => setContextMenu(null);
    window.addEventListener("click", handleClick);
    return () => window.removeEventListener("click", handleClick);
  }, []);

  const navigateTo = (path: string) => {
    loadDirectory(path);
  };

  const handleItemDoubleClick = (item: DesktopFileItem) => {
    if (item.type === "folder") {
      navigateTo(item.path);
    } else {
      const isTextFile =
        /\.(txt|js|ts|tsx|jsx|json|md|html|css|py|sh|log|conf|ini|xml|yaml|yml|properties|env|toml|cfg)$/i.test(
          item.name,
        ) || !item.name.includes(".");
      if (isTextFile && onOpenTextEditor) {
        onOpenTextEditor(item.path);
      }
    }
  };

  const getParentPath = () => {
    if (currentPath === "/" || currentPath === "") return "";
    const parts = currentPath.split("/").filter(Boolean);
    parts.pop();
    return parts.length === 0 ? "/" : "/" + parts.join("/");
  };

  const handleContextMenu = (e: React.MouseEvent, targetIds?: string[]) => {
    e.preventDefault();
    e.stopPropagation();
    if (targetIds) {
      setSelectedIds(new Set(targetIds));
    }
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      targetIds: targetIds || [],
    });
  };

  const handleDelete = async (ids: string[]) => {
    if (!ids.length) return;
    if (!confirm(`确定要删除 ${ids.length} 个项目吗？`)) return;
    try {
      for (const id of ids) {
        const file = files.find((f) => f.path === id);
        if (!file) continue;
        const cmd = file.type === "folder"
          ? `rm -rf '${file.path}'`
          : `rm -f '${file.path}'`;
        await desktopExec(sessionId, cmd);
      }
      loadDirectory(currentPath);
    } catch (err) {
      setError(String(err));
    }
    setContextMenu(null);
  };

  const handleNewFolder = async () => {
    if (!newState) return;
    try {
      await desktopExec(sessionId, `mkdir -p '${currentPath === "/" ? "" : currentPath}/${newState.name}'`);
      loadDirectory(currentPath);
    } catch (err) {
      setError(String(err));
    }
    setNewState(null);
  };

  const handleNewFile = async () => {
    if (!newState) return;
    try {
      await desktopExec(sessionId, `touch '${currentPath === "/" ? "" : currentPath}/${newState.name}'`);
      loadDirectory(currentPath);
    } catch (err) {
      setError(String(err));
    }
    setNewState(null);
  };

  const handleRename = async () => {
    if (!renameState) return;
    try {
      const newPath = `${currentPath === "/" ? "" : currentPath}/${renameState.name}`;
      await desktopExec(sessionId, `mv '${renameState.id}' '${newPath}'`);
      loadDirectory(currentPath);
    } catch (err) {
      setError(String(err));
    }
    setRenameState(null);
  };

  const handleArchive = async () => {
    if (!archiveState) return;
    try {
      const archiveName = `${archiveState.name}.tar.gz`;
      const fileNames = archiveState.files.map((p) => `'${p.split("/").pop()}'`).join(" ");
      await desktopExec(sessionId, `cd '${currentPath}' && tar -czf '${archiveName}' ${fileNames}`);
      loadDirectory(currentPath);
    } catch (err) {
      setError(String(err));
    }
    setArchiveState(null);
  };

  const handleCopy = (ids: string[]) => {
    const items = ids.map((id) => {
      const file = files.find((f) => f.path === id);
      return { path: id, name: file?.name || id.split("/").pop() || "", isDir: file?.type === "folder" };
    });
    setClipboard({ op: "copy", files: items, sourcePath: currentPath });
    setContextMenu(null);
  };

  const handleCut = (ids: string[]) => {
    const items = ids.map((id) => {
      const file = files.find((f) => f.path === id);
      return { path: id, name: file?.name || id.split("/").pop() || "", isDir: file?.type === "folder" };
    });
    setClipboard({ op: "cut", files: items, sourcePath: currentPath });
    setContextMenu(null);
  };

  const handlePaste = async () => {
    if (!clipboard || clipboard.files.length === 0) return;
    try {
      for (const file of clipboard.files) {
        const targetPath = `${currentPath === "/" ? "" : currentPath}/${file.name}`;
        if (clipboard.op === "cut") {
          await desktopExec(sessionId, `mv '${file.path}' '${targetPath}'`);
        } else {
          const cmd = file.isDir
            ? `cp -r '${file.path}' '${targetPath}'`
            : `cp '${file.path}' '${targetPath}'`;
          await desktopExec(sessionId, cmd);
        }
      }
      if (clipboard.op === "cut") setClipboard(null);
      loadDirectory(currentPath);
    } catch (err) {
      setError(String(err));
    }
    setContextMenu(null);
  };

  const handleToggleFavorite = (path: string, name: string) => {
    if (favorites.some((f) => f.path === path)) {
      setFavorites(favorites.filter((f) => f.path !== path));
    } else {
      setFavorites([...favorites, { name, path }]);
    }
  };

  const handleAddressBarClick = () => {
    if (!isEditingPath) {
      setIsEditingPath(true);
      setTempPath(currentPath === "" ? "/" : currentPath);
    }
  };

  const handlePathInputKeyDown = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const targetPath = tempPath.trim();
      if (targetPath === "") {
        navigateTo("");
        setIsEditingPath(false);
        return;
      }
      try {
        await desktopListFiles(sessionId, targetPath);
        navigateTo(targetPath);
        setIsEditingPath(false);
      } catch {
        setIsEditingPath(false);
      }
    } else if (e.key === "Escape") {
      setIsEditingPath(false);
    }
  };

  const sortedFiles = [...files].sort((a, b) => {
    if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return (
    <div className="flex h-full flex-col" onClick={() => setContextMenu(null)}>
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-white/5 px-2">
        <button
          onClick={() => navigateTo(getParentPath())}
          className="rounded p-1.5 text-white/60 hover:bg-white/5"
          disabled={currentPath === ""}
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <button className="rounded p-1.5 text-white/60 hover:bg-white/5">
          <ChevronRight className="h-4 w-4" />
        </button>
        <button
          onClick={() => loadDirectory(currentPath)}
          className="rounded p-1.5 text-white/60 hover:bg-white/5"
        >
          <RotateCw className="h-4 w-4" />
        </button>
        <button
          onClick={() => navigateTo(getParentPath())}
          className="rounded p-1.5 text-white/60 hover:bg-white/5"
        >
          <ChevronUp className="h-4 w-4" />
        </button>

        <div
          className="mx-2 flex-1 cursor-text rounded bg-black/20 px-3 py-1 text-sm text-white/80"
          onClick={handleAddressBarClick}
        >
          {isEditingPath ? (
            <input
              autoFocus
              type="text"
              value={tempPath}
              onChange={(e) => setTempPath(e.target.value)}
              onKeyDown={handlePathInputKeyDown}
              onBlur={() => setIsEditingPath(false)}
              className="w-full border-none bg-transparent p-0 text-sm text-white outline-none"
              onFocus={(e) => e.target.select()}
            />
          ) : (
            <div className="flex items-center gap-1 overflow-hidden">
              <button
                className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 hover:bg-white/10"
                onClick={(e) => { e.stopPropagation(); navigateTo(""); }}
              >
                <Monitor className="h-4 w-4 text-blue-400" />
                <span className="text-white/80">此电脑</span>
              </button>
              {currentPath !== "" && (
                <>
                  <ChevronRight className="h-3 w-3 shrink-0 text-white/40" />
                  <button
                    className="shrink-0 rounded px-1.5 py-0.5 hover:bg-white/10"
                    onClick={(e) => { e.stopPropagation(); navigateTo("/"); }}
                  >
                    根目录
                  </button>
                </>
              )}
              {currentPath.split("/").filter(Boolean).map((part, index, arr) => {
                const path = "/" + arr.slice(0, index + 1).join("/");
                return (
                  <span key={index} className="flex shrink-0 items-center gap-1">
                    <ChevronRight className="h-3 w-3 text-white/40" />
                    <button
                      className="max-w-[120px] truncate rounded px-1.5 py-0.5 hover:bg-white/10 hover:text-white"
                      onClick={(e) => { e.stopPropagation(); navigateTo(path); }}
                    >
                      {part}
                    </button>
                  </span>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex items-center gap-0.5">
          <button
            onClick={() => setNewState({ type: "folder", name: "新建文件夹" })}
            className="rounded p-1.5 text-white/60 hover:bg-white/5"
            title="新建文件夹"
          >
            <FolderPlus className="h-4 w-4" />
          </button>
          <button
            onClick={() => setNewState({ type: "file", name: "新建文件.txt" })}
            className="rounded p-1.5 text-white/60 hover:bg-white/5"
            title="新建文件"
          >
            <FilePlus className="h-4 w-4" />
          </button>
          <div className="mx-0.5 h-4 w-px bg-white/10" />
          <button
            onClick={() => setViewMode(viewMode === "grid" ? "list" : "grid")}
            className="rounded p-1.5 text-white/60 hover:bg-white/5"
            title={viewMode === "grid" ? "列表视图" : "网格视图"}
          >
            {viewMode === "grid" ? <List className="h-4 w-4" /> : <LayoutGrid className="h-4 w-4" />}
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="w-44 shrink-0 overflow-auto border-r border-white/5 p-2">
          <div className="mb-3">
            <div className="mb-1.5 flex items-center gap-2 text-yellow-400">
              <Star className="h-3.5 w-3.5 fill-yellow-400" />
              <span className="text-xs text-white/70">我的收藏</span>
            </div>
            {favorites.map((fav) => (
              <div
                key={fav.path}
                className="group flex items-center justify-between rounded py-1 pl-5 pr-1 hover:bg-white/5"
                onClick={() => navigateTo(fav.path)}
              >
                <div className="flex items-center gap-1.5 overflow-hidden">
                  <Folder className="h-3.5 w-3.5 shrink-0 text-yellow-400" />
                  <span className="truncate text-xs text-white/60">{fav.name}</span>
                </div>
                <button
                  className="opacity-0 group-hover:opacity-100"
                  onClick={(e) => { e.stopPropagation(); handleToggleFavorite(fav.path, fav.name); }}
                >
                  <X className="h-3 w-3 text-white/40 hover:text-white/80" />
                </button>
              </div>
            ))}
          </div>

          <div className="mb-3">
            <div
              className="mb-1.5 flex cursor-pointer items-center gap-2 text-blue-400"
              onClick={() => navigateTo("")}
            >
              <Monitor className="h-3.5 w-3.5" />
              <span className="text-xs text-white/70">此电脑</span>
            </div>
            {disks.map((disk) => (
              <div
                key={disk.mount}
                className="flex items-center gap-1.5 rounded py-1 pl-5 hover:bg-white/5"
                onClick={() => navigateTo(disk.mount)}
              >
                <HardDrive className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                <span className="truncate text-xs text-white/60">{disk.fs} ({disk.mount})</span>
              </div>
            ))}
          </div>

          <div>
            <div className="mb-1.5 flex items-center gap-2 text-green-400">
              <Home className="h-3.5 w-3.5" />
              <span className="text-xs text-white/70">快速访问</span>
            </div>
            {quickAccessFolders.map((folder) => (
              <div
                key={folder.name}
                className="flex items-center gap-1.5 rounded py-1 pl-5 hover:bg-white/5"
                onClick={() => navigateTo(folder.path)}
              >
                <Folder className="h-3.5 w-3.5 shrink-0 text-yellow-400" />
                <span className="truncate text-xs text-white/60">{folder.name}</span>
              </div>
            ))}
          </div>
        </div>

        <div
          className="flex-1 overflow-auto"
          onContextMenu={(e) => handleContextMenu(e)}
        >
          {loading && (
            <div className="flex h-full items-center justify-center text-white/50">
              加载中...
            </div>
          )}
          {error && (
            <div className="flex h-full items-center justify-center text-red-400">
              {error}
            </div>
          )}

          {!loading && !error && currentPath === "" && (
            <div className="flex flex-col gap-6 overflow-y-auto p-4">
              <div>
                <h3 className="mb-3 text-sm text-white/60">快速访问</h3>
                <div className="flex flex-wrap gap-4">
                  {quickAccessFolders.map((folder) => (
                    <div
                      key={folder.name}
                      className="flex w-20 cursor-pointer flex-col items-center gap-2 rounded-lg p-3 transition-colors hover:bg-white/5"
                      onDoubleClick={() => navigateTo(folder.path)}
                    >
                      <Folder className="h-10 w-10 text-yellow-400" />
                      <span className="text-center text-xs text-white/80">{folder.name}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <h3 className="mb-3 text-sm text-white/60">设备和驱动器 ({disks.length})</h3>
                <div className="flex flex-wrap gap-4">
                  {disks.map((disk) => (
                    <div
                      key={disk.mount}
                      className="flex w-72 cursor-pointer items-center gap-3 rounded-lg p-3 transition-colors hover:bg-white/5"
                      onDoubleClick={() => navigateTo(disk.mount)}
                    >
                      <HardDrive className="h-10 w-10 shrink-0 text-gray-400" />
                      <div className="min-w-0 flex-1">
                        <div className="mb-1.5 truncate text-sm font-medium text-white/90">
                          {disk.fs} ({disk.mount})
                        </div>
                        <div className="mb-1.5 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                          <div
                            className="h-full rounded-full bg-gradient-to-r from-blue-400 to-blue-500"
                            style={{ width: `${disk.use_percent}%` }}
                          />
                        </div>
                        <div className="whitespace-nowrap text-xs text-white/50">
                          {formatBytes(disk.available)} 可用，共 {formatBytes(disk.size)}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {!loading && !error && currentPath !== "" && sortedFiles.length === 0 && (
            <div className="flex h-full flex-col items-center justify-center text-white/40">
              <Folder className="mb-4 h-12 w-12 opacity-50" />
              <div>此文件夹为空</div>
            </div>
          )}

          {!loading && !error && currentPath !== "" && viewMode === "grid" && (
            <div className="flex flex-wrap content-start gap-1 p-3">
              {sortedFiles.map((file) => (
                <div
                  key={file.path}
                  className={`flex h-[90px] w-[90px] cursor-pointer flex-col items-center justify-center gap-1.5 rounded p-2 ${
                    selectedIds.has(file.path) ? "bg-blue-500/20 ring-1 ring-blue-500/50" : "hover:bg-white/5"
                  }`}
                  onClick={(e) => {
                    if (e.ctrlKey || e.metaKey) {
                      const newSet = new Set(selectedIds);
                      if (newSet.has(file.path)) newSet.delete(file.path);
                      else newSet.add(file.path);
                      setSelectedIds(newSet);
                    } else {
                      setSelectedIds(new Set([file.path]));
                    }
                  }}
                  onDoubleClick={() => handleItemDoubleClick(file)}
                  onContextMenu={(e) => handleContextMenu(e, [file.path])}
                >
                  {file.type === "folder" ? (
                    <Folder className="h-10 w-10 text-yellow-400" />
                  ) : (
                    <File className="h-10 w-10 text-blue-400" />
                  )}
                  <span className="line-clamp-2 w-full text-center text-[11px] leading-tight text-white/80">
                    {file.name}
                  </span>
                </div>
              ))}
            </div>
          )}

          {!loading && !error && currentPath !== "" && viewMode === "list" && (
            <div>
              <div className="grid grid-cols-[1fr_100px_80px_150px] border-b border-white/10 bg-white/5 text-left text-xs font-medium text-white/50">
                <div className="px-3 py-1.5">文件名</div>
                <div className="px-3 py-1.5">大小</div>
                <div className="px-3 py-1.5">权限</div>
                <div className="px-3 py-1.5">修改时间</div>
              </div>
              {sortedFiles.map((file) => (
                <div
                  key={file.path}
                  className={`grid grid-cols-[1fr_100px_80px_150px] cursor-default items-center ${
                    selectedIds.has(file.path) ? "bg-blue-500/20 hover:bg-blue-500/30" : "hover:bg-white/5"
                  }`}
                  onClick={(e) => {
                    if (e.ctrlKey || e.metaKey) {
                      const newSet = new Set(selectedIds);
                      if (newSet.has(file.path)) newSet.delete(file.path);
                      else newSet.add(file.path);
                      setSelectedIds(newSet);
                    } else {
                      setSelectedIds(new Set([file.path]));
                    }
                  }}
                  onDoubleClick={() => handleItemDoubleClick(file)}
                  onContextMenu={(e) => handleContextMenu(e, [file.path])}
                >
                  <div className="flex items-center gap-2 overflow-hidden px-3 py-1.5">
                    {file.type === "folder" ? (
                      <Folder className="h-4 w-4 shrink-0 text-yellow-400" />
                    ) : (
                      <File className="h-4 w-4 shrink-0 text-blue-400" />
                    )}
                    <span className="truncate text-sm text-white/80">{file.name}</span>
                  </div>
                  <div className="px-3 py-1.5 text-xs text-white/60">
                    {file.type === "folder" ? "-" : file.size}
                  </div>
                  <div className="px-3 py-1.5 text-xs text-white/60">{file.mode}</div>
                  <div className="px-3 py-1.5 text-xs text-white/60">
                    {file.modified ? new Date(file.modified).toLocaleString() : "-"}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed z-[9999] w-48 rounded-lg border border-white/10 bg-[#252526] py-1 shadow-2xl"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          {contextMenu.targetIds.length === 1 ? (
            <>
              <button
                onClick={() => {
                  const id = contextMenu.targetIds[0];
                  const file = files.find((f) => f.path === id);
                  if (file) handleItemDoubleClick(file);
                  setContextMenu(null);
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-white/80 hover:bg-[#37373d] hover:text-white"
              >
                <Folder className="h-3.5 w-3.5" />
                打开
              </button>
              {(() => {
                const id = contextMenu.targetIds[0];
                const file = files.find((f) => f.path === id);
                if (file && file.type === "folder") {
                  const isFav = favorites.some((f) => f.path === file.path);
                  return (
                    <button
                      onClick={() => { handleToggleFavorite(file.path, file.name); setContextMenu(null); }}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-white/80 hover:bg-[#37373d] hover:text-white"
                    >
                      <Star className={`h-3.5 w-3.5 ${isFav ? "fill-yellow-400 text-yellow-400" : ""}`} />
                      {isFav ? "取消收藏" : "收藏"}
                    </button>
                  );
                }
                return null;
              })()}
              <div className="my-0.5 border-t border-white/10" />
              <button
                onClick={() => handleCut(contextMenu.targetIds)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-white/80 hover:bg-[#37373d] hover:text-white"
              >
                <Scissors className="h-3.5 w-3.5" />
                剪切
              </button>
              <button
                onClick={() => handleCopy(contextMenu.targetIds)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-white/80 hover:bg-[#37373d] hover:text-white"
              >
                <Copy className="h-3.5 w-3.5" />
                复制
              </button>
              <div className="my-0.5 border-t border-white/10" />
              <button
                onClick={() => {
                  const id = contextMenu.targetIds[0];
                  const file = files.find((f) => f.path === id);
                  if (file) setRenameState({ id: file.path, name: file.name });
                  setContextMenu(null);
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-white/80 hover:bg-[#37373d] hover:text-white"
              >
                <Edit3 className="h-3.5 w-3.5" />
                重命名
              </button>
              <button
                onClick={() => handleDelete(contextMenu.targetIds)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-white/80 hover:bg-[#37373d] hover:text-white"
              >
                <Trash2 className="h-3.5 w-3.5" />
                删除
              </button>
              <div className="my-0.5 border-t border-white/10" />
              <button
                onClick={() => {
                  const id = contextMenu.targetIds[0];
                  const file = files.find((f) => f.path === id);
                  if (file) setArchiveState({ files: [file.path], name: file.name.replace(/\.[^/.]+$/, "") });
                  setContextMenu(null);
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-white/80 hover:bg-[#37373d] hover:text-white"
              >
                <Archive className="h-3.5 w-3.5" />
                创建压缩
              </button>
            </>
          ) : contextMenu.targetIds.length > 1 ? (
            <>
              <button
                onClick={() => handleCopy(contextMenu.targetIds)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-white/80 hover:bg-[#37373d] hover:text-white"
              >
                <Copy className="h-3.5 w-3.5" />
                复制
              </button>
              <button
                onClick={() => handleCut(contextMenu.targetIds)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-white/80 hover:bg-[#37373d] hover:text-white"
              >
                <Scissors className="h-3.5 w-3.5" />
                剪切
              </button>
              <button
                onClick={() => handleDelete(contextMenu.targetIds)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-white/80 hover:bg-[#37373d] hover:text-white"
              >
                <Trash2 className="h-3.5 w-3.5" />
                删除
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => { handlePaste(); setContextMenu(null); }}
                disabled={!clipboard || clipboard.files.length === 0}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-white/80 hover:bg-[#37373d] hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                <ClipboardPaste className="h-3.5 w-3.5" />
                粘贴
              </button>
              <div className="my-0.5 border-t border-white/10" />
              <button
                onClick={() => { loadDirectory(currentPath); setContextMenu(null); }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-white/80 hover:bg-[#37373d] hover:text-white"
              >
                <RotateCw className="h-3.5 w-3.5" />
                刷新
              </button>
            </>
          )}
        </div>
      )}

      {newState && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50" onClick={() => setNewState(null)}>
          <div className="w-80 rounded-lg border border-white/10 bg-[#252526] p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-4 text-sm font-medium text-white">
              {newState.type === "folder" ? "新建文件夹" : "新建文件"}
            </h3>
            <input
              type="text"
              value={newState.name}
              onChange={(e) => setNewState({ ...newState, name: e.target.value })}
              className="mb-4 w-full rounded border border-white/10 bg-black/20 px-3 py-2 text-sm text-white focus:border-blue-500 focus:outline-none"
              autoFocus
              onKeyDown={(e) => e.key === "Enter" && (newState.type === "folder" ? handleNewFolder() : handleNewFile())}
            />
            <div className="flex justify-end gap-2">
              <button onClick={() => setNewState(null)} className="rounded px-3 py-1.5 text-sm text-white/80 hover:bg-white/10">
                取消
              </button>
              <button onClick={newState.type === "folder" ? handleNewFolder : handleNewFile} className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-500">
                确定
              </button>
            </div>
          </div>
        </div>
      )}

      {renameState && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50" onClick={() => setRenameState(null)}>
          <div className="w-80 rounded-lg border border-white/10 bg-[#252526] p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-4 text-sm font-medium text-white">重命名</h3>
            <input
              type="text"
              value={renameState.name}
              onChange={(e) => setRenameState({ ...renameState, name: e.target.value })}
              className="mb-4 w-full rounded border border-white/10 bg-black/20 px-3 py-2 text-sm text-white focus:border-blue-500 focus:outline-none"
              autoFocus
              onKeyDown={(e) => e.key === "Enter" && handleRename()}
            />
            <div className="flex justify-end gap-2">
              <button onClick={() => setRenameState(null)} className="rounded px-3 py-1.5 text-sm text-white/80 hover:bg-white/10">
                取消
              </button>
              <button onClick={handleRename} className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-500">
                确定
              </button>
            </div>
          </div>
        </div>
      )}

      {archiveState && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50" onClick={() => setArchiveState(null)}>
          <div className="w-80 rounded-lg border border-white/10 bg-[#252526] p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-4 text-sm font-medium text-white">创建压缩包</h3>
            <div className="mb-4 flex items-center gap-2">
              <input
                type="text"
                value={archiveState.name}
                onChange={(e) => setArchiveState({ ...archiveState, name: e.target.value })}
                className="flex-1 rounded border border-white/10 bg-black/20 px-3 py-2 text-sm text-white focus:border-blue-500 focus:outline-none"
                autoFocus
                onKeyDown={(e) => e.key === "Enter" && handleArchive()}
              />
              <span className="text-sm text-white/60">.tar.gz</span>
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setArchiveState(null)} className="rounded px-3 py-1.5 text-sm text-white/80 hover:bg-white/10">
                取消
              </button>
              <button onClick={handleArchive} className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-500">
                确定
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
