import { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  Image as ImageIcon,
  FileCode,
  Package,
  PanelRightClose,
  RefreshCw,
  AlertTriangle,
  FolderOpen as FolderOpenIcon,
  Trash2,
} from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useFilePreviewStore, type PreviewScope } from "./filePreviewStore";
import { isTauri, openPathWithSystemApp, revealItemInDir } from "@/lib/tauri";
import {
  getCachedIcon,
  getIcon as getSystemIcon,
  extractExtension,
} from "@/components/terminal/FileManager/iconCache";
import { cn } from "@/lib/utils";
import type { DeliveredFile } from "@/lib/types";

interface WorkspacePanelProps {
  files: DeliveredFile[];
  /** Files delivered during the current session (deliver_file / file_edit
   *  events). Rendered as a dedicated flat section above the full artifact
   *  tree so the user can answer "what did THIS conversation produce". */
  sessionFiles?: DeliveredFile[];
  /** Preview scope passed through to file cards so previews resolve
   *  against the right root (``<workspace>/output/`` vs session project). */
  scope?: PreviewScope;
  /** Required when ``scope === "project"``. */
  sessionKey?: string | null;
  /** True while the artifact scan is in flight (shared mode only). */
  loading?: boolean;
  /** Error message from the artifact scan, if any. */
  error?: string | null;
  /** Whether the server hit its 1000-file return cap. */
  truncated?: boolean;
  /** Manual refresh callback. */
  onRefresh?: () => void;
  /** Move a shared-output artifact to the system recycle bin. Only offered
   *  when ``scope === "shared"``. May return a promise; rejections are shown
   *  inside the confirmation dialog so the user can retry or cancel. */
  onDelete?: (file: DeliveredFile) => void | Promise<void>;
  /** Absolute path of the shared output directory. Enables the
   *  "open output directory" affordances (empty state + truncated footer). */
  outputDir?: string | null;
  className?: string;
}

interface TreeNode {
  name: string;
  /** 相对 output_dir 的路径（文件夹为目录路径，文件为文件路径）。 */
  path: string;
  isDir: boolean;
  file?: DeliveredFile;
  children?: TreeNode[];
}

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]);
const CODE_EXTS = new Set([
  ".py", ".js", ".ts", ".tsx", ".jsx", ".rs", ".go", ".java", ".c", ".cpp",
  ".html", ".css", ".scss", ".json", ".yaml", ".yml", ".toml", ".sql",
]);

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot).toLowerCase();
}

/** Stable identity of a delivered file across scan results and live
 *  deliver events (absolute path preferred). */
function fileKey(f: DeliveredFile): string {
  return f.absolute_path || f.path || f.name;
}

/** Fallback lucide icon when no system icon is available (non-Tauri or
 *  extraction failure). */
function FallbackFileIcon({ name }: { name: string }) {
  const ext = extOf(name);
  if (IMAGE_EXTS.has(ext))
    return <ImageIcon className="h-4 w-4 shrink-0 text-emerald-500" />;
  if (CODE_EXTS.has(ext))
    return <FileCode className="h-4 w-4 shrink-0 text-blue-500" />;
  return <FileText className="h-4 w-4 shrink-0 text-sky-500" />;
}

/** Resolves the OS default file icon for a file name (by extension).
 *  Returns ``null`` until the async lookup completes; caller should
 *  render a fallback in the meantime. Empty ``name`` returns ``null``
 *  without triggering a lookup (used for directory rows). */
function useFileIconUrl(name: string): string | null {
  const [url, setUrl] = useState<string | null>(() => {
    if (!isTauri() || !name) return null;
    return getCachedIcon(extractExtension(name), false);
  });
  useEffect(() => {
    if (!isTauri() || !name) {
      setUrl(null);
      return;
    }
    let cancelled = false;
    const cached = getCachedIcon(extractExtension(name), false);
    if (cached) {
      setUrl(cached);
      return;
    }
    getSystemIcon(extractExtension(name), false).then((dataUrl) => {
      if (!cancelled && dataUrl) setUrl(dataUrl);
    });
    return () => {
      cancelled = true;
    };
  }, [name]);
  return url;
}

