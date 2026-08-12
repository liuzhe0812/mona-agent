/**
 * 资料库递归文件树：buildTree + TreeRow 及其专属 helper。
 */

import { useCallback, useEffect, useState } from "react";
import {
  ChevronRight,
  FileText,
  FolderInput,
  FolderPlus,
  Folder,
  RefreshCw,
  Sparkles,
  Trash2,
  Upload,
  ExternalLink,
} from "lucide-react";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { isTauri } from "@/lib/tauri";
import { getFileTypeIcon } from "@/components/terminal/ipc";
import type { MaterialsExtractStatus, MaterialsFileEntry } from "@/lib/materials-api";
import type { MaterialsSelection, TreeNode } from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statusLabel(status?: MaterialsExtractStatus): string {
  if (!status) return "";
  switch (status.status) {
    case "ok":
      return status.truncated ? "已截断" : "可搜索";
    case "queued":
      return "排队中";
    case "running":
      return "提取中";
    case "error":
      return "提取失败";
    case "unsupported":
      return "不支持";
    case "stale":
      return "已过期";
    default:
      return "";
  }
}

function statusColor(status?: MaterialsExtractStatus): string {
  if (!status) return "text-muted-foreground";
  switch (status.status) {
    case "ok":
      return "text-emerald-600";
    case "queued":
    case "running":
    case "stale":
      return "text-amber-600";
    case "error":
      return "text-rose-600";
    default:
      return "text-muted-foreground";
  }
}

// ---------------------------------------------------------------------------
// 递归文件树
// ---------------------------------------------------------------------------

export function buildTree(entries: MaterialsFileEntry[]): TreeNode[] {
  const sorted = [...entries].sort((a, b) => {
    const ad = a.type === "directory" ? 0 : 1;
    const bd = b.type === "directory" ? 0 : 1;
    if (ad !== bd) return ad - bd;
    return a.name.localeCompare(b.name, "zh");
  });
  return sorted.map((entry) => ({
    entry,
    children: [],
    loaded: false,
    expanded: false,
  }));
}

interface TreeRowProps {
  node: TreeNode;
  depth: number;
  selection: MaterialsSelection;
  expandedPaths: Set<string>;
  onSelectRaw: (path: string) => void;
  onToggleExpand: (path: string) => void;
  onUpload: (targetDir: string) => void;
  onCreateFolder: (parentDir: string) => void;
  onDelete: (path: string) => void;
  onMove: (path: string) => void;
  onExtract: (path: string) => void;
  onCompile: (path: string) => void;
  onDragDrop: (srcPath: string, targetDirRaw: string) => void;
  onOpenLocation: (path: string) => void;
  loadChildren: (path: string) => Promise<TreeNode[]>;
  refreshTick: number;
}

