import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useClientOptional } from "@/providers/ClientProvider";
import { toMediaAttachment } from "@/lib/media";
import { mergeUniqueToolTraceLines, toolTraceLinesFromEvents } from "@/lib/tool-traces";
import { finishPendingWidgets, upsertInlineWidgetMessage } from "@/lib/inline-widget-events";
import { getHostedPlatform } from "@/lib/hosted-platform";
import { LiveTokenSampler } from "@/lib/live-token-speed";
import { appendWorkRequest, summarizeWorkRequests, type WorkRequestSeries } from "@/lib/work-run-progress";
import { isMessageAdmissionRejectionReason } from "@/lib/mona-client";
import type { MessageAdmission, MessageAdmissionReason, MonaClient, StreamError } from "@/lib/mona-client";
import type {
  InboundEvent,
  AgentModelBinding,
  OutboundMedia,
  GoalStateWsPayload,
  TaskPlanWsPayload,
  DeliveredFile,
  DiscussionLaunchOptions,
  UIMediaAttachment,
  UIImage,
  UIFileEdit,
  UIMessage,
  WorkflowRun,
  ToolProgressEvent,
  MessageQuote,
} from "@/lib/types";

const MAX_UI_TRACE_LINES = 500;
const MAX_UI_TOOL_EVENTS = 500;
const MAX_UI_REASONING_CHARS = 128_000;

type StopTarget = { state: "ready"; turnId: string } | { state: "finished" } | { state: "unknown" } | { state: "cancelled" };

function waitForStopTarget(client: MonaClient, chatId: string, inputId: string, taskId: string): {
  promise: Promise<StopTarget>;
  cancel: () => void;
} {
  let finish: (value: StopTarget) => void = () => {};
  const promise = new Promise<StopTarget>((resolve) => {
    let settled = false;
    let unsubscribeChat = () => {};
    let unsubscribeStatus = () => {};
    const timer = window.setTimeout(() => finish({ state: "unknown" }), 10_000);
    finish = (value) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      unsubscribeChat();
      unsubscribeStatus();
      resolve(value);
    };
    unsubscribeChat = client.onChat(chatId, (event) => {
      if (event.event === "goal_status" && event.input_id === inputId && event.turn_id) {
        if (event.status === "idle") finish({ state: "finished" });
        else if (event.turn_state === "unknown") finish({ state: "unknown" });
        else finish({ state: "ready", turnId: event.turn_id });
      } else if (event.event === "turn_end" && event.input_id === inputId && (!event.task_id || event.task_id === taskId)) {
        finish({ state: "finished" });
      } else if (event.event === "error" && event.message_rejected && event.input_id === inputId) {
        finish({ state: "cancelled" });
      }
    });
    unsubscribeStatus = client.onStatus((status) => {
      if (status !== "open") finish({ state: "unknown" });
    });
    // onStatus invokes the listener synchronously, before it returns unsubscribe.
    if (settled) unsubscribeStatus();
  });
  return { promise, cancel: () => finish({ state: "cancelled" }) };
}

function boundedReasoning(value: string): string {
  return value.length > MAX_UI_REASONING_CHARS
    ? `…\n${value.slice(-MAX_UI_REASONING_CHARS)}`
    : value;
}

interface StreamBuffer {
  /** ID of the assistant message currently receiving deltas (cleared on ``stream_end``). */
  messageId: string;
  /** Backend stream/job identity. Undefined for legacy chat-scoped streams. */
  streamKey?: string;
  authorId?: string;
  jobId?: string;
}

interface PendingMessage {
  taskId: string;
  messageId: string;
  previousTaskId: string | null;
  previousTaskPlan?: TaskPlanWsPayload;
  awaitingAdmission: boolean;
}

interface MessageRejection {
  runActive: boolean;
  uncertain?: boolean;
  inputId?: string;
  stopOutcome?: "unknown" | "unsupported";
  stopTurnId?: string;
  reason?: MessageAdmissionReason;
}

interface ActiveAssistantCursor {
  id: string;
  index: number;
  streamKey?: string;
  authorId?: string;
  jobId?: string;
}

type PendingStreamEvent =
  | { kind: "delta"; text: string; authorId?: string; streamKey?: string; jobId?: string; taskId?: string }
  | { kind: "reasoning"; text: string; authorId?: string; streamKey?: string; jobId?: string; taskId?: string };

type RuntimeInboundEvent = InboundEvent & {
  message_id?: unknown;
  messageId?: unknown;
  id?: unknown;
  stream_id?: unknown;
  job_id?: unknown;
  workflow_run_id?: unknown;
  author_id?: unknown;
  task_id?: unknown;
};

