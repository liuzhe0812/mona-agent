import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useSessionHistory, useSessions } from "@/hooks/useSessions";
import { useMonaStream } from "@/hooks/useMonaStream";
import * as api from "@/lib/api";
import { MonaClient } from "@/lib/mona-client";
import type { ChatSummary, WebuiThreadPersistedPayload } from "@/lib/types";
import { ClientProvider } from "@/providers/ClientProvider";

vi.mock("@/lib/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/api")>(),
  listSessions: vi.fn(),
  deleteSession: vi.fn(),
  fetchWebuiThread: vi.fn(),
}));

type DeletionClient = MonaClient & {
  forgetDeletedChat: (chatId: string) => void;
  isChatDeleted: (chatId: string) => boolean;
  onSessionDeleted: (handler: (chatId: string) => void) => () => void;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function summary(chatId: string): ChatSummary {
  return {
    key: `websocket:${chatId}`, channel: "websocket", chatId,
    createdAt: null, updatedAt: null, preview: chatId,
  };
}

function history(id: string, hasMore = false): WebuiThreadPersistedPayload {
  return {
    schemaVersion: 3,
    messages: [{ id, role: "user", content: id, createdAt: 1, historyPosition: hasMore ? 1 : 0 }],
    pagination: { hasMore, before: hasMore ? 1 : null, revision: "revision-a", total: hasMore ? 2 : 1 },
  };
}

/** Isolate the hooks' deletion notification contract from the socket implementation. */
function hookClient() {
  const deleted = new Set<string>();
  const handlers = new Set<(chatId: string) => void>();
  return {
    status: "open", defaultChatId: null,
    onStatus: () => () => {}, onSessionUpdate: () => () => {},
    onSessionDeleted: (handler: (chatId: string) => void) => {
      handlers.add(handler);
      return () => { handlers.delete(handler); };
    },
    isChatDeleted: (chatId: string) => deleted.has(chatId),
    forgetDeletedChat: vi.fn((chatId: string) => {
      if (deleted.has(chatId)) return;
      deleted.add(chatId);
      for (const handler of handlers) handler(chatId);
    }),
  };
}

function wrapper(client: ReturnType<typeof hookClient>) {
  return ({ children }: { children: ReactNode }) => (
    <ClientProvider client={client as unknown as MonaClient} token="token" runtimeStatus="ready">
      {children}
    </ClientProvider>
  );
}

beforeEach(() => {
  vi.mocked(api.listSessions).mockReset();
  vi.mocked(api.deleteSession).mockReset();
  vi.mocked(api.fetchWebuiThread).mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("confirmed session deletion in useSessions", () => {
  it.each([true, false])("forgets only after HTTP confirms absence (deleted=%s)", async (deleted) => {
    const client = hookClient();
    const response = deferred<boolean>();
    vi.mocked(api.listSessions).mockResolvedValue([summary("a"), summary("b")]);
    vi.mocked(api.deleteSession).mockReturnValue(response.promise);
    const { result } = renderHook(() => useSessions(), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.sessions).toHaveLength(2));

    let deletion!: Promise<void>;
    act(() => { deletion = result.current.deleteChat("websocket:a"); });
    expect(client.forgetDeletedChat).not.toHaveBeenCalled();
    expect(result.current.sessions).toHaveLength(2);

    await act(async () => { response.resolve(deleted); await deletion; });
    expect(client.forgetDeletedChat).toHaveBeenCalledTimes(1);
    expect(client.forgetDeletedChat).toHaveBeenCalledWith("a");
    expect(result.current.sessions.map((row) => row.chatId)).toEqual(["b"]);
  });

  it("preserves callbacks and cached selection when HTTP deletion fails", async () => {
    const client = hookClient();
    vi.mocked(api.listSessions).mockResolvedValue([summary("a"), summary("b")]);
    vi.mocked(api.deleteSession).mockRejectedValue(new Error("delete result unavailable"));
    const { result } = renderHook(() => useSessions(), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.sessions).toHaveLength(2));
    await act(async () => {
      await expect(result.current.deleteChat("websocket:a")).rejects.toThrow("delete result unavailable");
    });
    expect(client.forgetDeletedChat).not.toHaveBeenCalled();
    expect(result.current.sessions.map((row) => row.chatId)).toEqual(["a", "b"]);
  });

  it("cleans only successful IDs from a partially failed batch", async () => {
    const client = hookClient();
    vi.mocked(api.listSessions).mockResolvedValue([summary("a"), summary("b")]);
    vi.mocked(api.deleteSession).mockImplementation((_token, key) => key === "websocket:a"
      ? Promise.resolve(true) : Promise.reject(new Error("b unavailable")));
    const { result } = renderHook(() => useSessions(), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.sessions).toHaveLength(2));
    await act(async () => {
      await Promise.allSettled([result.current.deleteChat("websocket:a"), result.current.deleteChat("websocket:b")]);
    });
    expect(client.forgetDeletedChat).toHaveBeenCalledTimes(1);
    expect(client.forgetDeletedChat).toHaveBeenCalledWith("a");
    expect(result.current.sessions.map((row) => row.chatId)).toEqual(["b"]);
  });

  it("does not restore a deleted row from a list response already in flight", async () => {
    const client = hookClient();
    const stale = deferred<ChatSummary[]>();
    const otherChannel = { ...summary("a"), key: "telegram:a", channel: "telegram" };
    const rows = [summary("a"), summary("b"), otherChannel];
    vi.mocked(api.listSessions).mockResolvedValueOnce(rows).mockReturnValueOnce(stale.promise);
    vi.mocked(api.deleteSession).mockResolvedValue(true);
    const { result } = renderHook(() => useSessions(), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.sessions).toHaveLength(3));
    act(() => { void result.current.refresh(); });
    await waitFor(() => expect(api.listSessions).toHaveBeenCalledTimes(2));
    await act(async () => { await result.current.deleteChat("websocket:a"); });
    await act(async () => { stale.resolve(rows); });
    expect(result.current.sessions.map((row) => row.key)).toEqual(["websocket:b", "telegram:a"]);
  });
});

