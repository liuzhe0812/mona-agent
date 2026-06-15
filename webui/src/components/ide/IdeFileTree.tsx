import { useState, useCallback, useEffect, useRef } from "react";
import {
  ChevronRight,
  ChevronDown,
  Folder,
  FolderOpen,
  File,
  Loader2,
  RefreshCw,
  FilePlus,
  FolderPlus,
  Trash2,
  Pencil,
  Eye,
  EyeOff,
  Download,
  ArrowRight,
  Upload,
  CheckCircle,
  XCircle,
  X,
} from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useIdeStore, type FileTreeNode } from "./useIdeStore";
import {
  getCachedIcon,
  getIcon,
  extractExtension,
} from "../terminal/FileManager/iconCache";

/* ------------------------------------------------------------------ */
/*  Inline rename / create input                                      */
/* ------------------------------------------------------------------ */

function InlineInput({
  defaultValue,
  onSubmit,
  onCancel,
}: {
  defaultValue: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(defaultValue);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && value.trim()) {
      onSubmit(value.trim());
    } else if (e.key === "Escape") {
      onCancel();
    }
  };

  return (
    <Input
      autoFocus
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={handleKeyDown}
      onBlur={() => {
        if (value.trim()) onSubmit(value.trim());
        else onCancel();
      }}
      className="h-6 rounded-sm px-1.5 py-0 text-[13px]"
    />
  );
}

/* ------------------------------------------------------------------ */
/*  File icon with system icon fallback                                */
/* ------------------------------------------------------------------ */

function FileIcon({ node, expanded }: { node: FileTreeNode; expanded: boolean }) {
  const [iconSrc, setIconSrc] = useState<string | null>(() => {
    if (node.isLoading || node.isDir) return null;
    const ext = extractExtension(node.name);
    return getCachedIcon(ext, false);
  });

  useEffect(() => {
    if (node.isLoading || node.isDir) return;
    const ext = extractExtension(node.name);
    let cancelled = false;
    getIcon(ext, false).then((url) => {
      if (!cancelled && url) setIconSrc(url);
    });
    return () => {
      cancelled = true;
    };
  }, [node.name, node.isDir, node.isLoading]);

  if (node.isLoading) {
    return <Loader2 className="mr-1.5 h-4 w-4 shrink-0 animate-spin text-muted-foreground" />;
  }

  if (node.isDir) {
    return expanded ? (
      <FolderOpen className="mr-1.5 h-4 w-4 shrink-0 text-yellow-500" />
    ) : (
      <Folder className="mr-1.5 h-4 w-4 shrink-0 text-yellow-500" />
    );
  }

  if (iconSrc) {
    return (
      <img
        src={iconSrc}
        alt=""
        className="mr-1.5 h-4 w-4 shrink-0"
        draggable={false}
      />
    );
  }

  return <File className="mr-1.5 h-4 w-4 shrink-0 text-muted-foreground" />;
}

/* ------------------------------------------------------------------ */
/*  Tree node                                                          */
/* ------------------------------------------------------------------ */

interface TreeNodeProps {
  node: FileTreeNode;
  depth: number;
}

