import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, ImagePlus, Plus, Trash2 } from "lucide-react";

import { DeleteConfirm } from "@/components/DeleteConfirm";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { useClient } from "@/providers/ClientProvider";
import { getServicesHttpBase } from "@/lib/api";
import { cn } from "@/lib/utils";

import { ThreeChatPanel } from "./ThreeChatPanel";
import type { ThreeChatPanelHandle } from "./ThreeChatPanel";
import { ThreePreview } from "./ThreePreview";
import { ThreeReviewPanel } from "./ThreeReviewPanel";
import { ThreeStagePanel } from "./ThreeStagePanel";
import {
  downloadProjectFile,
  fetchProjectFileText,
  fetchProjectState,
  projectFileUrl,
  type ThreeProjectState,
} from "./threeState";

interface ThreeProject {
  name: string;
  meta: Record<string, unknown>;
}

type CenterView = "preview" | "reference" | "compare";

export function ThreeDMakerView() {
  const { client } = useClient();
  const [projects, setProjects] = useState<ThreeProject[]>([]);
  const [activeProject, setActiveProject] = useState<string | null>(null);
  const [state, setState] = useState<ThreeProjectState | null>(null);
  const [modelSource, setModelSource] = useState<string | null>(null);
  const [centerView, setCenterView] = useState<CenterView>("preview");
  const [fileBase, setFileBase] = useState("");
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [chatId, setChatId] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const chatPanelRef = useRef<ThreeChatPanelHandle>(null);
  // P0-6: mirrors activeProject so async callbacks can discard stale results.
  // Invariant: state !== null → state.name === activeProject. This is what
  // keeps screenshot/candidate/export actions bound to the visible project.
  const activeProjectRef = useRef<string | null>(null);

  const fetchProjects = useCallback(async () => {
    try {
      const base = await getServicesHttpBase();
      setFileBase(base);
      const resp = await fetch(`${base}/api/three/projects`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      setProjects(data.projects ?? []);
    } catch {
      setProjects([]);
    }
  }, []);

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  const refreshState = useCallback(async (name: string) => {
    try {
      const next = await fetchProjectState(name);
      if (activeProjectRef.current !== name) return; // 项目已切换，丢弃迟到响应
      setState(next);
      setChatId((next.meta?.chatId as string) ?? null);
      if (next.sourcePresent) {
        const source = await fetchProjectFileText(name, "src/createObjectModel.ts");
        if (activeProjectRef.current !== name) return;
        setModelSource(source);
      } else {
        setModelSource(null);
      }
    } catch {
      if (activeProjectRef.current !== name) return;
      setState(null);
      setModelSource(null);
    }
  }, []);

  useEffect(() => {
    activeProjectRef.current = activeProject;
    // P0-6: 切换项目时同步清空旧项目状态，关闭旧会话/旧模型的串线窗口；
    // chatId 置空后聊天输入立即进入禁用占位态。
    setState(null);
    setModelSource(null);
    setChatId(null);
    setIsStreaming(false);
    if (activeProject) {
      setCenterView("preview");
      void refreshState(activeProject);
    }
  }, [activeProject, refreshState]);

  // P0-7: AI 流式期间有界轮询项目状态，使 spec/source 变更无需手动刷新；
  // 流式结束时立即做最终刷新（Agent 此刻刚写完文件，是最可靠的时机）。
  // 页面不可见或项目已切换时跳过请求。
  const prevStreamingRef = useRef(false);
  useEffect(() => {
    const wasStreaming = prevStreamingRef.current;
    prevStreamingRef.current = isStreaming;
    if (!activeProject) return;
    if (!isStreaming) {
      if (wasStreaming) void refreshState(activeProject);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      if (cancelled) return;
      if (!document.hidden && activeProjectRef.current === activeProject) {
        void refreshState(activeProject);
      }
      timer = setTimeout(tick, 3000);
    };
    timer = setTimeout(tick, 3000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [isStreaming, activeProject, refreshState]);

  const handleCreate = useCallback(async () => {
    const name = createName.trim();
    if (!name) return;
    setLoading(true);
    setCreateError(null);
    try {
      const base = await getServicesHttpBase();
      const resp = await fetch(`${base}/api/three/project`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error ?? `HTTP ${resp.status}`);
      }
      const newChatId = await client.newChat(5_000, false, null, "3d");
      await fetch(`${base}/api/three/project/save-chat-id`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, chatId: newChatId }),
      });
      // chatId 不在这里直接设置：setActiveProject 触发的状态加载会从 meta
      // 读回 chatId，避免新会话短暂绑到旧项目的串线窗口。
      await fetchProjects();
      setActiveProject(name);
      setCreateOpen(false);
      setCreateName("");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setCreateError(msg);
    } finally {
      setLoading(false);
    }
  }, [createName, fetchProjects, client]);

  const handleDelete = useCallback(
    async (name: string) => {
      try {
        const base = await getServicesHttpBase();
        await fetch(`${base}/api/three/project?name=${encodeURIComponent(name)}`, {
          method: "DELETE",
        });
        if (activeProject === name) setActiveProject(null);
        await fetchProjects();
      } catch (e) {
        console.error("delete 3d project failed", e);
      }
    },
    [activeProject, fetchProjects],
  );

  const reference = state?.references[0] ?? null;
  const latestRender = state?.renders.length ? state.renders[state.renders.length - 1] : null;
  const refUrl = reference && fileBase ? projectFileUrl(fileBase, state!.name, reference.path) : "";
  const renderUrl = latestRender && fileBase ? projectFileUrl(fileBase, state!.name, latestRender.path) : "";

  return (
    <div className="flex h-full min-h-0">
      {/* 左栏：项目列表 */}
      <div className="flex w-60 shrink-0 flex-col border-r border-border/40">
        <div className="flex h-12 items-center justify-between border-b border-border/40 px-3">
          <span className="text-[13px] font-medium">3D 项目</span>
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            onClick={() => setCreateOpen(true)}
            disabled={loading}
            aria-label="新建 3D 项目"
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-hover">
          {projects.length === 0 ? (
            <div className="px-3 py-2 text-[12px] text-muted-foreground">
              {loading ? "加载中..." : "暂无项目"}
            </div>
          ) : (
            projects.map((p) => (
              <ContextMenu key={p.name}>
                <ContextMenuTrigger asChild>
                  <button
                    type="button"
                    className={cn(
                      "flex w-full items-center px-3 py-2 text-left text-[13px] hover:bg-accent",
                      activeProject === p.name && "bg-accent font-medium",
                    )}
                    onClick={() => setActiveProject(p.name)}
                  >
                    <span className="truncate">{p.name}</span>
                  </button>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem
                    onSelect={() => setActiveProject(p.name)}
                  >
                    打开项目
                  </ContextMenuItem>
                  <ContextMenuItem
                    className="text-destructive focus:text-destructive"
                    onSelect={() => setDeleteTarget(p.name)}
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    删除项目
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            ))
          )}
        </div>
      </div>

      {/* 中栏：编辑区域 */}
      <div className="flex min-w-0 flex-1 flex-col">
        {!activeProject || !state ? (
          <div className="flex flex-1 flex-col items-center justify-center p-6 text-center">
            {activeProject ? (
              <>
                <div className="mb-4 h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                <p className="text-lg text-muted-foreground">正在加载项目状态...</p>
              </>
            ) : (
              <>
                <div className="mb-4 rounded-full bg-primary/10 p-4">
                  <ImagePlus className="h-8 w-8 text-primary" />
                </div>
                <h3 className="text-lg font-medium">开始 3D 创作</h3>
                <p className="mt-2 max-w-sm text-sm text-muted-foreground">
                  创建一个项目并上传参考图，AI 将通过多轮迭代生成高质量的 Three.js 模型代码
                </p>
                <div className="mt-6 flex flex-col gap-2">
                  <Button onClick={() => setCreateOpen(true)}>
                    <Plus className="mr-2 h-4 w-4" />
                    新建项目
                  </Button>
                  {projects.length > 0 && (
                    <p className="text-xs text-muted-foreground">
                      或从左侧选择已有项目继续工作
                    </p>
                  )}
                </div>
              </>
            )}
          </div>
        ) : (
          <>
            {/* 顶部 tab 条 */}
            <div className="flex h-12 items-center gap-1 border-b border-border/40 px-2">
              {(
                [
                  ["preview", "预览"],
                  ["reference", "参考图"],
                  ["compare", "对比"],
                ] as Array<[CenterView, string]>
              ).map(([key, label]) => (
                <Button
                  key={key}
                  variant={centerView === key ? "secondary" : "ghost"}
                  size="sm"
                  className="h-7 px-2.5 text-[13px]"
                  disabled={(key === "reference" && !reference) || (key === "compare" && (!reference || !latestRender))}
                  onClick={() => setCenterView(key)}
                >
                  {label}
                </Button>
              ))}
              <div className="flex-1" />
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2.5 text-[13px]"
                onClick={() => setPanelOpen((v) => !v)}
                aria-label={panelOpen ? "收起面板" : "展开面板"}
              >
                {panelOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm" className="h-7 px-2.5 text-[13px]">
                    导出
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    disabled={!state.specPresent}
                    onSelect={() =>
                      void downloadProjectFile(state.name, "object-sculpt-spec.json", `${state.name}-spec.json`)
                    }
                  >
                    规格 JSON
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={!state.sourcePresent}
                    onSelect={() =>
                      void downloadProjectFile(
                        state.name,
                        "src/createObjectModel.ts",
                        `create${state.name}Model.ts`,
                      )
                    }
                  >
                    Three.js 代码
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={state.reports.length === 0}
                    onSelect={() => {
                      const report = state.reports[state.reports.length - 1];
                      if (report) void downloadProjectFile(state.name, report.path, report.name);
                    }}
                  >
                    评审报告
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            {/* 预览区 */}
            <div className="min-h-0 flex-1">
              {centerView === "preview" && (
                <ThreePreview
                  projectName={state.name}
                  modelSource={modelSource}
                  onRenderSaved={() => void refreshState(state.name)}
                />
              )}
              {centerView === "reference" && refUrl && (
                <div className="flex h-full items-center justify-center overflow-auto p-4 scrollbar-hover">
                  <img src={refUrl} alt="参考图" className="max-h-full max-w-full rounded-lg" />
                </div>
              )}
              {centerView === "compare" && refUrl && renderUrl && (
                <div className="grid h-full grid-cols-2 gap-2 overflow-auto p-2 scrollbar-hover">
                  <figure className="flex min-h-0 flex-col items-center gap-1">
                    <img src={refUrl} alt="对比-参考图" className="max-h-full max-w-full rounded-lg object-contain" />
                    <figcaption className="text-[11px] text-muted-foreground">参考图</figcaption>
                  </figure>
                  <figure className="flex min-h-0 flex-col items-center gap-1">
                    <img src={renderUrl} alt="对比-渲染图" className="max-h-full max-w-full rounded-lg object-contain" />
                    <figcaption className="text-[11px] text-muted-foreground">最新渲染</figcaption>
                  </figure>
                </div>
              )}
            </div>

            {/* 底部面板：阶段 + 组件树 + 评审 */}
            {panelOpen && (
              <div className="flex h-48 shrink-0 flex-col border-t border-border/40">
                <div className="min-h-0 flex-1 overflow-y-auto scrollbar-hover">
                  <div className="grid grid-cols-[minmax(180px,1fr)_minmax(240px,1.4fr)] gap-2 p-2">
                    <div>
                      <div className="px-2.5 pb-1 text-[12px] font-medium text-muted-foreground">阶段</div>
                      <ThreeStagePanel
                        stages={state.stages}
                        blockedReason={state.blockedReason}
                        lastReview={state.lastReview}
                      />
                    </div>
                    <div>
                      <ThreeReviewPanel
                        projectName={state.name}
                        components={state.components}
                        specPresent={state.specPresent}
                        candidatePresent={state.candidatePresent}
                        onCandidateResolved={() => void refreshState(state.name)}
                      />
                    </div>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* 右栏：AI 对话 */}
      <div className="w-[400px] shrink-0 border-l border-border/40">
        <ThreeChatPanel
          key={chatId ?? "empty"}
          chatId={chatId}
          projectName={activeProject}
          onStreamingChange={setIsStreaming}
          onReferenceUploaded={activeProject ? () => void refreshState(activeProject) : undefined}
          ref={chatPanelRef}
        />
      </div>

      {/* 新建项目 Dialog */}
      <Dialog open={createOpen} onOpenChange={(o) => { setCreateOpen(o); if (!o) { setCreateName(""); setCreateError(null); } }}>
        <DialogContent className="max-w-sm">
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void handleCreate();
            }}
          >
            <DialogHeader className="text-left">
              <DialogTitle>新建 3D 项目</DialogTitle>
              <DialogDescription>输入项目名称，创建后可上传参考图</DialogDescription>
            </DialogHeader>
            <Input
              value={createName}
              onChange={(e) => { setCreateName(e.target.value); setCreateError(null); }}
              placeholder="项目名称"
              autoFocus
              maxLength={64}
            />
            {createError && (
              <p className="text-sm text-destructive">{createError}</p>
            )}
            <DialogFooter className="gap-2 sm:space-x-0">
              <Button type="button" variant="outline" onClick={() => { setCreateOpen(false); setCreateName(""); setCreateError(null); }}>
                取消
              </Button>
              <Button type="submit" disabled={!createName.trim() || loading}>
                创建
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* 删除确认 */}
      <DeleteConfirm
        open={deleteTarget !== null}
        title={deleteTarget ?? ""}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget) void handleDelete(deleteTarget);
          setDeleteTarget(null);
        }}
      />
    </div>
  );
}