class Socket {
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = 3; this.onclose?.(); }
  open() { this.readyState = 1; this.onopen?.(); }
  message(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) } as MessageEvent); }
  frames(): Array<Record<string, unknown>> { return this.sent.map((item) => JSON.parse(item)); }
}

describe("MonaClient confirmed deletion lifecycle", () => {
  const clients: MonaClient[] = [];
  function connected(open = true) {
    const sockets: Socket[] = [];
    const client = new MonaClient({ url: "ws://fixture", socketFactory: () => {
      const socket = new Socket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    } }) as DeletionClient;
    clients.push(client);
    client.connect();
    if (open) sockets[0].open();
    return { client, sockets, socket: sockets[0] };
  }
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { for (const client of clients.splice(0)) client.close(); });

  it("clears A's snapshots and listeners without deleting remotely or affecting B", () => {
    const { client, socket } = connected();
    const a = vi.fn(); const b = vi.fn(); const deleted = vi.fn();
    client.onChat("a", a); client.onChat("b", b);
    client.onSessionDeleted(deleted);
    for (const id of ["a", "b"]) {
      socket.message({ event: "goal_status", chat_id: id, status: "running", started_at: 10, turn_id: `turn-${id}` });
      socket.message({ event: "goal_state", chat_id: id, goal_state: { objective: id } });
      socket.message({ event: "task_plan", chat_id: id, task_plan: { id, steps: [] } });
      socket.message({ event: "user_questions", chat_id: id, requests: [{ id: `question-${id}` }] });
    }
    socket.sent = [];
    client.forgetDeletedChat("a"); client.forgetDeletedChat("a");
    expect(deleted).toHaveBeenCalledTimes(1);
    expect(deleted).toHaveBeenCalledWith("a");
    expect(socket.sent).toEqual([]);
    expect(client.isChatDeleted("a")).toBe(true);
    expect(client.isChatDeleted("b")).toBe(false);
    expect(client.getRunStartedAt("a")).toBeNull();
    expect(client.getWorkTurn("a")).toBeUndefined();
    expect(client.getGoalState("a")).toBeUndefined();
    expect(client.getTaskPlan("a")).toBeUndefined();
    expect(client.getUserQuestions("a")).toEqual([]);
    expect(client.getRunStartedAt("b")).toBe(10);
    expect(client.getWorkTurn("b")?.turnId).toBe("turn-b");
    expect(client.getUserQuestions("b")).toHaveLength(1);
    a.mockClear(); b.mockClear();
    socket.message({ event: "delta", chat_id: "a", text: "late" });
    socket.message({ event: "delta", chat_id: "b", text: "live" });
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledOnce();
  });

  it("drops buffered replay and late global callbacks before they can recreate A", async () => {
    const { client, socket, sockets } = connected();
    const replay = vi.fn(); const late = vi.fn(); const uploads = vi.fn(); const updates = vi.fn();
    socket.message({ event: "ready", chat_id: "a" });
    socket.message({ event: "delta", chat_id: "a", text: "buffered" });
    client.onChat("a", replay);
    client.onChat("b", () => {});
    client.onDocUploadResult(uploads); client.onSessionUpdate(updates);
    client.forgetDeletedChat("a");
    await Promise.resolve();
    client.onChat("a", late);
    for (const event of [
      { event: "attached", chat_id: "a" },
      { event: "ready", chat_id: "a" },
      { event: "goal_status", chat_id: "a", status: "running", turn_id: "late-turn" },
      { event: "user_questions", chat_id: "a", requests: [{ id: "late-question" }] },
      { event: "session_updated", chat_id: "a" },
      { event: "doc_upload_result", chat_id: "a", ok: true, files: [] },
    ]) socket.message(event);
    expect(replay).not.toHaveBeenCalled(); expect(late).not.toHaveBeenCalled();
    expect(uploads).not.toHaveBeenCalled(); expect(updates).not.toHaveBeenCalled();
    expect(client.defaultChatId).not.toBe("a");
    expect(client.getWorkTurn("a")).toBeUndefined();
    expect(client.getUserQuestions("a")).toEqual([]);
    socket.close(); vi.advanceTimersByTime(500); sockets.at(-1)!.open();
    expect(sockets.at(-1)!.frames().filter((frame) => frame.chat_id === "a")).toEqual([]);
    expect(sockets.at(-1)!.frames()).toContainEqual({ type: "attach", chat_id: "b" });
  });

  it.each([false, true])("settles only A's RPC and drops queued A writes (dispatched=%s)", async (dispatched) => {
    const { client, socket } = connected(dispatched);
    let aState = "pending";
    const pendingA = client.answerUserQuestion("a", "qa", null).then(
      () => { aState = "resolved"; }, () => { aState = "rejected"; },
    );
    const pendingB = client.answerUserQuestion("b", "qb", null);
    const observedB = pendingB.then(() => "resolved", () => "rejected");
    client.sendMessage("a", "must not be replayed");
    client.sendMessage("b", "keep B's input");
    client.forgetDeletedChat("a");
    await Promise.resolve(); await Promise.resolve();
    expect(aState).toBe("rejected");
    await pendingA;
    if (!dispatched) socket.open();
    const frames = socket.frames();
    if (!dispatched) expect(frames.filter((frame) => frame.chat_id === "a")).toEqual([]);
    const bRequest = frames.find((frame) => frame.type === "answer_user_question" && frame.chat_id === "b")!;
    expect(bRequest).toBeDefined();
    expect(frames).toContainEqual(expect.objectContaining({ type: "message", chat_id: "b", content: "keep B's input" }));
    socket.message({ event: "answer_user_question_result", request_id: bRequest.request_id, ok: true });
    expect(await observedB).toBe("resolved");
    expect(aState).toBe("rejected");
  });

  it("releases A's admission timers and callbacks while B still receives its receipt", () => {
    const { client, socket } = connected();
    const a = vi.fn(); const b = vi.fn();
    client.sendMessage("a", "one", undefined, { inputId: "input-a", onAdmission: a });
    client.sendMessage("b", "two", undefined, { inputId: "input-b", onAdmission: b });
    client.forgetDeletedChat("a");
    a.mockClear();
    socket.message({ event: "message_accepted", chat_id: "a", input_id: "input-a" });
    socket.message({ event: "message_accepted", chat_id: "b", input_id: "input-b" });
    vi.advanceTimersByTime(16_000);
    expect(a).not.toHaveBeenCalled();
    expect(client.getMessageAdmission("a", "input-a")).toBeUndefined();
    expect(b).toHaveBeenLastCalledWith("accepted");
  });

  it("clears current stream work and ignores a captured late admission without clearing B", async () => {
    const { client, socket } = connected();
    const outgoing = vi.spyOn(client, "sendMessage");
    const admitted = vi.fn();
    let flush!: FrameRequestCallback;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { flush = callback; return 1; });
    const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    const empty: import("@/lib/types").UIMessage[] = [];
    const keepB: import("@/lib/types").UIMessage[] = [{ id: "b", role: "user", content: "keep B", createdAt: 1 }];
    const { result } = renderHook(() => ({ a: useMonaStream("a", empty), b: useMonaStream("b", keepB) }), {
      wrapper: ({ children }: { children: ReactNode }) => <ClientProvider client={client} token="token" runtimeStatus="ready">{children}</ClientProvider>,
    });
    act(() => {
      result.current.a.send("original A", undefined, { inputId: "input-a", onAdmission: admitted });
      socket.message({ event: "delta", chat_id: "a", text: "buffered A" });
    });
    const admission = outgoing.mock.calls[0][3]!.onAdmission!;
    act(() => client.forgetDeletedChat("a"));
    expect(cancel).toHaveBeenCalledWith(1);
    act(() => { admission("accepted"); flush(0); });
    expect(admitted).not.toHaveBeenCalled();
    expect(result.current.a.messages).toEqual([]);
    expect(result.current.a.isStreaming).toBe(false);
    expect(result.current.b.messages).toEqual(keepB);
    act(() => result.current.a.send("must not restart"));
    expect(outgoing).toHaveBeenCalledTimes(1);
    expect(socket.frames().filter((frame) => frame.type === "stop_work_turn")).toEqual([]);
    vi.restoreAllMocks();
  });
});

