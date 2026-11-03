import { afterEach, describe, expect, it, vi } from "vitest";
import { configureHostedPlatform, getHostedPlatform, hostedPlatformFetch, invokeHostedPlatform } from "@/lib/hosted-platform";
import { MonaClient } from "@/lib/mona-client";
import { createHostedClient } from "./runtime";

const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "Content-Type": "application/json" },
});
const cleanup: Array<() => void> = [];
const configure = (token: string, onUnauthorized?: () => void) => {
  cleanup.push(configureHostedPlatform({ apiBase: "/api/work/desktop", token, onUnauthorized }));
};

afterEach(() => {
  while (cleanup.length) cleanup.pop()?.();
  vi.unstubAllGlobals(); vi.useRealTimers();
});

describe("hosted platform boundary", () => {
  it("is opt-in and only authenticates the current same-origin API prefix", async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ ok: true }));
    vi.stubGlobal("fetch", fetcher);
    expect(getHostedPlatform()).toBeNull();
    await expect(hostedPlatformFetch("/api/work/desktop/api/settings")).rejects.toMatchObject({ code: "not_connected" });
    configure("synthetic-account-A");
    const expected = `${location.origin}/api/work/desktop`;
    expect(getHostedPlatform()?.apiBase).toBe(expected);
    await invokeHostedPlatform("read_workspace_canvas", { path: "/workspace/canvases/id.mona-canvas" });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe(`${expected}/platform/invoke`);
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer synthetic-account-A");
    expect(init).toMatchObject({ credentials: "omit", redirect: "error", cache: "no-store" });
    expect(JSON.parse(init.body)).toEqual({ command: "read_workspace_canvas", args: { path: "/workspace/canvases/id.mona-canvas" } });
    await expect(hostedPlatformFetch("https://other.example/api/work/desktop/api/settings"))
      .rejects.toMatchObject({ code: "invalid_target" });
    await expect(hostedPlatformFetch("/api/settings")).rejects.toMatchObject({ code: "invalid_target" });
    await expect(hostedPlatformFetch("/api/work/desktop/api/settings", { headers: { Authorization: "Bearer different-account" } }))
      .rejects.toMatchObject({ code: "account_changed" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("does not deliver an old account response or clear a newer configuration", async () => {
    let finish!: (value: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
    const releaseA = configureHostedPlatform({ apiBase: "/api/work/desktop", token: "synthetic-account-A" });
    const pending = hostedPlatformFetch("/api/work/desktop/api/settings");
    configure("synthetic-account-B");
    releaseA();
    finish(response({ privateA: true }));
    await expect(pending).rejects.toMatchObject({ code: "account_changed" });
    expect(getHostedPlatform()?.token).toBe("synthetic-account-B");
  });

  it("reports a confirmed revoked account once without storing its token", async () => {
    const unauthorized = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ error: "login_required" }, 401)));
    configure("synthetic-account-A", unauthorized);
    await hostedPlatformFetch("/api/work/desktop/api/settings");
    await hostedPlatformFetch("/api/work/desktop/api/sessions");
    expect(unauthorized).toHaveBeenCalledOnce();
    expect([...Object.values(sessionStorage), ...Object.values(localStorage)])
      .not.toContainEqual(expect.stringContaining("synthetic-account-A"));
  });
});

describe("hosted conversation socket", () => {
  it("uses the real MonaClient with renewable one-use tickets and no JWT URL", async () => {
    const sockets: TestSocket[] = [];
    class TestSocket {
      readyState = 0;
      onopen?: () => void;
      onclose?: (event: { code: number }) => void;
      onerror?: () => void;
      onmessage?: (event: { data: string }) => void;
      constructor(readonly url: string) { sockets.push(this); }
      addEventListener() {}
      send() {}
      close() { this.readyState = 3; this.onclose?.({ code: 1000 }); }
      open() { this.readyState = 1; this.onopen?.(); }
      disconnect() { this.readyState = 3; this.onclose?.({ code: 1006 }); }
    }
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", TestSocket);
    const fetcher = vi.fn().mockImplementation(async () => response({
      ticket: fetcher.mock.calls.length === 1 ? "first_ticket_0123456789" : "second_ticket_0123456789", expires_in_seconds: 60,
    }));
    vi.stubGlobal("fetch", fetcher);
    configure("synthetic-account-A");
    const client = await createHostedClient();
    expect(client).toBeInstanceOf(MonaClient);
    cleanup.push(() => client.close());
    client.connect(); sockets[0].open();
    expect(client.status).toBe("open");
    expect(new URL(sockets[0].url).searchParams.get("ticket")).toBe("first_ticket_0123456789");
    const clientId = new URL(sockets[0].url).searchParams.get("client_id");
    expect(clientId).toMatch(/^web_[a-f0-9]{32}$/);
    expect(sockets[0].url).not.toContain("synthetic-account-A");
    expect(sockets[0].url).not.toContain("token=");
    sockets[0].disconnect();
    await vi.advanceTimersByTimeAsync(500);
    expect(sockets).toHaveLength(2);
    expect(new URL(sockets[1].url).searchParams.get("ticket")).toBe("second_ticket_0123456789");
    expect(new URL(sockets[1].url).searchParams.get("client_id")).toBe(clientId);
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ client_id: clientId });
    expect(new Headers(fetcher.mock.calls[1][1].headers).get("Authorization")).toBe("Bearer synthetic-account-A");
  });
});
