import type {
  ChatSummary,
  ImageGenerationSettingsUpdate,
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

export async function kbStatus(
  token: string,
  base?: string,
  instance?: string,
): Promise<{ mode: string; docCount: number; pendingChanges: number; instance: string }> {
  const effectiveBase = base ?? (await getApiBase());
  const query = new URLSearchParams();
  if (instance) query.set("instance", instance);
  return request(
    `${effectiveBase}/api/kb/status?${query}`,
    token,
  );
}

export async function kbIngest(
  token: string,
  paths: string[],
  base?: string,
  instance?: string,
  recursive = false,
  mode = "notebook",
): Promise<{ ingested: string[]; count: number }> {
  const effectiveBase = base ?? (await getApiBase());
  const query = new URLSearchParams();
  query.set("paths", paths.join(","));
  if (instance) query.set("instance", instance);
  query.set("recursive", String(recursive));
  query.set("mode", mode);
  return request(
    `${effectiveBase}/api/kb/ingest?${query}`,
    token,
  );
}

export async function kbQuery(
  token: string,
  q: string,
  base?: string,
  instance?: string,
  topK = 5,
  maxTokens = 8000,
): Promise<{ results: Array<{ path: string; title: string; content: string }>; totalTokens: number }> {
  const effectiveBase = base ?? (await getApiBase());
  const query = new URLSearchParams();
  query.set("q", q);
  if (instance) query.set("instance", instance);
  query.set("topK", String(topK));
  query.set("maxTokens", String(maxTokens));
  return request(
    `${effectiveBase}/api/kb/query?${query}`,
    token,
  );
}

export async function kbCompile(
  token: string,
  base?: string,
  instance?: string,
): Promise<{ compiled: number }> {
  const effectiveBase = base ?? (await getApiBase());
  const query = new URLSearchParams();
  if (instance) query.set("instance", instance);
  query.set("mode", "document");
  return request(
    `${effectiveBase}/api/kb/compile?${query}`,
    token,
  );
}

export async function kbList(
  token: string,
  base?: string,
): Promise<{ instances: Array<{ name: string; mode: string; paths: string[]; docCount: number; pendingChanges: number }> }> {
  const effectiveBase = base ?? (await getApiBase());
  const query = new URLSearchParams();
  return request(
    `${effectiveBase}/api/kb/list?${query}`,
    token,
  );
}

export async function kbCreate(
  token: string,
  name: string,
  mode: string,
  paths: string[],
  base?: string,
): Promise<{ name: string; mode: string }> {
  const effectiveBase = base ?? (await getApiBase());
  const query = new URLSearchParams();
  query.set("name", name);
  query.set("mode", mode);
  query.set("paths", paths.join(","));
  return request(
    `${effectiveBase}/api/kb/create?${query}`,
    token,
  );
}

export async function kbDelete(
  token: string,
  name: string,
  base?: string,
): Promise<{ deleted: string }> {
  const effectiveBase = base ?? (await getApiBase());
  const query = new URLSearchParams();
  query.set("name", name);
  return request(
    `${effectiveBase}/api/kb/delete?${query}`,
    token,
  );
}
