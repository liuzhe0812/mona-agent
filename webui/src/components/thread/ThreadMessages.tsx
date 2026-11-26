import { useLayoutEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { MessageBubble } from "@/components/MessageBubble";
import {
  AgentAvatar,
  MONA_AGENT_ID,
  resolveAgentDisplayName,
} from "@/components/room/AgentAvatar";
import { useAgents } from "@/components/room/useAgents";
import {
  AgentActivityCluster,
  ActivityTimingHeader,
  isAgentActivityMember,
} from "@/components/thread/AgentActivityCluster";
import { StepActivityTrace } from "@/components/workflow/StepActivityTrace";
import { projectStaticWidgetImages, type WidgetDisplayMessage } from "@/lib/static-widget-images";
import { useClientContextOrNull } from "@/providers/ClientProvider";
import type { AgentSummary, QuoteMessageHandler, UIMessage } from "@/lib/types";

export type ThreadPartner = Pick<AgentSummary, "id" | "displayName" | "avatarUrl">;

interface ThreadMessagesProps {
  messages: UIMessage[];
  /** When true, agent turn still in flight — keeps activity cluster expanded. */
  isStreaming?: boolean;
  runActivityLabel?: string;
  runStartedAt?: number | null;
  focusMessage?: { id: string; requestId: number } | null;
  /** Rooms use group-chat bubbles and show every assistant author, including Mona. */
  isGroupChat?: boolean;
  partner?: ThreadPartner;
  hiddenMessageCount?: number;
  hasMoreHistory?: boolean;
  loadingEarlier?: boolean;
  earlierError?: string | null;
  onLoadEarlier?: () => void;
  onQuote?: QuoteMessageHandler;
  onBranch?: (message: UIMessage, author: string) => void;
  onWidgetPrompt?: (text: string) => void;
  onJumpToReplyStart?: (target: HTMLElement) => void;
}

export type DisplayUnit =
  | { type: "cluster"; messages: UIMessage[] }
  | { type: "single"; message: WidgetDisplayMessage };

const GROUP_TIME_DIVIDER_GAP_MS = 5 * 60 * 1000;

export function buildDisplayUnits(input: UIMessage[]): DisplayUnit[] {
  const messages = projectStaticWidgetImages(input);
  const out: DisplayUnit[] = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    if (m.kind === "discussion" || m.kind === "workflowRun") {
      i += 1;
      continue;
    }
    if (isAgentActivityMember(m)) {
      const cluster: UIMessage[] = [];
      let segmentId: string | undefined = m.activitySegmentId;
      let clusterHasFileEdits = hasFileEdits(m);
      while (
        i < messages.length
        && isAgentActivityMember(messages[i])
        && canJoinActivityCluster(segmentId, clusterHasFileEdits, messages[i])
      ) {
        const current = messages[i];
        if (!segmentId && current.activitySegmentId) {
          segmentId = current.activitySegmentId;
        }
        clusterHasFileEdits = clusterHasFileEdits || hasFileEdits(current);
        cluster.push(current);
        i += 1;
      }
      out.push({ type: "cluster", messages: cluster });
      continue;
    }
    const previous = out[out.length - 1];
    if (
      previous?.type === "cluster"
      && assistantHasInlineReasoning(m)
      && canFoldInlineReasoning(previous.messages, m)
    ) {
      previous.messages.push(reasoningOnlyMessageFromAnswer(m));
      out.push({ type: "single", message: stripInlineReasoning(m) });
      i += 1;
      continue;
    }
    if (assistantHasInlineReasoning(m)) {
      out.push({ type: "cluster", messages: [reasoningOnlyMessageFromAnswer(m)] });
      out.push({ type: "single", message: stripInlineReasoning(m) });
      i += 1;
      continue;
    }
    out.push({ type: "single", message: m });
    i += 1;
  }
  return out;
}

function clusterSegmentId(messages: UIMessage[]): string | undefined {
  return messages.find((message) => message.activitySegmentId)?.activitySegmentId;
}

function hasFileEdits(message: UIMessage): boolean {
  return !!message.fileEdits?.length;
}

function clusterHasFileEdits(messages: UIMessage[]): boolean {
  return messages.some(hasFileEdits);
}

function canJoinActivityCluster(
  clusterSegmentId: string | undefined,
  clusterIncludesFileEdits: boolean,
  message: UIMessage,
): boolean {
  const messageHasFileEdits = hasFileEdits(message);
  if (!clusterIncludesFileEdits && !messageHasFileEdits) return true;
  if (!clusterSegmentId || !message.activitySegmentId) return true;
  return clusterSegmentId === message.activitySegmentId;
}

