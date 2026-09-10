import type {
  AgentChangeProposal,
  AgentDetailPayload,
  AgentInstruction,
  AgentInstructionHistoryItem,
  AgentSkill,
  AgentSkillDetail,
  AgentSummary,
  AutomationStatus,
  ComputerUseStatus,
  ExpertCatalogPayload,
  ExpertInstallJob,
  ManagedRuntimeInstallJob,
  ManagedRuntimeStatusPayload,
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
import {
  isTauri,
  getGatewayStatus,
  getServicesStatus,
  httpFetch,
} from "./tauri";

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
    if (status.port && status.ws_port) {
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
    if (!status.running || !status.port) {
      try {
        const { startGateway } = await import("./tauri");
        await startGateway();
        status = await getGatewayStatus();
      } catch {
        return "";
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
    if (!status.running || !status.port) {
      try {
        const { startServices } = await import("./tauri");
        await startServices();
        status = await getServicesStatus();
      } catch {
        return "";
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
      const contentType = res.headers.get("content-type") ?? "";
      if (contentType.includes("text/plain")) {
        const body = (await res.text()).trim();
        if (body) message = body;
      } else {
        const payload = (await res.json()) as {
          error?: string | { message?: string };
        };
        const error = payload.error;
        message = typeof error === "string" ? error : (error?.message ?? message);
      }
    } catch {
      // Keep the HTTP fallback when the response body cannot be read.
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

export async function fetchExpertCatalog(
  token: string,
  base?: string,
): Promise<ExpertCatalogPayload> {
  const effectiveBase = base ?? (await getApiBase());
  return request<ExpertCatalogPayload>(
    `${effectiveBase}/api/experts/catalog`,
    token,
  );
}

export async function startExpertInstall(
  token: string,
  expertId: string,
  version?: string,
  base?: string,
): Promise<{ ok: true; job: ExpertInstallJob }> {
  const effectiveBase = base ?? (await getApiBase());
  const query = new URLSearchParams({ expert_id: expertId });
  if (version) query.set("version", version);
  return request(`${effectiveBase}/api/experts/install/start?${query}`, token);
}

export async function fetchExpertInstallJob(
  token: string,
  jobId: string,
  base?: string,
): Promise<{ job: ExpertInstallJob }> {
  const effectiveBase = base ?? (await getApiBase());
  const query = new URLSearchParams({ job_id: jobId });
  return request(`${effectiveBase}/api/experts/install/status?${query}`, token);
}

export async function cancelExpertInstall(
  token: string,
  jobId: string,
  base?: string,
): Promise<{ ok: true; job: ExpertInstallJob }> {
  const effectiveBase = base ?? (await getApiBase());
  const query = new URLSearchParams({ job_id: jobId });
  return request(`${effectiveBase}/api/experts/install/cancel?${query}`, token);
}

export async function fetchManagedRuntimeStatus(
  token: string,
  base?: string,
): Promise<ManagedRuntimeStatusPayload> {
  const effectiveBase = base ?? (await getApiBase());
  return request(`${effectiveBase}/api/runtimes/status`, token);
}

export async function startManagedRuntimeInstall(
  token: string,
  component: string,
  repair = false,
  base?: string,
): Promise<{ ok: true; job: ManagedRuntimeInstallJob }> {
  const effectiveBase = base ?? (await getApiBase());
  const query = new URLSearchParams({ component, repair: String(repair) });
  return request(`${effectiveBase}/api/runtimes/install/start?${query}`, token);
}

export async function fetchManagedRuntimeInstallJob(
  token: string,
  jobId: string,
  base?: string,
): Promise<{ job: ManagedRuntimeInstallJob }> {
  const effectiveBase = base ?? (await getApiBase());
  const query = new URLSearchParams({ job_id: jobId });
  return request(`${effectiveBase}/api/runtimes/install/status?${query}`, token);
}

export async function cancelManagedRuntimeInstall(
  token: string,
  jobId: string,
  base?: string,
): Promise<{ ok: true; job: ManagedRuntimeInstallJob }> {
  const effectiveBase = base ?? (await getApiBase());
  const query = new URLSearchParams({ job_id: jobId });
  return request(`${effectiveBase}/api/runtimes/install/cancel?${query}`, token);
}

export async function updateManagedRuntimeSettings(
  token: string,
  autoDownload: boolean,
  base?: string,
): Promise<{ ok: true; autoDownload: boolean }> {
  const effectiveBase = base ?? (await getApiBase());
  const query = new URLSearchParams({ auto_download: String(autoDownload) });
  return request(`${effectiveBase}/api/runtimes/settings/update?${query}`, token);
}

export async function cleanupManagedRuntimes(
  token: string,
  base?: string,
): Promise<{
  ok: true;
  removedDownloads: number;
  removedVersions: number;
  freedBytes: number;
  removedLegacyBytes: number;
}> {
  const effectiveBase = base ?? (await getApiBase());
  return request(`${effectiveBase}/api/runtimes/cleanup`, token);
}

export async function fetchAutomationStatus(
  token: string,
  base?: string,
): Promise<AutomationStatus> {
  const effectiveBase = base ?? (await getGatewayHttpBase());
  return request(`${effectiveBase}/api/automation/status`, token);
}

export async function updateBrowserAutomation(
  token: string,
  enabled: boolean,
  base?: string,
): Promise<{ browserAutomationEnabled: boolean }> {
  const effectiveBase = base ?? (await getGatewayHttpBase());
  return request(`${effectiveBase}/api/automation/browser`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
}

export async function updateComputerUse(
  token: string,
  enabled: boolean,
  base?: string,
): Promise<ComputerUseStatus> {
  const effectiveBase = base ?? (await getGatewayHttpBase());
  return request(`${effectiveBase}/api/automation/computer`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
}

export async function cancelComputerUse(
  token: string,
  base?: string,
): Promise<ComputerUseStatus> {
  const effectiveBase = base ?? (await getGatewayHttpBase());
  return request(`${effectiveBase}/api/automation/computer/cancel`, token, {
    method: "POST",
  });
}

export async function grantComputerUsePermissions(
  token: string,
  base?: string,
): Promise<ComputerUseStatus> {
  const effectiveBase = base ?? (await getGatewayHttpBase());
  return request(`${effectiveBase}/api/automation/computer/permissions`, token, {
    method: "POST",
  });
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
  return body.skills.map((skill) => ({
    ...skill,
    ownerAgentId: skill.ownerAgentId ?? agentId,
    description: skill.description ?? "",
    category:
      skill.category ??
      (skill.source === "private" ? "self_learning" : "external"),
    provenance:
      skill.provenance ??
      (skill.source === "private"
        ? "agent"
        : skill.source === "platform"
          ? "bundled"
          : "unknown"),
    editable: skill.editable ?? (skill.source === "private" && !skill.archived),
    accessCount: skill.accessCount ?? 0,
    pinned: skill.pinned ?? false,
  }));
}

export async function getAgentSkill(
  token: string,
  agentId: string,
  name: string,
  base?: string,
): Promise<AgentSkillDetail> {
  const effectiveBase = base ?? (await getApiBase());
  const body = await request<{ skill: AgentSkillDetail }>(
    `${effectiveBase}/api/agents/${encodeURIComponent(agentId)}/skills/${encodeURIComponent(name)}`,
    token,
  );
  return body.skill;
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
      headers: { "Content-Type": "application/json" },
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

export interface ProviderModelsResult {
  models: string[];
  model_details?: Array<{
    id: string;
    name?: string;
    type?: string | null;
    input_modalities?: string[] | null;
  }>;
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
  const headers =
    params.apiKey === undefined
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
  const body = await request<{ commands: Row[] }>(
    `${effectiveBase}/api/commands`,
    token,
  );
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
  return request<SidebarStatePayload>(
    `${effectiveBase}/api/webui/sidebar-state`,
    token,
  );
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
  if (update.providerModel !== undefined)
    query.set("provider_model", update.providerModel);
  if (update.reasoningEffort !== undefined)
    query.set("reasoning_effort", update.reasoningEffort ?? "none");
  if (update.timezone !== undefined) query.set("timezone", update.timezone);
  if (update.toolHintMaxLength !== undefined) {
    query.set("tool_hint_max_length", String(update.toolHintMaxLength));
  }
  if (update.workspace !== undefined) query.set("workspace", update.workspace);
  return request<SettingsPayload>(
    `${effectiveBase}/api/settings/update?${query}`,
    token,
  );
}

export async function updateProviderSettings(
  token: string,
  update: ProviderSettingsUpdate,
  base?: string,
): Promise<SettingsPayload> {
  const effectiveBase = base ?? (await getApiBase());
  const query = new URLSearchParams();
  query.set("provider", update.provider);
  if (update.customName !== undefined)
    query.set("custom_name", update.customName);
  if (update.apiBase !== undefined) query.set("api_base", update.apiBase);
  if (update.model !== undefined) query.set("model", update.model);
  if (update.enabledModels !== undefined) {
    query.set("enabled_models", JSON.stringify(update.enabledModels));
  }
  if (update.discoveredModels !== undefined) {
    query.set("discovered_models", JSON.stringify(update.discoveredModels));
  }
  if (update.delete !== undefined) query.set("delete", String(update.delete));
  const headers =
    update.apiKey === undefined
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
  if (update.maxResults !== undefined)
    query.set("max_results", String(update.maxResults));
  if (update.timeout !== undefined)
    query.set("timeout", String(update.timeout));
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
  query.set("parameters", JSON.stringify(update.parameters));
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
  query.set("parameters", JSON.stringify(update.parameters));
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
  if (update.enabled !== undefined)
    query.set("enabled", String(update.enabled));
  if (update.autoReviewEnabled !== undefined) {
    query.set("autoReviewEnabled", String(update.autoReviewEnabled));
  }
  if (update.reviewTime !== undefined)
    query.set("reviewTime", update.reviewTime);
  if (update.reviewScope !== undefined)
    query.set("reviewScope", update.reviewScope);
  if (update.pushNotification !== undefined) {
    query.set("pushNotification", String(update.pushNotification));
  }
  if (update.pushEmail !== undefined)
    query.set("pushEmail", String(update.pushEmail));
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
  extra?: {
    botId?: string;
    appId?: string;
    secret?: string;
    appSecret?: string;
  },
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

export async function fetchPptProjectPath(
  token: string,
  project: string,
  base?: string,
): Promise<{ path: string }> {
  const effectiveBase = base ?? (await getApiBase());
  const query = new URLSearchParams({ project });
  return request(`${effectiveBase}/api/ppt/project-path?${query}`, token);
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
  phase?:
    "config" | "generating" | "outline" | "producing" | "exporting" | "done";
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
  return request<{
    ok: boolean;
    file: string;
    mtime: number;
    confirmedAt: string;
  }>(`${effectiveBase}/api/ppt/project/page/confirm`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, file, expectedMtime }),
  });
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
  "storyboard" | "producing" | "exportable" | "rendering" | "done";

export type VideoAspectVariant = "16:9" | "9:16" | "1:1";
export type VideoStyleMode = "light" | "dark";
export type VideoStyleCardStyle = "solid" | "outline" | "glass" | "none";
export type VideoStyleDensity = "compact" | "standard" | "spacious";
export type VideoStyleMotionIntensity = "restrained" | "standard" | "active";

export interface VideoStyleColorTokens {
  primary: string;
  secondary: string;
  background: string;
  surface: string;
  textPrimary: string;
  textSecondary: string;
  border: string;
  [key: string]: string;
}

export type VideoRuntimeComponent = "node" | "ffmpeg";
export type VideoRuntimeDownloadState =
  "pending" | "downloading" | "completed" | "failed" | "cancelled";

export interface VideoRuntimeDownloadComponent {
  component: VideoRuntimeComponent;
  state: VideoRuntimeDownloadState;
  progress: number | null;
  receivedBytes: number;
  totalBytes: number;
  path?: string | null;
  error?: string | null;
}

export interface VideoRuntimeDownloadJob {
  jobId: string;
  state: "running" | "completed" | "failed" | "cancelled";
  progress: number;
  currentComponent?: VideoRuntimeComponent | null;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
  components: Partial<
    Record<VideoRuntimeComponent, VideoRuntimeDownloadComponent>
  >;
}

export interface VideoStyleTypography {
  headingFamily?: string;
  bodyFamily?: string;
  scale?: "compact" | "standard" | "large" | string;
  [key: string]: unknown;
}

export interface VideoStyleShape {
  cardRadius?: number;
  cardStyle?: VideoStyleCardStyle | string;
  density?: VideoStyleDensity | string;
  [key: string]: unknown;
}

export interface VideoStyleMotion {
  intensity?: VideoStyleMotionIntensity | string;
  enterPreset?: string;
  emphasisPreset?: string;
  transitionPreset?: string;
  [key: string]: unknown;
}

export interface VideoStyleSubtitle {
  position?: "bottom-center" | "bottom-left" | "top-center" | string;
  style?: string;
  maxLines?: number;
  [key: string]: unknown;
}

export interface VideoStyleFocalPoint {
  x: number;
  y: number;
}

export interface VideoStyleBackgroundOverlay {
  type?: "linear-gradient" | "solid" | string;
  color?: string;
  opacity?: number;
  direction?: "left-to-right" | "right-to-left" | "top-to-bottom" | string;
  [key: string]: unknown;
}

export interface VideoBackgroundSlot {
  assetPolicy?: "fixed" | "episode-replaceable" | string;
  assetId?: string | null;
  fit?: "cover" | "contain" | string;
  focalPoint?: VideoStyleFocalPoint;
  overlay?: VideoStyleBackgroundOverlay;
  blur?: number;
  tint?: number;
  contrastMode?: "auto" | "light" | "dark" | string;
  fallback?: string;
  [key: string]: unknown;
}

export type VideoSceneRole =
  | "cover"
  | "chapter"
  | "content"
  | "data"
  | "comparison"
  | "process"
  | "quote"
  | "outro"
  | string;

export interface VideoStyleBackgrounds {
  default?: VideoBackgroundSlot;
  roles?: Partial<Record<VideoSceneRole, VideoBackgroundSlot>>;
  [key: string]: unknown;
}

export interface VideoStyleConfig {
  schemaVersion?: number;
  baseTemplateId?: string | null;
  mode?: VideoStyleMode | string;
  tokens?: {
    colors?: Partial<VideoStyleColorTokens>;
    typography?: VideoStyleTypography;
    shape?: VideoStyleShape;
    [key: string]: unknown;
  };
  components?: Record<string, string>;
  motion?: VideoStyleMotion;
  backgrounds?: VideoStyleBackgrounds;
  subtitle?: VideoStyleSubtitle;
  aspectVariants?: Partial<
    Record<VideoAspectVariant, { enabled?: boolean; [key: string]: unknown }>
  >;
  [key: string]: unknown;
}

export interface VideoStyleSummary {
  version?: number | null;
  name?: string | null;
  baseTemplateId?: string | null;
  mode?: VideoStyleMode | string | null;
  primaryColor?: string | null;
  backgroundAssetId?: string | null;
  previewUrl?: string | null;
  hasBackground?: boolean;
}

export interface VideoStyleDraft extends VideoStyleConfig {
  seriesId: string;
  revision: number;
  name?: string | null;
  updatedAt?: string | number | null;
  styleSummary?: VideoStyleSummary | null;
}

export interface VideoStyleVersion extends VideoStyleConfig {
  seriesId: string;
  version: number;
  name?: string | null;
  createdAt?: string | number | null;
  createdBy?: string | null;
  styleSummary?: VideoStyleSummary | null;
  previewUrl?: string | null;
}

export interface StyleValidationIssue {
  code?: string;
  severity: "error" | "warning" | "info" | string;
  message: string;
  path?: string | null;
  field?: string | null;
}

export interface BackgroundAsset {
  id: string;
  seriesId?: string;
  name?: string;
  mime?: string;
  width?: number;
  height?: number;
  size?: number;
  path?: string;
  previewUrl?: string;
  createdAt?: string | number;
  sourceType?: VideoAssetSourceType;
  rightsStatus?: VideoAssetRightsStatus;
  commercialUse?: boolean;
  licenseName?: string;
  rightsConfirmedAt?: string | null;
}

export interface VideoBrandKit {
  id: string;
  name: string;
  revision: number;
  latestVersion: number;
  tokens: {
    colors?: Partial<VideoStyleColorTokens>;
    typography?: VideoStyleTypography;
  };
  brand: {
    displayName: string;
    logo?: Partial<
      Record<
        "light" | "dark",
        {
          assetId: string;
          path: string;
          alt: string;
          rightsStatus: VideoAssetRightsStatus;
          commercialUse: boolean;
        }
      >
    >;
  };
  lockedFields: string[];
  createdAt: string;
  updatedAt: string;
}

export interface VideoBrandVersion extends VideoBrandKit {
  version: number;
  lockedAt: string;
  snapshotHash: string;
}

export interface VideoSeries {
  id: string;
  name: string;
  latestStyleVersion?: number | null;
  defaultAspectRatio?: VideoAspectVariant | null;
  createdAt?: string | number;
  updatedAt?: string | number;
  archivedAt?: string | null;
  episodeCount?: number;
  coverAssetId?: string | null;
  styleSummary?: VideoStyleSummary | null;
  draft?: VideoStyleDraft | null;
  styles?: VideoStyleVersion[];
  episodes?: VideoProject[];
}

export interface CreateVideoSeriesOptions {
  name: string;
  baseTemplateId?: string;
  defaultAspectRatio?: VideoAspectVariant;
  brandKitId?: string;
  brandKitVersion?: number;
  style?: Partial<VideoStyleConfig>;
}

export interface VideoStyleDraftUpdate extends Partial<VideoStyleConfig> {
  revision: number;
  name?: string | null;
}

export interface VideoProjectCreateOptions extends VideoTtsConfig {
  seriesId?: string | null;
  styleVersion?: number | null;
  episodeNumber?: number | null;
  aspectVariant?: VideoAspectVariant | null;
  backgroundBindings?: Record<string, string>;
  plan?: VideoProjectPlan;
  sourcePaths?: string[];
  music?: {
    preset: "none" | "ambient" | "rhythmic" | "brand";
    filePath?: string;
    sourceType?: VideoAssetSourceType;
    rightsStatus?: VideoAssetRightsStatus;
    licenseName?: string;
  };
}

export interface VideoPlanOutlineItem {
  id: string;
  title: string;
  goal: string;
  keyPoints: string[];
  sourceRefs: string[];
  estimatedSeconds: number;
  role: string;
}

export interface VideoProjectPlan {
  schemaVersion: number;
  contentSummary: string;
  outline: VideoPlanOutlineItem[];
  estimatedSceneCount: number;
  estimatedDurationSeconds: number;
  estimatedAssetCount: number;
  stages: string[];
  billing: { monaCredits: number; note: string };
}

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
  seriesId?: string | null;
  seriesName?: string | null;
  styleVersion?: number | null;
  latestSeriesStyleVersion?: number | null;
  styleUpdateAvailable?: boolean;
  episodeNumber?: number | null;
  aspectVariant?: VideoAspectVariant | null;
  backgroundBindings?: Record<string, string>;
  language?: string;
  localeGroupId?: string;
  sourceProject?: string | null;
  archived?: boolean;
  styleSummary?: VideoStyleSummary | null;
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
  frames?: Array<{
    timestamp: string;
    fileName: string;
    dataBase64: string;
  }>;
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

export async function startVideoRuntimeDownload(
  token: string,
  components: VideoRuntimeComponent[],
  base?: string,
): Promise<{ ok: boolean; job?: VideoRuntimeDownloadJob; error?: string }> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  return request(`${effectiveBase}/api/video/runtime-download/start`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ components }),
  });
}

export async function fetchVideoRuntimeDownloadJobs(
  token: string,
  base?: string,
): Promise<{ jobs: VideoRuntimeDownloadJob[] }> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  return request(`${effectiveBase}/api/video/runtime-download/status`, token);
}

export async function cancelVideoRuntimeDownload(
  token: string,
  jobId: string,
  base?: string,
): Promise<{ ok: boolean; job?: VideoRuntimeDownloadJob; error?: string }> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  return request(`${effectiveBase}/api/video/runtime-download/cancel`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jobId }),
  });
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

