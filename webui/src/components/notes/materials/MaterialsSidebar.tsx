/**
 * MaterialsSidebar — 资料库侧边栏：添加后自动处理，用户只管理资料文件。
 */

import { useCallback, useEffect, useState, forwardRef, useImperativeHandle } from "react";
import {
  BookOpen,
  ChevronRight,
  FileText,
  Folder,
  Loader2,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";

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
  createKnowledgeLibrary,
  cancelWikiCompile,
  deleteKnowledgeLibrary,
  deleteMaterialsFile,
  extractMaterialsText,
  getWikiCompileStatus,
  getMaterialsStatus,
  listKnowledgeLibraries,
  listMaterialsFiles,
  listWikiPages,
  moveMaterialsFile,
  reconcileMaterials,
  searchMaterials,
  startWikiCompile,
  type KnowledgeLibrary,
  type MaterialsSearchResult,
  type WikiCompileStatus,
  type WikiPageSummary,
  updateKnowledgeLibrary,
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
  const [libraries, setLibraries] = useState<KnowledgeLibrary[]>([]);
  const [knowledgeBaseId, setKnowledgeBaseId] = useState("kb-default");
  const [libraryPromptOpen, setLibraryPromptOpen] = useState(false);
  const [libraryRenameOpen, setLibraryRenameOpen] = useState(false);
  const [libraryDeleteOpen, setLibraryDeleteOpen] = useState(false);

  const [tree, setTree] = useState<TreeNode[]>([]);
  const [wikiPages, setWikiPages] = useState<WikiPageSummary[]>([]);
  const [compileTask, setCompileTask] = useState<WikiCompileStatus | null>(null);
  const [compileCancelling, setCompileCancelling] = useState(false);
  const [rawLoading, setRawLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 资料搜索：非空 query 时以搜索结果替换下方双分组列表
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<MaterialsSearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);

  const [rawCollapsed, setRawCollapsed] = useState(false);
  const [wikiCollapsed, setWikiCollapsed] = useState(false);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());

  // raw 根目录绝对路径，用于"打开文件路径"功能
  const [rawRoot, setRawRoot] = useState<string | null>(null);
  const [evidenceSummary, setEvidenceSummary] = useState<{ represented: number; excluded: number; uncovered: number; complete: boolean } | null>(null);
  // 刷新信号：递增后通知所有已展开的 TreeRow 重新加载子目录内容
  const [refreshTick, setRefreshTick] = useState(0);

  // 自定义弹窗：新建文件夹 / 删除确认 / 移动到
  const [folderPrompt, setFolderPrompt] = useState<{ open: boolean; parentDir: string }>(
    { open: false, parentDir: "" },
  );
  const [deleteConfirm, setDeleteConfirm] = useState<{
    open: boolean;
    path: string;
  }>({ open: false, path: "" });
  const [moveTarget, setMoveTarget] = useState<{ open: boolean; srcPath: string }>(
    { open: false, srcPath: "" },
  );

  const init = useCallback(async () => {
    if (!isTauri()) return;
    try {
      const available = await listKnowledgeLibraries();
      const initialId = selection?.knowledgeBaseId && available.some((item) => item.id === selection.knowledgeBaseId)
        ? selection.knowledgeBaseId
        : available[0]?.id ?? "kb-default";
      setLibraries(available);
      setKnowledgeBaseId(initialId);
      await materialsEnsureInitialized(initialId);
      setInitialized(true);
    } catch (err) {
      console.error("[materials] init failed:", err);
    }
  }, [selection?.knowledgeBaseId]);

  useEffect(() => {
    void init();
  }, [init]);

  const refreshRaw = useCallback(async () => {
    setRawLoading(true);
    try {
      // 先做轻量对账（补缺/清理孤儿/同步索引），再拉取最新列表
      await reconcileMaterials(knowledgeBaseId).catch(() => undefined);
      const [entries, pages] = await Promise.all([
        listMaterialsFiles(undefined, knowledgeBaseId),
        listWikiPages(knowledgeBaseId),
      ]);
      setTree(buildTree(entries));
      setWikiPages(pages);
      // 异步获取 raw 根目录绝对路径（用于"打开文件路径"）
      try {
        const status = await getMaterialsStatus(knowledgeBaseId);
        if (rawRoot === null && status.rawRoot) setRawRoot(status.rawRoot);
        setEvidenceSummary(status.evidence ?? null);
      } catch {
        // 静默失败，不影响列表加载
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRawLoading(false);
      // 通知已展开的子目录重新加载（解决移动/删除后子目录缓存不刷新）
      setRefreshTick((t) => t + 1);
    }
  }, [rawRoot, knowledgeBaseId]);

  useEffect(() => {
    if (initialized) void refreshRaw();
  }, [initialized, refreshRaw]);

  useEffect(() => {
    setRawRoot(null);
    setTree([]);
    setWikiPages([]);
    if (selection?.knowledgeBaseId && selection.knowledgeBaseId !== knowledgeBaseId) return;
    onSelect(null);
  }, [knowledgeBaseId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Report processing state to parent so the add button can disable.
  useEffect(() => {
    onStateChange?.({ busy });
  }, [busy, onStateChange]);

  const handleUpload = useCallback(
    async (targetDir: string) => {
      if (!isTauri()) return;
      try {
        setError(null);
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
        const imported = await materialsImportFiles(paths, targetDir, knowledgeBaseId);
        // 上传后立即触发后台文本提取，避免 extractStatus 永远为 pending
        // 对每个导入的文件单独触发提取（extract API 接受相对 raw/ 的路径）
        for (const entry of imported) {
          if (entry.kind === "file") {
            const rawRel = entry.path.replace(/^raw\//, "");
            try {
              await extractMaterialsText(rawRel, knowledgeBaseId);
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
    [refreshRaw, knowledgeBaseId],
  );

  const handleCreateFolder = useCallback((parentDir: string) => {
    setFolderPrompt({ open: true, parentDir });
  }, []);

  const submitCreateFolder = useCallback(
    async (name: string) => {
      const parentDir = folderPrompt.parentDir;
      try {
        const rel = parentDir ? `${parentDir}/${name}` : name;
        await createMaterialsDirectory(rel, knowledgeBaseId);
        await refreshRaw();
        setFolderPrompt((current) => ({ ...current, open: false }));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [folderPrompt.parentDir, refreshRaw, knowledgeBaseId],
  );

  const handleDeleteRaw = useCallback((path: string) => {
    setDeleteConfirm({ open: true, path });
  }, []);

  const submitDelete = useCallback(async () => {
    const { path } = deleteConfirm;
    try {
      await deleteMaterialsFile(path.replace(/^raw\//, ""), knowledgeBaseId);
      if (selection?.kind === "raw" && selection.path === path) {
        onSelect(null);
      }
      await refreshRaw();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [deleteConfirm, selection, onSelect, refreshRaw, knowledgeBaseId]);

  const handleRetry = useCallback(async (path: string) => {
    setBusy(true);
    try {
      setError(null);
      await extractMaterialsText(path.replace(/^raw\//, ""), knowledgeBaseId);
      await refreshRaw();
      setTimeout(() => void refreshRaw(), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [refreshRaw, knowledgeBaseId]);

  const handleMove = useCallback((srcPath: string) => {
    setMoveTarget({ open: true, srcPath });
  }, []);

  const submitMove = useCallback(
    async (targetDir: string) => {
      try {
        await moveMaterialsFile(moveTarget.srcPath.replace(/^raw\//, ""), targetDir, knowledgeBaseId);
        await refreshRaw();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [moveTarget.srcPath, refreshRaw, knowledgeBaseId],
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
        await moveMaterialsFile(srcRel, tgtRel, knowledgeBaseId);
        await refreshRaw();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [refreshRaw, knowledgeBaseId],
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

  const handleCreateLibrary = useCallback(async (name: string) => {
    try {
      const created = await createKnowledgeLibrary(name);
      const available = await listKnowledgeLibraries();
      setLibraries(available);
      setKnowledgeBaseId(created.id);
      await materialsEnsureInitialized(created.id);
      setLibraryPromptOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const handleRenameLibrary = useCallback(async (name: string) => {
    try {
      await updateKnowledgeLibrary(knowledgeBaseId, { name });
      setLibraries(await listKnowledgeLibraries());
      setLibraryRenameOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [knowledgeBaseId]);

  const handleDeleteLibrary = useCallback(async () => {
    try {
      await deleteKnowledgeLibrary(knowledgeBaseId);
      const available = await listKnowledgeLibraries();
      setLibraries(available);
      setKnowledgeBaseId(available[0]?.id ?? "kb-default");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [knowledgeBaseId]);

  const runCompile = useCallback(async (paths: string[]) => {
    if (paths.length === 0) {
      setError("当前知识库还没有可整理的来源资料");
      return;
    }
    setBusy(true);
    setError(null);
    setCompileCancelling(false);
    try {
      const started = await startWikiCompile(paths, knowledgeBaseId);
      let status = await getWikiCompileStatus(started.taskId);
      setCompileTask(status);
      const deadline = Date.now() + 10 * 60 * 1000;
      while (status.state === "running") {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await new Promise((resolve) => window.setTimeout(resolve, Math.min(600, remaining)));
        status = await getWikiCompileStatus(started.taskId);
        setCompileTask(status);
      }
      if (status.state === "running") {
        const cancelled = await cancelWikiCompile(started.taskId).catch(() => ({ cancelled: false }));
        if (cancelled.cancelled) {
          status = { ...status, state: "cancelled" };
          setCompileTask(status);
        }
        setError("整理时间较长，已停止等待。你可以稍后重试");
      } else if (status.state === "error") {
        setError(status.errors[0] ?? "整理失败，请重试");
      }
      await refreshRaw();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [knowledgeBaseId, refreshRaw]);

  const handleCompile = useCallback(async () => {
    await runCompile(tree.map((node) => node.entry.path.replace(/^raw\//, "")));
  }, [tree, runCompile]);

  const handleUpdateStaleWiki = useCallback(async () => {
    const paths = Array.from(new Set(
      wikiPages
        .filter((page) => page.stale)
        .flatMap((page) => page.sources ?? [])
        .map((source) => source.replace(/^raw\//, "")),
    ));
    await runCompile(
      paths.length > 0
        ? paths
        : tree.map((node) => node.entry.path.replace(/^raw\//, "")),
    );
  }, [wikiPages, tree, runCompile]);

  const handleCancelCompile = useCallback(async () => {
    if (!compileTask || compileTask.state !== "running") return;
    setCompileCancelling(true);
    try {
      await cancelWikiCompile(compileTask.taskId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCompileCancelling(false);
    }
  }, [compileTask]);

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
      searchMaterials({ query: q, count: 30, scope: "all", knowledgeBaseId })
        .then((results) => setSearchResults(results))
        .catch((err) => {
          setError(err instanceof Error ? err.message : String(err));
          setSearchResults([]);
        })
        .finally(() => setSearching(false));
    }, 300);
    return () => window.clearTimeout(timer);
  }, [searchQuery, knowledgeBaseId]);

  const handleSearchResultClick = useCallback(
    (result: MaterialsSearchResult) => {
      if (result.kind === "material_wiki") {
        onSelect({ kind: "wiki", path: result.path, knowledgeBaseId });
        return;
      }
      // 索引契约：source 结果的 path 已相对 raw/（如 docs/foo.pdf）
      const rawPath = `raw/${result.path}`;
      onSelect({ kind: "raw", path: rawPath, knowledgeBaseId });
      // 携带位置标签跳转：与 mona:material 引用跳转同一定位机制
      if (result.locationLabel) {
        useMaterialsOpenStore.getState().request({
          kind: "raw",
          path: rawPath,
          location: result.locationLabel,
          knowledgeBaseId,
        });
      }
    },
    [onSelect, knowledgeBaseId],
  );

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

  const staleWikiCount = wikiPages.filter((page) => page.stale).length;

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
      <div className="flex items-center gap-1 px-2 pb-1">
        <select
          aria-label="当前知识库"
          value={knowledgeBaseId}
          onChange={(event) => setKnowledgeBaseId(event.target.value)}
          className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-caption"
        >
          {libraries.map((library) => (
            <option key={library.id} value={library.id}>{library.name}</option>
          ))}
        </select>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="新建知识库"
          onClick={() => setLibraryPromptOpen(true)}
          className="h-7 w-7"
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="重命名知识库"
          onClick={() => setLibraryRenameOpen(true)}
          className="h-7 w-7"
        >
          <Pencil className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="删除知识库"
          disabled={knowledgeBaseId === "kb-default"}
          onClick={() => setLibraryDeleteOpen(true)}
          className="h-7 w-7 text-destructive"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
      {error ? (
        <div className="whitespace-pre-wrap px-3 py-1.5 text-[11.5px] text-destructive">
          {error}
        </div>
      ) : null}

      {compileTask ? (
        <div className="flex items-center gap-2 px-3 pb-1 text-micro text-muted-foreground">
          <span className="min-w-0 flex-1">
            {compileTask.state === "running"
              ? `正在整理 ${compileTask.completedFiles}/${compileTask.totalFiles}`
              : `整理${compileTask.state === "done" ? "完成" : compileTask.state === "cancelled" ? "已取消" : "结束"}，生成 ${compileTask.pagesWritten} 个知识页面${compileTask.coverage.complete ? "" : "，部分内容尚未整理"}`}
          </span>
          {compileTask.state === "running" ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label="取消编译"
              disabled={compileCancelling}
              onClick={() => void handleCancelCompile()}
              className="h-6 shrink-0 px-1.5 text-[11px] text-destructive"
            >
              {compileCancelling ? "取消中..." : "取消"}
            </Button>
          ) : null}
        </div>
      ) : null}
      {staleWikiCount > 0 ? (
        <div className="mx-2 mb-1 flex items-center gap-2 rounded-md bg-amber-500/10 px-2.5 py-2 text-caption text-amber-700">
          <span className="min-w-0 flex-1">来源资料有变化，{staleWikiCount} 个知识页面需要更新</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => void handleUpdateStaleWiki()}
            className="h-6 shrink-0 px-1.5 text-[11px] text-amber-700"
          >
            一键更新
          </Button>
        </div>
      ) : null}
      {staleWikiCount === 0 && evidenceSummary && evidenceSummary.uncovered > 0 ? (
        <div className="mx-2 mb-1 flex items-center gap-2 rounded-md bg-amber-500/10 px-2.5 py-2 text-caption text-amber-700">
          <span className="min-w-0 flex-1">有部分来源资料尚未完成整理</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => void handleCompile()}
            className="h-6 shrink-0 px-1.5 text-[11px] text-amber-700"
          >
            继续整理
          </Button>
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
          placeholder="搜索当前知识库..."
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

      {/* 列表区：搜索结果或资料目录 */}
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
                    <span
                      className="shrink-0 text-[10px] text-amber-600"
                      title="来源资料有变化，更新后可使用最新内容"
                    >
                      需更新
                    </span>
                  ) : null}
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
        {/* 资料目录（整个区域作为根目录 drop target） */}
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
            label="来源资料"
            collapsed={rawCollapsed}
            onToggle={() => setRawCollapsed((v) => !v)}
          />
          {!rawCollapsed ? (
            tree.length === 0 && !rawLoading ? (
              <div className="px-3 py-3 text-center text-[11.5px] text-muted-foreground">
                还没有资料。点击上方“添加资料”。
              </div>
            ) : (
              tree.map((node) => (
                <TreeRow
                  key={node.entry.path}
                  node={node}
                  depth={0}
                  selection={selection}
                  expandedPaths={expandedPaths}
                  onSelectRaw={(path) => onSelect({ kind: "raw", path, knowledgeBaseId })}
                  onToggleExpand={toggleExpand}
                  onUpload={handleUpload}
                  onCreateFolder={handleCreateFolder}
                  onDelete={handleDeleteRaw}
                  onMove={handleMove}
                  onRetry={handleRetry}
                  onDragDrop={handleDragDrop}
                  onOpenLocation={handleOpenLocation}
                  refreshTick={refreshTick}
                  loadChildren={async (path) => {
                    try {
                      const rel = path.replace(/^raw\//, "");
                      const entries = await listMaterialsFiles(rel, knowledgeBaseId);
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

        <div className="mt-1 border-t border-border/40 pt-1">
          <GroupHeader
            label="知识页面"
            collapsed={wikiCollapsed}
            onToggle={() => setWikiCollapsed((v) => !v)}
          />
          {!wikiCollapsed ? (
            wikiPages.length === 0 ? (
              <div className="px-3 py-2 text-center text-[11.5px] text-muted-foreground">
                还没有知识页面，点击上方“整理知识”开始整理
              </div>
            ) : (
              wikiPages.map((page) => (
                <button
                  key={page.id || page.path}
                  type="button"
                  onClick={() => onSelect({ kind: "wiki", path: page.path, knowledgeBaseId })}
                  className={cn(
                    "flex w-full items-center gap-1.5 px-3 py-1.5 text-left hover:bg-accent",
                    selection?.kind === "wiki" && selection.path === page.path && selection.knowledgeBaseId === knowledgeBaseId && "bg-accent",
                  )}
                >
                  <BookOpen className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
                  <span className="min-w-0 flex-1 truncate text-caption">{page.title}</span>
                  {page.stale ? (
                    <span
                      className="text-[10px] text-amber-600"
                      title="来源资料有变化，更新后可使用最新内容"
                    >
                      需更新
                    </span>
                  ) : null}
                </button>
              ))
            )
          ) : null}
        </div>

        </>
        )}
      </div>

      {/* 新建文件夹 */}
      <PromptDialog
        open={libraryPromptOpen}
        title="新建知识库"
        placeholder="输入知识库名称"
        onConfirm={handleCreateLibrary}
        onOpenChange={setLibraryPromptOpen}
      />
      <PromptDialog
        open={libraryRenameOpen}
        title="重命名知识库"
        placeholder="输入新的知识库名称"
        onConfirm={handleRenameLibrary}
        onOpenChange={setLibraryRenameOpen}
      />
      <ConfirmDialog
        open={libraryDeleteOpen}
        title="删除知识库"
        message="将永久删除该知识库中的原始资料、证据和 Wiki。"
        destructive
        onConfirm={handleDeleteLibrary}
        onOpenChange={setLibraryDeleteOpen}
      />

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
        title="移出资料库"
        message={`确认将 ${deleteConfirm.path.replace(/^raw\//, "")} 移出资料库？`}
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
