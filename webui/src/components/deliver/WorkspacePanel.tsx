import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  Image as ImageIcon,
  FileCode,
  Package,
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { RightSidebarToggleIcon } from "@/components/notes/RightSidebarToggleIcon";
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
  /** Files explicitly delivered during the current session. Rendered as a
   *  dedicated flat section above the full artifact
   *  tree so the user can answer "what did THIS conversation produce". */
  sessionFiles?: DeliveredFile[];
  /** Files created or modified by the current task. Rendered between the
   *  session deliveries and the full workspace tree. */
  taskFiles?: DeliveredFile[];
  /** Preview scope passed through to file cards so previews resolve against
   *  the active Agent owner or session project. */
  scope?: PreviewScope;
  /** Required when ``scope === "project"``. */
  sessionKey?: string | null;
  /** Error message from the artifact scan, if any. */
  error?: string | null;
  /** Whether the server hit its 1000-file return cap. */
  truncated?: boolean;
  /** Manual refresh callback. */
  onRefresh?: () => void;
  /** Collapse the entire right-side artifact panel. */
  onCollapse?: () => void;
  /** Move an artifact (file or directory) to the system recycle bin. May
   *  return a promise; rejections are shown inside the confirmation dialog
   *  so the user can retry or cancel. */
  onDelete?: (file: DeliveredFile) => void | Promise<void>;
  /** Rename a file or directory. The callback owns the filesystem update. */
  onRename?: (file: DeliveredFile, newName: string) => void | Promise<void>;
  /** Absolute path of the panel's root directory (Agent output or project
   *  workspace). Enables the "open directory" affordances and the
   *  directory context menu. */
  outputDir?: string | null;
  /** Stable Agent/project/room owner key for directory expansion state. */
  ownerKey?: string;
  /** Hide the standalone header when rendered inside the overview tab. */
  embedded?: boolean;
  /** Render only one flat inventory without the legacy nested section labels. */
  listOnly?: "session" | "task" | "workspace";
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

interface FileSelection {
  selectedKeys: Set<string>;
  selectedFiles: DeliveredFile[];
  onSelect: (file: DeliveredFile, event: React.MouseEvent<HTMLButtonElement>) => void;
  onContextMenu: (file: DeliveredFile) => void;
  onDelete: (files: DeliveredFile[]) => void;
}

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]);
const CODE_EXTS = new Set([
  ".py", ".js", ".ts", ".tsx", ".jsx", ".rs", ".go", ".java", ".c", ".cpp",
  ".html", ".css", ".scss", ".json", ".yaml", ".yml", ".toml", ".sql",
]);
const EMPTY_COLLAPSED_PATHS: string[] = [];

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

/** Hide the technical generated/ wrapper while keeping its real paths. */
function flattenGeneratedDirectory(nodes: TreeNode[]): TreeNode[] {
  return nodes.flatMap((node) =>
    node.isDir && node.name.toLowerCase() === "generated" ? node.children ?? [] : [node],
  );
}

function collectDirectoryPaths(nodes: TreeNode[]): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    if (!node.isDir) continue;
    paths.push(node.path);
    if (node.children) paths.push(...collectDirectoryPaths(node.children));
  }
  return paths;
}

/** Flatten the panel's visual order — session section first, current-task
 *  section second, then the sorted artifact tree depth-first — into a single
 *  navigation list.
 *  Used by the preview panel's prev/next cycling so "next" matches the
 *  next visual row the user saw in the list. Deduped by absolute path. */
