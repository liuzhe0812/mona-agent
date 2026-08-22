import type {
  AgentChangeProposal,
  AgentDetailPayload,
  AgentInstruction,
  AgentInstructionHistoryItem,
  AgentSkill,
  AgentSummary,
  AuthorType,
  ChatSummary,
  ConversationMeta,
  DeliveredFile,
  ImageGenerationSettingsUpdate,
  MessageType,
  PptProject,
  PptTemplatesResponse,
  ProviderSettingsUpdate,
  SettingsPayload,
  SettingsUpdate,
  SidebarStatePayload,
  SlashCommand,
  StockSettingsUpdate,
  TtsSettingsUpdate,
  VideoGenerationSettingsUpdate,
  WebSearchSettingsUpdate,
  WeixinLoginStatus,
  WebuiThreadPersistedPayload,
  WorkflowRunStatus,
} from "./types";
import { isTauri, getGatewayStatus, getServicesStatus, httpFetch } from "./tauri";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "ApiError";
  }
}

let _apiBase: string | null = null;
let _gatewayHttpBase: string | null = null;
let _servicesHttpBase: string | null = null;

export async function getApiBase(): Promise<string> {
  if (_apiBase) return _apiBase;
  if (isTauri()) {
    const status = await getGatewayStatus();
    if (status.ws_port) {
      _apiBase = `http://127.0.0.1:${status.ws_port}`;
      return _apiBase;
    }
  }
  return "";
}

/** Return the gateway HTTP base URL (e.g. ``http://127.0.0.1:17173``).
 *
 * The gateway aiohttp app serves ALL HTTP routes (/email/*, /api/kb/*,
 * /v1/chat/completions, /health, …). Use this instead of ``getApiBase()``
 * for routes that are registered on the gateway but NOT on the websocket
 * server (e.g. /email/*). See project_rules.md "端口架构" for details. */
export async function getGatewayHttpBase(): Promise<string> {
  if (_gatewayHttpBase) return _gatewayHttpBase;
  if (isTauri()) {
    let status = await getGatewayStatus();
    if (!status.running) {
      try {
        const { startGateway } = await import("./tauri");
        await startGateway();
        status = await getGatewayStatus();
      } catch {
        // fall through — return empty if gateway cannot be started
      }
    }
    if (status.port) {
      _gatewayHttpBase = `http://127.0.0.1:${status.port}`;
      return _gatewayHttpBase;
    }
  }
  return "";
}

/** Return the services HTTP base URL (e.g. ``http://127.0.0.1:17174``).
 *
 * The services process serves business-domain routes (email / schedule /
 * video / materials / profile / hoard / contacts). Mirrors
 * ``getGatewayHttpBase()``: caches the base and lazily starts the services
 * process when it is not running. */
export async function getServicesHttpBase(): Promise<string> {
  if (_servicesHttpBase) return _servicesHttpBase;
  if (isTauri()) {
    let status = await getServicesStatus();
    if (!status.running) {
      try {
        const { startServices } = await import("./tauri");
        await startServices();
        status = await getServicesStatus();
      } catch {
        // fall through — return empty if services cannot be started
      }
    }
    if (status.port) {
      _servicesHttpBase = `http://127.0.0.1:${status.port}`;
      return _servicesHttpBase;
    }
  }
  return "";
}

export function resetApiBase(): void {
  _apiBase = null;
  _gatewayHttpBase = null;
  _servicesHttpBase = null;
}

export function resetServicesHttpBase(): void {
  _servicesHttpBase = null;
}

/** Return the cached API base synchronously (empty string if not yet resolved).
 *
 * Useful for resolving relative media URLs (e.g. ``/api/media/…``) in
 * components where an async call is impractical. By the time media URLs
 * are rendered the bootstrap has completed, so the cache is populated. */
export function getCachedApiBase(): string {
  return _apiBase ?? "";
}

async function request<T>(
  url: string,
  token: string,
  init?: RequestInit,
): Promise<T> {
  const res = await httpFetch(url, {
    ...(init ?? {}),
    headers: {
      ...(init?.headers ?? {}),
      Authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const payload = await res.json() as { error?: string | { message?: string } };
      const error = payload.error;
      message = typeof error === "string" ? error : (error?.message ?? message);
    } catch {
      // Keep the HTTP fallback when the server did not return JSON.
    }
    throw new ApiError(res.status, message);
  }
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("text/html")) {
    throw new ApiError(res.status, "Gateway 未就绪，收到了 HTML 响应");
  }
  return (await res.json()) as T;
}

function splitKey(key: string): { channel: string; chatId: string } {
  const idx = key.indexOf(":");
  if (idx === -1) return { channel: "", chatId: key };
  return { channel: key.slice(0, idx), chatId: key.slice(idx + 1) };
}

export async function listSessions(
  token: string,
  base?: string,
): Promise<ChatSummary[]> {
  const effectiveBase = base ?? (await getApiBase());
  type Row = {
    key: string;
    created_at: string | null;
    updated_at: string | null;
    title?: string;
    preview?: string;
    preview_at?: string | null;
    preview_author_type?: AuthorType | null;
    preview_author_id?: string | null;
    preview_message_type?: MessageType | null;
    workflow_run_status?: WorkflowRunStatus | null;
    waiting_approval?: boolean;
    scheduled?: boolean;
    run_started_at?: number | null;
    conversation?: ConversationMeta | null;
  };
  const body = await request<{ sessions: Row[] }>(
    `${effectiveBase}/api/sessions`,
    token,
  );
  return body.sessions.map((s) => ({
    key: s.key,
    ...splitKey(s.key),
    createdAt: s.created_at,
    updatedAt: s.updated_at,
    title: s.title ?? "",
    preview: s.preview ?? "",
    previewAt: s.preview_at ?? null,
    previewAuthorType: s.preview_author_type ?? null,
    previewAuthorId: s.preview_author_id ?? null,
    previewMessageType: s.preview_message_type ?? null,
    workflowRunStatus: s.workflow_run_status ?? null,
    waitingApproval: s.waiting_approval ?? false,
    scheduled: s.scheduled ?? false,
    workspace: (s as Row & { workspace?: string | null }).workspace ?? null,
    runStartedAt: s.run_started_at ?? null,
    conversation: s.conversation ?? null,
  }));
}

/** List all installed agents (multi-agent phase 2d; ``GET /api/agents``). */
export async function listAgents(
  token: string,
  base?: string,
): Promise<AgentSummary[]> {
  const effectiveBase = base ?? (await getApiBase());
  const body = await request<{ agents: AgentSummary[] }>(
    `${effectiveBase}/api/agents`,
    token,
  );
  return body.agents;
}

export async function getAgentDetail(
  token: string,
  agentId: string,
  base?: string,
): Promise<AgentDetailPayload> {
  const effectiveBase = base ?? (await getApiBase());
  return request<AgentDetailPayload>(
    `${effectiveBase}/api/agents/${encodeURIComponent(agentId)}`,
    token,
  );
}

