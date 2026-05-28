import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronRight,
  FolderPlus,
  RefreshCw,
  ArrowUp,
  Home,
  Upload,
  Trash2,
  Pencil,
  Download,
  Folder,
  File,
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
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { getCachedIcon, getIcon, extractExtension } from "./iconCache";

export interface UnifiedFileItem {
  name: string;
  path: string;
  isDir: boolean;
  size: number | null;
  modified: string | null;
  permissions: string | null;
}

interface Props {
  label: string;
  currentPath: string;
  files: UnifiedFileItem[];
  loading: boolean;
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
}

function formatSize(size: number | null): string {
  if (size === null) return "-";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024)
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function useFileIcons(files: UnifiedFileItem[]) {
  const [resolved, setResolved] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    const toLoad: UnifiedFileItem[] = [];

    for (const f of files) {
      const ext = extractExtension(f.name);
      const cached = getCachedIcon(ext, f.isDir);
      if (cached) {
        if (!resolved[f.path] || resolved[f.path] !== cached) {
          setResolved((prev) => ({ ...prev, [f.path]: cached }));
        }
      } else {
        toLoad.push(f);
      }
    }

    if (toLoad.length === 0) return;

    let idx = 0;
    const batchSize = 6;

    async function loadBatch() {
      if (cancelled) return;
      const batch = toLoad.slice(idx, idx + batchSize);
      idx += batchSize;
      if (batch.length === 0) return;

      const entries: Record<string, string> = {};
      const results = await Promise.allSettled(
        batch.map(async (f) => {
          const ext = extractExtension(f.name);
          const dataUrl = await getIcon(ext, f.isDir);
          return { path: f.path, dataUrl };
        }),
      );

      if (cancelled) return;

      for (const r of results) {
        if (r.status === "fulfilled" && r.value.dataUrl) {
          entries[r.value.path] = r.value.dataUrl;
        }
      }

      if (Object.keys(entries).length > 0) {
        setResolved((prev) => ({ ...prev, ...entries }));
      }

      if (idx < toLoad.length) {
        requestAnimationFrame(loadBatch);
      }
    }

    loadBatch();
    return () => {
      cancelled = true;
    };
  }, [files]);

  return resolved;
}

