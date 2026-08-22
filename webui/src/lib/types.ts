export type Role = "user" | "assistant" | "tool" | "system";

/** "trace" rows are intermediate agent breadcrumbs (tool-call hints,
 * progress pings) that should not be rendered as conversational replies. */
export type MessageKind = "message" | "trace" | "workflowRun";

/** Multi-agent author kinds (phase 0, multi-agent-development-guide 5.3). */
export type AuthorType = "user" | "agent" | "system";

/** Structured message kinds; plain conversation is ``message``. */
export type MessageType = "message" | "job_status" | "workflow_run" | "approval" | "artifact";

/** Conversation shapes (multi-agent phase 2, guide 5.2). */
export type ConversationType = "direct" | "room";

/** Conversation metadata mirrored from ``Session.metadata["conversation"]``
 * (camelCase, matching the backend ``by_alias=True`` dump). Legacy sessions
 * without this payload are treated as a direct chat with Mona. */
export interface ConversationMeta {
  schemaVersion?: number;
  type: ConversationType;
  title: string;
  goal?: string | null;
  agentIds: string[];
  directAgentId?: string | null;
  activeWorkflowId?: string | null;
  activeWorkflowRevision?: number | null;
  archived?: boolean;
  /** System-managed execution container (stock-module design §5.1): hidden
   *  from every conversation list, never user-visible. */
  hidden?: boolean;
}

/** Agent listing entry (``GET /api/agents``). */
export interface AgentSummary {
  id: string;
  displayName: string;
  avatarUrl?: string;
  enabled: boolean;
  /** Product visibility (stock-module design §4.4): ``internal`` agents only
   *  exist inside their pack's room and never appear in the global partner
   *  list. Absent means ``partner``. */
  visibility?: "partner" | "internal";
  packageId?: string;
  packageVersion?: string;
  configRevision?: number;
}

export interface AgentUserConfigPayload {
  schemaVersion?: number;
  revision: number;
  enabled: boolean;
  displayName?: string | null;
  avatar?: string | null;
  modelPreset?: string | null;
  reasoningEffort?: string | null;
  temperature?: number | null;
  maxTokens?: number | null;
  grantedTools?: string[] | null;
  disabledSkills: string[];
  delegationEnabled: boolean;
  scriptEnabledSkills?: string[];
  updatedAt?: string | null;
}

export interface EffectiveAgentConfigPayload {
  agentId: string;
  enabled: boolean;
  displayName: string;
  avatar?: string | null;
  modelPreset?: string | null;
  reasoningEffort?: string | null;
  temperature?: number | null;
  maxTokens?: number | null;
  allowedTools?: string[] | null;
  disabledSkills: string[];
  delegationEnabled: boolean;
  scriptEnabledSkills?: string[];
}

export interface AgentDetailPayload {
  agent: AgentSummary;
  definition: {
    id: string;
    model: string;
    toolAllowlist: string[];
    canDelegate: boolean;
    skills: string[];
    packageId: string;
    packageVersion: string;
  };
  config: AgentUserConfigPayload;
  effective: EffectiveAgentConfigPayload;
  data: {
    memoryFiles: number;
    memoryBytes: number;
    memoryUpdatedAt?: string | null;
    skillFiles: number;
    skillBytes: number;
    skillUpdatedAt?: string | null;
  };
}

export interface AgentInstruction {
  key: "soul" | "agents" | "user" | "memory";
  filename: string;
  content: string;
  contentHash: string;
  updatedAt?: string | null;
}

export interface AgentInstructionHistoryItem {
  sha: string;
  message: string;
  timestamp: string;
}

export interface AgentSkill {
  name: string;
  source: "private" | "package" | "platform" | string;
  enabled: boolean;
  archived: boolean;
  hasScripts: boolean;
  scriptsEnabled: boolean;
  contentHash: string;
}

export interface AgentChangeProposal {
  id: string;
  agentId: string;
  kind: "instruction_patch" | "skill_install";
  status: "pending" | "approved" | "rejected" | "expired" | "failed";
  preview: Record<string, unknown>;
  expectedHash?: string | null;
  createdAt: string;
  expiresAt: string;
  resolvedAt?: string | null;
  error?: string;
  /** Returned only through the authenticated Agent-management channel. */
  token?: string;
}

/** One member entry inside a room state payload. */
export interface RoomAgentInfo {
  id: string;
  displayName: string;
}

/** Room state returned by ``create_room`` / ``update_room`` / ``get_room_state``
 * results and pushed via ``room_updated`` events. */
export interface RoomState {
  conversation: ConversationMeta;
  agents: RoomAgentInfo[];
}

/** Shared fields of the ``create_room`` / ``update_room`` / ``get_room_state``
 * result events (phase 2d). On ``ok: false`` only ``code`` / ``detail`` are set. */
