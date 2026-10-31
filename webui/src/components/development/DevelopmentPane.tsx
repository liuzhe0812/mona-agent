import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, Code2, Folder, LoaderCircle, PanelLeft, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { ThreadComposer } from "@/components/thread/ThreadComposer";
import type { PendingMessage } from "@/hooks/usePendingQueue";
import { DevelopmentHeader } from "./DevelopmentHeader";
import { DevelopmentLoading } from "./DevelopmentLoading";
import type { ModelOption } from "@/components/models/model-sources";
import { developmentModels, developmentModelRoute } from "./development-models";
import { DevelopmentDecision } from "./DevelopmentDecisions";
import { DevelopmentPermissionSelector, type DevelopmentPermissionMode } from "./DevelopmentPermissionSelector";
import { DevelopmentBackgroundTasks } from "./DevelopmentBackgroundTasks";
import { DevelopmentUnknownResult } from "./DevelopmentUnknownResult";
import { DevelopmentUnknownInputs } from "./DevelopmentUnknownInputs";
import { DevelopmentTranscript } from "./DevelopmentTranscript";
import type { TimelineNavigation } from "./zcode/VirtualTimeline";
import { useTimelineScroll } from "./zcode/useTimelineScroll";
import { prependVirtualAnchorAdjustment } from "./zcode/timelineScrollAnchor";
import { DevelopmentMarkdown } from "./DevelopmentMarkdown";
import { DevelopmentTurnNavigator } from "./DevelopmentTurnNavigator";
import { buildDevelopmentTurns } from "./development-turns";
import { projectPendingGuideQueue } from "./zcode/pendingGuideProjection";
import { DevelopmentApiError, developmentApi, isRunActive, runLabels,
  type DevelopmentSendAttachments, type DevExecutor, type DevProject, type DevSession } from "@/lib/development-api";
import { cn } from "@/lib/utils";
import { developmentContextUsage } from "@/lib/context-usage";
import { attachmentDraft, EMPTY_DOCUMENTS, useDevelopmentStore } from "./store";
import { refreshDevelopmentSession, useDevelopmentSession } from "./useDevelopmentSession";

type ActionIssue = { scope: "send" | "stop" | "history" | "model" | "queue" | "permissions" | "fork"; message: string; inputId?: string };

