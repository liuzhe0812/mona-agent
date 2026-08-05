/**
 * MaterialsView — 资料库视图（拆分为 sidebar + preview）。
 *
 * 由 NotesView 组装布局：
 * - MaterialsSidebar：顶部 toolbar + 双分组列表（原始资料 / AI 整理）
 * - MaterialsPreview：根据选中项渲染文本预览或 Wiki markdown
 *
 * 所有路径限制在 `<vault>/.mona/materials/` 内，由后端做 canonical 校验。
 */

import { useCallback, useEffect, useMemo, useRef, useState, forwardRef, useImperativeHandle } from "react";
import {
  ChevronRight,
  FileText,
  FolderInput,
  FolderPlus,
  Folder,
  Loader2,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  Upload,
  ExternalLink,
  X,
} from "lucide-react";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
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
import { cn } from "@/lib/utils";
import { OfficePreview, isOfficePreviewable } from "@/components/common/OfficePreview";
import { PromptDialog, ConfirmDialog } from "../NotesDialogs";
import { getServicesHttpBase } from "@/lib/api";
import {
  httpFetch,
  isTauri,
  materialsImportFiles,
  materialsEnsureInitialized,
  revealItemInDir,
} from "@/lib/tauri";
import { getFileTypeIcon } from "@/components/terminal/ipc";
import {
  createMaterialsDirectory,
  deleteMaterialsFile,
  deleteWikiPage,
  extractMaterialsText,
  getMaterialsStatus,
  getMaterialsText,
  getMaterialsRawFile,
  getWikiPage,
  getWikiCompileStatus,
  cancelWikiCompile,
  listMaterialsFiles,
  listWikiPages,
  moveMaterialsFile,
  reconcileMaterials,
  searchMaterials,
  startWikiCompile,
  type MaterialsExtractStatus,
  type MaterialsFileEntry,
  type MaterialsSearchResult,
  type WikiCompileStatus,
  type WikiPageSummary,
} from "@/lib/materials-api";
import MarkdownTextRenderer from "@/components/MarkdownTextRenderer";
import { useMaterialsOpenStore } from "@/lib/materials-open-store";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MaterialsSelection =
  | { kind: "raw"; path: string }
  | { kind: "wiki"; path: string }
  | null;

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

