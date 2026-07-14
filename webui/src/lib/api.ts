import type {
  ChatSummary,
  ImageGenerationSettingsUpdate,
  PptProject,
  PptTemplatesResponse,
  ProviderSettingsUpdate,
  SettingsPayload,
  SettingsUpdate,
  SidebarStatePayload,
  SlashCommand,
  VideoGenerationSettingsUpdate,
  WebSearchSettingsUpdate,
  WeixinLoginStatus,
  WebuiThreadPersistedPayload,
} from "./types";
import { isTauri, getGatewayStatus, httpFetch } from "./tauri";

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

export function resetApiBase(): void {
  _apiBase = null;
  _gatewayHttpBase = null;
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
    throw new ApiError(res.status, `HTTP ${res.status}`);
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
    run_started_at?: number | null;
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
    workspace: (s as Row & { workspace?: string | null }).workspace ?? null,
    runStartedAt: s.run_started_at ?? null,
  }));
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
  const effectiveBase = base ?? (await getApiBase());
  const query = new URLSearchParams();
  query.set("state", JSON.stringify(state));
  return request<SidebarStatePayload>(
    `${effectiveBase}/api/webui/sidebar-state/update?${query}`,
    token,
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
  if (update.apiKey !== undefined) query.set("api_key", update.apiKey);
  if (update.apiBase !== undefined) query.set("api_base", update.apiBase);
  if (update.model !== undefined) query.set("model", update.model);
  return request<SettingsPayload>(
    `${effectiveBase}/api/settings/provider/update?${query}`,
    token,
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

export interface VideoProject {
  name: string;
  createdAt: number;
  resolution: string;
  status: "init" | "generating" | "done" | "error";
  hasVideo: boolean;
  chatId: string | null;
}

export async function fetchVideoRuntimeCheck(
  token: string,
  base?: string,
): Promise<VideoRuntimeStatus> {
  const effectiveBase = base ?? (await getGatewayHttpBase());
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
  const effectiveBase = base ?? (await getGatewayHttpBase());
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

export async function fetchVideoProjects(
  token: string,
  base?: string,
): Promise<{ projects: VideoProject[] }> {
  const effectiveBase = base ?? (await getGatewayHttpBase());
  return request(`${effectiveBase}/api/video/projects`, token);
}

export async function createVideoProject(
  token: string,
  name: string,
  resolution: string,
  base?: string,
): Promise<{ ok: boolean; error?: string }> {
  const effectiveBase = base ?? (await getGatewayHttpBase());
  return request<{ ok: boolean; error?: string }>(
    `${effectiveBase}/api/video/project/create`,
    token,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, resolution }),
    },
  );
}

export async function fetchVideoProject(
  token: string,
  name: string,
  base?: string,
): Promise<VideoProject & { previewPort?: number | null; videoUrl?: string | null }> {
  const effectiveBase = base ?? (await getGatewayHttpBase());
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
  const effectiveBase = base ?? (await getGatewayHttpBase());
  const query = new URLSearchParams();
  query.set("name", name);
  query.set("path", path);
  return request(`${effectiveBase}/api/video/project-file?${query}`, token);
}

export async function saveVideoChatId(
  token: string,
  name: string,
  chatId: string,
  base?: string,
): Promise<{ ok: boolean }> {
  const effectiveBase = base ?? (await getGatewayHttpBase());
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
// Flowchart APIs
// ---------------------------------------------------------------------------

export interface FlowchartProject {
  name: string;
  createdAt: number;
  status: "init" | "generating" | "done";
  hasDiagram: boolean;
  chatId: string | null;
}

export async function fetchFlowchartProjects(
  token: string,
  base?: string,
): Promise<{ projects: FlowchartProject[] }> {
  const effectiveBase = base ?? (await getGatewayHttpBase());
  return request(`${effectiveBase}/api/flowchart/projects`, token);
}

export async function createFlowchartProject(
  token: string,
  name: string,
  base?: string,
): Promise<{ ok: boolean; error?: string }> {
  const effectiveBase = base ?? (await getGatewayHttpBase());
  return request<{ ok: boolean; error?: string }>(
    `${effectiveBase}/api/flowchart/project/create`,
    token,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    },
  );
}

export async function fetchFlowchartProject(
  token: string,
  name: string,
  base?: string,
): Promise<FlowchartProject> {
  const effectiveBase = base ?? (await getGatewayHttpBase());
  const query = new URLSearchParams();
  query.set("name", name);
  return request(`${effectiveBase}/api/flowchart/project?${query}`, token);
}

export async function fetchFlowchartProjectXml(
  token: string,
  name: string,
  base?: string,
): Promise<{ ok: boolean; xml?: string; error?: string }> {
  const effectiveBase = base ?? (await getGatewayHttpBase());
  const query = new URLSearchParams();
  query.set("name", name);
  return request(`${effectiveBase}/api/flowchart/project-xml?${query}`, token);
}

export async function saveFlowchartProject(
  token: string,
  name: string,
  xml: string,
  base?: string,
): Promise<{ ok: boolean; error?: string }> {
  const effectiveBase = base ?? (await getGatewayHttpBase());
  return request<{ ok: boolean; error?: string }>(
    `${effectiveBase}/api/flowchart/project-save`,
    token,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, xml }),
    },
  );
}

export async function exportFlowchartProject(
  token: string,
  name: string,
  format: string,
  base?: string,
): Promise<{ ok: boolean; url?: string; data?: string; error?: string }> {
  const effectiveBase = base ?? (await getGatewayHttpBase());
  const query = new URLSearchParams();
  query.set("name", name);
  query.set("format", format);
  return request(`${effectiveBase}/api/flowchart/project-export?${query}`, token);
}

export async function saveFlowchartChatId(
  token: string,
  name: string,
  chatId: string,
  base?: string,
): Promise<{ ok: boolean }> {
  const effectiveBase = base ?? (await getGatewayHttpBase());
  return request<{ ok: boolean }>(
    `${effectiveBase}/api/flowchart/project-save-chat-id`,
    token,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, chatId }),
    },
  );
}

export interface FlowchartRuntimeItem {
  ok: boolean;
  version?: string;
  path?: string;
}

export interface FlowchartRuntimeStatus {
  drawio: FlowchartRuntimeItem;
}

export async function fetchFlowchartRuntimeCheck(
  token: string,
  base?: string,
): Promise<FlowchartRuntimeStatus> {
  const effectiveBase = base ?? (await getGatewayHttpBase());
  return request<FlowchartRuntimeStatus>(
    `${effectiveBase}/api/flowchart/runtime-check`,
    token,
  );
}

export async function downloadFlowchartRuntime(
  token: string,
  base?: string,
): Promise<{ ok: boolean; error?: string }> {
  const effectiveBase = base ?? (await getGatewayHttpBase());
  return request<{ ok: boolean; error?: string }>(
    `${effectiveBase}/api/flowchart/runtime-download`,
    token,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    },
  );
}