export async function fetchVideoProjectsIncludingArchived(
  token: string,
  base?: string,
): Promise<{ projects: VideoProject[] }> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  return request(
    `${effectiveBase}/api/video/projects?includeArchived=true`,
    token,
  );
}

export async function renameVideoProject(
  token: string,
  name: string,
  newName: string,
  base?: string,
): Promise<{
  ok: boolean;
  name?: string;
  previousName?: string;
  error?: string;
}> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  return request(`${effectiveBase}/api/video/project/rename`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, newName }),
  });
}

export async function copyVideoProject(
  token: string,
  name: string,
  newName: string,
  base?: string,
): Promise<{
  ok: boolean;
  name?: string;
  copiedFrom?: string;
  error?: string;
}> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  return request(`${effectiveBase}/api/video/project/copy`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, newName }),
  });
}

export async function archiveVideoProject(
  token: string,
  name: string,
  archived: boolean,
  base?: string,
): Promise<{ ok: boolean; name?: string; archived?: boolean; error?: string }> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  return request(`${effectiveBase}/api/video/project/archive`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, archived }),
  });
}

// ---------------------------------------------------------------------------
// Video series / style APIs
// ---------------------------------------------------------------------------

export async function fetchVideoSeries(
  token: string,
  includeArchived = false,
  base?: string,
): Promise<{ series: VideoSeries[] }> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  const query = includeArchived ? "?includeArchived=true" : "";
  return request(`${effectiveBase}/api/video/series${query}`, token);
}

