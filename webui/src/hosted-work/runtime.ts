import { MonaClient } from "@/lib/mona-client";
import { getHostedPlatform, HostedPlatformError, hostedPlatformJson } from "@/lib/hosted-platform";
import { emitHostedPlatformEvent } from "@/lib/platform-events";

const CLIENT_ID_KEY = "mona-hosted-work-client-v1";

export function clearHostedClientIdentity() {
  sessionStorage.removeItem(CLIENT_ID_KEY);
}

function clientIdentity() {
  const stored = sessionStorage.getItem(CLIENT_ID_KEY);
  if (stored && /^web_[a-f0-9]{32}$/.test(stored)) return stored;
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const value = "web_" + Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  sessionStorage.setItem(CLIENT_ID_KEY, value);
  return value;
}

async function socketUrl(clientId: string, scope: ReturnType<typeof getHostedPlatform>, signal?: AbortSignal): Promise<string> {
  const configuration = getHostedPlatform();
  if (!configuration || configuration !== scope) throw new HostedPlatformError("工作台连接已变化。", 0, "account_changed");
  const reply = await hostedPlatformJson<{ ticket?: unknown; expires_in_seconds?: unknown }>(
    `${configuration.apiBase}/socket-ticket`, { method: "POST", signal,
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_id: clientId }) },
  );
  if (typeof reply.ticket !== "string" || !/^[A-Za-z0-9_-]{16,256}$/.test(reply.ticket)
    || typeof reply.expires_in_seconds !== "number" || !Number.isFinite(reply.expires_in_seconds)
    || reply.expires_in_seconds <= 0 || reply.expires_in_seconds > 300) {
    throw new HostedPlatformError("工作台连接授权无效，请重新登录。", 503, "invalid_ticket");
  }
  const url = new URL(`${configuration.apiBase}/ws`);
  url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("ticket", reply.ticket);
  url.searchParams.set("client_id", clientId);
  return url.href;
}

export async function createHostedClient(signal?: AbortSignal): Promise<MonaClient> {
  const scope = getHostedPlatform();
  const clientId = clientIdentity();
  const url = await socketUrl(clientId, scope, signal);
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
  return new MonaClient({ url, reconnect: true, maxBackoffMs: 5_000,
    socketFactory: value => {
      const socket = new WebSocket(value);
      socket.addEventListener("message", event => {
        if (getHostedPlatform() !== scope) return;
        let frame;
        try { frame = JSON.parse(String(event.data)); } catch { return; }
        if (frame?.event === "hosted_platform_event" && ["canvas-agent-request", "canvas-agent-cancel", "canvas-agent-activate-sidebar"].includes(frame.name)) {
          void emitHostedPlatformEvent(frame.name, frame.payload).catch(() => console.warn("画布编辑连接未完成。"));
        }
      });
      return socket;
    }, onReauth: () => socketUrl(clientId, scope, signal) });
}