export async function listAgentInstructions(
  token: string,
  agentId: string,
  base?: string,
): Promise<AgentInstruction[]> {
  const effectiveBase = base ?? (await getApiBase());
  const body = await request<{ instructions: AgentInstruction[] }>(
    `${effectiveBase}/api/agents/${encodeURIComponent(agentId)}/instructions`,
    token,
  );
  return body.instructions;
}

export async function listAgentInstructionHistory(
  token: string,
  agentId: string,
  key: AgentInstruction["key"],
  base?: string,
): Promise<AgentInstructionHistoryItem[]> {
  const effectiveBase = base ?? (await getApiBase());
  const body = await request<{ history: AgentInstructionHistoryItem[] }>(
    `${effectiveBase}/api/agents/${encodeURIComponent(agentId)}/instructions/${key}/history`,
    token,
  );
  return body.history;
}

export async function listAgentSkills(
  token: string,
  agentId: string,
  base?: string,
): Promise<AgentSkill[]> {
  const effectiveBase = base ?? (await getApiBase());
  const body = await request<{ skills: AgentSkill[] }>(
    `${effectiveBase}/api/agents/${encodeURIComponent(agentId)}/skills`,
    token,
  );
  return body.skills;
}

export async function listAgentChangeProposals(
  token: string,
  agentId: string,
  base?: string,
): Promise<AgentChangeProposal[]> {
  const effectiveBase = base ?? (await getApiBase());
  const body = await request<{ proposals: AgentChangeProposal[] }>(
    `${effectiveBase}/api/agents/${encodeURIComponent(agentId)}/proposals`,
    token,
  );
  return body.proposals;
}

export async function fetchWebuiThread(
  token: string,
  key: string,
  base?: string,
): Promise<WebuiThreadPersistedPayload | null> {
  const effectiveBase = base ?? (await getApiBase());
  const url = `${effectiveBase}/api/sessions/${encodeURIComponent(key)}/webui-thread`;
  const res = await httpFetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new ApiError(res.status, `HTTP ${res.status}`);
  return (await res.json()) as WebuiThreadPersistedPayload;
}

export async function deleteSession(
  token: string,
  key: string,
  base?: string,
): Promise<boolean> {
  const effectiveBase = base ?? (await getApiBase());
  const body = await request<{ deleted: boolean }>(
    `${effectiveBase}/api/sessions/${encodeURIComponent(key)}/delete`,
    token,
  );
  return body.deleted;
}

/** Bind a session to a project working directory.
 *
 *  POSTs to the gateway HTTP server (aiohttp app) because the websocket
 *  HTTP surface cannot reliably read POST bodies. Pass ``null`` to clear
 *  the binding and return the session to the default "会话" section. */
export async function updateSessionWorkspace(
  token: string,
  key: string,
  workspace: string | null,
  base?: string,
): Promise<{ ok: boolean; workspace: string | null }> {
  const effectiveBase = base ?? (await getGatewayHttpBase());
  if (workspace === null) {
    return request<{ ok: boolean; workspace: string | null }>(
      `${effectiveBase}/api/sessions/${encodeURIComponent(key)}/clear-workspace`,
      token,
      { method: "POST" },
    );
  }
  return request<{ ok: boolean; workspace: string | null }>(
    `${effectiveBase}/api/sessions/${encodeURIComponent(key)}/set-workspace`,
    token,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace }),
    },
  );
}

/** List distinct project workspaces bound to any session.
 *
 *  Used by the sidebar to keep project sections visible even after all
 *  their sessions are deleted (so the project folder remains discoverable). */
export async function listProjects(
  token: string,
  base?: string,
): Promise<string[]> {
  const effectiveBase = base ?? (await getGatewayHttpBase());
  const body = await request<{ projects: string[] }>(
    `${effectiveBase}/api/projects`,
    token,
  );
  return body.projects ?? [];
}

/** Remove a project by clearing workspace binding for all its sessions. */
export async function removeProject(
  workspace: string,
  token: string,
  base?: string,
): Promise<{ ok: boolean; cleared: number }> {
  const effectiveBase = base ?? (await getGatewayHttpBase());
  return request<{ ok: boolean; cleared: number }>(
    `${effectiveBase}/api/projects/remove`,
    token,
    {
      method: "POST",
      body: JSON.stringify({ workspace }),
    },
  );
}

export async function fetchSettings(
  token: string,
  base?: string,
): Promise<SettingsPayload> {
  const effectiveBase = base ?? (await getApiBase());
  return request<SettingsPayload>(`${effectiveBase}/api/settings`, token);
}

export async function fetchZenFreeModels(
  token: string,
  base?: string,
): Promise<{ models: string[] }> {
  const effectiveBase = base ?? (await getApiBase());
  return request<{ models: string[] }>(`${effectiveBase}/api/zen/models`, token);
}

export interface ProviderModelsResult {
  models: string[];
  /** Friendly Chinese error message from the backend; empty on success. */
  error?: string;
}

export async function fetchProviderModels(
  token: string,
  params: {
    provider: string;
    apiKey?: string;
    apiBase?: string;
  },
  base?: string,
): Promise<ProviderModelsResult> {
  const effectiveBase = base ?? (await getApiBase());
  const query = new URLSearchParams();
  query.set("provider", params.provider);
  if (params.apiBase !== undefined) query.set("api_base", params.apiBase);
  const headers = params.apiKey === undefined
    ? undefined
    : { "X-Mona-Provider-Key": params.apiKey };
  return request<ProviderModelsResult>(
    `${effectiveBase}/api/settings/provider/models?${query}`,
    token,
    headers ? { headers } : undefined,
  );
}

export async function listSlashCommands(
  token: string,
  base?: string,
): Promise<SlashCommand[]> {
  const effectiveBase = base ?? (await getApiBase());
  type Row = {
    command: string;
    title: string;
    description: string;
    icon: string;
    arg_hint?: string;
  };
  const body = await request<{ commands: Row[] }>(`${effectiveBase}/api/commands`, token);
  return body.commands
    .filter((command) => !["/stop", "/restart"].includes(command.command))
    .map((command) => ({
      command: command.command,
      title: command.title,
      description: command.description,
      icon: command.icon,
      argHint: command.arg_hint ?? "",
    }));
}

export async function fetchSidebarState(
  token: string,
  base?: string,
): Promise<SidebarStatePayload> {
  const effectiveBase = base ?? (await getApiBase());
  return request<SidebarStatePayload>(`${effectiveBase}/api/webui/sidebar-state`, token);
}

export async function updateSidebarState(
  token: string,
  state: SidebarStatePayload,
  base?: string,
): Promise<SidebarStatePayload> {
  const effectiveBase = base ?? (await getGatewayHttpBase());
  return request<SidebarStatePayload>(
    `${effectiveBase}/api/webui/sidebar-state/update`,
    token,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state),
    },
  );
}

