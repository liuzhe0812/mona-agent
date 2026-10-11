import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDefaultLayout } from "react-resizable-panels";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Code2, FolderOpen, PanelLeft, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { DevelopmentApiError, developmentApi, type DevelopmentSendAttachments, type DevExecutor, type DevProject, type DevSession } from "@/lib/development-api";
import { isTauri } from "@/lib/tauri";
import { useNativeProviderState } from "@/lib/native-provider-state";
import { DevelopmentPane } from "./DevelopmentPane";
import type { DevelopmentBrowserHost } from "./DevelopmentSidebar";
import { DevelopmentLoading } from "./DevelopmentLoading";
import { DevelopmentProjectSidebar } from "./DevelopmentProjectSidebar";
import { DevelopmentNewTask, type NewTaskDraft } from "./DevelopmentNewTask";
import { developmentModels, developmentModelRoute } from "./development-models";
import { refreshDevelopmentSession, useDevelopmentSession } from "./useDevelopmentSession";
import { stopDevelopmentTerminal } from "./terminal-lifecycle";
import { attachmentDraft, EMPTY_SIDE, EMPTY_VIEW, useDevelopmentStore, type TerminalState } from "./store";

const DevelopmentSidebar = lazy(() => import("./DevelopmentSidebar").then((module) => ({ default: module.DevelopmentSidebar })));

