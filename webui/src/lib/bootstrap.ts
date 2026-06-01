import type { BootstrapResponse } from "./types";
import { isTauri, getGatewayStatus, startGateway, httpFetch } from "./tauri";

const SECRET_STORAGE_KEY = "mona-webui.bootstrap-secret";

export function loadSavedSecret(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(SECRET_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveSecret(secret: string): void {
  try {
    window.localStorage.setItem(SECRET_STORAGE_KEY, secret);
  } catch {
    // ignore storage errors (private mode, etc.)
  }
}

export function clearSavedSecret(): void {
  try {
    window.localStorage.removeItem(SECRET_STORAGE_KEY);
  } catch {
    // ignore
  }
}

let _wsBaseUrl: string | null = null;

export async function getGatewayBaseUrl(): Promise<string> {
  if (_wsBaseUrl) return _wsBaseUrl;
  if (isTauri()) {
    let status = await getGatewayStatus();
    if (!status.running) {
      try {
        await startGateway();
        status = await getGatewayStatus();
      } catch {
        // fall through
      }
    }
    if (status.ws_port) {
      _wsBaseUrl = `http://127.0.0.1:${status.ws_port}`;
      return _wsBaseUrl;
    }
  }
  return "";
}

export function resetGatewayBaseUrl(): void {
  _wsBaseUrl = null;
}

async function parseJsonResponse(res: Response): Promise<unknown> {
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("text/html")) {
    throw new Error(
      "Gateway 未就绪，收到了 HTML 响应。请确认 gateway 已启动。",
    );
  }
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    if (text.trimStart().startsWith("<!DOCTYPE") || text.trimStart().startsWith("<html")) {
      throw new Error(
        "Gateway 未就绪，收到了 HTML 响应。请确认 gateway 已启动。",
      );
    }
    throw new Error(`响应解析失败: ${text.slice(0, 200)}`);
  }
}

export async function fetchBootstrap(
  baseUrl: string = "",
  secret: string = "",
): Promise<BootstrapResponse> {
  let effectiveBase = baseUrl;
  if (!effectiveBase && isTauri()) {
    effectiveBase = await getGatewayBaseUrl();
  }
  if (!effectiveBase) {
    throw new Error("无法连接到 Gateway，请确认服务已启动。");
  }
  const headers: Record<string, string> = {};
  if (secret) {
    headers["X-mona-Auth"] = secret;
  }
  const res = await httpFetch(`${effectiveBase}/webui/bootstrap`, {
    method: "GET",
    headers,
  });
  if (!res.ok) {
    throw new Error(`bootstrap failed: HTTP ${res.status}`);
  }
  const body = (await parseJsonResponse(res)) as BootstrapResponse;
  if (!body.token || !body.ws_path) {
    throw new Error("bootstrap response missing token or ws_path");
  }
  if (isTauri() && !_wsBaseUrl) {
    _wsBaseUrl = effectiveBase;
  }
  return body;
}

export async function deriveWsUrl(wsPath: string, token: string): Promise<string> {
  const path = wsPath && wsPath.startsWith("/") ? wsPath : `/${wsPath || ""}`;
  const query = `?token=${encodeURIComponent(token)}`;
  if (isTauri()) {
    const base = await getGatewayBaseUrl();
    const port = base ? new URL(base).port : "8765";
    return `ws://127.0.0.1:${port}${path}${query}`;
  }
  if (typeof window === "undefined") {
    return `ws://127.0.0.1:8765${path}${query}`;
  }
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  const host = window.location.host;
  return `${scheme}://${host}${path}${query}`;
}