function canFoldInlineReasoning(cluster: UIMessage[], message: UIMessage): boolean {
  if (!clusterHasFileEdits(cluster) && !hasFileEdits(message)) return true;
  const segmentId = clusterSegmentId(cluster);
  if (!segmentId || !message.activitySegmentId) return true;
  return segmentId === message.activitySegmentId;
}

function assistantHasInlineReasoning(message: UIMessage): boolean {
  return (
    message.role === "assistant"
    && message.kind !== "trace"
    && Boolean(message.content.trim() || message.media?.length)
    && (!!message.reasoning?.trim() || !!message.reasoningStreaming)
  );
}

function reasoningOnlyMessageFromAnswer(message: UIMessage): UIMessage {
  return {
    id: `${message.id}-reasoning`,
    role: "assistant",
    content: "",
    createdAt: message.createdAt,
    reasoning: message.reasoning,
    reasoningStreaming: message.reasoningStreaming,
    isStreaming: message.reasoningStreaming,
    activitySegmentId: message.activitySegmentId,
  };
}

function stripInlineReasoning(message: UIMessage): UIMessage {
  const next = { ...message };
  delete next.reasoning;
  delete next.reasoningStreaming;
  return next;
}

/** Author row above assistant bubbles: group chats show Mona and partner
 *  authors alike; direct chats preserve the existing Mona-bare layout. */
function AgentAuthorHeader({
  message,
  agentsById,
  isGroupChat,
  showAvatar = true,
}: {
  message: UIMessage;
  agentsById: ReadonlyMap<string, AgentSummary>;
  isGroupChat: boolean;
  showAvatar?: boolean;
}) {
  if (message.role !== "assistant") return null;
  const authorId = message.authorId ?? (isGroupChat ? MONA_AGENT_ID : null);
  if (!authorId || (!isGroupChat && authorId === MONA_AGENT_ID)) return null;
  const agent = agentsById.get(authorId);
  const name = agent?.displayName ?? resolveAgentDisplayName(agentsById, authorId);
  return (
    <div className="mb-1 flex items-center gap-1.5">
      {showAvatar ? (
        <AgentAvatar
          agentId={authorId}
          displayName={name}
          avatarUrl={agent?.avatarUrl}
          className="h-4 w-4"
        />
      ) : null}
      <span className="text-[11.5px] font-medium text-muted-foreground">{name}</span>
    </div>
  );
}

function quoteAuthorName(
  message: UIMessage,
  agentsById: ReadonlyMap<string, AgentSummary>,
  isGroupChat: boolean,
): string | undefined {
  if (message.role !== "assistant") return undefined;
  const authorId = message.authorId ?? (isGroupChat ? MONA_AGENT_ID : null);
  if (!authorId || authorId === MONA_AGENT_ID) return "Mona";
  return agentsById.get(authorId)?.displayName
    ?? resolveAgentDisplayName(agentsById, authorId);
}

function visibleMessageTime(unit: DisplayUnit): number | null {
  if (unit.type !== "single") return null;
  const message = unit.message;
  if (message.kind === "trace" || (message.role !== "user" && message.role !== "assistant")) {
    return null;
  }
  return Number.isFinite(message.createdAt) ? message.createdAt : null;
}

function groupMessageTime(timestamp: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  return new Intl.DateTimeFormat(undefined, sameDay
    ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }
    : { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }
  ).format(date);
}

