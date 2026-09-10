import { useMemo } from "react";
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
  isAgentActivityMember,
} from "@/components/thread/AgentActivityCluster";
import { StepActivityTrace } from "@/components/workflow/StepActivityTrace";
import { useClientContextOrNull } from "@/providers/ClientProvider";
import type { AgentSummary, UIMessage } from "@/lib/types";

interface ThreadMessagesProps {
  messages: UIMessage[];
  /** When true, agent turn still in flight — keeps activity cluster expanded. */
  isStreaming?: boolean;
  /** Rooms use group-chat bubbles and show every assistant author, including Mona. */
  isGroupChat?: boolean;
  hiddenMessageCount?: number;
  onLoadEarlier?: () => void;
  onQuote?: (message: UIMessage, author: string) => void;
  onBranch?: (message: UIMessage, author: string) => void;
}

export type DisplayUnit =
  | { type: "cluster"; messages: UIMessage[] }
  | { type: "single"; message: UIMessage };

const GROUP_TIME_DIVIDER_GAP_MS = 5 * 60 * 1000;

export function buildDisplayUnits(messages: UIMessage[]): DisplayUnit[] {
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
    && message.content.trim().length > 0
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
  isGroupChat = false,
  hiddenMessageCount = 0,
  onLoadEarlier,
  onQuote,
  onBranch,
}: ThreadMessagesProps) {
  const { t } = useTranslation();
  // Tolerates bare renders (no ClientProvider in unit tests): agent names
  // then fall back to the derived display name from the agent id.
  const clientCtx = useClientContextOrNull();
  const agentsById = useAgents(clientCtx?.token ?? null);
  const units = useMemo(() => buildDisplayUnits(messages), [messages]);
  const showTimeDivider = useMemo(() => {
    let previousTime: number | null = null;
    return units.map((unit) => {
      const currentTime = visibleMessageTime(unit);
      if (currentTime === null) return false;
      const show = previousTime === null || currentTime - previousTime >= GROUP_TIME_DIVIDER_GAP_MS;
      previousTime = currentTime;
      return show;
    });
  }, [units]);
  const liveActivityClusterIndex = useMemo(
    () => isStreaming ? currentActivityClusterIndex(units) : -1,
    [isStreaming, units],
  );

  return (
    <div className="flex w-full flex-col">
      {hiddenMessageCount > 0 && onLoadEarlier ? (
        <div className="mb-4 flex justify-center">
          <button
            type="button"
            onClick={onLoadEarlier}
            className="rounded-full border border-border/60 bg-background/85 px-3 py-1.5 text-xs font-medium text-muted-foreground shadow-sm transition-colors hover:bg-muted/55 hover:text-foreground"
          >
            {t("thread.loadEarlier", {
              count: hiddenMessageCount,
              defaultValue: "Load earlier messages",
            })}
          </button>
        </div>
      ) : null}
      {units.map((unit, index) => {
        const prev = units[index - 1];
        const marginTop =
          index > 0
            ? marginAfterPrevUnit(prev)
            : "";
        const next = units[index + 1];
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

        return (
          <div
            key={unitKey(unit, index)}
            id={unit.type === "single" ? `thread-message-${unit.message.id}` : undefined}
            className={marginTop}
          >
            {isGroupChat && showTimeDivider[index] && unit.type === "single" ? (
              <div
                className="my-2 flex items-center gap-3 px-2 text-[10.5px] text-muted-foreground/55"
                aria-label={groupMessageTime(unit.message.createdAt)}
              >
                <span className="h-px flex-1 bg-border/35" aria-hidden />
                <span className="shrink-0">{groupMessageTime(unit.message.createdAt)}</span>
                <span className="h-px flex-1 bg-border/35" aria-hidden />
              </div>
            ) : null}
            {unit.type === "cluster" ? (
              <AgentActivityCluster
                messages={unit.messages}
                isTurnStreaming={index === liveActivityClusterIndex}
                hasBodyBelow={hasBodyBelow}
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
                    isGroupChat={isGroupChat}
                    authorName={quoteAuthorName(unit.message, agentsById, isGroupChat)}
                    onQuote={onQuote}
                    onBranch={onBranch}
                  />
                  {unit.message.toolEvents && unit.message.toolEvents.length > 0 ? (
                    <StepActivityTrace events={unit.message.toolEvents} />
                  ) : null}
                </div>
              </div>
            ) : (
              <>
                <AgentAuthorHeader
                  message={unit.message}
                  agentsById={agentsById}
                  isGroupChat={isGroupChat}
                />
                <MessageBubble
                  message={unit.message}
                  isGroupChat={isGroupChat}
                  authorName={quoteAuthorName(unit.message, agentsById, isGroupChat)}
                  onQuote={onQuote}
                  onBranch={onBranch}
                />
                {unit.message.toolEvents && unit.message.toolEvents.length > 0 ? (
                  <StepActivityTrace events={unit.message.toolEvents} />
                ) : null}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

function currentActivityClusterIndex(units: DisplayUnit[]): number {
  const last = units.length - 1;
  return units[last]?.type === "cluster" ? last : -1;
}

function unitKey(unit: DisplayUnit, index: number): string {
  if (unit.type === "cluster") {
    const anchor = unit.messages[0]?.id;
    return anchor != null ? `cluster-${anchor}` : `cluster-idx-${index}`;
  }
  return unit.message.id;
}

function marginAfterPrevUnit(prev: DisplayUnit): string {
  if (prev.type === "cluster") {
    return "mt-4";
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