export async function updateVideoSeries(
  token: string,
  seriesId: string,
  update: { name?: string; archived?: boolean },
  base?: string,
): Promise<{ ok: boolean; series?: VideoSeries; error?: string }> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  return request(
    `${effectiveBase}/api/video/series/${encodeURIComponent(seriesId)}`,
    token,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(update),
    },
  );
}

export async function createVideoSeries(
  token: string,
  options: CreateVideoSeriesOptions,
  base?: string,
): Promise<{
  ok: boolean;
  series?: VideoSeries;
  draft?: VideoStyleDraft;
  error?: string;
}> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  return request(`${effectiveBase}/api/video/series`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options),
  });
}

export async function fetchVideoSeriesDetail(
  token: string,
  seriesId: string,
  base?: string,
): Promise<VideoSeries> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  return request(
    `${effectiveBase}/api/video/series/${encodeURIComponent(seriesId)}`,
    token,
  );
}

export async function deleteVideoSeries(
  token: string,
  seriesId: string,
  detachEpisodes = false,
  base?: string,
): Promise<{
  ok: boolean;
  deletedSeriesId: string;
  detachedEpisodeCount: number;
}> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  const query = detachEpisodes ? "?detachEpisodes=true" : "";
  return request(
    `${effectiveBase}/api/video/series/${encodeURIComponent(seriesId)}${query}`,
    token,
    { method: "DELETE" },
  );
}