function TreeNode({ node, depth }: TreeNodeProps) {
  const openFile = useIdeStore((s) => s.openFile);
  const togglePath = useIdeStore((s) => s.togglePath);
  const expandedPaths = useIdeStore((s) => s.expandedPaths);
  const selectedPaths = useIdeStore((s) => s.selectedPaths);
  const expanded = expandedPaths.has(node.path);
  const isSelected = selectedPaths.has(node.path);

  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(node.name);

  const handleToggle = (e: React.MouseEvent) => {
    // Handle selection on single click
    useIdeStore.getState().toggleSelectedPath(node.path, e.ctrlKey || e.metaKey);

    if (node.isDir) {
      togglePath(node.path);
    }
  };

  const handleDoubleClick = () => {
    if (node.isDir) {
      togglePath(node.path);
    } else {
      openFile(node.path).catch(console.error);
    }
  };

  const handleEdit = () => {
    if (!node.isDir) {
      openFile(node.path).catch(console.error);
    }
  };

  const handleRenameSubmit = useCallback(
    (newName: string) => {
      setRenaming(false);
      if (newName === node.name) return;
      const parentPath = node.path.substring(0, node.path.lastIndexOf("/"));
      const newPath = `${parentPath}/${newName}`;
      useIdeStore.getState().renameNode(node.path, newPath).catch(console.error);
    },
    [node.path, node.name],
  );

  const handleDelete = () => {
    if (node.isDir) {
      if (!confirm(`确认删除文件夹 "${node.name}" 及其所有内容？`)) return;
    } else {
      if (!confirm(`确认删除文件 "${node.name}"？`)) return;
    }
    useIdeStore.getState().deleteNode(node.path, node.isDir).catch(console.error);
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="treeitem"
          aria-expanded={node.isDir ? expanded : undefined}
          className={`flex cursor-pointer select-none items-center py-[3px] pr-2 text-[13px] ${
            isSelected
              ? "bg-primary/10 text-foreground"
              : "text-foreground hover:bg-accent"
          }`}
          style={{ paddingLeft: `${depth * 16 + 4}px` }}
          onClick={handleToggle}
          onDoubleClick={handleDoubleClick}
        >
          {/* expand chevron */}
          <span className="mr-0.5 flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground">
            {node.isDir ? (
              expanded ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )
            ) : null}
          </span>

          {/* icon */}
          <FileIcon node={node} expanded={expanded} />

          {/* name or rename input */}
          {renaming ? (
            <InlineInput
              defaultValue={renameValue}
              onSubmit={handleRenameSubmit}
              onCancel={() => setRenaming(false)}
            />
          ) : (
            <span className="truncate">{node.name}</span>
          )}
        </div>
      </ContextMenuTrigger>

      <ContextMenuContent>
        {!node.isDir && (
          <ContextMenuItem onClick={handleEdit}>
            <FilePlus className="mr-2 h-3.5 w-3.5" />
            编辑文档
          </ContextMenuItem>
        )}
        <ContextMenuItem
          onClick={async () => {
            const sftpSessionId = useIdeStore.getState().sftpSessionId;
            if (!sftpSessionId) return;
            try {
              if (node.isDir) {
                const { open } = await import("@tauri-apps/plugin-dialog");
                const dir = await open({ directory: true, title: "选择保存位置" });
                if (!dir) return;
                const localDir = typeof dir === "string" ? dir : (dir as string);
                const { sftpDownloadDir } = await import("../terminal/ipc");
                await sftpDownloadDir(sftpSessionId, node.path, `${localDir}/${node.name}`, `ide-ctx-dl-${Date.now()}`);
              } else {
                const { save } = await import("@tauri-apps/plugin-dialog");
                const savePath = await save({ defaultPath: node.name, title: "保存文件" });
                if (!savePath) return;
                const { sftpDownloadFile } = await import("../terminal/ipc");
                await sftpDownloadFile(sftpSessionId, node.path, savePath as string, `ide-ctx-dl-${Date.now()}`);
              }
            } catch {}
          }}
        >
          <Download className="mr-2 h-3.5 w-3.5" />
          下载
        </ContextMenuItem>
        {node.isDir && (
          <>
            <ContextMenuItem
              onClick={() => {
                const name = prompt("新文件名：");
                if (name) {
                  useIdeStore.getState().createFile(node.path, name).catch(console.error);
                }
              }}
            >
              <FilePlus className="mr-2 h-3.5 w-3.5" />
              新建文件
            </ContextMenuItem>
            <ContextMenuItem
              onClick={() => {
                const name = prompt("新文件夹名：");
                if (name) {
                  useIdeStore.getState().createFolder(node.path, name).catch(console.error);
                }
              }}
            >
              <FolderPlus className="mr-2 h-3.5 w-3.5" />
              新建文件夹
            </ContextMenuItem>
          </>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem
          onClick={() => {
            setRenameValue(node.name);
            setRenaming(true);
          }}
        >
          <Pencil className="mr-2 h-3.5 w-3.5" />
          重命名
        </ContextMenuItem>
        <ContextMenuItem onClick={handleDelete}>
          <Trash2 className="mr-2 h-3.5 w-3.5" />
          删除
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/* ------------------------------------------------------------------ */
/*  Recursive renderer                                                */
/* ------------------------------------------------------------------ */

function renderNode(node: FileTreeNode, depth: number) {
  return (
    <div key={node.path}>
      <TreeNode node={node} depth={depth} />
      {node.isDir && node.children?.map((child) => renderNode(child, depth + 1))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Toolbar icon button                                                */
/* ------------------------------------------------------------------ */

function IconBtn({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/*  Transfer progress panel                                            */
/* ------------------------------------------------------------------ */

function formatSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

function IdeTransferPanel() {
  const task = useIdeStore((s) => s.transferTask);
  const cancelTransfer = useIdeStore((s) => s.cancelTransfer);
  const clearTransfer = useIdeStore((s) => s.clearTransfer);

  if (!task) return null;

  const isActive = task.status === "transferring" || task.status === "waiting";
  const isCompleted = task.status === "completed";
  const isError = task.status === "error";
  const isCancelled = task.status === "cancelled";
  const completedFiles = task.files.filter((f) => f.status === "completed").length;
  const isDownload = task.type === "download";
  const TypeIcon = isDownload ? Download : Upload;
  const typeLabel = isDownload ? "下载" : "上传";

  return (
    <div className="shrink-0 border-t border-border bg-muted/30">
      {/* Header */}
      <div className="flex items-center justify-between px-2 py-1 border-b border-border">
        <div className="flex items-center gap-1.5 text-[11px]">
          <TypeIcon className="h-3 w-3 text-primary shrink-0" />
          <span className="font-medium">{typeLabel}</span>
          <span className="text-muted-foreground">
            ({completedFiles}/{task.totalFiles})
          </span>
        </div>
        <div className="flex items-center gap-0.5">
          {isActive && (
            <Button
              variant="ghost"
              size="sm"
              className="h-5 gap-1 px-1.5 text-[10px] text-destructive hover:text-destructive"
              onClick={cancelTransfer}
            >
              <X className="h-2.5 w-2.5" />
              取消
            </Button>
          )}
          {(isCompleted || isError || isCancelled) && (
            <Button
              variant="ghost"
              size="sm"
              className="h-5 gap-1 px-1.5 text-[10px]"
              onClick={clearTransfer}
            >
              清理
            </Button>
          )}
        </div>
      </div>

      {/* Progress */}
      <div className="px-2 py-1.5">
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-1.5 text-[11px] min-w-0">
            {isActive && <Loader2 className="h-3 w-3 text-primary animate-spin shrink-0" />}
            {isCompleted && <CheckCircle className="h-3 w-3 text-green-500 shrink-0" />}
            {isError && <XCircle className="h-3 w-3 text-destructive shrink-0" />}
            {isCancelled && <XCircle className="h-3 w-3 text-muted-foreground shrink-0" />}
            <span className="truncate">
              {isCompleted
                ? `${typeLabel}完成`
                : isError
                  ? `失败: ${task.error || "未知错误"}`
                  : isCancelled
                    ? "已取消"
                    : task.status === "waiting"
                      ? `等待中: ${task.totalFiles} 个文件`
                      : task.currentFile}
            </span>
          </div>
          <div className="text-[11px] text-muted-foreground shrink-0 ml-2">
            {isActive && task.status === "transferring" ? task.speed : ""}
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          {task.totalBytes > 0 ? (
            <Progress
              value={task.progress}
              className="flex-1 h-1"
            />
          ) : (
            <div className="flex-1 h-1 rounded-full bg-muted overflow-hidden">
              {isActive && (
                <div className="h-full bg-primary w-1/3 animate-[indeterminate_1.5s_infinite]" />
              )}
            </div>
          )}
          <span className="text-[10px] font-medium min-w-[2rem] text-right">
            {task.totalBytes > 0 ? `${task.progress}%` : ""}
          </span>
        </div>

        {task.totalBytes > 0 && isActive && (
          <div className="text-[10px] text-muted-foreground mt-0.5">
            {formatSize(task.bytesTransferred)} / {formatSize(task.totalBytes)}
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  IdeFileTree                                                        */
/* ------------------------------------------------------------------ */

export function IdeFileTree() {
  const tree = useIdeStore((s) => s.tree);
  const rootPath = useIdeStore((s) => s.rootPath);
  const expandedPaths = useIdeStore((s) => s.expandedPaths);
  const showHiddenFiles = useIdeStore((s) => s.showHiddenFiles);
  const setShowHiddenFiles = useIdeStore((s) => s.setShowHiddenFiles);
  const refreshDir = useIdeStore((s) => s.refreshDir);
  const createFile = useIdeStore((s) => s.createFile);
  const createFolder = useIdeStore((s) => s.createFolder);
  const navigateTo = useIdeStore((s) => s.navigateTo);
  const uploadFiles = useIdeStore((s) => s.uploadFiles);
  const downloadFiles = useIdeStore((s) => s.downloadFiles);
  const selectedPaths = useIdeStore((s) => s.selectedPaths);
  const clearSelection = useIdeStore((s) => s.clearSelection);

  // Address bar state
  const [addressValue, setAddressValue] = useState(rootPath || "");
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounterRef = useRef(0);

  // Sync address bar with rootPath
  useEffect(() => {
    if (rootPath) setAddressValue(rootPath);
  }, [rootPath]);

  const handleAddressSubmit = () => {
    const path = addressValue.trim();
    if (!path) return;
    navigateTo(path).catch(console.error);
  };

  const handleRefresh = () => {
    if (!rootPath) return;
    expandedPaths.forEach((p) => refreshDir(p).catch(console.error));
  };

  const handleNewFile = () => {
    if (!rootPath) return;
    const name = prompt("新文件名：");
    if (name) createFile(rootPath, name).catch(console.error);
  };

  const handleNewFolder = () => {
    if (!rootPath) return;
    const name = prompt("新文件夹名：");
    if (name) createFolder(rootPath, name).catch(console.error);
  };

  const handleUploadByPicker = async () => {
    if (!rootPath) return;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({ multiple: true, title: "选择文件上传" });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      const files: { name: string; path: string; size: number; rawFile?: File }[] = paths.map(
        (p) => {
          const name = p.split(/[/\\]/).pop() || "upload";
          return { name, path: p, size: 0 };
        },
      );
      uploadFiles(files, rootPath).catch(console.error);
    } catch (err) {
      // File picker error
    }
  };

  const handleDownload = async () => {
    if (selectedPaths.size === 0) return;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const dir = await open({ directory: true, title: "选择保存位置" });
      if (!dir) return;
      const localDir = typeof dir === "string" ? dir : (dir as string);

      // Find selected nodes from tree
      const items: { path: string; name: string; isDir: boolean }[] = [];
      const findNodes = (nodes: FileTreeNode[]) => {
        for (const node of nodes) {
          if (selectedPaths.has(node.path)) {
            items.push({ path: node.path, name: node.name, isDir: node.isDir });
          }
          if (node.children) findNodes(node.children);
        }
      };
      findNodes(tree);

      if (items.length > 0) {
        downloadFiles(items, localDir).catch(console.error);
      }
    } catch {
      // Dialog error
    }
  };

  // Drag-and-drop handlers for file upload
  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;
    if (e.dataTransfer.types.includes("Files")) {
      setIsDragOver(true);
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) {
      setIsDragOver(false);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current = 0;
    setIsDragOver(false);

    if (!rootPath) return;

    const droppedFiles = e.dataTransfer.files;
    if (!droppedFiles || droppedFiles.length === 0) return;

    // Build file list following SFTP FileManager pattern
    // When dragDropEnabled is false in Tauri, File.path is empty so we always use rawFile
    const files: { name: string; path: string; size: number; rawFile?: File }[] = [];
    for (let i = 0; i < droppedFiles.length; i++) {
      const f = droppedFiles[i];
      const filePath = (f as File & { path?: string }).path;
      const hasLocalPath = filePath && (filePath.includes(":") || filePath.startsWith("/"));
      files.push({
        name: f.name,
        path: hasLocalPath ? filePath : f.name,
        size: f.size,
        // If no local path available, pass the raw File for arrayBuffer upload
        rawFile: hasLocalPath ? undefined : f,
      });
    }

    if (files.length > 0) {
      uploadFiles(files, rootPath).catch(console.error);
    }
  };

  return (
    <div
      className="flex h-full flex-col bg-background"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Toolbar */}
      <div className="flex h-8 shrink-0 items-center gap-0.5 border-b border-border px-1.5">
        <span className="mr-auto px-1 text-xs font-medium text-foreground">文件</span>
        <IconBtn title="上传文件" onClick={handleUploadByPicker}>
          <Upload className="h-4 w-4" />
        </IconBtn>
        <IconBtn title={`下载选中 (${selectedPaths.size})`} onClick={handleDownload}>
          <Download className="h-4 w-4" />
        </IconBtn>
        <IconBtn title="新建文件" onClick={handleNewFile}>
          <FilePlus className="h-4 w-4" />
        </IconBtn>
        <IconBtn title="新建文件夹" onClick={handleNewFolder}>
          <FolderPlus className="h-4 w-4" />
        </IconBtn>
        <IconBtn title="刷新" onClick={handleRefresh}>
          <RefreshCw className="h-4 w-4" />
        </IconBtn>
        <IconBtn
          title={showHiddenFiles ? "隐藏隐藏文件" : "显示隐藏文件"}
          onClick={() => setShowHiddenFiles(!showHiddenFiles)}
        >
          {showHiddenFiles ? (
            <Eye className="h-4 w-4" />
          ) : (
            <EyeOff className="h-4 w-4" />
          )}
        </IconBtn>
      </div>

      {/* Address bar */}
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border px-1.5">
        <Input
          value={addressValue}
          onChange={(e) => setAddressValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleAddressSubmit();
          }}
          placeholder="输入路径..."
          className="h-6 rounded-sm px-1.5 py-0 text-[13px]"
        />
        <IconBtn title="前往" onClick={handleAddressSubmit}>
          <ArrowRight className="h-3.5 w-3.5" />
        </IconBtn>
      </div>

      {/* Tree */}
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className="relative min-h-0 flex-1 overflow-auto"
            onClick={(e) => {
              if (e.target === e.currentTarget) {
                clearSelection();
              }
            }}
          >
            <div className="py-0.5" role="tree">
              {tree.map((node) => renderNode(node, 0))}
            </div>
            {/* Drag overlay */}
            {isDragOver && (
              <div className="absolute inset-0 z-10 flex items-center justify-center bg-primary/5 border-2 border-dashed border-primary/40 rounded">
                <span className="text-sm font-medium text-primary">拖放文件到此处上传</span>
              </div>
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={handleNewFile}>
            <FilePlus className="mr-2 h-3.5 w-3.5" />
            新建文件
          </ContextMenuItem>
          <ContextMenuItem onClick={handleNewFolder}>
            <FolderPlus className="mr-2 h-3.5 w-3.5" />
            新建文件夹
          </ContextMenuItem>
          <ContextMenuItem onClick={handleUploadByPicker}>
            <Upload className="mr-2 h-3.5 w-3.5" />
            上传文件
          </ContextMenuItem>
          <ContextMenuItem onClick={handleDownload}>
            <Download className="mr-2 h-3.5 w-3.5" />
            下载选中
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={handleRefresh}>
            <RefreshCw className="mr-2 h-3.5 w-3.5" />
            刷新
          </ContextMenuItem>
          <ContextMenuItem onClick={() => setShowHiddenFiles(!showHiddenFiles)}>
            {showHiddenFiles ? (
              <Eye className="mr-2 h-3.5 w-3.5" />
            ) : (
              <EyeOff className="mr-2 h-3.5 w-3.5" />
            )}
            {showHiddenFiles ? "隐藏隐藏文件" : "显示隐藏文件"}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {/* Transfer progress */}
      <IdeTransferPanel />
    </div>
  );
}