export async function updateSettings(
  token: string,
  update: SettingsUpdate,
  base?: string,
): Promise<SettingsPayload> {
  const effectiveBase = base ?? (await getApiBase());
  const query = new URLSearchParams();
  if (update.modelPreset !== undefined) {
    query.set("model_preset", update.modelPreset ?? "default");
  }
  if (update.model !== undefined) query.set("model", update.model);
  if (update.provider !== undefined) query.set("provider", update.provider);
  if (update.providerModel !== undefined) query.set("provider_model", update.providerModel);
  if (update.timezone !== undefined) query.set("timezone", update.timezone);
  if (update.botName !== undefined) query.set("bot_name", update.botName);
  if (update.botIcon !== undefined) query.set("bot_icon", update.botIcon);
  if (update.toolHintMaxLength !== undefined) {
    query.set("tool_hint_max_length", String(update.toolHintMaxLength));
  }
  if (update.workspace !== undefined) query.set("workspace", update.workspace);
  return request<SettingsPayload>(`${effectiveBase}/api/settings/update?${query}`, token);
}

export async function updateProviderSettings(
  token: string,
  update: ProviderSettingsUpdate,
  base?: string,
): Promise<SettingsPayload> {
  const effectiveBase = base ?? (await getApiBase());
  const query = new URLSearchParams();
  query.set("provider", update.provider);
  if (update.customName !== undefined) query.set("custom_name", update.customName);
  if (update.apiBase !== undefined) query.set("api_base", update.apiBase);
  if (update.model !== undefined) query.set("model", update.model);
  if (update.enabledModels !== undefined) {
    query.set("enabled_models", JSON.stringify(update.enabledModels));
  }
  if (update.discoveredModels !== undefined) {
    query.set("discovered_models", JSON.stringify(update.discoveredModels));
  }
  if (update.delete !== undefined) query.set("delete", String(update.delete));
  const headers = update.apiKey === undefined
    ? undefined
    : { "X-Mona-Provider-Key": update.apiKey };
  return request<SettingsPayload>(
    `${effectiveBase}/api/settings/provider/update?${query}`,
    token,
    headers ? { headers } : undefined,
  );
}

export async function updateWebSearchSettings(
  token: string,
  update: WebSearchSettingsUpdate,
  base?: string,
): Promise<SettingsPayload> {
  const effectiveBase = base ?? (await getApiBase());
  const query = new URLSearchParams();
  query.set("provider", update.provider);
  if (update.apiKey !== undefined) query.set("api_key", update.apiKey);
  if (update.baseUrl !== undefined) query.set("base_url", update.baseUrl);
  if (update.maxResults !== undefined) query.set("max_results", String(update.maxResults));
  if (update.timeout !== undefined) query.set("timeout", String(update.timeout));
  if (update.useJinaReader !== undefined) {
    query.set("use_jina_reader", String(update.useJinaReader));
  }
  return request<SettingsPayload>(
    `${effectiveBase}/api/settings/web-search/update?${query}`,
    token,
  );
}

export async function updateImageGenerationSettings(
  token: string,
  update: ImageGenerationSettingsUpdate,
  base?: string,
): Promise<SettingsPayload> {
  const effectiveBase = base ?? (await getApiBase());
  const query = new URLSearchParams();
  query.set("enabled", String(update.enabled));
  query.set("provider", update.provider);
  query.set("model", update.model);
  query.set("default_aspect_ratio", update.defaultAspectRatio);
  query.set("default_image_size", update.defaultImageSize);
  query.set("max_images_per_turn", String(update.maxImagesPerTurn));
  return request<SettingsPayload>(
    `${effectiveBase}/api/settings/image-generation/update?${query}`,
    token,
  );
}

export async function updateVideoGenerationSettings(
  token: string,
  update: VideoGenerationSettingsUpdate,
  base?: string,
): Promise<SettingsPayload> {
  const effectiveBase = base ?? (await getApiBase());
  const query = new URLSearchParams();
  query.set("enabled", String(update.enabled));
  query.set("provider", update.provider);
  query.set("model", update.model);
  query.set("default_aspect_ratio", update.defaultAspectRatio);
  query.set("default_duration", String(update.defaultDuration));
  return request<SettingsPayload>(
    `${effectiveBase}/api/settings/video-generation/update?${query}`,
    token,
  );
}

export async function updateTtsSettings(
  token: string,
  update: TtsSettingsUpdate,
  base?: string,
): Promise<SettingsPayload> {
  const effectiveBase = base ?? (await getApiBase());
  const query = new URLSearchParams();
  if (update.provider !== undefined) query.set("provider", update.provider);
  if (update.voice !== undefined) query.set("voice", update.voice);
  if (update.apiBase !== undefined) query.set("apiBase", update.apiBase);
  if (update.model !== undefined) query.set("model", update.model);
  if (update.apiKey) query.set("apiKey", update.apiKey);
  if (update.clearKey) query.set("clearKey", "true");
  return request<SettingsPayload>(
    `${effectiveBase}/api/settings/tts/update?${query}`,
    token,
  );
}

export async function updateStockSettings(
  token: string,
  update: StockSettingsUpdate,
  base?: string,
): Promise<SettingsPayload> {
  const effectiveBase = base ?? (await getApiBase());
  const query = new URLSearchParams();
  if (update.enabled !== undefined) query.set("enabled", String(update.enabled));
  if (update.autoReviewEnabled !== undefined) {
    query.set("autoReviewEnabled", String(update.autoReviewEnabled));
  }
  if (update.reviewTime !== undefined) query.set("reviewTime", update.reviewTime);
  if (update.reviewScope !== undefined) query.set("reviewScope", update.reviewScope);
  if (update.pushNotification !== undefined) {
    query.set("pushNotification", String(update.pushNotification));
  }
  if (update.pushEmail !== undefined) query.set("pushEmail", String(update.pushEmail));
  if (update.quoteRefreshSec !== undefined) {
    query.set("quoteRefreshSec", String(update.quoteRefreshSec));
  }
  return request<SettingsPayload>(
    `${effectiveBase}/api/settings/stock/update?${query}`,
    token,
  );
}

export async function updateChannelSettings(
  token: string,
  channel: string,
  enabled: boolean,
  allowFrom?: string[],
  base?: string,
  extra?: { botId?: string; appId?: string; secret?: string; appSecret?: string },
): Promise<SettingsPayload> {
  const effectiveBase = base ?? (await getApiBase());
  const query = new URLSearchParams();
  query.set("channel", channel);
  query.set("enabled", String(enabled));
  if (allowFrom) {
    query.set("allowFrom", allowFrom.join(","));
  }
  if (extra?.botId !== undefined) {
    query.set("botId", extra.botId);
  }
  if (extra?.appId !== undefined) {
    query.set("appId", extra.appId);
  }
  if (extra?.secret !== undefined) {
    query.set("secret", extra.secret);
  }
  if (extra?.appSecret !== undefined) {
    query.set("appSecret", extra.appSecret);
  }
  return request<SettingsPayload>(
    `${effectiveBase}/api/settings/channels/update?${query}`,
    token,
  );
}