export async function fetchVideoStyleDraft(
  token: string,
  seriesId: string,
  base?: string,
): Promise<VideoStyleDraft> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  return request(
    `${effectiveBase}/api/video/series/${encodeURIComponent(seriesId)}/style/draft`,
    token,
  );
}

export async function saveVideoStyleDraft(
  token: string,
  seriesId: string,
  draft: VideoStyleDraftUpdate,
  base?: string,
): Promise<{
  ok: boolean;
  draft?: VideoStyleDraft;
  revision?: number;
  error?: string;
}> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  return request(
    `${effectiveBase}/api/video/series/${encodeURIComponent(seriesId)}/style/draft`,
    token,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draft),
    },
  );
}

export async function validateVideoStyle(
  token: string,
  seriesId: string,
  draft?: VideoStyleDraftUpdate | Partial<VideoStyleConfig>,
  base?: string,
): Promise<{
  ok: boolean;
  valid: boolean;
  issues: StyleValidationIssue[];
  error?: string;
}> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  return request(
    `${effectiveBase}/api/video/series/${encodeURIComponent(seriesId)}/style/validate`,
    token,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      ...(draft ? { body: JSON.stringify(draft) } : {}),
    },
  );
}

export async function previewVideoStyle(
  token: string,
  seriesId: string,
  style: VideoStyleDraftUpdate | Partial<VideoStyleConfig>,
  role: "cover" | "content" | "data" | "outro",
  aspectRatio: VideoAspectVariant,
  base?: string,
): Promise<{ ok: boolean; html: string }> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  return request(
    `${effectiveBase}/api/video/series/${encodeURIComponent(seriesId)}/style/preview`,
    token,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ style, role, aspectRatio }),
    },
  );
}