export function ThreadMessages({
  messages,
  isStreaming = false,
  runActivityLabel,
  runStartedAt,
  focusMessage,
  isGroupChat = false,
  partner,
  hiddenMessageCount = 0,
  hasMoreHistory = false,
  loadingEarlier = false,
  earlierError = null,
  onLoadEarlier,
  onQuote,
  onBranch,
  onWidgetPrompt,
  onJumpToReplyStart,
}: ThreadMessagesProps) {
  const { t } = useTranslation();
  // Tolerates bare renders (no ClientProvider in unit tests): agent names
  // then fall back to the derived display name from the agent id.
  const clientCtx = useClientContextOrNull();
  const agentsById = useAgents(clientCtx?.token ?? null);
  const isPartnerChat = !!partner;
  const units = useMemo(() => buildDisplayUnits(messages), [messages]);
  const { timingHeaders, processTimings, taskTimings, latestTiming } = useMemo(() => {
    type Timing = {
      key: string;
      startedAt: number;
      latencyMs?: number;
      isTurnStreaming: boolean;
      hasActivity: boolean;
      indices: number[];
      finalAnswerIndex: number;
      hasConfirmedFinalAnswer: boolean;
      hasProcess: boolean;
    };
    const headers = new Map<number, Timing>();
    const processes = new Map<number, Timing>();
    const tasks = new Map<number, Timing>();
    let current: Timing | null = null;
    let userMessageId: string | undefined;
    for (const [index, unit] of units.entries()) {
      if (unit.type === "single" && unit.message.role === "user") {
        if (!unit.message.isInjected) {
          current = null;
          userMessageId = unit.message.id;
        }
        continue;
      }
      if (unit.type !== "cluster" && unit.message.role !== "assistant") continue;
      const rows = unit.type === "cluster" ? unit.messages : [unit.message];
      if (!current) {
        current = { key: userMessageId ?? unitKey(unit, index), startedAt: rows[0].createdAt, isTurnStreaming: false, hasActivity: false, indices: [], finalAnswerIndex: -1, hasConfirmedFinalAnswer: false, hasProcess: false };
        headers.set(index, current);
      }
      current.indices.push(index);
      tasks.set(index, current);
      if (unit.type === "cluster") {
        current.hasActivity = true;
        if (!current.hasConfirmedFinalAnswer) current.finalAnswerIndex = -1;
      }
      else if (
        unit.message.kind !== "widget"
        && (!unit.message.messageType || unit.message.messageType === "message")
        && (unit.message.content.trim() || unit.message.deliveredFiles?.length || unit.message.media?.length)
        && (unit.message.isFinalResponse || !current.hasConfirmedFinalAnswer)
      ) {
        current.finalAnswerIndex = index;
        current.hasConfirmedFinalAnswer = !!unit.message.isFinalResponse;
      }
      for (const row of rows) {
        if (row.latencyMs != null) current.latencyMs = row.latencyMs;
      }
    }
    if (current && isStreaming) current.isTurnStreaming = true;
    for (const [index, timing] of headers) {
      if (!isGroupChat) {
        for (const unitIndex of timing.indices) {
          const unit = units[unitIndex];
          if (unit.type === "single" && unit.message.toolEvents?.length) timing.hasProcess = true;
          if (unitIndex === timing.finalAnswerIndex) continue;
          if (unit.type === "single" && (
            unit.message.kind === "widget"
            || (unit.message.messageType && unit.message.messageType !== "message")
            || unit.message.deliveredFiles?.length
            || unit.message.media?.length
            || unit.message.images?.length
          )) continue;
          processes.set(unitIndex, timing);
          timing.hasProcess = true;
        }
      }
      if (!timing.hasActivity && !timing.hasProcess && timing.latencyMs == null && !timing.isTurnStreaming) headers.delete(index);
    }
    return { timingHeaders: headers, processTimings: processes, taskTimings: tasks, latestTiming: current };
  }, [units, isStreaming, isGroupChat]);
  const [expandedProcesses, setExpandedProcesses] = useState<Set<string>>(() => new Set());
  const latestProcessKey = latestTiming?.hasProcess ? latestTiming.key : undefined;
  const latestProcessStreaming = latestTiming?.isTurnStreaming ?? false;
  useLayoutEffect(() => {
    if (!latestProcessKey || isGroupChat) return;
    setExpandedProcesses((previous) => {
      if (previous.has(latestProcessKey) === latestProcessStreaming) return previous;
      const next = new Set(previous);
      if (latestProcessStreaming) next.add(latestProcessKey);
      else next.delete(latestProcessKey);
      return next;
    });
  }, [latestProcessKey, latestProcessStreaming, isGroupChat]);
  const focusedProcessKey = focusMessage
    ? processTimings.get(units.findIndex((unit) => unit.type === "single" && unit.message.id === focusMessage.id))?.key
    : undefined;
  useLayoutEffect(() => {
    if (!focusedProcessKey) return;
    setExpandedProcesses((previous) => previous.has(focusedProcessKey)
      ? previous : new Set(previous).add(focusedProcessKey));
  }, [focusMessage?.id, focusMessage?.requestId, focusedProcessKey]);
  const showTimeDivider = useMemo(() => {
    let previousTime: number | null = null;
    return units.map((unit, index) => {
      const process = processTimings.get(index);
      if (isPartnerChat && process && !expandedProcesses.has(process.key)) return false;
      const currentTime = visibleMessageTime(unit);
      if (currentTime === null) return false;
      const show = previousTime === null || currentTime - previousTime >= GROUP_TIME_DIVIDER_GAP_MS;
      previousTime = currentTime;
      return show;
    });
  }, [units, isPartnerChat, processTimings, expandedProcesses]);
  const liveActivityClusterIndex = useMemo(
    () => isStreaming ? currentActivityClusterIndex(units) : -1,
    [isStreaming, units],
  );

  return (
    <div className="flex w-full flex-col">
      {(hiddenMessageCount > 0 || hasMoreHistory) && onLoadEarlier ? (
        <div className="mb-4 flex flex-col items-center gap-2">
          <button
            type="button"
            onClick={onLoadEarlier}
            disabled={loadingEarlier}
            className="rounded-full border border-border/60 bg-background/85 px-3 py-1.5 text-xs font-medium text-muted-foreground shadow-sm transition-colors hover:bg-muted/55 hover:text-foreground disabled:cursor-wait disabled:opacity-70"
          >
            {loadingEarlier
              ? "正在加载更早消息…"
              : hiddenMessageCount > 0
                ? t("thread.loadEarlier", { count: hiddenMessageCount, defaultValue: "Load earlier messages" })
                : t("thread.loadEarlier", { defaultValue: "Load earlier messages" })}
          </button>
          {earlierError ? <p role="alert" className="text-caption text-destructive">{earlierError}</p> : null}
        </div>
      ) : null}
      {units.map((unit, index) => {
        const prev = units[index - 1];
        const marginTop = !prev ? "" : isPartnerChat && prev.type === "cluster"
          && unit.type === "single" && unit.message.role === "assistant"
          ? "mt-3" : marginAfterPrevUnit(prev, unit);
        const next = units[index + 1];
        const timing = timingHeaders.get(index);
        const process = processTimings.get(index);
        const processHidden = !isGroupChat && process && !expandedProcesses.has(process.key);
        const task = taskTimings.get(index);
        const showToolEvents = isGroupChat || !task?.hasProcess || expandedProcesses.has(task.key);
        if (processHidden && !timing) return null;
        const hasBodyBelow =
          unit.type === "cluster"
          && next?.type === "single"
          && next.message.role === "assistant";

        const groupAssistant =
          isGroupChat && unit.type === "single" && unit.message.role === "assistant";
        const groupAuthorId = groupAssistant
          ? unit.message.authorId ?? MONA_AGENT_ID
          : null;
        const groupAuthor = groupAuthorId ? agentsById.get(groupAuthorId) : undefined;
        const groupAuthorName = groupAuthorId
          ? groupAuthor?.displayName ?? resolveAgentDisplayName(agentsById, groupAuthorId)
          : "";
        const timestamp = (isGroupChat || isPartnerChat) && showTimeDivider[index] && unit.type === "single"
          ? groupMessageTime(unit.message.createdAt) : null;
        const partnerIncoming = partner && (unit.type === "cluster" || unit.message.role === "assistant");
        const showPartnerAvatar = partnerIncoming && (task?.indices[0] === index || !!timestamp);

        const content = (
          <>
            {timing && <ActivityTimingHeader
              inline={isPartnerChat}
              startedAt={timing.startedAt}
              latencyMs={timing.latencyMs}
              isTurnStreaming={timing.isTurnStreaming}
              runStartedAt={timing.isTurnStreaming ? runStartedAt : undefined}
              expanded={expandedProcesses.has(timing.key)}
              onToggle={!isGroupChat && timing.hasProcess ? () => setExpandedProcesses((previous) => {
                const next = new Set(previous);
                if (next.has(timing.key)) next.delete(timing.key);
                else next.add(timing.key);
                return next;
              }) : undefined}
            />}
            {!processHidden && <>
            {isGroupChat && timestamp ? (
              <div
                className="my-2 flex items-center gap-3 px-2 text-[10.5px] text-muted-foreground/55"
                aria-label={timestamp}
              >
                <span className="h-px flex-1 bg-border/35" aria-hidden />
                <span className="shrink-0">{timestamp}</span>
                <span className="h-px flex-1 bg-border/35" aria-hidden />
              </div>
            ) : null}
            {unit.type === "cluster" ? (
              <AgentActivityCluster
                messages={unit.messages}
                isTurnStreaming={index === liveActivityClusterIndex}
                runActivityLabel={runActivityLabel}
                hasBodyBelow={hasBodyBelow}
                showTiming={false}
              />
            ) : groupAssistant ? (
              <div className="flex min-w-0 items-start gap-2">
                <AgentAvatar
                  agentId={groupAuthorId!}
                  displayName={groupAuthorName}
                  avatarUrl={groupAuthor?.avatarUrl}
                  className="mt-1 h-9 w-9"
                />
                <div className="min-w-0 flex-1">
                  <AgentAuthorHeader
                    message={unit.message}
                    agentsById={agentsById}
                    isGroupChat={isGroupChat}
                    showAvatar={false}
                  />
                  <MessageBubble
                    message={unit.message}
                    widgetImages={unit.message.widgetImages}
                    isGroupChat={isGroupChat}
                    authorName={quoteAuthorName(unit.message, agentsById, isGroupChat)}
                    onQuote={onQuote}
                    onBranch={onBranch}
                    onWidgetPrompt={onWidgetPrompt}
                  />
                  {showToolEvents && unit.message.toolEvents && unit.message.toolEvents.length > 0 ? (
                    <StepActivityTrace events={unit.message.toolEvents} />
                  ) : null}
                </div>
              </div>
            ) : (
              <>
                {!partner && <AgentAuthorHeader
                  message={unit.message}
                  agentsById={agentsById}
                  isGroupChat={isGroupChat}
                />}
                <MessageBubble
                  message={unit.message}
                  widgetImages={unit.message.widgetImages}
                  isGroupChat={isGroupChat}
                  partnerChat={isPartnerChat}
                  showTurnActions={!task?.isTurnStreaming && task?.finalAnswerIndex === index}
                  authorName={partner && unit.message.role === "assistant"
                    ? partner.displayName : quoteAuthorName(unit.message, agentsById, isGroupChat)}
                  onQuote={onQuote}
                  onBranch={isPartnerChat ? undefined : onBranch}
                  onWidgetPrompt={onWidgetPrompt}
                  onJumpToReplyStart={onJumpToReplyStart}
                />
                {showToolEvents && unit.message.toolEvents && unit.message.toolEvents.length > 0 ? (
                  <StepActivityTrace events={unit.message.toolEvents} />
                ) : null}
              </>
            )}
            </>}
          </>
        );

        return (
          <div
            key={unitKey(unit, index)}
            id={unit.type === "single" ? `thread-message-${unit.message.id}` : undefined}
            className={marginTop}
          >
            {partner && timestamp && unit.type === "single" ? (
              <time dateTime={new Date(unit.message.createdAt).toISOString()} className="mb-3 block text-center text-micro tabular-nums text-muted-foreground">
                {timestamp}
              </time>
            ) : null}
            {partner && partnerIncoming ? (
              <div className="flex min-w-0 items-start gap-2">
                {showPartnerAvatar ? (
                  <>
                    <AgentAvatar agentId={partner.id} displayName={partner.displayName}
                      avatarUrl={partner.avatarUrl} className="h-7 w-7" />
                    <span className="sr-only">{partner.displayName}</span>
                  </>
                ) : <span className="w-7 shrink-0" aria-hidden />}
                <div className="min-w-0 flex-1">{content}</div>
              </div>
            ) : content}
          </div>
        );
      })}
    </div>
  );
}