/** 将扁平的 DeliveredFile 列表构建为树形结构。
 *
 *  - artifacts scan 返回相对路径（如 "sub/dir/file.pdf"），按 "/" 分层
 *  - deliver_file/file_edit 事件可能是绝对路径或纯文件名，回退为顶层节点
 */
function buildFileTree(files: DeliveredFile[]): TreeNode[] {
  const root: TreeNode = { name: "", path: "", isDir: true, children: [] };
  for (const file of files) {
    const rawPath = file.path || file.name;
    // 绝对路径（Windows 盘符或 POSIX 根）无法作为相对树路径，回退为顶层
    const isAbsolute = /^[A-Za-z]:[\\/]/.test(rawPath) || rawPath.startsWith("/");
    const segments = isAbsolute
      ? [file.name]
      : rawPath.split("/").filter(Boolean);
    if (segments.length === 0) continue;

    let cur = root;
    for (let i = 0; i < segments.length; i++) {
      const part = segments[i];
      const isLeaf = i === segments.length - 1;
      if (isLeaf) {
        cur.children!.push({
          name: part,
          path: rawPath,
          isDir: false,
          file,
        });
      } else {
        let next = cur.children!.find((c) => c.isDir && c.name === part);
        if (!next) {
          next = {
            name: part,
            path: segments.slice(0, i + 1).join("/"),
            isDir: true,
            children: [],
          };
          cur.children!.push(next);
        }
        cur = next;
      }
    }
  }

  const sortNodes = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name, "zh-Hans-CN");
    });
    for (const n of nodes) if (n.children) sortNodes(n.children);
  };
  sortNodes(root.children!);
  return root.children!;
}

/** Flatten the panel's visual order — session section first (flat), then
 *  the sorted artifact tree depth-first — into a single navigation list.
 *  Used by the preview panel's prev/next cycling so "next" matches the
 *  next visual row the user saw in the list. Deduped by absolute path. */
export function flattenFilesForDisplay(
  files: DeliveredFile[],
  sessionFiles: DeliveredFile[],
): DeliveredFile[] {
  const out: DeliveredFile[] = [];
  const seen = new Set<string>();
  const push = (f: DeliveredFile) => {
    const key = fileKey(f);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(f);
  };
  for (const f of sessionFiles) push(f);
  const walk = (nodes: TreeNode[]) => {
    for (const node of nodes) {
      if (node.isDir) {
        if (node.children) walk(node.children);
      } else if (node.file) {
        push(node.file);
      }
    }
  };
  walk(buildFileTree(files));
  return out;
}

