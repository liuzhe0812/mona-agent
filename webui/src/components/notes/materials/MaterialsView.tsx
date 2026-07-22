/**
 * MaterialsView — 资料库视图（拆分为 sidebar + preview）。
 *
 * 由 NotesView 组装布局：
 * - MaterialsSidebar：顶部 toolbar + 双分组列表（原始资料 / AI 整理）
 * - MaterialsPreview：根据选中项渲染文本预览或 Wiki markdown
 *
 * 所有路径限制在 `<vault>/.mona/materials/` 内，由后端做 canonical 校验。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronRight,
  FileText,
  FolderPlus,
  Folder,
  Loader2,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  Upload,
} from "lucide-react";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { OfficePreview, isOfficePreviewable } from "@/components/common/OfficePreview";
import { getGatewayHttpBase } from "@/lib/api";
import {
  isTauri,
  materialsImportFiles,
  materialsEnsureInitialized,
} from "@/lib/tauri";
import { getFileTypeIcon } from "@/components/terminal/ipc";
import {
  createMaterialsDirectory,
  deleteMaterialsFile,
  deleteWikiPage,
  extractMaterialsText,
  getMaterialsText,
  getMaterialsRawFile,
  getWikiPage,
  listMaterialsFiles,
  listWikiPages,
  moveMaterialsFile,
  type MaterialsExtractStatus,
  type MaterialsFileEntry,
  type WikiPageSummary,
} from "@/lib/materials-api";
import {
  ingestMaterialsFiles,
  type MaterialsIngestProgress,
} from "@/lib/materials-ingest";
import MarkdownTextRenderer from "@/components/MarkdownTextRenderer";

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
    case "pending":
      return "等待提取";
    case "error":
      return "提取失败";
    default:
      return "";
  }
}

function statusColor(status?: MaterialsExtractStatus): string {
  if (!status) return "text-muted-foreground";
  switch (status.status) {
    case "ok":
      return "text-emerald-600";
    case "pending":
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

interface MaterialsSidebarProps {
  selection: MaterialsSelection;
  onSelect: (sel: MaterialsSelection) => void;
}

export function MaterialsSidebar({ selection, onSelect }: MaterialsSidebarProps) {
  const [initialized, setInitialized] = useState(false);

  const [tree, setTree] = useState<TreeNode[]>([]);
  const [rawLoading, setRawLoading] = useState(false);
  const [wikiPages, setWikiPages] = useState<WikiPageSummary[]>([]);
  const [wikiLoading, setWikiLoading] = useState(false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [compiling, setCompiling] = useState(false);
  const [compileProgress, setCompileProgress] =
    useState<MaterialsIngestProgress | null>(null);

  const [rawCollapsed, setRawCollapsed] = useState(false);
  const [wikiCollapsed, setWikiCollapsed] = useState(false);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());

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
      const entries = await listMaterialsFiles();
      setTree(buildTree(entries));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRawLoading(false);
    }
  }, []);

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

  const handleCreateFolder = useCallback(
    async (parentDir: string) => {
      const name = window.prompt("输入文件夹名称");
      if (!name) return;
      try {
        const rel = parentDir ? `${parentDir}/${name}` : name;
        await createMaterialsDirectory(rel);
        await refreshRaw();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [refreshRaw],
  );

  const handleDeleteRaw = useCallback(
    async (path: string) => {
      if (!window.confirm(`确认删除 ${path}？`)) return;
      try {
        await deleteMaterialsFile(path.replace(/^raw\//, ""));
        if (selection?.kind === "raw" && selection.path === path) {
          onSelect(null);
        }
        await refreshRaw();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [refreshRaw, selection, onSelect],
  );

  const handleDeleteWiki = useCallback(
    async (path: string) => {
      if (!window.confirm(`确认删除 Wiki 页面 ${path}？`)) return;
      try {
        await deleteWikiPage(path);
        if (selection?.kind === "wiki" && selection.path === path) {
          onSelect(null);
        }
        await refreshWiki();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [refreshWiki, selection, onSelect],
  );

  const handleExtract = useCallback(async (path: string) => {
    try {
      await extractMaterialsText(path.replace(/^raw\//, ""));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const handleMove = useCallback(
    async (srcPath: string) => {
      const target = window.prompt("移动到目录（相对于 raw/）", "");
      if (!target) return;
      try {
        await moveMaterialsFile(srcPath.replace(/^raw\//, ""), target);
        await refreshRaw();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [refreshRaw],
  );

  const handleCompile = useCallback(async () => {
    setCompiling(true);
    setCompileProgress(null);
    setError(null);
    try {
      const entries = await listMaterialsFiles();
      // 收集所有 raw 文件（不依赖 extractStatus，ingestOneFile 会处理 text 缺失）
      const readyFiles = entries
        .filter((e) => e.type === "file")
        .map((e) => e.path.replace(/^raw\//, ""))
        .filter(Boolean);

      if (readyFiles.length === 0) {
        setError("没有可编译的资料。请先上传文件。");
        return;
      }

      const result = await ingestMaterialsFiles(readyFiles, (p) =>
        setCompileProgress({ ...p }),
      );
      if (result.errors.length > 0) {
        setError(
          `编译完成，但有 ${result.errors.length} 个错误：\n${result.errors.slice(0, 3).join("\n")}${result.errors.length > 3 ? `\n…（共 ${result.errors.length} 个）` : ""}`,
        );
      }
      await refreshWiki();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCompiling(false);
      setCompileProgress(null);
    }
  }, [refreshWiki]);

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
      {/* 顶部 toolbar */}
      <div className="flex h-9 shrink-0 items-center justify-center gap-0.5 px-2">
        <SidebarIconButton label="上传文件" disabled={busy} onClick={() => handleUpload("")}>
          <Upload className="h-3.5 w-3.5" />
        </SidebarIconButton>
        <SidebarIconButton label="新建文件夹" onClick={() => handleCreateFolder("")}>
          <FolderPlus className="h-3.5 w-3.5" />
        </SidebarIconButton>
        <SidebarIconButton label="生成 Wiki" disabled={compiling} onClick={handleCompile}>
          <Sparkles className={cn("h-3.5 w-3.5", compiling && "animate-pulse")} />
        </SidebarIconButton>
        <SidebarIconButton
          label="刷新"
          disabled={rawLoading || wikiLoading}
          onClick={refreshAll}
        >
          <RefreshCw
            className={cn("h-3.5 w-3.5", (rawLoading || wikiLoading) && "animate-spin")}
          />
        </SidebarIconButton>
      </div>

      {error ? (
        <div className="whitespace-pre-wrap px-3 py-1.5 text-[11.5px] text-destructive">
          {error}
        </div>
      ) : null}

      {compiling && compileProgress ? (
        <div className="border-b border-border/70 px-3 py-1.5 text-[11.5px] text-muted-foreground">
          <div className="flex items-center gap-1.5">
            <Loader2 className="h-3 w-3 animate-spin" />
            <span className="truncate">
              {compileProgress.currentFile || "处理中..."}
            </span>
          </div>
          <div className="mt-0.5 text-[10.5px]">
            已完成 {compileProgress.completedFiles.length} / 生成{" "}
            {compileProgress.pagesWritten} 页
          </div>
        </div>
      ) : null}

      {/* 双分组列表 */}
      <div className="min-h-0 flex-1 overflow-y-auto py-1 scrollbar-thin">
        {/* 原始资料分组 */}
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

        {/* AI 整理分组 */}
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
            wikiPages.map((page) => (
              <WikiRow
                key={page.path}
                page={page}
                selected={selection?.kind === "wiki" && selection.path === page.path}
                onSelect={() => onSelect({ kind: "wiki", path: page.path })}
                onDelete={() => handleDeleteWiki(page.path)}
              />
            ))
          )
        ) : null}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// 小组件
