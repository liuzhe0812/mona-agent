import { useEffect, useRef, useState } from "react";
import { ArrowLeft, CircleAlert, LoaderCircle, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { effortLabel } from "@/components/models/model-sources";
import { developmentApi, isRunActive, type DevProject, type DevSession, type DevSnapshot } from "@/lib/development-api";
import { DevelopmentMarkdown } from "./DevelopmentMarkdown";
import { DevelopmentTranscript } from "./DevelopmentTranscript";
import { DevelopmentDecision } from "./DevelopmentDecisions";
import { DevelopmentUnknownResult } from "./DevelopmentUnknownResult";
import { SubagentAvatar } from "./subagent-tasks";
import { useDevelopmentStore } from "./store";
import { refreshDevelopmentSession, useDevelopmentSession } from "./useDevelopmentSession";
import { prependVirtualAnchorAdjustment } from "./zcode/timelineScrollAnchor";
import type { TimelineNavigation } from "./zcode/VirtualTimeline";

type ReadIssue = "snapshot" | "history" | "membership" | "membership-read" | "ownership";

function belongsToParent(snapshot: DevSnapshot, childId: string, parent: DevSession, project: DevProject) {
  return snapshot.session.id === childId && snapshot.session.parentSessionId === parent.id
    && snapshot.session.projectId === parent.projectId && project.id === parent.projectId;
}

export function DevelopmentSubagentDetail({ parent, project, childId, visible, onBack }: {
  parent: DevSession; project: DevProject; childId: string; visible: boolean; onBack: () => void;
}) {
  const snapshot = useDevelopmentSession(childId, visible);
  const readError = useDevelopmentStore((state) => state.errors[childId]);
  const valid = !!snapshot && belongsToParent(snapshot, childId, parent, project);
  const [member, setMember] = useState<boolean | null>(null);
  const [taskTitle, setTaskTitle] = useState<string | null>(null);
  const [dispatchMessageId, setDispatchMessageId] = useState<string | null>(null);
  const [issue, setIssue] = useState<ReadIssue | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [actionError, setActionError] = useState("");
  const stopPending = useRef(false);
  const loadingOlderRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const navigationRef = useRef<TimelineNavigation | null>(null);

  useEffect(() => {
    setIssue(null);
    setMember(null);
    setTaskTitle(null);
    setDispatchMessageId(null);
    loadingOlderRef.current = false;
    setActionsOpen(false);
    setActionError("");
    setLoadingOlder(false);
  }, [childId]);
  useEffect(() => {
    let active = true;
    void developmentApi.collaborations(parent.id).then((records) => {
      if (!active) return;
      const record = records.find((record) => record.parentSessionId === parent.id && record.childSessionId === childId);
      const exists = !!record;
      setTaskTitle(record?.title ?? null);
      setDispatchMessageId(record?.latestRun?.requestMessageId ?? null);
      setMember(exists);
      if (!exists) setIssue("membership");
    }).catch(() => {
      if (active) setIssue("membership-read");
    });
    return () => { active = false; };
  }, [parent.id, childId]);
  useEffect(() => {
    if (member === false) setIssue("membership");
    else if (member && snapshot && !valid) setIssue("ownership");
    else if (member && readError) setIssue("snapshot");
    else if (member && valid) setIssue((current) => current === "ownership" || current === "snapshot" || current === "membership" ? null : current);
  }, [member, snapshot, valid, readError]);

  const loadOlder = async () => {
    if (member !== true || !valid || !snapshot || snapshot.before == null || loadingOlderRef.current) return false;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    const element = scrollRef.current;
    const previousTop = element?.scrollTop;
    const virtualAnchor = navigationRef.current?.capturePrependAnchor() ?? false;
    const anchor = element ? [...element.querySelectorAll<HTMLElement>("[data-message-id]")]
      .find((node) => node.getBoundingClientRect().bottom > element.getBoundingClientRect().top) : undefined;
    const anchorTop = anchor?.getBoundingClientRect().top;
    try {
      const older = await developmentApi.snapshot(childId, 0, snapshot.before);
      if (!belongsToParent(older, childId, parent, project)) {
        setIssue("ownership");
        return false;
      }
      followingRef.current = false;
      const preserve = element && element.scrollTop === previousTop;
      useDevelopmentStore.getState().setSnapshot(childId, older, true);
      requestAnimationFrame(() => {
        if (!virtualAnchor && preserve && scrollRef.current === element && anchor?.isConnected && anchorTop !== undefined) {
          const offsetTop = anchorTop - element.getBoundingClientRect().top;
          const nextStart = element.scrollTop + anchor.getBoundingClientRect().top - element.getBoundingClientRect().top;
          const delta = prependVirtualAnchorAdjustment({ key: anchor.dataset.messageId!, offsetTop, start: previousTop! + offsetTop },
            { key: anchor.dataset.messageId!, offsetTop, start: nextStart }, element.scrollTop);
          if (delta !== null) element.scrollTop += delta;
        }
      });
      setIssue(null);
      return true;
    } catch {
      setIssue("history");
      return false;
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  };

  const retry = async () => {
    if (retrying) return;
    if (issue === "history" && member && snapshot?.before != null) {
      setRetrying(true);
      await loadOlder();
      setRetrying(false);
      return;
    }
    setRetrying(true);
    try {
      let records;
      try { records = await developmentApi.collaborations(parent.id); }
      catch { setMember(null); setIssue("membership-read"); return; }
      const record = records.find((record) => record.parentSessionId === parent.id && record.childSessionId === childId);
      const exists = !!record;
      setTaskTitle(record?.title ?? null);
      setDispatchMessageId(record?.latestRun?.requestMessageId ?? null);
      setMember(exists);
      if (!exists) { setIssue("membership"); return; }
      const value = await developmentApi.snapshot(childId);
      if (!belongsToParent(value, childId, parent, project)) {
        setIssue("ownership");
        return;
      }
      useDevelopmentStore.getState().setSnapshot(childId, value);
      setIssue(null);
    } catch {
      setIssue("snapshot");
    } finally {
      setRetrying(false);
    }
  };

  const authorized = member === true && valid;
  const current = authorized ? snapshot.session : undefined;
  const transcriptMessages = snapshot?.messages.filter((message) => message.id !== dispatchMessageId) ?? [];
  const run = authorized ? snapshot.runs[0] : undefined;
  const decisions = authorized ? snapshot.pendingDecisions ?? [] : [];
  const permission = decisions.find((decision) => decision.kind === "permission");
  const needsAction = decisions.length > 0 || run?.status === "unknown";
  const stop = async () => {
    if (!authorized || !run || stopPending.current) return;
    stopPending.current = true; setStopping(true); setActionError("");
    try {
      await developmentApi.interrupt(childId, run.id);
      refreshDevelopmentSession(childId);
      refreshDevelopmentSession(parent.id);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "未确认子任务已停止，请重试。");
      setActionsOpen(true);
    } finally { stopPending.current = false; setStopping(false); }
  };
  const model = current?.model
    ? `${current.model}${current.modelReasoningEffort ? ` · ${effortLabel(current.modelReasoningEffort)}` : ""}`
    : "";
  const issueText = issue === "history" ? "更早的任务记录暂时无法读取，请重试。"
    : issue === "membership" ? "此子智能体任务已不属于当前主任务，因此没有显示任务内容。"
      : issue === "membership-read" ? "暂时无法确认此子智能体任务是否属于当前主任务，请重试。"
        : issue === "ownership" ? "无法确认子智能体任务归属，因此没有显示任务内容。"
          : "无法读取子智能体任务内容，请重试。";
  const closeIssue = () => {
    setIssue(null);
    if (!authorized) onBack();
  };

  return <DevelopmentMarkdown project={project} sessionId={parent.id}>
    <section aria-label="子智能体任务详情" className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border/50 px-3">
        <Button variant="ghost" size="icon" aria-label="返回子智能体列表" onClick={onBack}><ArrowLeft className="h-4 w-4" /></Button>
        <SubagentAvatar id={childId} className="h-6 w-6 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-ui font-medium">{taskTitle ?? current?.title ?? "子智能体任务"}</span>
        {model && <span className="min-w-0 max-w-[40%] shrink truncate text-caption text-muted-foreground" title={model}>{model}</span>}
        {needsAction && <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0 text-warning" aria-label="处理子任务待办" onClick={() => {
          if (permission) {
            useDevelopmentStore.getState().setSide(parent.id, { maximized: false, approvalDecisionId: permission.id });
            refreshDevelopmentSession(parent.id);
          } else setActionsOpen(true);
        }}><CircleAlert className="h-4 w-4" /></Button>}
        {run && isRunActive(run) && !["unknown", "recovering"].includes(run.status) && <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" aria-label="停止此子任务" disabled={stopping || run.status === "interrupting"} onClick={() => void stop()}>{stopping ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Square className="h-3.5 w-3.5" />}</Button>}
      </header>
      <div className="development-conversation relative min-h-0 flex-1">
        <div ref={scrollRef} aria-label="子智能体任务记录" className="scrollbar-thin absolute inset-0 overflow-y-auto overscroll-contain">
          <div className="flex min-h-full flex-col">
            {authorized && <div className="development-conversation-content flex-1 px-4 py-6 @min-[864px]/development-conversation:px-16">
              {snapshot.before != null && <div className="flex justify-center py-3">
                <Button variant="ghost" size="sm" disabled={loadingOlder} onClick={() => void loadOlder()}>
                  {loadingOlder && <LoaderCircle className="mr-2 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />}
                  {loadingOlder ? "正在读取…" : "读取更早记录"}
                </Button>
              </div>}
              <DevelopmentTranscript messages={transcriptMessages} events={snapshot.events} runs={snapshot.runs}
                sessionId={childId} visible={visible} live={snapshot.live} scrollRef={scrollRef} followingRef={followingRef}
                navigationRef={navigationRef} showRunHeaders />
            </div>}
            {!authorized && !issue && <p role="status" className="p-4 text-caption text-muted-foreground">正在读取子智能体任务…</p>}
          </div>
        </div>
      </div>
    </section>
    <Dialog open={actionsOpen && authorized} onOpenChange={setActionsOpen}><DialogContent className="max-h-[85vh] overflow-y-auto">
      <DialogHeader><DialogTitle>{taskTitle ?? current?.title ?? "子任务"}</DialogTitle><DialogDescription className="sr-only">处理当前子任务的待办</DialogDescription></DialogHeader>
      {decisions.filter((decision) => decision.kind === "question").map((decision) => <DevelopmentDecision key={decision.id} decision={{ ...decision, parentSessionId: parent.id }} />)}
      {run?.status === "unknown" && <DevelopmentUnknownResult key={run.id} run={run} binding={snapshot?.nativeBinding}
        onStop={stop} stopping={stopping} />}
      {actionError && <p role="alert" className="text-caption text-destructive">{actionError}</p>}
      {!needsAction && !actionError && <p className="text-caption text-muted-foreground">当前没有待处理事项。</p>}
    </DialogContent></Dialog>
    <Dialog open={!!issue} onOpenChange={(open) => { if (!open) closeIssue(); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>子智能体任务暂不可用</DialogTitle><DialogDescription>{issueText}</DialogDescription></DialogHeader>
        <DialogFooter>
          <Button variant="outline" disabled={retrying || loadingOlder} onClick={() => void retry()}>
            {retrying || loadingOlder ? "正在重试…" : "重试"}
          </Button>
          <Button onClick={closeIssue}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </DevelopmentMarkdown>;
}