export function WorkspacePanel({
  files,
  sessionFiles: sessionFilesProp,
  scope = "shared",
  sessionKey = null,
  loading = false,
  error = null,
  truncated = false,
  onRefresh,
  onDelete,
  outputDir = null,
  className,
}: WorkspacePanelProps) {
  const toggleCollapsed = useFilePreviewStore((s) => s.toggleWorkspaceCollapsed);
  const previewFile = useFilePreviewStore((s) => s.file);
  const closePreview = useFilePreviewStore((s) => s.close);
  const artifactBaseline = useFilePreviewStore((s) => s.artifactBaseline);
  const viewedArtifactPaths = useFilePreviewStore((s) => s.viewedArtifactPaths);
  const observeArtifactInventory = useFilePreviewStore(
    (s) => s.observeArtifactInventory,
  );

  const tree = useMemo(() => buildFileTree(files), [files]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [deleteTarget, setDeleteTarget] = useState<DeliveredFile | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deletePending, setDeletePending] = useState(false);

  // Session deliveries may repeat the same file across turns (dedupe by
  // absolute path); the scan tree below stays the authoritative full list.
  const sessionFiles = useMemo(() => {
    const out: DeliveredFile[] = [];
    const seen = new Set<string>();
    for (const f of sessionFilesProp ?? []) {
      const key = f.absolute_path || f.path || f.name;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(f);
    }
    return out;
  }, [sessionFilesProp]);

  const totalCount = useMemo(() => {
    const keys = new Set<string>();
    for (const f of files) keys.add(fileKey(f));
    for (const f of sessionFiles) keys.add(fileKey(f));
    return keys.size;
  }, [files, sessionFiles]);

  // New-file feedback: the first non-empty inventory is the baseline;
  // anything arriving afterwards is flagged "new" until previewed. The
  // state lives in the preview store because this panel unmounts while a
  // preview is open, and local state would reset on every round-trip.
  const allKeys = useMemo(() => {
    const keys: string[] = [];
    for (const f of files) keys.push(fileKey(f));
    for (const f of sessionFiles) keys.push(fileKey(f));
    return keys;
  }, [files, sessionFiles]);

  useEffect(() => {
    observeArtifactInventory(allKeys);
  }, [allKeys, observeArtifactInventory]);

  const newKeys = useMemo(() => {
    const out = new Set<string>();
    if (!artifactBaseline) return out;
    for (const key of allKeys) {
      if (!artifactBaseline.has(key) && !viewedArtifactPaths.has(key)) {
        out.add(key);
      }
    }
    return out;
  }, [allKeys, artifactBaseline, viewedArtifactPaths]);

  const toggle = (path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const handleOpenOutputDir = () => {
    if (!isTauri() || !outputDir) return;
    void openPathWithSystemApp(outputDir);
  };

  const handleDeleteRequest = (file: DeliveredFile) => {
    setDeleteError(null);
    setDeleteTarget(file);
  };

  const handleDeleteConfirm = async (event: React.MouseEvent) => {
    // Radix closes the dialog on Action click by default; we close it
    // ourselves only after the trash call succeeds, so failures keep the
    // dialog open and never read as a silent permanent delete.
    event.preventDefault();
    if (!deleteTarget || !onDelete) return;
    const target = deleteTarget;
    setDeletePending(true);
    setDeleteError(null);
    try {
      await onDelete(target);
    } catch (err) {
      setDeletePending(false);
      setDeleteError(err instanceof Error ? err.message : String(err));
      return;
    }
    setDeletePending(false);
    // 若正在预览该文件，先关闭预览，避免预览面板指向已删除文件。
    if (previewFile?.absolute_path === target.absolute_path) {
      closePreview();
    }
    setDeleteTarget(null);
  };

  const isEmpty = files.length === 0 && sessionFiles.length === 0;
  const canDelete = scope === "shared" && !!onDelete;

  return (
    <div className={cn("flex h-full flex-col bg-background", className)}>
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
        <Package className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">产物</span>
        {!isEmpty && (
          <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
            {totalCount}
          </span>
        )}
        <div className="flex-1" />
        {onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            title="刷新"
            className={cn(
              "rounded-sm p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground",
              "disabled:opacity-40 disabled:hover:bg-transparent",
            )}
          >
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          </button>
        )}
        <button
          type="button"
          onClick={toggleCollapsed}
          title="折叠工作区"
          className="rounded-sm p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <PanelRightClose className="h-4 w-4" />
        </button>
      </div>

      {error ? (
        <div className="flex flex-col items-center gap-2 px-4 py-6 text-center text-xs text-destructive">
          <AlertTriangle className="h-5 w-5 opacity-70" />
          <span>加载产物失败：{error}</span>
          {onRefresh && (
            <button
              type="button"
              onClick={onRefresh}
              className="rounded-md border border-border/60 px-2 py-1 text-[11px] hover:bg-muted"
            >
              重试
            </button>
          )}
        </div>
      ) : isEmpty ? (
        <div className="flex h-full flex-col items-center justify-center gap-2 px-4 py-6 text-center text-xs text-muted-foreground">
          <FolderOpenIcon className="h-6 w-6 opacity-40" />
          <span>
            {scope === "shared"
              ? "还没有产物。AI 创建的文件会出现在这里。"
              : "当前项目还没有交付文件。"}
          </span>
          {isTauri() && scope === "shared" && outputDir && (
            <button
              type="button"
              onClick={handleOpenOutputDir}
              className="rounded-md border border-border/60 px-2 py-1 text-[11px] hover:bg-muted"
            >
              打开 output 目录
            </button>
          )}
        </div>
      ) : (
        <>
          {sessionFiles.length > 0 && (
            <div className="shrink-0 border-b border-border/60 px-2 py-1.5">
              <div className="px-1 pb-1 text-[11px] font-medium text-muted-foreground">
                本次会话
              </div>
              <ul className="flex flex-col text-[13px]">
                {sessionFiles.map((f) => {
                  const key = fileKey(f);
                  return (
                    <TreeRow
                      key={`s-${key}`}
                      node={{ name: f.name, path: key, isDir: false, file: f }}
                      depth={0}
                      collapsed={collapsed}
                      onToggle={toggle}
                      scope={scope}
                      sessionKey={sessionKey}
                      activePath={previewFile?.absolute_path ?? null}
                      canDelete={canDelete}
                      onDelete={handleDeleteRequest}
                      newKeys={newKeys}
                    />
                  );
                })}
              </ul>
            </div>
          )}
          {tree.length > 0 && (
            <div className="shrink-0 px-2 pt-1.5 pb-1">
              <div className="px-1 text-[11px] font-medium text-muted-foreground">
                工作区文件
              </div>
            </div>
          )}
          <div className="flex-1 overflow-y-auto scrollbar-hover py-1">
            <ul className="flex flex-col text-[13px]">
              {tree.map((node) => (
                <TreeRow
                  key={`${node.isDir ? "d" : "f"}-${node.path}`}
                  node={node}
                  depth={0}
                  collapsed={collapsed}
                  onToggle={toggle}
                  scope={scope}
                  sessionKey={sessionKey}
                  activePath={previewFile?.absolute_path ?? null}
                  canDelete={canDelete}
                  onDelete={handleDeleteRequest}
                  newKeys={newKeys}
                />
              ))}
            </ul>
            {truncated && (
              <div className="mt-2 rounded-md border border-border/50 bg-muted/30 px-2 py-1.5 text-[11px] text-muted-foreground">
                仅显示最近 1000 个文件。
                {isTauri() && outputDir && (
                  <button
                    type="button"
                    onClick={handleOpenOutputDir}
                    className="ml-1 underline-offset-2 hover:underline"
                  >
                    打开 output 目录查看全部
                  </button>
                )}
              </div>
            )}
          </div>
        </>
      )}

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(o) => {
          if (!o) {
            setDeleteTarget(null);
            setDeleteError(null);
          }
        }}
      >
        <AlertDialogContent className="w-[min(calc(100vw-2rem),22.75rem)] gap-0 rounded-2xl border border-border/60 bg-card/95 p-5 text-center shadow-lg backdrop-blur-xl sm:rounded-2xl">
          <AlertDialogHeader className="items-center space-y-0 text-center">
            <div className="mb-5 grid h-16 w-16 place-items-center rounded-full bg-destructive/10 text-destructive">
              <div className="grid h-9 w-9 place-items-center rounded-full border border-destructive/20 bg-destructive/5">
                <Trash2 className="h-5 w-5" strokeWidth={2.4} aria-hidden />
              </div>
            </div>
            <AlertDialogTitle className="text-center text-[20px] font-semibold leading-tight tracking-[-0.02em] text-foreground">
              删除这个文件？
            </AlertDialogTitle>
            <AlertDialogDescription className="mt-3 max-w-[17rem] text-center text-[14px] leading-6 text-muted-foreground">
              「{deleteTarget?.name ?? ""}」将被移至系统回收站，需要时可以从回收站恢复。
            </AlertDialogDescription>
            {deleteError ? (
              <p className="mt-3 max-w-[17rem] text-center text-[13px] leading-5 text-destructive">
                移至回收站失败：{deleteError}
              </p>
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter className="mt-7 grid grid-cols-2 gap-3 space-x-0">
            <AlertDialogCancel className="mt-0 h-11 rounded-full border-0 bg-muted/70 px-5 text-[15px] font-semibold text-foreground shadow-none hover:bg-muted">
              取消
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteConfirm}
              disabled={deletePending}
              className="h-11 rounded-full bg-destructive px-5 text-[15px] font-semibold text-destructive-foreground shadow-none hover:bg-destructive/90"
            >
              移至回收站
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function TreeRow({
  node,
  depth,
  collapsed,
  onToggle,
  scope,
  sessionKey,
  activePath,
  canDelete,
  onDelete,
  newKeys,
}: {
  node: TreeNode;
  depth: number;
  collapsed: Set<string>;
  onToggle: (path: string) => void;
  scope: PreviewScope;
  sessionKey: string | null;
  activePath: string | null;
  canDelete: boolean;
  onDelete: (file: DeliveredFile) => void;
  /** Paths that arrived after the baseline inventory and are not yet
   *  previewed — file rows get a leading "new" dot. */
  newKeys: Set<string>;
}) {
  const openPreview = useFilePreviewStore((s) => s.open);
  const indent = 8 + depth * 14;
  // Hook must run unconditionally before any early return (Rules of Hooks).
  const fileName = node.isDir ? "" : (node.file?.name ?? "");
  const fileIconUrl = useFileIconUrl(fileName);

  if (node.isDir) {
    const isCollapsed = collapsed.has(node.path);
    const childCount = node.children?.length ?? 0;
    return (
      <li>
        <button
          type="button"
          onClick={() => onToggle(node.path)}
          className={cn(
            "flex w-full items-center gap-1 rounded-sm py-1 pr-2 text-left",
            "text-foreground/90 hover:bg-muted/60",
          )}
          style={{ paddingLeft: indent }}
        >
          {isCollapsed ? (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )}
          {isCollapsed ? (
            <Folder className="h-4 w-4 shrink-0 text-amber-500" />
          ) : (
            <FolderOpen className="h-4 w-4 shrink-0 text-amber-500" />
          )}
          <span className="min-w-0 truncate font-medium">{node.name}</span>
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {childCount}
          </span>
        </button>
        {!isCollapsed && node.children && (
          <ul className="flex flex-col">
            {node.children.map((child) => (
              <TreeRow
                key={`${child.isDir ? "d" : "f"}-${child.path}`}
                node={child}
                depth={depth + 1}
                collapsed={collapsed}
                onToggle={onToggle}
                scope={scope}
                sessionKey={sessionKey}
                activePath={activePath}
                canDelete={canDelete}
                onDelete={onDelete}
                newKeys={newKeys}
              />
            ))}
          </ul>
        )}
      </li>
    );
  }

  const file = node.file!;
  const isActive = activePath === file.absolute_path;
  const isNew = newKeys.has(fileKey(file));

  const handleClick = () => {
    openPreview(file, scope, sessionKey);
  };
  const handleDoubleClick = () => {
    // Single click stays on in-pane preview; double click hands the file
    // to the OS default app (file-manager muscle memory).
    if (isTauri()) void openPathWithSystemApp(file.absolute_path);
  };
  const handleOpenWithSystem = () => {
    if (isTauri()) void openPathWithSystemApp(file.absolute_path);
  };
  const handleRevealInDir = () => {
    if (isTauri()) void revealItemInDir(file.absolute_path);
  };
  const handleDelete = () => {
    onDelete(file);
  };

  const row = (
    <li>
      <button
        type="button"
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        className={cn(
          "flex w-full items-center gap-1.5 rounded-sm py-1 pr-2 text-left",
          "hover:bg-muted/60",
          isActive && "bg-primary/8",
        )}
        style={{ paddingLeft: indent + 18 }}
      >
        {isNew ? (
          <span
            aria-label="新文件"
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
          />
        ) : null}
        {fileIconUrl ? (
          <img
            src={fileIconUrl}
            alt=""
            className="h-4 w-4 shrink-0 object-contain"
            draggable={false}
          />
        ) : (
          <FallbackFileIcon name={file.name} />
        )}
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-foreground",
            isActive && "text-primary",
          )}
        >
          {file.name}
        </span>
        {file.size_human && (
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {file.size_human}
          </span>
        )}
      </button>
    </li>
  );

  if (!isTauri()) {
    return row;
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuItem onClick={handleClick}>预览</ContextMenuItem>
        <ContextMenuItem onClick={handleOpenWithSystem}>
          系统程序打开
        </ContextMenuItem>
        <ContextMenuItem onClick={handleRevealInDir}>
          打开所在目录
        </ContextMenuItem>
        {canDelete && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem
              onClick={handleDelete}
              className="text-destructive focus:text-destructive"
            >
              <Trash2 className="mr-2 h-4 w-4" />
              删除
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