export async function startWeixinLogin(
  token: string,
  base?: string,
): Promise<WeixinLoginStatus> {
  const effectiveBase = base ?? (await getApiBase());
  return request<WeixinLoginStatus>(
    `${effectiveBase}/api/channels/weixin/login/start`,
    token,
  );
}

export async function getWeixinLoginStatus(
  token: string,
  base?: string,
): Promise<WeixinLoginStatus> {
  const effectiveBase = base ?? (await getApiBase());
  return request<WeixinLoginStatus>(
    `${effectiveBase}/api/channels/weixin/login/status`,
    token,
  );
}

export async function cancelWeixinLogin(
  token: string,
  base?: string,
): Promise<{ state: string }> {
  const effectiveBase = base ?? (await getApiBase());
  return request<{ state: string }>(
    `${effectiveBase}/api/channels/weixin/login/cancel`,
    token,
  );
}

export async function logoutWeixin(
  token: string,
  base?: string,
): Promise<{ logged_in: boolean }> {
  const effectiveBase = base ?? (await getApiBase());
  return request<{ logged_in: boolean }>(
    `${effectiveBase}/api/channels/weixin/logout`,
    token,
  );
}

export async function fetchPptTemplates(
  token: string,
  base?: string,
): Promise<PptTemplatesResponse> {
  const effectiveBase = base ?? (await getApiBase());
  return request<PptTemplatesResponse>(
    `${effectiveBase}/api/ppt/templates`,
    token,
  );
}

export async function fetchPptProjects(
  token: string,
  base?: string,
): Promise<{ projects: PptProject[] }> {
  const effectiveBase = base ?? (await getApiBase());
  return request(`${effectiveBase}/api/ppt/projects`, token);
}

export interface PptSlide {
  name: string;
  url: string;
  type?: "svg" | "image";
}

export async function fetchPptProjectSlides(
  token: string,
  project: string,
  base?: string,
): Promise<{ slides: PptSlide[] }> {
  const effectiveBase = base ?? (await getApiBase());
  const query = new URLSearchParams();
  query.set("project", project);
  return request(`${effectiveBase}/api/ppt/project-slides?${query}`, token);
}

export async function fetchPptPreviewPort(
  token: string,
  project: string,
  base?: string,
): Promise<{ port: number | null }> {
  const effectiveBase = base ?? (await getApiBase());
  const query = new URLSearchParams();
  query.set("project", project);
  return request(`${effectiveBase}/api/ppt/preview-port?${query}`, token);
}

export interface PptExportStatus {
  status: "not_found" | "init" | "planning" | "generating" | "done";
  phase?: "config" | "generating" | "outline" | "producing" | "exporting" | "done";
  slideCount: number;
  hasExport: boolean;
  hasSvgOutput: boolean;
  hasPptxOutput: boolean;
  hasSpecLock: boolean;
  exportFile: string | null;
  pipelineStage: string;
  svgOutputCount: number;
  svgFinalCount: number;
}

export async function fetchPptExportStatus(
  token: string,
  project: string,
  base?: string,
): Promise<PptExportStatus> {
  const effectiveBase = base ?? (await getApiBase());
  const query = new URLSearchParams();
  query.set("project", project);
  return request<PptExportStatus>(
    `${effectiveBase}/api/ppt/export-status?${query}`,
    token,
  );
}

export interface PptVisualPlanPage {
  page: string;
  file: string;
  title: string;
  visual_type: string;
  chart_template: string | null;
  layout_template: string | null;
  has_ai_image: boolean;
  notes: string;
}

export async function fetchPptVisualPlan(
  token: string,
  project: string,
  base?: string,
): Promise<{ pages: PptVisualPlanPage[] }> {
  const effectiveBase = base ?? (await getApiBase());
  const query = new URLSearchParams();
  query.set("project", project);
  return request(`${effectiveBase}/api/ppt/visual-plan?${query}`, token);
}

export async function markPptGenerating(
  token: string,
  project: string,
  action: "start" | "finish",
  base?: string,
): Promise<{ ok: boolean }> {
  const effectiveBase = base ?? (await getApiBase());
  const query = new URLSearchParams();
  query.set("project", project);
  query.set("action", action);
  return request<{ ok: boolean }>(
    `${effectiveBase}/api/ppt/mark-generating?${query}`,
    token,
  );
}

export interface PptSourceFile {
  name: string;
  path: string;
}

export async function pptAddSources(
  token: string,
  sources: string[],
  base?: string,
): Promise<{ files: PptSourceFile[] }> {
  const effectiveBase = base ?? (await getApiBase());
  const query = new URLSearchParams();
  query.set("sources", sources.join("|"));
  return request(`${effectiveBase}/api/ppt/add-sources?${query}`, token);
}

export interface PptOfficeCliStatus {
  ok: boolean;
  version: string | null;
  path: string | null;
  error: string | null;
  supported: boolean;
}

export async function fetchPptOfficeCliCheck(
  token: string,
  base?: string,
): Promise<PptOfficeCliStatus> {
  const effectiveBase = base ?? (await getApiBase());
  return request<PptOfficeCliStatus>(
    `${effectiveBase}/api/ppt/officecli-check`,
    token,
  );
}

export async function downloadPptOfficeCli(
  token: string,
  base?: string,
): Promise<{ ok: boolean; path?: string; cached?: boolean; error?: string }> {
  const effectiveBase = base ?? (await getApiBase());
  return request(`${effectiveBase}/api/ppt/officecli-download`, token);
}

// --- PPT V2 outline APIs (services port) ---

export interface PptOutlinePage {
  page: string;
  file: string;
  title: string;
  bullets: string[];
  visual_type: string;
  chart_template: string | null;
  layout_template: string;
  has_ai_image: boolean;
  layout: string;
  notes: string;
  summary: string;
  image_plan: string;
}

export interface PptOutlineResponse {
  ok: boolean;
  pages: PptOutlinePage[];
  revision: number;
  schemaVersion: number;
  locked: boolean;
}

export async function fetchPptOutline(
  token: string,
  name: string,
  base?: string,
): Promise<PptOutlineResponse> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  const query = new URLSearchParams();
  query.set("name", name);
  return request<PptOutlineResponse>(
    `${effectiveBase}/api/ppt/project/outline?${query}`,
    token,
  );
}