export interface RoomCommandResult {
  ok: boolean;
  chat_id?: string;
  request_id?: string;
  code?: string;
  detail?: string;
  conversation?: ConversationMeta;
  agents?: RoomAgentInfo[];
}

/** Job states mirrored from ``mona/agent/jobs.py`` (guide 5.6). */
export type AgentJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

/** Compact job projection carried by ``agent_job_updated`` events. */
export interface AgentJobSummary {
  id: string;
  roomId: string;
  requestedBy: string;
  assignedTo: string;
  task: string;
  status: AgentJobStatus;
  workflowRunId?: string | null;
  workflowStepId?: string | null;
  parentJobId?: string | null;
  attempt?: number;
  result?: string | null;
  error?: string | null;
}

/** Editable room fields accepted by the ``update_room`` command. */
export interface RoomUpdate {
  title?: string;
  goal?: string | null;
  agentIds?: string[];
}

// ---------------------------------------------------------------------------
// Workflow (multi-agent phase 3, guide 5.4/5.5). Wire shapes mirror
// ``mona/agent/workflow.py`` serialized with ``by_alias=True`` (camelCase).
// ---------------------------------------------------------------------------

export type WorkflowTriggerType = "manual" | "cron";

export interface WorkflowTrigger {
  type: WorkflowTriggerType;
  /** Cron expression when ``type === "cron"`` (phase 4). */
  expr?: string | null;
  /** IANA timezone; null = server local. */
  tz?: string | null;
}

export type WorkflowStepType = "agent" | "approval";

export interface WorkflowStep {
  id: string;
  type: WorkflowStepType;
  /** Agent steps only; must be a room member. */
  agentId?: string | null;
  /** Agent steps only: task brief. */
  task?: string;
  /** Agent steps only: what a good result looks like. */
  expectedOutput?: string;
  /** Approval steps only: prompt shown to the approver. */
  message?: string;
  dependsOn?: string[];
  /** Canvas node coordinates; absent = auto-layout. */
  position?: { x: number; y: number } | null;
}

export type WorkflowStatus = "draft" | "active" | "archived";

export interface WorkflowDefinition {
  schemaVersion: number;
  id: string;
  roomId: string;
  revision: number;
  status: WorkflowStatus;
  goal: string;
  trigger: WorkflowTrigger;
  steps: WorkflowStep[];
  createdAt: string;
  createdBy: string;
}

export type WorkflowRunStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "succeeded"
  | "failed"
  | "cancelled";

export type WorkflowStepStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "skipped";

/** Per-step state inside a run (``StepRun``). The approval fields are
 *  only set on approval steps (phase 4). */
export interface WorkflowStepRun {
  status: WorkflowStepStatus;
  /** Durable execution attempt; legacy run payloads omit it and default to 1. */
  attempt?: number;
  jobId?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  output?: { summary?: string; artifacts?: Array<string | ArtifactRef> } | null;
  error?: string | null;
  approvalToken?: string | null;
  approvalExpiresAt?: string | null;
  approvalDecision?: "approved" | "rejected" | null;
  approvalResolvedAt?: string | null;
  approvalResolvedBy?: string | null;
}

/** One workflow execution with a full definition snapshot. */
export interface WorkflowRun {
  schemaVersion: number;
  id: string;
  roomId: string;
  workflowId: string;
  workflowRevision: number;
  workflow: WorkflowDefinition;
  status: WorkflowRunStatus;
  triggerType: WorkflowTriggerType;
  startedBy: string;
  startedAt: string;
  finishedAt?: string | null;
  steps: Record<string, WorkflowStepRun>;
  /** Structured run inputs supplied at start (stock-module design §4.2). */
  inputs?: Record<string, unknown>;
}

/** Shared envelope of the workflow ``*_result`` events. On ``ok: false``
 *  only ``code`` / ``detail`` are set. */
export interface WorkflowCommandResult {
  ok: boolean;
  chat_id?: string;
  request_id?: string;
  code?: string;
  detail?: string;
  workflow?: WorkflowDefinition;
  /** ``workflow_state_result``: current draft (may be null). */
  draft?: WorkflowDefinition | null;
  /** ``workflow_state_result``: active revision snapshot (may be null). */
  active?: WorkflowDefinition | null;
  activeRevision?: number | null;
  revisions?: number[];
  run?: WorkflowRun | null;
  run_id?: string;
  /** ``resolve_workflow_approval_result``: the resolved step id. */
  step_id?: string;
}

/** One waiting approval inside an ``approval_requested`` broadcast. */
export interface ApprovalRequestItem {
  stepId: string;
  message: string;
  token: string | null;
}