export function DevelopmentView({ visible = true, browserHost, onOpenModelSettings }: { visible?: boolean; browserHost?: DevelopmentBrowserHost; onOpenModelSettings?: () => void }) {
  const selectedProject = useDevelopmentStore((s) => s.projectId);
  const providerRevision = useNativeProviderState((state) => state.revision);
  const view = useDevelopmentStore((s) => selectedProject ? s.views[selectedProject] ?? EMPTY_VIEW : EMPTY_VIEW);
  const [projects, setProjects] = useState<DevProject[]>([]);
  const [sessionLists, setSessionLists] = useState<Record<string, DevSession[]>>({});
  const [executors, setExecutors] = useState<DevExecutor[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [projectsError, setProjectsError] = useState("");
  const [modelsError, setModelsError] = useState("");
  const [projectError, setProjectError] = useState("");
  const [newTaskError, setNewTaskError] = useState("");
  const [renameError, setRenameError] = useState("");
  const [updateError, setUpdateError] = useState<{ title: string; message: string } | null>(null);
  const [deleteWarnings, setDeleteWarnings] = useState<string[]>([]);
  const [leftOpen, setLeftOpen] = useState(true);
  const [projectDialog, setProjectDialog] = useState(false);
  const [path, setPath] = useState("");
  const [creatingProjectId, setCreatingProjectId] = useState<string | null>(null);
  const creatingTask = useRef(false);
  const taskNavigation = useRef(0);
  const [busy, setBusy] = useState(false);
  const [rename, setRename] = useState<DevSession | null>(null);
  const [name, setName] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [modelRefreshKey, setModelRefreshKey] = useState(0);
  const [newTaskProjectId, setNewTaskProjectId] = useState<string | null>(null);
  const [newTasks, setNewTasks] = useState<Record<string, NewTaskDraft>>({});
  const error = projectsError || modelsError;
  const project = projects.find((p) => p.id === selectedProject) ?? null;
  const focusedId = view.sessionId;
  const cachedSession = useDevelopmentStore((s) => focusedId ? s.snapshots[focusedId]?.session : undefined);
  const listedSession = (selectedProject ? sessionLists[selectedProject] : [])?.find((s) => s.id === focusedId);
  const storedFocused = cachedSession?.projectId === selectedProject && (!listedSession || cachedSession.revision >= listedSession.revision)
    ? cachedSession : listedSession ?? null;
  const composing = !!project && newTaskProjectId === project.id;
  useDevelopmentSession(focusedId, visible && !composing);
  const focused = composing ? null : storedFocused;
  const projectsLoading = !loaded && !projectsError;
  const tasksLoading = !!project && !composing && !focused && sessionLists[project.id] === undefined;
  const modelsLoading = !executors.length && !modelsError;
  const side = useDevelopmentStore((s) => focused ? s.sides[focused.id] ?? EMPTY_SIDE : EMPTY_SIDE);
  const hasWorkspace = !!project && !!focused && side.expanded;
  // Keep the project rail in a stable outer split. The conversation/workspace
  // split is nested so opening a task or tool panel can never rebalance the rail.
  const shellPanelIds = useMemo(() => [
    ...(leftOpen ? ["development-projects"] : []), "development-conversation",
  ], [leftOpen]);
  const workspacePanelIds = useMemo(() => [
    "development-content-conversation", ...(hasWorkspace ? ["development-workspace"] : []),
  ], [hasWorkspace]);
  const { defaultLayout: shellDefaultLayout, onLayoutChanged: onShellLayoutChanged } = useDefaultLayout({
    id: "mona.development.columns", panelIds: shellPanelIds,
  });
  const { defaultLayout: workspaceDefaultLayout, onLayoutChanged: onWorkspaceLayoutChanged } = useDefaultLayout({
    id: "mona.development.workspace.columns", panelIds: workspacePanelIds,
  });
  const receiveSessions = useCallback((projectId: string, rows: DevSession[]) => {
    setSessionLists((old) => ({ ...old, [projectId]: rows }));
  }, []);
  const reloadWorkspace = () => { setRefreshKey((n) => n + 1); setModelRefreshKey((n) => n + 1); };
  useEffect(() => {
    if (!visible) return;
    let alive = true;
    void developmentApi.projects().then((items) => { if (alive) { setProjects(items); setLoaded(true); setProjectsError(""); } })
      .catch((cause) => { if (alive) setProjectsError(cause instanceof Error ? cause.message : "项目列表读取失败"); });
    return () => { alive = false; };
  }, [visible, refreshKey]);
  useEffect(() => {
    if (!visible) return;
    let alive = true;
    void developmentApi.capabilities(selectedProject ?? undefined).then((caps) => { if (alive) { setExecutors(caps.executors); setModelsError(""); } })
      .catch((cause) => { if (alive) setModelsError(cause instanceof Error ? cause.message : "模型列表读取失败"); });
    return () => { alive = false; };
  }, [visible, selectedProject, modelRefreshKey, providerRevision]);

  const openProject = async () => {
    if (!path.trim() || busy) return;
    setBusy(true); setProjectError("");
    try {
      const result = await developmentApi.openProject(path.trim());
      setProjects((old) => [result, ...old.filter((p) => p.id !== result.id)]
        .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.lastOpenedAt.localeCompare(a.lastOpenedAt)));
      useDevelopmentStore.getState().selectProject(result.id); setProjectDialog(false); setPath("");
    } catch (e) { setProjectError(e instanceof Error ? e.message : "项目打开失败"); }
    finally { setBusy(false); }
  };
  const browse = async () => {
    setProjectError("");
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const value = await open({ directory: true, multiple: false, title: "选择开发项目" });
      if (typeof value === "string") setPath(value);
    } catch (e) { setProjectError(e instanceof Error ? e.message : "目录选择失败"); }
  };
  const beginNewTask = (target: DevProject) => {
    const state = useDevelopmentStore.getState();
    const previousId = state.views[target.id]?.sessionId;
    const previous = (previousId ? state.snapshots[previousId]?.session : undefined)
      ?? sessionLists[target.id]?.find((item) => item.id === previousId);
    const fallback = developmentModels(executors).find((option) => !option.disabledReason);
    const fallbackRoute = fallback ? developmentModelRoute(fallback, fallback.reasoningEffort) : null;
    const initial = previous?.projectId === target.id
      ? { draft: "", executor: previous.executor, model: previous.model, provider: previous.modelProvider ?? null, effort: previous.modelReasoningEffort ?? null }
      : fallbackRoute
        ? { draft: "", ...fallbackRoute }
        : { draft: "", executor: "mona" as const, model: null, provider: null, effort: null };
    setNewTasks((old) => ({ ...old, [target.id]: old[target.id] ?? initial }));
    taskNavigation.current += 1;
    state.selectProject(target.id);
    setNewTaskProjectId(target.id);
    setNewTaskError("");
  };
  const submitNewTask = async (target: DevProject, content: string, attachments?: DevelopmentSendAttachments) => {
    const pendingTask = newTasks[target.id];
    if (!pendingTask || (!content.trim() && !attachments?.docPaths?.length) || creatingTask.current) return false;
    creatingTask.current = true; setCreatingProjectId(target.id); setNewTaskError("");
    const text = content;
    const messageTitle = content.replace(/\s+/g, " ").trim()
      || (attachments?.documentNames ?? []).filter((name) => name.trim()).join("、");
    const titleCharacters = Array.from(messageTitle);
    const title = titleCharacters.length > 200 ? `${titleCharacters.slice(0, 199).join("")}…` : messageTitle;
    const requestId = `request_${crypto.randomUUID().replaceAll("-", "")}`;
    const navigation = taskNavigation.current;
    try {
      const result = await developmentApi.createSession(target.id, {
        executor: pendingTask.executor, model: pendingTask.model,
        modelProvider: pendingTask.provider, modelReasoningEffort: pendingTask.effort,
        ...(title ? { title } : {}),
      });
      setSessionLists((old) => ({ ...old, [target.id]: [result, ...(old[target.id] ?? []).filter((s) => s.id !== result.id)] }));
      const state = useDevelopmentStore.getState();
      state.setSnapshot(result.id, { session: result, messages: [], before: null, messageCount: 0,
        runs: [], events: [], eventCursor: 0, pendingInputs: [], live: null });
      state.setDraft(result.id, text);
      state.setDocumentDraft(result.id, attachmentDraft(attachments));
      state.setSend(result.id, { id: requestId, content: text, uncertain: false,
        ...(attachments?.docPaths?.length ? { docPaths: [...attachments.docPaths] } : {}),
        ...(attachments?.documentNames?.length ? { documentNames: [...attachments.documentNames] } : {}),
      });
      setNewTasks((old) => { const next = { ...old }; delete next[target.id]; return next; });
      if (taskNavigation.current === navigation) {
        state.openSession(target.id, result.id);
        setNewTaskProjectId(null);
      }
      try {
        if (attachments?.docPaths?.length) await developmentApi.send(result.id, requestId, text, undefined, attachments);
        else await developmentApi.send(result.id, requestId, text);
        state.setSend(result.id, null);
        state.setDocumentDraft(result.id, (useDevelopmentStore.getState().documentDrafts[result.id] ?? []).filter((doc) => !attachments?.docPaths?.includes(doc.path)));
        if (useDevelopmentStore.getState().drafts[result.id] === text) state.setDraft(result.id, "");
        refreshDevelopmentSession(result.id);
      } catch (cause) {
        const definite = cause instanceof DevelopmentApiError && cause.status >= 400 && cause.status < 500;
        state.setSend(result.id, definite ? null : { id: requestId, content: text, uncertain: true,
          ...(attachments?.docPaths?.length ? { docPaths: [...attachments.docPaths] } : {}),
          ...(attachments?.documentNames?.length ? { documentNames: [...attachments.documentNames] } : {}),
        });
        state.setError(result.id, cause instanceof Error ? cause.message : "发送失败。新会话和原输入已保留。");
        return false;
      }
      setRefreshKey((n) => n + 1);
      return true;
    } catch (cause) {
      if (taskNavigation.current === navigation) setNewTaskError(cause instanceof Error ? cause.message : "新建会话失败，输入仍保留。");
      return false;
    } finally {
      creatingTask.current = false; setCreatingProjectId(null);
    }
  };
  const update = async (session: DevSession, changes: Partial<Pick<DevSession, "title" | "pinned" | "archived">>) => {
    setRenameError(""); setUpdateError(null);
    try {
      const value = await developmentApi.updateSession(session, changes);
      const state = useDevelopmentStore.getState();
      const snapshot = state.snapshots[value.id];
      if (snapshot) state.setSnapshot(value.id, { ...snapshot, session: value });
      refreshDevelopmentSession(value.id);
      setSessionLists((old) => ({ ...old, [session.projectId]: (old[session.projectId] ?? []).map((s) => s.id === value.id ? { ...s, ...value } : s) }));
      setRefreshKey((n) => n + 1);
      if (rename?.id === value.id) setRename(null);
    } catch (e) {
      const message = e instanceof Error ? e.message : "任务更新失败";
      if (rename?.id === session.id) setRenameError(message);
      else setUpdateError({ title: session.title, message });
      setRefreshKey((n) => n + 1);
    }
  };
  const cleanupDeletedTerminal = async (sessionId: string, title: string, original: TerminalState) => {
    try { await stopDevelopmentTerminal(sessionId); }
    catch (cause) {
      const state = useDevelopmentStore.getState();
      const current = state.terminals[sessionId] ?? original;
      state.setTerminal(sessionId, { ...current, status: "error", error: `未确认终端已结束：${cause instanceof Error ? cause.message : String(cause)}` });
    }
    const state = useDevelopmentStore.getState();
    const terminal = state.terminals[sessionId];
    if (terminal) {
      setDeleteWarnings((warnings) => [...warnings, `任务“${title}”已删除，但关联终端未确认结束。请在系统任务管理器检查。${terminal.error ? `原因：${terminal.error}` : ""}`]);
    } else {
      state.forgetSession(sessionId);
    }
  };

  const deleteTask = async (session: DevSession) => {
    setDeleteWarnings([]);
    const result = await developmentApi.deleteSession(session);
    const deleted = new Set(result.deleted);
    const currentView = useDevelopmentStore.getState();
    const deletingFocused = currentView.projectId === session.projectId
      && deleted.has(currentView.views[session.projectId]?.sessionId ?? "");
    const remaining = (sessionLists[session.projectId] ?? []).filter((item) => !deleted.has(item.id));
    setSessionLists((old) => ({ ...old, [session.projectId]: (old[session.projectId] ?? []).filter((item) => !deleted.has(item.id)) }));
    setDeleteWarnings(result.warnings ?? []);
    for (const id of result.deleted) {
      const state = useDevelopmentStore.getState();
      const terminal = state.terminals[id];
      state.forgetSession(id);
      if (terminal) {
        state.setTerminal(id, terminal);
        const title = sessionLists[session.projectId]?.find((item) => item.id === id)?.title ?? session.title;
        void cleanupDeletedTerminal(id, title, terminal);
      }
    }
    const state = useDevelopmentStore.getState();
    if (deletingFocused) {
      const next = remaining.filter((item) => !item.parentSessionId && !item.archived)
        .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
      state.openSession(session.projectId, next?.id ?? null);
    }
    setRefreshKey((n) => n + 1);
  };
  const openTaskTerminal = async (session: DevSession) => {
    if (!isTauri()) throw new Error("请在 Mona 桌面端打开终端。");
    const target = projects.find((item) => item.id === session.projectId);
    if (!target) throw new Error("找不到任务所属项目，请重新打开项目后再试。");
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("system_open_in_terminal", { path: target.rootPath });
    } catch {
      throw new Error("无法打开终端，请确认项目目录仍然存在且可以访问，并检查系统终端是否可用。");
    }
  };
  const projectChanged = (value: DevProject) => {
    setProjects((items) => items.map((item) => item.id === value.id ? value : item).filter((item) => !item.removed)
      .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.lastOpenedAt.localeCompare(a.lastOpenedAt)));
    if (value.removed && useDevelopmentStore.getState().projectId === value.id) {
      // Unlink only the visible selection; drafts and original session bindings survive reopening.
      useDevelopmentStore.setState({ projectId: null });
    }
    setRefreshKey((n) => n + 1);
  };
  const selectSession = (session: DevSession) => {
    taskNavigation.current += 1;
    setNewTaskProjectId(null);
    useDevelopmentStore.getState().openSession(session.projectId, session.id);
  };
  const forkNavigation = taskNavigation.current;
  const forkSourceId = focused?.id;
  const forkProjectId = focused?.projectId;
  const onForkCreated = focused ? (child: DevSession) => {
    setSessionLists((old) => ({ ...old, [child.projectId]: [child, ...(old[child.projectId] ?? []).filter((item) => item.id !== child.id)] }));
    setRefreshKey((value) => value + 1);
    const state = useDevelopmentStore.getState();
    if (forkProjectId && forkSourceId && child.projectId === forkProjectId && taskNavigation.current === forkNavigation
      && state.projectId === forkProjectId && state.views[forkProjectId]?.sessionId === forkSourceId) {
      taskNavigation.current += 1;
      state.openSession(child.projectId, child.id);
    }
  } : undefined;
  const navigateToForkSource = (sourceSessionId: string) => {
    const source = (sessionLists[focused?.projectId ?? ""] ?? []).find((item) => item.id === sourceSessionId)
      ?? useDevelopmentStore.getState().snapshots[sourceSessionId]?.session;
    if (!source || source.projectId !== focused?.projectId) return false;
    selectSession(source);
    return true;
  };
  return <div data-testid="development-workbench" className="relative flex h-full min-h-0 min-w-0 overflow-hidden bg-background">
    <ResizablePanelGroup id="development-columns" direction="horizontal" defaultLayout={shellDefaultLayout} onLayoutChanged={onShellLayoutChanged}
      resizeTargetMinimumSize={{ fine: 8, coarse: 24 }} className="min-h-0 min-w-0">
    {leftOpen && <>
      <ResizablePanel id="development-projects" defaultSize="240px" minSize="180px" maxSize="420px" groupResizeBehavior="preserve-pixel-size" style={{ overflow: "hidden" }}>
        <DevelopmentProjectSidebar projects={projects} projectsLoading={projectsLoading} projectsError={projectsError} activeSessionId={focusedId} visible={visible} refreshKey={refreshKey}
          onToggleProjects={() => setLeftOpen(false)}
          onSessions={receiveSessions} onProjectChanged={projectChanged} onReload={reloadWorkspace}
          onOpenProject={() => setProjectDialog(true)} onSelectSession={selectSession} onCreate={beginNewTask} creatingProjectId={creatingProjectId}
          onRename={(value) => { setRename(value); setName(value.title); setRenameError(""); }} onUpdate={(value, changes) => void update(value, changes)}
          onDelete={deleteTask} onOpenTerminal={openTaskTerminal} />
      </ResizablePanel>
      <ResizableHandle aria-label="调整项目列表宽度" className="z-10 bg-border/50 hover:bg-primary/30 focus-visible:bg-primary/30" />
    </>}
    <ResizablePanel id="development-conversation" minSize="320px" style={{ overflow: "hidden" }}>
      <ResizablePanelGroup id="development-workspace-columns" direction="horizontal" defaultLayout={workspaceDefaultLayout} onLayoutChanged={onWorkspaceLayoutChanged}
        resizeTargetMinimumSize={{ fine: 8, coarse: 24 }} className="min-h-0 min-w-0">
        <ResizablePanel id="development-content-conversation" minSize="320px" style={{ overflow: "hidden" }}>
          <main className="relative flex h-full min-h-0 min-w-0 flex-col">
            {error && (!project || !focused) && <div role="alert" className="flex shrink-0 items-center gap-2 border-b border-border/50 px-4 py-2 text-caption text-destructive"><div className="min-w-0 flex-1 space-y-1">{projectsError && <p>{projectsError}</p>}{modelsError && <p>{modelsError}</p>}</div><Button variant="ghost" size="sm" onClick={reloadWorkspace}><RefreshCw className="mr-1 h-3 w-3" />重试读取</Button></div>}
            {projectsLoading || tasksLoading ? <><div className="flex h-12 shrink-0 items-center px-3">{!leftOpen && <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="切换项目列表" onClick={() => setLeftOpen(true)}><PanelLeft className="h-4 w-4" /></Button>}</div><DevelopmentLoading label={projectsLoading ? "正在读取项目…" : "正在恢复任务…"} /></>
              : !loaded && projectsError ? <p className="p-5 text-ui text-muted-foreground">项目暂未读取，请重试。</p>
              : !project ? <><div className="flex h-12 shrink-0 items-center px-3">{!leftOpen && <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="切换项目列表" onClick={() => setLeftOpen(true)}><PanelLeft className="h-4 w-4" /></Button>}</div>
              <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-8 pb-24 text-center"><Code2 className="h-8 w-8 text-muted-foreground" /><h1 className="text-title-md font-medium">开始编程</h1><p className="text-ui text-muted-foreground">打开本地项目，或从左侧继续已有会话。</p><Button variant="outline" onClick={() => setProjectDialog(true)}><FolderOpen className="mr-2 h-4 w-4" />打开本地项目</Button></div></>
              : composing ? <DevelopmentNewTask key={`new:${project.id}`} project={project} executors={executors}
                  modelsLoading={modelsLoading}
                  value={newTasks[project.id] ?? { draft: "", executor: "mona", model: null, provider: null, effort: null }}
                  error={newTaskError}
                  busy={creatingProjectId === project.id}
                  onChange={(value) => setNewTasks((old) => ({ ...old, [project.id]: value }))}
                  onSubmit={(content, attachments) => submitNewTask(project, content, attachments)}
                  onToggleProjects={leftOpen ? undefined : () => setLeftOpen(true)} onManageModels={onOpenModelSettings} />
                : <DevelopmentPane key={focused?.id ?? project.id} session={focused} project={project} executors={executors} modelsLoading={modelsLoading} visible={visible} workspaceError={error} onRetryWorkspace={reloadWorkspace}
                  onRename={(value) => { setRename(value); setName(value.title); setRenameError(""); }} onUpdate={(value, changes) => void update(value, changes)}
                  onToggleProjects={leftOpen ? undefined : () => setLeftOpen(true)} onManageModels={onOpenModelSettings} onNew={() => beginNewTask(project)} creatingTask={creatingProjectId !== null}
                  onForkCreated={onForkCreated} onNavigateToSession={navigateToForkSource} />}
          </main>
        </ResizablePanel>
        {project && focused && hasWorkspace && <>
          <ResizableHandle aria-label="调整工作侧栏宽度" className="z-10 bg-border/50 hover:bg-primary/30 focus-visible:bg-primary/30" />
          <ResizablePanel id="development-workspace" defaultSize="384px" minSize="280px" maxSize="55%" groupResizeBehavior="preserve-pixel-size" style={{ overflow: "visible" }}>
            <Suspense fallback={<DevelopmentLoading label="正在打开工作侧栏…" />}><DevelopmentSidebar key={focused.id} project={project} session={focused} executors={executors} visible={visible} browserHost={browserHost} onManageModels={onOpenModelSettings} /></Suspense>
          </ResizablePanel>
        </>}
      </ResizablePanelGroup>
    </ResizablePanel>
    </ResizablePanelGroup>
    <Dialog open={projectDialog} onOpenChange={(open) => { setProjectDialog(open); if (!open) setProjectError(""); }}><DialogContent><DialogHeader><DialogTitle>打开本地项目</DialogTitle><DialogDescription>选择已有代码目录。不会创建分支、修改项目配置或启动任务。</DialogDescription></DialogHeader>
      <div className="flex gap-2"><Input aria-label="项目目录" placeholder="输入项目的完整目录路径" value={path} onChange={(e) => setPath(e.target.value)} />{isTauri() && <Button variant="outline" onClick={() => void browse()}>选择目录</Button>}</div>
      {projectError && <p role="alert" className="text-caption text-destructive">{projectError}</p>}
      <DialogFooter><Button variant="outline" onClick={() => { setProjectDialog(false); setProjectError(""); }}>取消</Button><Button disabled={!path.trim() || busy} onClick={() => void openProject()}>{busy ? "正在打开…" : "打开项目"}</Button></DialogFooter>
    </DialogContent></Dialog>
    <Dialog open={!!rename} onOpenChange={(open) => { if (!open) { setRename(null); setRenameError(""); } }}><DialogContent><DialogHeader><DialogTitle>重命名开发任务</DialogTitle><DialogDescription>名称不影响已有历史和执行状态。</DialogDescription></DialogHeader>
      <Input aria-label="新的任务名称" value={name} onChange={(e) => setName(e.target.value)} />{renameError && <p role="alert" className="text-caption text-destructive">{renameError}</p>}<DialogFooter><Button variant="outline" onClick={() => { setRename(null); setRenameError(""); }}>取消</Button><Button disabled={!name.trim()} onClick={() => rename && void update(rename, { title: name.trim() })}>保存</Button></DialogFooter>
    </DialogContent></Dialog>
    <Dialog open={!!updateError} onOpenChange={(open) => { if (!open) setUpdateError(null); }}><DialogContent><DialogHeader><DialogTitle>任务操作未完成</DialogTitle><DialogDescription>「{updateError?.title}」未更新，原任务仍保留。</DialogDescription></DialogHeader>
      {updateError && <p role="alert" className="text-ui text-destructive">{updateError.message}</p>}
      <DialogFooter><Button onClick={() => setUpdateError(null)}>知道了</Button></DialogFooter>
    </DialogContent></Dialog>
    <Dialog open={!!deleteWarnings.length} onOpenChange={(open) => { if (!open) setDeleteWarnings([]); }}><DialogContent><DialogHeader><DialogTitle>删除后仍需核对</DialogTitle><DialogDescription>会话记录已删除，以下关联资源的结束状态仍需核对。</DialogDescription></DialogHeader>
      <div role="alert" className="max-h-52 space-y-2 overflow-auto text-ui text-destructive">{deleteWarnings.map((warning, index) => <p key={`${index}:${warning}`}>{warning}</p>)}</div>
      <DialogFooter><Button onClick={() => setDeleteWarnings([])}>知道了</Button></DialogFooter>
    </DialogContent></Dialog>
  </div>;
}
