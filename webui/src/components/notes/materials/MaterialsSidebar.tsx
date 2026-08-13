/**
 * MaterialsSidebar — 资料库侧边栏：顶部 toolbar + 双分组列表（原始资料 / AI 整理）。
 */

import { useCallback, useEffect, useMemo, useRef, useState, forwardRef, useImperativeHandle } from "react";
import {
  ChevronRight,
  FileText,
  Folder,
  Loader2,
  Search,
  Trash2,
  X,
} from "lucide-react";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
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
import { PromptDialog, ConfirmDialog } from "../NotesDialogs";
import {
  isTauri,
  materialsImportFiles,
  materialsEnsureInitialized,
  revealItemInDir,
} from "@/lib/tauri";
import {
  createMaterialsDirectory,
  deleteMaterialsFile,
  deleteWikiPage,
  extractMaterialsText,
  getMaterialsStatus,
  getWikiCompileStatus,
  cancelWikiCompile,
  listMaterialsFiles,
  listWikiPages,
  moveMaterialsFile,
  reconcileMaterials,
  searchMaterials,
  startWikiCompile,
  type MaterialsSearchResult,
  type WikiCompileStatus,
  type WikiPageSummary,
} from "@/lib/materials-api";
import type {
  MaterialsSidebarHandle,
  MaterialsSidebarProps,
  TreeNode,
} from "./types";
import { buildTree, TreeRow } from "./materials-tree";
import { useMaterialsOpenStore } from "@/lib/materials-open-store";

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

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
        // 索引契约：source 结果的 path 已相对 raw/（如 docs/foo.pdf）
        const rawPath = `raw/${result.path}`;
        onSelect({ kind: "raw", path: rawPath });
        // 携带位置标签跳转：与 mona:material 引用跳转同一定位机制
        if (result.locationLabel) {
          useMaterialsOpenStore.getState().request({
            kind: "raw",
            path: rawPath,
            location: result.locationLabel,
          });
        }
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
      <div className="flex flex-1 items-center justify-center text-ui text-muted-foreground">
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
          className="pl-7 pr-7 text-caption"
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
                  <span className="min-w-0 flex-1 truncate text-caption">{r.title}</span>
                  {r.locationLabel ? (
                    <span className="shrink-0 rounded-md bg-accent px-1 py-px text-[10px] text-muted-foreground">
                      {r.locationLabel}
                    </span>
                  ) : null}
                  {r.stale ? (
                    <span className="shrink-0 text-[10px] text-amber-600">已过期</span>
                  ) : null}
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {r.kind === "material_wiki" ? "Wiki" : "原文"}
                  </span>
                </div>
                {r.snippet ? (
                  <div className="line-clamp-2 pl-5 text-micro text-muted-foreground">
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
                    className="flex w-full items-center gap-1 px-2 py-0.5 text-micro text-muted-foreground hover:text-foreground"
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
      className="flex w-full items-center gap-1 px-2 py-1 text-micro font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground"
    >
      <ChevronRight
        className={cn("h-3 w-3 transition-transform", !collapsed && "rotate-90")}
      />
      <span>{label}</span>
    </button>
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
          <DialogTitle className="text-body">移动到...</DialogTitle>
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
              className="h-8 text-caption"
            />
          </div>
        </div>
        <DialogFooter className="border-t border-border/65 px-4 py-2.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2.5 text-caption"
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-7 px-2.5 text-caption"
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