/** ``approval_requested`` broadcast payload (normalized by MonaClient). */
export interface ApprovalRequestedPayload {
  chatId: string;
  runId: string;
  approvals: ApprovalRequestItem[];
}

/** ``workflow_updated`` broadcast payload (normalized by MonaClient). */
export interface WorkflowUpdatedPayload {
  chatId: string;
  workflow: WorkflowDefinition;
  /** True when the pushed workflow is the room draft. */
  draft: boolean;
  activeRevision?: number | null;
}

/** ``workflow_step_activity`` broadcast payload (normalized by MonaClient):
 *  the live tool-activity accumulator of one step job; each frame is a full
 *  snapshot, replacing whatever was seen before for the same step. */
export interface WorkflowStepActivityPayload {
  runId: string;
  stepId: string;
  jobId?: string | null;
  authorId: string;
  toolEvents: ToolProgressEvent[];
}

/** One image attached to a UIMessage.
 *
 * ``url`` can arrive in three different shapes, which the bubble renders
 * identically:
 * - A ``data:image/...;base64,...`` URL generated by the Composer for the
 *   optimistic preview of an in-flight user turn. Self-contained, no
 *   lifecycle.
 * - A signed ``/api/media/...`` URL attached to a historical user turn by
 *   the backend on session replay. Safe to drop into an ``<img src>``.
 * - Absent. The backend couldn't resolve a stored path (file moved,
 *   deleted, or pre-media-persistence session). The bubble shows a
 *   placeholder tile with ``name`` as the label.
 */
export interface UIImage {
  url?: string;
  name?: string;
}

export type UIMediaKind = "image" | "video" | "file";

export interface UIMediaAttachment {
  kind: UIMediaKind;
  url?: string;
  name?: string;
}

export interface DeliveredFile {
  path: string;
  absolute_path: string;
  name: string;
  size: number;
  size_human: string;
  mime: string;
  summary?: string;
  /** ISO 8601 timestamp from the shared-output scan. May be absent on
   *  deliver_file/file_edit events that don't carry mtime. */
  modified_at?: string;
  missing?: boolean;
  artifact_ref?: ArtifactRef;
}

export interface ArtifactRef {
  id: string;
  owner_kind: "agent" | "product";
  owner_id: string;
  relative_path: string;
  created_by_agent_id: string;
  created_at: string;
  product?: string | null;
  session_id?: string | null;
  room_id?: string | null;
  job_id?: string | null;
  workflow_run_id?: string | null;
  workflow_step_id?: string | null;
  size?: number | null;
  modified_at?: string | null;
  mime?: string | null;
}

export interface UIMessage {
  id: string;
  role: Role;
  content: string;
  /** Short display text for user messages (e.g. action label). Falls back to ``content``. */
  displayContent?: string;
  kind?: MessageKind;
  isStreaming?: boolean;
  createdAt: number;
  /** For trace rows: each individual hint line, so consecutive hints can
   * render as a single collapsible group. */
  traces?: string[];
  /** Activity rows: explicit file edits emitted by edit tools. */
  fileEdits?: UIFileEdit[];
  /** Activity rows created during the same agent phase share one collapsible block. */
  activitySegmentId?: string;
  /** User turn: optimistic blob URLs for preview. Replay: placeholder chips. */
  images?: UIImage[];
  /** Signed or local UI-renderable media attachments. */
  media?: UIMediaAttachment[];
  /** Files delivered via deliver_file tool, rendered as FileCards. */
  deliveredFiles?: DeliveredFile[];
  /** Assistant turn: accumulated model reasoning / thinking text. Built up
   * incrementally from ``reasoning_delta`` frames; finalized when
   * ``reasoning_end`` arrives. */
  reasoning?: string;
  /** True while ``reasoning_delta`` frames are still arriving for this turn.
   * Drives the shimmer header on ``ReasoningBubble``. */
  reasoningStreaming?: boolean;
  /** End-to-end wall time for this assistant turn (persisted ``latency_ms`` / ``turn_end``). */
  latencyMs?: number;
  /** User turn: true when this message was injected mid-turn (via the pending
   *  queue "append" action) rather than sent as a new conversational turn.
   *  Drives a subtle visual badge so the user knows it was a supplement. */
  isInjected?: boolean;
  /** Multi-agent phase 0: who authored this message. Absent on
   *  pre-multi-agent persisted data. */
  authorType?: AuthorType;
  /** Agent ID of the author (``mona``, ``com.mona.a-share-analyst``, …).
   *  Absent on user messages and legacy data; render a missing value on
   *  assistant messages as Mona. */
  authorId?: string;
  /** Structured message kind; plain conversation when absent or ``message``. */
  messageType?: MessageType;
  /** Delegated job this message belongs to (``job_status`` / delegated replies). */
  jobId?: string;
  /** Workflow run this message belongs to (``workflow_run`` / ``approval``). */
  workflowRunId?: string;
  /** Tool-activity trail of a workflow step, persisted with the step's
   *  result message so the room can show "how the agent worked" on replay. */
  toolEvents?: ToolProgressEvent[];
  /** Structured payload for non-``message`` kinds (job snapshot, run summary…). */
  payload?: unknown;
}