export function FilePane({
  label,
  currentPath,
  files,
  loading,
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
}: Props) {
  const [editing, setEditing] = useState(false);
  const [editPath, setEditPath] = useState(currentPath);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const lastSelectedIndexRef = useRef(-1);
  const [searchQuery, setSearchQuery] = useState("");

  const iconMap = useFileIcons(files);

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
      if ((e.ctrlKey || e.metaKey) && e.key === "a") {
        e.preventDefault();
        const all = new Set(displayFiles.map((f) => f.path));
        setSelectedPaths(all);
      }
    },
    [displayFiles],
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

  const handleBreadcrumbClick = (index: number) => {
    if (side === "local") {
      const normalized = currentPath.replace(/\\/g, "/");
      const parts = normalized.split("/").filter(Boolean);
      const path = parts.slice(0, index + 1).join("/");
      onNavigate(
        path.length >= 2 && path[1] === ":" ? path.replace(/\//g, "\\") : path,
      );
    } else {
      const path = "/" + segments.slice(0, index + 1).join("/");
      onNavigate(path);
    }
  };

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
      onNavigate(parent || (currentPath.includes("\\") ? "C:\\" : "/"));
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
      className="flex h-full flex-col outline-none"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onFocus={onFocus}
    >
      <div className="flex h-8 shrink-0 items-center gap-1 border-b px-2 bg-muted/20">
        <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider shrink-0">
          {label}
        </span>
        <div className="flex-1" />
        <div className="relative">
          <Search className="absolute left-1.5 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索..."
            className="h-6 w-20 pl-6 pr-1.5 py-0 text-xs"
          />
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0"
          onClick={onToggleHiddenFiles}
          title={showHiddenFiles ? "隐藏隐藏文件" : "显示隐藏文件"}
        >
          {showHiddenFiles ? (
            <Eye className="h-3 w-3" />
          ) : (
            <EyeOff className="h-3 w-3" />
          )}
        </Button>
        {onUploadByPicker && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 gap-1 px-1.5 text-xs"
            onClick={onUploadByPicker}
            title="上传文件"
          >
            <Upload className="h-3 w-3" />
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-1.5 text-xs"
          onClick={onCreateFolder}
          title="新建文件夹"
        >
          <FolderPlus className="h-3 w-3" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0"
          onClick={onRefresh}
          title="刷新"
        >
          <RefreshCw className="h-3 w-3" />
        </Button>
      </div>

      <div className="flex h-8 shrink-0 items-center gap-1 border-b px-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0"
          onClick={() => {
            if (side === "local") {
              onNavigate(currentPath.includes("\\") ? "C:\\" : "/");
            } else {
              onNavigate("/");
            }
          }}
          title="根目录"
        >
          <Home className="h-3 w-3" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0"
          onClick={handleParentDir}
          disabled={isRoot}
          title="上级目录"
        >
          <ArrowUp className="h-3 w-3" />
        </Button>

        <div className="min-w-0 flex-1 overflow-hidden">
          {editing ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handlePathSubmit();
              }}
              className="flex items-center"
            >
              <Input
                value={editPath}
                onChange={(e) => setEditPath(e.target.value)}
                onBlur={handlePathSubmit}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setEditing(false);
                }}
                className="h-5 px-1.5 py-0 text-xs"
                autoFocus
              />
            </form>
          ) : (
            <div
              className="flex items-center gap-0.5 overflow-x-auto text-xs text-muted-foreground scrollbar-none"
              onDoubleClick={handleStartEdit}
            >
              {side === "local" ? (
                segments.map((seg, i) => (
                  <span key={i} className="flex items-center gap-0.5">
                    {i > 0 && (
                      <ChevronRight className="h-3 w-3 shrink-0 opacity-40" />
                    )}
                    <button
                      onClick={() => handleBreadcrumbClick(i)}
                      className="shrink-0 rounded px-1 hover:bg-accent hover:text-foreground"
                    >
                      {seg}
                    </button>
                  </span>
                ))
              ) : (
                <>
                  <button
                    onClick={() => onNavigate("/")}
                    className="shrink-0 rounded px-1 hover:bg-accent hover:text-foreground"
                  >
                    /
                  </button>
                  {segments.map((seg, i) => (
                    <span key={i} className="flex items-center gap-0.5">
                      <ChevronRight className="h-3 w-3 shrink-0 opacity-40" />
                      <button
                        onClick={() => handleBreadcrumbClick(i)}
                        className="shrink-0 rounded px-1 hover:bg-accent hover:text-foreground"
                      >
                        {seg}
                      </button>
                    </span>
                  ))}
                </>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        {loading ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            加载中…
          </div>
        ) : displayFiles.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            空目录
          </div>
        ) : (
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <table
                className="w-full text-xs"
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
                <thead className="sticky top-0 bg-background z-10">
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="w-7 px-1.5 py-1" />
                    <th className="px-1.5 py-1 font-medium">名称</th>
                    <th className="w-20 px-1.5 py-1 font-medium">大小</th>
                    {side === "remote" && (
                      <th className="w-24 px-1.5 py-1 font-medium">权限</th>
                    )}
                    <th className="w-32 px-1.5 py-1 font-medium">修改时间</th>
                  </tr>
                </thead>
                <tbody>
                  {displayFiles.map((file, index) => (
                    <FileRow
                      key={file.path}
                      file={file}
                      side={side}
                      selected={selectedPaths.has(file.path)}
                      iconSrc={iconMap[file.path]}
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
                    />
                  ))}
                </tbody>
              </table>
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

      <div className="h-6 shrink-0 border-t px-2 flex items-center text-[10px] text-muted-foreground bg-muted/10">
        <span>{displayFiles.length} 项</span>
        {selectedPaths.size > 0 && (
          <>
            <span className="mx-1">·</span>
            <span>已选 {selectedPaths.size} 项</span>
          </>
        )}
      </div>
    </div>
  );
}

function FileRow({
  file,
  side,
  selected,
  iconSrc,
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
}: {
  file: UnifiedFileItem;
  side: "local" | "remote";
  selected: boolean;
  iconSrc: string | undefined;
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
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <tr
          className={`group cursor-pointer border-b border-transparent transition-colors ${
            selected ? "bg-accent/70" : "hover:bg-accent/50"
          }`}
          onClick={onSelect}
          onDoubleClick={() => onOpen(file)}
        >
          <td className="px-1.5 py-1">
            {iconSrc ? (
              <img src={iconSrc} alt="" className="h-4 w-4" draggable={false} />
            ) : file.isDir ? (
              <Folder className="h-4 w-4 text-blue-400" />
            ) : (
              <File className="h-4 w-4 text-muted-foreground" />
            )}
          </td>
          <td className="max-w-[200px] truncate px-1.5 py-1 font-medium">
            {file.name}
          </td>
          <td className="px-1.5 py-1 text-muted-foreground">
            {file.isDir ? "-" : formatSize(file.size)}
          </td>
          {side === "remote" && (
            <td className="px-1.5 py-1 font-mono text-muted-foreground">
              {file.permissions ?? "-"}
            </td>
          )}
          <td className="px-1.5 py-1 text-muted-foreground">
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