export function DevelopmentPane({ session, project, executors, modelsLoading = false, visible = true, onToggleProjects, onNew, creatingTask = false, compact = false, onUseAnswer, onManageModels, onRename, onUpdate, fileSessionId, workspaceError, onRetryWorkspace, onForkCreated, onNavigateToSession }: {
  session: DevSession | null; project?: DevProject; executors: DevExecutor[]; visible?: boolean;
  modelsLoading?: boolean;
  onToggleProjects?: () => void; onNew?: () => void; creatingTask?: boolean; compact?: boolean; onUseAnswer?: (text: string) => void; onManageModels?: () => void;
  onForkCreated?: (session: DevSession) => void; onNavigateToSession?: (sessionId: string) => boolean;
  onRename?: (session: DevSession) => void;
  onUpdate?: (session: DevSession, changes: Partial<Pick<DevSession, "pinned" | "archived">>) => void;
  fileSessionId?: string;
  workspaceError?: string; onRetryWorkspace?: () => void;
}) {
  const id = session?.id ?? null;
  const snapshot = useDevelopmentSession(id, visible);
  const turns = useMemo(() => buildDevelopmentTurns(snapshot?.messages ?? [], snapshot?.runs ?? [], snapshot?.live), [snapshot?.messages, snapshot?.runs, snapshot?.live]);
  const current = snapshot?.session ?? session;
  const queue = useMemo(() => projectPendingGuideQueue({ items: (snapshot?.pendingInputs ?? [])
    .filter((item) => item.intent !== "steering" || item.state !== "unknown").map((item, admissionSeq) => {
    const message = snapshot?.messages.find((entry) => entry.id === item.messageId);
    return { ...item, queueItemId: item.id, sourceCommandId: item.id, clientId: item.id,
      text: message?.content || item.source?.content || item.source?.documentNames?.join("、") || "",
      attachments: message?.media, admittedAt: item.createdAt ?? message?.timestamp ?? "", order: { admissionSeq },
      delivery: { admitted: item.intent === "steering" ? "guide" as const : "queue" as const } };
  }) }), [snapshot?.pendingInputs, snapshot?.messages]);
  const draft = useDevelopmentStore((s) => id ? s.drafts[id] ?? "" : "");
  const documents = useDevelopmentStore((s) => id ? s.documentDrafts[id] ?? EMPTY_DOCUMENTS : EMPTY_DOCUMENTS);
  const error = useDevelopmentStore((s) => id ? s.errors[id] : "");
  const pending = useDevelopmentStore((s) => id ? s.sends[id] : undefined);
  const unknownGuides = (snapshot?.pendingInputs ?? []).filter((item) => item.intent === "steering" && item.state === "unknown");
  const approvalDecisionId = useDevelopmentStore((s) => id ? s.sides[id]?.approvalDecisionId : undefined);
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [queueBusy, setQueueBusy] = useState(false);
  const queueRequest = useRef(false);
  const [switching, setSwitching] = useState(false);
  const [actionError, setActionError] = useState<ActionIssue | null>(null);
  const [permissionChoice, setPermissionChoice] = useState<DevelopmentPermissionMode | null>(null);

  const [failureOpen, setFailureOpen] = useState(false);
  const [statusDialogOpen, setStatusDialogOpen] = useState(false);
  const [overviewSessionId, setOverviewSessionId] = useState<string | null>(null);
  const overviewOpen = !!id && overviewSessionId === id && visible && !compact;
  const setOverviewOpen = useCallback((open: boolean) => setOverviewSessionId(open ? id : null), [id]);
  const [paneWidth, setPaneWidth] = useState(0);
  const pane = useRef<HTMLElement>(null);
  const overviewContainer = useRef<HTMLElement>(null);
  const feed = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const timelineNavigation = useRef<TimelineNavigation | null>(null);
  const loadingOlder = useRef(false);
  const [showLatest, setShowLatest] = useState(false);
  const run = snapshot?.runs[0];
  const active = isRunActive(run);
  const unresolved = run?.status === "unknown" || run?.status === "recovering";
  const blocksRunControls = active || unresolved;
  const canFork = !!current && !!onForkCreated && !current.readonly && !current.parentSessionId;
  const canSteer = current?.executor === "mona"
    ? ["preparing", "running", "waiting_user"].includes(run?.status ?? "")
    : !!snapshot?.nativeBinding?.steering && ["running", "waiting_user"].includes(run?.status ?? "");
  const permissions = (snapshot?.pendingDecisions ?? []).filter((decision) => decision.kind === "permission");
  const questions = (snapshot?.pendingDecisions ?? []).filter((decision) => decision.kind === "question");
  const permission = permissions.find((decision) => decision.id === approvalDecisionId) ?? permissions[0];
  const executor = executors.find((e) => e.id === current?.executor);
  const models = developmentModels(executors, current);
  const contextUsage = current ? developmentContextUsage(snapshot?.events ?? [], current, models.find((option) => option.active)?.contextWindow ?? null) : null;
  useEffect(() => { setActionError(null); setStatusDialogOpen(false); setPermissionChoice(null); }, [id]);
  useEffect(() => { setOverviewOpen(false); }, [id, visible, compact, setOverviewOpen]);
  useLayoutEffect(() => {
    const element = pane.current;
    if (!element) return;
    const measure = () => setPaneWidth(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const overviewDocked = paneWidth >= 640 + 280 + 24;
  const overviewWidth = overviewDocked ? Math.min(300, paneWidth - 640 - 24) : 300;

  const timelineScroll = useTimelineScroll({ scrollRef: scroll, contentRef: feed, followingRef: follow,
    sessionKey: id, visible, rowCount: snapshot?.messages.length ?? 0, revision: snapshot,
    rowWindowKey: `${snapshot?.messages.length ?? 0}:${snapshot?.messages[0]?.id ?? "none"}:${snapshot?.messages.at(-1)?.id ?? "none"}`,
    onFollowingChange: setShowLatest, canLoadOlder: snapshot?.before != null, loadingOlder,
    onLoadOlder: () => { void loadOlder(); } });
  const send = async (content?: string, intent?: "steering" | "follow_up", attachments?: DevelopmentSendAttachments, targetRunId?: string) => {
    if (!id || !snapshot || modelsLoading || !executor?.available || sending || switching) return false;
    const state = useDevelopmentStore.getState();
    const known = state.sends[id];
    if (unresolved && !known) return false;
    const text = known?.content ?? content ?? state.drafts[id] ?? "";
    if (!text.trim() && !(known?.docPaths?.length || attachments?.docPaths?.length)) return false;
    const request = known ?? { id: `request_${crypto.randomUUID().replaceAll("-", "")}`, content: text, uncertain: false,
      intent: intent ?? (active && current?.executor === "mona" ? "follow_up" : undefined),
      ...(targetRunId ? { targetRunId } : {}),
      ...(attachments?.docPaths?.length ? { docPaths: [...attachments.docPaths] } : {}),
      ...(attachments?.documentNames?.length ? { documentNames: [...attachments.documentNames] } : {}),
    };
    state.setSend(id, request); setSending(true); setActionError(null);
    try {
      const attachmentOptions = request.docPaths?.length
        ? { docPaths: request.docPaths, documentNames: request.documentNames }
        : undefined;
      const result = request.targetRunId
        ? await developmentApi.send(id, request.id, text, request.intent, attachmentOptions, request.targetRunId)
        : attachmentOptions ? await developmentApi.send(id, request.id, text, request.intent, attachmentOptions)
          : request.intent ? await developmentApi.send(id, request.id, text, request.intent)
            : await developmentApi.send(id, request.id, text);
      if (request.intent === "steering" && ["unknown", "reserved"].includes(result?.input?.state ?? "")) {
        throw new DevelopmentApiError(409, "native_steering_unknown", "未确认引导消息是否送达，请核对原任务。原输入已保留。");
      }
      state.setSend(id, null);
      state.setDocumentDraft(id, (useDevelopmentStore.getState().documentDrafts[id] ?? []).filter((doc) => !request.docPaths?.includes(doc.path)));
      if (useDevelopmentStore.getState().drafts[id]?.trim() === text.trim()) state.setDraft(id, "");
      refreshDevelopmentSession(id);
      return true;
    } catch (cause) {
      const definite = cause instanceof DevelopmentApiError && cause.status >= 400 && cause.status < 500 && cause.code !== "native_steering_unknown";
      state.setSend(id, definite ? null : { ...request, uncertain: true });
      setActionError({ scope: "send", message: cause instanceof Error ? cause.message : "发送失败。原输入已保留。" });
      return false;
    } finally { setSending(false); }
  };
  const queuedMessages: (PendingMessage & { locked: boolean })[] = queue.visibleQueue.items.map((item) => ({
    id: item.id,
    content: item.text,
    locked: item.state !== "pending" || queueBusy || sending || !!pending || !!current?.archived,
  }));
  const changeQueued = async (inputId: string, action: "remove" | "edit" | "append") => {
    if (!id || queueRequest.current || sending || pending) return;
    const queued = queuedMessages.find((item) => item.id === inputId);
    if (!queued || queued.locked) return;
    const sourceInput = snapshot?.pendingInputs.find((item) => item.id === inputId);
    const source = sourceInput?.source;
    const content = source?.content ?? queued.content;
    queueRequest.current = true; setQueueBusy(true); setActionError(null);
    try {
      if (action === "append") {
        if (!run || !canSteer || !sourceInput) return;
        const result = await developmentApi.guideInput(id, inputId, sourceInput.revision, run.id);
        if (["unknown", "reserved"].includes(result.input.state)) {
          throw new DevelopmentApiError(409, "native_steering_unknown", "引导结果待核对，原消息已保留，不会重复发送。");
        }
        refreshDevelopmentSession(id);
        return;
      }
      await developmentApi.cancelInput(id, inputId);
      const state = useDevelopmentStore.getState();
      const latest = state.snapshots[id];
      if (latest) state.setSnapshot(id, { ...latest, pendingInputs: latest.pendingInputs.filter((item) => item.id !== inputId) });
      if (action === "edit") {
        state.setDraft(id, content);
        state.setDocumentDraft(id, attachmentDraft(source));
      }
      refreshDevelopmentSession(id);
    } catch (cause) {
      if (cause instanceof DevelopmentApiError && cause.code === "native_steering_rejected") {
        const state = useDevelopmentStore.getState();
        state.appendDraft(id, content);
        state.setDocumentDraft(id, [...new Map([...(state.documentDrafts[id] ?? []), ...attachmentDraft(source)].map((doc) => [doc.path, doc])).values()]);
      }
      setActionError({ scope: "queue", inputId, message: cause instanceof Error ? cause.message : "消息操作失败，请重试。" });
      refreshDevelopmentSession(id);
    } finally { queueRequest.current = false; setQueueBusy(false); }
  };
  const stop = async () => {
    if (!id || !run || stopping) return;
    setStopping(true); setActionError(null);
    try { await developmentApi.interrupt(id, run.id); refreshDevelopmentSession(id); }
    catch (cause) { setActionError({ scope: "stop", message: cause instanceof Error ? cause.message : "未确认任务已停止" }); }
    finally { setStopping(false); }
  };
  const loadOlder = async () => {
    if (!id || snapshot?.before == null || loadingOlder.current) return;
    loadingOlder.current = true;
    const element = scroll.current;
    const previousTop = element?.scrollTop;
    const virtualAnchor = timelineNavigation.current?.capturePrependAnchor();
    const anchor = element ? [...element.querySelectorAll<HTMLElement>("[data-message-id]")]
      .find((node) => node.getBoundingClientRect().bottom > element.getBoundingClientRect().top) : undefined;
    const anchorTop = anchor?.getBoundingClientRect().top;
    try {
      const older = await developmentApi.snapshot(id, 0, snapshot.before);
      follow.current = false;
      const preserve = element && element.scrollTop === previousTop;
      useDevelopmentStore.getState().setSnapshot(id, older, true);
      requestAnimationFrame(() => {
        if (!timelineScroll.restoringRef.current && !virtualAnchor && preserve && scroll.current === element && anchor?.isConnected && anchorTop !== undefined) {
          const key = anchor.dataset.messageId!;
          const offsetTop = anchorTop - element.getBoundingClientRect().top;
          const nextStart = element.scrollTop + anchor.getBoundingClientRect().top - element.getBoundingClientRect().top;
          const delta = prependVirtualAnchorAdjustment({ key, offsetTop, start: previousTop! + offsetTop }, { key, offsetTop, start: nextStart }, element.scrollTop);
          if (delta !== null) element.scrollTop += delta;
        }
      });
    } catch (cause) { setActionError({ scope: "history", message: cause instanceof Error ? cause.message : "历史读取失败" }); }
    finally { loadingOlder.current = false; }
  };
  const jumpToTurn = (messageId: string) => {
    const element = scroll.current;
    const anchor = element && [...element.querySelectorAll<HTMLElement>("[data-message-id]")].find((node) => node.dataset.messageId === messageId);
    if (!element) return;
    timelineScroll.detachForNavigation(); setShowLatest(true);
    if (!anchor) { timelineNavigation.current?.scrollToMessage(messageId); return; }
    element.scrollTo({ top: Math.max(0, element.scrollTop + anchor.getBoundingClientRect().top - element.getBoundingClientRect().top - 16),
      behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  };
  const selectModel = async (option: ModelOption, effort?: string | null) => {
    if (!current || !id || !snapshot || active || switching || sending || pending) return;
    setSwitching(true); setActionError(null);
    try {
      const selected = await developmentApi.selectModelSource(current, developmentModelRoute(option, effort));
      const state = useDevelopmentStore.getState();
      const latest = state.snapshots[id];
      if (latest) state.setSnapshot(id, { ...latest, session: selected });
      refreshDevelopmentSession(id);
    }
    catch (cause) { throw cause; }
    finally { setSwitching(false); }
  };
  const returnLatest = timelineScroll.handleBackToBottom;
  const savePermissions = async (mode: DevelopmentPermissionMode, confirmed = false) => {
    if (!current || !id || active || sending || switching || pending || current.readonly || current.parentSessionId) return;
    setSwitching(true); setActionError(null);
    try {
      const selected = await developmentApi.permissions(current, mode, confirmed);
      const state = useDevelopmentStore.getState();
      const latest = state.snapshots[id];
      if (latest) state.setSnapshot(id, { ...latest, session: selected });
      refreshDevelopmentSession(id);
    } catch (cause) {
      setActionError({ scope: "permissions", message: cause instanceof Error ? cause.message : "权限切换失败，原设置已保留。" });
    } finally { setSwitching(false); }
  };
  const selectPermissions = async (mode: DevelopmentPermissionMode) => {
    if (mode === "full_access" && current?.permissionMode !== mode) setPermissionChoice(mode);
    else await savePermissions(mode);
  };
  const forkMessage = async (messageId: string, requestId: string) => {
    if (!current || !canFork) return;
    setActionError(null);
    const child = await developmentApi.forkSession(current, messageId, requestId);
    onForkCreated?.(child);
  };
  const reportForkError = (cause: unknown) => setActionError({ scope: "fork", message: cause instanceof Error ? cause.message : "分叉会话失败，请重试。" });
  const returnToForkSource = (sourceSessionId: string) => {
    if (onNavigateToSession?.(sourceSessionId)) return;
    setActionError({ scope: "fork", message: `原任务「${current?.forkSource?.sourceTitle ?? ""}」已不存在，无法返回。` });
  };
  const failure = actionError?.message || error || workspaceError
    || (run?.status === "failed" && run.errorCode === "native_session_not_found"
      ? "连接已失效，本次请求未执行。请重新发送消息，系统会自动恢复连接。" : "")
    || (run?.status === "failed" && run.errorCode?.startsWith("collaboration_")
      ? "子任务结果未处理完成。已有记录仍保留，请核对任务与当前模型后继续。" : "");
  useEffect(() => { setFailureOpen(!!failure); }, [failure, actionError, id, run?.id]);
  const needsAttention = !!(pending?.uncertain || !modelsLoading && executors.length > 0 && !executor?.available
    || run?.status === "unknown" || questions.length || unknownGuides.length);
  const hasStatus = !!current && !!(needsAttention || snapshot?.before != null);
  useEffect(() => { if (!hasStatus) setStatusDialogOpen(false); }, [hasStatus]);
  useEffect(() => { setStatusDialogOpen(false); }, [id]);
  const statusContent = hasStatus && current && <div className="space-y-3 text-caption">
    {questions.map((decision) => <DevelopmentDecision key={decision.id} decision={decision} />)}
    {run?.status === "unknown" && <DevelopmentUnknownResult key={run.id} run={run} binding={snapshot?.nativeBinding}
      onStop={stop} stopping={stopping} />}
    {!!unknownGuides.length && <DevelopmentUnknownInputs key={current.id} sessionId={current.id} inputs={unknownGuides} />}
    {pending?.uncertain && !unknownGuides.some((item) => item.id === pending.id) && <div role="status" aria-label="发送状态待核对" className="space-y-2 text-warning"><p>上次发送结果待核对。核对时沿用原请求，不会重复启动任务。</p><Button variant="outline" size="sm" disabled={sending || switching || !executor?.available || current.archived} onClick={() => void send()}>核对发送</Button></div>}
    {snapshot?.before != null && <Button variant="ghost" size="sm" onClick={() => void loadOlder()}>读取较早消息</Button>}
    {!modelsLoading && executors.length > 0 && !executor?.available && <p role="status" className="text-muted-foreground">{executor?.reason ?? "当前模型不可用"}{onManageModels && <Button variant="ghost" size="sm" className="ml-2" onClick={onManageModels}>配置模型</Button>}</p>}
  </div>;
  return <Dialog open={statusDialogOpen} onOpenChange={setStatusDialogOpen}><DevelopmentMarkdown project={project} sessionId={fileSessionId ?? id}><section ref={pane} data-testid="development-pane" aria-label={current?.title ?? "空开发会话"}
    className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background">
    {project && current && !compact ? <DevelopmentHeader key={current.id} project={project} session={current} executors={executors} visible={visible} onToggleProjects={onToggleProjects} onRename={onRename} onUpdate={onUpdate} onOpenStatus={() => setStatusDialogOpen(true)} hasStatus={hasStatus} needsAttention={needsAttention}
      overviewOpen={overviewOpen} onOverviewOpenChange={setOverviewOpen} overviewContainer={overviewContainer.current} overviewDocked={overviewDocked} /> : <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border/50 px-4">
      {onToggleProjects && <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="切换项目列表" onClick={onToggleProjects}><PanelLeft className="h-4 w-4" /></Button>}
      {project && <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />}
      <span className="min-w-0 flex-1 truncate text-ui font-medium" title={current?.title ?? project?.displayName}>{current?.title ?? project?.displayName ?? "开发会话"}</span>
      {run && <span role="status" className={cn("flex shrink-0 items-center gap-1.5 text-caption text-muted-foreground", run.status === "failed" && "text-destructive")}>
        {active && !["unknown", "waiting_user"].includes(run.status) && <LoaderCircle className="h-3 w-3 animate-spin motion-reduce:animate-none" />}{runLabels[run.status]}</span>}
      {hasStatus && <DialogTrigger asChild><Button variant="ghost" size="sm" className="relative h-7 px-2 text-caption" aria-label="任务状态与操作">状态{needsAttention && <span aria-hidden className="ml-1 h-1.5 w-1.5 rounded-full bg-warning" />}</Button></DialogTrigger>}
      {onNew && <Button size="icon" variant="ghost" className="h-7 w-7" aria-label="新建开发任务" disabled={creatingTask} onClick={onNew}>{creatingTask ? <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <Plus className="h-4 w-4" />}</Button>}
    </header>}
    {!current ? <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-5 text-center text-muted-foreground">
      <Code2 className="h-8 w-8 opacity-40" /><p className="text-ui">从左侧打开任务，或创建新的开发会话。</p>
      {onNew && <Button variant="outline" size="sm" disabled={creatingTask} onClick={onNew}>{creatingTask ? "正在新建…" : "新建开发任务"}</Button>}
    </div> : <div className="relative flex min-h-0 flex-1">
    <div className="development-conversation relative min-h-0 min-w-0 flex-1">
      <DevelopmentTurnNavigator key={current.id} items={turns} scrollRef={scroll} contentRef={feed} onJump={jumpToTurn} hasOlder={snapshot?.before != null} loadOlder={loadOlder} />
      <div ref={scroll} {...timelineScroll.props}
        aria-label="开发会话记录" className="scrollbar-thin absolute inset-0 overflow-y-auto overscroll-contain">
        <div ref={feed} className="flex min-h-full flex-col">
        <div className="development-conversation-content flex-1">
        {snapshot ? <DevelopmentTranscript messages={snapshot.messages} events={snapshot.events} runs={snapshot.runs} pendingGuides={queue.pendingGuides} sessionId={current.id} visible={visible} live={snapshot.live} scrollRef={scroll} followingRef={follow} navigationRef={timelineNavigation} onLayoutScroll={timelineScroll.recordLayoutScroll} restoringRef={timelineScroll.restoringRef} showRunHeaders onUseAnswer={onUseAnswer}
          canFork={canFork} onFork={forkMessage} onForkError={reportForkError} forkSource={current.forkSource}
          onReturnToForkSource={onNavigateToSession ? returnToForkSource : undefined} /> : !error && <DevelopmentLoading label="正在读取会话…" />}
        </div>
      <footer className="sticky bottom-0 z-10 mt-auto shrink-0 bg-background">
        <div aria-hidden className="pointer-events-none absolute inset-x-0 -top-12 h-12 bg-gradient-to-t from-background to-transparent" />
        {showLatest && <TooltipProvider delayDuration={250}><Tooltip><TooltipTrigger asChild>
          <Button variant="outline" size="icon" aria-label="返回最新消息" onClick={returnLatest}
            className="group/latest absolute bottom-full left-1/2 z-20 mb-3 -translate-x-1/2 rounded-full border-border/70 bg-background text-muted-foreground shadow-sm hover:bg-background hover:text-foreground">
            {active && <span aria-hidden className="flex items-center gap-1 group-hover/latest:hidden group-focus-visible/latest:hidden">
              {[0, 150, 300].map((delay) => <span key={delay} className="h-1 w-1 animate-bounce rounded-full bg-current motion-reduce:animate-none" style={{ animationDelay: `${delay}ms` }} />)}
            </span>}
            <ArrowDown aria-hidden className={cn("h-4 w-4", active && "hidden group-hover/latest:block group-focus-visible/latest:block")} />
          </Button>
        </TooltipTrigger><TooltipContent side="top">返回最新消息</TooltipContent></Tooltip></TooltipProvider>}
        <div className="relative mx-auto w-full max-w-4xl space-y-2 px-5 pb-4 pt-2">
        {permission && <div aria-label="操作授权">
          {permissions.length > 1 && <div className="mb-2 flex justify-end gap-1">
            {permissions.map((item, index) => <Button key={item.id} variant={item.id === permission.id ? "secondary" : "ghost"} size="xs"
              aria-label={`查看第 ${index + 1} 个授权请求`} aria-pressed={item.id === permission.id}
              onClick={() => useDevelopmentStore.getState().setSide(current.id, { approvalDecisionId: item.id })}>{index + 1}</Button>)}
          </div>}
          <DevelopmentDecision key={permission.id} decision={permission} autoFocus={visible} />
        </div>}
        <div hidden={!!permission}><ThreadComposer chatId={current.id} value={draft}
          documentDraft={documents} onDocumentDraftChange={(value) => useDevelopmentStore.getState().setDocumentDraft(current.id, value)} awaitSendResult
          contextUsage={contextUsage}
          onValueChange={(value) => useDevelopmentStore.getState().setDraft(current.id, value)}
          onSend={(content, _images, options) => send(content, undefined, {
            docPaths: options?.docPaths, documentNames: options?.documentNames,
          })} clearOnSend={false}
          autoFocus={visible && !permission && !compact && snapshot?.messageCount === 0}
          inputLabel={current.readonly ? "侧边聊天输入" : "开发任务输入"} sendLabel="发送开发任务" stopLabel={run?.status === "waiting_children" ? "停止等待子任务" : "中断当前轮次"}
          sendDisabled={!snapshot || modelsLoading || sending || switching || !!pending || queueBusy || !executor?.available || current.archived || unresolved}
          isStreaming={active} stopping={stopping || run?.status === "interrupting"} onStop={() => void stop()}
          imageInputEnabled={false}
          modelOptions={models} modelLabel={models.find((option) => option.active)?.label ?? current.model ?? "选择模型"}
          modelDisabled={modelsLoading || !snapshot || blocksRunControls || switching || sending || queueBusy || !!pending} currentExecutor={current.executor}
          onModelSelect={(option, effort) => selectModel(option, effort)} onOpenSettings={onManageModels}
          leadingActions={<><DevelopmentPermissionSelector mode={current.permissionMode ?? "ask"} readonly={current.readonly}
            disabled={!snapshot || !executor?.available || blocksRunControls || switching || sending || queueBusy || !!pending || !!current.parentSessionId || current.archived}
            onChange={selectPermissions} />
            <DevelopmentBackgroundTasks sessionId={current.id} commands={snapshot?.backgroundCommands ?? []} readonly={current.readonly} /></>}
          pendingMessages={queuedMessages} isPendingFull={queuedMessages.length >= 3}
          onPendingRemove={(inputId) => void changeQueued(inputId, "remove")}
          onPendingEdit={(inputId) => changeQueued(inputId, "edit")}
          onPendingAppend={canSteer
            ? (inputId) => void changeQueued(inputId, "append") : undefined}
          /></div>
        {modelsLoading && <DevelopmentLoading label="正在读取模型…" variant="inline" />}
        </div>
      </footer>
        </div>
      </div>
      <div aria-hidden className="pointer-events-none absolute left-0 right-2 top-0 z-10 h-6 bg-gradient-to-b from-background to-transparent" />
    </div>
    <aside ref={overviewContainer} hidden={!overviewOpen} aria-label="任务摘要"
      className={cn("pointer-events-none min-h-0", overviewDocked
        ? "relative mx-3 my-2 shrink-0 self-stretch" : "absolute bottom-3 right-3 top-2 z-40 max-w-[calc(100%-24px)]")}
      style={{ width: overviewWidth }} />
    </div>}
  </section>
    <DialogContent className="max-h-[85vh] overflow-y-auto"><DialogHeader><DialogTitle>任务状态与操作</DialogTitle><DialogDescription>处理任务提问、未确认结果或发送状态。</DialogDescription></DialogHeader>{statusContent}</DialogContent>
    <Dialog open={permissionChoice !== null} onOpenChange={(open) => { if (!open) setPermissionChoice(null); }}><DialogContent>
      <DialogHeader><DialogTitle>启用完全访问</DialogTitle><DialogDescription>允许当前会话访问项目外文件并执行命令，后续操作将跳过常规审批。只读任务仍保持只读。</DialogDescription></DialogHeader>
      <DialogFooter><Button variant="outline" onClick={() => setPermissionChoice(null)}>取消</Button>
        <Button onClick={() => { const mode = permissionChoice; setPermissionChoice(null); if (mode) void savePermissions(mode, true); }}>授权完全访问</Button></DialogFooter>
    </DialogContent></Dialog>
    <Dialog open={failureOpen && !!failure} onOpenChange={setFailureOpen}><DialogContent>
      <DialogHeader><DialogTitle>操作未完成</DialogTitle><DialogDescription className="break-words">{failure}</DialogDescription></DialogHeader>
      <DialogFooter>
        {error && <Button variant="outline" onClick={() => { if (id) refreshDevelopmentSession(id); }}>重新读取会话</Button>}
        {workspaceError && onRetryWorkspace && <Button variant="outline" onClick={onRetryWorkspace}>重试读取项目与模型</Button>}
        <Button onClick={() => setFailureOpen(false)}>知道了</Button>
      </DialogFooter>
    </DialogContent></Dialog>
  </DevelopmentMarkdown></Dialog>;
}
