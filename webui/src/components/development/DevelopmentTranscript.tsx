import { Fragment, memo, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { ChevronRight } from "lucide-react";
import { GitBranchIcon } from "zcode-lucide-react";
import { ZCodeMarkdown as MarkdownText } from "./zcode/markdown";
import { formatMessageTimeLabel } from "./zcode/messageTimeLabel";
import { CopyRowAction } from "./zcode/CopyRowAction";
import { ForkRowAction } from "./zcode/ForkRowAction";
import { MarkerDividerRow } from "./zcode/MarkerDividerRow";
import { useZCodeIntl } from "./zcode/primitives/intl";
import { MarkdownMedia } from "@/components/markdown/MarkdownMedia";
import { MarkdownGallery } from "@/components/markdown/MarkdownGallery";
import { Button } from "@/components/ui/button";
import { isRunActive, type DevEvent, type DevMessage, type DevRun, type DevSessionForkSource, type ToolCall } from "@/lib/development-api";
import { cn } from "./zcode/utils";
import { getConversationContentWidthClassName } from "./zcode/conversationLayout";
import { DevelopmentFullMessage } from "./DevelopmentFullMessage";
import { developmentActivity, DevelopmentActivityRow, DevelopmentWorkItems, type Activity } from "./DevelopmentActivity";
import { DevelopmentElapsed } from "./DevelopmentElapsed";
import { AssistantHistoryStatus } from "./zcode/AssistantHistoryStatus";
import { Collapsible, CollapsibleContent } from "./zcode/primitives/collapsible";
import { ZCodeSurface } from "./zcode/Surface";
import { buildConversationTurnWorkSegments, type ConversationTurnWorkSegment } from "./zcode/conversationTurnWorkSegments";
import { buildAssistantWorkRenderItems } from "./zcode/tools/conversationAssistantWorkItems";
import type { ConversationRow } from "./zcode/types";
import { VirtualTimeline, type TimelineNavigation } from "./zcode/VirtualTimeline";
import { ChatLoading } from "./zcode/chat-loading";
import { shouldShowTurnChatLoading } from "./zcode/chatLoadingVisibility";
import { ConversationPendingGuideList } from "./zcode/ConversationPendingGuideList";
import type { QueueItem } from "./zcode/queueTypes";
import { DevelopmentStreamContext, useDevelopmentStreamContext } from "./DevelopmentStreamContext";
import { isSubagentTool, readSubagentTask } from "./SubagentTranscriptRow";
import { useSubagentTasks } from "./subagent-tasks";

const toolNames: Record<string, string> = {
  read_file: "读取文件", write_file: "写入文件", edit_file: "修改文件", list_dir: "查看目录",
  exec: "运行命令", write_stdin: "读取命令输出", list_exec_sessions: "查看运行中的命令",
  update_plan: "更新计划", development_collaboration: "调用子智能体",
  development_browser: "验证开发预览",
  grep: "检索代码内容", find_files: "定位项目文件", load_coding_tools: "加载开发能力",
};
const callKey = (runId: string | undefined, callId: string) => JSON.stringify([runId ?? null, callId]);

function MessageMedia({ media }: { media: DevMessage["media"] }) {
  return media?.length ? <MarkdownGallery><div className="flex flex-wrap items-start gap-3" aria-label="消息附件">
    {media.map((item, index) => <MarkdownMedia key={`${index}:${item.url}`} src={item.url} kind={item.kind} alt={item.name ?? (item.kind === "image" ? "图片" : "附件")} />)}
  </div></MarkdownGallery> : null;
}

export function pairTranscriptTools(messages: DevMessage[]) {
  const calls = new Set(messages.flatMap((message) => message.toolCalls.map((call) => callKey(message.runId, call.id))));
  const results = new Map<string, DevMessage>();
  const paired = new Set<string>();
  for (const message of messages) {
    if (message.role !== "tool" || !message.toolCallId) continue;
    const key = callKey(message.runId, message.toolCallId);
    if (!calls.has(key) || results.has(key)) continue;
    results.set(key, message); paired.add(message.id);
  }
  return { messages: messages.filter((message) => !paired.has(message.id)), results };
}

function callTarget(call: ToolCall): string {
  try {
    const args = JSON.parse(call.function.arguments);
    const value = args.path ?? args.file_path ?? args.command;
    return typeof value === "string" ? value : "";
  } catch { return ""; }
}

function toolActivity(call: ToolCall, result: DevMessage | undefined, running: boolean, ended: boolean): Activity {
  let input: unknown = {};
  try { input = JSON.parse(call.function.arguments); } catch { /* Partial tool input. */ }
  return { id: call.id, sequence: 0, label: toolNames[call.function.name] ?? call.function.name,
    description: callTarget(call), output: result?.content ?? "", paths: [], kind: call.function.name, input,
    state: result ? "returned" : running || ended ? "pending" : "waiting", truncated: !!result?.truncated };
}

const MessageRow = memo(function MessageRow({ message, sessionId, streaming = false, onUseAnswer, copyText, hideActions = false, forkable = false, onFork, onForkError, userInputStatus }: {
  message: DevMessage; sessionId: string; streaming?: boolean; onUseAnswer?: (text: string) => void; copyText?: string; hideActions?: boolean;
  forkable?: boolean; onFork?: (messageId: string, requestId: string) => Promise<void>; onForkError?: (cause: unknown) => void;
  userInputStatus?: string;
}) {
  const { intl, locale } = useZCodeIntl();
  const timeLabel = message.timestamp ? formatMessageTimeLabel(Date.parse(message.timestamp), locale, intl) : null;
  if (!message.content && !message.media?.length) return null;
  if (message.role === "tool") return <details className="mx-auto max-w-4xl border-l border-border/60 px-3 py-2 text-caption">
    <summary className="cursor-pointer text-muted-foreground">{toolNames[message.name ?? ""] ?? "工具结果"} · 已返回</summary>
    <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono">{message.content}</pre>
    <MessageMedia media={message.media} />
    {message.truncated && <DevelopmentFullMessage sessionId={sessionId} messageId={message.id} />}
  </details>;
  const user = message.role === "user";
  return <article className="group/answer min-w-0 w-full" data-message-id={message.id}>
    <div className={cn("space-y-2", user && "ml-auto w-fit max-w-full rounded-lg bg-muted/60 px-4 py-3")}>
      {userInputStatus && <div className="text-ui-sm text-foreground-subtle">{userInputStatus}</div>}
      {onUseAnswer && message.role === "assistant" && <div className="flex items-center justify-end gap-2 text-caption text-muted-foreground">
        <Button variant="ghost" size="sm" className="h-6 text-caption" onClick={() => onUseAnswer(message.content)}>加入主会话</Button>
      </div>}
      {!streaming && message.content.length > 1200 && user ? <details className="group/message">
        <summary aria-label="长消息详情" className="flex cursor-pointer list-none items-start gap-2 text-ui [&::-webkit-details-marker]:hidden">
          <ChevronRight className="mt-1 h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-open/message:rotate-90" />
          <span className="min-w-0 flex-1"><span className="line-clamp-3 break-words">{message.content.slice(0, 180)}…</span>
            <span className="mt-1 block text-caption text-muted-foreground group-open/message:hidden">展开完整内容</span></span>
        </summary>
        <div className="mt-3 border-t border-border/40 pt-3"><MarkdownText className="text-ui-base">{message.content}</MarkdownText></div>
      </details> : <MarkdownText streaming={streaming} className="text-ui-base">{message.content}</MarkdownText>}
      {message.truncated && <DevelopmentFullMessage sessionId={sessionId} messageId={message.id} />}
      <MessageMedia media={message.media} />
      {message.role === "assistant" && !streaming && !hideActions && message.content && <div className="mt-1 flex items-center gap-1 opacity-0 transition-opacity group-hover/answer:opacity-100 focus-within:opacity-100">
        <CopyRowAction rowId={message.id} text={copyText ?? message.content} label={intl.formatMessage({ id: "chat.message.copy" })} />
        {forkable && onFork && onForkError && <ForkRowAction messageId={message.id} label={intl.formatMessage({ id: "chat.message.fork" })} onFork={onFork} onError={onForkError} />}
        {timeLabel && <span className="select-none text-ui-sm text-foreground-subtlest">{timeLabel}</span>}
      </div>}
    </div>
  </article>;
});

// Native operations are positioned using the engine's message event identity,
// never using wall-clock guesses or matching message text.
export function nativeTimeline(messages: DevMessage[], events: DevEvent[], runs: DevRun[]) {
  const before = new Map<string, Activity[]>();
  const tail = new Map<string, Activity[]>();
  const streaming = new Set<string>();
  for (const run of runs) {

    const linked = new Map<string, { first: number; complete: boolean }>();
    for (const event of events) {
      if (event.runId !== run.id || !["agent.message.delta", "agent.message.completed"].includes(event.type)) continue;
      const id = event.payload.messageId;
      if (typeof id !== "string") continue;
      const old = linked.get(id);
      linked.set(id, { first: Math.min(old?.first ?? event.sequence, event.sequence), complete: !!old?.complete || event.type === "agent.message.completed" });
    }
    for (const [id, state] of linked) if (!state.complete && run.status === "running") streaming.add(id);
    const ordered = messages.filter((m) => m.runId === run.id && linked.has(m.id));
    for (const row of developmentActivity(events, run.id)) {
      const next = ordered.find((m) => linked.get(m.id)!.first > row.sequence);
      const map = next ? before : tail;
      const key = next?.id ?? run.id;
      map.set(key, [...(map.get(key) ?? []), row]);
    }
  }
  return { before, tail, streaming };
}

function WorkSegment({ segment, run, showHeader }: { segment: ConversationTurnWorkSegment; run?: DevRun; showHeader: boolean }) {
  const [historyOpen, setHistoryOpen] = useState(segment.assistantHistoryDefaultOpen);
  useEffect(() => { setHistoryOpen(segment.assistantHistoryDefaultOpen); }, [segment.assistantHistoryDefaultOpen, segment.key]);
  const open = !showHeader || segment.assistantHistoryDefaultOpen || historyOpen;
  let headerShown = false;
  const runWaitStatus = run && ["waiting_user", "waiting_children", "unknown", "recovering"].includes(run.status)
    ? <DevelopmentElapsed run={run} /> : undefined;
  const header = showHeader && run ? <AssistantHistoryStatus segment={segment} open={open} label={runWaitStatus} /> : null;
  const renderWork = (rows: ConversationRow[], stageTailIsRunning: boolean) => {
    const content = [];
    for (let index = 0; index < rows.length;) {
      const row = rows[index];
      if ((row.kind === "toolCall" || row.kind === "reasoning") && row.activity) {
        const batch = [row]; index += 1;
        while (index < rows.length) {
          const next = rows[index];
          if ((next.kind !== "toolCall" && next.kind !== "reasoning") || !next.activity) break;
          batch.push(next); index += 1;
        }
        const items = buildAssistantWorkRenderItems(batch, { stageTailIsRunning: stageTailIsRunning && index === rows.length });
        if (items.length) content.push(<DevelopmentWorkItems key={row.rowId} rows={batch} items={items} running={segment.workStatus?.state === "running"} />);
      } else { content.push(<Fragment key={row.rowId}>{row.content}</Fragment>); index += 1; }
    }
    return content;
  };
  return <Collapsible open={open} onOpenChange={segment.assistantHistoryDefaultOpen ? undefined : setHistoryOpen}
    className="history-message flex min-w-0 w-full flex-col [&>*+*:not([data-slot=collapsible-content])]:mt-5" data-work-segment={segment.key}>
    {segment.flowItems.map((item, index) => {
      const show = item.kind !== "userInput" && !headerShown;
      if (show) headerShown = true;
      const key = item.kind === "userInput" || item.kind === "assistantText" ? item.row.rowId : item.rows[0]?.rowId;
      const work = item.kind === "assistantHistory" || item.kind === "assistantWork"
        ? renderWork(item.rows, segment.workStatus?.state === "running" && index === segment.flowItems.length - 1) : null;
      return <Fragment key={key}>{show && header}
        {item.kind === "userInput" || item.kind === "assistantText" ? item.row.content
          : !work?.length ? null : item.kind === "assistantHistory" ? <CollapsibleContent data-work-history={segment.key}><div className="space-y-4 pt-5">{work}</div></CollapsibleContent>
          : <div className="space-y-4">{work}</div>}
      </Fragment>;
    })}
    {!headerShown && header}
  </Collapsible>;
}

export function DevelopmentTranscript({ messages, events, runs, sessionId, visible = true, showRunHeaders = false, onUseAnswer, live, scrollRef, followingRef, navigationRef, onLayoutScroll, restoringRef, pendingGuides = [],
  canFork = false, onFork, onForkError, forkSource, onReturnToForkSource }: {
  messages: DevMessage[]; events: DevEvent[]; runs: DevRun[]; sessionId: string; showRunHeaders?: boolean; onUseAnswer?: (text: string) => void;
  live?: { runId: string; content: string } | null;
  scrollRef?: RefObject<HTMLDivElement | null>; followingRef?: RefObject<boolean>; navigationRef?: RefObject<TimelineNavigation | null>;
  onLayoutScroll?: (element: HTMLDivElement) => void;
  restoringRef?: RefObject<boolean>; visible?: boolean;
  pendingGuides?: readonly QueueItem[];
  canFork?: boolean; onFork?: (messageId: string, requestId: string) => Promise<void>; onForkError?: (cause: unknown) => void;
  forkSource?: DevSessionForkSource | null; onReturnToForkSource?: (sourceSessionId: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const host = useDevelopmentStreamContext();
  const { records } = useSubagentTasks(sessionId, visible && messages.some((message) => message.sourceKind === "collaboration" && !!message.childSessionId));
  const fallbackFollowing = useRef(true);
  const [nowMs, setNowMs] = useState(Date.now);
  const hasRunningUnit = runs.some((run) => ["queued", "preparing", "running", "waiting_user", "waiting_children", "interrupting"].includes(run.status));
  useEffect(() => {
    if (!hasRunningUnit) return;
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [hasRunningUnit]);
  const paired = useMemo(() => pairTranscriptTools(messages.filter((message) => !message.queued)), [messages]);
  const hintedTasks = useMemo(() => [
    ...paired.messages.flatMap((message) => message.toolCalls.filter((call) => isSubagentTool(call.function.name)).flatMap((call) => {
      const task = readSubagentTask(paired.results.get(callKey(message.runId, call.id))?.content);
      return task ? [task] : [];
    })),
    ...events.filter((event) => event.type === "tool.completed" && typeof event.payload.name === "string" && isSubagentTool(event.payload.name)).flatMap((event) => {
      const task = readSubagentTask(event.payload.content);
      return task ? [task] : [];
    }),
  ], [paired, events]);
  const streamHost = useMemo(() => host ? { ...host, subagents: [...(records ?? host.subagents ?? []), ...hintedTasks] } : null, [host, records, hintedTasks]);
  const started = useMemo(() => {
    const ids = new Set<string>();
    for (const event of events) {
      if (event.type !== "tools.started" || !Array.isArray(event.payload.tools)) continue;
      for (const tool of event.payload.tools) if (tool && typeof tool === "object" && typeof tool.id === "string") ids.add(callKey(event.runId ?? undefined, tool.id));
    }
    return ids;
  }, [events]);
  const timeline = useMemo(() => nativeTimeline(paired.messages, events, runs), [paired.messages, events, runs]);
  const groups: { key: string; run?: DevRun; rows: ConversationRow[] }[] = [];
  for (const message of paired.messages) {
    // The completed tool row already represents this child; keep unrelated collaboration evidence visible.
    if (message.sourceKind === "collaboration" && message.childSessionId
      && hintedTasks.some((task) => task.childSessionId === message.childSessionId)) continue;
    const run = runs.find((item) => item.id === message.runId);
    const key = run?.id ?? `message:${message.id}`;
    const assistantMessages = paired.messages.filter((item) => item.runId === message.runId && item.role === "assistant" && item.sourceKind !== "collaboration" && (item.content || item.media?.length));
    const finalMessageId = run?.resultMessageId ?? assistantMessages.at(-1)?.id;
    const showActions = !run || !isRunActive(run) && message.id === finalMessageId;
    const forkable = canFork && run?.status === "succeeded" && message.role === "assistant"
      && !!message.content && message.id === finalMessageId;
    const copyText = assistantMessages.map((item) => item.content).join("\n\n");
    let group = groups.at(-1);
    if (!group || group.run?.id !== run?.id || !run) {
      group = { key: groups.some((item) => item.key === key) ? `${key}:${message.id}` : key, run, rows: [] }; groups.push(group);
    }
    for (const row of timeline.before.get(message.id) ?? []) group.rows.push({ rowId: `${sessionId}:${key}:${row.id}`, kind: row.kind === "reasoning" ? "reasoning" : "toolCall", activity: row, content: <DevelopmentActivityRow row={row} running={run?.status === "running"} /> });
    if (message.content || message.media?.length || message.role === "user") group.rows.push({ rowId: message.id, entityId: message.id,
      kind: message.sourceKind === "collaboration" ? "toolCall" : message.role === "user" ? "userInput" : message.role === "tool" ? "toolCall" : "assistantText",
      ...(message.role === "user" ? { guided: message.sourceKind === "steering", createdAt: message.timestamp ? Date.parse(message.timestamp) : undefined } : {}),
      content: <MessageRow message={message} sessionId={sessionId} streaming={timeline.streaming.has(message.id)} onUseAnswer={onUseAnswer} hideActions={!showActions} copyText={copyText}
        forkable={!!forkable} onFork={onFork} onForkError={onForkError} /> });
    for (const call of message.toolCalls) {
      const result = paired.results.get(callKey(message.runId, call.id));
      const running = !!run && ["running", "preparing"].includes(run.status) && started.has(callKey(message.runId, call.id));
      const ended = !run || !isRunActive(run) || ["unknown", "recovering"].includes(run.status);
      group.rows.push({ rowId: `${sessionId}:${key}:tool:${call.id}`, kind: "toolCall", activity: toolActivity(call, result, running, ended),
        fullOutputContent: result ? <><MessageMedia media={result.media} />{result.truncated && <DevelopmentFullMessage sessionId={sessionId} messageId={result.id} />}</> : undefined });
    }
  }
  // Native-only work has no assistant message yet. Its header and rows still
  // appear immediately; identity is the run, never the time of first paint.
  for (const run of [...runs].reverse()) {
    let group = [...groups].reverse().find((item) => item.run?.id === run.id);
    if (!group) {
      if (!isRunActive(run) && !timeline.tail.get(run.id)?.length) continue;
      group = { key: run.id, run, rows: [] };
      const next = groups.findIndex((item) => item.run && Date.parse(item.run.createdAt) > Date.parse(run.createdAt));
      if (next < 0) groups.push(group); else groups.splice(next, 0, group);
    }
    for (const row of timeline.tail.get(run.id) ?? []) group.rows.push({ rowId: `${sessionId}:${run.id}:${row.id}`, kind: row.kind === "reasoning" ? "reasoning" : "toolCall", activity: row,
      content: <DevelopmentActivityRow row={row} running={run.status === "running"} /> });
    if (live?.runId === run.id && live.content) group.rows.push({ rowId: `${run.id}:live`, kind: "assistantText", content: <article aria-label="正在输出"><MarkdownText streaming className="text-ui-base">{live.content}</MarkdownText></article> });
  }
  const sourceMarker = forkSource ? <MarkerDividerRow rowId={`fork-source:${sessionId}`} markerType="forkNotice" markerStatus="created"
    icon={<GitBranchIcon className="size-3.5" />} label={intl.formatMessage({ id: "chat.message.fork.derivedFrom" })}
    onClick={onReturnToForkSource ? () => onReturnToForkSource(forkSource.sourceSessionId) : undefined} /> : null;
  const units = groups.map((group, index) => {
    const { run, rows } = group;
    const running = !!run && ["queued", "preparing", "running", "waiting_user", "waiting_children", "interrupting"].includes(run.status);
    const final = run?.resultMessageId ? rows.find((row) => row.rowId === run.resultMessageId && row.kind === "assistantText") : undefined;
    const segments = buildConversationTurnWorkSegments({ key: group.key, orderedRows: rows,
      ...(run ? { header: { kind: "turnHeader" as const, rowId: run.id, executionKind: "agent" as const, startedAt: Date.parse(run.startedAt ?? run.createdAt), ...(run.finishedAt ? { endedAt: Date.parse(run.finishedAt) } : {}) } } : {}),
      assistantTailRows: [], ...(final?.kind === "assistantText" ? { latestAssistantTextRow: final } : {}),
      isRunning: running, isLastTurn: index === groups.length - 1, isInterrupted: run?.status === "interrupted",
      forceOpenHistory: !showRunHeaders || run?.status === "failed" || run?.status === "interrupted", timelineOnly: false, nowMs });
    // The source builder expects at least one row; an empty newly started run
    // still owns its working header and loading slot.
    return { key: group.key, isRunning: running, messageIds: rows.filter((row) => row.kind === "userInput" || row.kind === "assistantText").map((row) => row.rowId), content: <div key={group.key} className={cn("group/assistant-turn relative mx-auto flex flex-col gap-5 px-4 @md/conversation:px-6 pb-5 pt-14", getConversationContentWidthClassName({ centeredEmptyLayout: false, statusPanelLayout: "none" }))}>
      {segments.length ? segments.map((segment) => <WorkSegment key={segment.key} segment={segment} run={run} showHeader={showRunHeaders} />)
        : showRunHeaders && run && <div className="w-full border-b border-[var(--color-border)]/50 pb-2 text-ui-base"><DevelopmentElapsed run={run} /></div>}
      <ChatLoading loading={shouldShowTurnChatLoading({ isLastTurn: index === groups.length - 1, isRunning: running, blockedByInteraction: run?.status === "waiting_user", blockedByActiveWork: run?.status === "waiting_children", rows: rows.filter((row) => row.kind !== "turnHeader") })} size="sm" className="w-full" />
      {forkSource && rows.some((row) => row.rowId === forkSource.sourceMessageId && row.kind === "assistantText") && sourceMarker}
    </div> };
  });
  return <DevelopmentStreamContext.Provider value={streamHost}><ZCodeSurface><div className="@container/conversation text-foreground">
    {scrollRef ? <VirtualTimeline key={sessionId} units={units} scrollRef={scrollRef} followingRef={followingRef ?? fallbackFollowing} navigationRef={navigationRef} onLayoutScroll={onLayoutScroll} restoringRef={restoringRef} />
      : <div>{units.map((unit) => unit.content)}</div>}
    {pendingGuides.length > 0 && <div className={cn("relative mx-auto w-full px-4 @md/conversation:px-6 pb-5", getConversationContentWidthClassName({ centeredEmptyLayout: false, statusPanelLayout: "none" }))}>
      <ConversationPendingGuideList items={pendingGuides} turnId={runs[0]?.id ?? "pending-guide"} context={{ renderUserInput: (row, status) =>
        <MessageRow sessionId={sessionId} userInputStatus={status} message={{ id: row.entityId, role: "user", content: row.text,
          runId: row.turnId, sourceKind: "steering", timestamp: row.createdAt, media: row.attachments, toolCalls: [], queued: false, truncated: false }} /> }} />
    </div>}
  </div></ZCodeSurface></DevelopmentStreamContext.Provider>;
}