export async function lockVideoStyle(
  token: string,
  seriesId: string,
  draft?: VideoStyleDraftUpdate | Partial<VideoStyleConfig>,
  base?: string,
): Promise<{ ok: boolean; version?: VideoStyleVersion; error?: string }> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  return request(
    `${effectiveBase}/api/video/series/${encodeURIComponent(seriesId)}/style/lock`,
    token,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      ...(draft ? { body: JSON.stringify(draft) } : {}),
    },
  );
}

export async function fetchVideoStyleVersions(
  token: string,
  seriesId: string,
  base?: string,
): Promise<{ styles: VideoStyleVersion[] }> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  return request(
    `${effectiveBase}/api/video/series/${encodeURIComponent(seriesId)}/styles`,
    token,
  );
}

export async function createVideoStyleDraftFromVersion(
  token: string,
  seriesId: string,
  version: number,
  base?: string,
): Promise<{ ok: boolean; draft?: VideoStyleDraft; error?: string }> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  return request(
    `${effectiveBase}/api/video/series/${encodeURIComponent(seriesId)}/styles/${encodeURIComponent(String(version))}/draft`,
    token,
    { method: "POST" },
  );
}

export async function fetchVideoBrandKits(
  token: string,
  base?: string,
): Promise<{ brandKits: VideoBrandKit[] }> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  return request(`${effectiveBase}/api/video/brand-kits`, token);
}

export async function createVideoBrandKit(
  token: string,
  input: {
    name: string;
    displayName: string;
    tokens: VideoBrandKit["tokens"];
    lockedFields?: string[];
  },
  base?: string,
): Promise<{
  ok: boolean;
  brandKit?: VideoBrandKit;
  version?: VideoBrandVersion;
  error?: string;
}> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  return request(`${effectiveBase}/api/video/brand-kits`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function applyVideoBrandKit(
  token: string,
  seriesId: string,
  brandKitId: string,
  version: number,
  base?: string,
): Promise<{ ok: boolean; draft?: VideoStyleDraft; error?: string }> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  return request(
    `${effectiveBase}/api/video/series/${encodeURIComponent(seriesId)}/brand-kit`,
    token,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ brandKitId, version }),
    },
  );
}

export async function uploadVideoBrandLogo(
  token: string,
  kitId: string,
  filePath: string,
  variant: "light" | "dark",
  rightsStatus: VideoAssetRightsStatus,
  base?: string,
): Promise<{
  ok: boolean;
  logo?: NonNullable<VideoBrandKit["brand"]["logo"]>["light"];
  brandKit?: VideoBrandKit;
  error?: string;
}> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  return request(
    `${effectiveBase}/api/video/brand-kits/${encodeURIComponent(kitId)}/logo`,
    token,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath, variant, rightsStatus }),
    },
  );
}

export async function lockVideoBrandKit(
  token: string,
  kitId: string,
  revision: number,
  base?: string,
): Promise<{ ok: boolean; version?: VideoBrandVersion; error?: string }> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  return request(
    `${effectiveBase}/api/video/brand-kits/${encodeURIComponent(kitId)}/lock`,
    token,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ revision }),
    },
  );
}

export async function uploadVideoBackgroundAsset(
  token: string,
  seriesId: string,
  filePath: string,
  metadata?: {
    sourceType: VideoAssetSourceType;
    rightsStatus: VideoAssetRightsStatus;
    licenseName?: string;
  },
  base?: string,
): Promise<{ ok: boolean; asset?: BackgroundAsset; error?: string }> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  return request(
    `${effectiveBase}/api/video/series/${encodeURIComponent(seriesId)}/background-assets`,
    token,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath, ...(metadata ?? {}) }),
    },
  );
}

