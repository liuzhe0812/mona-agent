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
import { attachmentDraft, DEVELOPMENT_STORAGE_KEY, EMPTY_SIDE, EMPTY_VIEW, useDevelopmentStore, type PendingNewTask, type TerminalState } from "./store";

const DevelopmentSidebar = lazy(() => import("./DevelopmentSidebar").then((module) => ({ default: module.DevelopmentSidebar })));
const CANCELLATION_OUTBOX_PREFIX = "mona.development.creation-cancel.pending.v1:";
interface CancellationOutboxEntry { projectId: string; pending: PendingNewTask; draft?: NewTaskDraft }

function cancellationOutboxKey(projectId: string, requestId: string) {
  return `${CANCELLATION_OUTBOX_PREFIX}${encodeURIComponent(projectId)}:${encodeURIComponent(requestId)}`;
}

function readCancellationEntry(key: string): CancellationOutboxEntry | undefined {
  const raw = localStorage.getItem(key);
  if (raw === null) return undefined;
  const entry = JSON.parse(raw) as CancellationOutboxEntry | null;
  if (!entry || typeof entry.projectId !== "string" || typeof entry.pending?.requestId !== "string"
    || typeof entry.pending.sendRequestId !== "string" || entry.pending.state !== "cancelling"
    || key !== cancellationOutboxKey(entry.projectId, entry.pending.requestId)) throw new Error("invalid cancellation record");
  return entry;
}

function readCancellationOutbox(): CancellationOutboxEntry[] {
  const entries: CancellationOutboxEntry[] = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (!key?.startsWith(CANCELLATION_OUTBOX_PREFIX)) continue;
    const entry = readCancellationEntry(key);
    if (entry) entries.push(entry);
  }
  return entries;
}

function saveCancellationOutbox(entry: CancellationOutboxEntry): void {
  const key = cancellationOutboxKey(entry.projectId, entry.pending.requestId);
  localStorage.setItem(key, JSON.stringify(entry));
  if (localStorage.getItem(key) !== JSON.stringify(entry)) throw new Error("cancellation persistence failed");
}

function removeCancellationOutbox(entry: CancellationOutboxEntry): void {
  const key = cancellationOutboxKey(entry.projectId, entry.pending.requestId);
  localStorage.removeItem(key);
  if (localStorage.getItem(key) !== null) throw new Error("cancellation cleanup failed");
}

