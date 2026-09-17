import type {
  AgentInstruction,
  AgentSkillSetupJob,
  AgentSummary,
  AgentUserConfigPayload,
  AgentJobSummary,
  ApprovalRequestedPayload,
  ConnectionStatus,
  DiscussionLaunchOptions,
  InboundEvent,
  Outbound,
  OutboundMedia,
  GoalStateWsPayload,
  TaskPlanWsPayload,
  RoomCommandResult,
  RoomState,
  RoomUpdate,
  WorkflowCommandResult,
  WorkflowDefinition,
  WorkflowRun,
  WorkflowStep,
  WorkflowStepActivityPayload,
  WorkflowTrigger,
  WorkflowUpdatedPayload,
  MessageQuote,
} from "./types";

/** WebSocket readyState constants, referenced by value to stay portable
 * across runtimes that don't expose a global ``WebSocket`` (tests, SSR). */
const WS_OPEN = 1;
const WS_CLOSING = 2;

/** Inbound WebSocket ``console.log`` / parse-failure ``console.warn``.
 *
 * Disabled by default because token-level streams can produce thousands of
 * frames and retained console objects can stall WebView2. Enable explicitly
 * with ``localStorage.setItem('mona_debug_ws','1')`` when diagnosing transport.
 * Values are read on every frame; no reload needed.
 */