export async function savePptOutline(
  token: string,
  name: string,
  expectedRevision: number,
  pages: PptOutlinePage[],
  base?: string,
): Promise<{ ok: boolean; revision: number; pages: PptOutlinePage[] }> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  return request<{ ok: boolean; revision: number; pages: PptOutlinePage[] }>(
    `${effectiveBase}/api/ppt/project/outline`,
    token,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, expectedRevision, pages }),
    },
  );
}

export async function lockPptOutline(
  token: string,
  name: string,
  base?: string,
): Promise<{ ok: boolean; revision: number }> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  return request<{ ok: boolean; revision: number }>(
    `${effectiveBase}/api/ppt/project/lock-outline`,
    token,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    },
  );
}

// --- PPT design spec summary (eight confirmations AI recommendation) ---

export interface PptDesignSpecSummary {
  schemaVersion?: number;
  canvasFormat?: string;
  pageCount?: number | null;
  audience?: string;
  styleMode?: string | null;
  styleDescriptor?: string;
  primaryColor?: string;
  colorScheme?: string;
  iconApproach?: string | null;
  iconLibrary?: string | null;
  typographyPlan?: string;
  titleFont?: string;
  bodyFont?: string;
  formulaPolicy?: string | null;
  imageApproach?: string | null;
  imageRendering?: string | null;
  imagePalette?: string | null;
  updatedAt?: string;
}

export interface PptDesignSpecSummaryResponse {
  ok: boolean;
  summary: PptDesignSpecSummary | null;
  error?: string;
}

export async function fetchPptDesignSpecSummary(
  token: string,
  name: string,
  base?: string,
): Promise<PptDesignSpecSummaryResponse> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  const query = new URLSearchParams();
  query.set("name", name);
  return request<PptDesignSpecSummaryResponse>(
    `${effectiveBase}/api/ppt/project/design-spec-summary?${query}`,
    token,
  );
}

export async function updatePptDesignSpecSummary(
  token: string,
  name: string,
  patch: Partial<PptDesignSpecSummary>,
  base?: string,
): Promise<PptDesignSpecSummaryResponse> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  const query = new URLSearchParams();
  query.set("name", name);
  return request<PptDesignSpecSummaryResponse>(
    `${effectiveBase}/api/ppt/project/design-spec-summary?${query}`,
    token,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    },
  );
}

// --- PPT V3 per-page APIs (services port) ---

export type PptPageState = "pending" | "previewing" | "confirmed";

export interface PptPageInfo {
  page: string;
  file: string;
  title: string;
  mtime: number | null;
  state: PptPageState;
}

export interface PptPagesResponse {
  ok: boolean;
  pages: PptPageInfo[];
  outlineRevision: number;
  confirmedCount: number;
  totalCount: number;
  currentPageIndex: number;
}

export async function fetchPptPages(
  token: string,
  name: string,
  base?: string,
): Promise<PptPagesResponse> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  const query = new URLSearchParams();
  query.set("name", name);
  return request<PptPagesResponse>(
    `${effectiveBase}/api/ppt/project/pages?${query}`,
    token,
  );
}

export async function confirmPptPage(
  token: string,
  name: string,
  file: string,
  expectedMtime: number,
  base?: string,
): Promise<{ ok: boolean; file: string; mtime: number; confirmedAt: string }> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  return request<{ ok: boolean; file: string; mtime: number; confirmedAt: string }>(
    `${effectiveBase}/api/ppt/project/page/confirm`,
    token,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, file, expectedMtime }),
    },
  );
}

export async function requestPptExport(
  token: string,
  name: string,
  base?: string,
): Promise<{ ok: boolean; exportRequestedAt: string }> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  return request<{ ok: boolean; exportRequestedAt: string }>(
    `${effectiveBase}/api/ppt/project/request-export`,
    token,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    },
  );
}

export async function savePptChatId(
  token: string,
  project: string,
  chatId: string,
  base?: string,
): Promise<{ ok: boolean }> {
  const effectiveBase = base ?? (await getApiBase());
  const query = new URLSearchParams();
  query.set("project", project);
  query.set("chatId", chatId);
  return request(`${effectiveBase}/api/ppt/save-chat-id?${query}`, token);
}

export async function deletePptProject(
  token: string,
  project: string,
  base?: string,
): Promise<{ ok: boolean }> {
  const effectiveBase = base ?? (await getApiBase());
  const query = new URLSearchParams();
  query.set("project", project);
  return request(`${effectiveBase}/api/ppt/delete-project?${query}`, token);
}

export async function fetchPptUrl(
  token: string,
  url: string,
  project?: string,
  base?: string,
): Promise<{ ok: boolean; file?: string; output?: string; error?: string }> {
  const effectiveBase = base ?? (await getApiBase());
  const query = new URLSearchParams();
  query.set("url", url);
  if (project) query.set("project", project);
  return request(`${effectiveBase}/api/ppt/fetch-url?${query}`, token);
}

export async function generatePptPreview(
  token: string,
  project: string,
  base?: string,
): Promise<{ ok: boolean; slideCount?: number; error?: string }> {
  const effectiveBase = base ?? (await getApiBase());
  const query = new URLSearchParams();
  query.set("project", project);
  return request(`${effectiveBase}/api/ppt/generate-preview?${query}`, token);
}

// ---------------------------------------------------------------------------
// Video APIs
// ---------------------------------------------------------------------------

export interface VideoRuntimeItem {
  ok: boolean;
  version?: string;
  path?: string;
}

export interface VideoRuntimeStatus {
  node: VideoRuntimeItem;
  ffmpeg: VideoRuntimeItem;
  chrome: VideoRuntimeItem;
}

export type VideoProjectPhase =
  | "storyboard"
  | "producing"
  | "exportable"
  | "rendering"
  | "done";

export interface VideoProject {
  name: string;
  createdAt: number;
  resolution: string;
  phase: VideoProjectPhase;
  hasVideo: boolean;
  outputStale: boolean;
  hasStoryboard?: boolean;
  hasIndex?: boolean;
  sceneCount?: number;
  chatId: string | null;
}

export async function fetchVideoRuntimeCheck(
  token: string,
  base?: string,
): Promise<VideoRuntimeStatus> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  return request<VideoRuntimeStatus>(
    `${effectiveBase}/api/video/runtime-check`,
    token,
  );
}

export async function downloadVideoRuntime(
  token: string,
  component: string,
  base?: string,
): Promise<{ ok: boolean; error?: string }> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  return request<{ ok: boolean; error?: string }>(
    `${effectiveBase}/api/video/runtime-download`,
    token,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ component }),
    },
  );
}

export interface OfficeHealthStatus {
  ok: boolean;
  version: string | null;
  path: string | null;
  error?: string;
  supported: boolean;
}

export async function fetchOfficeHealth(
  token: string,
  base?: string,
): Promise<OfficeHealthStatus> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  return request<OfficeHealthStatus>(
    `${effectiveBase}/api/office/health`,
    token,
  );
}