function savedPendingNewTask(projectId: string): PendingNewTask | undefined {
  return JSON.parse(localStorage.getItem(DEVELOPMENT_STORAGE_KEY) ?? "null")?.state?.pendingNewTasks?.[projectId];
}

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
  const [newTaskNotices, setNewTaskNotices] = useState<Record<string, string>>({});
  const [outboxState, setOutboxState] = useState<{ entries: CancellationOutboxEntry[]; error: string }>(() => {
    try { return { entries: readCancellationOutbox(), error: "" }; }
    catch { return { entries: [], error: "无法读取上次放弃状态，请检查本地存储。" }; }
  });
  const restoredOutboxKeys = useRef(new Set(outboxState.entries.map((entry) => cancellationOutboxKey(entry.projectId, entry.pending.requestId))));
  const [renameError, setRenameError] = useState("");
  const [updateError, setUpdateError] = useState<{ title: string; message: string } | null>(null);
  const [deleteWarnings, setDeleteWarnings] = useState<string[]>([]);
  const [leftOpen, setLeftOpen] = useState(true);
  const [projectDialog, setProjectDialog] = useState(false);
  const [path, setPath] = useState("");
  const [creatingProjectId, setCreatingProjectId] = useState<string | null>(null);
  const creatingTask = useRef(false);
  const remoteCancellations = useRef<Record<string, string>>({});
  const [, setCancellationRevision] = useState(0);
  const taskNavigation = useRef(0);
  const [busy, setBusy] = useState(false);
  const [rename, setRename] = useState<DevSession | null>(null);
  const [name, setName] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [modelRefreshKey, setModelRefreshKey] = useState(0);
  const newTaskProjectId = useDevelopmentStore((s) => s.newTaskProjectId);
  const newTasks = useDevelopmentStore((s) => s.newTaskDrafts);
  const pendingNewTasks = useDevelopmentStore((s) => s.pendingNewTasks);
  const error = projectsError || modelsError;
  const project = projects.find((p) => p.id === selectedProject) ?? null;
  const currentCancellation = project ? outboxState.entries.find((entry) => entry.projectId === project.id) : undefined;
  const currentPending = project ? pendingNewTasks[project.id] : undefined;
  const cancellationDraft = currentCancellation && (!currentPending || currentPending.requestId === currentCancellation.pending.requestId)
    && (restoredOutboxKeys.current.has(cancellationOutboxKey(currentCancellation.projectId, currentCancellation.pending.requestId)) || !project || !newTasks[project.id])
    ? currentCancellation.draft : undefined;
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
    const onStorage = (event: StorageEvent) => {
      if (event.key?.startsWith(CANCELLATION_OUTBOX_PREFIX)) {
        try { setOutboxState({ entries: readCancellationOutbox(), error: "" }); }
        catch { setOutboxState({ entries: [], error: "无法读取上次放弃状态，请检查本地存储。" }); }
        return;
      }
      if (event.key !== DEVELOPMENT_STORAGE_KEY || !event.newValue) return;
      try {
        const remote = JSON.parse(event.newValue)?.state?.pendingNewTasks ?? {};
        const current = useDevelopmentStore.getState();
        for (const [projectId, value] of Object.entries(current.pendingNewTasks)) {
          const received = remote[projectId] as PendingNewTask | undefined;
          if (received?.requestId === value.requestId && received.state === "cancelling" && value.state !== "cancelling") {
            remoteCancellations.current[projectId] = received.requestId;
            setCancellationRevision((revision) => revision + 1);
          }
        }
      } catch {
        setNewTaskError("无法同步上次提交状态，请检查本地存储。");
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
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
  const changeNewTaskDraft = (projectId: string, draft: NewTaskDraft) => {
    try {
      const state = useDevelopmentStore.getState();
      const pending = state.pendingNewTasks[projectId];
      const entries = readCancellationOutbox();
      const entry = entries.find((item) => item.projectId === projectId && (!pending || pending.requestId === item.pending.requestId));
      const saved = savedPendingNewTask(projectId);
      const owner = pending?.requestId ?? entry?.pending.requestId;
      if (saved && owner && saved.requestId !== owner) {
        setNewTaskError("此项目在其他窗口有待确认提交，请先在原窗口处理。");
        return;
      }
      if (entry) {
        saveCancellationOutbox({ ...entry, draft });
        setOutboxState({ entries: readCancellationOutbox(), error: "" });
      }
      state.setNewTaskDraft(projectId, draft);
    } catch {
      setNewTaskError("无法保存草稿，请检查本地存储。");
    }
  };
  const settleCancellation = (projectId: string, requestId: string, notice: string) => {
    const entry = readCancellationEntry(cancellationOutboxKey(projectId, requestId));
    const state = useDevelopmentStore.getState();
    const current = state.pendingNewTasks[projectId];
    const saved = savedPendingNewTask(projectId);
    if ((!current || current.requestId === requestId) && (!saved || saved.requestId === requestId)) {
      if (entry?.draft && (!state.newTaskDrafts[projectId] || restoredOutboxKeys.current.has(cancellationOutboxKey(projectId, requestId)))) state.setNewTaskDraft(projectId, entry.draft);
      if (current) state.setPendingNewTask(projectId, null);
    }
    if (entry) removeCancellationOutbox(entry);
    restoredOutboxKeys.current.delete(cancellationOutboxKey(projectId, requestId));
    setOutboxState({ entries: readCancellationOutbox(), error: "" });
    if (remoteCancellations.current[projectId] === requestId) delete remoteCancellations.current[projectId];
    setNewTaskNotices((old) => ({ ...old, [projectId]: notice }));
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
    if (!state.newTaskDrafts[target.id]) state.setNewTaskDraft(target.id, initial);
    taskNavigation.current += 1;
    state.selectProject(target.id);
    state.setNewTaskProject(target.id);
    setNewTaskError("");
  };
  const submitNewTask = async (target: DevProject, content: string, attachments?: DevelopmentSendAttachments, continuing = false) => {
    if (creatingTask.current) return false;
    const state = useDevelopmentStore.getState();
    let pending = state.pendingNewTasks[target.id];
    try {
      const entries = readCancellationOutbox();
      if ((pending && readCancellationEntry(cancellationOutboxKey(target.id, pending.requestId))) || entries.some((item) => item.projectId === target.id)) {
        setOutboxState({ entries, error: "" });
        setNewTaskError("请先确认放弃上次提交，当前草稿已保留。");
        return false;
      }
    } catch {
      setNewTaskError("无法读取上次放弃状态，请检查本地存储。");
      return false;
    }
    if (pending && remoteCancellations.current[target.id] === pending.requestId) return false;
    try {
      const saved = savedPendingNewTask(target.id);
      if (saved && !pending) { state.setPendingNewTask(target.id, saved); return false; }
      if (saved && pending && saved.requestId !== pending.requestId) {
        setNewTaskError("此项目还有未确认的提交，请先在原窗口处理。");
        return false;
      }
      if (pending && saved?.requestId === pending.requestId && saved.state === "cancelling") {
        remoteCancellations.current[target.id] = pending.requestId;
        setCancellationRevision((revision) => revision + 1);
        return false;
      }
    } catch {
      setNewTaskError("无法读取提交信息，请检查本地存储后重试。");
      return false;
    }
    if (pending && (!continuing || pending.state !== "pending")) return false;
    if (!pending) {
      const draft = state.newTaskDrafts[target.id];
      if (continuing || !draft || (!content.trim() && !attachments?.docPaths?.length)) return false;
      const messageTitle = content.replace(/\s+/g, " ").trim()
        || (attachments?.documentNames ?? []).filter((name) => name.trim()).join("、");
      const titleCharacters = Array.from(messageTitle);
      const title = titleCharacters.length > 200 ? `${titleCharacters.slice(0, 199).join("")}…` : messageTitle;
      pending = {
        requestId: `request_${crypto.randomUUID().replaceAll("-", "")}`,
        sendRequestId: `request_${crypto.randomUUID().replaceAll("-", "")}`,
        options: { executor: draft.executor, model: draft.model, modelProvider: draft.provider, modelReasoningEffort: draft.effort,
          ...(title ? { title } : {}) },
        content,
        ...(attachments?.docPaths?.length ? { attachments: { docPaths: [...attachments.docPaths], documentNames: [...(attachments.documentNames ?? [])] } } : {}),
        draft: { ...draft, ...(draft.documents ? { documents: draft.documents.map((item) => ({ ...item })) } : {}) },
        state: "pending",
        attempt: 0,
      } satisfies PendingNewTask;
    }
    // A late failure from an earlier attempt must not clear a resumed request.
    pending = { ...pending, attempt: (pending.attempt ?? 0) + 1 };
    try {
      state.setPendingNewTask(target.id, pending);
      const saved = JSON.parse(localStorage.getItem(DEVELOPMENT_STORAGE_KEY) ?? "null");
      if (saved?.state?.pendingNewTasks?.[target.id]?.requestId !== pending.requestId) throw new Error("draft persistence failed");
    } catch {
      setNewTaskError("无法保存提交信息，请检查本地存储后重试。");
      return false;
    }
    creatingTask.current = true; setCreatingProjectId(target.id); setNewTaskError("");
    setNewTaskNotices((old) => { const next = { ...old }; delete next[target.id]; return next; });
    const navigation = taskNavigation.current;
    try {
      const result = await developmentApi.createSession(target.id, { ...pending.options, requestId: pending.requestId });
      setSessionLists((old) => ({ ...old, [target.id]: [result, ...(old[target.id] ?? []).filter((s) => s.id !== result.id)] }));
      let current = useDevelopmentStore.getState();
      if (current.pendingNewTasks[target.id]?.requestId !== pending.requestId || current.pendingNewTasks[target.id]?.state !== "pending" || remoteCancellations.current[target.id] === pending.requestId) return false;
      if (readCancellationEntry(cancellationOutboxKey(target.id, pending.requestId))) return false;
      const saved = savedPendingNewTask(target.id);
      if (saved?.requestId !== pending.requestId || saved.state !== "pending") {
        if (saved?.requestId === pending.requestId && saved.state === "cancelling") {
          remoteCancellations.current[target.id] = pending.requestId;
          setCancellationRevision((revision) => revision + 1);
        }
        return false;
      }
      if (!current.snapshots[result.id]) current.setSnapshot(result.id, { session: result, messages: [], before: null, messageCount: 0,
        runs: [], events: [], eventCursor: 0, pendingInputs: [], live: null });
      current = useDevelopmentStore.getState();
      if (current.sends[result.id] && current.sends[result.id].id !== pending.sendRequestId) {
        if (taskNavigation.current === navigation) setNewTaskError("此任务还有未确认的发送，请先在任务中核对。上次提交已保留。");
        return false;
      }
      const pendingNewTasks = { ...current.pendingNewTasks };
      delete pendingNewTasks[target.id];
      const newTaskDrafts = { ...current.newTaskDrafts };
      if (JSON.stringify(newTaskDrafts[target.id]) === JSON.stringify(pending.draft)) delete newTaskDrafts[target.id];
      const open = taskNavigation.current === navigation && current.projectId === target.id && current.newTaskProjectId === target.id;
      const hadDraft = Object.prototype.hasOwnProperty.call(current.drafts, result.id);
      const hadDocuments = Object.prototype.hasOwnProperty.call(current.documentDrafts, result.id);
      // Persist the accepted session and its original message together before dispatch.
      useDevelopmentStore.setState({ pendingNewTasks, newTaskDrafts,
        drafts: { ...current.drafts, [result.id]: hadDraft ? current.drafts[result.id] : pending.content },
        documentDrafts: { ...current.documentDrafts, [result.id]: hadDocuments ? current.documentDrafts[result.id] : attachmentDraft(pending.attachments) },
        sends: { ...current.sends, [result.id]: { id: pending.sendRequestId, content: pending.content, uncertain: true,
          ...(pending.attachments?.docPaths?.length ? { docPaths: [...pending.attachments.docPaths] } : {}),
          ...(pending.attachments?.documentNames?.length ? { documentNames: [...pending.attachments.documentNames] } : {}) } },
        ...(open ? { views: { ...current.views, [target.id]: { sessionId: result.id } }, newTaskProjectId: null } : {}),
      });
      try {
        const updated = savedPendingNewTask(target.id);
        const entry = readCancellationEntry(cancellationOutboxKey(target.id, pending.requestId));
        if (entry || updated?.requestId === pending.requestId && updated.state === "cancelling") {
          const latest = useDevelopmentStore.getState();
          if (latest.sends[result.id]?.id === pending.sendRequestId) latest.setSend(result.id, null);
          if (!latest.newTaskDrafts[target.id]) latest.setNewTaskDraft(target.id, entry?.draft ?? pending.draft);
          if (!latest.pendingNewTasks[target.id] || latest.pendingNewTasks[target.id].requestId === pending.requestId) latest.setPendingNewTask(target.id, entry?.pending ?? updated!);
          latest.setError(result.id, "上次提交正在放弃，输入已保留。");
          return false;
        }
        if (pending.attachments?.docPaths?.length) await developmentApi.send(result.id, pending.sendRequestId, pending.content, undefined, pending.attachments);
        else await developmentApi.send(result.id, pending.sendRequestId, pending.content);
        const latest = useDevelopmentStore.getState();
        if (latest.sends[result.id]?.id === pending.sendRequestId) {
          latest.setSend(result.id, null);
          if (!hadDocuments) latest.setDocumentDraft(result.id, (useDevelopmentStore.getState().documentDrafts[result.id] ?? []).filter((doc) => !pending.attachments?.docPaths?.includes(doc.path)));
          if (!hadDraft && useDevelopmentStore.getState().drafts[result.id] === pending.content) latest.setDraft(result.id, "");
        }
        refreshDevelopmentSession(result.id);
      } catch (cause) {
        const definite = cause instanceof DevelopmentApiError && cause.status >= 400 && cause.status < 500;
        const latest = useDevelopmentStore.getState();
        if (latest.sends[result.id]?.id === pending.sendRequestId) {
          if (definite) {
            latest.setSend(result.id, null);
            if ((hadDraft || hadDocuments) && !useDevelopmentStore.getState().newTaskDrafts[target.id]) latest.setNewTaskDraft(target.id, pending.draft);
          }
          latest.setError(result.id, cause instanceof Error ? cause.message : "发送失败。新会话和原输入已保留。");
        }
        return false;
      }
      setRefreshKey((n) => n + 1);
      return true;
    } catch (cause) {
      const latest = useDevelopmentStore.getState();
      if (cause instanceof DevelopmentApiError && cause.code === "creation_request_cancelled") {
        try { settleCancellation(target.id, pending.requestId, "上次提交不会继续发送。若此前已被接收，可在原会话查看任务状态；当前草稿已保留。"); }
        catch { setNewTaskError("上次提交已停止，但本地状态未能保存，请检查本地存储。"); }
      } else if (latest.pendingNewTasks[target.id]?.requestId === pending.requestId && cause instanceof DevelopmentApiError) {
        if (latest.pendingNewTasks[target.id]?.state === "pending" && latest.pendingNewTasks[target.id]?.attempt === pending.attempt) {
          if (["creation_request_conflict", "creation_request_deleted"].includes(cause.code)) latest.setPendingNewTask(target.id, { ...pending, state: "conflict" });
          else if (cause.status >= 400 && cause.status < 500 && ![408, 409].includes(cause.status)) {
            if (!continuing && pending.attempt === 1) latest.setPendingNewTask(target.id, null);
            if (taskNavigation.current === navigation) setNewTaskError(cause.message);
          }
        }
      }
      return false;
    } finally {
      creatingTask.current = false; setCreatingProjectId(null);
    }
  };
  const abandonNewTask = async (target: DevProject) => {
    if (creatingTask.current) return;
    const state = useDevelopmentStore.getState();
    let pending: PendingNewTask;
    try {
      const entry = readCancellationOutbox().find((item) => item.projectId === target.id);
      const current = entry?.pending ?? state.pendingNewTasks[target.id];
      if (!current) return;
      pending = { ...current, state: "cancelling", attempt: (current.attempt ?? 0) + 1 };
      const saved = savedPendingNewTask(target.id);
      if (!entry && saved && saved.requestId !== pending.requestId) throw new Error("different pending request");
      const rootPending = state.pendingNewTasks[target.id];
      const ownsDraft = (!rootPending || rootPending.requestId === pending.requestId) && (!saved || saved.requestId === pending.requestId);
      const restored = restoredOutboxKeys.current.has(cancellationOutboxKey(target.id, pending.requestId));
      const draft = ownsDraft && !restored ? state.newTaskDrafts[target.id] ?? entry?.draft : entry?.draft;
      saveCancellationOutbox({ projectId: target.id, pending, ...(draft ? { draft } : {}) });
      setOutboxState({ entries: readCancellationOutbox(), error: "" });
      if ((!rootPending || rootPending.requestId === pending.requestId) && (!saved || saved.requestId === pending.requestId)) {
        state.setPendingNewTask(target.id, pending);
        const persisted = savedPendingNewTask(target.id);
        if (persisted?.requestId !== pending.requestId || persisted.state !== "cancelling") throw new Error("draft persistence failed");
      }
    } catch {
      setNewTaskError("无法保存放弃状态，请检查本地存储后重试。");
      return;
    }
    creatingTask.current = true; setCreatingProjectId(target.id); setNewTaskError("");
    const navigation = taskNavigation.current;
    let confirmed = false;
    try {
      const result = await developmentApi.cancelSessionCreation(target.id, pending.requestId, pending.options, pending.sendRequestId);
      if (result.state !== "cancelled" && result.state !== "accepted" && result.state !== "rejected") throw new Error("invalid cancellation result");
      confirmed = true;
      settleCancellation(target.id, pending.requestId, result.state === "accepted"
        ? "原提交已被接收，任务状态可在原会话查看。当前草稿已保留。"
        : result.state === "rejected" ? "提交信息与已有记录不一致，已结束本地等待；已有会话和任务保留。当前草稿已保留。"
          : "上次提交已放弃，当前草稿已保留。");
    } catch {
      let stillPending = true;
      try { stillPending = readCancellationEntry(cancellationOutboxKey(target.id, pending.requestId))?.pending.attempt === pending.attempt; }
      catch { stillPending = true; }
      if (taskNavigation.current === navigation && (confirmed || stillPending)) {
        setNewTaskError(confirmed ? "放弃已确认，但本地状态未能保存，请检查本地存储。" : "暂未确认放弃，请再次尝试。原提交不会自动发送。");
      }
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
    const state = useDevelopmentStore.getState();
    state.setNewTaskProject(null);
    state.openSession(session.projectId, session.id);
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
      <ResizableHandle aria-label="调整项目列表宽度" className="z-10" />
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
                  value={cancellationDraft ?? newTasks[project.id] ?? { draft: "", executor: "mona", model: null, provider: null, effort: null }}
                  error={newTaskError || outboxState.error}
                  notice={newTaskNotices[project.id]}
                  busy={creatingProjectId === project.id}
                  pendingSubmission={currentCancellation ? "cancelling" : currentPending && remoteCancellations.current[project.id] === currentPending.requestId ? "cancelling" : currentPending?.state}
                  onContinueSubmission={() => { void submitNewTask(project, "", undefined, true); }}
                  onAbandonSubmission={() => { void abandonNewTask(project); }}
                  onChange={(value) => changeNewTaskDraft(project.id, value)}
                  onSubmit={(content, attachments) => submitNewTask(project, content, attachments)}
                  onToggleProjects={leftOpen ? undefined : () => setLeftOpen(true)} onManageModels={onOpenModelSettings} />
                : <DevelopmentPane key={focused?.id ?? project.id} session={focused} project={project} executors={executors} modelsLoading={modelsLoading} visible={visible} workspaceError={error} onRetryWorkspace={reloadWorkspace}
                  onRename={(value) => { setRename(value); setName(value.title); setRenameError(""); }} onUpdate={(value, changes) => void update(value, changes)}
                  onToggleProjects={leftOpen ? undefined : () => setLeftOpen(true)} onManageModels={onOpenModelSettings} onNew={() => beginNewTask(project)} creatingTask={creatingProjectId !== null}
                  onForkCreated={onForkCreated} onNavigateToSession={navigateToForkSource} />}
          </main>
        </ResizablePanel>
        {project && focused && hasWorkspace && <>
          <ResizableHandle aria-label="调整工作侧栏宽度" className="z-10" />
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