// ---------------------------------------------------------------------------

function SidebarIconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
    >
      {children}
    </button>
  );
}

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
  loadChildren: (path: string) => Promise<TreeNode[]>;
}

function TreeRow(props: TreeRowProps) {
  const { node, depth, selection, expandedPaths } = props;
  const isDir = node.entry.type === "directory";
  const isSelected = selection?.kind === "raw" && selection.path === node.entry.path;
  const isExpanded = expandedPaths.has(node.entry.path);
  const [children, setChildren] = useState<TreeNode[]>([]);
  const [childrenLoaded, setChildrenLoaded] = useState(false);
  const [iconData, setIconData] = useState<string | null>(null);

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

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            role="button"
            tabIndex={0}
            onClick={() => {
              if (isDir) {
                void loadAndToggle();
              } else {
                props.onSelectRaw(node.entry.path);
              }
            }}
            className={cn(
              "flex cursor-default items-center gap-1 px-2 py-[3px] text-[13px] outline-none",
              "hover:bg-accent/60",
              isSelected && "bg-accent text-foreground",
            )}
            style={{ paddingLeft: `${depth * 12 + 8}px` }}
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
          <ContextMenuItem onClick={() => props.onMove(node.entry.path)}>
            <Plus className="mr-2 h-3.5 w-3.5" />
            移动到...
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
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="button"
          tabIndex={0}
          onClick={onSelect}
          className={cn(
            "flex cursor-default items-center gap-1 px-3 py-[3px] text-[13px] outline-none",
            "hover:bg-accent/60",
            selected && "bg-accent text-foreground",
          )}
        >
          <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">{page.title}</span>
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

  // Office 文档用 jit-viewer 预览
  if (isOffice) {
    return <OfficeRawPreview path={path} />;
  }

  return <TextRawPreview path={path} rawRel={rawRel} ext={ext} isDirect={isDirect} />;
}

function OfficeRawPreview({ path }: { path: string }) {
  const rawRel = path.replace(/^raw\//, "");
  const fetchBuffer = useCallback(async () => {
    const base = await getGatewayHttpBase();
    const resp = await fetch(`${base}/api/materials/raw-binary/${encodeURIComponent(rawRel)}`);
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
}: {
  path: string;
  rawRel: string;
  ext: string;
  isDirect: boolean;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [previewMode, setPreviewMode] = useState<"text" | "markdown" | "html">("text");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
            sandbox="allow-scripts allow-same-origin"
            className="h-full min-h-[400px] w-full border-0"
          />
        ) : (
          <pre className="whitespace-pre-wrap break-words font-mono text-[12.5px] leading-relaxed">
            {content ?? ""}
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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/70 px-3">
        <FileText className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="truncate text-[13px]">{path}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4 scrollbar-hover">
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
