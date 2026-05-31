import { useState, useCallback, useEffect } from "react";
import {
  ChevronLeft,
  BookOpen,
  Upload,
  RefreshCw,
  Database,
  Loader2,
  FileText,
  FileCode,
  AlertCircle,
  Plus,
  Trash2,
  FolderOpen,
  FolderSearch,
  CheckCircle2,
  Network,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { isTauri } from "@/lib/tauri";
import {
  kbStatus,
  kbCompile,
  kbGraph,
  kbList,
  kbCreate,
  kbDelete,
  kbFiles,
  kbIngestFiles,
} from "@/lib/api";
import { useClient } from "@/providers/ClientProvider";

interface KbInstance {
  name: string;
  mode: string;
  paths: string[];
  sources: number;
  pages: number;
  nodes: number;
  edges: number;
  pending: number;
}

interface KbFile {
  name: string;
  path: string;
  size: number;
  modified: string;
}

interface GraphNode {
  id: string;
  kind: string;
  title: string;
}

interface GraphEdge {
  source: string;
  target: string;
  relation: string;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatModifiedDate(iso: string): string {
  try {
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  } catch {
    return "";
  }
}

function getFileIcon(name: string) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "md") return <FileText className="h-4 w-4 shrink-0 text-blue-500" />;
  if (["py", "js", "ts"].includes(ext))
    return <FileCode className="h-4 w-4 shrink-0 text-green-500" />;
  return <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />;
}

