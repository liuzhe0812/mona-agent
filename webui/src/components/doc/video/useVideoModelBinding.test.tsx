import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RoomCommandError } from "@/lib/mona-client";
import { useVideoModelBinding, useVideoSessionKind } from "./useVideoModelBinding";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), update: vi.fn(), listSessions: vi.fn() }));
vi.mock("@/lib/api", async (original) => ({ ...await original<typeof import("@/lib/api")>(), fetchVideoSessionModelBinding: mocks.fetch, listSessions: mocks.listSessions }));
vi.mock("@/providers/ClientProvider", () => ({ useClient: () => ({ token: "test", client: { updateVideoModelBinding: mocks.update } }) }));
const codex = { executor: "codex", model: "gpt-6.1-sol", provider: null, effort: "high" } as const;
const api = { executor: "mona", model: "api-model", provider: "configured-api", effort: null } as const;

describe("video model binding", () => {
  beforeEach(() => { mocks.fetch.mockReset().mockResolvedValue(null); mocks.update.mockReset(); mocks.listSessions.mockReset(); });

  it("does not read or change a binding for a regular owner conversation", async () => {
    const { result } = renderHook(() => useVideoModelBinding("regular-owner", null, false));
    expect(result.current.loading).toBe(false);
    await act(async () => { await result.current.changeBinding(codex); });
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("resolves an unknown project owner from Gateway session metadata before enabling a binding", async () => {
    let resolve!: (sessions: unknown[]) => void;
    mocks.listSessions.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const { result } = renderHook(() => {
      const session = useVideoSessionKind("regular-owner");
      useVideoModelBinding("regular-owner", null, session.agentKind === "video");
      return session;
    });
    expect(result.current.agentKind).toBeUndefined();
    expect(mocks.fetch).not.toHaveBeenCalled();
    await act(async () => resolve([{ channel: "websocket", chatId: "regular-owner", agentKind: null }]));
    expect(result.current.agentKind).toBeNull();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("restores the saved selection and retains it on an explicit rejection", async () => {
    mocks.fetch.mockResolvedValue(codex);
    mocks.update.mockRejectedValue(new RoomCommandError("请先停止当前制作任务", "run_active"));
    const { result } = renderHook(() => useVideoModelBinding("video-a"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.binding).toEqual(codex);
    await act(async () => { await expect(result.current.changeBinding(api)).rejects.toThrow("请先停止"); });
    expect(result.current.binding).toEqual(codex);
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });

  it("reconciles a lost update receipt by reading the actual selection once", async () => {
    mocks.fetch.mockResolvedValueOnce(null).mockResolvedValueOnce(codex);
    mocks.update.mockRejectedValue(new Error("response lost"));
    const { result } = renderHook(() => useVideoModelBinding("video-a"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { await expect(result.current.changeBinding(codex)).resolves.toEqual(codex); });
    expect(result.current.binding).toEqual(codex);
    expect(mocks.update).toHaveBeenCalledOnce();
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it("blocks further work when the update result cannot be determined, until a read succeeds", async () => {
    mocks.fetch.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(codex);
    mocks.update.mockRejectedValue(new Error("response lost"));
    const { result } = renderHook(() => useVideoModelBinding("video-a"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { await expect(result.current.changeBinding(codex)).rejects.toThrow("结果暂时无法确认"); });
    expect(result.current.error).toContain("重新读取");
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.binding).toEqual(codex));
    expect(result.current.error).toBeNull();
    expect(mocks.update).toHaveBeenCalledOnce();
  });

  it("does not overwrite a different video when an older update completes late", async () => {
    let complete!: (value: typeof codex) => void;
    mocks.fetch.mockResolvedValueOnce(null).mockResolvedValueOnce(api);
    mocks.update.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    const { result, rerender } = renderHook(({ chat }) => useVideoModelBinding(chat), { initialProps: { chat: "video-a" } });
    await waitFor(() => expect(result.current.loading).toBe(false));
    let pending!: Promise<unknown>;
    act(() => { pending = result.current.changeBinding(codex); });
    rerender({ chat: "video-b" });
    await waitFor(() => expect(result.current.binding).toEqual(api));
    await act(async () => { complete(codex); await pending; });
    expect(result.current.binding).toEqual(api);
  });
});
