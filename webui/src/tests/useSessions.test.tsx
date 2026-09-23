import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  conversationListStatus,
  sessionTitle,
  useSessionHistory,
  useSessions,
} from "@/hooks/useSessions";
import * as api from "@/lib/api";
import { ClientProvider } from "@/providers/ClientProvider";
import type { ConnectionStatus } from "@/lib/types";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    listSessions: vi.fn(),
    deleteSession: vi.fn(),
    fetchWebuiThread: vi.fn(),
  };
});

function fakeClient() {
  const sessionUpdateHandlers = new Set<(chatId: string, scope?: string) => void>();
  const statusHandlers = new Set<(status: ConnectionStatus) => void>();
  let currentStatus: ConnectionStatus = "open";
  return {
    get status() {
      return currentStatus;
    },
    defaultChatId: null as string | null,
    onStatus: (handler: (status: ConnectionStatus) => void) => {
      statusHandlers.add(handler);
      handler(currentStatus);
      return () => statusHandlers.delete(handler);
    },
    onError: () => () => {},
    onChat: () => () => {},
    getRunStartedAt: () => null,
    onSessionUpdate: (handler: (chatId: string, scope?: string) => void) => {
      sessionUpdateHandlers.add(handler);
      return () => sessionUpdateHandlers.delete(handler);
    },
    emitSessionUpdate: (chatId: string, scope?: string) => {
      for (const handler of sessionUpdateHandlers) handler(chatId, scope);
    },
    emitStatus: (status: ConnectionStatus) => {
      currentStatus = status;
      for (const handler of statusHandlers) handler(status);
    },
    sendMessage: vi.fn(),
    newChat: vi.fn(),
    branchChat: vi.fn(),
    attach: vi.fn(),
    connect: vi.fn(),
    close: vi.fn(),
    updateUrl: vi.fn(),
  };
}

function wrap(client: ReturnType<typeof fakeClient>) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <ClientProvider
        client={client as unknown as import("@/lib/mona-client").MonaClient}
        token="tok"
      >
        {children}
      </ClientProvider>
    );
  };
}