function currentActivityClusterIndex(units: DisplayUnit[]): number {
  const last = units.length - 1;
  if (units[last]?.type === "cluster") return last;
  return units[last]?.type === "single"
    && units[last].message.role === "assistant"
    && !!units[last].message.isStreaming
    && units[last - 1]?.type === "cluster" ? last - 1 : -1;
}

function unitKey(unit: DisplayUnit, index: number): string {
  if (unit.type === "cluster") {
    const anchor = unit.messages[0]?.id;
    return anchor != null ? `cluster-${anchor}` : `cluster-idx-${index}`;
  }
  return unit.message.id;
}

function marginAfterPrevUnit(prev: DisplayUnit, current: DisplayUnit): string {
  if (prev.type === "cluster") {
    if (current.type === "cluster") return "mt-1";
    return current.type === "single" && current.message.role === "assistant" ? "mt-1" : "mt-4";
  }
  if (current.type === "cluster" && prev.message.role === "assistant") {
    return "mt-2";
  }
  const p = prev.message;
  const denseP =
    p.kind === "trace"
    || (
      p.role === "assistant"
      && p.content.trim().length === 0
      && (!!p.reasoning || !!p.reasoningStreaming)
    );
  if (denseP) {
    return "mt-2";
  }
  return "mt-5";
}