function wsInboundDebugEnabled(): boolean {
  if (typeof globalThis === "undefined") return false;
  try {
    if (import.meta.env.MODE === "test") return false;
    const ls = (globalThis as unknown as { localStorage?: Storage }).localStorage;
    const raw = ls?.getItem("mona_debug_ws")?.trim().toLowerCase() ?? "";
    if (raw === "0" || raw === "false" || raw === "off" || raw === "no") {
      return false;
    }
    if (raw === "1" || raw === "true" || raw === "on" || raw === "yes") {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** Shorten streaming text fields so logging stays usable for huge deltas. */
function summarizeInboundWsPayload(ev: InboundEvent): unknown {
  const kind = (ev as { event?: string }).event;
  if (kind !== "delta" && kind !== "reasoning_delta") return ev;
  const row = { ...(ev as object) } as Record<string, unknown>;
  const text = typeof row.text === "string" ? row.text : "";
  const max = 240;
  if (text.length > max) {
    row.text = `${text.slice(0, max)}… (${text.length} chars)`;
  }
  return row;
}

type Unsubscribe = () => void;
type EventHandler = (ev: InboundEvent) => void;
type StatusHandler = (status: ConnectionStatus) => void;
type RuntimeModelHandler = (modelName: string | null, modelPreset?: string | null) => void;
type SessionUpdateScope = "metadata" | "thread" | string;
type SessionUpdateHandler = (chatId: string, scope?: SessionUpdateScope) => void;
type RunStatusHandler = (chatId: string, startedAt: number | null) => void;
type RoomUpdatedHandler = (chatId: string, state: RoomState) => void;
type AgentJobUpdatedHandler = (chatId: string, job: AgentJobSummary) => void;
type WorkflowUpdatedHandler = (chatId: string, payload: WorkflowUpdatedPayload) => void;
/** ``run`` is null on run-conflict/run-failed error frames (``error`` carries
 *  the code, ``detail`` the human-readable cause). */
type WorkflowRunUpdatedHandler = (chatId: string, run: WorkflowRun | null, error?: string, detail?: string) => void;
/** Live tool-activity snapshot of one workflow step job (full accumulator,
 *  not a delta — replace any previously seen list for the same step). */
type WorkflowStepActivityHandler = (chatId: string, payload: WorkflowStepActivityPayload) => void;
type ApprovalRequestedHandler = (payload: ApprovalRequestedPayload) => void;
type AgentsUpdatedHandler = (agentId: string, event: "agents_updated" | "agent_instructions_updated" | "agent_skills_updated") => void;
/** Room-scoped command results share one pending map; workflow commands add
 *  their optional payload fields via this intersection. */
type AnyRoomCommandResult = RoomCommandResult & WorkflowCommandResult;

/** Structured connection-level errors surfaced to the UI.
 *
 * These are *not* InboundEvent errors from the server application layer —
 * those arrive as ``{event: "error"}`` messages via ``onChat``. These are
 * transport-level or protocol-level faults the UI should make visible so
 * the user understands *why* their action failed (as opposed to silently
 * reconnecting under the hood).
 */
export type StreamError =
  /** Server rejected the inbound frame as too large (WS close code 1009).
   * Typically means the user attached images whose base64 size exceeded
   * ``maxMessageBytes`` on the server. */
  | { kind: "message_too_big" };

type ErrorHandler = (error: StreamError) => void;

/** Rejection for failed room commands; ``code`` carries the wire-safe
 *  server error code (e.g. ``approval_expired``) when the failure came from
 *  a ``*_result`` frame. */
export class RoomCommandError extends Error {
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "RoomCommandError";
    this.code = code;
  }
}

interface PendingNewChat {
  requestId: string;
  resolve: (chatId: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingRoomCommand {
  resolve: (result: AnyRoomCommandResult) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface MonaClientOptions {
  url: string;
  reconnect?: boolean;
  /** Called when a connection drops so the app can refresh its token. */
  onReauth?: () => Promise<string | null>;
  /** Inject a custom WebSocket factory (used by unit tests). */
  socketFactory?: (url: string) => WebSocket;
  /** Delay-cap for reconnect backoff (ms). */
  maxBackoffMs?: number;
}

/**
 * Singleton WebSocket client that multiplexes chat streams.
 *
 * One socket carries many chat_ids: the server tags every outbound event with
 * ``chat_id``, and this class fans those events out to handlers registered
 * per chat. Reconnects are transparent and re-attach every known chat_id.
 */
export class MonaClient {
  private socket: WebSocket | null = null;
  private statusHandlers = new Set<StatusHandler>();
  private runtimeModelHandlers = new Set<RuntimeModelHandler>();
  private sessionUpdateHandlers = new Set<SessionUpdateHandler>();
  private artifactsChangedHandlers = new Set<(chatId?: string) => void>();
  private videoProjectChangedHandlers = new Set<(payload: { projectName: string; hint: string }) => void>();
  private runStatusHandlers = new Set<RunStatusHandler>();
  private roomUpdatedHandlers = new Set<RoomUpdatedHandler>();
  private agentJobUpdatedHandlers = new Set<AgentJobUpdatedHandler>();
  private workflowUpdatedHandlers = new Set<WorkflowUpdatedHandler>();
  private workflowRunUpdatedHandlers = new Set<WorkflowRunUpdatedHandler>();
  private workflowStepActivityHandlers = new Set<WorkflowStepActivityHandler>();
  private approvalRequestedHandlers = new Set<ApprovalRequestedHandler>();
  private agentsUpdatedHandlers = new Set<AgentsUpdatedHandler>();
  private errorHandlers = new Set<ErrorHandler>();
  private docUploadHandlers = new Set<(result: {
    ok: boolean;
    files?: { name: string; path: string; size?: number; mime?: string }[];
    chatId?: string;
    error?: string;
  }) => void>();
  // chat_id -> handlers listening on it
  private chatHandlers = new Map<string, Set<EventHandler>>();
  /** Inbound frames received while no subscriber is registered (e.g. user switched away). */
  private pendingInboundByChat = new Map<string, InboundEvent[]>();
  private pendingChatReplayScheduled = new Set<string>();
  private static readonly PENDING_INBOUND_MAX = 2000;
  // chat_ids we've attached to since connect; re-attached after reconnects
  private knownChats = new Set<string>();
  /** Wall-clock run strip: updated from ``goal_status`` even with no ``onChat`` subscriber. */
  private runStartedAtByChatId = new Map<string, number>();
  /** Latest ``goal_state`` snapshot per ``chat_id`` (multi-session isolation). */
  private goalStateByChatId = new Map<string, GoalStateWsPayload>();
  private taskPlanByChatId = new Map<string, TaskPlanWsPayload>();
  private artifactTaskIdByChatId = new Map<string, string>();
  private pendingNewChat: PendingNewChat | null = null;
  private newChatRequestSeq = 0;
  private pendingRoomCommands = new Map<string, PendingRoomCommand>();
  private roomCommandSeq = 0;
  // Frames queued while the socket is not yet OPEN
  private sendQueue: Outbound[] = [];
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly shouldReconnect: boolean;
  private readonly maxBackoffMs: number;
  private readonly socketFactory: (url: string) => WebSocket;
  private currentUrl: string;
  private status_: ConnectionStatus = "idle";
  private readyChatId: string | null = null;
  // Set by ``close()`` so the onclose handler knows the drop was intentional
  // and must not schedule a reconnect or flip status back to "reconnecting".
  private intentionallyClosed = false;

  constructor(private options: MonaClientOptions) {
    this.shouldReconnect = options.reconnect ?? true;
    this.maxBackoffMs = options.maxBackoffMs ?? 15_000;
    this.socketFactory =
      options.socketFactory ?? ((url) => new WebSocket(url));
    this.currentUrl = options.url;
  }

  get status(): ConnectionStatus {
    return this.status_;
  }

  get defaultChatId(): string | null {
    return this.readyChatId;
  }

  /** Swap the URL (e.g. after fetching a fresh token) then reconnect. */
  updateUrl(url: string): void {
    this.currentUrl = url;
  }

  onStatus(handler: StatusHandler): Unsubscribe {
    this.statusHandlers.add(handler);
    handler(this.status_);
    return () => {
      this.statusHandlers.delete(handler);
    };
  }

  onRuntimeModelUpdate(handler: RuntimeModelHandler): Unsubscribe {
    this.runtimeModelHandlers.add(handler);
    return () => {
      this.runtimeModelHandlers.delete(handler);
    };
  }

  onSessionUpdate(handler: SessionUpdateHandler): Unsubscribe {
    this.sessionUpdateHandlers.add(handler);
    return () => {
      this.sessionUpdateHandlers.delete(handler);
    };
  }

  /** Subscribe to artifact change hints. ``chatId`` is present for an
   *  explicit delivery event and absent for a global filesystem watcher. */
  onArtifactsChanged(handler: (chatId?: string) => void): Unsubscribe {
    this.artifactsChangedHandlers.add(handler);
    return () => {
      this.artifactsChangedHandlers.delete(handler);
    };
  }

  /** Subscribe to server-pushed ``video_project_changed`` broadcasts: a video
   *  project's state changed, listeners should refresh per ``hint`` granularity. */
  onVideoProjectChanged(handler: (payload: { projectName: string; hint: string }) => void): Unsubscribe {
    this.videoProjectChangedHandlers.add(handler);
    return () => {
      this.videoProjectChangedHandlers.delete(handler);
    };
  }

  onRunStatus(handler: RunStatusHandler): Unsubscribe {
    this.runStatusHandlers.add(handler);
    for (const [chatId, startedAt] of this.runStartedAtByChatId) {
      handler(chatId, startedAt);
    }
    return () => {
      this.runStatusHandlers.delete(handler);
    };
  }

  /** Subscribe to transport-level faults (see :type:`StreamError`). */
  onError(handler: ErrorHandler): Unsubscribe {
    this.errorHandlers.add(handler);
    return () => {
      this.errorHandlers.delete(handler);
    };
  }

  /**
   * Upload documents for the "文档加工" workbench. Files are written to
   * ``workspace/uploads/<chat_id>/`` on the server. The returned relative
   * paths should be passed back via ``sendMessage``'s ``doc_paths`` field so
   * the backend can extract their text into the user message.
   */
  sendDocUpload(
    chatId: string,
    files: Array<{ name: string; data_url: string } | { name: string; local_path: string }>,
  ): void {
    this.queueSend({ type: "doc_upload", chat_id: chatId, files });
  }

  onDocUploadResult(
    handler: (result: {
      ok: boolean;
      files?: { name: string; path: string; size?: number; mime?: string }[];
      chatId?: string;
      error?: string;
    }) => void,
  ): Unsubscribe {
    this.docUploadHandlers.add(handler);
    return () => {
      this.docUploadHandlers.delete(handler);
    };
  }

  /** Last ``goal_status`` ``started_at`` (unix sec) for *chatId*, if the turn is running. */
  getRunStartedAt(chatId: string): number | null {
    const v = this.runStartedAtByChatId.get(chatId);
    return v === undefined ? null : v;
  }

  /** Last ``goal_state`` payload for *chatId*, if any frame has arrived this connection. */
  getGoalState(chatId: string): GoalStateWsPayload | undefined {
    return this.goalStateByChatId.get(chatId);
  }

  getTaskPlan(chatId: string): TaskPlanWsPayload | undefined {
    return this.taskPlanByChatId.get(chatId);
  }

  private recordGoalStatusForRunStrip(chatId: string, ev: InboundEvent): void {
    if (ev.event !== "goal_status") return;
    if (ev.status === "running" && typeof ev.started_at === "number") {
      const previous = this.runStartedAtByChatId.get(chatId);
      this.runStartedAtByChatId.set(chatId, ev.started_at);
      if (previous !== ev.started_at) this.emitRunStatus(chatId, ev.started_at);
    } else if (this.runStartedAtByChatId.has(chatId)) {
      this.runStartedAtByChatId.delete(chatId);
      this.emitRunStatus(chatId, null);
    }
  }

  private recordGoalStateSnapshot(chatId: string, ev: InboundEvent): void {
    if (ev.event === "goal_state") {
      this.goalStateByChatId.set(chatId, ev.goal_state);
      return;
    }
    if (ev.event === "turn_end" && ev.goal_state != null && typeof ev.goal_state === "object") {
      this.goalStateByChatId.set(chatId, ev.goal_state);
    }
  }

  /** Subscribe to events for a given chat_id. Auto-attaches on the next open. */
  onChat(chatId: string, handler: EventHandler): Unsubscribe {
    let handlers = this.chatHandlers.get(chatId);
    if (!handlers) {
      handlers = new Set();
      this.chatHandlers.set(chatId, handlers);
    }
    handlers.add(handler);
    const pending = this.pendingInboundByChat.get(chatId);
    if (
      pending !== undefined
      && pending.length > 0
      && !this.pendingChatReplayScheduled.has(chatId)
    ) {
      this.pendingChatReplayScheduled.add(chatId);
      queueMicrotask(() => {
        this.pendingChatReplayScheduled.delete(chatId);
        const flushed = this.pendingInboundByChat.get(chatId)?.splice(0) ?? [];
        this.pendingInboundByChat.delete(chatId);
        const current = this.chatHandlers.get(chatId);
        if (!current) return;
        for (const ev of flushed) {
          for (const subscriber of current) subscriber(ev);
        }
      });
    }
    this.attach(chatId);
    return () => {
      const current = this.chatHandlers.get(chatId);
      if (!current) return;
      current.delete(handler);
      if (current.size === 0) this.chatHandlers.delete(chatId);
    };
  }

  /** Subscribe to server-pushed ``room_updated`` broadcasts (room metadata
   *  changed on another client or as a side effect of a room command). */
  onRoomUpdated(handler: RoomUpdatedHandler): Unsubscribe {
    this.roomUpdatedHandlers.add(handler);
    return () => {
      this.roomUpdatedHandlers.delete(handler);
    };
  }

  /** Subscribe to room job state changes (``agent_job_updated``). */
  onAgentJobUpdated(handler: AgentJobUpdatedHandler): Unsubscribe {
    this.agentJobUpdatedHandlers.add(handler);
    return () => {
      this.agentJobUpdatedHandlers.delete(handler);
    };
  }

  /** Subscribe to workflow draft/activation broadcasts (``workflow_updated``). */
  onWorkflowUpdated(handler: WorkflowUpdatedHandler): Unsubscribe {
    this.workflowUpdatedHandlers.add(handler);
    return () => {
      this.workflowUpdatedHandlers.delete(handler);
    };
  }

  /** Subscribe to workflow run state broadcasts (``workflow_run_updated``). */
  onWorkflowRunUpdated(handler: WorkflowRunUpdatedHandler): Unsubscribe {
    this.workflowRunUpdatedHandlers.add(handler);
    return () => {
      this.workflowRunUpdatedHandlers.delete(handler);
    };
  }

  /** Subscribe to live step tool-activity streams (``workflow_step_activity``). */
  onWorkflowStepActivity(handler: WorkflowStepActivityHandler): Unsubscribe {
    this.workflowStepActivityHandlers.add(handler);
    return () => {
      this.workflowStepActivityHandlers.delete(handler);
    };
  }

  /** Subscribe to approval request broadcasts (``approval_requested``). */
  onApprovalRequested(handler: ApprovalRequestedHandler): Unsubscribe {
    this.approvalRequestedHandlers.add(handler);
    return () => {
      this.approvalRequestedHandlers.delete(handler);
    };
  }

  /** Subscribe to Agent management updates so cached agent data can refresh. */
  onAgentsUpdated(handler: AgentsUpdatedHandler): Unsubscribe {
    this.agentsUpdatedHandlers.add(handler);
    return () => {
      this.agentsUpdatedHandlers.delete(handler);
    };
  }

  /** Turn an existing chat into a collaboration room (phase 2d). */
  createRoom(
    chatId: string,
    agentIds: string[],
    title: string,
    goal?: string,
  ): Promise<RoomState> {
    return this.sendRoomCommand("create_room_result", (requestId) => ({
      type: "create_room",
      chat_id: chatId,
      agent_ids: agentIds,
      title,
      ...(goal ? { goal } : {}),
      request_id: requestId,
    }));
  }

  /** Mark an existing chat as a direct conversation with a named agent
   *  (shell phase). The chat is created first via ``newChat``; this stamps
   *  the conversation metadata so the backend resolves the agent identity. */
  createDirectConversation(chatId: string, agentId: string): Promise<void> {
    return this.sendRoomCommandRaw("create_direct_conversation_result", (requestId) => ({
      type: "create_direct_conversation",
      chat_id: chatId,
      agent_id: agentId,
      request_id: requestId,
    })).then(() => undefined);
  }

  updateAgentConfig(
    agentId: string,
    config: Record<string, unknown>,
    expectedRevision?: number,
  ): Promise<AgentUserConfigPayload> {
    return this.sendAgentCommandRaw("agent_config_update_result", (requestId) => ({
      type: "agent_config_update",
      agent_id: agentId,
      config,
      ...(expectedRevision !== undefined ? { expected_revision: expectedRevision } : {}),
      request_id: requestId,
    })).then((result) => {
      const configResult = (result as { config?: AgentUserConfigPayload }).config;
      if (!configResult) throw new Error("malformed agent_config_update_result");
      return configResult;
    });
  }

  saveAgentInstruction(
    agentId: string,
    key: AgentInstruction["key"],
    content: string,
  ): Promise<AgentInstruction> {
    return this.sendAgentCommandRaw("agent_instruction_save_result", (requestId) => ({
      type: "agent_instruction_save",
      agent_id: agentId,
      key,
      content,
      request_id: requestId,
    })).then((result) => {
      const instruction = (result as { instruction?: AgentInstruction }).instruction;
      if (!instruction) throw new Error("malformed agent_instruction_save_result");
      return instruction;
    });
  }

  restoreAgentInstruction(
    agentId: string,
    key: AgentInstruction["key"],
    commit: string,
  ): Promise<AgentInstruction> {
    return this.sendAgentCommandRaw("agent_instruction_restore_result", (requestId) => ({
      type: "agent_instruction_restore",
      agent_id: agentId,
      key,
      commit,
      request_id: requestId,
    })).then((result) => {
      const instruction = (result as { instruction?: AgentInstruction }).instruction;
      if (!instruction) throw new Error("malformed agent_instruction_restore_result");
      return instruction;
    });
  }

  actOnAgentSkill(
    agentId: string,
    name: string,
    action: "enable" | "disable" | "archive" | "restore" | "enable_scripts" | "disable_scripts" | "pin" | "unpin",
  ): Promise<void> {
    return this.sendAgentCommandRaw("agent_skill_action_result", (requestId) => ({
      type: "agent_skill_action",
      agent_id: agentId,
      name,
      action,
      request_id: requestId,
    })).then(() => undefined);
  }

  /** Edit room title / goal / membership. */
  updateRoom(chatId: string, updates: RoomUpdate): Promise<RoomState> {
    return this.sendRoomCommand("update_room_result", (requestId) => ({
      type: "update_room",
      chat_id: chatId,
      ...(updates.agentIds ? { agent_ids: updates.agentIds } : {}),
      ...(updates.title !== undefined ? { title: updates.title } : {}),
      ...(updates.goal !== undefined ? { goal: updates.goal } : {}),
      request_id: requestId,
    }));
  }

  /** Fetch the current room state for a chat. */
  getRoomState(chatId: string): Promise<RoomState> {
    return this.sendRoomCommand("room_state_result", (requestId) => ({
      type: "get_room_state",
      chat_id: chatId,
      request_id: requestId,
    }));
  }

  /** Cancel a queued/running room job. */
  cancelAgentJob(chatId: string, jobId: string, reason?: string): Promise<AgentJobSummary> {
    return this.sendRoomCommandRaw("cancel_agent_job_result", (requestId) => ({
      type: "cancel_agent_job",
      chat_id: chatId,
      job_id: jobId,
      ...(reason ? { reason } : {}),
      request_id: requestId,
    })).then((result) => {
      const job = (result as { job?: AgentJobSummary }).job;
      if (!job) {
        throw new Error("malformed cancel_agent_job result");
      }
      return job;
    });
  }

  // -- workflow commands (multi-agent phase 3) -----------------------------

  /** Fetch the room's workflow draft + active revision. */
  getWorkflow(chatId: string): Promise<{
    draft: WorkflowDefinition | null;
    active: WorkflowDefinition | null;
    activeRevision: number | null;
    revisions: number[];
  }> {
    return this.sendRoomCommandRaw("workflow_state_result", (requestId) => ({
      type: "get_workflow",
      chat_id: chatId,
      request_id: requestId,
    })).then((result) => ({
      draft: result.draft ?? null,
      active: result.active ?? null,
      activeRevision: result.activeRevision ?? null,
      revisions: result.revisions ?? [],
    }));
  }

  /** Save (or replace) the room's workflow draft. */
  saveWorkflowDraft(
    chatId: string,
    goal: string,
    steps: WorkflowStep[],
    trigger?: WorkflowTrigger,
  ): Promise<WorkflowDefinition> {
    return this.sendRoomCommandRaw("workflow_draft_ready", (requestId) => ({
      type: "save_workflow_draft",
      chat_id: chatId,
      goal,
      steps,
      ...(trigger ? { trigger } : {}),
      request_id: requestId,
    })).then((result) => {
      if (!result.workflow) {
        throw new Error("malformed workflow_draft_ready");
      }
      return result.workflow;
    });
  }

  /** Promote the room draft to the active revision. */
  activateWorkflow(chatId: string): Promise<WorkflowDefinition> {
    return this.sendRoomCommandRaw("activate_workflow_result", (requestId) => ({
      type: "activate_workflow",
      chat_id: chatId,
      request_id: requestId,
    })).then((result) => {
      if (!result.workflow) {
        throw new Error("malformed activate_workflow_result");
      }
      return result.workflow;
    });
  }

  /** Start a run of the room's active workflow. Run state arrives via
   *  ``workflow_run_updated`` pushes. Optional ``inputs`` ride along
   *  verbatim as the run's structured input (stock-module design §4.2).
   *  ``templateRef`` is an optional installed-package template selector;
   *  omitting it preserves the legacy active-workflow behavior. */
  runWorkflow(
    chatId: string,
    inputs?: Record<string, unknown>,
    templateRef?: string,
  ): Promise<void> {
    return this.sendRoomCommandRaw("run_workflow_result", (requestId) => ({
      type: "run_workflow",
      chat_id: chatId,
      ...(inputs !== undefined ? { inputs } : {}),
      ...(templateRef !== undefined ? { template_ref: templateRef } : {}),
      request_id: requestId,
    })).then(() => undefined);
  }

  startAgentSkillSetup(agentId: string, name: string): Promise<AgentSkillSetupJob> {
    return this.sendAgentCommandRaw("agent_skill_setup_start_result", (requestId) => ({
      type: "agent_skill_setup_start",
      agent_id: agentId,
      name,
      request_id: requestId,
    })).then((result) => {
      const job = (result as unknown as { job?: AgentSkillSetupJob }).job;
      if (!job) throw new Error("malformed agent_skill_setup_start_result");
      return job;
    });
  }

  getAgentSkillSetup(
    agentId: string,
    name: string,
    jobId?: string,
  ): Promise<AgentSkillSetupJob | null> {
    return this.sendAgentCommandRaw("agent_skill_setup_status_result", (requestId) => ({
      type: "agent_skill_setup_status",
      agent_id: agentId,
      name,
      ...(jobId ? { job_id: jobId } : {}),
      request_id: requestId,
    })).then((result) => (
      (result as unknown as { job?: AgentSkillSetupJob | null }).job ?? null
    ));
  }

  cancelAgentSkillSetup(jobId: string): Promise<AgentSkillSetupJob> {
    return this.sendAgentCommandRaw("agent_skill_setup_cancel_result", (requestId) => ({
      type: "agent_skill_setup_cancel",
      job_id: jobId,
      request_id: requestId,
    })).then((result) => {
      const job = (result as unknown as { job?: AgentSkillSetupJob }).job;
      if (!job) throw new Error("malformed agent_skill_setup_cancel_result");
      return job;
    });
  }

  createCustomAgent(
    displayName: string,
    description: string,
    instructions: string,
  ): Promise<AgentSummary> {
    return this.sendAgentCommandRaw("custom_agent_create_result", (requestId) => ({
      type: "custom_agent_create",
      display_name: displayName,
      description,
      instructions,
      request_id: requestId,
    })).then((result) => {
      const agent = (result as { agent?: AgentSummary }).agent;
      if (!agent) throw new Error("malformed custom_agent_create_result");
      return agent;
    });
  }

  private recordTaskPlanSnapshot(chatId: string, ev: InboundEvent): void {
    if (ev.event === "artifact_task_started") {
      this.artifactTaskIdByChatId.set(chatId, ev.task_id);
      this.taskPlanByChatId.delete(chatId);
      return;
    }
    if (ev.event !== "task_plan") return;
    const currentTaskId = this.artifactTaskIdByChatId.get(chatId);
    if (currentTaskId && ev.task_plan.task_id && ev.task_plan.task_id !== currentTaskId) return;
    this.taskPlanByChatId.set(chatId, ev.task_plan);
  }

  updateAgentSkill(
    agentId: string,
    name: string,
    content: string,
    expectedHash: string,
  ): Promise<void> {
    return this.sendAgentCommandRaw("agent_skill_update_result", (requestId) => ({
      type: "agent_skill_update",
      agent_id: agentId,
      name,
      content,
      expected_hash: expectedHash,
      request_id: requestId,
    })).then(() => undefined);
  }

  /** Synchronize the persisted stock-selection schedule with the gateway
   * cron service.  This is deliberately separate from the HTTP strategy save:
   * a successful save must not be presented as a registered schedule. */
  syncStockScreenSchedule(
    chatId: string,
    strategyId: string,
    schedule: Record<string, unknown>,
  ): Promise<{ status: "registered" | "disabled" | "unavailable" | string; code?: string; detail?: string; job_id?: string }> {
    return this.sendRoomCommandRaw("sync_stock_selection_schedule_result", (requestId) => ({
      type: "sync_stock_selection_schedule",
      chat_id: chatId,
      strategy_id: strategyId,
      schedule,
      request_id: requestId,
    } as unknown as Outbound)).then((result) => {
      const payload = result as unknown as {
        status?: string;
        registered?: boolean;
        unavailable?: boolean;
        code?: string;
        detail?: string;
        job_id?: string;
      };
      if (!payload.status && payload.registered === undefined && payload.unavailable === undefined) {
        throw new Error("malformed sync_stock_selection_schedule_result");
      }
      const status = payload.status
        ?? (payload.registered === true ? "registered" : payload.unavailable === true ? "unavailable" : "disabled");
      return {
        status,
        code: payload.code,
        detail: payload.detail,
        job_id: payload.job_id,
      };
    });
  }

  /** Cancel a non-terminal run (defaults to the room's active run);
   *  resolves with the cancelled run id. */
  cancelWorkflowRun(chatId: string, runId?: string): Promise<string> {
    return this.sendRoomCommandRaw("cancel_workflow_run_result", (requestId) => ({
      type: "cancel_workflow_run",
      chat_id: chatId,
      ...(runId ? { run_id: runId } : {}),
      request_id: requestId,
    })).then((result) => {
      if (!result.run_id) {
        throw new Error("malformed cancel_workflow_run_result");
      }
      return result.run_id;
    });
  }

  /** Retry one failed agent step; the server acknowledges after resetting the
   * step and resumes the run asynchronously. */
  retryWorkflowStep(chatId: string, runId: string, stepId: string): Promise<void> {
    return this.sendRoomCommandRaw("retry_workflow_step_result", (requestId) => ({
      type: "retry_workflow_step",
      chat_id: chatId,
      run_id: runId,
      step_id: stepId,
      request_id: requestId,
    })).then(() => undefined);
  }

  /** Fetch a workflow run (defaults to the room's latest). */
  getWorkflowRun(chatId: string, runId?: string): Promise<WorkflowRun | null> {
    return this.sendRoomCommandRaw("workflow_run_state_result", (requestId) => ({
      type: "get_workflow_run",
      chat_id: chatId,
      ...(runId ? { run_id: runId } : {}),
      request_id: requestId,
    })).then((result) => result.run ?? null);
  }

  /** Approve or reject a waiting approval step (phase 4). Rejects with a
   *  ``RoomCommandError`` whose ``code`` is one of ``conflict`` /
   *  ``not_waiting`` / ``invalid_token`` / ``approval_expired``; the run
   *  state refresh arrives via ``workflow_run_updated`` either way. */
  resolveWorkflowApproval(
    chatId: string,
    runId: string,
    stepId: string,
    token: string,
    approve: boolean,
  ): Promise<void> {
    return this.sendRoomCommandRaw(
      "resolve_workflow_approval_result",
      (requestId) => ({
        type: "resolve_workflow_approval",
        chat_id: chatId,
        run_id: runId,
        step_id: stepId,
        token,
        approve,
        request_id: requestId,
      }),
    ).then(() => undefined);
  }

  connect(): void {
    if (this.socket && this.socket.readyState < WS_CLOSING) return;
    this.intentionallyClosed = false;
    this.setStatus("connecting");
    const sock = this.socketFactory(this.currentUrl);
    this.socket = sock;
    sock.onopen = () => this.handleOpen();
    sock.onmessage = (ev) => this.handleMessage(ev);
    sock.onerror = () => this.setStatus("error");
    sock.onclose = (ev) => this.handleClose(ev);
  }

  close(): void {
    this.intentionallyClosed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const sock = this.socket;
    this.socket = null;
    try {
      sock?.close();
    } catch {
      // ignore
    }
    this.setStatus("closed");
  }

  /** Ask the server to provision a new chat_id; resolves with the assigned id.
   *  When ``ephemeral`` is true the session is hidden from the session list
   *  and deleted when the client explicitly calls ``deleteChat``.
   *
   *  ``workspace`` binds the session to a project working directory. Pass
   *  ``null`` or omit for the default "会话" section.
   *
   *  ``agentKind`` routes the session to a dedicated document agent loop. */
  newChat(
    timeoutMs: number = 5_000,
    ephemeral = false,
    workspace?: string | null,
    agentKind?: string | null,
  ): Promise<string> {
    if (this.pendingNewChat) {
      return Promise.reject(new Error("newChat already in flight"));
    }
    const requestId = `chat_${Date.now().toString(36)}_${(this.newChatRequestSeq++).toString(36)}`;
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingNewChat = null;
        reject(new Error("newChat timed out"));
      }, timeoutMs);
      this.pendingNewChat = { requestId, resolve, reject, timer };
      const payload: Record<string, unknown> = { type: "new_chat", request_id: requestId };
      if (ephemeral) payload.ephemeral = true;
      if (workspace) payload.workspace = workspace;
      if (agentKind) payload.agent_kind = agentKind;
      this.queueSend(payload as Outbound);
    });
  }

  /** Create an independent chat containing the source history through one assistant turn. */
  branchChat(
    sourceChatId: string,
    assistantOrdinal: number,
    sourceTaskId?: string,
    timeoutMs: number = 5_000,
  ): Promise<string> {
    if (this.pendingNewChat) {
      return Promise.reject(new Error("newChat already in flight"));
    }
    const requestId = `chat_${Date.now().toString(36)}_${(this.newChatRequestSeq++).toString(36)}`;
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingNewChat = null;
        reject(new Error("branchChat timed out"));
      }, timeoutMs);
      this.pendingNewChat = { requestId, resolve, reject, timer };
      this.queueSend({
        type: "branch_chat",
        source_chat_id: sourceChatId,
        assistant_ordinal: assistantOrdinal,
        ...(sourceTaskId ? { source_task_id: sourceTaskId } : {}),
        request_id: requestId,
      });
    });
  }

  attach(chatId: string): void {
    this.knownChats.add(chatId);
    if (this.socket?.readyState === WS_OPEN) {
      this.queueSend({ type: "attach", chat_id: chatId });
    }
  }

  deleteChat(chatId: string): void {
    this.knownChats.delete(chatId);
    this.chatHandlers.delete(chatId);
    this.pendingInboundByChat.delete(chatId);
    this.runStartedAtByChatId.delete(chatId);
    this.goalStateByChatId.delete(chatId);
    this.taskPlanByChatId.delete(chatId);
    this.artifactTaskIdByChatId.delete(chatId);
    this.queueSend({ type: "delete_chat", chat_id: chatId });
  }

  sendMessage(
    chatId: string,
    content: string,
    media?: OutboundMedia[],
    options?: {
      /** IMPORTANT: Short display text persisted to server for history replay.
       *  DO NOT remove — keeps user messages showing original input, not enriched prompts. */
      displayContent?: string;
      quote?: MessageQuote;
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
      browserPageUrl?: string;
      browserPageTitle?: string;
      officeSessionId?: string;
      officeDocumentType?: "docs" | "sheets" | "slides";
      officeDisplayName?: string;
      canvasId?: string;
      canvasPath?: string;
      /** Route only this message through a dedicated document Agent. */
      agentKind?: "video";
      taskId?: string;
      origin?: "profile_advice";
      profileAdviceId?: string;
      /** Workspace-relative paths of documents uploaded via sendDocUpload.
       *  The backend resolves them to absolute paths and passes them to
       *  extract_documents(), which injects the extracted text into the user
       *  message so the agent can answer questions about the documents. */
      docPaths?: string[];
      /** Structured ``@Agent`` targets in a room (multi-agent guide 7.5).
       *  The backend re-validates every ID against room membership and
       *  routes partner targets to tracked AgentJobs. */
      targetAgentIds?: string[];
      /** Structured topic discussion launched from a room. */
      discussion?: DiscussionLaunchOptions;
    },
  ): void {
    this.knownChats.add(chatId);
    if (options?.discussion) {
      const frame: Outbound = {
        type: "start_discussion",
        chat_id: chatId,
        content,
        target_agent_ids: options.discussion.participantIds,
        discussion: {
          mode: options.discussion.mode,
          max_rounds: options.discussion.maxRounds,
          positions: options.discussion.positions,
          styles: options.discussion.styles,
          summary_agent_id: options.discussion.summaryAgentId,
        },
        ...(options.displayContent ? { display_content: options.displayContent } : {}),
        ...(options.quote ? { quote: options.quote } : {}),
        webui: true,
      };
      this.queueSend(frame);
      return;
    }
    const frame: Outbound = {
      type: "message",
      chat_id: chatId,
      content,
      ...(media && media.length > 0 ? { media } : {}),
      ...(options?.displayContent ? { display_content: options.displayContent } : {}),
      ...(options?.quote ? { quote: options.quote } : {}),
      ...(options?.terminalSessionId ? { terminal_session_id: options.terminalSessionId } : {}),
      ...(options?.terminalExecMode ? { terminal_exec_mode: options.terminalExecMode } : {}),
      ...(options?.dbConnectionId ? { db_connection_id: options.dbConnectionId } : {}),
      ...(options?.dbDatabase ? { db_database: options.dbDatabase } : {}),
      ...(options?.dbTable ? { db_table: options.dbTable } : {}),
      ...(options?.dbType ? { db_type: options.dbType } : {}),
      ...(options?.dbServerVersion ? { db_server_version: options.dbServerVersion } : {}),
      ...(options?.dbCurrentSql ? { db_current_sql: options.dbCurrentSql } : {}),
      ...(options?.dbLastError ? { db_last_error: options.dbLastError } : {}),
      ...(options?.browserTabId ? { browser_tab_id: options.browserTabId } : {}),
      ...(options?.browserPageUrl ? { browser_page_url: options.browserPageUrl } : {}),
      ...(options?.browserPageTitle ? { browser_page_title: options.browserPageTitle } : {}),
      ...(options?.officeSessionId ? { office_session_id: options.officeSessionId } : {}),
      ...(options?.officeDocumentType ? { office_document_type: options.officeDocumentType } : {}),
      ...(options?.officeDisplayName ? { office_display_name: options.officeDisplayName } : {}),
      ...(options?.canvasId ? { canvas_id: options.canvasId } : {}),
      ...(options?.canvasPath ? { canvas_path: options.canvasPath } : {}),
      ...(options?.agentKind ? { agent_kind: options.agentKind } : {}),
      ...(options?.taskId ? { task_id: options.taskId } : {}),
      ...(options?.origin ? { origin: options.origin } : {}),
      ...(options?.profileAdviceId ? { profile_advice_id: options.profileAdviceId } : {}),
      ...(options?.docPaths && options.docPaths.length > 0 ? { doc_paths: options.docPaths } : {}),
      ...(options?.targetAgentIds && options.targetAgentIds.length > 0
        ? { target_agent_ids: options.targetAgentIds }
        : {}),
      webui: true,
    };
    this.queueSend(frame);
  }

  // -- internals ---------------------------------------------------------

  private setStatus(status: ConnectionStatus): void {
    if (this.status_ === status) return;
    this.status_ = status;
    for (const handler of this.statusHandlers) handler(status);
  }

  private handleOpen(): void {
    this.setStatus("open");
    this.reconnectAttempts = 0;
    // Re-attach every known chat_id so deliveries continue routing after a drop.
    for (const chatId of this.knownChats) {
      this.rawSend({ type: "attach", chat_id: chatId });
    }
    // Flush anything queued during reconnect.
    const queued = this.sendQueue.splice(0);
    for (const frame of queued) this.rawSend(frame);
  }

  private handleMessage(ev: MessageEvent): void {
    let parsed: InboundEvent;
    try {
      parsed = JSON.parse(typeof ev.data === "string" ? ev.data : "") as InboundEvent;
    } catch {
      if (wsInboundDebugEnabled()) {
        const raw = typeof ev.data === "string" ? ev.data : String(ev.data);
        console.warn(
          "[mona ws inbound] invalid JSON",
          raw.length > 400 ? `${raw.slice(0, 400)}… (${raw.length} chars)` : raw,
        );
      }
      return;
    }

    if (wsInboundDebugEnabled()) {
      console.log("[mona ws inbound]", summarizeInboundWsPayload(parsed));
    }

    if (parsed.event === "ready") {
      this.readyChatId = parsed.chat_id;
      this.knownChats.add(parsed.chat_id);
      return;
    }

    if (parsed.event === "attached") {
      this.knownChats.add(parsed.chat_id);
      if (
        this.pendingNewChat &&
        parsed.request_id === this.pendingNewChat.requestId
      ) {
        clearTimeout(this.pendingNewChat.timer);
        this.pendingNewChat.resolve(parsed.chat_id);
        this.pendingNewChat = null;
      }
      this.dispatch(parsed.chat_id, parsed);
      return;
    }

    if (parsed.event === "runtime_model_updated") {
      this.emitRuntimeModelUpdate(parsed.model_name || null, parsed.model_preset ?? null);
      return;
    }

    if (parsed.event === "session_updated") {
      this.emitSessionUpdate(parsed.chat_id, parsed.scope);
      return;
    }

    if (parsed.event === "artifacts_changed") {
      const chatId = typeof parsed.chat_id === "string" ? parsed.chat_id : undefined;
      for (const handler of this.artifactsChangedHandlers) {
        handler(chatId);
      }
      return;
    }

    if (parsed.event === "video_project_changed") {
      const payload = parsed as { name?: string; hint?: string };
      for (const handler of this.videoProjectChangedHandlers) {
        handler({ projectName: payload.name ?? "", hint: payload.hint ?? "" });
      }
      return;
    }

    if (parsed.event === "doc_upload_result") {
      for (const handler of this.docUploadHandlers) {
        handler({
          ok: !!parsed.ok,
          files: parsed.files,
          chatId: parsed.chat_id,
          error: parsed.error,
        });
      }
      return;
    }

    if (
      parsed.event === "create_room_result" ||
      parsed.event === "create_direct_conversation_result" ||
      parsed.event === "update_room_result" ||
      parsed.event === "room_state_result" ||
      parsed.event === "cancel_agent_job_result" ||
      parsed.event === "workflow_draft_ready" ||
      parsed.event === "activate_workflow_result" ||
      parsed.event === "workflow_state_result" ||
      parsed.event === "run_workflow_result" ||
      parsed.event === "cancel_workflow_run_result" ||
      parsed.event === "retry_workflow_step_result" ||
      parsed.event === "workflow_run_state_result" ||
      parsed.event === "resolve_workflow_approval_result" ||
      (parsed as unknown as { event?: string }).event === "sync_stock_selection_schedule_result" ||
      parsed.event === "agent_config_update_result" ||
      parsed.event === "custom_agent_create_result" ||
      parsed.event === "agent_instruction_save_result" ||
      parsed.event === "agent_instruction_restore_result" ||
      parsed.event === "agent_skill_action_result" ||
      parsed.event === "agent_skill_setup_start_result" ||
      parsed.event === "agent_skill_setup_status_result" ||
      parsed.event === "agent_skill_setup_cancel_result" ||
      (parsed as unknown as { event?: string }).event === "agent_skill_update_result"
    ) {
      this.handleRoomCommandResult(parsed);
      return;
    }

    if (
      parsed.event === "agents_updated" ||
      parsed.event === "agent_instructions_updated" ||
      parsed.event === "agent_skills_updated"
    ) {
      for (const handler of this.agentsUpdatedHandlers) {
        handler(parsed.agent_id, parsed.event);
      }
      return;
    }

    if (parsed.event === "room_updated") {
      for (const handler of this.roomUpdatedHandlers) {
        handler(parsed.chat_id, {
          conversation: parsed.conversation,
          agents: parsed.agents,
        });
      }
      return;
    }

    if (parsed.event === "agent_job_updated") {
      for (const handler of this.agentJobUpdatedHandlers) {
        handler(parsed.chat_id, parsed.job);
      }
      return;
    }

    if (parsed.event === "workflow_updated") {
      for (const handler of this.workflowUpdatedHandlers) {
        handler(parsed.chat_id, {
          chatId: parsed.chat_id,
          workflow: parsed.workflow,
          draft: parsed.draft === true,
          activeRevision: parsed.activeRevision ?? null,
        });
      }
      return;
    }

    if (parsed.event === "workflow_run_updated") {
      // The run snapshot is spread at the top level of the frame; conflict
      // error frames carry ``error``/``detail`` instead of ``id``.
      const run = parsed.id ? (parsed as unknown as WorkflowRun) : null;
      for (const handler of this.workflowRunUpdatedHandlers) {
        handler(parsed.chat_id, run, parsed.error, parsed.detail);
      }
      return;
    }

    if (parsed.event === "workflow_step_activity") {
      const frame = parsed as {
        chat_id: string;
        run_id?: string;
        step_id?: string;
        job_id?: string | null;
        author_id?: string;
        tool_events?: unknown;
      };
      if (typeof frame.run_id !== "string" || typeof frame.step_id !== "string") {
        return;
      }
      const toolEvents = Array.isArray(frame.tool_events)
        ? (frame.tool_events as WorkflowStepActivityPayload["toolEvents"])
        : [];
      for (const handler of this.workflowStepActivityHandlers) {
        handler(frame.chat_id, {
          runId: frame.run_id,
          stepId: frame.step_id,
          jobId: typeof frame.job_id === "string" ? frame.job_id : null,
          authorId: typeof frame.author_id === "string" && frame.author_id ? frame.author_id : "mona",
          toolEvents,
        });
      }
      return;
    }

    if (parsed.event === "approval_requested") {
      for (const handler of this.approvalRequestedHandlers) {
        handler({
          chatId: parsed.chat_id,
          runId: parsed.run_id,
          approvals: parsed.approvals ?? [],
        });
      }
      return;
    }

    const chatId = (parsed as { chat_id?: string }).chat_id;
    if (chatId) {
      this.recordGoalStatusForRunStrip(chatId, parsed);
      this.recordGoalStateSnapshot(chatId, parsed);
      this.recordTaskPlanSnapshot(chatId, parsed);
      this.dispatch(chatId, parsed);
    }
  }

  /** Send a room command envelope and await its correlated ``*_result``. */
  private sendRoomCommand(
    resultEvent: string,
    build: (requestId: string) => Outbound,
  ): Promise<RoomState> {
    return this.sendRoomCommandRaw(resultEvent, build).then((result) => {
      if (!result.conversation || !result.agents) {
        throw new Error(`malformed ${resultEvent}`);
      }
      return { conversation: result.conversation, agents: result.agents };
    });
  }

  private sendRoomCommandRaw(
    resultEvent: string,
    build: (requestId: string) => Outbound,
  ): Promise<AnyRoomCommandResult> {
    const requestId = `room_${Date.now().toString(36)}_${(this.roomCommandSeq++).toString(36)}`;
    return new Promise<AnyRoomCommandResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRoomCommands.delete(requestId);
        reject(new Error(`${resultEvent} timed out`));
      }, 10_000);
      this.pendingRoomCommands.set(requestId, { resolve, reject, timer });
      this.queueSend(build(requestId));
    });
  }

  private sendAgentCommandRaw(
    resultEvent: string,
    build: (requestId: string) => Outbound,
  ): Promise<AnyRoomCommandResult> {
    return this.sendRoomCommandRaw(resultEvent, build);
  }

  private handleRoomCommandResult(ev: InboundEvent): void {
    const result = ev as AnyRoomCommandResult & { event: string };
    const requestId = result.request_id;
    const pending = requestId ? this.pendingRoomCommands.get(requestId) : undefined;
    if (!pending) return;
    this.pendingRoomCommands.delete(requestId!);
    clearTimeout(pending.timer);
    if (result.ok) {
      pending.resolve(result);
    } else {
      pending.reject(
        new RoomCommandError(
          result.detail || result.code || "room command failed",
          result.code,
        ),
      );
    }
  }

  private emitRuntimeModelUpdate(modelName: string | null, modelPreset?: string | null): void {
    for (const handler of this.runtimeModelHandlers) {
      handler(modelName, modelPreset);
    }
  }

  private emitSessionUpdate(chatId: string, scope?: SessionUpdateScope): void {
    for (const handler of this.sessionUpdateHandlers) {
      handler(chatId, scope);
    }
  }

  private emitRunStatus(chatId: string, startedAt: number | null): void {
    for (const handler of this.runStatusHandlers) {
      handler(chatId, startedAt);
    }
  }

  private dispatch(chatId: string, ev: InboundEvent): void {
    const handlers = this.chatHandlers.get(chatId);
    if (handlers !== undefined && handlers.size > 0) {
      for (const h of handlers) {
        h(ev);
      }
      return;
    }
    let q = this.pendingInboundByChat.get(chatId);
    if (!q) {
      q = [];
      this.pendingInboundByChat.set(chatId, q);
    }
    q.push(ev);
    const over = q.length - MonaClient.PENDING_INBOUND_MAX;
    if (over > 0) {
      q.splice(0, over);
    }
  }

  private handleClose(event?: { code?: number }): void {
    this.socket = null;
    if (this.pendingNewChat) {
      clearTimeout(this.pendingNewChat.timer);
      this.pendingNewChat.reject(new Error("socket closed"));
      this.pendingNewChat = null;
    }
    // Surface structured reasons *before* reconnect logic so the UI can
    // display the error even while the client transparently reconnects.
    // Browsers populate ``CloseEvent.code`` with the wire-level close code;
    // 1009 = Message Too Big (server's max frame guard).
    if (event?.code === 1009) {
      this.emitError({ kind: "message_too_big" });
    }
    if (this.intentionallyClosed || !this.shouldReconnect) {
      this.setStatus("closed");
      return;
    }
    this.scheduleReconnect();
  }

  private emitError(error: StreamError): void {
    // Isolate subscribers so a throwing handler cannot abort the surrounding
    // ``handleClose`` flow (which still owes us a reconnect decision + status
    // update). We deliberately swallow here: error reporting is best-effort
    // and must never be allowed to compound the failure it's reporting.
    for (const handler of this.errorHandlers) {
      try {
        handler(error);
      } catch {
        // best-effort: subscriber fault must not stall transport bookkeeping
      }
    }
  }

  private scheduleReconnect(): void {
    this.setStatus("reconnecting");
    const attempt = this.reconnectAttempts++;
    // Exponential backoff: 0.5s, 1s, 2s, 4s, capped.
    const delay = Math.min(500 * 2 ** attempt, this.maxBackoffMs);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.options.onReauth) {
        try {
          const refreshed = await this.options.onReauth();
          if (refreshed) this.currentUrl = refreshed;
        } catch {
          // fall through to retry with current URL
        }
      }
      this.connect();
    }, delay);
  }

  private queueSend(frame: Outbound): void {
    if (this.socket?.readyState === WS_OPEN) {
      this.rawSend(frame);
    } else {
      this.sendQueue.push(frame);
    }
  }

  private rawSend(frame: Outbound): void {
    if (!this.socket) return;
    try {
      this.socket.send(JSON.stringify(frame));
    } catch {
      // Send failure will materialize as a close; queue the frame for retry.
      this.sendQueue.push(frame);
    }
  }
}