function rawPathToTextPath(rawRel: string): string {
  const stripped = rawRel.replace(/^raw\//, "");
  return `text/${stripped}.md`;
}

// ---------------------------------------------------------------------------
// 递归文件树节点
// ---------------------------------------------------------------------------

interface TreeNode {
  entry: MaterialsFileEntry;
  children: TreeNode[];
  loaded: boolean;
  expanded: boolean;
}

function buildTree(entries: MaterialsFileEntry[]): TreeNode[] {
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

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

/** Imperative handle exposed by MaterialsSidebar to the parent (tab bar buttons). */
export interface MaterialsSidebarHandle {
  upload: () => void;
  createFolder: () => void;
  compile: () => void;
}

interface MaterialsSidebarProps {
  selection: MaterialsSelection;
  onSelect: (sel: MaterialsSelection) => void;
  /** Reports busy/compiling state so the parent can disable tab bar buttons. */
  onStateChange?: (state: { busy: boolean; compiling: boolean }) => void;
}

export const MaterialsSidebar = forwardRef<MaterialsSidebarHandle, MaterialsSidebarProps>(
  function MaterialsSidebar({ selection, onSelect, onStateChange }, ref) {
  const [initialized, setInitialized] = useState(false);

  const [tree, setTree] = useState<TreeNode[]>([]);
  const [rawLoading, setRawLoading] = useState(false);
  const [wikiPages, setWikiPages] = useState<WikiPageSummary[]>([]);
  const [wikiLoading, setWikiLoading] = useState(false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [compiling, setCompiling] = useState(false);
  const [compileTask, setCompileTask] = useState<WikiCompileStatus | null>(null);
  const compileTaskIdRef = useRef<string | null>(null);

  // 资料搜索：非空 query 时以搜索结果替换下方双分组列表
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<MaterialsSearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);

  const [rawCollapsed, setRawCollapsed] = useState(false);
  const [wikiCollapsed, setWikiCollapsed] = useState(false);
  const [wikiGroupCollapsed, setWikiGroupCollapsed] = useState<Set<string>>(new Set());
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());

  // raw 根目录绝对路径，用于"打开文件路径"功能
  const [rawRoot, setRawRoot] = useState<string | null>(null);
  // 刷新信号：递增后通知所有已展开的 TreeRow 重新加载子目录内容
  const [refreshTick, setRefreshTick] = useState(0);

  // 自定义弹窗：新建文件夹 / 删除确认 / 移动到
  const [folderPrompt, setFolderPrompt] = useState<{ open: boolean; parentDir: string }>(
    { open: false, parentDir: "" },
  );
  const [deleteConfirm, setDeleteConfirm] = useState<{
    open: boolean;
    kind: "raw" | "wiki";
    path: string;
  }>({ open: false, kind: "raw", path: "" });
  const [moveTarget, setMoveTarget] = useState<{ open: boolean; srcPath: string }>(
    { open: false, srcPath: "" },
  );

  const init = useCallback(async () => {
    if (!isTauri()) return;
    try {
      await materialsEnsureInitialized();
      setInitialized(true);
    } catch (err) {
      console.error("[materials] init failed:", err);
    }
  }, []);

  useEffect(() => {
    void init();
  }, [init]);

  const refreshRaw = useCallback(async () => {
    setRawLoading(true);
    try {
      // 先做轻量对账（补缺/清理孤儿/同步索引），再拉取最新列表
      await reconcileMaterials().catch(() => undefined);
      const entries = await listMaterialsFiles();
      setTree(buildTree(entries));
      // 异步获取 raw 根目录绝对路径（用于"打开文件路径"）
      if (rawRoot === null) {
        try {
          const status = await getMaterialsStatus();
          if (status.rawRoot) setRawRoot(status.rawRoot);
        } catch {
          // 静默失败，不影响列表加载
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRawLoading(false);
      // 通知已展开的子目录重新加载（解决移动/删除后子目录缓存不刷新）
      setRefreshTick((t) => t + 1);
    }
  }, [rawRoot]);

  const refreshWiki = useCallback(async () => {
    setWikiLoading(true);
    try {
      const data = await listWikiPages();
      setWikiPages(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWikiLoading(false);
    }
  }, []);

  const refreshAll = useCallback(async () => {
    setError(null);
    await Promise.all([refreshRaw(), refreshWiki()]);
  }, [refreshRaw, refreshWiki]);

  useEffect(() => {
    if (initialized) void refreshAll();
  }, [initialized, refreshAll]);

  // Report busy/compiling state to parent so tab bar buttons can disable.
  useEffect(() => {
    onStateChange?.({ busy, compiling });
  }, [busy, compiling, onStateChange]);

  const handleUpload = useCallback(
    async (targetDir: string) => {
      if (!isTauri()) return;
      try {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const selected = await open({
          multiple: true,
          filters: [
            {
              name: "文档",
              extensions: ["pdf", "docx", "xlsx", "pptx", "txt", "md", "csv", "json", "html"],
            },
          ],
        });
        if (!selected) return;
        const paths = Array.isArray(selected) ? selected : [selected];
        setBusy(true);
        const imported = await materialsImportFiles(paths, targetDir);
        // 上传后立即触发后台文本提取，避免 extractStatus 永远为 pending
        // 对每个导入的文件单独触发提取（extract API 接受相对 raw/ 的路径）
        for (const entry of imported) {
          if (entry.kind === "file") {
            const rawRel = entry.path.replace(/^raw\//, "");
            try {
              await extractMaterialsText(rawRel);
            } catch (extractErr) {
              console.warn(`[materials] extract trigger failed for ${rawRel}:`, extractErr);
            }
          }
        }
        await refreshRaw();
        // 提取是异步的，延迟再刷新一次让状态更新
        setTimeout(() => void refreshRaw(), 2000);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [refreshRaw],
  );

  const handleCreateFolder = useCallback((parentDir: string) => {
    setFolderPrompt({ open: true, parentDir });
  }, []);

  const submitCreateFolder = useCallback(
    async (name: string) => {
      const parentDir = folderPrompt.parentDir;
      try {
        const rel = parentDir ? `${parentDir}/${name}` : name;
        await createMaterialsDirectory(rel);
        await refreshRaw();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [folderPrompt.parentDir, refreshRaw],
  );

  const handleDeleteRaw = useCallback((path: string) => {
    setDeleteConfirm({ open: true, kind: "raw", path });
  }, []);

  const handleDeleteWiki = useCallback((path: string) => {
    setDeleteConfirm({ open: true, kind: "wiki", path });
  }, []);

  const submitDelete = useCallback(async () => {
    const { kind, path } = deleteConfirm;
    try {
      if (kind === "raw") {
        await deleteMaterialsFile(path.replace(/^raw\//, ""));
        if (selection?.kind === "raw" && selection.path === path) {
          onSelect(null);
        }
        await refreshRaw();
      } else {
        await deleteWikiPage(path);
        if (selection?.kind === "wiki" && selection.path === path) {
          onSelect(null);
        }
        await refreshWiki();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [deleteConfirm, selection, onSelect, refreshRaw, refreshWiki]);

  const handleExtract = useCallback(async (path: string) => {
    try {
      await extractMaterialsText(path.replace(/^raw\//, ""));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const handleMove = useCallback((srcPath: string) => {
    setMoveTarget({ open: true, srcPath });
  }, []);

  const submitMove = useCallback(
    async (targetDir: string) => {
      try {
        await moveMaterialsFile(moveTarget.srcPath.replace(/^raw\//, ""), targetDir);
        await refreshRaw();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [moveTarget.srcPath, refreshRaw],
  );

  // 拖拽移动：把 srcPath 拖到 targetDir 目录（相对 raw/ 的目录路径，空字符串表示根目录）
  const handleDragDrop = useCallback(
    async (srcPath: string, targetDirRaw: string) => {
      const srcRel = srcPath.replace(/^raw\//, "");
      const tgtRel = targetDirRaw.replace(/^raw\//, "");
      if (!tgtRel) {
        // 拖到根目录：src 本身就在根目录（无 /）则无需移动
        if (!srcRel.includes("/")) return;
      } else {
        // 不允许拖到自身
        if (srcRel === tgtRel) return;
        // 不允许拖到自己的子目录
        if (tgtRel.startsWith(srcRel + "/")) return;
        // 同父目录则忽略
        const srcParent = srcRel.includes("/")
          ? srcRel.substring(0, srcRel.lastIndexOf("/"))
          : "";
        if (srcParent === tgtRel) return;
      }
      try {
        await moveMaterialsFile(srcRel, tgtRel);
        await refreshRaw();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [refreshRaw],
  );

  // 在系统资源管理器中定位文件（revealItemInDir 无路径白名单限制）
  const handleOpenLocation = useCallback(
    (rawPath: string) => {
      if (!rawRoot) return;
      const rel = rawPath.replace(/^raw\//, "");
      const abs = `${rawRoot}/${rel}`.replace(/\//g, "\\");
      void revealItemInDir(abs);
    },
    [rawRoot],
  );

  // 后端编译：启动任务后轮询进度，支持取消。
  // paths 相对 raw/，可为文件或目录（目录由后端递归展开）。
  const runCompile = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) {
        setError("没有可编译的资料。请先上传文件。");
        return;
      }
      setCompiling(true);
      setCompileTask(null);
      setError(null);
      try {
        const { taskId } = await startWikiCompile(paths);
        compileTaskIdRef.current = taskId;
        for (;;) {
          const status = await getWikiCompileStatus(taskId);
          setCompileTask(status);
          if (status.state !== "running") {
            if (status.errors.length > 0 && status.state !== "cancelled") {
              setError(
                `编译完成，但有 ${status.errors.length} 个错误：\n${status.errors.slice(0, 3).join("\n")}${status.errors.length > 3 ? `\n…（共 ${status.errors.length} 个）` : ""}`,
              );
            }
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        compileTaskIdRef.current = null;
        setCompiling(false);
        setCompileTask(null);
        await refreshWiki();
      }
    },
    [refreshWiki],
  );

  const handleCompile = useCallback(async () => {
    try {
      const entries = await listMaterialsFiles();
      // 传根目录全部条目（含目录），后端递归展开，修复旧流程只编译根目录文件的问题
      const paths = entries.map((e) => e.path.replace(/^raw\//, "")).filter(Boolean);
      await runCompile(paths);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [runCompile]);

  const handleCancelCompile = useCallback(async () => {
    const taskId = compileTaskIdRef.current;
    if (!taskId) return;
    try {
      await cancelWikiCompile(taskId);
    } catch {
      // 任务可能刚好结束，忽略
    }
  }, []);

  // Expose imperative handlers for the parent (tab bar buttons).
  useImperativeHandle(ref, () => ({
    upload: () => void handleUpload(""),
    createFolder: () => handleCreateFolder(""),
    compile: () => void handleCompile(),
  }), [handleUpload, handleCreateFolder, handleCompile]);

  // 资料搜索：防抖 300ms，空 query 退出搜索模式
  useEffect(() => {
    const q = searchQuery.trim();
    if (!q) {
      setSearchResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = window.setTimeout(() => {
      searchMaterials({ query: q, count: 30 })
        .then((results) => setSearchResults(results))
        .catch((err) => {
          setError(err instanceof Error ? err.message : String(err));
          setSearchResults([]);
        })
        .finally(() => setSearching(false));
    }, 300);
    return () => window.clearTimeout(timer);
  }, [searchQuery]);

  const handleSearchResultClick = useCallback(
    (result: MaterialsSearchResult) => {
      if (result.kind === "material_wiki") {
        onSelect({ kind: "wiki", path: result.path });
      } else {
        // text/ 下的提取文件形如 docs/foo.pdf.md → 还原为 raw/docs/foo.pdf
        const rawRel = result.path.replace(/\.md$/, "");
        onSelect({ kind: "raw", path: `raw/${rawRel}` });
      }
    },
    [onSelect],
  );

  // Wiki 页面按顶层目录分组（sources/entities/concepts/...），根级页面归入 "" 组
  const wikiGroups = useMemo(() => {
    const groups = new Map<string, WikiPageSummary[]>();
    for (const page of wikiPages) {
      const dir = page.path.includes("/") ? page.path.split("/")[0] : "";
      const list = groups.get(dir) ?? [];
      list.push(page);
      groups.set(dir, list);
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [wikiPages]);

  const toggleWikiGroup = useCallback((dir: string) => {
    setWikiGroupCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) {
        next.delete(dir);
      } else {
        next.add(dir);
      }
      return next;
    });
  }, []);

  const toggleExpand = useCallback((path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  if (!initialized) {
    return (
      <div className="flex flex-1 items-center justify-center text-[13px] text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        正在初始化资料库...
      </div>
    );
  }

  return (
    <>
      {error ? (
        <div className="whitespace-pre-wrap px-3 py-1.5 text-[11.5px] text-destructive">
          {error}
        </div>
      ) : null}

      {/* 资料搜索框 */}
      <div className="relative px-2 pb-1">
        <Search className="pointer-events-none absolute left-4 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setSearchQuery("");
          }}
          placeholder="搜索资料正文和 Wiki..."
          className="pl-7 pr-7 text-[12px]"
        />
        {searchQuery ? (
          <button
            type="button"
            aria-label="清除搜索"
            onClick={() => setSearchQuery("")}
            className="absolute right-3.5 top-1/2 grid h-4 w-4 -translate-y-1/2 place-items-center rounded text-muted-foreground hover:text-foreground"
          >
            <X className="h-3 w-3" />
          </button>
        ) : null}
      </div>

      {compiling && compileTask ? (
        <div className="border-b border-border/70 px-3 py-1.5 text-[11.5px] text-muted-foreground">
          <div className="flex items-center gap-1.5">
            <Loader2 className="h-3 w-3 animate-spin" />
            <span className="min-w-0 flex-1 truncate">
              {compileTask.currentFile || "处理中..."}
            </span>
            <button
              type="button"
              onClick={handleCancelCompile}
              className="shrink-0 rounded px-1 py-0.5 text-[10.5px] text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              取消
            </button>
          </div>
          <div className="mt-0.5 text-[10.5px]">
            已完成 {compileTask.completedFiles} / {compileTask.totalFiles} · 生成{" "}
            {compileTask.pagesWritten} 页
          </div>
        </div>
      ) : null}

      {/* 列表区：搜索模式 / 双分组模式 */}
      <div className="min-h-0 flex-1 overflow-y-auto py-1 scrollbar-thin">
        {searchResults !== null ? (
          searching ? (
            <div className="px-3 py-3 text-center text-[11.5px] text-muted-foreground">
              搜索中...
            </div>
          ) : searchResults.length === 0 ? (
            <div className="px-3 py-3 text-center text-[11.5px] text-muted-foreground">
              没有匹配的结果
            </div>
          ) : (
            searchResults.map((r, i) => (
              <button
                key={`${r.kind}:${r.path}:${i}`}
                type="button"
                onClick={() => handleSearchResultClick(r)}
                className="flex w-full flex-col gap-0.5 px-3 py-1.5 text-left hover:bg-accent"
              >
                <div className="flex items-center gap-1.5">
                  <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-[12.5px]">{r.title}</span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {r.kind === "material_wiki" ? "Wiki" : "原文"}
                  </span>
                </div>
                {r.snippet ? (
                  <div className="line-clamp-2 pl-5 text-[11px] text-muted-foreground">
                    {r.snippet}
                  </div>
                ) : null}
              </button>
            ))
          )
        ) : (
        <>
        {/* 原始资料分组（整个区域作为根目录 drop target） */}
        <div
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
          }}
          onDrop={(e) => {
            e.preventDefault();
            const srcPath = e.dataTransfer.getData("text/plain");
            if (!srcPath) return;
            // 拖到非子目录行（GroupHeader、文件行、空白）= 拖到根目录
            handleDragDrop(srcPath, "");
          }}
        >
          <GroupHeader
            label="原始资料"
            collapsed={rawCollapsed}
            onToggle={() => setRawCollapsed((v) => !v)}
          />
          {!rawCollapsed ? (
            tree.length === 0 && !rawLoading ? (
              <div className="px-3 py-3 text-center text-[11.5px] text-muted-foreground">
                还没有资料。点击上方上传按钮添加文件。
              </div>
            ) : (
              tree.map((node) => (
                <TreeRow
                  key={node.entry.path}
                  node={node}
                  depth={0}
                  selection={selection}
                  expandedPaths={expandedPaths}
                  onSelectRaw={(path) => onSelect({ kind: "raw", path })}
                  onToggleExpand={toggleExpand}
                  onUpload={handleUpload}
                  onCreateFolder={handleCreateFolder}
                  onDelete={handleDeleteRaw}
                  onMove={handleMove}
                  onExtract={handleExtract}
                  onCompile={(path) => void runCompile([path.replace(/^raw\//, "")])}
                  onDragDrop={handleDragDrop}
                  onOpenLocation={handleOpenLocation}
                  refreshTick={refreshTick}
                  loadChildren={async (path) => {
                    try {
                      const rel = path.replace(/^raw\//, "");
                      const entries = await listMaterialsFiles(rel);
                      return buildTree(entries);
                    } catch {
                      return [];
                    }
                  }}
                />
              ))
            )
          ) : null}
        </div>

        {/* AI 整理分组（按顶层目录再分组） */}
        <GroupHeader
          label="AI 整理"
          collapsed={wikiCollapsed}
          onToggle={() => setWikiCollapsed((v) => !v)}
        />
        {!wikiCollapsed ? (
          wikiPages.length === 0 && !wikiLoading ? (
            <div className="px-3 py-3 text-center text-[11.5px] text-muted-foreground">
              还没有 AI 整理页面。
            </div>
          ) : (
            wikiGroups.map(([dir, pages]) => (
              <div key={dir || "_root"}>
                {dir ? (
                  <button
                    type="button"
                    onClick={() => toggleWikiGroup(dir)}
                    className="flex w-full items-center gap-1 px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
                  >
                    <ChevronRight
                      className={cn(
                        "h-3 w-3 transition-transform",
                        !wikiGroupCollapsed.has(dir) && "rotate-90",
                      )}
                    />
                    <span>{dir}</span>
                    <span className="text-[10px]">{pages.length}</span>
                  </button>
                ) : null}
                {!dir || !wikiGroupCollapsed.has(dir)
                  ? pages.map((page) => (
                      <WikiRow
                        key={page.path}
                        page={page}
                        selected={selection?.kind === "wiki" && selection.path === page.path}
                        onSelect={() => onSelect({ kind: "wiki", path: page.path })}
                        onDelete={() => handleDeleteWiki(page.path)}
                      />
                    ))
                  : null}
              </div>
            ))
          )
        ) : null}
        </>
        )}
      </div>

      {/* 新建文件夹 */}
      <PromptDialog
        open={folderPrompt.open}
        title={folderPrompt.parentDir ? "新建子文件夹" : "新建文件夹"}
        placeholder="输入文件夹名称"
        onConfirm={submitCreateFolder}
        onOpenChange={(open) => setFolderPrompt((prev) => ({ ...prev, open }))}
      />

      {/* 删除确认 */}
      <ConfirmDialog
        open={deleteConfirm.open}
        title={deleteConfirm.kind === "raw" ? "删除资料" : "删除 Wiki 页面"}
        message={
          deleteConfirm.kind === "raw"
            ? `确认删除 ${deleteConfirm.path.replace(/^raw\//, "")}？`
            : `确认删除 Wiki 页面 ${deleteConfirm.path}？`
        }
        destructive
        onConfirm={submitDelete}
        onOpenChange={(open) => setDeleteConfirm((prev) => ({ ...prev, open }))}
      />

      {/* 移动到 */}
      <MoveTargetDialog
        open={moveTarget.open}
        srcPath={moveTarget.srcPath}
        onConfirm={submitMove}
        onOpenChange={(open) => setMoveTarget((prev) => ({ ...prev, open }))}
      />
    </>
  );
  },
);

// ---------------------------------------------------------------------------
// 小组件
// ---------------------------------------------------------------------------

function GroupHeader({
  label,
  collapsed,
  onToggle,
}: {
  label: string;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full items-center gap-1 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground"
    >
      <ChevronRight
        className={cn("h-3 w-3 transition-transform", !collapsed && "rotate-90")}
      />
      <span>{label}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// 递归树行
// ---------------------------------------------------------------------------

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

function TreeRow(props: TreeRowProps) {
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

// ---------------------------------------------------------------------------
// Wiki 行
// ---------------------------------------------------------------------------

function WikiRow({
  page,
  selected,
  onSelect,
  onDelete,
}: {
  page: WikiPageSummary;
  selected: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const sources = page.sources ?? [];
  const sourceLabel =
    sources.length === 0
      ? null
      : sources.length === 1
        ? (sources[0].split("/").pop() ?? sources[0])
        : `${sources.length} 份来源`;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="button"
          tabIndex={0}
          onClick={onSelect}
          className={cn(
            "flex cursor-default items-center gap-1 px-3 py-[3px] text-[13px] outline-none",
            "hover:bg-accent",
            selected && "bg-accent text-foreground",
          )}
        >
          <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">{page.title}</span>
          {page.stale ? (
            <span className="shrink-0 text-[10px] text-amber-600">已过期</span>
          ) : null}
          {sourceLabel ? (
            <span className="max-w-[90px] shrink-0 truncate text-[10px] text-muted-foreground">
              {sourceLabel}
            </span>
          ) : null}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          className="text-destructive focus:text-destructive"
          onClick={onDelete}
        >
          <Trash2 className="mr-2 h-3.5 w-3.5" />
          删除
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

interface MaterialsPreviewProps {
  selection: MaterialsSelection;
}

export function MaterialsPreview({ selection }: MaterialsPreviewProps) {
  if (!selection) {
    return (
      <div className="flex flex-1 items-center justify-center text-[13px] text-muted-foreground">
        选择左侧的资料或 Wiki 页面查看内容
      </div>
    );
  }
  return selection.kind === "raw" ? (
    <RawPreview path={selection.path} />
  ) : (
    <WikiPreview path={selection.path} />
  );
}

// 可直接读取原文预览的扩展名
const DIRECT_PREVIEW_EXTS = new Set(["md", "markdown", "html", "htm", "txt", "csv", "json", "xml", "yaml", "yml", "log", "py", "js", "ts", "css", "sh", "toml"]);

function getExt(path: string): string {
  return path.split(".").pop()?.toLowerCase() ?? "";
}

function RawPreview({ path }: { path: string }) {
  const rawRel = path.replace(/^raw\//, "");
  const ext = getExt(rawRel);
  const isOffice = isOfficePreviewable(rawRel);
  const isDirect = DIRECT_PREVIEW_EXTS.has(ext);

  // 引用跳转带位置时强制走文本预览（提取文本含 seg 标题，可滚动定位），
  // 否则 Office 原文预览无法定位到 Page/Sheet。
  // 位置标签捕获到本地 state 后立即清除全局 pending：避免已消费的请求
  // 残留导致用户之后手动选中同一文件时仍被强制文本预览。
  const pending = useMaterialsOpenStore((s) => s.pending);
  const [captured, setCaptured] = useState<{ nonce: number; location: string } | null>(null);

  useEffect(() => {
    if (!pending || pending.kind !== "raw" || pending.path !== path) return;
    if (pending.location) {
      setCaptured({ nonce: pending.nonce, location: pending.location });
    }
    useMaterialsOpenStore.getState().clear();
  }, [pending, path]);

  // 切换文件后丢弃旧的捕获位置
  useEffect(() => {
    setCaptured(null);
  }, [path]);

  const forceText = captured !== null;

  // Office 文档用 jit-viewer 预览
  if (isOffice && !forceText) {
    return <OfficeRawPreview path={path} />;
  }

  return (
    <TextRawPreview
      path={path}
      rawRel={rawRel}
      ext={ext}
      isDirect={isDirect && !forceText}
      scrollToLabel={captured?.location}
      scrollNonce={captured?.nonce}
    />
  );
}

function OfficeRawPreview({ path }: { path: string }) {
  const rawRel = path.replace(/^raw\//, "");
  const fetchBuffer = useCallback(async () => {
    const base = await getServicesHttpBase();
    // 必须走 httpFetch（Tauri 本地桥）：裸 fetch 不会附带 X-Mona-Token，会 401
    const resp = await httpFetch(`${base}/api/materials/raw-binary/${encodeURIComponent(rawRel)}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.arrayBuffer();
  }, [rawRel]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/70 px-3">
        <FileText className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="truncate text-[13px]">{rawRel}</span>
      </div>
      <OfficePreview filename={rawRel} fetchBuffer={fetchBuffer} />
    </div>
  );
}

function TextRawPreview({
  path,
  rawRel,
  ext,
  isDirect,
  scrollToLabel,
  scrollNonce,
}: {
  path: string;
  rawRel: string;
  ext: string;
  isDirect: boolean;
  scrollToLabel?: string;
  scrollNonce?: number;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [previewMode, setPreviewMode] = useState<"text" | "markdown" | "html">("text");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const anchorRef = useRef<HTMLSpanElement | null>(null);

  // 引用定位：提取文本中 seg 标题形如 "## Page 12"，按行精确匹配后拆分内容，
  // 在目标行处插入锚点 <span>，渲染完成后 scrollIntoView。
  const split = useMemo(() => {
    if (!scrollToLabel || !content) return null;
    const heading = `## ${scrollToLabel}`.trim().toLowerCase();
    const lines = content.split("\n");
    const idx = lines.findIndex((l) => l.trim().toLowerCase() === heading);
    if (idx < 0) return null;
    return {
      before: lines.slice(0, idx).join("\n") + "\n",
      after: lines.slice(idx).join("\n"),
    };
  }, [content, scrollToLabel]);

  useEffect(() => {
    if (!split || !anchorRef.current) return;
    anchorRef.current.scrollIntoView({ block: "start" });
  }, [split, scrollNonce]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setContent(null);
    setPreviewMode("text");
    (async () => {
      try {
        if (isDirect) {
          // md/html/txt 等文本格式：直接读取 raw 原文
          const data = await getMaterialsRawFile(rawRel);
          if (cancelled) return;
          setContent(data.content);
          if (ext === "md" || ext === "markdown") {
            setPreviewMode("markdown");
          } else if (ext === "html" || ext === "htm") {
            setPreviewMode("html");
          } else {
            setPreviewMode("text");
          }
        } else {
          // pdf/docx/xlsx/pptx 等：读取提取后的文本
          const textPath = rawPathToTextPath(path);
          const data = await getMaterialsText(textPath);
          if (cancelled) return;
          // 去掉 frontmatter
          let text = data.content;
          if (text.startsWith("---")) {
            const end = text.indexOf("---", 3);
            if (end !== -1) text = text.slice(end + 3).trimStart();
          }
          setContent(text);
          setPreviewMode("text");
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path, rawRel, ext, isDirect]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/70 px-3">
        <FileText className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="truncate text-[13px]">{rawRel}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4 scrollbar-hover">
        {loading ? (
          <div className="flex items-center text-[13px] text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            正在读取...
          </div>
        ) : error ? (
          <div className="text-[13px] text-muted-foreground">
            {isDirect
              ? "无法读取文件内容。"
              : "暂无可读正文。可能原因：文件尚未提取、格式不支持或提取失败。"}
            <div className="mt-1 text-[12px] text-destructive">{error}</div>
          </div>
        ) : previewMode === "markdown" ? (
          <MarkdownTextRenderer>{content ?? ""}</MarkdownTextRenderer>
        ) : previewMode === "html" ? (
          <iframe
            srcDoc={content ?? ""}
            title={rawRel}
            // 用户上传的 HTML 属不可信内容：空 sandbox 禁用脚本且强制独立源，
            // 禁止 allow-scripts 与 allow-same-origin 组合（P0-1 / ui-spec）。
            sandbox=""
            className="h-full min-h-[400px] w-full border-0"
          />
        ) : (
          <pre className="whitespace-pre-wrap break-words font-mono text-[12.5px] leading-relaxed">
            {split ? (
              <>
                {split.before}
                <span ref={anchorRef} className="block h-0 scroll-mt-2" />
                {split.after}
              </>
            ) : (
              content ?? ""
            )}
          </pre>
        )}
      </div>
    </div>
  );
}

function WikiPreview({ path }: { path: string }) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // 引用跳转（wiki）：捕获位置标签后立即清除全局 pending，
  // 渲染完成后在 markdown 标题中定位并滚动。
  const pending = useMaterialsOpenStore((s) => s.pending);
  const [captured, setCaptured] = useState<{ nonce: number; location: string } | null>(null);

  useEffect(() => {
    if (!pending || pending.kind !== "wiki" || pending.path !== path) return;
    if (pending.location) {
      setCaptured({ nonce: pending.nonce, location: pending.location });
    }
    useMaterialsOpenStore.getState().clear();
  }, [pending, path]);

  useEffect(() => {
    setCaptured(null);
  }, [path]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setContent(null);
    (async () => {
      try {
        const data = await getWikiPage(path);
        if (!cancelled) setContent(data.content);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path]);

  const body = useMemo(() => {
    if (!content) return "";
    if (content.startsWith("---")) {
      const end = content.indexOf("---", 3);
      if (end !== -1) return content.slice(end + 3).trimStart();
    }
    return content;
  }, [content]);

  useEffect(() => {
    if (!captured || !body || !containerRef.current) return;
    const label = captured.location.trim().toLowerCase();
    const headings = containerRef.current.querySelectorAll("h1, h2, h3, h4, h5, h6");
    for (const h of Array.from(headings)) {
      const text = h.textContent?.trim().toLowerCase() ?? "";
      if (text === label || text.includes(label)) {
        h.scrollIntoView({ block: "start" });
        return;
      }
    }
  }, [captured, body]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/70 px-3">
        <FileText className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="truncate text-[13px]">{path}</span>
      </div>
      <div
        ref={containerRef}
        className="min-h-0 flex-1 overflow-y-auto px-6 py-4 scrollbar-hover"
      >
        {loading ? (
          <div className="flex items-center text-[13px] text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            正在读取...
          </div>
        ) : error ? (
          <div className="text-[13px] text-destructive">{error}</div>
        ) : (
          <MarkdownTextRenderer>{body}</MarkdownTextRenderer>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 移动到对话框（目录选择 + 自定义路径输入）
// ---------------------------------------------------------------------------

interface MoveTargetDialogProps {
  open: boolean;
  srcPath: string;
  onConfirm: (targetDir: string) => void;
  onOpenChange: (open: boolean) => void;
}

function MoveTargetDialog({ open, srcPath, onConfirm, onOpenChange }: MoveTargetDialogProps) {
  const [dirs, setDirs] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string>("");
  const [customInput, setCustomInput] = useState("");

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setSelected("");
    setCustomInput("");
    listMaterialsFiles()
      .then((entries) => {
        const allDirs = entries
          .filter((e) => e.type === "directory")
          .map((e) => e.path.replace(/^raw\//, ""))
          .filter(Boolean)
          .sort((a, b) => a.localeCompare(b, "zh"));
        setDirs(allDirs);
      })
      .catch(() => setDirs([]))
      .finally(() => setLoading(false));
  }, [open]);

  const srcRel = srcPath.replace(/^raw\//, "");
  // 禁止把目录移到自身或其子目录
  const isDisabledTarget = (target: string): boolean => {
    if (!target) return false;
    if (target === srcRel) return true;
    if (target.startsWith(srcRel + "/")) return true;
    return false;
  };

  const target = customInput.trim() || selected;
  const buttonDisabled = target !== "" && isDisabledTarget(target);

  const handleConfirm = () => {
    onConfirm(target);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[400px] gap-0 rounded-xl border-border/70 p-0">
        <DialogHeader className="border-b border-border/65 px-4 py-3 text-left">
          <DialogTitle className="text-[14px]">移动到...</DialogTitle>
        </DialogHeader>
        <div className="px-4 py-3">
          <p className="mb-2 truncate text-[11.5px] text-muted-foreground">
            源：{srcRel || "(根目录)"}
          </p>
          <div className="max-h-[240px] overflow-y-auto rounded-md border border-border/50 scrollbar-thin">
            <button
              type="button"
              onClick={() => {
                setSelected("");
                setCustomInput("");
              }}
              disabled={isDisabledTarget("")}
              className={cn(
                "flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[12.5px]",
                selected === "" && !customInput
                  ? "bg-primary/10 text-primary"
                  : "hover:bg-accent",
                isDisabledTarget("") && "opacity-40",
              )}
            >
              <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="flex-1">资料库根目录</span>
            </button>
            {loading ? (
              <div className="px-2.5 py-2 text-[11.5px] text-muted-foreground">加载中...</div>
            ) : (
              dirs.map((d) => {
                const segments = d.split("/");
                const name = segments.pop() ?? d;
                const depth = segments.length;
                const disabled = isDisabledTarget(d);
                return (
                  <button
                    key={d}
                    type="button"
                    onClick={() => {
                      setSelected(d);
                      setCustomInput("");
                    }}
                    disabled={disabled}
                    style={{ paddingLeft: `${depth * 12 + 10}px` }}
                    className={cn(
                      "flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[12.5px]",
                      selected === d && !customInput
                        ? "bg-primary/10 text-primary"
                        : "hover:bg-accent",
                      disabled && "opacity-40",
                    )}
                  >
                    <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{name}</span>
                    <span className="shrink-0 text-[10px] text-muted-foreground truncate">
                      {d}
                    </span>
                  </button>
                );
              })
            )}
          </div>
          <div className="mt-2">
            <Input
              value={customInput}
              onChange={(e) => {
                setCustomInput(e.target.value);
                setSelected("");
              }}
              placeholder="或输入自定义路径（相对 raw/，留空表示根目录）"
              className="h-8 text-[12.5px]"
            />
          </div>
        </div>
        <DialogFooter className="border-t border-border/65 px-4 py-2.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2.5 text-[12px]"
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-7 px-2.5 text-[12px]"
            disabled={buttonDisabled}
            onClick={handleConfirm}
          >
            移动
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