export async function deleteVideoBackgroundAsset(
  token: string,
  seriesId: string,
  assetId: string,
  base?: string,
): Promise<{ ok: boolean; error?: string }> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  return request(
    `${effectiveBase}/api/video/series/${encodeURIComponent(seriesId)}/background-assets/${encodeURIComponent(assetId)}`,
    token,
    { method: "DELETE" },
  );
}

export function buildVideoBackgroundAssetPreviewUrl(
  base: string,
  token: string,
  seriesId: string,
  assetId: string,
): string {
  return `${base}/api/video/series/${encodeURIComponent(seriesId)}/background-assets/${encodeURIComponent(assetId)}/preview?${new URLSearchParams({ token })}`;
}

export interface VideoTtsConfig {
  narrationEnabled?: boolean;
  ttsProvider?: string;
  ttsVoice?: string;
  ttsRate?: string;
  subtitleMode?: "burned" | "external" | "off";
}

export async function createVideoProject(
  token: string,
  name: string,
  resolution: string,
  tts?: VideoProjectCreateOptions,
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

export async function planVideoProject(
  token: string,
  options: { topic: string; sourcePaths?: string[] },
  base?: string,
): Promise<{
  ok: boolean;
  plan?: VideoProjectPlan;
  error?: string;
  code?: string;
}> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  return request(`${effectiveBase}/api/video/project/plan`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options),
  });
}

export async function changeVideoProjectAspect(
  token: string,
  name: string,
  aspectVariant: VideoAspectVariant,
  base?: string,
): Promise<{
  ok: boolean;
  aspectVariant?: VideoAspectVariant;
  resolution?: string;
  phase?: VideoProjectPhase;
  error?: string;
}> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  return request(`${effectiveBase}/api/video/project/change-aspect`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, aspectVariant }),
  });
}

export async function fetchVideoProject(
  token: string,
  name: string,
  base?: string,
): Promise<
  VideoProject & { previewPort?: number | null; videoUrl?: string | null }
> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  const query = new URLSearchParams();
  query.set("name", name);
  return request(`${effectiveBase}/api/video/project?${query}`, token);
}

export type VideoLanguage =
  "zh-CN" | "zh-TW" | "en-US" | "ja-JP" | "ko-KR" | "es-ES" | "fr-FR" | "de-DE";

export async function localizeVideoProject(
  token: string,
  name: string,
  targetLanguage: VideoLanguage,
  base?: string,
): Promise<{
  ok: boolean;
  name?: string;
  language?: VideoLanguage;
  project?: VideoProject;
  error?: string;
}> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  return request(`${effectiveBase}/api/video/project/localize`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, targetLanguage }),
  });
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
  artifact?: "package" | "srt" | "vtt" | "cover" | "audio" | "report",
): string {
  const query = new URLSearchParams();
  query.set("name", name);
  query.set("token", token);
  if (artifact) query.set("artifact", artifact);
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
  stage: "idle" | "rendering" | "cancelling" | "cancelled" | "done" | "error";
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
  requestedEngine?: "legacy" | "hyperframes" | "auto";
  actualEngine?: "legacy" | "hyperframes";
  fallbackReason?: string | null;
  recoverable?: boolean;
  deliveryArtifacts?: Partial<
    Record<
      | "mp4"
      | "package"
      | "srt"
      | "vtt"
      | "cover"
      | "audio"
      | "report"
      | "assetRights",
      string
    >
  >;
  qualityStatus?: "passed" | "warning";
  deliveryWarnings?: string[];
  releaseType?: "draft" | "final";
}

export async function cancelVideoExport(
  token: string,
  name: string,
  base?: string,
): Promise<{ ok: boolean; stage?: "cancelling"; error?: string }> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  return request(`${effectiveBase}/api/video/project/export/cancel`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
}

export async function exportVideoProject(
  token: string,
  name: string,
  opts?: {
    quality?: "draft" | "standard" | "high";
    renderEngine?: "legacy" | "hyperframes" | "auto";
    releaseType?: "draft" | "final";
  },
  base?: string,
): Promise<{
  ok: boolean;
  stage?: string;
  message?: string;
  requestedEngine?: "legacy" | "hyperframes" | "auto";
  error?: string;
}> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  return request(`${effectiveBase}/api/video/project/export`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, ...(opts ?? {}) }),
  });
}

export async function fetchVideoExportStatus(
  token: string,
  name: string,
  base?: string,
): Promise<VideoExportStatus> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  const query = new URLSearchParams();
  query.set("name", name);
  return request(
    `${effectiveBase}/api/video/project/export-status?${query}`,
    token,
  );
}

export function buildVideoPreviewFullUrl(
  base: string,
  token: string,
  name: string,
): string {
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
  role: VideoSceneRole;
  layout: string;
  backgroundSlot: string;
  duration: number;
  durationRaw: string;
  visual: string;
  animation: string;
  narration: string;
  assets: string[];
  audioTimingSource?: "provider-boundary" | "estimated" | "missing" | string;
  audioAlignmentConfidence?: "high" | "review" | string | null;
  audioTimingPath?: string;
  motionPlanPath?: string;
  motionPlanSummary?: string;
}

export type VideoAssetSourceType =
  | "user-upload"
  | "document"
  | "ai-generated"
  | "licensed-library"
  | "generated-chart";

export type VideoAssetRightsStatus =
  | "unknown"
  | "owned"
  | "licensed"
  | "public-domain"
  | "ai-generated"
  | "permission-granted";