/** Structured UI blob on ``progress`` WS frames; channels may add more ``kind`` values later. */
export interface AgentUIBlob {
  kind: string;
  data?: unknown;
}

/** WebSocket snapshot for sustained goals (`goal_state` events; keyed by ``chat_id``). */
export interface GoalStateWsPayload {
  active: boolean;
  ui_summary?: string;
  objective?: string;
}

export interface ToolProgressEvent {
  version?: number;
  phase?: "start" | "end" | "error" | string;
  call_id?: string;
  name?: string;
  arguments?: unknown;
  result?: unknown;
  error?: unknown;
  files?: unknown[];
  embeds?: unknown[];
}

export interface UIFileEdit {
  version?: number;
  call_id: string;
  tool: string;
  path: string;
  absolute_path?: string;
  phase?: "start" | "end" | "error" | string;
  added: number;
  deleted: number;
  approximate?: boolean;
  status: "editing" | "done" | "error";
  binary?: boolean;
  error?: string;
  pending?: boolean;
  artifact_ref?: ArtifactRef;
}

export interface ChatSummary {
  /** Server-side session key, e.g. ``websocket:abcd-...``. */
  key: string;
  /** Local channel + chat_id parts derived from ``key`` for convenience. */
  channel: string;
  chatId: string;
  createdAt: string | null;
  updatedAt: string | null;
  title?: string;
  preview: string;
  /** Timestamp of the preview message (IM plan 12.1); ``preview`` and
   *  ``previewAt`` always come from the same user-visible message. */
  previewAt?: string | null;
  /** Author of the preview message; legacy assistant messages count as the
   *  Mona agent. */
  previewAuthorType?: AuthorType | null;
  previewAuthorId?: string | null;
  previewMessageType?: MessageType | null;
  /** Latest persisted workflow run status for room sessions (IM plan 12.1). */
  workflowRunStatus?: WorkflowRunStatus | null;
  /** True while a persisted run waits on an approval step. */
  waitingApproval?: boolean;
  /** True when the room's active workflow has a live cron trigger. */
  scheduled?: boolean;
  /** Project workspace directory bound to this session. ``null`` (or omitted)
   *  means the session belongs to the default "会话" section (default workspace). */
  workspace?: string | null;
  /** Unix epoch seconds when this session currently has a turn in flight. */
  runStartedAt?: number | null;
  /** Multi-agent conversation shape (phase 2d). Absent on legacy sessions,
   *  which render as a direct chat with Mona. */
  conversation?: ConversationMeta | null;
}

/** Attention badge for a conversation row (IM plan 12.3), derived on the UI
 *  layer from ``ChatSummary`` — never persisted into a React store. */
export type ConversationListStatus =
  | "waiting_approval"
  | "failed"
  | "running"
  | "scheduled"
  | null;

export type SidebarDensity = "comfortable" | "compact";
export type SidebarSortMode = "updated_desc" | "created_desc" | "title_asc";

export interface SidebarViewState {
  density: SidebarDensity;
  show_previews: boolean;
  show_timestamps: boolean;
  show_archived: boolean;
  sort: SidebarSortMode;
}

export interface SidebarStatePayload {
  schema_version: number;
  pinned_keys: string[];
  archived_keys: string[];
  title_overrides: Record<string, string>;
    /** IM unread derivation (schema v5): last-read marker per
   *  session key, compared against ``ChatSummary.previewAt``. */
  last_read_at_by_key: Record<string, string>;
  tags_by_key: Record<string, string[]>;
  collapsed_groups: Record<string, boolean>;
  view: SidebarViewState;
  updated_at?: string | null;
}

export interface BootstrapResponse {
  token: string;
  ws_path: string;
  expires_in: number;
  model_name?: string | null;
}