export function flattenFilesForDisplay(
  files: DeliveredFile[],
  sessionFiles: DeliveredFile[],
  taskFiles: DeliveredFile[] = [],
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
  for (const f of taskFiles) push(f);
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
  taskFiles: taskFilesProp,
  scope = "shared",
  sessionKey = null,
  error = null,
  truncated = false,
  onRefresh,
  onCollapse,
  onDelete,
  onRename,
  outputDir = null,
  ownerKey = "default",
  embedded = false,
  listOnly,
  className,
}: WorkspacePanelProps) {
  const previewFile = useFilePreviewStore((s) => s.file);
  const closePreview = useFilePreviewStore((s) => s.close);
  const artifactBaseline = useFilePreviewStore((s) => s.artifactBaseline);
  const viewedArtifactPaths = useFilePreviewStore((s) => s.viewedArtifactPaths);
  const observeArtifactInventory = useFilePreviewStore(
    (s) => s.observeArtifactInventory,
  );
  const markArtifactsViewed = useFilePreviewStore((s) => s.markArtifactsViewed);

  const tree = useMemo(() => flattenGeneratedDirectory(buildFileTree(files)), [files]);
  const directoryPaths = useMemo(() => collectDirectoryPaths(tree), [tree]);
  const collapsedPaths = useFilePreviewStore(
    (s) => s.treeCollapsedByOwner[ownerKey] ?? EMPTY_COLLAPSED_PATHS,
  );
  const initializedDirectoryPaths = useFilePreviewStore(
    (s) => s.treeExpansionInitializedByOwner[ownerKey] ?? EMPTY_COLLAPSED_PATHS,
  );
  const collapsed = useMemo(() => {
    const next = new Set(collapsedPaths);
    const initialized = new Set(initializedDirectoryPaths);
    for (const path of directoryPaths) {
      if (!initialized.has(path)) next.add(path);
    }
    return next;
  }, [collapsedPaths, directoryPaths, initializedDirectoryPaths]);
  const toggleTreeDirectory = useFilePreviewStore((s) => s.toggleTreeDirectory);
  const initializeTreeDirectories = useFilePreviewStore((s) => s.initializeTreeDirectories);
  useEffect(() => {
    initializeTreeDirectories(ownerKey, directoryPaths);
  }, [directoryPaths, initializeTreeDirectories, ownerKey]);
  const [deleteTarget, setDeleteTarget] = useState<{
    files: DeliveredFile[];
    isDir: boolean;
  } | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const [renameTarget, setRenameTarget] = useState<{
    file: DeliveredFile;
    isDir: boolean;
  } | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renamePending, setRenamePending] = useState(false);
  const [sessionExpanded, setSessionExpanded] = useState(true);
  const [taskExpanded, setTaskExpanded] = useState(true);
  const [workspaceExpanded, setWorkspaceExpanded] = useState(scope !== "shared");
  const [selectedFileKeys, setSelectedFileKeys] = useState<Set<string>>(() => new Set());
  const selectionAnchorRef = useRef<string | null>(null);
  useEffect(() => {
    setWorkspaceExpanded(scope !== "shared");
  }, [ownerKey, scope]);

  // Session deliveries may repeat the same file across turns (dedupe by
  // absolute path); the scan tree below stays the authoritative full list.
  const sessionFiles = useMemo(() => {
    const out: DeliveredFile[] = [];
    const seen = new Set<string>();
    for (const f of sessionFilesProp ?? []) {
      if (f.missing) continue;
      const key = f.absolute_path || f.path || f.name;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(f);
    }
    return out;
  }, [sessionFilesProp]);

  // Current-task files can also be present in the session delivery list;
  // session deliveries own that section and should not be repeated here.
  const taskFiles = useMemo(() => {
    const sessionKeys = new Set(sessionFiles.map(fileKey));
    const out: DeliveredFile[] = [];
    const seen = new Set<string>();
    for (const f of taskFilesProp ?? []) {
      if (f.missing) continue;
      const key = fileKey(f);
      if (sessionKeys.has(key) || seen.has(key)) continue;
      seen.add(key);
      out.push(f);
    }
    return out;
  }, [sessionFiles, taskFilesProp]);

  const totalCount = useMemo(() => {
    const keys = new Set<string>();
    for (const f of files) keys.add(fileKey(f));
    for (const f of sessionFiles) keys.add(fileKey(f));
    for (const f of taskFiles) keys.add(fileKey(f));
    return keys.size;
  }, [files, sessionFiles, taskFiles]);

  const selectionOrder = useMemo(
    () => flattenFilesForDisplay(files, sessionFiles, taskFiles).filter((file) => !file.missing),
    [files, sessionFiles, taskFiles],
  );
  const filesByKey = useMemo(
    () => new Map(selectionOrder.map((file) => [fileKey(file), file])),
    [selectionOrder],
  );
  const selectedFiles = useMemo(
    () => [...selectedFileKeys]
      .map((key) => filesByKey.get(key))
      .filter((file): file is DeliveredFile => Boolean(file)),
    [filesByKey, selectedFileKeys],
  );

  useEffect(() => {
    const availableKeys = new Set(filesByKey.keys());
    setSelectedFileKeys((current) => {
      const next = new Set([...current].filter((key) => availableKeys.has(key)));
      return next.size === current.size ? current : next;
    });
    if (selectionAnchorRef.current && !availableKeys.has(selectionAnchorRef.current)) {
      selectionAnchorRef.current = null;
    }
  }, [filesByKey]);

  useEffect(() => {
    setSelectedFileKeys(new Set());
    selectionAnchorRef.current = null;
  }, [ownerKey]);

  // New-file feedback: the first non-empty inventory is the baseline;
  // anything arriving afterwards is flagged "new" until previewed. The
  // state lives in the preview store because this panel unmounts while a
  // preview is open, and local state would reset on every round-trip.
  const allKeys = useMemo(() => {
    const keys: string[] = [];
    for (const f of files) keys.push(fileKey(f));
    for (const f of sessionFiles) keys.push(fileKey(f));
    for (const f of taskFiles) keys.push(fileKey(f));
    return keys;
  }, [files, sessionFiles, taskFiles]);

  useEffect(() => {
    observeArtifactInventory(allKeys);
  }, [allKeys, observeArtifactInventory]);

  // Everything the panel displayed counts as seen: when the panel unmounts
  // (preview opens, panel collapses, session switches), merge the current
  // inventory into the baseline so the same rows are not flagged "new" again.
  const allKeysRef = useRef(allKeys);
  allKeysRef.current = allKeys;
  useEffect(() => {
    return () => markArtifactsViewed(allKeysRef.current);
  }, [markArtifactsViewed]);

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

  const toggle = (path: string) => toggleTreeDirectory(ownerKey, path);

  const handleOpenOutputDir = () => {
    if (!isTauri() || !outputDir) return;
    void openPathWithSystemApp(outputDir);
  };

  const handleDeleteRequest = (filesToDelete: DeliveredFile[], isDir = false) => {
    const availableFiles = filesToDelete.filter((file) => !file.missing);
    if (availableFiles.length === 0) return;
    setDeleteError(null);
    setDeleteTarget({ files: availableFiles, isDir });
  };

  const handleFileSelection = (
    file: DeliveredFile,
    event: React.MouseEvent<HTMLButtonElement>,
  ) => {
    if (file.missing) return;
    const key = fileKey(file);
    const isRangeSelection = event.shiftKey && selectionAnchorRef.current;
    const isToggleSelection = event.ctrlKey || event.metaKey;

    setSelectedFileKeys((current) => {
      if (isRangeSelection) {
        const anchorIndex = selectionOrder.findIndex(
          (candidate) => fileKey(candidate) === selectionAnchorRef.current,
        );
        const targetIndex = selectionOrder.findIndex((candidate) => fileKey(candidate) === key);
        if (anchorIndex >= 0 && targetIndex >= 0) {
          const range = selectionOrder
            .slice(Math.min(anchorIndex, targetIndex), Math.max(anchorIndex, targetIndex) + 1)
            .map(fileKey);
          return new Set(isToggleSelection ? [...current, ...range] : range);
        }
      }

      const next = new Set(isToggleSelection ? current : []);
      if (isToggleSelection && next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

    if (!event.shiftKey) selectionAnchorRef.current = key;
  };

  const handleFileContextMenu = (file: DeliveredFile) => {
    if (file.missing) return;
    const key = fileKey(file);
    setSelectedFileKeys((current) => current.has(key) ? current : new Set([key]));
    selectionAnchorRef.current = key;
  };

  const handleRenameRequest = (file: DeliveredFile, isDir = false) => {
    if (file.missing || !onRename) return;
    setRenameError(null);
    setRenameValue(file.name);
    setRenameTarget({ file, isDir });
  };

  const handleRenameConfirm = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!renameTarget || !onRename || renamePending) return;
    const newName = renameValue.trim();
    if (!newName) {
      setRenameError("请输入新名称");
      return;
    }
    setRenamePending(true);
    setRenameError(null);
    try {
      await onRename(renameTarget.file, newName);
      setRenameTarget(null);
    } catch (err) {
      setRenameError(err instanceof Error ? err.message : String(err));
    } finally {
      setRenamePending(false);
    }
  };

  const handleDeleteConfirm = async (event: React.MouseEvent) => {
    // Radix closes the dialog on Action click by default; we close it
    // ourselves only after the trash call succeeds, so failures keep the
    // dialog open and never read as a silent permanent delete.
    event.preventDefault();
    if (!deleteTarget || !onDelete) return;
    const targets = deleteTarget.files;
    setDeletePending(true);
    setDeleteError(null);
    for (let index = 0; index < targets.length; index += 1) {
      try {
        await onDelete(targets[index]);
      } catch (err) {
        setDeletePending(false);
        const remainingTargets = targets.slice(index);
        setDeleteTarget({
          files: remainingTargets,
          isDir: remainingTargets.length === 1 && deleteTarget.isDir,
        });
        setDeleteError(err instanceof Error ? err.message : String(err));
        return;
      }
    }
    setDeletePending(false);
    // 若正在预览该文件（或被删目录内的文件），先关闭预览，避免预览面板
    // 指向已删除内容。
    const previewPath = previewFile?.absolute_path;
    if (previewPath) {
      const previewWasDeleted = targets.some((target) => {
        const targetPath = target.absolute_path;
        return previewPath === targetPath
          || (deleteTarget.isDir && previewPath.startsWith(`${targetPath}/`));
      });
      if (previewWasDeleted) closePreview();
    }
    setSelectedFileKeys((current) => {
      const next = new Set(current);
      for (const target of targets) next.delete(fileKey(target));
      return next;
    });
    setDeleteTarget(null);
  };

  const isEmpty =
    files.length === 0 && sessionFiles.length === 0 && taskFiles.length === 0;
  const deleteFileCount = deleteTarget?.files.length ?? 0;
  const canDelete = !!onDelete;
  const canRename = !!onRename;
  const fileSelection: FileSelection = {
    selectedKeys: selectedFileKeys,
    selectedFiles,
    onSelect: handleFileSelection,
    onContextMenu: handleFileContextMenu,
    onDelete: (filesToDelete) => handleDeleteRequest(filesToDelete),
  };
  const panelLabel = embedded ? "交付物" : scope === "shared" ? "概览" : "项目文件";

  return (
    <div className={cn("flex flex-col bg-card", !embedded && "h-full", className)}>
      {!embedded ? <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
        <Package className="h-4 w-4 text-muted-foreground" />
        <span className="text-body font-medium">{panelLabel}</span>
        {!isEmpty && (
          <span className="rounded-full bg-muted px-1.5 py-0.5 text-micro text-muted-foreground">
            {totalCount}
          </span>
        )}
        <div className="flex-1" />
        {onCollapse && (
          <Button
            type="button"
            variant="ghost"
            onClick={onCollapse}
            title="收起概览"
            aria-label="收起概览"
            className={cn(
              "h-6 w-6 rounded-sm p-0 text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            <RightSidebarToggleIcon open className="h-3.5 w-3.5" />
          </Button>
        )}
      </div> : null}

      {error ? (
        <div className="flex flex-col items-center gap-2 px-4 py-6 text-center text-caption text-destructive">
          <AlertTriangle className="h-5 w-5 opacity-70" />
          <span>加载{panelLabel}失败：{error}</span>
          {onRefresh && (
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={onRefresh}
            >
              重试
            </Button>
          )}
        </div>
      ) : listOnly ? (
        <div className="py-1">
          {listOnly === "workspace" ? (
            <>
              <ul className="flex flex-col text-ui">
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
                    canRename={canRename}
                    onRename={handleRenameRequest}
                    newKeys={new Set<string>()}
                    rootDir={outputDir}
                    selection={fileSelection}
                  />
                ))}
              </ul>
              {tree.length === 0 ? (
                <div className="px-3 py-2 text-micro text-muted-foreground/70">
                  工作区暂无文件。
                  {isTauri() && outputDir ? (
                    <Button type="button" variant="link" size="xs" onClick={handleOpenOutputDir} className="ml-1 h-auto p-0 text-micro">
                      打开目录
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : (
            <>
              <ul className="flex flex-col text-ui">
                {(listOnly === "session" ? sessionFiles : taskFiles).map((file) => {
                  const key = fileKey(file);
                  return (
                    <TreeRow
                      key={`${listOnly}-${key}`}
                      node={{ name: file.name, path: key, isDir: false, file }}
                      depth={0}
                      collapsed={collapsed}
                      onToggle={toggle}
                      scope={scope}
                      sessionKey={sessionKey}
                      activePath={previewFile?.absolute_path ?? null}
                      canDelete={canDelete}
                      onDelete={handleDeleteRequest}
                      canRename={canRename}
                      onRename={handleRenameRequest}
                      newKeys={new Set<string>()}
                      rootDir={outputDir}
                      selection={fileSelection}
                    />
                  );
                })}
              </ul>
              {(listOnly === "session" ? sessionFiles : taskFiles).length === 0 ? (
                <p className="px-3 py-2 text-micro text-muted-foreground/70">
                  {listOnly === "session" ? "当前会话还没有明确交付的文件" : "当前任务还没有新增或修改的文件"}
                </p>
              ) : null}
            </>
          )}
          {truncated ? (
            <p className="px-3 py-2 text-micro text-muted-foreground">仅显示最近 1000 个文件。</p>
          ) : null}
        </div>
      ) : scope !== "shared" && isEmpty ? (
        <EmptyState
          className="h-full py-6"
          icon={<FolderOpenIcon className="h-6 w-6 opacity-40" />}
          title="项目目录里还没有文件。"
        />
      ) : (
        <>
          {scope === "shared" && (
            <section className="shrink-0 py-1.5">
              <button
                type="button"
                className="flex w-full items-center gap-1 px-3 text-left text-micro font-medium text-muted-foreground hover:text-foreground"
                aria-expanded={sessionExpanded}
                onClick={() => setSessionExpanded((expanded) => !expanded)}
              >
                <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", sessionExpanded && "rotate-90")} />
                本次会话产物
              </button>
              {sessionExpanded ? sessionFiles.length > 0 ? (
                <ul className="flex flex-col text-ui">
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
                        canRename={canRename}
                        onRename={handleRenameRequest}
                        newKeys={newKeys}
                        rootDir={outputDir}
                        selection={fileSelection}
                      />
                    );
                  })}
                </ul>
              ) : (
                <p className="px-3 py-1 text-micro text-muted-foreground/70">
                  当前会话还没有明确交付的文件
                </p>
              ) : null}
            </section>
          )}
          {scope === "shared" && (
            <section className="shrink-0 py-1.5">
              <button
                type="button"
                className="flex w-full items-center gap-1 px-3 text-left text-micro font-medium text-muted-foreground hover:text-foreground"
                aria-expanded={taskExpanded}
                onClick={() => setTaskExpanded((expanded) => !expanded)}
              >
                <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", taskExpanded && "rotate-90")} />
                当前任务文件
              </button>
              {taskExpanded ? taskFiles.length > 0 ? (
                <ul className="flex flex-col text-ui">
                  {taskFiles.map((f) => {
                    const key = fileKey(f);
                    return (
                      <TreeRow
                        key={`t-${key}`}
                        node={{ name: f.name, path: key, isDir: false, file: f }}
                        depth={0}
                        collapsed={collapsed}
                        onToggle={toggle}
                        scope={scope}
                        sessionKey={sessionKey}
                        activePath={previewFile?.absolute_path ?? null}
                        canDelete={canDelete}
                        onDelete={handleDeleteRequest}
                        canRename={canRename}
                        onRename={handleRenameRequest}
                        newKeys={newKeys}
                        rootDir={outputDir}
                        selection={fileSelection}
                      />
                    );
                  })}
                </ul>
              ) : (
                <p className="px-3 py-1 text-micro text-muted-foreground/70">
                  当前任务还没有新增或修改的文件
                </p>
              ) : null}
            </section>
          )}
          <div className={cn("py-1", !embedded && "flex-1 overflow-y-auto scrollbar-hover")}>
            <button
              type="button"
              className="flex w-full items-center gap-1 px-3 pt-1.5 pb-1 text-left text-micro font-medium text-muted-foreground hover:text-foreground"
              aria-expanded={workspaceExpanded}
              onClick={() => setWorkspaceExpanded((expanded) => !expanded)}
            >
              <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", workspaceExpanded && "rotate-90")} />
              <span>
                {scope === "shared" ? "工作区文件" : "全部文件"}
              </span>
            </button>
            {workspaceExpanded ? <>
            <ul className="flex flex-col text-ui">
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
                  canRename={canRename}
                  onRename={handleRenameRequest}
                  newKeys={newKeys}
                  rootDir={outputDir}
                  selection={fileSelection}
                />
              ))}
            </ul>
            {scope === "shared" && tree.length === 0 ? (
              <div className="px-3 py-3 text-micro text-muted-foreground/70">
                工作区暂无其他文件。
                {isTauri() && outputDir && (
                  <Button
                    type="button"
                    variant="link"
                    size="xs"
                    onClick={handleOpenOutputDir}
                    className="ml-1 h-auto p-0 text-micro"
                  >
                    打开目录
                  </Button>
                )}
              </div>
            ) : null}
            {truncated && (
              <div className="mt-2 rounded-md border border-border/50 bg-muted/30 px-2 py-1.5 text-micro text-muted-foreground">
                仅显示最近 1000 个文件。
                {isTauri() && outputDir && (
                  <Button
                    type="button"
                    variant="link"
                    onClick={handleOpenOutputDir}
                    className="ml-1 h-auto p-0 font-normal text-micro text-muted-foreground underline-offset-2"
                  >
                    {scope === "shared"
                      ? "打开 output 目录查看全部"
                      : "打开项目目录查看全部"}
                  </Button>
                )}
              </div>
            )}
            </> : null}
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
            <AlertDialogTitle className="text-center text-title-sm tracking-[-0.02em] text-foreground">
              {deleteFileCount > 1
                ? `删除这 ${deleteFileCount} 个文件？`
                : deleteTarget?.isDir ? "删除这个文件夹？" : "删除这个文件？"}
            </AlertDialogTitle>
            <AlertDialogDescription className="mt-3 max-w-[17rem] text-center text-body leading-6 text-muted-foreground">
              {deleteFileCount > 1
                ? `选中的 ${deleteFileCount} 个文件将被移至系统回收站，需要时可以从回收站恢复。`
                : `「${deleteTarget?.files[0]?.name ?? ""}」将被移至系统回收站，需要时可以从回收站恢复。`}
            </AlertDialogDescription>
            {deleteError ? (
              <p className="mt-3 max-w-[17rem] text-center text-ui leading-5 text-destructive">
                移至回收站失败：{deleteError}
              </p>
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter className="mt-7 grid grid-cols-2 gap-3 space-x-0">
            <AlertDialogCancel className="mt-0 h-11 rounded-full border-0 bg-muted/70 px-5 text-body-lg font-semibold text-foreground shadow-none hover:bg-muted">
              取消
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteConfirm}
              disabled={deletePending}
              className="h-11 rounded-full bg-destructive px-5 text-body-lg font-semibold text-destructive-foreground shadow-none hover:bg-destructive/90"
            >
              移至回收站
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog
        open={!!renameTarget}
        onOpenChange={(open) => {
          if (!open) {
            setRenameTarget(null);
            setRenameError(null);
            setRenamePending(false);
          }
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <form className="grid gap-4" onSubmit={handleRenameConfirm}>
            <DialogHeader>
              <DialogTitle>
                {renameTarget?.isDir ? "重命名文件夹" : "重命名文件"}
              </DialogTitle>
              <DialogDescription>请输入新的名称。</DialogDescription>
            </DialogHeader>
            <Input
              aria-label="新名称"
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
              autoFocus
              maxLength={255}
              disabled={renamePending}
            />
            {renameError ? (
              <p className="text-ui text-destructive">重命名失败：{renameError}</p>
            ) : null}
            <DialogFooter className="gap-2 sm:space-x-0">
              <Button
                type="button"
                variant="outline"
                onClick={() => setRenameTarget(null)}
                disabled={renamePending}
              >
                取消
              </Button>
              <Button type="submit" disabled={renamePending || !renameValue.trim()}>
                {renamePending ? "保存中…" : "保存"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
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
  canRename,
  onRename,
  newKeys,
  rootDir,
  selection,
}: {
  node: TreeNode;
  depth: number;
  collapsed: Set<string>;
  onToggle: (path: string) => void;
  scope: PreviewScope;
  sessionKey: string | null;
  activePath: string | null;
  canDelete: boolean;
  onDelete: (files: DeliveredFile[], isDir?: boolean) => void;
  canRename: boolean;
  onRename: (file: DeliveredFile, isDir?: boolean) => void;
  /** Paths that arrived after the baseline inventory and are not yet
   *  previewed — file rows get a leading "new" dot. */
  newKeys: Set<string>;
  /** Absolute path of the panel root; directory rows resolve their own
   *  absolute path against it for the context menu. */
  rootDir: string | null;
  selection: FileSelection;
}) {
  const openPreview = useFilePreviewStore((s) => s.open);
  const indent = 8 + depth * 14;
  // Hook must run unconditionally before any early return (Rules of Hooks).
  const fileName = node.isDir ? "" : (node.file?.name ?? "");
  const fileIconUrl = useFileIconUrl(fileName);

  if (node.isDir) {
    const isCollapsed = collapsed.has(node.path);
    const childCount = node.children?.length ?? 0;
    const dirButton = (
      <Button
        type="button"
        variant="ghost"
        onClick={() => onToggle(node.path)}
        className={cn(
          "h-auto w-full justify-start gap-1 rounded-sm py-1 pr-2 text-left font-normal",
          "text-foreground/90 hover:bg-muted/60 hover:text-foreground",
        )}
        style={{ paddingLeft: indent }}
      >
        {isCollapsed ? (
          <Folder className="h-4 w-4 shrink-0 text-amber-500" />
        ) : (
          <FolderOpen className="h-4 w-4 shrink-0 text-amber-500" />
        )}
        <span className="min-w-0 truncate font-medium">{node.name}</span>
        <span className="shrink-0 text-micro text-muted-foreground">
          {childCount}
        </span>
      </Button>
    );

    // Directory rows resolve their absolute path against the panel root so
    // the context menu can open / trash the whole folder.
    const dirAbsPath = rootDir
      ? `${rootDir.replace(/\\/g, "/").replace(/\/+$/, "")}/${node.path}`
      : null;
    const dirPseudoFile: DeliveredFile = {
      path: node.path,
      absolute_path: dirAbsPath ?? node.path,
      name: node.name,
      size: 0,
      size_human: "",
      mime: "",
    };
    const handleOpenDir = () => {
      if (isTauri() && dirAbsPath) void openPathWithSystemApp(dirAbsPath);
    };
    const handleDeleteDir = () => onDelete([dirPseudoFile], true);

    return (
      <li>
        {isTauri() && dirAbsPath ? (
          <ContextMenu>
            <ContextMenuTrigger asChild>{dirButton}</ContextMenuTrigger>
            <ContextMenuContent className="w-48">
              <ContextMenuItem onClick={handleOpenDir}>
                在系统资源管理器中打开
              </ContextMenuItem>
              {canDelete && (
                <>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    onClick={handleDeleteDir}
                    className="text-destructive focus:text-destructive"
                  >
                    删除
                  </ContextMenuItem>
                </>
              )}
            </ContextMenuContent>
          </ContextMenu>
        ) : (
          dirButton
        )}
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
                canRename={canRename}
                onRename={onRename}
                newKeys={newKeys}
                rootDir={rootDir}
                selection={selection}
              />
            ))}
          </ul>
        )}
      </li>
    );
  }

  const file = node.file!;
  const isPreviewing = activePath === file.absolute_path;
  const isSelected = selection.selectedKeys.has(fileKey(file));
  const contextFiles = isSelected && selection.selectedFiles.length > 0
    ? selection.selectedFiles
    : [file];
  const isMultiple = contextFiles.length > 1;
  const isNew = newKeys.has(fileKey(file));

  const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    selection.onSelect(file, event);
  };
  const handleDoubleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (file.missing) return;
    selection.onSelect(file, event);
    openPreview(file, scope, sessionKey);
  };
  const handleOpenWithSystem = () => {
    if (isTauri()) {
      for (const selectedFile of contextFiles) {
        void openPathWithSystemApp(selectedFile.absolute_path);
      }
    }
  };
  const handleRevealInDir = () => {
    if (file.missing) return;
    if (isTauri()) void revealItemInDir(file.absolute_path);
  };
  const handleDelete = () => {
    selection.onDelete(contextFiles);
  };
  const handleRename = () => {
    if (file.missing) return;
    onRename(file);
  };

  const row = (
    <li>
      <Button
        type="button"
        variant="ghost"
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onContextMenu={() => selection.onContextMenu(file)}
        aria-pressed={isSelected}
        disabled={file.missing}
        className={cn(
          "relative h-auto w-full justify-start gap-1.5 rounded-sm py-1 pr-2 text-left font-normal",
          "hover:bg-muted/60 hover:text-foreground",
          file.missing && "cursor-default opacity-60",
          isSelected && "bg-muted/70 text-foreground hover:bg-muted/70",
          isPreviewing && "before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-[hsl(var(--brand-red))]",
        )}
        style={{ paddingLeft: depth === 0 ? indent : indent + 18 }}
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
            (isSelected || isPreviewing) && "text-foreground",
          )}
        >
          {file.name}
        </span>
        {file.missing ? (
          <span className="shrink-0 text-micro text-muted-foreground">
            文件已移除
          </span>
        ) : file.size_human ? (
          <span className="shrink-0 text-micro text-muted-foreground">
            {file.size_human}
          </span>
        ) : null}
      </Button>
    </li>
  );

  if (!isTauri()) {
    return row;
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuItem
          onClick={handleOpenWithSystem}
          disabled={file.missing}
        >
          {isMultiple ? `用系统程序打开 ${contextFiles.length} 个文件` : "用系统程序打开"}
        </ContextMenuItem>
        {!isMultiple && <ContextMenuItem onClick={handleRevealInDir} disabled={file.missing}>
          打开所在目录
        </ContextMenuItem>}
        {canRename && !file.missing && !isMultiple && (
          <ContextMenuItem onClick={handleRename}>
            重命名
          </ContextMenuItem>
        )}
        {canDelete && !file.missing && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem
              onClick={handleDelete}
              disabled={file.missing}
              className="text-destructive focus:text-destructive"
            >
              {isMultiple ? `删除 ${contextFiles.length} 个文件` : "删除"}
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