export async function downloadOfficeRuntime(
  token: string,
  base?: string,
): Promise<{ ok: boolean; error?: string }> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  return request<{ ok: boolean; error?: string }>(
    `${effectiveBase}/api/office/runtime-download`,
    token,
    { method: "POST" },
  );
}

export interface Url2NoteSource {
  title: string;
  url: string;
  kind: "article" | "video";
  text: string;
}

export async function extractUrl2Note(
  token: string,
  url: string,
  base?: string,
): Promise<Url2NoteSource> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  return request<Url2NoteSource>(
    `${effectiveBase}/api/url2note/extract`,
    token,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    },
  );
}

export async function generateNote(
  token: string,
  prompt: string,
  base?: string,
): Promise<string> {
  const effectiveBase = base ?? (await getGatewayHttpBase());
  const result = await request<{ content: string }>(
    `${effectiveBase}/api/notes/generate`,
    token,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    },
  );
  return result.content;
}

export interface Doc2NoteStatus {
  supportedExtensions: string[];
  pandoc: {
    ok: boolean;
    version: string | null;
    path: string | null;
    error?: string | null;
  };
  pandocDownloadMb: number;
}

export async function fetchDoc2NoteStatus(
  token: string,
  base?: string,
): Promise<Doc2NoteStatus> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  return request<Doc2NoteStatus>(`${effectiveBase}/api/doc2note/status`, token);
}

export async function downloadDoc2NoteRuntime(
  token: string,
  base?: string,
): Promise<{ ok: boolean; error?: string }> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  return request<{ ok: boolean; error?: string }>(
    `${effectiveBase}/api/doc2note/runtime-download`,
    token,
    { method: "POST" },
  );
}

export interface Doc2NoteSource {
  title: string;
  kind: string;
  text: string;
}

export async function extractDoc2Note(
  token: string,
  filePath: string,
  base?: string,
): Promise<Doc2NoteSource> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  // 直接用 httpFetch 以透出服务端的友好错误文案（request() 只给 HTTP 状态码）
  const res = await httpFetch(`${effectiveBase}/api/doc2note/extract`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ file_path: filePath }),
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const payload = (await res.json()) as { error?: string };
      if (payload.error) message = payload.error;
    } catch {
      // 保留默认 HTTP 状态码错误
    }
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as Doc2NoteSource;
}

export async function fetchVideoProjects(
  token: string,
  base?: string,
): Promise<{ projects: VideoProject[] }> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  return request(`${effectiveBase}/api/video/projects`, token);
}

export interface VideoTtsConfig {
  narrationEnabled?: boolean;
  ttsProvider?: string;
  ttsVoice?: string;
  ttsRate?: string;
}

export async function createVideoProject(
  token: string,
  name: string,
  resolution: string,
  tts?: VideoTtsConfig,
  base?: string,
): Promise<{ ok: boolean; error?: string }> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  return request<{ ok: boolean; error?: string }>(
    `${effectiveBase}/api/video/project/create`,
    token,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, resolution, ...(tts ?? {}) }),
    },
  );
}

export async function fetchVideoProject(
  token: string,
  name: string,
  base?: string,
): Promise<VideoProject & { previewPort?: number | null; videoUrl?: string | null }> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  const query = new URLSearchParams();
  query.set("name", name);
  return request(`${effectiveBase}/api/video/project?${query}`, token);
}

export async function fetchVideoProjectFile(
  token: string,
  name: string,
  path: string,
  base?: string,
): Promise<{ ok: boolean; content?: string; error?: string }> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  const query = new URLSearchParams();
  query.set("name", name);
  query.set("path", path);
  return request(`${effectiveBase}/api/video/project-file?${query}`, token);
}

export async function deleteVideoProject(
  token: string,
  name: string,
  base?: string,
): Promise<{ ok: boolean }> {
  const effectiveBase = base ?? (await getApiBase());
  const query = new URLSearchParams();
  query.set("name", name);
  return request(`${effectiveBase}/api/video/delete-project?${query}`, token);
}

export function buildVideoDownloadUrl(
  base: string,
  token: string,
  name: string,
): string {
  const query = new URLSearchParams();
  query.set("name", name);
  query.set("token", token);
  return `${base}/api/video/download?${query}`;
}

export async function saveVideoChatId(
  token: string,
  name: string,
  chatId: string,
  base?: string,
): Promise<{ ok: boolean }> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  return request<{ ok: boolean }>(
    `${effectiveBase}/api/video/project-save-chat-id`,
    token,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, chatId }),
    },
  );
}

// ---------------------------------------------------------------------------
// Video export
// ---------------------------------------------------------------------------

export interface VideoExportStatus {
  stage: "idle" | "rendering" | "done" | "error";
  progress: number;
  message?: string;
  output?: string;
  duration?: number;
  fps?: number;
  resolution?: [number, number];
  totalFrames?: number;
  audio?: boolean;
  hasVideo?: boolean;
  needDownload?: boolean;
  startedAt?: string;
  finishedAt?: string;
}

export async function exportVideoProject(
  token: string,
  name: string,
  opts?: { quality?: "draft" | "standard" | "high" },
  base?: string,
): Promise<{ ok: boolean; stage?: string; message?: string; error?: string }> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  return request(
    `${effectiveBase}/api/video/project/export`,
    token,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, ...(opts ?? {}) }),
    },
  );
}

export async function fetchVideoExportStatus(
  token: string,
  name: string,
  base?: string,
): Promise<VideoExportStatus> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  const query = new URLSearchParams();
  query.set("name", name);
  return request(`${effectiveBase}/api/video/project/export-status?${query}`, token);
}

export function buildVideoPreviewFullUrl(base: string, token: string, name: string): string {
  const query = new URLSearchParams();
  query.set("name", name);
  query.set("token", token);
  return `${base}/api/video/project/preview-full?${query}`;
}

// ---------------------------------------------------------------------------
// Video storyboard scene CRUD
// ---------------------------------------------------------------------------

export interface VideoScene {
  index: number;
  title: string;
  duration: number;
  durationRaw: string;
  visual: string;
  animation: string;
  narration: string;
  assets: string[];
}

export async function fetchVideoStoryboard(
  token: string,
  name: string,
  base?: string,
): Promise<{
  ok: boolean;
  scenes?: VideoScene[];
  source?: string;
  error?: string;
  storyboardExists?: boolean;
  parseError?: string | null;
}> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  const query = new URLSearchParams();
  query.set("name", name);
  return request(`${effectiveBase}/api/video/project/storyboard?${query}`, token);
}

export async function updateVideoScene(
  token: string,
  name: string,
  scene: Partial<VideoScene> & { index: number },
  base?: string,
): Promise<{ ok: boolean; scene?: VideoScene; error?: string }> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  return request(`${effectiveBase}/api/video/project/scene`, token, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, ...scene }),
  });
}

