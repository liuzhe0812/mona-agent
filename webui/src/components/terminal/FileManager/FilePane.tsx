import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FolderPlus,
  RefreshCw,
  ArrowUp,
  Home,
  Upload,
  Trash2,
  Pencil,
  Download,
  Eye,
  EyeOff,
  Search,
  Copy,
  Scissors,
  ClipboardPaste,
  FilePlus,
  Info,
  FolderOpen,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FileSystemIcon } from "@/components/ui/file-system-icon";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

export interface UnifiedFileItem {
  name: string;
  path: string;
  isDir: boolean;
  size: number | null;
  modified: string | null;
  permissions: string | null;
  _rawFile?: File;
}

async function readDirEntries(
  entry: FileSystemDirectoryEntry,
  prefix: string,
): Promise<{ file: File; relativePath: string }[]> {
  return new Promise((resolve, reject) => {
    const reader = entry.createReader();
    const allEntries: FileSystemEntry[] = [];
    const readBatch = () => {
      reader.readEntries(async (batch) => {
        if (batch.length === 0) {
          const results: { file: File; relativePath: string }[] = [];
          for (const e of allEntries) {
            if (e.isFile) {
              const fileEntry = e as FileSystemFileEntry;
              const file = await new Promise<File>((res, rej) =>
                fileEntry.file(res, rej),
              );
              results.push({ file, relativePath: `${prefix}${e.name}` });
            } else if (e.isDirectory) {
              const sub = await readDirEntries(
                e as FileSystemDirectoryEntry,
                `${prefix}${e.name}/`,
              );
              results.push(...sub);
            }
          }
          resolve(results);
        } else {
          allEntries.push(...batch);
          readBatch();
        }
      }, reject);
    };
    readBatch();
  });
}

interface Props {
  label: string;
  currentPath: string;
  files: UnifiedFileItem[];
  loading: boolean;
  error?: string | null;
  onNavigate: (path: string) => void;
  onOpen: (file: UnifiedFileItem) => void;
  onDelete: (file: UnifiedFileItem) => void;
  onRename: (file: UnifiedFileItem) => void;
  onCreateFolder: () => void;
  onCreateFile?: () => void;
  onRefresh: () => void;
  onUploadByPicker: (() => void) | undefined;
  onDownload?: (file: UnifiedFileItem) => void;
  onCopy?: (files: UnifiedFileItem[]) => void;
  onCut?: (files: UnifiedFileItem[]) => void;
  onPaste?: () => void;
  onProperties?: (file: UnifiedFileItem) => void;
  showHiddenFiles: boolean;
  onToggleHiddenFiles: () => void;
  clipboardHasItems: boolean;
  side: "local" | "remote";
  onSelectionChange?: (paths: Set<string>) => void;
  onFocus?: () => void;
  onDropFiles?: (files: UnifiedFileItem[], fromSide: "local" | "remote" | "system") => void;
  isTransferring?: boolean;
}