export function KnowledgeBaseView({ onBack }: { onBack?: () => void }) {
  const { token } = useClient();
  const [instances, setInstances] = useState<KbInstance[]>([]);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [status, setStatus] = useState<KbInstance | null>(null);
  const [ingesting, setIngesting] = useState(false);
  const [compiling, setCompiling] = useState(false);
  const [compileSuccess, setCompileSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createMode, setCreateMode] = useState("document");
  const [createPaths, setCreatePaths] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [files, setFiles] = useState<KbFile[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [graphOpen, setGraphOpen] = useState(false);
  const [graphNodes, setGraphNodes] = useState<GraphNode[]>([]);
  const [graphEdges, setGraphEdges] = useState<GraphEdge[]>([]);
  const [loadingGraph, setLoadingGraph] = useState(false);

  const loadInstances = useCallback(async () => {
    try {
      const res = await kbList(token);
      setInstances(res.instances);
      setError(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "无法获取知识库列表";
      setError(msg);
    }
  }, [token]);

  const loadStatus = useCallback(async () => {
    if (!selectedName) {
      setStatus(null);
      return;
    }
    try {
      const s = await kbStatus(token, undefined, selectedName);
      setStatus({
        name: s.instance,
        mode: s.mode,
        paths: [],
        sources: s.sources,
        pages: s.pages,
        nodes: s.nodes,
        edges: s.edges,
        pending: s.pending,
      });
      setError(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "无法获取知识库状态";
      setError(msg);
    }
  }, [token, selectedName]);

  const loadFiles = useCallback(async () => {
    if (!selectedName) {
      setFiles([]);
      return;
    }
    setLoadingFiles(true);
    try {
      const res = await kbFiles(token, selectedName);
      setFiles(res.files);
    } catch {
      setFiles([]);
    } finally {
      setLoadingFiles(false);
    }
  }, [token, selectedName]);

  const loadGraph = useCallback(async () => {
    if (!selectedName) return;
    setLoadingGraph(true);
    try {
      const res = await kbGraph(token, undefined, selectedName);
      setGraphNodes(res.nodes);
      setGraphEdges(res.edges);
      setGraphOpen(true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "无法获取图谱";
      setError(msg);
    } finally {
      setLoadingGraph(false);
    }
  }, [token, selectedName]);

  useEffect(() => {
    loadInstances();
  }, [loadInstances]);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    loadFiles();
  }, [loadFiles]);



  const handleIngestFiles = useCallback(async () => {
    if (!selectedName || !isTauri()) return;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        multiple: true,
        directory: false,
        title: "选择要入库的文件",
      });
      if (!selected) return;
      const paths = Array.isArray(selected)
        ? selected.map(String)
        : [String(selected)];
      if (paths.length === 0) return;
      setIngesting(true);
      setError(null);
      await kbIngestFiles(token, selectedName, paths);
      await loadFiles();
      await loadStatus();
      await loadInstances();
    } catch {
      setError("入库失败");
    } finally {
      setIngesting(false);
    }
  }, [token, selectedName, loadFiles, loadStatus, loadInstances]);

  const handleCompile = useCallback(async () => {
    if (!selectedName) return;
    setCompiling(true);
    setError(null);
    setCompileSuccess(null);
    try {
      const res = await kbCompile(token, undefined, selectedName);
      await loadStatus();
      await loadInstances();
      if (res.compiled === 0) {
        setCompileSuccess("没有待编译的文件");
      } else {
        setCompileSuccess(`编译完成，已处理 ${res.compiled} 个文件`);
      }
      setTimeout(() => setCompileSuccess(null), 3000);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "编译失败";
      setError(msg);
    } finally {
      setCompiling(false);
    }
  }, [token, selectedName, loadStatus, loadInstances]);

  const handleCreate = useCallback(async () => {
    const name = createName.trim();
    if (!name) return;
    setCreating(true);
    setCreateError(null);
    try {
      const paths = createPaths
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
      await kbCreate(token, name, createMode, paths);
      setCreateOpen(false);
      setCreateName("");
      setCreateMode("document");
      setCreatePaths("");
      await loadInstances();
      setSelectedName(name);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "创建失败";
      setCreateError(msg);
    } finally {
      setCreating(false);
    }
  }, [token, createName, createMode, createPaths, loadInstances]);

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setError(null);
    try {
      await kbDelete(token, deleteTarget);
      setDeleteOpen(false);
      if (selectedName === deleteTarget) {
        setSelectedName(null);
        setStatus(null);
        setResults([]);
        setFiles([]);
        setQuery("");
      }
      setDeleteTarget(null);
      await loadInstances();
    } catch {
      setError("删除失败");
    } finally {
      setDeleting(false);
    }
  }, [token, deleteTarget, selectedName, loadInstances]);

  const browseDirectory = useCallback(async () => {
    if (!isTauri()) return;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        multiple: true,
        directory: true,
        title: "选择关联目录",
      });
      if (!selected) return;
      const paths = Array.isArray(selected)
        ? selected.map(String)
        : [String(selected)];
      setCreatePaths((prev) => {
        const existing = prev
          .split(",")
          .map((p) => p.trim())
          .filter(Boolean);
        const merged = [...new Set([...existing, ...paths])];
        return merged.join(", ");
      });
    } catch {
      // user cancelled or error
    }
  }, []);

  const openDeleteDialog = useCallback((name: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setDeleteTarget(name);
    setDeleteOpen(true);
  }, []);

  const selectedInstance = instances.find((i) => i.name === selectedName) ?? status;

  return (
    <div className="flex h-full bg-background">
      <div className="flex w-60 shrink-0 flex-col border-r border-border/70">
        <div className="shrink-0 px-3 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {onBack && (
                <button
                  type="button"
                  onClick={onBack}
                  className="inline-flex items-center gap-1 rounded-full px-1.5 py-1 text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
              )}
              <div className="flex items-center gap-1.5">
                <BookOpen className="h-4 w-4 text-[#a877e7]" />
                <span className="text-sm font-semibold">知识库</span>
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { setCreateOpen(true); setCreateError(null); }}
              className="h-7 gap-1 text-[12px]"
            >
              <Plus className="h-3.5 w-3.5" />
              新建
            </Button>
          </div>
        </div>

        <Separator />

        <ScrollArea className="flex-1">
          <div className="flex flex-col gap-0.5 p-2">
            {instances.map((inst) => {
              const isSelected = inst.name === selectedName;
              return (
                <button
                  key={inst.name}
                  type="button"
                  onClick={() => {
                    setSelectedName(inst.name);
                    setError(null);
                  }}
                  className={`group relative flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left transition-colors ${
                    isSelected
                      ? "bg-muted text-foreground"
                      : "text-foreground/80 hover:bg-muted/50"
                  }`}
                >
                  <Database className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium">{inst.name}</div>
                    <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                      <span
                        className={`rounded px-1 py-0.5 text-[10px] font-medium ${
                          inst.mode === "document"
                            ? "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400"
                            : "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                        }`}
                      >
                        {inst.mode === "document" ? "Document" : "Notebook"}
                      </span>
                      <span>{inst.sources} 源</span>
                    </div>
                  </div>
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => openDeleteDialog(inst.name, e)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") openDeleteDialog(inst.name, e as unknown as React.MouseEvent);
                    }}
                    className="absolute right-1.5 top-1.5 rounded p-1 opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </span>
                </button>
              );
            })}
            {instances.length === 0 && (
              <div className="py-8 text-center text-[12px] text-muted-foreground">
                暂无知识库
              </div>
            )}
          </div>
        </ScrollArea>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        {!selectedInstance ? (
          <div className="flex flex-1 flex-col items-center justify-center text-muted-foreground">
            <BookOpen className="mb-3 h-10 w-10 opacity-30" />
            <p className="text-[13px]">选择或创建一个知识库</p>
          </div>
        ) : (
          <>
            <div className="shrink-0 border-b border-border/70 px-4 py-3">
              <div className="flex items-center gap-2">
                <h2 className="text-base font-semibold">{selectedInstance.name}</h2>
                <span
                  className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${
                    selectedInstance.mode === "document"
                      ? "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400"
                      : "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                  }`}
                >
                  {selectedInstance.mode === "document" ? "Document" : "Notebook"}
                </span>
              </div>
              {"paths" in selectedInstance && selectedInstance.paths.length > 0 && (
                <div className="mt-1 flex items-center gap-1.5 text-[12px] text-muted-foreground">
                  <FolderOpen className="h-3.5 w-3.5" />
                  {selectedInstance.paths.join(", ")}
                </div>
              )}
            </div>

            <div className="shrink-0 border-b border-border/70 px-4 py-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4 text-[12px] text-muted-foreground">
                  <span>源 {selectedInstance.sources}</span>
                  <span>页 {selectedInstance.pages}</span>
                  <span>节点 {selectedInstance.nodes}</span>
                  <span>边 {selectedInstance.edges}</span>
                  {selectedInstance.pending > 0 && (
                    <span className="text-amber-600 dark:text-amber-400">
                      待编译 {selectedInstance.pending}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleIngestFiles}
                    disabled={ingesting}
                    className="h-7 gap-1.5 text-[12px]"
                  >
                    {ingesting ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Upload className="h-3.5 w-3.5" />
                    )}
                    入库
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleCompile}
                    disabled={compiling}
                    className="h-7 gap-1.5 text-[12px]"
                    title="编译知识库（LLM Wiki）"
                  >
                    {compiling ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="h-3.5 w-3.5" />
                    )}
                    编译
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={loadGraph}
                    disabled={loadingGraph}
                    className="h-7 gap-1.5 text-[12px]"
                    title="查看知识图谱"
                  >
                    {loadingGraph ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Network className="h-3.5 w-3.5" />
                    )}
                    图谱
                  </Button>
                </div>
              </div>
            </div>

            <ScrollArea className="flex-1">
              <div className="px-4 py-3">
                {error && (
                  <div className="mb-3 flex items-center gap-2 rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-[13px] text-destructive">
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    {error}
                  </div>
                )}
                {compileSuccess && (
                  <div className="mb-3 flex items-center gap-2 rounded-lg border border-green-500/50 bg-green-500/10 px-3 py-2 text-[13px] text-green-700 dark:text-green-400">
                    <CheckCircle2 className="h-4 w-4 shrink-0" />
                    {compileSuccess}
                  </div>
                )}

                {files.length > 0 && (
                  <div className="mb-3">
                    <div className="mb-2 text-[12px] font-medium text-muted-foreground">
                      关联目录文件
                    </div>
                    <div className="flex flex-col gap-0.5">
                      {files.map((file) => (
                        <div
                          key={file.path}
                          className="flex items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-muted/50"
                        >
                          {getFileIcon(file.name)}
                          <span className="min-w-0 flex-1 truncate text-[13px]">
                            {file.name}
                          </span>
                          <span className="shrink-0 text-[11px] text-muted-foreground">
                            {formatFileSize(file.size)}
                          </span>
                          <span className="shrink-0 text-[11px] text-muted-foreground">
                            {formatModifiedDate(file.modified)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {files.length === 0 && !loadingFiles && !error && (
                  <div className="mb-3 flex flex-col items-center justify-center py-8 text-muted-foreground">
                    <FolderOpen className="mb-2 h-8 w-8 opacity-40" />
                    <p className="text-[13px]">关联目录为空，点击入库添加文件</p>
                  </div>
                )}


              </div>
            </ScrollArea>
          </>
        )}
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>新建知识库</DialogTitle>
            <DialogDescription>创建一个新的知识库实例</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-2">
            <div className="flex flex-col gap-1.5">
              <label className="text-[13px] font-medium">名称</label>
              <Input
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                placeholder="输入知识库名称"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-[13px] font-medium">模式</label>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant={createMode === "document" ? "default" : "outline"}
                  size="sm"
                  onClick={() => setCreateMode("document")}
                  className="flex-1"
                >
                  Document
                </Button>
                <Button
                  type="button"
                  variant={createMode === "notebook" ? "default" : "outline"}
                  size="sm"
                  onClick={() => setCreateMode("notebook")}
                  className="flex-1"
                >
                  Notebook
                </Button>
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-[13px] font-medium">关联目录</label>
              <div className="flex items-center gap-2">
                <Input
                  value={createPaths}
                  onChange={(e) => setCreatePaths(e.target.value)}
                  placeholder="输入或浏览选择目录路径"
                  className="flex-1"
                />
                {isTauri() && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={browseDirectory}
                    className="shrink-0 gap-1.5"
                  >
                    <FolderSearch className="h-3.5 w-3.5" />
                    浏览
                  </Button>
                )}
              </div>
            </div>
          </div>
          {createError && (
            <div className="flex items-center gap-2 rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-[13px] text-destructive">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {createError}
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCreateOpen(false)}
              disabled={creating}
            >
              取消
            </Button>
            <Button onClick={handleCreate} disabled={creating || !createName.trim()}>
              {creating && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              确认
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="sm:max-w-[360px]">
          <DialogHeader>
            <DialogTitle>删除知识库</DialogTitle>
            <DialogDescription>
              确定要删除知识库「{deleteTarget}」吗？此操作不可撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteOpen(false)}
              disabled={deleting}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={graphOpen} onOpenChange={setGraphOpen}>
        <DialogContent className="sm:max-w-[600px]">
          <DialogHeader>
            <DialogTitle>知识图谱</DialogTitle>
            <DialogDescription>
              {graphNodes.length} 节点 · {graphEdges.length} 边
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-[400px]">
            <div className="flex flex-col gap-3 py-2">
              <div>
                <div className="mb-1 text-[12px] font-medium text-muted-foreground">节点</div>
                <div className="flex flex-wrap gap-1">
                  {graphNodes.map((n) => (
                    <span
                      key={n.id}
                      className={`rounded px-2 py-0.5 text-[11px] ${
                        n.kind === "source"
                          ? "bg-blue-100 text-blue-700"
                          : n.kind === "concept"
                          ? "bg-purple-100 text-purple-700"
                          : "bg-amber-100 text-amber-700"
                      }`}
                    >
                      {n.title}
                    </span>
                  ))}
                </div>
              </div>
              {graphEdges.length > 0 && (
                <div>
                  <div className="mb-1 text-[12px] font-medium text-muted-foreground">关系</div>
                  <div className="flex flex-col gap-0.5">
                    {graphEdges.slice(0, 50).map((e, i) => (
                      <div key={i} className="text-[11px] text-muted-foreground">
                        {e.source} → {e.relation} → {e.target}
                      </div>
                    ))}
                    {graphEdges.length > 50 && (
                      <div className="text-[11px] text-muted-foreground">
                        ... 还有 {graphEdges.length - 50} 条边
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </div>
  );
}