export function TreeRow(props: TreeRowProps) {
  const { node, depth, selection, expandedPaths } = props;
  const isDir = node.entry.type === "directory";
  const isSelected = selection?.kind === "raw" && selection.path === node.entry.path;
  const isExpanded = expandedPaths.has(node.entry.path);
  const [children, setChildren] = useState<TreeNode[]>([]);
  const [childrenLoaded, setChildrenLoaded] = useState(false);
  const [iconData, setIconData] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  // 加载系统默认应用图标（仅文件类型）
  useEffect(() => {
    if (isDir || !isTauri()) return;
    let cancelled = false;
    const ext = node.entry.name.split(".").pop() ?? "";
    getFileTypeIcon(ext, false)
      .then((data) => {
        if (!cancelled) setIconData(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isDir, node.entry.name]);

  const loadAndToggle = useCallback(async () => {
    if (isDir && !childrenLoaded) {
      const kids = await props.loadChildren(node.entry.path);
      setChildren(kids);
      setChildrenLoaded(true);
    }
    props.onToggleExpand(node.entry.path);
  }, [isDir, childrenLoaded, node.entry.path, props]);

  // refreshTick 变化时重新加载已展开的子目录（解决移动/删除后子目录缓存不刷新问题）
  useEffect(() => {
    if (!isDir || !childrenLoaded || props.refreshTick === 0) return;
    let cancelled = false;
    void props
      .loadChildren(node.entry.path)
      .then((kids) => {
        if (!cancelled) setChildren(kids);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.refreshTick]);

  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData("text/plain", node.entry.path);
    e.dataTransfer.effectAllowed = "move";
  };

  const handleDragOver = (e: React.DragEvent) => {
    if (!isDir) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (!dragOver) setDragOver(true);
  };

  const handleDragLeave = () => {
    if (dragOver) setDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    if (!isDir) return;
    e.preventDefault();
    e.stopPropagation(); // 阻止冒泡到根目录 wrapper
    setDragOver(false);
    const srcPath = e.dataTransfer.getData("text/plain");
    if (!srcPath) return;
    props.onDragDrop(srcPath, node.entry.path);
  };

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            role="button"
            tabIndex={0}
            draggable
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={() => {
              if (isDir) {
                void loadAndToggle();
              } else {
                props.onSelectRaw(node.entry.path);
              }
            }}
            className={cn(
              "flex cursor-default items-center gap-1 px-2 py-[3px] text-[13px] outline-none",
              "hover:bg-accent",
              isSelected && "bg-accent text-foreground",
              isDir && dragOver && "ring-1 ring-inset ring-primary/60 bg-primary/10",
            )}
            style={{ paddingLeft: `${depth * 12 + 20}px` }}
          >
            {isDir ? (
              <ChevronRight
                className={cn(
                  "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
                  isExpanded && "rotate-90",
                )}
              />
            ) : (
              <span className="inline-block w-3.5 shrink-0" />
            )}
            {isDir ? (
              <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            ) : iconData ? (
              <img
                src={`data:image/png;base64,${iconData}`}
                alt=""
                className="h-4 w-4 shrink-0 object-contain"
                draggable={false}
              />
            ) : (
              <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className="min-w-0 flex-1 truncate">{node.entry.name}</span>
            {!isDir && node.entry.extractStatus ? (
              <span className={cn("shrink-0 text-[10px]", statusColor(node.entry.extractStatus))}>
                {statusLabel(node.entry.extractStatus)}
              </span>
            ) : null}
            {isDir && node.entry.fileCount != null ? (
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {node.entry.fileCount}
              </span>
            ) : null}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {isDir ? (
            <>
              <ContextMenuItem onClick={() => props.onUpload(node.entry.path.replace(/^raw\//, ""))}>
                <Upload className="mr-2 h-3.5 w-3.5" />
                上传到此目录
              </ContextMenuItem>
              <ContextMenuItem onClick={() => props.onCreateFolder(node.entry.path.replace(/^raw\//, ""))}>
                <FolderPlus className="mr-2 h-3.5 w-3.5" />
                新建子文件夹
              </ContextMenuItem>
              <ContextMenuSeparator />
            </>
          ) : (
            <ContextMenuItem onClick={() => props.onExtract(node.entry.path)}>
              <RefreshCw className="mr-2 h-3.5 w-3.5" />
              重新提取
            </ContextMenuItem>
          )}
          <ContextMenuItem onClick={() => props.onCompile(node.entry.path)}>
            <Sparkles className="mr-2 h-3.5 w-3.5" />
            编译为 Wiki
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => props.onMove(node.entry.path)}>
            <FolderInput className="mr-2 h-3.5 w-3.5" />
            移动到...
          </ContextMenuItem>
          <ContextMenuItem onClick={() => props.onOpenLocation(node.entry.path)}>
            <ExternalLink className="mr-2 h-3.5 w-3.5" />
            {isDir ? "打开此目录" : "打开文件路径"}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            className="text-destructive focus:text-destructive"
            onClick={() => props.onDelete(node.entry.path)}
          >
            <Trash2 className="mr-2 h-3.5 w-3.5" />
            删除
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {isDir && isExpanded && childrenLoaded ? (
        children.map((child) => (
          <TreeRow
            key={child.entry.path}
            {...props}
            node={child}
            depth={depth + 1}
          />
        ))
      ) : null}
    </>
  );
}