export async function deleteVideoScene(
  token: string,
  name: string,
  index: number,
  base?: string,
): Promise<{ ok: boolean; scenes?: VideoScene[]; error?: string }> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  const query = new URLSearchParams();
  query.set("name", name);
  query.set("index", String(index));
  return request(`${effectiveBase}/api/video/project/scene?${query}`, token, {
    method: "DELETE",
  });
}

export async function addVideoScene(
  token: string,
  name: string,
  scene?: Partial<VideoScene>,
  base?: string,
): Promise<{ ok: boolean; scene?: VideoScene; error?: string }> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  return request(`${effectiveBase}/api/video/project/scene/add`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, ...(scene ?? {}) }),
  });
}

export async function reorderVideoScenes(
  token: string,
  name: string,
  indices: number[],
  base?: string,
): Promise<{ ok: boolean; scenes?: VideoScene[]; error?: string }> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  return request(`${effectiveBase}/api/video/project/scene/reorder`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, indices }),
  });
}

export async function lockVideoStoryboard(
  token: string,
  name: string,
  base?: string,
): Promise<{ ok: boolean; phase?: string; error?: string }> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  return request(`${effectiveBase}/api/video/project/lock-storyboard`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
}

export async function fetchSceneNarrationBytes(
  token: string,
  name: string,
  index: number,
  base?: string,
): Promise<Blob | null> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  const res = await fetch(`${effectiveBase}/api/video/project/scene/narration`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ name, index }),
  });
  if (!res.ok) return null;
  return res.blob();
}

// ---------------------------------------------------------------------------
// Video scene HTML generation / preview / state machine (P2)
// ---------------------------------------------------------------------------

export type SceneHtmlStatus = "pending" | "generating" | "previewing" | "confirmed";

export interface VideoSceneWithHtml extends VideoScene {
  htmlStatus?: SceneHtmlStatus;
  htmlPath?: string;
  htmlMtime?: number;
  confirmedAt?: string;
  confirmedMtime?: number;
}

export async function generateSceneHtml(
  token: string,
  name: string,
  index: number,
  base?: string,
): Promise<{ ok: boolean; scene?: VideoSceneWithHtml; htmlPath?: string; error?: string }> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  return request(`${effectiveBase}/api/video/ai/scene-html`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, index }),
  });
}

export function buildScenePreviewUrl(
  base: string,
  token: string,
  name: string,
  index: number,
): string {
  const query = new URLSearchParams();
  query.set("name", name);
  query.set("index", String(index));
  query.set("token", token);
  return `${base}/api/video/project/scene/preview?${query}`;
}