export interface SettingsPayload {
  agent: {
    model: string;
    provider: string;
    resolved_provider: string | null;
    has_api_key: boolean;
    model_preset: string | null;
    max_tokens: number;
    context_window_tokens: number;
    temperature: number;
    reasoning_effort: string | null;
    timezone: string;
    bot_name: string;
    bot_icon: string;
    tool_hint_max_length: number;
  };
  model_presets: Array<{
    name: string;
    label: string;
    active: boolean;
    is_default: boolean;
    model: string;
    provider: string;
    max_tokens: number;
    context_window_tokens: number;
    temperature: number;
    reasoning_effort: string | null;
    capabilities?: {
      supports_vision: boolean | null;
      supports_tool_calling: boolean | null;
      supports_streaming: boolean;
      supports_json_mode: boolean | null;
    };
  }>;
  providers: Array<{
    name: string;
    label: string;
    configured: boolean;
    api_key_required?: boolean;
    api_key_hint?: string | null;
    api_base?: string | null;
    default_api_base?: string | null;
    free_default_model?: string | null;
    model?: string | null;
    backend?: string;
    probe_supported?: boolean;
  }>;
  chat_providers?: Array<{
    name: string;
    label: string;
    is_custom?: boolean;
    configured: boolean;
    api_key_required: boolean;
    api_key_hint?: string | null;
    api_base: string;
    default_api_base: string;
    model?: string | null;
    models: Array<{
      id: string;
      name: string;
      context_window?: number | null;
      enabled: boolean;
      recommended: boolean;
    }>;
    models_url?: string | null;
    region?: string | null;
    api_base_editable: boolean;
  }>;
  web_search: {
    provider: string;
    api_key_hint?: string | null;
    base_url?: string | null;
    max_results: number;
    timeout: number;
    providers: Array<{
      name: string;
      label: string;
      credential: "none" | "api_key" | "base_url";
    }>;
  };
  web: {
    enable: boolean;
    proxy?: string | null;
    user_agent?: string | null;
    search: {
      max_results: number;
      timeout: number;
    };
    fetch: {
      use_jina_reader: boolean;
    };
  };
  image_generation: {
    enabled: boolean;
    provider: string;
    provider_configured: boolean;
    model: string;
    default_aspect_ratio: string;
    default_image_size: string;
    max_images_per_turn: number;
    save_dir: string;
    providers: Array<{
      name: string;
      label: string;
      configured: boolean;
      api_key_hint?: string | null;
      api_base?: string | null;
      default_api_base?: string | null;
      image_models?: string[];
      default_image_model?: string | null;
    }>;
  };
  video_generation: {
    enabled: boolean;
    provider: string;
    provider_configured: boolean;
    model: string;
    default_aspect_ratio: string;
    default_duration: number;
    save_dir: string;
    providers: Array<{
      name: string;
      label: string;
      configured: boolean;
      api_key_hint?: string | null;
      api_base?: string | null;
      default_api_base?: string | null;
      video_models?: string[];
      default_video_model?: string | null;
    }>;
  };
  runtime: {
    config_path: string;
    workspace_path: string;
    gateway_host: string;
    gateway_port: number;
    heartbeat: {
      enabled: boolean;
      interval_s: number;
      keep_recent_messages: number;
    };
    dream: {
      schedule: string;
      max_batch_size: number;
      max_iterations: number;
      annotate_line_ages: boolean;
    };
    unified_session: boolean;
  };
  advanced: {
    restrict_to_workspace: boolean;
    ssrf_whitelist_count: number;
    mcp_server_count: number;
    exec_enabled: boolean;
    exec_sandbox?: string | null;
    exec_path_append_set: boolean;
  };
  channels: {
    available: Array<ChannelInfo>;
  };
  tts: {
    provider: string;
    voice: string;
    api_base: string | null;
    model: string | null;
    api_key_configured: boolean;
    api_key_hint: string | null;
  };
  stock: {
    enabled: boolean;
    auto_review_enabled: boolean;
    review_time: string;
    review_scope: "all" | "focus";
    push_notification: boolean;
    push_email: boolean;
    quote_refresh_sec: number;
  };
  requires_restart: boolean;
  restart_required_sections?: Array<"runtime" | "web" | "providers" | "channels">;
}

export interface ChannelInfo {
  name: string;
  display_name: string;
  enabled: boolean;
  supports_login: boolean;
  logged_in?: boolean;
  allow_from?: string[];
  /** WeCom: bot_id; QQ/Feishu: app_id. */
  bot_id?: string;
  app_id?: string;
  /** "true" if a secret/app_secret is set, "" otherwise (never echoes the value). */
  secret?: string;
  app_secret?: string;
}

export type WeixinLoginState =
  | "idle"
  | "fetching_qr"
  | "awaiting_scan"
  | "confirmed"
  | "expired"
  | "failed"
  | "cancelled";

export interface WeixinLoginStatus {
  state: WeixinLoginState;
  qr_svg?: string;
  error?: string;
  logged_in?: boolean;
}

export interface SettingsUpdate {
  model?: string;
  provider?: string;
  modelPreset?: string | null;
  providerModel?: string;
  timezone?: string;
  botName?: string;
  botIcon?: string;
  toolHintMaxLength?: number;
  workspace?: string;
}

export interface ProviderSettingsUpdate {
  provider: string;
  customName?: string;
  apiKey?: string;
  apiBase?: string;
  model?: string;
  enabledModels?: string[];
  discoveredModels?: Array<{ id: string; name?: string; contextWindow?: number | null }>;
  delete?: boolean;
}