export interface VideoProjectAsset {
  id: string;
  kind: string;
  path: string;
  originalName: string;
  mimeType: string;
  bytes: number;
  sha256: string;
  sourceType: VideoAssetSourceType;
  rightsStatus: VideoAssetRightsStatus;
  commercialUse: boolean;
  licenseName?: string;
  sourceUrl?: string;
  creator?: string;
  attribution?: string;
  aiProvider?: string;
  generationPrompt?: string;
  createdAt: string;
  updatedAt: string;
}

export async function fetchVideoProjectAssets(
  token: string,
  name: string,
  base?: string,
): Promise<{
  ok: boolean;
  assets: VideoProjectAsset[];
  unconfirmedCount: number;
}> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  const query = new URLSearchParams({ name });
  return request(`${effectiveBase}/api/video/project/assets?${query}`, token);
}

export async function importVideoProjectAsset(
  token: string,
  name: string,
  sourcePath: string,
  metadata: {
    sourceType: VideoAssetSourceType;
    rightsStatus: VideoAssetRightsStatus;
    licenseName?: string;
  },
  base?: string,
): Promise<{ ok: boolean; asset?: VideoProjectAsset; error?: string }> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  return request(`${effectiveBase}/api/video/project/asset/import`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, sourcePath, ...metadata }),
  });
}

export async function updateVideoProjectAsset(
  token: string,
  name: string,
  assetId: string,
  patch: Partial<
    Pick<
      VideoProjectAsset,
      | "sourceType"
      | "rightsStatus"
      | "licenseName"
      | "sourceUrl"
      | "creator"
      | "attribution"
      | "aiProvider"
      | "generationPrompt"
    >
  >,
  base?: string,
): Promise<{ ok: boolean; asset?: VideoProjectAsset; error?: string }> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  return request(`${effectiveBase}/api/video/project/asset`, token, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, assetId, ...patch }),
  });
}

export function buildVideoProjectAssetPreviewUrl(
  base: string,
  token: string,
  name: string,
  path: string,
): string {
  const query = new URLSearchParams({ name, path, token });
  return `${base}/api/video/project-file?${query}`;
}

export interface VideoExportPreflight {
  duration: number;
  fps: number;
  resolution: [number, number];
  estimatedFrames: number;
  estimatedOutputBytes: number;
  narrationCharacters: number;
  openReviewCount: number;
  assetRights: {
    usedAssetCount: number;
    missingAssetIds: string[];
    unconfirmedAssets: Array<{
      assetId: string;
      name?: string;
      rightsStatus?: VideoAssetRightsStatus;
    }>;
    readyForCommercialUse: boolean;
  };
  billing: {
    monaCredits: number;
    localRender: boolean;
    externalProviderBilling: boolean;
    note: string;
  };
}

export async function fetchVideoExportPreflight(
  token: string,
  name: string,
  quality: "draft" | "standard" | "high",
  base?: string,
): Promise<{ ok: boolean } & VideoExportPreflight> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  const query = new URLSearchParams({ name, quality });
  return request(
    `${effectiveBase}/api/video/project/export-preflight?${query}`,
    token,
  );
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
  return request(
    `${effectiveBase}/api/video/project/storyboard?${query}`,
    token,
  );
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
  const res = await fetch(
    `${effectiveBase}/api/video/project/scene/narration`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ name, index }),
    },
  );
  if (!res.ok) return null;
  return res.blob();
}

// ---------------------------------------------------------------------------
// Video scene HTML generation / preview / state machine (P2)
// ---------------------------------------------------------------------------

export type SceneHtmlStatus =
  "pending" | "generating" | "previewing" | "confirmed";

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
): Promise<{
  ok: boolean;
  scene?: VideoSceneWithHtml;
  htmlPath?: string;
  error?: string;
}> {
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
  const res = await fetch(
    `${effectiveBase}/api/video/project/scene/preview?${query}`,
    {
      headers: { Authorization: `Bearer ${token}` },
    },
  );
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
): Promise<{
  ok: boolean;
  scene?: VideoSceneWithHtml;
  allConfirmed?: boolean;
  phase?: string;
  error?: string;
}> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  return request(`${effectiveBase}/api/video/project/scene/confirm`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      index,
      ...(expectedMtime !== undefined ? { expectedMtime } : {}),
    }),
  });
}

// ---------------------------------------------------------------------------
// Skill lifecycle (settings panel)
// ---------------------------------------------------------------------------

export interface SkillUsageRow {
  name: string;
  ownerAgentId: string;
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
  dreamSchedule: string;
  scope: "per_agent";
}

export interface VideoSceneTimeline {
  sceneIndex: number;
  durationMs: number;
  subtitleTrack?: {
    timingSource: string;
    cues: Array<{ id: string; startMs: number; endMs: number; text: string }>;
  } | null;
  motionPlan?: {
    beats: Array<{
      id: string;
      startMs: number;
      endMs: number;
      target: string;
      effect: string;
    }>;
  } | null;
}

export async function fetchVideoSceneTimeline(
  token: string,
  name: string,
  index: number,
  base?: string,
): Promise<{ ok: boolean } & VideoSceneTimeline> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  const query = new URLSearchParams({ name, index: String(index) });
  return request(
    `${effectiveBase}/api/video/project/scene/timeline?${query}`,
    token,
  );
}

export async function listSkills(
  token: string,
  agentId: string,
  base?: string,
): Promise<{ skills: SkillUsageRow[] }> {
  const effectiveBase = base ?? (await getGatewayHttpBase());
  return request(
    `${effectiveBase}/api/skills/list?agentId=${encodeURIComponent(agentId)}`,
    token,
  );
}

export async function setSkillPinned(
  token: string,
  agentId: string,
  name: string,
  pinned: boolean,
  base?: string,
): Promise<{ ok: boolean; name: string; pinned: boolean }> {
  const effectiveBase = base ?? (await getGatewayHttpBase());
  return request(`${effectiveBase}/api/skills/set_pinned`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentId, name, pinned }),
  });
}