export async function fetchScenePreviewHtml(
  token: string,
  name: string,
  index: number,
  base?: string,
): Promise<{ html: string | null; needsGeneration: boolean }> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  const query = new URLSearchParams();
  query.set("name", name);
  query.set("index", String(index));
  const res = await fetch(`${effectiveBase}/api/video/project/scene/preview?${query}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 404) {
    return { html: null, needsGeneration: true };
  }
  if (!res.ok) return { html: null, needsGeneration: false };
  const html = await res.text();
  return { html, needsGeneration: false };
}

export async function confirmVideoScene(
  token: string,
  name: string,
  index: number,
  expectedMtime?: number,
  base?: string,
): Promise<{ ok: boolean; scene?: VideoSceneWithHtml; allConfirmed?: boolean; phase?: string; error?: string }> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  return request(`${effectiveBase}/api/video/project/scene/confirm`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, index, ...(expectedMtime !== undefined ? { expectedMtime } : {}) }),
  });
}

// ---------------------------------------------------------------------------
// Skill lifecycle (settings panel)
// ---------------------------------------------------------------------------

export interface SkillUsageRow {
  name: string;
  created_by: string | null;
  created_at: string | null;
  access_count: number;
  last_accessed_at: string | null;
  pinned: boolean;
  archived_at: string | null;
  provenance: "agent" | "bundled" | "unknown";
  location: "active" | "archived";
}

export interface SkillLifecycleConfig {
  skillPruneEnabled: boolean;
  archiveAfterDays: number;
  maxActiveUserSkills: number;
  activeCount: number;
  archivedCount: number;
}

export async function listSkills(
  token: string,
  base?: string,
): Promise<{ skills: SkillUsageRow[] }> {
  const effectiveBase = base ?? (await getGatewayHttpBase());
  return request(`${effectiveBase}/api/skills/list`, token);
}

export async function setSkillPinned(
  token: string,
  name: string,
  pinned: boolean,
  base?: string,
): Promise<{ ok: boolean; name: string; pinned: boolean }> {
  const effectiveBase = base ?? (await getGatewayHttpBase());
  return request(`${effectiveBase}/api/skills/set_pinned`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, pinned }),
  });
}

export async function archiveSkill(
  token: string,
  name: string,
  base?: string,
): Promise<{ ok: boolean; name: string; message: string }> {
  const effectiveBase = base ?? (await getGatewayHttpBase());
  return request(`${effectiveBase}/api/skills/archive`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
}

export async function restoreSkill(
  token: string,
  name: string,
  base?: string,
): Promise<{ ok: boolean; name: string; message: string }> {
  const effectiveBase = base ?? (await getGatewayHttpBase());
  return request(`${effectiveBase}/api/skills/restore`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
}

export async function pruneSkills(
  token: string,
  opts: { apply?: boolean; days?: number },
  base?: string,
): Promise<{
  candidates: string[];
  archived: { name: string; ok: boolean; message: string }[];
  applied: boolean;
  days: number;
}> {
  const effectiveBase = base ?? (await getGatewayHttpBase());
  return request(`${effectiveBase}/api/skills/prune`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apply: opts.apply ?? false,
      ...(opts.days !== undefined ? { days: opts.days } : {}),
    }),
  });
}

export async function getSkillLifecycleConfig(
  token: string,
  base?: string,
): Promise<SkillLifecycleConfig> {
  const effectiveBase = base ?? (await getGatewayHttpBase());
  return request(`${effectiveBase}/api/skills/config`, token);
}

export async function updateSkillLifecycleConfig(
  token: string,
  update: Partial<{
    skillPruneEnabled: boolean;
    archiveAfterDays: number;
    maxActiveUserSkills: number;
  }>,
  base?: string,
): Promise<{ ok: boolean }> {
  const effectiveBase = base ?? (await getGatewayHttpBase());
  return request(`${effectiveBase}/api/skills/update_config`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(update),
  });
}

// ---------------------------------------------------------------------------
// MCP server lifecycle (settings panel)
// ---------------------------------------------------------------------------

export type McpTransport = "stdio" | "sse" | "streamableHttp" | "unknown";

export interface McpServerConfig {
  type: McpTransport | null;
  command: string;
  args: string[];
  env: Record<string, string>;
  url: string;
  headers: Record<string, string>;
  toolTimeout: number;
  enabledTools: string[];
}

export interface McpServerStatus {
  name: string;
  connected: boolean;
  transport: McpTransport;
  toolCount: number;
  toolTimeout: number;
  enabledTools: string[];
  config?: McpServerConfig;
}

export interface McpToolInfo {
  name: string;
  description: string;
  kind: "tool" | "resource" | "prompt";
}

export async function listMcpServers(
  token: string,
  base?: string,
): Promise<{ servers: McpServerStatus[] }> {
  const effectiveBase = base ?? (await getGatewayHttpBase());
  return request(`${effectiveBase}/api/mcp/servers`, token);
}

export async function listMcpServerTools(
  token: string,
  name: string,
  base?: string,
): Promise<{ name: string; tools: McpToolInfo[] }> {
  const effectiveBase = base ?? (await getGatewayHttpBase());
  return request(
    `${effectiveBase}/api/mcp/servers/${encodeURIComponent(name)}/tools`,
    token,
  );
}

export async function createMcpServer(
  token: string,
  name: string,
  config: Partial<McpServerConfig>,
  base?: string,
): Promise<{ ok: boolean; name: string; connected?: boolean; toolCount?: number; error?: string }> {
  const effectiveBase = base ?? (await getGatewayHttpBase());
  return request(`${effectiveBase}/api/mcp/servers`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, ...config }),
  });
}

export async function updateMcpServer(
  token: string,
  name: string,
  config: Partial<McpServerConfig>,
  base?: string,
): Promise<{ ok: boolean; name: string; connected?: boolean; toolCount?: number; error?: string }> {
  const effectiveBase = base ?? (await getGatewayHttpBase());
  return request(
    `${effectiveBase}/api/mcp/servers/${encodeURIComponent(name)}`,
    token,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    },
  );
}

export async function deleteMcpServer(
  token: string,
  name: string,
  base?: string,
): Promise<{ ok: boolean; name: string; error?: string }> {
  const effectiveBase = base ?? (await getGatewayHttpBase());
  return request(
    `${effectiveBase}/api/mcp/servers/${encodeURIComponent(name)}`,
    token,
    { method: "DELETE" },
  );
}

export async function restartMcpServer(
  token: string,
  name: string,
  base?: string,
): Promise<{ ok: boolean; name: string; connected?: boolean; toolCount?: number; error?: string }> {
  const effectiveBase = base ?? (await getGatewayHttpBase());
  return request(
    `${effectiveBase}/api/mcp/servers/${encodeURIComponent(name)}/restart`,
    token,
    { method: "POST" },
  );
}

export async function reloadMcpServers(
  token: string,
  base?: string,
): Promise<{ ok: boolean; connectedCount?: number; totalConfigured?: number; error?: string }> {
  const effectiveBase = base ?? (await getGatewayHttpBase());
  return request(`${effectiveBase}/api/mcp/reload`, token, { method: "POST" });
}

export async function regenerateVideoScene(
  token: string,
  name: string,
  index: number,
  base?: string,
): Promise<{ ok: boolean; scene?: VideoSceneWithHtml; error?: string }> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  return request(`${effectiveBase}/api/video/project/scene/regenerate`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, index }),
  });
}

export async function rewriteVideoScene(
  token: string,
  name: string,
  index: number,
  requirement: string,
  base?: string,
): Promise<{ ok: boolean; scene?: VideoSceneWithHtml; error?: string }> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  return request(`${effectiveBase}/api/video/ai/scene-rewrite`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, index, requirement }),
  });
}

// ---------------------------------------------------------------------------
// Shared output artifacts & authenticated file preview
// ---------------------------------------------------------------------------

export interface ArtifactListResponse {
  files: DeliveredFile[];
  session_files?: DeliveredFile[];
  truncated: boolean;
}

/** List an Agent workspace plus explicit session references, or one room's
 *  flat explicit-reference projection when ``room`` is given. The directory
 *  root is fixed by the server; clients cannot pass an arbitrary root. */
export async function listArtifacts(
  token: string,
  base?: string,
  room?: string,
  sessionKey?: string,
): Promise<ArtifactListResponse> {
  const effectiveBase = base ?? (await getApiBase());
  const params = new URLSearchParams();
  if (room) params.set("room", room);
  if (sessionKey) params.set("session_key", sessionKey);
  const query = params.toString() ? `?${params}` : "";
  return request<ArtifactListResponse>(
    `${effectiveBase}/api/artifacts${query}`,
    token,
  );
}

/** List all files of a project session's bound workspace directory.
 *
 *  The root is resolved server-side from the session's ``metadata.workspace``;
 *  clients cannot pass an arbitrary root. Machine-generated directories
 *  (``node_modules``, ``dist`` …) are skipped by the server. */
export async function listProjectFiles(
  token: string,
  sessionKey: string,
  base?: string,
): Promise<ArtifactListResponse> {
  const effectiveBase = base ?? (await getApiBase());
  const query = new URLSearchParams({ key: sessionKey });
  return request<ArtifactListResponse>(
    `${effectiveBase}/api/project-files?${query.toString()}`,
    token,
  );
}

export interface FilePreviewParams {
  /** ``shared`` resolves against the active Agent output; ``project``
   *  resolves against the session's bound workspace directory; ``room``
   *  resolves through the room's explicit ArtifactRef owner. */
  scope: "shared" | "project" | "room";
  /** Relative path under the scope root. Must not be empty, absolute,
   *  or contain ``..``. */
  path: string;
  /** Session key that identifies the active Agent/project owner. */
  sessionKey?: string | null;
  /** Required when ``scope === "room"``: the room id. */
  room?: string | null;
  /** Structured owner reference id when the row came from an explicit
   *  session/room delivery. */
  artifactId?: string | null;
}

/** Fetch a file preview as a Blob using an authenticated request.
 *
 *  Returns the Blob and the resolved MIME type so callers can build a
 *  typed object URL or render HTML source as ``text/plain``. The server
 *  already forces ``text/plain`` for ``.html``/``.htm`` to prevent
 *  execution; callers should still render the result inside a sandboxed
 *  surface to be safe. */
export async function fetchFilePreviewBlob(
  token: string,
  params: FilePreviewParams,
  base?: string,
): Promise<{ blob: Blob; mime: string }> {
  const effectiveBase = base ?? (await getApiBase());
  const query = new URLSearchParams();
  query.set("scope", params.scope);
  query.set("path", params.path);
  if (params.sessionKey) query.set("session_key", params.sessionKey);
  if (params.room) query.set("room", params.room);
  if (params.artifactId) query.set("artifact_id", params.artifactId);
  const url = `${effectiveBase}/api/file-preview?${query.toString()}`;
  const res = await httpFetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new ApiError(res.status, `HTTP ${res.status}`);
  }
  const blob = await res.blob();
  const mime = res.headers.get("content-type") ?? "application/octet-stream";
  return { blob, mime };
}