function formatSize(size: number | null): string {
  if (size === null) return "-";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024)
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function FilePane({
  label,
  currentPath,
  files,
  loading,
  error,
  onNavigate,
  onOpen,
  onDelete,
  onRename,
  onCreateFolder,
  onCreateFile,
  onRefresh,
  onUploadByPicker,
  onDownload,
  onCopy,
  onCut,
  onPaste,
  onProperties,
  showHiddenFiles,
  onToggleHiddenFiles,
  clipboardHasItems,
  side,
  onSelectionChange,
  onFocus,
  onDropFiles,
  isTransferring,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [editPath, setEditPath] = useState(currentPath);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const lastSelectedIndexRef = useRef(-1);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounterRef = useRef(0);

  const defaultColWidths: Record<string, number> = side === "remote"
    ? { icon: 28, name: 200, size: 80, permissions: 96, modified: 140 }
    : { icon: 28, name: 200, size: 80, modified: 140 };
  const [colWidths, setColWidths] = useState<Record<string, number>>(defaultColWidths);
  const resizeRef = useRef<{ key: string; startX: number; startWidth: number } | null>(null);

  const displayFiles = useMemo(() => {
    let result = files;
    if (!showHiddenFiles) {
      result = result.filter((f) => !f.name.startsWith("."));
    }
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      result = result.filter((f) => f.name.toLowerCase().includes(q));
    }
    return result;
  }, [files, showHiddenFiles, searchQuery]);

  useEffect(() => {
    onSelectionChange?.(selectedPaths);
  }, [selectedPaths, onSelectionChange]);

  const handleSelect = useCallback(
    (file: UnifiedFileItem, index: number, e: React.MouseEvent) => {
      const next = new Set(selectedPaths);
      if (e.shiftKey && lastSelectedIndexRef.current >= 0) {
        const start = Math.min(lastSelectedIndexRef.current, index);
        const end = Math.max(lastSelectedIndexRef.current, index);
        for (let i = start; i <= end; i++) {
          if (displayFiles[i]) next.add(displayFiles[i].path);
        }
      } else if (e.ctrlKey || e.metaKey) {
        if (next.has(file.path)) {
          next.delete(file.path);
        } else {
          next.add(file.path);
        }
      } else {
        next.clear();
        next.add(file.path);
      }
      setSelectedPaths(next);
      lastSelectedIndexRef.current = index;
    },
    [selectedPaths, displayFiles],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, textarea, [contenteditable=true]")) return;
      if ((e.ctrlKey || e.metaKey) && e.key === "a") {
        e.preventDefault();
        const all = new Set(displayFiles.map((f) => f.path));
        setSelectedPaths(all);
      }
    },
    [displayFiles],
  );

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current++;
    if (dragCounterRef.current === 1) {
      setIsDragOver(true);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, []);

  const handleDragLeave = useCallback(() => {
    dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
    if (dragCounterRef.current === 0) {
      setIsDragOver(false);
    }
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      dragCounterRef.current = 0;
      setIsDragOver(false);
      if (!onDropFiles) return;
      const sftpData = e.dataTransfer.getData("application/x-sftp-files");
      if (sftpData) {
        try {
          const parsed = JSON.parse(sftpData);
          onDropFiles(parsed.files, parsed.side);
        } catch (err) {
          console.error("[FilePane] failed to parse drag data:", err);
        }
        return;
      }
      const items = e.dataTransfer.items;
      const files: UnifiedFileItem[] = [];
      const pendingDirs: {
        entry: FileSystemDirectoryEntry;
        name: string;
      }[] = [];

      if (items && items.length > 0) {
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          let isDir = false;
          let dirEntry: FileSystemDirectoryEntry | null = null;

          try {
            const entry = item.webkitGetAsEntry?.();
            if (entry?.isDirectory) {
              isDir = true;
              dirEntry = entry as FileSystemDirectoryEntry;
            }
          } catch {}

          const f = item.getAsFile();
          const filePath = f
            ? (f as File & { path?: string }).path
            : undefined;
          const hasValidPath = !!(filePath && filePath.includes(":"));

          if (isDir && dirEntry && !hasValidPath) {
            pendingDirs.push({
              entry: dirEntry,
              name: f?.name ?? dirEntry.name,
            });
          } else if (f) {
            files.push({
              name: f.name,
              path: hasValidPath ? filePath! : f.name,
              isDir,
              size: f.size,
              modified: null,
              permissions: null,
              _rawFile: hasValidPath ? undefined : f,
            });
          }
        }

        for (const { entry, name } of pendingDirs) {
          try {
            const subFiles = await readDirEntries(entry, "");
            for (const { file, relativePath } of subFiles) {
              files.push({
                name: `${name}/${relativePath}`,
                path: "",
                isDir: false,
                size: file.size,
                modified: null,
                permissions: null,
                _rawFile: file,
              });
            }
          } catch (err) {
            console.error("[FilePane] failed to read directory:", err);
          }
        }
      } else if (e.dataTransfer.files.length > 0) {
        for (let i = 0; i < e.dataTransfer.files.length; i++) {
          const f = e.dataTransfer.files[i];
          const filePath = (f as File & { path?: string }).path;
          files.push({
            name: f.name,
            path: filePath && filePath.includes(":") ? filePath : f.name,
            isDir: false,
            size: f.size,
            modified: null,
            permissions: null,
            _rawFile: filePath ? undefined : f,
          });
        }
      }

      if (files.length > 0) {
        onDropFiles(files, "system");
      }
    },
    [onDropFiles],
  );

  const getSelectedFilesForContextMenu = useCallback(
    (clickedFile: UnifiedFileItem): UnifiedFileItem[] => {
      if (selectedPaths.has(clickedFile.path)) {
        return displayFiles.filter((f) => selectedPaths.has(f.path));
      }
      return [clickedFile];
    },
    [selectedPaths, displayFiles],
  );

  const segments = useMemo(() => {
    if (side === "local") {
      const normalized = currentPath.replace(/\\/g, "/");
      return normalized.split("/").filter(Boolean);
    }
    return currentPath.split("/").filter(Boolean);
  }, [currentPath, side]);

  const handlePathSubmit = () => {
    if (editPath.trim()) {
      onNavigate(editPath.trim());
    }
    setEditing(false);
  };

  const handleStartEdit = useCallback(() => {
    setEditPath(currentPath);
    setEditing(true);
  }, [currentPath]);

  const handleParentDir = () => {
    if (side === "local") {
      const sep = currentPath.includes("\\") ? "\\" : "/";
      const parts = currentPath.split(sep).filter(Boolean);
      if (parts.length <= 1) return;
      const parent = parts.slice(0, -1).join(sep);
      onNavigate(/^[A-Za-z]:$/.test(parent) ? parent + sep : currentPath.startsWith("/") ? "/" + parent : parent || "/");
    } else {
      const parent = segments.slice(0, -1).join("/");
      onNavigate(parent ? "/" + parent : "/");
    }
  };

  const isRoot =
    side === "local"
      ? currentPath.replace(/\\/g, "/").split("/").filter(Boolean).length <= 1
      : currentPath === "/";

  return (
    <div
      className="flex h-full flex-col outline-none relative"
      tabIndex={0}
      role="region"
      aria-label={`${label}文件`}
      onMouseDown={(event) => {
        if (!(event.target as HTMLElement).closest("button, input, textarea, [contenteditable=true]")) {
          event.currentTarget.focus({ preventScroll: true });
        }
      }}
      onKeyDown={handleKeyDown}
      onFocus={onFocus}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div role="toolbar" aria-label={label + "文件工具栏"}
        className="flex h-8 min-w-0 shrink-0 flex-nowrap items-center gap-1 border-b border-border bg-muted/20 px-2">
        <span className="shrink-0 text-caption font-medium text-muted-foreground">{label}</span>
        <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" title="根目录" aria-label={label + "根目录"}
          onClick={() => onNavigate(side === "local" && /^[A-Za-z]:/.test(currentPath) ? currentPath.slice(0, 2) + "\\" : "/")}>
          <Home className="h-3 w-3" />
        </Button>
        <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" title="上级目录" aria-label={label + "上级目录"}
          disabled={isRoot} onClick={handleParentDir}><ArrowUp className="h-3 w-3" /></Button>
        <div className="min-w-0 flex-1">
          {editing ? (
            <form onSubmit={(event) => { event.preventDefault(); handlePathSubmit(); }}>
              <Input value={editPath} aria-label={label + "路径"} autoFocus
                onChange={(event) => setEditPath(event.target.value)} onBlur={() => setEditing(false)}
                onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); setEditing(false); } }}
                className="h-6 min-w-0 px-1.5 py-0 text-caption" />
            </form>
          ) : (
            <button type="button" aria-label={label + "路径"} title={currentPath} onClick={handleStartEdit}
              className="h-6 w-full min-w-0 truncate rounded px-1.5 text-left text-caption text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
              {currentPath || "/"}
            </button>
          )}
        </div>
        {searchOpen && <Input value={searchQuery} autoFocus aria-label={"搜索" + label + "文件"} placeholder="搜索…"
          onChange={(event) => setSearchQuery(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Escape") { setSearchOpen(false); setSearchQuery(""); } }}
          className="h-6 w-24 shrink-0 px-1.5 py-0 text-caption" />}
        <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" aria-label={"搜索" + label + "文件"}
          title="搜索文件" aria-pressed={searchOpen} onClick={() => { setSearchOpen(!searchOpen); if (searchOpen) setSearchQuery(""); }}>
          <Search className="h-3 w-3" />
        </Button>
        <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" onClick={onToggleHiddenFiles}
          aria-label={label + (showHiddenFiles ? "隐藏隐藏文件" : "显示隐藏文件")} title={showHiddenFiles ? "隐藏隐藏文件" : "显示隐藏文件"}>
          {showHiddenFiles ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
        </Button>
        {onUploadByPicker && <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" onClick={onUploadByPicker}
          aria-label="上传文件" title="上传文件"><Upload className="h-3 w-3" /></Button>}
        <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" onClick={onCreateFolder}
          aria-label={label + "新建文件夹"} title="新建文件夹"><FolderPlus className="h-3 w-3" /></Button>
        <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" onClick={onRefresh}
          aria-label={"刷新" + label + "目录"} title="刷新"><RefreshCw className="h-3 w-3" /></Button>
      </div>
      {error && <div role="alert" className="shrink-0 break-words border-b border-border px-2 py-1 text-caption text-destructive">{error}</div>}

      <div className="flex-1 min-h-0 overflow-auto">
        {loading ? (
          <div className="flex h-full items-center justify-center text-body text-muted-foreground">
            加载中…
          </div>
        ) : displayFiles.length === 0 ? (
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <div className="flex h-full items-center justify-center text-body text-muted-foreground">
                空目录
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent className="w-48">
              {onCreateFolder && (
                <ContextMenuItem onClick={onCreateFolder}>
                  <FolderPlus className="mr-2 h-3.5 w-3.5" /> 新建文件夹
                </ContextMenuItem>
              )}
              {onCreateFile && (
                <ContextMenuItem onClick={onCreateFile}>
                  <FilePlus className="mr-2 h-3.5 w-3.5" /> 新建文件
                </ContextMenuItem>
              )}
              {clipboardHasItems && onPaste && (
                <ContextMenuItem onClick={onPaste}>
                  <ClipboardPaste className="mr-2 h-3.5 w-3.5" /> 粘贴
                </ContextMenuItem>
              )}
              <ContextMenuSeparator />
              <ContextMenuItem onClick={onToggleHiddenFiles}>
                {showHiddenFiles ? (
                  <Eye className="mr-2 h-3.5 w-3.5" />
                ) : (
                  <EyeOff className="mr-2 h-3.5 w-3.5" />
                )}
                {showHiddenFiles ? "隐藏隐藏文件" : "显示隐藏文件"}
              </ContextMenuItem>
              <ContextMenuItem onClick={onRefresh}>
                <RefreshCw className="mr-2 h-3.5 w-3.5" /> 刷新
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        ) : (
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <div
                className="h-full"
                onClick={(e) => {
                  if (e.target === e.currentTarget) {
                    setSelectedPaths(new Set());
                    lastSelectedIndexRef.current = -1;
                  }
                }}
                onContextMenu={() => {
                  setSelectedPaths(new Set());
                  lastSelectedIndexRef.current = -1;
                }}
              >
              <table
                className="w-full text-caption"
                style={{ tableLayout: "fixed", minWidth: side === "remote" ? 544 : 448 }}
                onClick={(e) => {
                  if (
                    e.target === e.currentTarget ||
                    (e.target as HTMLElement).tagName === "TH"
                  ) {
                    setSelectedPaths(new Set());
                    lastSelectedIndexRef.current = -1;
                  }
                }}
              >
                <colgroup>
                  <col style={{ width: colWidths.icon }} />
                  <col style={{ width: colWidths.name }} />
                  <col style={{ width: colWidths.size }} />
                  {side === "remote" && (
                    <col style={{ width: colWidths.permissions }} />
                  )}
                  <col style={{ width: colWidths.modified }} />
                </colgroup>
                <thead className="sticky top-0 bg-background z-10">
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="px-1.5 py-1" />
                    <th className="px-1.5 py-1 font-medium relative group/name">
                      名称
                      <span
                        className="mona-resize-handle absolute right-0 top-0 bottom-0 w-1 cursor-col-resize"
                        onMouseDown={(e) => {
                          e.preventDefault();
                          resizeRef.current = { key: "name", startX: e.clientX, startWidth: colWidths.name };
                          const onMove = (ev: MouseEvent) => {
                            if (!resizeRef.current) return;
                            const delta = ev.clientX - resizeRef.current.startX;
                            setColWidths((w) => ({ ...w, name: Math.max(60, resizeRef.current!.startWidth + delta) }));
                          };
                          const onUp = () => {
                            resizeRef.current = null;
                            document.removeEventListener("mousemove", onMove);
                            document.removeEventListener("mouseup", onUp);
                          };
                          document.addEventListener("mousemove", onMove);
                          document.addEventListener("mouseup", onUp);
                        }}
                      />
                    </th>
                    <th className="px-1.5 py-1 font-medium relative">
                      大小
                      <span
                        className="mona-resize-handle absolute right-0 top-0 bottom-0 w-1 cursor-col-resize"
                        onMouseDown={(e) => {
                          e.preventDefault();
                          resizeRef.current = { key: "size", startX: e.clientX, startWidth: colWidths.size };
                          const onMove = (ev: MouseEvent) => {
                            if (!resizeRef.current) return;
                            const delta = ev.clientX - resizeRef.current.startX;
                            setColWidths((w) => ({ ...w, size: Math.max(40, resizeRef.current!.startWidth + delta) }));
                          };
                          const onUp = () => {
                            resizeRef.current = null;
                            document.removeEventListener("mousemove", onMove);
                            document.removeEventListener("mouseup", onUp);
                          };
                          document.addEventListener("mousemove", onMove);
                          document.addEventListener("mouseup", onUp);
                        }}
                      />
                    </th>
                    {side === "remote" && (
                      <th className="px-1.5 py-1 font-medium relative">
                        权限
                        <span
                          className="mona-resize-handle absolute right-0 top-0 bottom-0 w-1 cursor-col-resize"
                          onMouseDown={(e) => {
                            e.preventDefault();
                            resizeRef.current = { key: "permissions", startX: e.clientX, startWidth: colWidths.permissions };
                            const onMove = (ev: MouseEvent) => {
                              if (!resizeRef.current) return;
                              const delta = ev.clientX - resizeRef.current.startX;
                              setColWidths((w) => ({ ...w, permissions: Math.max(40, resizeRef.current!.startWidth + delta) }));
                            };
                            const onUp = () => {
                              resizeRef.current = null;
                              document.removeEventListener("mousemove", onMove);
                              document.removeEventListener("mouseup", onUp);
                            };
                            document.addEventListener("mousemove", onMove);
                            document.addEventListener("mouseup", onUp);
                          }}
                        />
                      </th>
                    )}
                    <th className="px-1.5 py-1 font-medium">
                      修改时间
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {displayFiles.map((file, index) => (
                    <FileRow
                      key={file.path}
                      file={file}
                      side={side}
                      selected={selectedPaths.has(file.path)}
                      onSelect={(e) => handleSelect(file, index, e)}
                      onOpen={onOpen}
                      onDelete={onDelete}
                      onRename={onRename}
                      onDownload={onDownload}
                      onCopy={onCopy}
                      onCut={onCut}
                      onPaste={onPaste}
                      onProperties={onProperties}
                      clipboardHasItems={clipboardHasItems}
                      getSelectedFiles={() =>
                        getSelectedFilesForContextMenu(file)
                      }
                      onCreateFolder={onCreateFolder}
                      onCreateFile={onCreateFile}
                      onUploadByPicker={onUploadByPicker}
                      draggable={!isTransferring}
                      onDragStart={(e) => {
                        const filesToDrag = selectedPaths.has(file.path)
                          ? displayFiles.filter((f) => selectedPaths.has(f.path))
                          : [file];
                        e.dataTransfer.setData(
                          "application/x-sftp-files",
                          JSON.stringify({ side, files: filesToDrag }),
                        );
                        e.dataTransfer.effectAllowed = "copy";
                      }}
                    />
                  ))}
                </tbody>
              </table>
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent className="w-48">
              {onCreateFolder && (
                <ContextMenuItem onClick={onCreateFolder}>
                  <FolderPlus className="mr-2 h-3.5 w-3.5" /> 新建文件夹
                </ContextMenuItem>
              )}
              {onCreateFile && (
                <ContextMenuItem onClick={onCreateFile}>
                  <FilePlus className="mr-2 h-3.5 w-3.5" /> 新建文件
                </ContextMenuItem>
              )}
              {clipboardHasItems && onPaste && (
                <ContextMenuItem onClick={onPaste}>
                  <ClipboardPaste className="mr-2 h-3.5 w-3.5" /> 粘贴
                </ContextMenuItem>
              )}
              <ContextMenuSeparator />
              <ContextMenuItem onClick={onToggleHiddenFiles}>
                {showHiddenFiles ? (
                  <Eye className="mr-2 h-3.5 w-3.5" />
                ) : (
                  <EyeOff className="mr-2 h-3.5 w-3.5" />
                )}
                {showHiddenFiles ? "隐藏隐藏文件" : "显示隐藏文件"}
              </ContextMenuItem>
              <ContextMenuItem onClick={onRefresh}>
                <RefreshCw className="mr-2 h-3.5 w-3.5" /> 刷新
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        )}
      </div>

      <div className="h-6 shrink-0 border-t px-2 flex items-center text-micro text-muted-foreground bg-muted/10">
        <span>{displayFiles.length} 项</span>
        {selectedPaths.size > 0 && (
          <>
            <span className="mx-1">·</span>
            <span>已选 {selectedPaths.size} 项</span>
          </>
        )}
      </div>
      {isDragOver && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-primary/10 border-2 border-dashed border-primary/40 rounded-sm pointer-events-none">
          <span className="text-body font-medium text-primary">
            {side === "remote" ? "拖放以上传" : "拖放以下载"}
          </span>
        </div>
      )}
    </div>
  );
}