interface EventIdentity {
  messageId?: string;
  streamId?: string;
  jobId?: string;
  workflowRunId?: string;
  authorId?: string;
  taskId?: string;
  streamKey?: string;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function eventIdentity(event: InboundEvent): EventIdentity {
  const raw = event as RuntimeInboundEvent;
  const streamId = nonEmptyString(raw.stream_id);
  const jobId = nonEmptyString(raw.job_id);
  const workflowRunId = nonEmptyString(raw.workflow_run_id);
  const authorId = nonEmptyString(raw.author_id);
  const taskId = nonEmptyString(raw.task_id);
  const messageId =
    nonEmptyString(raw.message_id)
    ?? nonEmptyString(raw.messageId)
    ?? nonEmptyString(raw.id);
  const streamKey = streamId
    ? `stream:${streamId}`
    : jobId
      ? `job:${jobId}`
      : workflowRunId
        ? undefined
        : authorId
          ? `agent:${authorId}`
          : undefined;
  return { messageId, streamId, jobId, workflowRunId, authorId, taskId, streamKey };
}

function findMessageIndexById(messages: UIMessage[], id: string | undefined): number | null {
  if (!id) return null;
  const index = messages.findIndex((message) => message.id === id);
  return index === -1 ? null : index;
}

/** Find a still-open streamed assistant turn. Closed stream segments stay visible
 * as streaming until ``turn_end`` for visual continuity, but they must not
 * receive later delta segments. */
function findStreamingAssistantIndex(
  prev: UIMessage[],
  closedStreamIds: ReadonlySet<string>,
): number | null {
  for (let i = prev.length - 1; i >= 0; i -= 1) {
    const m = prev[i];
    if (m.kind === "trace" || m.kind === "widget") continue;
    if (m.role === "assistant" && m.isStreaming && !closedStreamIds.has(m.id)) return i;
    if (m.role === "user") break;
  }
  return null;
}

/**
 * Append a reasoning chunk to the last open reasoning stream in ``prev``.
 *
 * Lookup rule: prefer the most recent assistant turn in the active UI tail.
 * Most providers emit reasoning before answer text, but some only expose
 * ``reasoning_content`` after the answer stream completes. In that post-hoc
 * case the reasoning still belongs to the same assistant turn and must render
 * above the answer, not as a new row below it.
 */
function attachReasoningChunk(
  prev: UIMessage[],
  chunk: string,
  segments?: {
    ensure: () => string;
  },
): UIMessage[] {
  for (let i = prev.length - 1; i >= 0; i -= 1) {
    const candidate = prev[i];
    // A user turn is a hard boundary: reasoning after it belongs to the new
    // assistant turn, never to an earlier assistant reply.
    if (candidate.role === "user") break;
    // A trace row (e.g. Used tools) is also a phase boundary. Reasoning after
    // tools belongs to the next assistant iteration, not the assistant turn
    // that produced those tool calls.
    if (candidate.kind === "trace" || candidate.kind === "widget") break;
    if (candidate.role !== "assistant") continue;
    const activitySegmentId = candidate.activitySegmentId ?? segments?.ensure();
    const hasAnswer = candidate.content.length > 0;
    if (
      candidate.reasoningStreaming
      || candidate.reasoning !== undefined
      || hasAnswer
      || candidate.isStreaming
    ) {
      const next = prev.slice();
      next[i] = {
        ...candidate,
        reasoning: boundedReasoning((candidate.reasoning ?? "") + chunk),
        reasoningStreaming: true,
        ...(activitySegmentId ? { activitySegmentId } : {}),
      };
      return next;
    }
    if (!hasAnswer && candidate.isStreaming) {
      const next = prev.slice();
      next[i] = {
        ...candidate,
        reasoning: boundedReasoning(chunk),
        reasoningStreaming: true,
        ...(activitySegmentId ? { activitySegmentId } : {}),
      };
      return next;
    }
    break;
  }
  const activitySegmentId = segments?.ensure();
  return [
    ...prev,
    {
      id: crypto.randomUUID(),
      role: "assistant",
      content: "",
      isStreaming: true,
      reasoning: boundedReasoning(chunk),
      reasoningStreaming: true,
      ...(activitySegmentId ? { activitySegmentId } : {}),
      createdAt: Date.now(),
    },
  ];
}

/**
 * Find the most recent assistant placeholder that an incoming answer
 * delta should adopt instead of spawning a parallel row. We look for an
 * empty-content assistant turn that is still marked ``isStreaming`` —
 * typically created earlier by ``reasoning_delta``. Anything else means
 * the model already produced an answer in a previous turn, so the new
 * delta belongs in a fresh row.
 */
function findActiveAssistantPlaceholderIndex(prev: UIMessage[]): number | null {
  const last = prev[prev.length - 1];
  if (!last) return null;
  if (last.role !== "assistant" || last.kind === "trace" || last.kind === "widget") return null;
  if (last.content.length > 0) return null;
  if (!last.isStreaming) return null;
  return prev.length - 1;
}

function replaceMessageAt(prev: UIMessage[], index: number, message: UIMessage): UIMessage[] {
  const next = prev.slice();
  next[index] = message;
  return next;
}

function mergeDeliveredFiles(
  existing: DeliveredFile[] | undefined,
  incoming: DeliveredFile[],
): DeliveredFile[] {
  const next = [...(existing ?? [])];
  const seen = new Set(next.map((file) => file.absolute_path || file.path || file.name));
  for (const file of incoming) {
    const key = file.absolute_path || file.path || file.name;
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(file);
  }
  return next;
}

function mergeMedia(
  existing: UIMediaAttachment[] | undefined,
  incoming: UIMediaAttachment[],
): UIMediaAttachment[] {
  const next = [...(existing ?? [])];
  const seen = new Set(next.map((item) => `${item.kind}|${item.name || item.url || ""}`));
  for (const item of incoming) {
    const key = `${item.kind}|${item.name || item.url || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(item);
  }
  return next;
}

function pendingDeliveryOnce(
  filesRef: { current: DeliveredFile[] },
  mediaRef: { current: UIMediaAttachment[] },
): () => { files: DeliveredFile[]; media: UIMediaAttachment[] } {
  let captured: { files: DeliveredFile[]; media: UIMediaAttachment[] } | undefined;
  return () => {
    if (!captured) {
      captured = { files: filesRef.current, media: mediaRef.current };
      filesRef.current = [];
      mediaRef.current = [];
    }
    return captured;
  };
}

function appendDeliveredFilesToLastAssistant(
  prev: UIMessage[],
  files: DeliveredFile[],
  media: UIMediaAttachment[] = [],
): UIMessage[] {
  if (files.length === 0 && media.length === 0) return prev;
  for (let i = prev.length - 1; i >= 0; i -= 1) {
    const message = prev[i];
    if (message.role === "user") break;
    if (message.role === "assistant" && message.kind !== "trace" && message.kind !== "widget") {
      return replaceMessageAt(prev, i, {
        ...message,
        deliveredFiles: mergeDeliveredFiles(message.deliveredFiles, files),
        media: mergeMedia(message.media, media),
      });
    }
  }
  return [
    ...prev,
    {
      id: `deliver-${Date.now()}`,
      role: "assistant",
      content: "",
      deliveredFiles: files,
      media,
      createdAt: Date.now(),
    },
  ];
}

/**
 * Close the active reasoning stream segment, if any. Idempotent: a
 * ``reasoning_end`` with no preceding deltas is a harmless no-op.
 */
function closeReasoningStream(prev: UIMessage[]): UIMessage[] {
  for (let i = prev.length - 1; i >= 0; i -= 1) {
    const candidate = prev[i];
    if (!candidate.reasoningStreaming) continue;
    const next = prev.slice();
    next[i] = { ...candidate, reasoningStreaming: false };
    return next;
  }
  return prev;
}

function isReasoningOnlyPlaceholder(message: UIMessage): boolean {
  return (
    message.role === "assistant"
    && message.kind !== "trace"
    && message.content.trim().length === 0
    && !!message.reasoning
    && !message.reasoningStreaming
    && !message.media?.length
  );
}

function isToolTrace(message: UIMessage | undefined): boolean {
  return message?.kind === "trace";
}

function pruneReasoningOnlyPlaceholders(prev: UIMessage[]): UIMessage[] {
  return prev.filter((message, index) => {
    if (!isReasoningOnlyPlaceholder(message)) return true;
    // A reasoning-only assistant row immediately followed by tool traces is
    // the live equivalent of a persisted assistant tool-call message with
    // empty content, reasoning_content, and tool_calls. Keep it so live render
    // and history replay stay isomorphic.
    return isToolTrace(prev[index + 1]);
  });
}

function absorbCompleteAssistantMessage(
  prev: UIMessage[],
  message: Omit<UIMessage, "id" | "role" | "createdAt">,
): UIMessage[] {
  const last = prev[prev.length - 1];
  if (!last || !isReasoningOnlyPlaceholder(last)) {
    return [
      ...prev,
      {
        id: crypto.randomUUID(),
        role: "assistant",
        createdAt: Date.now(),
        ...message,
      },
    ];
  }
  return [
    ...prev.slice(0, -1),
    {
      ...last,
      ...message,
      isStreaming: false,
      reasoningStreaming: false,
    },
  ];
}

function fileEditKey(edit: Pick<UIFileEdit, "call_id" | "tool" | "path">): string {
  if (edit.call_id) return `${edit.call_id}|${edit.tool}`;
  return `${edit.tool}|${edit.path}`;
}

function normalizeFileEdit(edit: UIFileEdit): UIFileEdit | null {
  if (!edit || !edit.tool || (!edit.path && !edit.pending)) return null;
  const inferredStatus =
    edit.phase === "error"
      ? "error"
      : edit.phase === "end"
        ? "done"
        : "editing";
  const normalized: UIFileEdit = {
    ...edit,
    call_id: edit.call_id || `${edit.tool}:${edit.path}`,
    added: Number.isFinite(edit.added) ? Math.max(0, Math.round(edit.added)) : 0,
    deleted: Number.isFinite(edit.deleted) ? Math.max(0, Math.round(edit.deleted)) : 0,
    status: edit.status === "error" || edit.status === "done" || edit.status === "editing"
      ? edit.status
      : inferredStatus,
  };
  if (edit.pending && !edit.path) normalized.pending = true;
  return normalized;
}

function mergeFileEdits(existing: UIFileEdit[] | undefined, incoming: UIFileEdit[]): UIFileEdit[] {
  const next = [...(existing ?? [])];
  const indexByKey = new Map(next.map((edit, index) => [fileEditKey(edit), index]));
  for (const raw of incoming) {
    const edit = normalizeFileEdit(raw);
    if (!edit) continue;
    const key = fileEditKey(edit);
    const existingIndex = indexByKey.get(key);
    if (existingIndex === undefined) {
      indexByKey.set(key, next.length);
      next.push(edit);
      continue;
    }
    const merged = { ...next[existingIndex], ...edit };
    if (edit.path && !edit.pending) delete merged.pending;
    next[existingIndex] = merged;
  }
  return next;
}

function findFileEditTraceIndex(
  prev: UIMessage[],
  segmentId: string | null,
  incoming: UIFileEdit[],
): number | null {
  const incomingKeys = new Set(incoming.map(fileEditKey));
  for (let i = prev.length - 1; i >= 0; i -= 1) {
    const candidate = prev[i];
    if (candidate.role === "user") break;
    if (candidate.kind !== "trace" || !candidate.fileEdits?.length) continue;
    if (segmentId && candidate.activitySegmentId === segmentId) return i;
    for (const existing of candidate.fileEdits) {
      if (incomingKeys.has(fileEditKey(existing))) return i;
    }
  }
  return null;
}

/**
 * Subscribe to a chat by ID. Returns the in-memory message list for the chat,
 * a streaming flag, and a ``send`` function. Initial history must be seeded
 * separately (e.g. via ``fetchWebuiThread``) since the server only replays
 * live events.
 */
/** Payload passed to ``send`` when the user attaches one or more images.
 *
 * ``media`` is handed to the wire client verbatim; ``preview`` powers the
 * optimistic user bubble (blob URLs so the preview appears before the server
 * acks the frame). Keeping the two separate lets the bubble re-use the local
 * blob URL even after the server persists the file under a different name. */
export interface SendImage {
  media: OutboundMedia;
  preview: UIImage;
}

export interface SendOptions {
  resumeInput?: boolean;
  awaitConsumption?: boolean;
  inputId?: string;
  onAdmission?: (state: MessageAdmission) => void;
  displayContent?: string;
  quote?: MessageQuote;
  origin?: "profile_advice";
  profileAdviceId?: string;
  /** Workspace-relative documents returned by the document upload endpoint. */
  docPaths?: string[];
  /** Names rendered as optimistic file cards while the canonical history is loading. */
  documentNames?: string[];
  terminalSessionId?: string;
  terminalExecMode?: string;
  dbConnectionId?: string;
  dbDatabase?: string;
  dbTable?: string;
  dbType?: string;
  dbServerVersion?: string;
  dbCurrentSql?: string;
  dbLastError?: string;
  browserTabId?: string;
  browserSidebar?: boolean;
  browserPageUrl?: string;
  browserPageTitle?: string;
  officeSessionId?: string;
  officeDocumentType?: "docs" | "sheets" | "slides";
  officeDisplayName?: string;
  canvasId?: string;
  canvasPath?: string;
  /** Route only this turn through a dedicated document Agent. */
  agentKind?: "video";
  modelBinding?: AgentModelBinding | null;
  /** Structured ``@Agent`` targets in a room (multi-agent guide 7.5). */
  targetAgentIds?: string[];
  /** A bounded topic debate/discussion; rendered separately from workflows. */
  discussion?: DiscussionLaunchOptions;
  taskId?: string;
}

function normalizedTokenUsage(value: import("@/lib/types").RawTokenUsage | undefined): UIMessage["tokenUsage"] {
  if (!value) return undefined;
  const promptTokens = Math.max(0, Math.round(value.prompt_tokens ?? 0));
  const completionTokens = Math.max(0, Math.round(value.completion_tokens ?? 0));
  const cachedTokens = Math.max(
    0,
    Math.round(value.cached_tokens ?? value.cache_read_input_tokens ?? 0),
  );
  const totalTokens = Math.max(
    0,
    Math.round(value.total_tokens ?? promptTokens + completionTokens),
  );
  const contextTokens = typeof value.context_tokens === "number"
    && Number.isSafeInteger(value.context_tokens) && value.context_tokens >= 0 ? value.context_tokens : undefined;
  if (Math.max(promptTokens, completionTokens, cachedTokens, totalTokens) === 0 && contextTokens === undefined) return undefined;
  return {
    promptTokens,
    completionTokens,
    cachedTokens,
    totalTokens,
    ...(contextTokens !== undefined ? { contextTokens } : {}),
    ...((value.context_window_tokens ?? 0) > 0 ? { contextWindowTokens: value.context_window_tokens } : {}),
    ...((value.context_budget_tokens ?? 0) > 0 ? { contextBudgetTokens: value.context_budget_tokens } : {}),
    ...(typeof value.context_model === "string" ? { contextModel: value.context_model } : {}),
    ...(typeof value.context_provider === "string" ? { contextProvider: value.context_provider } : {}),
  };
}

function stampAssistantTurnEnd(
  prev: UIMessage[],
  { tokenUsage, taskId, latencyMs, finalStreamId }: {
    tokenUsage?: UIMessage["tokenUsage"];
    taskId?: string;
    latencyMs?: number;
    finalStreamId?: string;
  },
): UIMessage[] {
  if (!tokenUsage && !taskId && latencyMs === undefined && !finalStreamId) return prev;
  const finalStreamIndex = finalStreamId
    ? prev.findIndex((message) => message.role === "assistant" && message.streamId === finalStreamId)
    : -1;
  let answerIndex = finalStreamIndex;
  let fallbackIndex = -1;
  for (let i = prev.length - 1; answerIndex < 0 && i >= 0; i -= 1) {
    const message = prev[i];
    if (message.role === "user" && !message.isInjected) break;
    if (
      message.role !== "assistant" || message.kind === "trace"
      || (taskId && message.taskId && message.taskId !== taskId)
    ) continue;
    if (message.isFinalResponse) {
      answerIndex = i;
      break;
    }
    if (fallbackIndex < 0 || (!prev[fallbackIndex].content.trim() && message.content.trim())) fallbackIndex = i;
  }
  if (answerIndex < 0) answerIndex = fallbackIndex;
  if (answerIndex < 0) return prev;
  return prev.map((message, index) => {
    if (index === answerIndex) {
      return {
        ...message,
        ...(tokenUsage ? { tokenUsage } : {}),
        ...(taskId ? { taskId } : {}),
        ...(latencyMs !== undefined ? { latencyMs } : {}),
        ...(index === finalStreamIndex ? { isFinalResponse: true } : {}),
      };
    }
    if (
      tokenUsage
      && taskId
      && message.role === "assistant"
      && message.kind !== "trace"
      && message.taskId === taskId
      && message.tokenUsage
    ) {
      const { tokenUsage: _duplicateUsage, ...rest } = message;
      return rest;
    }
    return message;
  });
}

function boundedTraceLines(lines: string[]): string[] {
  return lines.length > MAX_UI_TRACE_LINES ? lines.slice(-MAX_UI_TRACE_LINES) : lines;
}

function toolEventKey(event: ToolProgressEvent, index: number): string {
  const callId = typeof event.call_id === "string" && event.call_id ? event.call_id : `index:${index}`;
  return `${callId}|${event.phase ?? ""}|${event.name ?? ""}`;
}

function boundedToolEvents(
  existing: ToolProgressEvent[] | undefined,
  incoming: ToolProgressEvent[] | undefined,
): ToolProgressEvent[] | undefined {
  if ((!existing || existing.length === 0) && (!incoming || incoming.length === 0)) return undefined;
  const merged = [...(existing ?? []), ...(incoming ?? [])];
  const byKey = new Map<string, ToolProgressEvent>();
  merged.forEach((event, index) => byKey.set(toolEventKey(event, index), event));
  const result = [...byKey.values()];
  return result.length > MAX_UI_TOOL_EVENTS ? result.slice(-MAX_UI_TOOL_EVENTS) : result;
}

export function useMonaStream(
  chatId: string | null,
  initialMessages: UIMessage[] = [],
  _hasPendingToolCalls = false,
  onTurnEnd?: () => void,
): {
  messages: UIMessage[];
  liveTokenUsage?: UIMessage["tokenUsage"];
  runMetrics?: ReturnType<typeof summarizeWorkRequests>;
  liveTokenRate?: number;
  isStreaming: boolean;
  /** True after sending a turn until Mona emits its first visible activity. */
  isAwaitingModelResponse: boolean;
  /** True only while the server is generating a replacement context handoff. */
  isCompacting: boolean;
  /** True after the user requested stop until the server confirms completion. */
  stopping: boolean;
  /** Unix epoch seconds when the current user turn started (WebSocket ``goal_status``). */
  runStartedAt: number | null;
  /** Latest sustained goal for this ``chatId`` (``goal_state`` WS events). */
  goalState: GoalStateWsPayload | undefined;
  taskPlan: TaskPlanWsPayload | undefined;
  currentTaskId: string | null;
  send: (content: string, images?: SendImage[], options?: SendOptions) => void;
  inject: (content: string, images?: SendImage[], options?: SendOptions) => void;
  stop: () => void;
  setMessages: React.Dispatch<React.SetStateAction<UIMessage[]>>;
  /** Latest transport-level fault raised since the last ``dismissStreamError``.
   * ``null`` when there is nothing to show. */
  streamError: StreamError | null;
  /** Clear the current ``streamError`` (e.g. after the user dismisses the
   * notification or starts a fresh action). */
  dismissStreamError: () => void;
  messageRejection: MessageRejection | null;
  dismissMessageRejection: () => void;
} {
  const { client } = useClientOptional();
  const [messages, setMessages] = useState<UIMessage[]>(initialMessages);
  const [deletionVersion, setDeletionVersion] = useState(0);
  const initialRunStartedAt = chatId && client ? client.getRunStartedAt(chatId) : null;
  const [isStreaming, setIsStreaming] = useState(initialRunStartedAt !== null);
  // A restored in-progress turn may already have emitted activity before this
  // view subscribed, so only locally sent turns enter the waiting phase.
  const [isAwaitingModelResponse, setIsAwaitingModelResponse] = useState(false);
  const [isCompacting, setIsCompacting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const hostedRef = useRef(Boolean(getHostedPlatform()));
  hostedRef.current ||= Boolean(getHostedPlatform());
  const stoppingRef = useRef(false);
  const stopRequestRef = useRef<{ turnId?: string; inputId?: string } | null>(null);
  const unresolvedStopRef = useRef<{ turnId?: string; inputId?: string } | null>(null);
  const stopTargetWaitRef = useRef<(() => void) | null>(null);
  /** Unix epoch seconds when the current user turn started; cleared on ``idle``. */
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [goalState, setGoalState] = useState<GoalStateWsPayload | undefined>(undefined);
  const [taskPlan, setTaskPlan] = useState<TaskPlanWsPayload | undefined>(undefined);
  const [currentTaskId, setCurrentTaskId] = useState<string | null>(null);
  const [liveTokenUsage, setLiveTokenUsage] = useState<UIMessage["tokenUsage"]>();
  const [workRequests, setWorkRequests] = useState<WorkRequestSeries | null>(null);
  const runMetrics = useMemo(() => isStreaming ? summarizeWorkRequests(workRequests) : undefined, [isStreaming, workRequests]);
  const liveTokenSampler = useMemo(() => new LiveTokenSampler(), []);
  const [liveTokenRate, setLiveTokenRate] = useState<number>();
  const resetLiveTokenRate = useCallback(() => {
    liveTokenSampler.reset();
    setLiveTokenRate(undefined);
  }, [liveTokenSampler]);
  useEffect(() => {
    if (!isStreaming) {
      resetLiveTokenRate();
      return;
    }
    const timer = window.setInterval(() => setLiveTokenRate(liveTokenSampler.rate(performance.now())), 500);
    return () => window.clearInterval(timer);
  }, [isStreaming, liveTokenSampler, resetLiveTokenRate]);
  const currentTaskIdRef = useRef<string | null>(null);
  const [streamError, setStreamError] = useState<StreamError | null>(null);
  const [messageRejection, setMessageRejection] = useState<MessageRejection | null>(null);
  const activeChatRef = useRef(chatId);
  activeChatRef.current = chatId;
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopTargetWaitRef.current?.();
      stopTargetWaitRef.current = null;
    };
  }, []);
  const pendingMessageRef = useRef<PendingMessage | null>(null);
  const buffer = useRef<StreamBuffer | null>(null);
  const activeAssistantRef = useRef<ActiveAssistantCursor | null>(null);
  /** Open streamed bubbles indexed by backend stream/job identity. */
  const streamMessageIdsRef = useRef<Map<string, string>>(new Map());
  /** Completed message identities used to make duplicate complete frames idempotent. */
  const messageIdentityIdsRef = useRef<Map<string, string>>(new Map());
  const closedAssistantStreamIdsRef = useRef<Set<string>>(new Set());
  const activitySegmentRef = useRef<string | null>(null);
  const fileEditSegmentRef = useRef<string | null>(null);
  const activitySegmentCounterRef = useRef(0);
  const pendingStreamEventsRef = useRef<PendingStreamEvent[]>([]);
  const pendingDeliveredFilesRef = useRef<DeliveredFile[]>([]);
  const pendingDeliveredMediaRef = useRef<UIMediaAttachment[]>([]);
  const streamFrameRef = useRef<number | null>(null);
  const suppressStreamUntilTurnEndRef = useRef(false);
  /** Timer that defers ``isStreaming = false`` after ``stream_end``.
   *
   * When the model finishes a text segment and calls a tool, the server
   * sends ``stream_end`` but the agent is still "thinking" while the tool
   * executes.  By deferring the flag reset by a short window (1 s) we keep
   * the loading spinner alive across tool-call boundaries without needing
   * backend changes. */
  const streamEndTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!client) return undefined;
    return client.onError((err) => { setMessageRejection(null); setStreamError(err); });
  }, [client]);

  const dismissStreamError = useCallback(() => setStreamError(null), []);
  const dismissMessageRejection = useCallback(() => setMessageRejection(null), []);

  const clearPendingStreamWork = useCallback(() => {
    if (streamFrameRef.current !== null) {
      window.cancelAnimationFrame(streamFrameRef.current);
      streamFrameRef.current = null;
    }
    pendingStreamEventsRef.current = [];
  }, []);

  useEffect(() => client?.onSessionDeleted((deletedChatId) => {
    if (activeChatRef.current !== deletedChatId) return;
    stopTargetWaitRef.current?.();
    stopTargetWaitRef.current = null;
    pendingMessageRef.current = null;
    stopRequestRef.current = null;
    unresolvedStopRef.current = null;
    clearPendingStreamWork();
    setDeletionVersion((value) => value + 1);
  }), [client, clearPendingStreamWork]);

  const createActivitySegmentId = useCallback((activate = true) => {
    activitySegmentCounterRef.current += 1;
    const id = `activity-${activitySegmentCounterRef.current}`;
    if (activate) activitySegmentRef.current = id;
    return id;
  }, []);

  const freshActivitySegmentId = useCallback(
    () => createActivitySegmentId(true),
    [createActivitySegmentId],
  );

  const detachedActivitySegmentId = useCallback(
    () => createActivitySegmentId(false),
    [createActivitySegmentId],
  );

  const ensureActivitySegmentId = useCallback(() => {
    if (activitySegmentRef.current) return activitySegmentRef.current;
    return freshActivitySegmentId();
  }, [freshActivitySegmentId]);

  const clearActivitySegment = useCallback(() => {
    activitySegmentRef.current = null;
    fileEditSegmentRef.current = null;
  }, []);

  const forgetStreamMessage = useCallback((messageId: string) => {
    for (const [key, id] of streamMessageIdsRef.current) {
      if (id === messageId) streamMessageIdsRef.current.delete(key);
    }
  }, []);

  const closeAssistantStream = useCallback((streamKey?: string) => {
    const active = activeAssistantRef.current;
    const messageId = streamKey
      ? streamMessageIdsRef.current.get(streamKey)
        ?? (active?.streamKey === streamKey ? active.id : undefined)
      : buffer.current?.messageId ?? active?.id;
    if (messageId) {
      closedAssistantStreamIdsRef.current.add(messageId);
      forgetStreamMessage(messageId);
    }
    if (streamKey) streamMessageIdsRef.current.delete(streamKey);
    if (!streamKey || buffer.current?.messageId === messageId) buffer.current = null;
    if (!streamKey || active?.id === messageId) activeAssistantRef.current = null;
  }, [forgetStreamMessage]);

  const resolveActiveAssistantIndex = useCallback((prev: UIMessage[]): number | null => {
    const cursor = activeAssistantRef.current;
    if (!cursor) return null;
    const indexed = prev[cursor.index];
    if (indexed?.id === cursor.id && indexed.role === "assistant" && indexed.kind !== "trace") {
      return cursor.index;
    }
    const idx = prev.findIndex((m) => m.id === cursor.id);
    if (idx === -1) {
      activeAssistantRef.current = null;
      return null;
    }
    const found = prev[idx];
    if (found.role !== "assistant" || found.kind === "trace") {
      activeAssistantRef.current = null;
      return null;
    }
    activeAssistantRef.current = {
      id: cursor.id,
      index: idx,
      ...(cursor.streamKey ? { streamKey: cursor.streamKey } : {}),
      ...(cursor.authorId ? { authorId: cursor.authorId } : {}),
      ...(cursor.jobId ? { jobId: cursor.jobId } : {}),
    };
    return idx;
  }, []);

  const resolveStreamAssistantIndex = useCallback((prev: UIMessage[], streamKey?: string): number | null => {
    if (!streamKey) return null;
    const messageId = streamMessageIdsRef.current.get(streamKey);
    const index = findMessageIndexById(prev, messageId);
    if (index === null) {
      streamMessageIdsRef.current.delete(streamKey);
      return null;
    }
    const message = prev[index];
    if (
      message.role !== "assistant"
      || message.kind === "trace"
      || closedAssistantStreamIdsRef.current.has(message.id)
    ) {
      streamMessageIdsRef.current.delete(streamKey);
      return null;
    }
    return index;
  }, []);

  const applyPendingStreamEvents = useCallback(
    (prev: UIMessage[], events: PendingStreamEvent[]): UIMessage[] => {
      if (events.length === 0) return prev;
      // Single array copy — all mutations happen on this draft,
      // eliminating the O(events × messages) cascade of intermediate arrays.
      const draft = prev.slice();
      for (let i = 0; i < events.length;) {
        const kind = events[i].kind;
        const authorId = events[i].authorId;
        const streamKey = events[i].streamKey;
        const streamId = streamKey?.startsWith("stream:") ? streamKey.slice("stream:".length) : undefined;
        const jobId = events[i].jobId;
        const taskId = events[i].taskId;
        let text = "";
        while (
          i < events.length
          && events[i].kind === kind
          && (events[i].authorId ?? null) === (authorId ?? null)
          && (events[i].streamKey ?? null) === (streamKey ?? null)
          && (events[i].jobId ?? null) === (jobId ?? null)
          && (events[i].taskId ?? null) === (taskId ?? null)
        ) {
          text += events[i].text;
          i += 1;
        }
        if (kind === "delta") {
          // Inline appendAnswerChunk: find target, mutate draft in-place
          let targetIndex = resolveStreamAssistantIndex(draft, streamKey);
          if (targetIndex === null && (!streamKey || activeAssistantRef.current?.streamKey === streamKey)) {
            targetIndex = resolveActiveAssistantIndex(draft);
          }
          if (targetIndex === null && !streamKey) {
            targetIndex = findActiveAssistantPlaceholderIndex(draft);
          }
          if (targetIndex === null && !streamKey) {
            targetIndex = findStreamingAssistantIndex(draft, closedAssistantStreamIdsRef.current);
          }
          if (targetIndex === null) {
            const id = crypto.randomUUID();
            draft.push({
              id,
              role: "assistant",
              content: "",
              isStreaming: true,
              createdAt: Date.now(),
              ...(authorId ? { authorId, authorType: "agent" as const } : {}),
              ...(taskId ? { taskId } : {}),
            });
            targetIndex = draft.length - 1;
          }
          const target = draft[targetIndex];
          const merged: UIMessage = {
            ...target,
            content: target.content + text,
            isStreaming: true,
            ...(streamId ? { streamId } : {}),
            ...(authorId && !target.authorId
              ? { authorId, authorType: "agent" as const }
              : {}),
            ...(taskId && !target.taskId ? { taskId } : {}),
          };
          closedAssistantStreamIdsRef.current.delete(merged.id);
          activeAssistantRef.current = {
            id: merged.id,
            index: targetIndex,
            ...(streamKey ? { streamKey } : {}),
            ...(authorId ? { authorId } : {}),
            ...(jobId ? { jobId } : {}),
          };
          buffer.current = {
            messageId: merged.id,
            ...(streamKey ? { streamKey } : {}),
            ...(authorId ? { authorId } : {}),
            ...(jobId ? { jobId } : {}),
          };
          if (streamKey) streamMessageIdsRef.current.set(streamKey, merged.id);
          draft[targetIndex] = merged;
        } else {
          // Inline attachReasoningChunk: find target, mutate draft in-place
          let found = false;
          const keyedReasoningIndex = resolveStreamAssistantIndex(draft, streamKey);
          if (keyedReasoningIndex !== null) {
            const candidate = draft[keyedReasoningIndex];
            const activitySegmentId = candidate.activitySegmentId ?? ensureActivitySegmentId();
            draft[keyedReasoningIndex] = {
              ...candidate,
              reasoning: boundedReasoning((candidate.reasoning ?? "") + text),
              reasoningStreaming: true,
              ...(streamId ? { streamId } : {}),
              ...(activitySegmentId ? { activitySegmentId } : {}),
            };
            found = true;
          } else if (!streamKey) {
            for (let j = draft.length - 1; j >= 0; j -= 1) {
              const candidate = draft[j];
              if (candidate.role === "user") break;
              if (candidate.kind === "trace" || candidate.kind === "widget") break;
              if (candidate.role !== "assistant") continue;
              const activitySegmentId = candidate.activitySegmentId ?? ensureActivitySegmentId();
              const hasAnswer = candidate.content.length > 0;
              if (
                candidate.reasoningStreaming
                || candidate.reasoning !== undefined
                || hasAnswer
                || candidate.isStreaming
              ) {
                draft[j] = {
                  ...candidate,
                  reasoning: boundedReasoning((candidate.reasoning ?? "") + text),
                  reasoningStreaming: true,
                  ...(activitySegmentId ? { activitySegmentId } : {}),
                };
                found = true;
                break;
              }
              if (!hasAnswer && candidate.isStreaming) {
                draft[j] = {
                  ...candidate,
                  reasoning: boundedReasoning(text),
                  reasoningStreaming: true,
                  ...(activitySegmentId ? { activitySegmentId } : {}),
                };
                found = true;
                break;
              }
              break;
            }
          }
          if (!found) {
            const activitySegmentId = ensureActivitySegmentId();
            const id = crypto.randomUUID();
            draft.push({
              id,
              role: "assistant",
              content: "",
              isStreaming: true,
              reasoning: boundedReasoning(text),
              reasoningStreaming: true,
              ...(streamId ? { streamId } : {}),
              ...(activitySegmentId ? { activitySegmentId } : {}),
              createdAt: Date.now(),
            });
            if (streamKey) {
              streamMessageIdsRef.current.set(streamKey, id);
              activeAssistantRef.current = {
                id,
                index: draft.length - 1,
                streamKey,
                ...(authorId ? { authorId } : {}),
                ...(jobId ? { jobId } : {}),
              };
              buffer.current = {
                messageId: id,
                streamKey,
                ...(authorId ? { authorId } : {}),
                ...(jobId ? { jobId } : {}),
              };
            }
          }
        }
      }
      return draft;
    },
    [resolveActiveAssistantIndex, resolveStreamAssistantIndex, ensureActivitySegmentId],
  );

  const flushPendingStreamEvents = useCallback((options?: {
    closeAnswerSegment?: boolean;
    streamKey?: string;
  }) => {
    if (streamFrameRef.current !== null) {
      window.cancelAnimationFrame(streamFrameRef.current);
      streamFrameRef.current = null;
    }
    const events = pendingStreamEventsRef.current;
    if (events.length === 0) {
      if (options?.closeAnswerSegment) closeAssistantStream(options.streamKey);
      return;
    }
    pendingStreamEventsRef.current = [];
    setMessages((prev) => {
      const next = applyPendingStreamEvents(prev, events);
      if (options?.closeAnswerSegment) closeAssistantStream(options.streamKey);
      return next;
    });
  }, [applyPendingStreamEvents, closeAssistantStream]);

  const schedulePendingStreamFlush = useCallback(() => {
    if (streamFrameRef.current !== null) return;
    streamFrameRef.current = window.requestAnimationFrame(() => {
      streamFrameRef.current = null;
      const events = pendingStreamEventsRef.current;
      if (events.length === 0) return;
      pendingStreamEventsRef.current = [];
      setMessages((prev) => applyPendingStreamEvents(prev, events));
    });
  }, [applyPendingStreamEvents]);

  // Reset local state when switching chats. Do not reset on every
  // ``initialMessages`` update: a brand-new chat can receive an empty/404
  // history response after the optimistic first message has already rendered.
  useEffect(() => {
    const restoredMessages = chatId && client?.isChatDeleted(chatId) ? [] : initialMessages.map((message) => {
      const admission = chatId && client?.getMessageAdmission?.(chatId, message.id);
      return admission ? { ...message,
        sendState: admission === "accepted" || admission === "consumed" ? undefined
          : admission === "rejected" || admission === "cancelled" || admission === "paused" ? "rejected" as const : "pending" as const,
        ...(message.isInjected !== undefined ? { isInjected: admission === "consumed" } : {}),
      } : message;
    });
    setMessages(restoredMessages.some((message, index) => message !== initialMessages[index]) ? restoredMessages : initialMessages);
    const restoredRunStartedAt = chatId && client ? client.getRunStartedAt(chatId) : null;
    const restoredTaskPlan = chatId && client ? client.getTaskPlan?.(chatId) : undefined;
    const pending = restoredMessages.slice().reverse().find((message) => message.sendState === "pending" && message.taskId && message.isInjected !== false);
    pendingMessageRef.current = pending?.taskId ? {
      taskId: pending.taskId,
      messageId: pending.id,
      previousTaskId: restoredTaskPlan?.task_id ?? null,
      previousTaskPlan: restoredTaskPlan,
      awaitingAdmission: false,
    } : null;
    currentTaskIdRef.current = pending?.taskId ?? null;
    setCurrentTaskId(currentTaskIdRef.current);
    setIsStreaming(restoredRunStartedAt !== null);
    setStreamError(null);
    setMessageRejection(null);
    setIsAwaitingModelResponse(false);
    setIsCompacting(false);
    setRunStartedAt(restoredRunStartedAt);
    setGoalState(chatId && client ? client.getGoalState(chatId) : undefined);
    setTaskPlan(restoredTaskPlan);
    setLiveTokenUsage(undefined);
    setWorkRequests(null);
    resetLiveTokenRate();
    stopTargetWaitRef.current?.();
    stopTargetWaitRef.current = null;
    stoppingRef.current = false;
    stopRequestRef.current = null;
    unresolvedStopRef.current = null;
    setStopping(false);
    buffer.current = null;
    activeAssistantRef.current = null;
    streamMessageIdsRef.current.clear();
    messageIdentityIdsRef.current.clear();
    closedAssistantStreamIdsRef.current.clear();
    pendingDeliveredFilesRef.current = [];
    pendingDeliveredMediaRef.current = [];
    clearActivitySegment();
    clearPendingStreamWork();
    suppressStreamUntilTurnEndRef.current = false;
    if (streamEndTimerRef.current !== null) {
      clearTimeout(streamEndTimerRef.current);
      streamEndTimerRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, client, clearActivitySegment, clearPendingStreamWork, deletionVersion, resetLiveTokenRate]);

  useEffect(() => {
    if (!chatId || !client) return;

    const confirmStop = (turnId: string | undefined) => {
      if (!turnId) return null;
      const confirmed = unresolvedStopRef.current?.turnId === turnId ? unresolvedStopRef.current : null;
      if (confirmed) unresolvedStopRef.current = null;
      if (stopRequestRef.current?.turnId === turnId) stopRequestRef.current = null;
      setMessageRejection((current) => current?.stopOutcome === "unknown" && current.stopTurnId === turnId ? null : current);
      return confirmed;
    };
    const finishWaitingStop = (inputId: string | undefined) => {
      const request = stopRequestRef.current;
      if (!inputId) return;
      if (request && !request.turnId && request.inputId === inputId) {
        stopTargetWaitRef.current?.();
        stopTargetWaitRef.current = null;
        stopRequestRef.current = null;
      }
      const unresolved = unresolvedStopRef.current;
      if (unresolved && !unresolved.turnId && unresolved.inputId === inputId) {
        unresolvedStopRef.current = null;
        setMessageRejection((current) => current?.stopOutcome === "unknown" && !current.stopTurnId ? null : current);
      }
    };
    const handle = (ev: InboundEvent) => {
      if (client.isChatDeleted(chatId)) return;
      if (ev.event === "error") {
        if (ev.input_id) return;
        const pending = pendingMessageRef.current;
        if (ev.message_rejected !== true || ev.chat_id !== chatId || !pending || ev.task_id !== pending.taskId) return;
        if (ev.code === "billing_unknown") {
          if (!client.markBillingUnknown(chatId, pending.messageId)) {
            setMessageRejection({ runActive: client.getRunStartedAt(chatId) !== null, uncertain: true,
              inputId: pending.messageId, reason: "billing_unknown" });
          }
          return;
        }
        pendingMessageRef.current = null;
        setMessages((previous) => previous.map((message) => message.id === pending.messageId
          ? { ...message, sendState: "rejected" }
          : message));
        const activeRunStartedAt = client.getRunStartedAt(chatId);
        setIsAwaitingModelResponse(false);
        setIsStreaming(activeRunStartedAt !== null);
        setRunStartedAt(activeRunStartedAt);
        if (currentTaskIdRef.current === pending.taskId) {
          currentTaskIdRef.current = pending.previousTaskId;
          setCurrentTaskId(pending.previousTaskId);
          setTaskPlan(pending.previousTaskPlan);
        }
        if (activeRunStartedAt === null) {
          setIsCompacting(false);
          stoppingRef.current = false;
          setStopping(false);
          suppressStreamUntilTurnEndRef.current = false;
        }
        setMessageRejection({ runActive: activeRunStartedAt !== null,
          ...(isMessageAdmissionRejectionReason(ev.code) ? { reason: ev.code } : {}) });
        return;
      }
      if (ev.event === "context_usage") {
        if (ev.chat_id !== chatId || ev.job_id) return;
        const usage = normalizedTokenUsage(ev.token_usage);
        if (usage?.contextTokens !== undefined) setLiveTokenUsage(usage);
        const turnKey = ev.turn_id ?? ev.input_id;
        const currentTurnId = client.getWorkTurn?.(chatId)?.turnId;
        const sample = ev.token_usage?.request_stats;
        if (turnKey && sample && (!ev.turn_id || !currentTurnId || ev.turn_id === currentTurnId)) {
          setWorkRequests((current) => appendWorkRequest(current, turnKey, sample));
        }
        return;
      }
      const identity = eventIdentity(ev);
      const primaryStream = !identity.jobId && !identity.workflowRunId && (
        !identity.taskId || !currentTaskIdRef.current || identity.taskId === currentTaskIdRef.current
      );
      const acceptPendingMessage = () => {
        const pending = pendingMessageRef.current;
        if (!pending) return;
        pendingMessageRef.current = null;
        setMessages((previous) => previous.map((message) => message.id === pending.messageId
          ? { ...message, sendState: undefined }
          : message));
      };
      // Any incoming event while the debounce timer is alive means the model
      // is still working (e.g. tool result arrived, more text to stream).
      // Cancel the pending "stream ended" timer so we don't hide the spinner.
      if (streamEndTimerRef.current !== null) {
        clearTimeout(streamEndTimerRef.current);
        streamEndTimerRef.current = null;
      }

      if (ev.event === "delta") {
        if (suppressStreamUntilTurnEndRef.current) return;
        const chunk = typeof ev.text === "string" ? ev.text : "";
        if (!chunk) return;
        if (primaryStream) liveTokenSampler.push(chunk, performance.now());
        clearActivitySegment();
        setIsAwaitingModelResponse(false);
        setIsStreaming(true);
        pendingStreamEventsRef.current.push({
          kind: "delta",
          text: chunk,
          ...(identity.authorId ? { authorId: identity.authorId } : {}),
          ...(identity.streamKey ? { streamKey: identity.streamKey } : {}),
          ...(identity.jobId ? { jobId: identity.jobId } : {}),
          ...(identity.taskId ? { taskId: identity.taskId } : {}),
        });
        schedulePendingStreamFlush();
        return;
      }

      if (ev.event === "reasoning_delta") {
        if (suppressStreamUntilTurnEndRef.current) return;
        const chunk = ev.text;
        if (!chunk) return;
        if (primaryStream) liveTokenSampler.push(chunk, performance.now());
        if (fileEditSegmentRef.current) clearActivitySegment();
        setIsAwaitingModelResponse(false);
        setIsStreaming(true);
        pendingStreamEventsRef.current.push({
          kind: "reasoning",
          text: chunk,
          ...(identity.authorId ? { authorId: identity.authorId } : {}),
          ...(identity.streamKey ? { streamKey: identity.streamKey } : {}),
          ...(identity.jobId ? { jobId: identity.jobId } : {}),
          ...(identity.taskId ? { taskId: identity.taskId } : {}),
        });
        schedulePendingStreamFlush();
        return;
      }

      if (ev.event === "stream_end") {
        flushPendingStreamEvents({ closeAnswerSegment: true, streamKey: identity.streamKey });
        if (suppressStreamUntilTurnEndRef.current) return;
        if (primaryStream) resetLiveTokenRate();
        // stream_end only means the text segment finished — the model may
        // still be executing tools.  Do NOT reset isStreaming here; the
        // definitive "turn is complete" signal is ``turn_end``.
        return;
      }

      flushPendingStreamEvents();

      if (ev.event === "user_questions") {
        if (ev.requests.length > 0) {
          setIsAwaitingModelResponse(false);
          const pendingDelivery = pendingDeliveryOnce(pendingDeliveredFilesRef, pendingDeliveredMediaRef);
          setMessages((previous) => {
            const visible = previous.map((message) => message.isStreaming ? { ...message, isStreaming: false } : message);
            const { files, media } = pendingDelivery();
            return appendDeliveredFilesToLastAssistant(closeReasoningStream(visible), files, media);
          });
        }
        return;
      }

      if (ev.event === "widget") {
        if (suppressStreamUntilTurnEndRef.current && ev.widget.status === "streaming") return;
        setIsAwaitingModelResponse(false);
        setMessages((previous) => upsertInlineWidgetMessage(previous, ev.widget, identity));
        return;
      }

      if (ev.event === "reasoning_end") {
        if (suppressStreamUntilTurnEndRef.current) return;
        setMessages((prev) => closeReasoningStream(prev));
        return;
      }

      if (ev.event === "goal_state") {
        setGoalState(ev.goal_state);
        return;
      }

      if (ev.event === "task_plan") {
        if (
          currentTaskIdRef.current
          && ev.task_plan.task_id
          && ev.task_plan.task_id !== currentTaskIdRef.current
        ) return;
        setTaskPlan(ev.task_plan);
        return;
      }

      if (ev.event === "artifact_task_started") {
        const pending = pendingMessageRef.current;
        if (pending && ev.task_id !== pending.taskId) return;
        if (pending && pending.previousTaskId !== pending.taskId) acceptPendingMessage();
        currentTaskIdRef.current = ev.task_id;
        setCurrentTaskId(ev.task_id);
        setTaskPlan(undefined);
        return;
      }

      if (ev.event === "goal_status") {
        if (ev.status === "running") {
          const turnKey = ev.turn_id ?? ev.input_id;
          if (turnKey) setWorkRequests((current) => current?.turnKey === turnKey ? current : null);
          if (ev.turn_id && stopRequestRef.current?.turnId && ev.turn_id !== stopRequestRef.current.turnId) {
            stopRequestRef.current = null;
            unresolvedStopRef.current = null;
            stoppingRef.current = false;
            suppressStreamUntilTurnEndRef.current = false;
            setStopping(false);
          }
          if (ev.turn_state === "unknown" && stoppingRef.current && ev.turn_id
              && unresolvedStopRef.current?.turnId === ev.turn_id) {
            stopRequestRef.current = null;
            stoppingRef.current = false;
            setStopping(false);
            suppressStreamUntilTurnEndRef.current = false;
            if (!hostedRef.current) {
              setMessageRejection({ runActive: true, stopOutcome: "unknown", stopTurnId: ev.turn_id });
            }
          }
          setIsStreaming(true);
          if (!stoppingRef.current) setStopping(false);
          if (typeof ev.started_at === "number") {
            setRunStartedAt(ev.started_at);
          } else {
            setRunStartedAt((current) => current ?? Date.now() / 1000);
          }
        } else {
          // Attach may report the previous idle state before this message is admitted.
          const waiting = stopRequestRef.current;
          if (waiting && !waiting.turnId && waiting.inputId && ev.input_id !== waiting.inputId) return;
          if (ev.turn_id) finishWaitingStop(ev.input_id);
          const confirmed = ev.stop_confirmed === true ? confirmStop(ev.turn_id) : null;
          const confirmedInput = !!confirmed?.inputId && confirmed.inputId === pendingMessageRef.current?.messageId;
          if ((pendingMessageRef.current?.awaitingAdmission && !stoppingRef.current && !confirmedInput)
              || client.getRunStartedAt(chatId) !== null) return;
          if (stoppingRef.current || confirmedInput) acceptPendingMessage();
          setIsStreaming(false);
          setIsAwaitingModelResponse(false);
          setIsCompacting(false);
          stoppingRef.current = false;
          setStopping(false);
          suppressStreamUntilTurnEndRef.current = false;
          setRunStartedAt(null);
        }
        return;
      }

      // Direct @Agent requests are acknowledged before their background jobs
      // finish, so they do not emit the normal turn_end frame.
      if (ev.event === "agent_mentions_routed") {
        acceptPendingMessage();
        setIsStreaming(true);
        return;
      }

      if (ev.event === "discussion_updated") {
        const run = ev as Partial<WorkflowRun>;
        if (typeof run.id !== "string" || !run.workflow || !run.steps) return;
        acceptPendingMessage();
        setMessages((prev) => {
          const id = `discussion:${run.id}`;
          const index = prev.findIndex((message) => message.id === id);
          const message: UIMessage = {
            id,
            role: "assistant",
            kind: "discussion",
            content: "",
            workflowRunId: run.id,
            payload: run,
            createdAt: index >= 0 ? prev[index].createdAt : Date.now(),
          };
          if (index < 0) return [...prev, message];
          const next = prev.slice();
          next[index] = message;
          return next;
        });
        if (run.status === "succeeded" || run.status === "failed" || run.status === "cancelled") {
          setIsStreaming(false);
          setIsAwaitingModelResponse(false);
          stoppingRef.current = false;
          setStopping(false);
          setRunStartedAt(null);
          onTurnEnd?.();
        } else {
          setIsStreaming(true);
        }
        return;
      }

      // Some direct @Agent backends report completion explicitly instead of
      // sending the normal turn_end frame. Keep this string-based for
      // compatibility with servers that add the event before the shared type.
      if ((ev as { event?: string }).event === "agent_mentions_completed") {
        acceptPendingMessage();
        setIsStreaming(false);
        setIsAwaitingModelResponse(false);
        stoppingRef.current = false;
        setStopping(false);
        suppressStreamUntilTurnEndRef.current = false;
        return;
      }

      if (ev.event === "turn_end") {
        const pending = pendingMessageRef.current;
        if (pending && ev.task_id && ev.task_id !== pending.taskId) return;
        finishWaitingStop(ev.input_id);
        if (ev.stop_confirmed === true) confirmStop(ev.turn_id);
        acceptPendingMessage();
        setMessages((previous) => finishPendingWidgets(previous));
        const usage = normalizedTokenUsage(ev.token_usage);
        if (usage?.contextTokens !== undefined) setLiveTokenUsage(usage);
        const finishedKey = ev.turn_id ?? ev.input_id;
        if (finishedKey) {
          setWorkRequests((current) => current?.turnKey === finishedKey
            ? { ...current, finished: true } : current);
        }
        resetLiveTokenRate();
        if ("goal_state" in ev && ev.goal_state != null && typeof ev.goal_state === "object") {
          setGoalState(ev.goal_state);
        }
        // Definitive signal that the turn is fully complete.  Cancel any
        // pending debounce timer and stop the loading indicator immediately.
        if (streamEndTimerRef.current !== null) {
          clearTimeout(streamEndTimerRef.current);
          streamEndTimerRef.current = null;
        }
        setIsStreaming(false);
        setRunStartedAt(null);
        setIsAwaitingModelResponse(false);
        setIsCompacting(false);
        stoppingRef.current = false;
        setStopping(false);
        const pendingDelivery = pendingDeliveryOnce(pendingDeliveredFilesRef, pendingDeliveredMediaRef);
        setMessages((prev) => {
          let finalized = prev.map((m) => (m.isStreaming ? { ...m, isStreaming: false } : m));
          finalized = pruneReasoningOnlyPlaceholders(finalized);
          const { files, media } = pendingDelivery();
          if (files.length > 0) {
            finalized = appendDeliveredFilesToLastAssistant(finalized, files, media);
          }
          finalized = stampAssistantTurnEnd(finalized, {
            tokenUsage: usage,
            taskId: ev.task_id,
            latencyMs: typeof ev.latency_ms === "number" && ev.latency_ms >= 0 ? Math.round(ev.latency_ms) : undefined,
            finalStreamId: ev.final_stream_id,
          });
          buffer.current = null;
          activeAssistantRef.current = null;
          streamMessageIdsRef.current.clear();
          clearActivitySegment();
          closedAssistantStreamIdsRef.current.clear();
          return finalized;
        });
        suppressStreamUntilTurnEndRef.current = false;
        onTurnEnd?.();
        return;
      }

      if (ev.event === "message") {
        if (typeof ev.context_compacting === "boolean") {
          setIsCompacting(ev.context_compacting);
          if (ev.context_compacting) {
            setLiveTokenUsage(undefined);
            resetLiveTokenRate();
          }
          return;
        }
        if (
          suppressStreamUntilTurnEndRef.current &&
          (ev.kind === "tool_hint" || ev.kind === "progress" || ev.kind === "reasoning")
        ) {
          return;
        }
        // Back-compat: a legacy ``kind: "reasoning"`` message (no streaming
        // partner) is treated as one complete delta + immediate end so the
        // bubble renders identically to the streaming path.
        if (ev.kind === "reasoning") {
          const line = ev.text;
          if (!line) return;
          setIsAwaitingModelResponse(false);
          if (fileEditSegmentRef.current) clearActivitySegment();
          setMessages((prev) => closeReasoningStream(attachReasoningChunk(prev, line, {
            ensure: ensureActivitySegmentId,
          })));
          return;
        }
        // Intermediate agent breadcrumbs (tool-call hints, raw progress).
        // Attach them to the last trace row if it was the last emitted item
        // so a sequence of calls collapses into one compact trace group.
        if (ev.kind === "tool_hint" || ev.kind === "progress") {
          if (primaryStream && ev.tool_events?.some((event) => event.phase === "start")) resetLiveTokenRate();
          const structuredLines = toolTraceLinesFromEvents(ev.tool_events);
          const lines = structuredLines.length > 0
            ? structuredLines
            : ev.text
              ? [ev.text]
              : [];
          if (lines.length === 0) return;
          setIsAwaitingModelResponse(false);
          setMessages((prev) => {
            const segmentId = ensureActivitySegmentId();
            const last = prev[prev.length - 1];
            if (
              last
              && last.kind === "trace"
              && !last.media?.length && !last.deliveredFiles?.length
              && !last.isStreaming
              && (!identity.taskId || identity.taskId === last.taskId)
              && (!last.activitySegmentId || last.activitySegmentId === segmentId)
            ) {
              const previousTraces = last.traces?.length
                ? last.traces
                : last.content
                  ? [last.content]
                  : [];
              const mergedLines = structuredLines.length > 0
                ? mergeUniqueToolTraceLines(previousTraces, structuredLines)
                : null;
              const toolEvents = boundedToolEvents(last.toolEvents, ev.tool_events);
              if (mergedLines && !mergedLines.added && !ev.tool_events?.length) return prev;
              const merged: UIMessage = {
                ...last,
                traces: boundedTraceLines(mergedLines ? mergedLines.traces : [...previousTraces, ...lines]),
                content: mergedLines
                  ? mergedLines.traces[mergedLines.traces.length - 1]
                  : lines[lines.length - 1],
                activitySegmentId: last.activitySegmentId ?? segmentId,
                ...(identity.taskId ? { taskId: identity.taskId } : {}),
                ...(toolEvents ? { toolEvents } : {}),
              };
              const next = prev.slice();
              next[next.length - 1] = merged;
              return next;
            }
            return [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: "tool",
                kind: "trace",
                content: lines[lines.length - 1],
                traces: boundedTraceLines(lines),
                ...(boundedToolEvents(undefined, ev.tool_events)
                  ? { toolEvents: boundedToolEvents(undefined, ev.tool_events) }
                  : {}),
                ...(identity.taskId ? { taskId: identity.taskId } : {}),
                activitySegmentId: segmentId,
                createdAt: Date.now(),
                ...(ev.author_id
                  ? { authorId: ev.author_id, authorType: "agent" as const }
                  : {}),
              },
            ];
          });
          return;
        }

        const media = ev.media_urls?.length
          ? ev.media_urls.map((m) => toMediaAttachment(m))
          : ev.media?.map((url) => toMediaAttachment({ url }));
        const hasMedia = !!media && media.length > 0;
        setIsAwaitingModelResponse(false);

        // A complete (non-streamed) assistant message. If a stream was in
        // flight, drop the placeholder so we don't render the text twice.
        // Do NOT reset isStreaming here — only ``turn_end`` signals that
        // the full turn (all tool calls + final text) is complete.
        // A job/workflow result is its own stream. It may arrive while Mona
        // (or another agent) is still streaming, so it must not clear that
        // stream's cursor. A plain message remains the legacy Mona turn.
        const active = activeAssistantRef.current;
        const mappedStreamMessageId = identity.streamKey
          ? streamMessageIdsRef.current.get(identity.streamKey)
          : undefined;
        const sameActiveStream = Boolean(
          active
          && (
            mappedStreamMessageId === active.id
            || (identity.jobId && active.jobId === identity.jobId)
            || (
              !identity.jobId
              && !identity.workflowRunId
              && identity.authorId
              && active.authorId
              && identity.authorId === active.authorId
            )
          ),
        );
        const isIndependentAgentMessage = Boolean(
          (identity.jobId || identity.workflowRunId) && !sameActiveStream
          || (
            identity.authorId
            && active?.authorId
            && identity.authorId !== active.authorId
          ),
        );
        if (!isIndependentAgentMessage) {
          clearActivitySegment();
        }
        const pendingDelivery = pendingDeliveryOnce(pendingDeliveredFilesRef, pendingDeliveredMediaRef);
        setMessages((prev) => {
          const identityKey = identity.messageId
            ? `message:${identity.messageId}`
            : identity.jobId
              ? `job:${identity.jobId}`
              : undefined;
          const existingIdentityId = identityKey
            ? messageIdentityIdsRef.current.get(identityKey)
            : undefined;
          const existingIdentityIndex = findMessageIndexById(prev, existingIdentityId);
          const activeId = isIndependentAgentMessage
            ? undefined
            : mappedStreamMessageId
              ?? buffer.current?.messageId;
          if (!isIndependentAgentMessage) {
            buffer.current = null;
            activeAssistantRef.current = null;
          }
          const content = ev.text;
          const lat =
            typeof ev.latency_ms === "number" && ev.latency_ms >= 0
              ? Math.round(ev.latency_ms)
              : undefined;
          const tokenUsage = normalizedTokenUsage(ev.token_usage);
          const completeMessage: Omit<UIMessage, "id" | "role" | "createdAt"> = {
            content,
            ...(ev.final_response === true ? { isFinalResponse: true } : {}),
            ...(hasMedia ? { media } : {}),
            ...(lat !== undefined ? { latencyMs: lat } : {}),
            ...(tokenUsage ? { tokenUsage } : {}),
            ...(ev.task_id ? { taskId: ev.task_id } : {}),
            ...(identity.authorId
              ? { authorId: identity.authorId, authorType: "agent" as const }
              : {}),
            ...(ev.message_type && ev.message_type !== "message"
              ? { messageType: ev.message_type }
              : {}),
            ...(identity.jobId ? { jobId: identity.jobId } : {}),
            ...(identity.workflowRunId ? { workflowRunId: identity.workflowRunId } : {}),
            ...(Array.isArray(ev.tool_events) && ev.tool_events.length > 0
              ? { toolEvents: boundedToolEvents(undefined, ev.tool_events) }
              : {}),
            ...(ev.task_plan ? { taskPlan: ev.task_plan } : {}),
            isStreaming: false,
            reasoningStreaming: false,
          };

          // Replay/duplicate complete frames update the original bubble.
          if (existingIdentityIndex !== null) {
            const existing = prev[existingIdentityIndex];
            forgetStreamMessage(existing.id);
            const next = replaceMessageAt(prev, existingIdentityIndex, {
              ...existing,
              ...completeMessage,
            });
            return next;
          }

          let next: UIMessage[];
          if (isIndependentAgentMessage) {
            // Never use absorbCompleteAssistantMessage here: the last item
            // may be another agent's reasoning placeholder.
            const id = crypto.randomUUID();
            next = [
              ...prev,
              {
                id,
                role: "assistant",
                createdAt: Date.now(),
                ...completeMessage,
              },
            ];
            if (identityKey) messageIdentityIdsRef.current.set(identityKey, id);
          } else {
            const filtered = activeId ? prev.filter((m) => m.id !== activeId) : prev;
            if (activeId) forgetStreamMessage(activeId);
            next = absorbCompleteAssistantMessage(filtered, completeMessage);
            if (identityKey) {
              const inserted = next[next.length - 1];
              if (inserted?.role === "assistant") messageIdentityIdsRef.current.set(identityKey, inserted.id);
            }
          }
          const { files, media: pendingMedia } = pendingDelivery();
          if (files.length > 0) {
            next = appendDeliveredFilesToLastAssistant(next, files, pendingMedia);
          }
          return next;
        });
        if (hasMedia) {
          suppressStreamUntilTurnEndRef.current = true;
        }
        return;
      }
      if (ev.event === "file_edit") {
        const edits = Array.isArray(ev.edits) ? ev.edits : [];
        if (edits.length === 0) return;
        const normalized = mergeFileEdits(undefined, edits);
        if (normalized.length === 0) return;
        setIsAwaitingModelResponse(false);
        const opensFileEditPhase = normalized.some(
          (edit) => edit.status === "editing" || edit.phase === "start",
        );
        let eventSegmentId = fileEditSegmentRef.current;
        if (!eventSegmentId && opensFileEditPhase) {
          eventSegmentId = detachedActivitySegmentId();
          fileEditSegmentRef.current = eventSegmentId;
        }
        setMessages((prev) => {
          let segmentId = eventSegmentId;
          const targetIndex = findFileEditTraceIndex(prev, segmentId, normalized);
          if (targetIndex !== null) {
            const target = prev[targetIndex];
            segmentId = target.activitySegmentId ?? segmentId ?? detachedActivitySegmentId();
            if (opensFileEditPhase) fileEditSegmentRef.current = segmentId;
            const merged: UIMessage = {
              ...target,
              fileEdits: mergeFileEdits(target.fileEdits, normalized),
              activitySegmentId: segmentId,
            };
            return replaceMessageAt(prev, targetIndex, merged);
          }
          segmentId = segmentId ?? detachedActivitySegmentId();
          if (opensFileEditPhase) fileEditSegmentRef.current = segmentId;
          return [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: "tool",
              kind: "trace",
              content: "",
              traces: [],
              fileEdits: normalized,
              activitySegmentId: segmentId,
              createdAt: Date.now(),
            },
          ];
        });
        return;
      }
      if (ev.event === "deliver_files") {
        const files = Array.isArray(ev.files) ? ev.files : [];
        if (files.length === 0) return;
        setIsAwaitingModelResponse(false);
        const media = ev.media_urls?.map((item) => toMediaAttachment(item)) ?? [];
        if (ev.presentation === "question_preview") {
          const activitySegmentId = ensureActivitySegmentId();
          setMessages((previous) => [...previous, {
            id: crypto.randomUUID(), role: "tool", kind: "trace", content: "", traces: [],
            deliveredFiles: files, media, activitySegmentId, createdAt: Date.now(),
          }]);
          return;
        }
        setMessages((prev) => {
          let targetIdx: number | null = null;
          for (let i = prev.length - 1; i >= 0; i--) {
            const m = prev[i];
            if (m.role === "assistant" && m.kind !== "trace") {
              targetIdx = i;
              break;
            }
            if (m.role === "user") break;
          }
          if (targetIdx !== null && !prev[targetIdx].isStreaming) {
            const target = prev[targetIdx];
            return [
              ...prev.slice(0, targetIdx),
              {
                ...target,
                deliveredFiles: mergeDeliveredFiles(target.deliveredFiles, files),
                media: mergeMedia(target.media, media),
              },
              ...prev.slice(targetIdx + 1),
            ];
          }
          pendingDeliveredFilesRef.current = mergeDeliveredFiles(
            pendingDeliveredFilesRef.current,
            files,
          );
          pendingDeliveredMediaRef.current = mergeMedia(
            pendingDeliveredMediaRef.current,
            media,
          );
          return prev;
        });
        return;
      }
      // ``attached`` frames are handled by the client shell.
    };

    const unsub = client.onChat(chatId, handle);
    return () => {
      unsub();
      buffer.current = null;
      activeAssistantRef.current = null;
      streamMessageIdsRef.current.clear();
      messageIdentityIdsRef.current.clear();
      closedAssistantStreamIdsRef.current.clear();
      pendingDeliveredFilesRef.current = [];
      pendingDeliveredMediaRef.current = [];
      clearActivitySegment();
      clearPendingStreamWork();
      if (streamEndTimerRef.current !== null) {
        clearTimeout(streamEndTimerRef.current);
        streamEndTimerRef.current = null;
      }
    };
  }, [
    chatId,
    client,
    clearActivitySegment,
    clearPendingStreamWork,
    detachedActivitySegmentId,
    ensureActivitySegmentId,
    flushPendingStreamEvents,
    liveTokenSampler,
    onTurnEnd,
    resetLiveTokenRate,
    schedulePendingStreamFlush,
  ]);

  const send = useCallback(
    (content: string, images?: SendImage[], options?: SendOptions) => {
      if (!chatId || !client || client.isChatDeleted(chatId)) return;
      const hasImages = !!images && images.length > 0;
      const hasDocuments = !!options?.docPaths?.length;
      // Text is optional when images are attached — the agent will still see
      // the image blocks via ``media`` paths.
      if (!hasImages && !hasDocuments && !content.trim()) return;
      if (options?.inputId) {
        const known = client.getMessageAdmission?.(chatId, options.inputId);
        if (known && known !== "rejected" && !(known === "paused" && options.resumeInput)) {
          options.onAdmission?.(known === "consumed" ? "accepted" : known);
          if (known === "consumed" && options.awaitConsumption) options.onAdmission?.("consumed");
          return;
        }
      }

      let taskId = options?.taskId;
      const previousTaskId = currentTaskIdRef.current;
      let startsNewTask = false;
      if (!taskId && goalState?.active) {
        taskId = currentTaskIdRef.current ?? undefined;
      }
      if (!taskId) {
        taskId = `task_${crypto.randomUUID()}`;
        startsNewTask = true;
      } else if (!goalState?.active && taskId !== currentTaskIdRef.current) {
        startsNewTask = true;
      }
      if (startsNewTask) {
        currentTaskIdRef.current = taskId;
        setCurrentTaskId(taskId);
        setTaskPlan(undefined);
      }
      const messageId = options?.inputId ?? crypto.randomUUID();
      pendingMessageRef.current = {
        taskId,
        messageId,
        previousTaskId,
        previousTaskPlan: client.getTaskPlan?.(chatId),
        awaitingAdmission: true,
      };
      setMessageRejection(null);
      setWorkRequests(null);
      resetLiveTokenRate();

      flushPendingStreamEvents();
      const previews = hasImages ? images!.map((i) => i.preview) : undefined;
      const documentMedia: UIMediaAttachment[] | undefined = options?.documentNames?.length
        ? options.documentNames.map((name) => ({ kind: "file", name }))
        : undefined;
      setMessages((prev) => {
        buffer.current = null;
        activeAssistantRef.current = null;
        streamMessageIdsRef.current.clear();
        messageIdentityIdsRef.current.clear();
        closedAssistantStreamIdsRef.current.clear();
        pendingDeliveredFilesRef.current = [];
        pendingDeliveredMediaRef.current = [];
        clearActivitySegment();
        return [
          ...pruneReasoningOnlyPlaceholders(prev.filter((message) => message.id !== messageId)),
          {
            id: messageId,
            role: "user",
            content,
            taskId,
            sendState: "pending",
            createdAt: Date.now(),
            ...(options?.displayContent ? { displayContent: options.displayContent } : {}),
            ...(options?.quote ? { quote: options.quote } : {}),
            ...(previews ? { images: previews } : {}),
            ...(documentMedia ? { media: documentMedia } : {}),
          },
        ];
      });
      // Mark streaming immediately so the UI shows the loading indicator
      // right away, before the first delta arrives from the server.
      setRunStartedAt(Date.now() / 1000);
      setIsAwaitingModelResponse(true);
      setIsCompacting(false);
      setIsStreaming(true);
      const wireMedia = hasImages ? images!.map((i) => i.media) : undefined;
      let acceptedReported = false;
      let unknownReported = false;
      const onAdmission = (state: MessageAdmission, reason?: MessageAdmissionReason) => {
        if (client.isChatDeleted(chatId)) return;
        if (state === "accepted" || state === "consumed") {
          if (!acceptedReported) options?.onAdmission?.("accepted");
          acceptedReported = true;
          if (state === "consumed" && options?.awaitConsumption) options.onAdmission?.("consumed");
        } else if ((!acceptedReported || options?.awaitConsumption) && (state !== "unknown" || !unknownReported)) {
          options?.onAdmission?.(state);
        }
        unknownReported = state === "unknown";
        if (!mountedRef.current || activeChatRef.current !== chatId) return;
        const pending = pendingMessageRef.current;
        if (!pending || pending.messageId !== messageId) return;
        if (state === "accepted" || state === "consumed") {
          if (state === "consumed") pendingMessageRef.current = null;
          setMessages((previous) => previous.map((message) => message.id === messageId ? { ...message, sendState: undefined } : message));
          setMessageRejection((current) => current?.inputId === messageId ? null : current);
          return;
        }
        if (state === "unknown") {
          setMessageRejection({ runActive: client.getRunStartedAt(chatId) !== null, uncertain: true, inputId: messageId,
            ...(reason === "billing_unknown" ? { reason } : {}) });
          return;
        }
        pendingMessageRef.current = null;
        setMessages((previous) => previous.map((message) => message.id === messageId ? { ...message, sendState: "rejected" } : message));
        const started = client.getRunStartedAt(chatId);
        setIsStreaming(started !== null);
        setRunStartedAt(started);
        setIsAwaitingModelResponse(false);
        if (currentTaskIdRef.current === pending.taskId) {
          currentTaskIdRef.current = client.getArtifactTaskId?.(chatId) ?? pending.previousTaskId;
          setCurrentTaskId(currentTaskIdRef.current);
          setTaskPlan(client.getTaskPlan?.(chatId) ?? pending.previousTaskPlan);
        }
        if (state !== "cancelled" && state !== "paused") setMessageRejection({ runActive: started !== null, inputId: messageId,
          ...(state === "rejected" && isMessageAdmissionRejectionReason(reason) ? { reason } : {}) });
      };
      if (options) {
        client.sendMessage(chatId, content, wireMedia, {
          inputId: messageId,
          onAdmission,
          resumeInput: options.resumeInput,
          // IMPORTANT: displayContent is persisted to the server so that
          // history replay also shows the short label. DO NOT remove.
          displayContent: options.displayContent,
          quote: options.quote,
          terminalSessionId: options.terminalSessionId,
          terminalExecMode: options.terminalExecMode,
          dbConnectionId: options.dbConnectionId,
          dbDatabase: options.dbDatabase,
          dbTable: options.dbTable,
          dbType: options.dbType,
          dbServerVersion: options.dbServerVersion,
          dbCurrentSql: options.dbCurrentSql,
          dbLastError: options.dbLastError,
          browserTabId: options.browserTabId,
          browserSidebar: options.browserSidebar,
          browserPageUrl: options.browserPageUrl,
          browserPageTitle: options.browserPageTitle,
          officeSessionId: options.officeSessionId,
          officeDocumentType: options.officeDocumentType,
          officeDisplayName: options.officeDisplayName,
          canvasId: options.canvasId,
          canvasPath: options.canvasPath,
          agentKind: options.agentKind,
          modelBinding: options.modelBinding,
          docPaths: options.docPaths,
          targetAgentIds: options.targetAgentIds,
          discussion: options.discussion,
          taskId,
          origin: options.origin,
          profileAdviceId: options.profileAdviceId,
        });
      } else {
        client.sendMessage(chatId, content, wireMedia, { taskId, inputId: messageId, onAdmission });
      }
    },
    [chatId, clearActivitySegment, client, flushPendingStreamEvents, goalState?.active, resetLiveTokenRate],
  );

  const inject = useCallback(
    (content: string, images?: SendImage[], options?: SendOptions) => {
      if (!chatId || !client || client.isChatDeleted(chatId)) return;
      const hasImages = !!images && images.length > 0;
      if (!hasImages && !options?.docPaths?.length && !content.trim()) return;
      const targetTurnId = client.getWorkTurn?.(chatId)?.turnId;
      if (!targetTurnId) {
        if (!isStreaming) {
          send(content, images, { ...options, awaitConsumption: true });
        } else {
          options?.onAdmission?.("rejected");
          setMessageRejection({ runActive: client.getRunStartedAt(chatId) !== null });
        }
        return;
      }

      let taskId = currentTaskIdRef.current;
      if (!taskId) {
        taskId = `task_${crypto.randomUUID()}`;
        currentTaskIdRef.current = taskId;
        setCurrentTaskId(taskId);
      }

      const previews = hasImages ? images!.map((i) => i.preview) : undefined;
      const inputId = options?.inputId ?? crypto.randomUUID();
      setMessages((prev) => [
        ...prev.filter((message) => message.id !== inputId),
        {
          id: inputId,
          role: "user" as const,
          content,
          taskId,
          createdAt: Date.now(),
          sendState: "pending",
          isInjected: false,
          ...(options?.displayContent ? { displayContent: options.displayContent } : {}),
          ...(previews ? { images: previews } : {}),
          ...(options?.documentNames?.length ? {
            media: options.documentNames.map((name): UIMediaAttachment => ({ kind: "file", name })),
          } : {}),
        },
      ]);
      const wireMedia = hasImages ? images!.map((i) => i.media) : undefined;
      let lastAdmission: MessageAdmission | undefined;
      client.sendMessage(chatId, content, wireMedia, {
        ...options, taskId, inputId, targetTurnId,
        onAdmission: (state, reason) => {
          if (client.isChatDeleted(chatId)) return;
          if (state !== lastAdmission) options?.onAdmission?.(state);
          lastAdmission = state;
          if (!mountedRef.current || activeChatRef.current !== chatId) return;
          setMessages((previous) => previous.map((message) => message.id === inputId ? {
            ...message, sendState: state === "consumed" ? undefined
              : state === "rejected" || state === "paused" || state === "cancelled" ? "rejected" : "pending",
            isInjected: state === "consumed",
          } : message));
          if (state === "unknown" || state === "rejected") setMessageRejection({ runActive: client.getRunStartedAt(chatId) !== null, uncertain: state === "unknown", inputId,
            ...((state === "rejected" && isMessageAdmissionRejectionReason(reason))
              || (state === "unknown" && reason === "billing_unknown") ? { reason } : {}) });
          else setMessageRejection((current) => current?.inputId === inputId ? null : current);
        },
      });
    },
    [chatId, client, isStreaming, send],
  );

  const stop = useCallback(() => {
    if (!chatId || !client || client.isChatDeleted(chatId) || stoppingRef.current || !isStreaming) return;
    const pending = pendingMessageRef.current;
    if (pending?.awaitingAdmission && client.cancelUnsentInput?.(chatId, pending.messageId)) return;
    const turn = client.getWorkTurn?.(chatId);
    const request = { turnId: pending?.awaitingAdmission && turn?.inputId !== pending.messageId ? undefined : turn?.turnId,
      inputId: pending?.awaitingAdmission ? pending.messageId : turn?.inputId };
    stopRequestRef.current = request;
    unresolvedStopRef.current = request;
    stoppingRef.current = true;
    setStopping(true);
    setMessageRejection(null);
    flushPendingStreamEvents();
    setMessages((prev) => {
      buffer.current = null;
      activeAssistantRef.current = null;
      streamMessageIdsRef.current.clear();
      messageIdentityIdsRef.current.clear();
      closedAssistantStreamIdsRef.current.clear();
      pendingDeliveredFilesRef.current = [];
      pendingDeliveredMediaRef.current = [];
      clearActivitySegment();
      return finishPendingWidgets(prev).map((m) => (m.isStreaming ? { ...m, isStreaming: false } : m));
    });
    suppressStreamUntilTurnEndRef.current = true;
    void (async () => {
      let outcome;
      try {
        if (!request.turnId && pending?.awaitingAdmission && request.inputId) {
          const wait = waitForStopTarget(client, chatId, request.inputId, pending.taskId);
          stopTargetWaitRef.current = wait.cancel;
          const target = await wait.promise;
          if (stopTargetWaitRef.current === wait.cancel) stopTargetWaitRef.current = null;
          if (!mountedRef.current || activeChatRef.current !== chatId || stopRequestRef.current !== request) return;
          if (target.state === "finished" || target.state === "cancelled") {
            stopRequestRef.current = null;
            unresolvedStopRef.current = null;
            stoppingRef.current = false;
            setStopping(false);
            suppressStreamUntilTurnEndRef.current = false;
            return;
          }
          if (target.state === "unknown") throw new Error("stop target unconfirmed");
          const current = client.getWorkTurn(chatId);
          if (client.status !== "open" || !current || current.turnId !== target.turnId || current.inputId !== request.inputId) {
            throw new Error("stop target changed");
          }
          request.turnId = target.turnId;
        }
        outcome = await client.stopWorkTurn?.(chatId, request.turnId) ?? "unsupported";
      } catch {
        outcome = "unknown";
      }
      if (!mountedRef.current || activeChatRef.current !== chatId || stopRequestRef.current !== request) return;
      if (outcome === "pending") return;
      stopRequestRef.current = null;
      stoppingRef.current = false;
      setStopping(false);
      suppressStreamUntilTurnEndRef.current = false;
      const current = client.getWorkTurn?.(chatId);
      if (current && request.turnId && current.turnId !== request.turnId) {
        if (unresolvedStopRef.current === request) unresolvedStopRef.current = null;
        return;
      }
      if (outcome === "stopped" || outcome === "already_finished") {
        unresolvedStopRef.current = null;
        const started = client.getRunStartedAt(chatId);
        setIsStreaming(started !== null);
        setRunStartedAt(started);
        setIsAwaitingModelResponse(false);
        if (started === null) setIsCompacting(false);
        onTurnEnd?.();
      } else {
        if (!request.turnId && !request.inputId) unresolvedStopRef.current = null;
        if (!hostedRef.current) {
          setMessageRejection({ runActive: client.getRunStartedAt(chatId) !== null,
            stopOutcome: outcome === "unsupported" ? "unsupported" : "unknown",
            ...(request.turnId ? { stopTurnId: request.turnId } : {}) });
        }
      }
    })();
  }, [chatId, clearActivitySegment, client, flushPendingStreamEvents, isStreaming, onTurnEnd]);

  return {
    messages,
    liveTokenUsage,
    runMetrics,
    liveTokenRate: isStreaming ? liveTokenRate : undefined,
    isStreaming,
    isAwaitingModelResponse,
    isCompacting,
    stopping,
    runStartedAt,
    goalState,
    taskPlan,
    currentTaskId,
    send,
    inject,
    stop,
    setMessages,
    streamError,
    dismissStreamError,
    messageRejection,
    dismissMessageRejection,
  };
}