describe("deleted session history request boundaries", () => {
  it.each(["latest", "earlier", "full"] as const)("does not apply a late %s response or clear B", async (kind) => {
    const client = hookClient();
    const late = deferred<WebuiThreadPersistedPayload | null>();
    let aRequests = 0;
    let lateSignal: AbortSignal | undefined;
    vi.mocked(api.fetchWebuiThread).mockImplementation((_token, key, _base, options) => {
      if (key === "websocket:b") return Promise.resolve(history("keep-b"));
      aRequests += 1;
      if (kind !== "latest" && aRequests === 1) return Promise.resolve(history("a-tail", true));
      lateSignal = options?.signal;
      return late.promise;
    });
    const { result } = renderHook(() => ({
      a: useSessionHistory("websocket:a", 1), b: useSessionHistory("websocket:b", 1),
    }), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.b.messages[0]?.content).toBe("keep-b"));
    let loading: Promise<unknown> | undefined;
    if (kind !== "latest") {
      await waitFor(() => expect(result.current.a.hasMore).toBe(true));
      act(() => { loading = kind === "earlier" ? result.current.a.loadEarlier() : result.current.a.loadAllHistory(); });
    }
    await waitFor(() => expect(lateSignal).toBeDefined());
    act(() => client.forgetDeletedChat("a"));
    expect(lateSignal?.aborted).toBe(true);
    await act(async () => { late.resolve(history("late-a")); await loading; });
    expect(result.current.a.messages).toEqual([]);
    expect(result.current.a.loading).toBe(false);
    expect(result.current.a.error).toBeNull();
    expect(result.current.b.messages[0]?.content).toBe("keep-b");
    const requestsBeforeRefresh = aRequests;
    act(() => result.current.a.refresh());
    await act(async () => { await Promise.resolve(); });
    expect(aRequests).toBe(requestsBeforeRefresh);
  });
});