function FileRow({
  file,
  side,
  selected,
  onSelect,
  onOpen,
  onDelete,
  onRename,
  onDownload,
  onCopy,
  onCut,
  onPaste,
  onProperties,
  clipboardHasItems,
  getSelectedFiles,
  onCreateFolder,
  onCreateFile,
  onUploadByPicker,
  draggable,
  onDragStart,
}: {
  file: UnifiedFileItem;
  side: "local" | "remote";
  selected: boolean;
  onSelect: (e: React.MouseEvent) => void;
  onOpen: (file: UnifiedFileItem) => void;
  onDelete: (file: UnifiedFileItem) => void;
  onRename: (file: UnifiedFileItem) => void;
  onDownload?: (file: UnifiedFileItem) => void;
  onCopy?: (files: UnifiedFileItem[]) => void;
  onCut?: (files: UnifiedFileItem[]) => void;
  onPaste?: () => void;
  onProperties?: (file: UnifiedFileItem) => void;
  clipboardHasItems: boolean;
  getSelectedFiles: () => UnifiedFileItem[];
  onCreateFolder?: () => void;
  onCreateFile?: () => void;
  onUploadByPicker?: (() => void) | undefined;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent<HTMLTableRowElement>) => void;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <tr
          draggable={draggable}
          onDragStart={onDragStart}
          className={`group cursor-pointer border-b border-transparent transition-colors ${
            selected ? "bg-accent" : "hover:bg-accent"
          }`}
          onClick={onSelect}
          onDoubleClick={() => onOpen(file)}
        >
          <td className="px-1.5 py-1">
            <FileSystemIcon name={file.name} isDirectory={file.isDir} />
          </td>
          <td className="truncate px-1.5 py-1 font-medium" title={file.name}>
            {file.name}
          </td>
          <td className="truncate px-1.5 py-1 text-muted-foreground">
            {file.isDir ? "-" : formatSize(file.size)}
          </td>
          {side === "remote" && (
            <td className="truncate px-1.5 py-1 font-mono text-muted-foreground">
              {file.permissions ?? "-"}
            </td>
          )}
          <td className="truncate px-1.5 py-1 text-muted-foreground">
            {file.modified ?? "-"}
          </td>
        </tr>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        {file.isDir && (
          <ContextMenuItem onClick={() => onOpen(file)}>
            <FolderOpen className="mr-2 h-3.5 w-3.5" /> 打开
          </ContextMenuItem>
        )}
        {side === "remote" && !file.isDir && onDownload && (
          <ContextMenuItem onClick={() => onDownload(file)}>
            <Download className="mr-2 h-3.5 w-3.5" /> 下载
          </ContextMenuItem>
        )}
        {side === "local" && onUploadByPicker && (
          <ContextMenuItem onClick={onUploadByPicker}>
            <Upload className="mr-2 h-3.5 w-3.5" /> 上传
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        {onCopy && (
          <ContextMenuItem onClick={() => onCopy(getSelectedFiles())}>
            <Copy className="mr-2 h-3.5 w-3.5" /> 复制
          </ContextMenuItem>
        )}
        {onCut && (
          <ContextMenuItem onClick={() => onCut(getSelectedFiles())}>
            <Scissors className="mr-2 h-3.5 w-3.5" /> 剪切
          </ContextMenuItem>
        )}
        {clipboardHasItems && onPaste && (
          <ContextMenuItem onClick={onPaste}>
            <ClipboardPaste className="mr-2 h-3.5 w-3.5" /> 粘贴
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => onRename(file)}>
          <Pencil className="mr-2 h-3.5 w-3.5" /> 重命名
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onDelete(file)}>
          <Trash2 className="mr-2 h-3.5 w-3.5" /> 删除
        </ContextMenuItem>
        <ContextMenuSeparator />
        {onCreateFile && (
          <ContextMenuItem onClick={onCreateFile}>
            <FilePlus className="mr-2 h-3.5 w-3.5" /> 新建文件
          </ContextMenuItem>
        )}
        {onCreateFolder && (
          <ContextMenuItem onClick={onCreateFolder}>
            <FolderPlus className="mr-2 h-3.5 w-3.5" /> 新建文件夹
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        {onProperties && (
          <ContextMenuItem onClick={() => onProperties(file)}>
            <Info className="mr-2 h-3.5 w-3.5" /> 属性
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