export interface WebSearchSettingsUpdate {
  provider: string;
  apiKey?: string;
  baseUrl?: string;
  maxResults?: number;
  timeout?: number;
  useJinaReader?: boolean;
}

export interface ImageGenerationSettingsUpdate {
  enabled: boolean;
  provider: string;
  model: string;
  defaultAspectRatio: string;
  defaultImageSize: string;
  maxImagesPerTurn: number;
}

export interface VideoGenerationSettingsUpdate {
  enabled: boolean;
  provider: string;
  model: string;
  defaultAspectRatio: string;
  defaultDuration: number;
}

export interface TtsSettingsUpdate {
  provider?: string;
  voice?: string;
  apiBase?: string;
  model?: string;
  /** Non-empty replaces the stored key; omitted leaves it unchanged. */
  apiKey?: string;
  /** Remove the stored API key. */
  clearKey?: boolean;
}

export interface StockSettingsUpdate {
  enabled?: boolean;
  /** Whether the daily review scheduler is enabled independently of the stock module. */
  autoReviewEnabled?: boolean;
  /** ``HH:MM`` in Asia/Shanghai — the daily review trigger time. */
  reviewTime?: string;
  /** Daily-review coverage: all watchlist items or focus-marked only. */
  reviewScope?: "all" | "focus";
  pushNotification?: boolean;
  pushEmail?: boolean;
  /** Quote polling interval in seconds (5–3600). */
  quoteRefreshSec?: number;
}

export interface SlashCommand {
  command: string;
  title: string;
  description: string;
  icon: string;
  argHint?: string;
}

export type ConnectionStatus =
  | "idle"
  | "connecting"
  | "open"
  | "reconnecting"
  | "closed"
  | "error";

