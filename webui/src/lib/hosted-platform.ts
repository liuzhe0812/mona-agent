export interface HostedPlatformConfiguration {
  apiBase: string;
  token: string;
  onUnauthorized?: () => void;
}

interface HostedSession {
  configuration: Readonly<HostedPlatformConfiguration>;
  unauthorized: boolean;
}

let activeSession: HostedSession | null = null;

export class HostedPlatformError extends Error {
  constructor(message: string, readonly status = 0, readonly code = "request_failed") {
    super(message);
    this.name = "HostedPlatformError";
  }
}

export function configureHostedPlatform(configuration: HostedPlatformConfiguration): () => void {
  const base = new URL(configuration.apiBase, window.location.origin);
  if (base.origin !== window.location.origin || base.pathname.replace(/\/$/, "") !== "/api/work/desktop"
    || base.username || base.password || base.search || base.hash
    || !configuration.token || configuration.token.length > 8192 || /[^\x21-\x7e]/.test(configuration.token)) {
    throw new HostedPlatformError("工作台连接配置无效。", 0, "invalid_configuration");
  }
  const session: HostedSession = {
    configuration: Object.freeze({ ...configuration, apiBase: base.href.replace(/\/$/, "") }),
    unauthorized: false,
  };
  activeSession = session;
  return () => { if (activeSession === session) activeSession = null; };
}

export function getHostedPlatform(): Readonly<HostedPlatformConfiguration> | null {
  return activeSession?.configuration ?? null;
}

export async function hostedPlatformFetch(url: string, init?: RequestInit): Promise<Response> {
  const session = activeSession;
  if (!session) throw new HostedPlatformError("工作台连接尚未就绪。", 0, "not_connected");
  const target = new URL(url, window.location.origin);
  const base = new URL(session.configuration.apiBase);
  if (target.origin !== base.origin || target.username || target.password
    || target.pathname !== base.pathname && !target.pathname.startsWith(`${base.pathname}/`)) {
    throw new HostedPlatformError("工作台请求超出当前账户范围。", 0, "invalid_target");
  }
  const headers = new Headers(init?.headers);
  const authorization = headers.get("Authorization");
  if (authorization && authorization !== `Bearer ${session.configuration.token}`) {
    throw new HostedPlatformError("账号已变化，请在原账号中核对操作结果。", 0, "account_changed");
  }
  headers.set("Authorization", `Bearer ${session.configuration.token}`);
  const response = await window.fetch(target.href, {
    ...init, headers, credentials: "omit", redirect: "error", cache: "no-store",
  });
  if (activeSession !== session) {
    throw new HostedPlatformError("账号已变化，请在原账号中核对操作结果。", 0, "account_changed");
  }
  if (response.status === 401 && !session.unauthorized) {
    session.unauthorized = true;
    session.configuration.onUnauthorized?.();
  }
  return response;
}

export async function hostedPlatformJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await hostedPlatformFetch(url, init);
  let payload: unknown;
  if (response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    payload = await response.json();
  }
  if (!response.ok) {
    const value = payload as { message?: unknown; error?: { message?: unknown; code?: unknown } } | undefined;
    const message = value?.message ?? value?.error?.message;
    throw new HostedPlatformError(typeof message === "string" ? message : "工作台操作未能完成，请核对后重试。",
      response.status);
  }
  if (payload === undefined) throw new HostedPlatformError("工作台返回的数据无效。", 503, "invalid_response");
  return payload as T;
}

export async function invokeHostedPlatform<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const configuration = getHostedPlatform();
  if (!configuration) throw new HostedPlatformError("工作台连接尚未就绪。", 0, "not_connected");
  return hostedPlatformJson<T>(`${configuration.apiBase}/platform/invoke`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command, args: args ?? {} }),
  });
}