describe("useSessions", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.mocked(api.listSessions).mockReset();
    vi.mocked(api.deleteSession).mockReset();
    vi.mocked(api.fetchWebuiThread).mockReset();
  });

  it("does not report the session list loaded before an authoritative response", async () => {
    let resolve: ((rows: import("@/lib/types").ChatSummary[]) => void) | undefined;
    vi.mocked(api.listSessions).mockImplementationOnce(
      () => new Promise((done) => { resolve = done; }),
    );

    const { result } = renderHook(() => useSessions(), {
      wrapper: wrap(fakeClient()),
    });

    await waitFor(() => expect(api.listSessions).toHaveBeenCalledTimes(1));
    expect(result.current.loading).toBe(true);
    expect(result.current.loaded).toBe(false);

    await act(async () => {
      resolve?.([]);
    });

    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.loading).toBe(false);
  });

  it("retries a transient session-list failure with a finite backoff", async () => {
    vi.useFakeTimers();
    vi.mocked(api.listSessions).mockRejectedValue(new Error("temporarily unavailable"));

    const { result } = renderHook(() => useSessions(), {
      wrapper: wrap(fakeClient()),
    });

    await act(async () => {
      await Promise.resolve();
      await vi.runAllTimersAsync();
    });

    expect(api.listSessions).toHaveBeenCalledTimes(4);
    expect(result.current.loaded).toBe(false);
    expect(result.current.error).toBe("temporarily unavailable");
  });

  it("does not use low-information greetings as fallback session titles", () => {
    expect(sessionTitle({
      key: "websocket:chat-hi",
      channel: "websocket",
      chatId: "chat-hi",
      createdAt: "2026-04-16T10:00:00Z",
      updatedAt: "2026-04-16T10:00:00Z",
      title: "",
      preview: "hi",
    })).toBe("New chat");

    expect(sessionTitle({
      key: "websocket:chat-work",
      channel: "websocket",
      chatId: "chat-work",
      createdAt: "2026-04-16T10:00:00Z",
      updatedAt: "2026-04-16T10:00:00Z",
      title: "",
      preview: "帮我优化 WebUI 性能",
    })).toBe("帮我优化 WebUI 性能");
  });

  it("removes a session from the local list after delete succeeds", async () => {
    vi.mocked(api.listSessions).mockResolvedValue([
      {
        key: "websocket:chat-a",
        channel: "websocket",
        chatId: "chat-a",
        createdAt: "2026-04-16T10:00:00Z",
        updatedAt: "2026-04-16T10:00:00Z",
        preview: "Alpha",
      },
      {
        key: "websocket:chat-b",
        channel: "websocket",
        chatId: "chat-b",
        createdAt: "2026-04-16T11:00:00Z",
        updatedAt: "2026-04-16T11:00:00Z",
        preview: "Beta",
      },
    ]);
    vi.mocked(api.deleteSession).mockResolvedValue(true);

    const { result } = renderHook(() => useSessions(), {
      wrapper: wrap(fakeClient()),
    });

    await waitFor(() => expect(result.current.sessions).toHaveLength(2));

    await act(async () => {
      await result.current.deleteChat("websocket:chat-a");
    });

    expect(api.deleteSession).toHaveBeenCalledWith("tok", "websocket:chat-a");
    expect(result.current.sessions.map((s) => s.key)).toEqual(["websocket:chat-b"]);
  });

  it("refreshes sessions when the websocket reports a session update", async () => {
    vi.mocked(api.listSessions)
      .mockResolvedValueOnce([
      {
        key: "websocket:chat-a",
        channel: "websocket",
        chatId: "chat-a",
        createdAt: "2026-04-16T10:00:00Z",
        updatedAt: "2026-04-16T10:00:00Z",
        preview: "第一条回复",
        previewAt: "2026-04-16T10:00:00Z",
      },
      ])
      .mockResolvedValueOnce([
        {
          key: "websocket:chat-a",
          channel: "websocket",
          chatId: "chat-a",
          createdAt: "2026-04-16T10:00:00Z",
          updatedAt: "2026-04-16T10:01:00Z",
          title: "生成的小标题",
          preview: "第二条专业 Agent 回复",
          previewAt: "2026-04-16T10:01:00Z",
          previewAuthorType: "agent",
          previewAuthorId: "com.mona.a-share-analyst",
        },
      ]);
    const client = fakeClient();

    const { result } = renderHook(() => useSessions(), {
      wrapper: wrap(client),
    });

    await waitFor(() => expect(result.current.sessions[0]?.title).toBeUndefined());

    act(() => {
      client.emitSessionUpdate("chat-a");
    });

    await waitFor(() => expect(result.current.sessions[0]?.title).toBe("生成的小标题"));
    expect(result.current.sessions[0]?.preview).toBe("第二条专业 Agent 回复");
    expect(result.current.sessions[0]?.previewAuthorId).toBe("com.mona.a-share-analyst");
    expect(api.listSessions).toHaveBeenCalledTimes(2);
  });

  it("refreshes sessions after the websocket reconnects", async () => {
    vi.mocked(api.listSessions)
      .mockResolvedValueOnce([
        {
          key: "websocket:chat-a",
          channel: "websocket",
          chatId: "chat-a",
          createdAt: "2026-04-16T10:00:00Z",
          updatedAt: "2026-04-16T10:00:00Z",
          preview: "第一条回复",
        },
      ])
      .mockResolvedValueOnce([
        {
          key: "websocket:chat-a",
          channel: "websocket",
          chatId: "chat-a",
          createdAt: "2026-04-16T10:00:00Z",
          updatedAt: "2026-04-16T10:01:00Z",
          title: "重连后刷新标题",
          preview: "最新回复",
        },
      ]);
    const client = fakeClient();

    const { result } = renderHook(() => useSessions(), {
      wrapper: wrap(client),
    });

    await waitFor(() => expect(result.current.sessions[0]?.title).toBeUndefined());

    act(() => {
      client.emitStatus("reconnecting");
      client.emitStatus("open");
    });

    await waitFor(() => expect(result.current.sessions[0]?.title).toBe("重连后刷新标题"));
    expect(api.listSessions).toHaveBeenCalledTimes(2);
  });

  it("keeps a newly created chat visible until the server session list catches up", async () => {
    vi.mocked(api.listSessions)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          key: "websocket:chat-new",
          channel: "websocket",
          chatId: "chat-new",
          createdAt: "2026-05-20T10:00:00Z",
          updatedAt: "2026-05-20T10:01:00Z",
          title: "Generated title",
          preview: "First message",
        },
      ]);
    const client = fakeClient();
    client.newChat.mockResolvedValue("chat-new");

    const { result } = renderHook(() => useSessions(), {
      wrapper: wrap(client),
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.sessions).toEqual([]);

    await act(async () => {
      await result.current.createChat();
    });

    expect(result.current.sessions.map((s) => s.key)).toEqual(["websocket:chat-new"]);

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.sessions.map((s) => s.key)).toEqual(["websocket:chat-new"]);
    expect(result.current.sessions[0]?.preview).toBe("");

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.sessions.map((s) => s.key)).toEqual(["websocket:chat-new"]);
    expect(result.current.sessions[0]?.preview).toBe("First message");
    expect(result.current.sessions[0]?.title).toBe("Generated title");
  });

  it("keeps a newly branched chat visible while the session list catches up", async () => {
    vi.mocked(api.listSessions).mockResolvedValue([]);
    const client = fakeClient();
    client.branchChat.mockResolvedValue("chat-branch");
    const { result } = renderHook(() => useSessions(), { wrapper: wrap(client) });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.branchChat("chat-source", 2, "task-2");
    });

    expect(client.branchChat).toHaveBeenCalledWith("chat-source", 2, "task-2");
    expect(result.current.sessions[0]?.key).toBe("websocket:chat-branch");
  });

  it("passes through WebUI transcript user media as images and media", async () => {
    vi.mocked(api.fetchWebuiThread).mockResolvedValue({
      schemaVersion: 3,
      messages: [
        {
          id: "u1",
          role: "user",
          content: "what's this?",
          createdAt: 1,
          images: [
            { url: "/api/media/sig-1/payload-1", name: "snap.png" },
            { url: "/api/media/sig-2/payload-2", name: "diag.jpg" },
          ],
          media: [
            { kind: "image", url: "/api/media/sig-1/payload-1", name: "snap.png" },
            { kind: "image", url: "/api/media/sig-2/payload-2", name: "diag.jpg" },
          ],
        },
        { id: "a1", role: "assistant", content: "it's a cat", createdAt: 2 },
        { id: "u2", role: "user", content: "follow-up without images", createdAt: 3 },
      ],
    });

    const { result } = renderHook(() => useSessionHistory("websocket:chat-media"), {
      wrapper: wrap(fakeClient()),
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    const [first, second, third] = result.current.messages;
    expect(first.role).toBe("user");
    expect(first.images).toEqual([
      { url: "/api/media/sig-1/payload-1", name: "snap.png" },
      { url: "/api/media/sig-2/payload-2", name: "diag.jpg" },
    ]);
    expect(first.media).toEqual([
      { kind: "image", url: "/api/media/sig-1/payload-1", name: "snap.png" },
      { kind: "image", url: "/api/media/sig-2/payload-2", name: "diag.jpg" },
    ]);
    expect(second.role).toBe("assistant");
    expect(second.images).toBeUndefined();
    expect(third.role).toBe("user");
    expect(third.images).toBeUndefined();
  });

  it("passes through assistant video media from transcript replay", async () => {
    vi.mocked(api.fetchWebuiThread).mockResolvedValue({
      schemaVersion: 3,
      messages: [
        {
          id: "a1",
          role: "assistant",
          content: "clip ready",
          createdAt: 1,
          media: [{ kind: "video", url: "/api/media/sig-v/payload-v", name: "clip.mp4" }],
        },
      ],
    });

    const { result } = renderHook(() => useSessionHistory("websocket:chat-video"), {
      wrapper: wrap(fakeClient()),
    });

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.messages[0]!.role).toBe("assistant");
    expect(result.current.messages[0]!.images).toBeUndefined();
    expect(result.current.messages[0]!.media).toEqual([
      { kind: "video", url: "/api/media/sig-v/payload-v", name: "clip.mp4" },
    ]);
  });

  it("passes through assistant reasoning from transcript replay", async () => {
    vi.mocked(api.fetchWebuiThread).mockResolvedValue({
      schemaVersion: 3,
      messages: [
        {
          id: "a1",
          role: "assistant",
          content: "final answer",
          createdAt: 1,
          reasoning: "hidden but persisted reasoning",
        },
      ],
    });

    const { result } = renderHook(() => useSessionHistory("websocket:chat-reasoning"), {
      wrapper: wrap(fakeClient()),
    });

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0]!.role).toBe("assistant");
    expect(result.current.messages[0]!.content).toBe("final answer");
    expect(result.current.messages[0]!.reasoning).toBe("hidden but persisted reasoning");
  });

  it("accepts transcript rows produced by the server replay reducer", async () => {
    vi.mocked(api.fetchWebuiThread).mockResolvedValue({
      schemaVersion: 3,
      messages: [
        { id: "u1", role: "user", content: "research this", createdAt: 1 },
        {
          id: "t1",
          role: "tool",
          kind: "trace",
          content: "web_fetch({})",
          traces: ["web_search({\"query\":\"agents\"})", "web_fetch({\"url\":\"https://example.com\"})"],
          createdAt: 2,
        },
        { id: "a1", role: "assistant", content: "summary", createdAt: 3 },
      ],
    });

    const { result } = renderHook(() => useSessionHistory("websocket:chat-tools"), {
      wrapper: wrap(fakeClient()),
    });

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.messages.map((m) => m.role)).toEqual(["user", "tool", "assistant"]);
    const trace = result.current.messages[1]!;
    expect(trace.kind).toBe("trace");
    expect(trace.traces).toEqual([
      "web_search({\"query\":\"agents\"})",
      "web_fetch({\"url\":\"https://example.com\"})",
    ]);
    expect(result.current.messages[2]!.content).toBe("summary");
  });

  it("flags transcript ending with a trace row as pending", async () => {
    vi.mocked(api.fetchWebuiThread).mockResolvedValue({
      schemaVersion: 3,
      messages: [
        {
          id: "t1",
          role: "tool",
          kind: "trace",
          content: "Using 2 tools",
          traces: ["Using 2 tools"],
          createdAt: 1,
        },
      ],
    });

    const { result } = renderHook(() => useSessionHistory("websocket:chat-pending"), {
      wrapper: wrap(fakeClient()),
    });

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.hasPendingToolCalls).toBe(true);
  });

  it("does not flag transcript as pending when last row is not a trace", async () => {
    vi.mocked(api.fetchWebuiThread).mockResolvedValue({
      schemaVersion: 3,
      messages: [
        { id: "a1", role: "assistant", content: "All done", createdAt: 1 },
      ],
    });

    const { result } = renderHook(() => useSessionHistory("websocket:chat-done"), {
      wrapper: wrap(fakeClient()),
    });

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.hasPendingToolCalls).toBe(false);
  });

  it("treats missing transcript (404) as empty history", async () => {
    vi.mocked(api.fetchWebuiThread).mockResolvedValue(null);

    const { result } = renderHook(() => useSessionHistory("websocket:new-chat"), {
      wrapper: wrap(fakeClient()),
    });

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.messages).toEqual([]);
    expect(result.current.missing).toBe(true);
    expect(result.current.hasPendingToolCalls).toBe(false);
  });

  it("keeps transcript request failures distinct from missing history", async () => {
    vi.mocked(api.fetchWebuiThread).mockRejectedValue(new api.ApiError(500, "HTTP 500"));

    const { result } = renderHook(() => useSessionHistory("websocket:broken"), {
      wrapper: wrap(fakeClient()),
    });

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.messages).toEqual([]);
    expect(result.current.missing).toBe(false);
    expect(result.current.error).toBe("HTTP 500");
  });

  it("requests a bounded first page and prepends older pages in transcript order", async () => {
    vi.mocked(api.fetchWebuiThread)
      .mockResolvedValueOnce({
        schemaVersion: 3,
        messages: [
          { id: "u3", role: "user", content: "third", createdAt: 3, historyPosition: 2 },
          { id: "a3", role: "assistant", content: "answer", createdAt: 4, historyPosition: 3, assistantOrdinal: 2 },
        ],
        pagination: { hasMore: true, before: 2, revision: "rev-1", total: 4 },
      })
      .mockResolvedValueOnce({
        schemaVersion: 3,
        messages: [
          { id: "u1", role: "user", content: "first", createdAt: 1, historyPosition: 0 },
          { id: "a1", role: "assistant", content: "reply", createdAt: 2, historyPosition: 1, assistantOrdinal: 1 },
        ],
        pagination: { hasMore: false, before: null, revision: "rev-1", total: 4 },
      });

    const { result } = renderHook(() => useSessionHistory("websocket:chat-paged", 2), {
      wrapper: wrap(fakeClient()),
    });

    await waitFor(() => expect(result.current.messages.map((message) => message.id)).toEqual(["u3", "a3"]));
    expect(api.fetchWebuiThread).toHaveBeenNthCalledWith(
      1,
      "tok",
      "websocket:chat-paged",
      undefined,
      expect.objectContaining({ limit: 2, signal: expect.any(AbortSignal) }),
    );
    let added = false;
    await act(async () => {
      added = await result.current.loadEarlier();
    });

    expect(added).toBe(true);
    expect(result.current.messages.map((message) => message.id)).toEqual(["u1", "a1", "u3", "a3"]);
    expect(result.current.hasMore).toBe(false);
    expect(result.current.messages[1]?.assistantOrdinal).toBe(1);
    expect(api.fetchWebuiThread).toHaveBeenNthCalledWith(
      2,
      "tok",
      "websocket:chat-paged",
      undefined,
      expect.objectContaining({ limit: 2, before: 2, revision: "rev-1" }),
    );
  });

  it("keeps the earliest loaded cursor when refreshing within the same revision", async () => {
    vi.mocked(api.fetchWebuiThread)
      .mockResolvedValueOnce({
        schemaVersion: 3,
        messages: [
          { id: "m3", role: "user", content: "three", createdAt: 3, historyPosition: 3 },
          { id: "m4", role: "assistant", content: "four", createdAt: 4, historyPosition: 4 },
        ],
        pagination: { hasMore: true, before: 3, revision: "rev-1", total: 5 },
      })
      .mockResolvedValueOnce({
        schemaVersion: 3,
        messages: [
          { id: "m1", role: "user", content: "one", createdAt: 1, historyPosition: 1 },
          { id: "m2", role: "assistant", content: "two", createdAt: 2, historyPosition: 2 },
        ],
        pagination: { hasMore: true, before: 1, revision: "rev-1", total: 5 },
      })
      .mockResolvedValueOnce({
        schemaVersion: 3,
        messages: [
          { id: "m3", role: "user", content: "three", createdAt: 3, historyPosition: 3 },
          { id: "m4", role: "assistant", content: "four", createdAt: 4, historyPosition: 4 },
        ],
        pagination: { hasMore: true, before: 3, revision: "rev-1", total: 5 },
      })
      .mockResolvedValueOnce({
        schemaVersion: 3,
        messages: [{ id: "m0", role: "user", content: "zero", createdAt: 0, historyPosition: 0 }],
        pagination: { hasMore: false, before: null, revision: "rev-1", total: 5 },
      });

    const { result } = renderHook(() => useSessionHistory("websocket:chat-cursor", 2), {
      wrapper: wrap(fakeClient()),
    });
    await waitFor(() => expect(result.current.messages.map((message) => message.id)).toEqual(["m3", "m4"]));
    await act(async () => {
      await result.current.loadEarlier();
    });
    await waitFor(() => expect(result.current.messages.map((message) => message.id)).toEqual(["m1", "m2", "m3", "m4"]));

    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.loadEarlier();
    });

    expect(api.fetchWebuiThread).toHaveBeenNthCalledWith(
      4,
      "tok",
      "websocket:chat-cursor",
      undefined,
      expect.objectContaining({ limit: 2, before: 1, revision: "rev-1" }),
    );
    expect(result.current.messages.map((message) => message.id)).toEqual(["m0", "m1", "m2", "m3", "m4"]);
  });

  it("does not apply a slow history response after switching sessions", async () => {
    let resolveOld: ((value: Awaited<ReturnType<typeof api.fetchWebuiThread>>) => void) | undefined;
    vi.mocked(api.fetchWebuiThread).mockImplementation((_token, key) => {
      if (key === "websocket:chat-old") {
        return new Promise((resolve) => { resolveOld = resolve; });
      }
      return Promise.resolve({
        schemaVersion: 3,
        messages: [{ id: "new", role: "user", content: "new session", createdAt: 2 }],
      });
    });
    const { result, rerender } = renderHook(
      ({ sessionKey }) => useSessionHistory(sessionKey, 160),
      { initialProps: { sessionKey: "websocket:chat-old" }, wrapper: wrap(fakeClient()) },
    );

    await waitFor(() => expect(api.fetchWebuiThread).toHaveBeenCalledTimes(1));
    rerender({ sessionKey: "websocket:chat-new" });
    await waitFor(() => expect(result.current.messages[0]?.content).toBe("new session"));

    await act(async () => {
      resolveOld?.({
        schemaVersion: 3,
        messages: [{ id: "old", role: "user", content: "old session", createdAt: 1 }],
      });
    });

    expect(result.current.messages.map((message) => message.id)).toEqual(["new"]);
  });

  it("recovers a stale page revision by reloading the latest page", async () => {
    vi.mocked(api.fetchWebuiThread)
      .mockResolvedValueOnce({
        schemaVersion: 3,
        messages: [{ id: "old-head", role: "user", content: "old", createdAt: 2, historyPosition: 1 }],
        pagination: { hasMore: true, before: 1, revision: "rev-1", total: 2 },
      })
      .mockRejectedValueOnce(new api.ApiError(409, "stale revision"))
      .mockResolvedValueOnce({
        schemaVersion: 3,
        messages: [{ id: "new-head", role: "user", content: "new", createdAt: 3, historyPosition: 2 }],
        pagination: { hasMore: true, before: 2, revision: "rev-2", total: 3 },
      });

    const { result } = renderHook(() => useSessionHistory("websocket:chat-stale", 1), {
      wrapper: wrap(fakeClient()),
    });
    await waitFor(() => expect(result.current.hasMore).toBe(true));

    await act(async () => {
      expect(await result.current.loadEarlier()).toBe(false);
    });

    expect(result.current.messages.map((message) => message.id)).toEqual(["new-head"]);
    expect(result.current.hasMore).toBe(true);
    expect(result.current.earlierError).toContain("会话记录已更新");
    expect(api.fetchWebuiThread).toHaveBeenNthCalledWith(
      3,
      "tok",
      "websocket:chat-stale",
      undefined,
      expect.objectContaining({ limit: 1, signal: expect.any(AbortSignal) }),
    );
  });

  it("replaces the canonical tail on a new revision and clears full-history state", async () => {
    vi.mocked(api.fetchWebuiThread)
      .mockResolvedValueOnce({
        schemaVersion: 3,
        messages: [
          { id: "old-middle", role: "assistant", content: "middle", createdAt: 2, historyPosition: 1 },
          { id: "old-tail", role: "assistant", content: "old", createdAt: 3, historyPosition: 2 },
        ],
        pagination: { hasMore: true, before: 1, revision: "rev-1", total: 3 },
      })
      .mockResolvedValueOnce({
        schemaVersion: 3,
        messages: [
          { id: "old-prefix", role: "user", content: "prefix", createdAt: 1, historyPosition: 0 },
          { id: "old-middle", role: "assistant", content: "middle", createdAt: 2, historyPosition: 1 },
          { id: "old-tail", role: "assistant", content: "old", createdAt: 3, historyPosition: 2 },
        ],
        pagination: { hasMore: false, before: null, revision: "rev-1", total: 3 },
      })
      .mockResolvedValueOnce({
        schemaVersion: 3,
        messages: [
          { id: "new-tail", role: "assistant", content: "new", createdAt: 4, historyPosition: 2 },
          { id: "latest", role: "user", content: "latest", createdAt: 5, historyPosition: 3 },
        ],
        pagination: { hasMore: true, before: 2, revision: "rev-2", total: 4 },
      });

    const { result } = renderHook(() => useSessionHistory("websocket:chat-refresh", 2), {
      wrapper: wrap(fakeClient()),
    });
    await waitFor(() => expect(result.current.hasMore).toBe(true));
    await act(async () => {
      await result.current.loadAllHistory();
    });
    expect(result.current.hasMore).toBe(false);

    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.messages.some((message) => message.id === "latest")).toBe(true));

    expect(result.current.messages.map((message) => message.id)).toEqual([
      "new-tail",
      "latest",
    ]);
    expect(result.current.hasMore).toBe(true);
    expect(result.current.fullHistoryLoading).toBe(false);
  });

  it("does not carry full-history state when switching to a longer session", async () => {
    vi.mocked(api.fetchWebuiThread)
      .mockResolvedValueOnce({
        schemaVersion: 3,
        messages: [{ id: "small", role: "user", content: "small", createdAt: 1 }],
        pagination: { hasMore: false, before: null, revision: "small-rev", total: 1 },
      })
      .mockResolvedValueOnce({
        schemaVersion: 3,
        messages: [{ id: "large-tail", role: "user", content: "large", createdAt: 2, historyPosition: 1 }],
        pagination: { hasMore: true, before: 1, revision: "large-rev", total: 2 },
      });
    const { result, rerender } = renderHook(
      ({ sessionKey }) => useSessionHistory(sessionKey, 160),
      { initialProps: { sessionKey: "websocket:small" }, wrapper: wrap(fakeClient()) },
    );

    await waitFor(() => expect(result.current.hasMore).toBe(false));
    rerender({ sessionKey: "websocket:large" });
    await waitFor(() => expect(result.current.messages[0]?.id).toBe("large-tail"));

    expect(result.current.hasMore).toBe(true);
  });

  it("keeps the session in the list when delete fails", async () => {
    vi.mocked(api.listSessions).mockResolvedValue([
      {
        key: "websocket:chat-a",
        channel: "websocket",
        chatId: "chat-a",
        createdAt: "2026-04-16T10:00:00Z",
        updatedAt: "2026-04-16T10:00:00Z",
        preview: "Alpha",
      },
    ]);
    vi.mocked(api.deleteSession).mockRejectedValue(new Error("boom"));

    const { result } = renderHook(() => useSessions(), {
      wrapper: wrap(fakeClient()),
    });

    await waitFor(() => expect(result.current.sessions).toHaveLength(1));

    await expect(
      act(async () => {
        await result.current.deleteChat("websocket:chat-a");
      }),
    ).rejects.toThrow("boom");

    expect(result.current.sessions.map((s) => s.key)).toEqual(["websocket:chat-a"]);
  });

  it("coalesces a burst of session updates into one trailing refresh", async () => {
    // IM plan 12.5: rapid session_updated events merge into the in-flight
    // refresh plus at most one follow-up, never one request per event.
    let resolveFirst: ((rows: unknown[]) => void) | null = null;
    vi.mocked(api.listSessions)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve as (rows: unknown[]) => void;
          }),
      )
      .mockResolvedValue([]);
    const client = fakeClient();

    const { result } = renderHook(() => useSessions(), {
      wrapper: wrap(client),
    });

    // The initial refresh is in flight; events arriving during it must queue
    // a single trailing refresh instead of starting concurrent requests.
    await waitFor(() => expect(api.listSessions).toHaveBeenCalledTimes(1));
    act(() => {
      client.emitSessionUpdate("chat-a");
      client.emitSessionUpdate("chat-b");
      client.emitSessionUpdate("chat-c");
    });
    expect(api.listSessions).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirst?.([]);
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(api.listSessions).toHaveBeenCalledTimes(2);

    // No further refresh fires once the queue has drained.
    await act(async () => {
      await Promise.resolve();
    });
    expect(api.listSessions).toHaveBeenCalledTimes(2);
  });
});