export type InboundEvent =
  | { event: "ready"; chat_id: string; client_id: string }
  | { event: "attached"; chat_id: string }
  | {
      event: "message";
      chat_id: string;
      text: string;
      reply_to?: string;
      media?: string[];
      media_urls?: Array<{ url: string; name?: string }>;
      tool_events?: ToolProgressEvent[];
      /** Present when the frame is an agent breadcrumb (e.g. tool hint,
       * generic progress line) rather than a conversational reply. */
      kind?: "tool_hint" | "progress" | "reasoning";
      /** Server-measured turn wall time when this frame finishes an assistant reply. */
      latency_ms?: number;
      /** Optional structured payload on progress frames (channel-specific). */
      agent_ui?: AgentUIBlob;
      /** Set when this message is a fired personal schedule reminder;
       * webui clients use it to trigger a native system notification. */
      schedule_reminder?: boolean;
      schedule_item_id?: string;
      /** Multi-agent phase 2d: authoring agent; absent defaults to Mona. */
      author_id?: string;
      /** Structured message kind; plain conversation when absent. */
      message_type?: MessageType;
      job_id?: string;
      workflow_run_id?: string;
      payload?: unknown;
    }
  | {
      event: "file_edit";
      chat_id: string;
      edits: UIFileEdit[];
    }
  | {
      event: "deliver_files";
      chat_id: string;
      files: DeliveredFile[];
    }
  | {
      event: "delta";
      chat_id: string;
      text: string;
      stream_id?: string;
      /** Multi-agent phase 2d: streaming author; absent defaults to Mona. */
      author_id?: string;
    }
  | {
      event: "stream_end";
      chat_id: string;
      stream_id?: string;
    }
  | {
      event: "reasoning_delta";
      chat_id: string;
      text: string;
      stream_id?: string;
    }
  | {
      event: "reasoning_end";
      chat_id: string;
      stream_id?: string;
    }
  | {
      event: "runtime_model_updated";
      model_name: string;
      model_preset?: string | null;
    }
  | {
      event: "turn_end";
      chat_id: string;
      latency_ms?: number;
      /** Authoritative sustained-goal snapshot for this chat (same shape as ``goal_state`` events). */
      goal_state?: GoalStateWsPayload;
    }
  | {
      event: "goal_status";
      chat_id: string;
      /** Turn executing (user message through agent loop). */
      status: "running" | "idle";
      /** Server ``time.time()`` when ``status`` is ``running``. */
      started_at?: number;
    }
  | {
      event: "goal_state";
      chat_id: string;
      goal_state: GoalStateWsPayload;
    }
  | { event: "session_updated"; chat_id: string; scope?: "metadata" | "thread" | string }
  | { event: "artifacts_changed"; chat_id?: string }
  | { event: "video_project_changed"; name?: string; hint?: string }
  | { event: "error"; chat_id?: string; detail?: string }
  | {
      event: "ppt_upload_result";
      ok: boolean;
      files?: { name: string; path: string }[];
      error?: string;
    }
  | {
      event: "ppt_save_brand_result";
      ok: boolean;
      brandId?: string;
      error?: string;
    }
  | {
      event: "ppt_delete_brand_result";
      ok: boolean;
      brandId?: string;
      error?: string;
    }
  | {
      event: "ppt_import_native_result";
      ok: boolean;
      templateId?: string;
      name?: string;
      pageCount?: number;
      coverUrl?: string;
      primaryColor?: string;
      error?: string;
    }
  | {
      event: "ppt_delete_native_result";
      ok: boolean;
      templateId?: string;
      error?: string;
    }
  | {
      event: "doc_upload_result";
      ok: boolean;
      files?: { name: string; path: string; size?: number; mime?: string }[];
      chat_id?: string;
      error?: string;
    }
  | ({ event: "create_room_result" } & RoomCommandResult)
  | ({ event: "update_room_result" } & RoomCommandResult)
  | ({ event: "room_state_result" } & RoomCommandResult)
  | ({ event: "create_direct_conversation_result" } & RoomCommandResult)
  | {
      event: "room_updated";
      chat_id: string;
      conversation: ConversationMeta;
      agents: RoomAgentInfo[];
    }
  | {
      event: "agents_updated" | "agent_instructions_updated" | "agent_skills_updated";
      agent_id: string;
      key?: string;
    }
  | {
      event: "agent_change_proposal_created" | "agent_change_proposal_resolved";
      agent_id: string;
      proposal_id: string;
      kind?: AgentChangeProposal["kind"];
      status?: AgentChangeProposal["status"];
    }
  | ({
      event:
        | "agent_config_update_result"
        | "agent_instruction_save_result"
        | "agent_instruction_restore_result"
        | "agent_skill_stage_result"
        | "agent_skill_action_result"
        | "resolve_agent_change_result";
      ok: boolean;
      request_id?: string;
      agent_id?: string;
      detail?: string;
      config?: AgentUserConfigPayload;
      agent?: AgentSummary;
      instruction?: AgentInstruction;
      proposal?: AgentChangeProposal;
      name?: string;
      action?: string;
    })
  | {
      event: "cancel_agent_job_result";
      ok: boolean;
      chat_id?: string;
      request_id?: string;
      code?: string;
      detail?: string;
      job_id?: string;
      job?: AgentJobSummary;
    }
  | {
      event: "agent_job_updated";
      chat_id: string;
      job: AgentJobSummary;
    }
  | ({ event: "workflow_draft_ready" } & WorkflowCommandResult)
  | ({ event: "activate_workflow_result" } & WorkflowCommandResult)
  | ({ event: "workflow_state_result" } & WorkflowCommandResult)
  | ({ event: "run_workflow_result" } & WorkflowCommandResult)
  | ({ event: "cancel_workflow_run_result" } & WorkflowCommandResult)
  | ({ event: "retry_workflow_step_result" } & WorkflowCommandResult)
  | ({ event: "workflow_run_state_result" } & WorkflowCommandResult)
  | ({ event: "resolve_workflow_approval_result" } & WorkflowCommandResult)
  | {
      event: "approval_requested";
      chat_id: string;
      run_id: string;
      approvals: ApprovalRequestItem[];
    }
  | {
      event: "workflow_updated";
      chat_id: string;
      workflow: WorkflowDefinition;
      draft?: boolean;
      activeRevision?: number | null;
    }
  | ({
      event: "workflow_run_updated";
      chat_id: string;
      /** Present (with ``detail``) on run-conflict frames instead of a run. */
      error?: string;
      detail?: string;
    } & Partial<WorkflowRun>)
  | {
      event: "workflow_step_activity";
      chat_id: string;
      run_id?: string;
      step_id?: string;
      job_id?: string | null;
      author_id?: string;
      tool_events?: ToolProgressEvent[];
    };

/** Base64-encoded image attached to an outbound ``message`` envelope.
 *
 * ``data_url`` must be a ``data:image/<png|jpeg|webp|gif>;base64,...`` string
 * — the server whitelists those MIME types and rejects everything else
 * (including SVG, to avoid an XSS surface). ``name`` is advisory: it's
 * preserved for the file on disk and surfaced as the placeholder label when
 * the session is replayed.
 */
export interface OutboundMedia {
  data_url: string;
  name?: string;
}

/** Response shape for ``GET .../webui-thread`` (server-built transcript replay). */
export interface WebuiThreadPersistedPayload {
  schemaVersion: number;
  sessionKey?: string;
  savedAt?: string;
  messages: UIMessage[];
}

