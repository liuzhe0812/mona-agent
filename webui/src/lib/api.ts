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
  WebSearchSettingsUpdate,
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

export function resetApiBase(): void {
  _apiBase = null;
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
  hasSpecLock: boolean;
  exportFile: string | null;
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