describe("conversationListStatus", () => {
  it("prioritizes waiting approval over other attention states", () => {
    expect(
      conversationListStatus({
        waitingApproval: true,
        workflowRunStatus: "waiting_approval",
        scheduled: true,
      }),
    ).toBe("waiting_approval");
    expect(
      conversationListStatus({
        waitingApproval: false,
        workflowRunStatus: "failed",
        scheduled: true,
      }),
    ).toBe("failed");
    expect(
      conversationListStatus({
        waitingApproval: false,
        workflowRunStatus: "running",
        scheduled: true,
      }),
    ).toBe("running");
    expect(
      conversationListStatus({
        waitingApproval: false,
        workflowRunStatus: "queued",
        scheduled: true,
      }),
    ).toBe("running");
    // An in-flight websocket turn also counts as running.
    expect(
      conversationListStatus({
        waitingApproval: false,
        workflowRunStatus: "succeeded",
        runStartedAt: 1_700_000_000,
        scheduled: true,
      }),
    ).toBe("running");
    expect(
      conversationListStatus({
        waitingApproval: false,
        workflowRunStatus: "succeeded",
        scheduled: true,
      }),
    ).toBe("scheduled");
    expect(
      conversationListStatus({
        waitingApproval: false,
        workflowRunStatus: "succeeded",
        scheduled: false,
      }),
    ).toBeNull();
    expect(
      conversationListStatus({
        waitingApproval: false,
        workflowRunStatus: null,
        scheduled: false,
      }),
    ).toBeNull();
  });
});