export type Outbound =
  | { type: "new_chat"; ephemeral?: boolean; workspace?: string | null; agent_kind?: string | null }
  | { type: "attach"; chat_id: string }
  | {
      type: "message";
      chat_id: string;
      content: string;
      media?: OutboundMedia[];
      webui?: true;
      /** IMPORTANT: Short display text for the user message bubble (e.g. action label).
       *  When set, the frontend renders this instead of the full `content`.
       *  This field is persisted to the server so history replay also shows the short version.
       *  DO NOT remove — multiple modules (terminal, db, notes) depend on this. */
      display_content?: string;
      terminal_session_id?: string;
      terminal_exec_mode?: string;
      db_connection_id?: string;
      db_database?: string;
      db_table?: string;
      db_type?: string;
      db_server_version?: string;
      db_current_sql?: string;
      db_last_error?: string;
      browser_page_url?: string;
      browser_page_title?: string;
    }
  | { type: "delete_chat"; chat_id: string }
  | {
      type: "ppt_upload";
      files: { name: string; data_url: string }[];
    }
  | {
      type: "ppt_delete_brand";
      data: { brandId: string };
    }
  | {
      type: "ppt_import_native";
      file: { name: string; data_url: string };
    }
  | {
      type: "ppt_delete_native";
      data: { templateId: string };
    }
  | {
      type: "doc_upload";
      chat_id: string;
      files: { name: string; data_url: string }[];
    }
  | {
      type: "create_room";
      chat_id: string;
      agent_ids: string[];
      title?: string;
      goal?: string;
      request_id?: string;
    }
  | {
      type: "create_direct_conversation";
      chat_id: string;
      agent_id: string;
      title?: string;
      request_id?: string;
    }
  | {
      type: "update_room";
      chat_id: string;
      agent_ids?: string[];
      title?: string;
      goal?: string | null;
      request_id?: string;
    }
  | { type: "get_room_state"; chat_id: string; request_id?: string }
  | {
      type: "cancel_agent_job";
      chat_id: string;
      job_id: string;
      reason?: string;
      request_id?: string;
    }
  | {
      type: "save_workflow_draft";
      chat_id: string;
      goal: string;
      trigger?: WorkflowTrigger;
      steps: WorkflowStep[];
      request_id?: string;
    }
  | { type: "activate_workflow"; chat_id: string; request_id?: string }
  | { type: "get_workflow"; chat_id: string; request_id?: string }
  | { type: "run_workflow"; chat_id: string; request_id?: string }
  | {
      type: "cancel_workflow_run";
      chat_id: string;
      run_id?: string;
      request_id?: string;
    }
  | {
      type: "retry_workflow_step";
      chat_id: string;
      run_id: string;
      step_id: string;
      request_id?: string;
    }
  | { type: "get_workflow_run"; chat_id: string; run_id?: string; request_id?: string }
  | {
      type: "resolve_workflow_approval";
      chat_id: string;
      run_id: string;
      step_id: string;
      token: string;
      approve: boolean;
      request_id?: string;
    }
  | {
      type: "agent_config_update";
      agent_id: string;
      config: Record<string, unknown>;
      expected_revision?: number;
      request_id?: string;
    }
  | {
      type: "agent_instruction_save";
      agent_id: string;
      key: AgentInstruction["key"];
      content: string;
      request_id?: string;
    }
  | {
      type: "agent_instruction_restore";
      agent_id: string;
      key: AgentInstruction["key"];
      commit: string;
      request_id?: string;
    }
  | {
      type: "agent_skill_stage";
      agent_id: string;
      name: string;
      content?: string;
      files?: Record<string, string>;
      request_id?: string;
    }
  | {
      type: "agent_skill_action";
      agent_id: string;
      name: string;
      action: "enable" | "disable" | "archive" | "restore" | "enable_scripts" | "disable_scripts";
      request_id?: string;
    }
  | {
      type: "resolve_agent_change";
      agent_id: string;
      proposal_id: string;
      token: string;
      approve: boolean;
      request_id?: string;
    };

export interface PptTemplate {
  key: string;
  kind: "layout" | "brand" | "native";
  group: string;
  name: string;
  summary: string;
  coverSvgUrl: string;
  primaryColor?: string;
  pageCount?: number;
  canvasFormat?: string;
  userCreated?: boolean;
}

export interface PptCanvasFormat {
  key: string;
  label: string;
  viewBox: string;
  desc: string;
}

export interface PptTemplatesResponse {
  templates: PptTemplate[];
  canvasFormats: PptCanvasFormat[];
}

export interface PptProject {
  name: string;
  createdAt: number;
  format: string;
  slideCount: number;
  hasExport: boolean;
  hasSvgOutput: boolean;
  hasPptxOutput: boolean;
  hasSpecLock: boolean;
  status: "init" | "planning" | "generating" | "done";
  phase?: string;
  chatId: string | null;
}