export async function archiveSkill(
  token: string,
  agentId: string,
  name: string,
  base?: string,
): Promise<{ ok: boolean; name: string; message: string }> {
  const effectiveBase = base ?? (await getGatewayHttpBase());
  return request(`${effectiveBase}/api/skills/archive`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentId, name }),
  });
}

export async function restoreSkill(
  token: string,
  agentId: string,
  name: string,
  base?: string,
): Promise<{ ok: boolean; name: string; message: string }> {
  const effectiveBase = base ?? (await getGatewayHttpBase());
  return request(`${effectiveBase}/api/skills/restore`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentId, name }),
  });
}

export async function pruneSkills(
  token: string,
  agentId: string,
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
      agentId,
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
): Promise<{
  ok: boolean;
  name: string;
  connected?: boolean;
  toolCount?: number;
  error?: string;
}> {
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
): Promise<{
  ok: boolean;
  name: string;
  connected?: boolean;
  toolCount?: number;
  error?: string;
}> {
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
): Promise<{
  ok: boolean;
  name: string;
  connected?: boolean;
  toolCount?: number;
  error?: string;
}> {
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
): Promise<{
  ok: boolean;
  connectedCount?: number;
  totalConfigured?: number;
  error?: string;
}> {
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
): Promise<{
  ok: boolean;
  scene?: VideoSceneWithHtml;
  undoVersionId?: string;
  error?: string;
}> {
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
  task_files?: DeliveredFile[];
  task_id?: string | null;
  truncated: boolean;
}

export interface VideoProjectVersion {
  id: string;
  createdAt: string;
  label: string;
  reason: string;
  changedSceneIndices: number[];
  projectPhase?: VideoProjectPhase;
  styleVersion?: number | null;
}

export async function fetchVideoProjectVersions(
  token: string,
  name: string,
  base?: string,
): Promise<{ ok: boolean; versions: VideoProjectVersion[] }> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  const query = new URLSearchParams({ name });
  return request(`${effectiveBase}/api/video/project/versions?${query}`, token);
}

export async function restoreVideoProjectVersion(
  token: string,
  name: string,
  versionId: string,
  base?: string,
): Promise<{
  ok: boolean;
  restoredVersionId?: string;
  backupVersionId?: string;
  phase?: VideoProjectPhase;
  error?: string;
}> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  return request(`${effectiveBase}/api/video/project/version/restore`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, versionId }),
  });
}

export interface VideoReview {
  id: string;
  sceneIndex: number;
  timeMs: number;
  text: string;
  status: "open" | "resolved";
  createdAt: string;
  resolvedAt?: string | null;
}

export async function fetchVideoReviews(
  token: string,
  name: string,
  base?: string,
): Promise<{ ok: boolean; reviews: VideoReview[]; openCount: number }> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  const query = new URLSearchParams({ name });
  return request(`${effectiveBase}/api/video/project/reviews?${query}`, token);
}

export async function createVideoReview(
  token: string,
  name: string,
  sceneIndex: number,
  timeMs: number,
  text: string,
  base?: string,
): Promise<{ ok: boolean; review?: VideoReview; error?: string }> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  return request(`${effectiveBase}/api/video/project/review`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, sceneIndex, timeMs, text }),
  });
}

export async function resolveVideoReview(
  token: string,
  name: string,
  reviewId: string,
  resolved = true,
  base?: string,
): Promise<{ ok: boolean; review?: VideoReview; error?: string }> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  return request(`${effectiveBase}/api/video/project/review`, token, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, reviewId, resolved }),
  });
}

export async function upgradeVideoProjectStyle(
  token: string,
  name: string,
  styleVersion: number,
  base?: string,
): Promise<{
  ok: boolean;
  styleVersion?: number;
  phase?: VideoProjectPhase;
  error?: string;
}> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  return request(`${effectiveBase}/api/video/project/upgrade-style`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, styleVersion }),
  });
}

export async function upgradeVideoSeriesProjects(
  token: string,
  seriesId: string,
  styleVersion: number,
  projectNames?: string[],
  base?: string,
): Promise<{
  ok: boolean;
  styleVersion?: number;
  updatedProjectNames?: string[];
  skipped?: Array<{ name: string; reason: string }>;
  error?: string;
}> {
  const effectiveBase = base ?? (await getServicesHttpBase());
  return request(
    `${effectiveBase}/api/video/series/${encodeURIComponent(seriesId)}/upgrade-projects`,
    token,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ styleVersion, projectNames }),
    },
  );
}

/** List an Agent workspace plus explicit session references, or one room's
 *  flat explicit-reference projection when ``room`` is given. The directory
 *  root is fixed by the server; clients cannot pass an arbitrary root. */
export async function listArtifacts(
  token: string,
  base?: string,
  room?: string,
  sessionKey?: string,
  taskId?: string,
): Promise<ArtifactListResponse> {
  const effectiveBase = base ?? (await getApiBase());
  const params = new URLSearchParams();
  if (room) params.set("room", room);
  if (sessionKey) params.set("session_key", sessionKey);
  if (taskId) params.set("task_id", taskId);
  const query = params.toString() ? `?${params}` : "";
  return request<ArtifactListResponse>(
    `${effectiveBase}/api/artifacts${query}`,
    token,
  );
}

export async function renameArtifact(
  token: string,
  params: {
    scope: "shared" | "project";
    sessionKey: string;
    path: string;
    newName: string;
  },
  base?: string,
): Promise<{ path: string; name: string }> {
  const effectiveBase = base ?? (await getApiBase());
  const query = new URLSearchParams({
    scope: params.scope,
    session_key: params.sessionKey,
    path: params.path,
    new_name: params.newName,
  });
  return request(`${effectiveBase}/api/artifact-rename?${query}`, token);
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
