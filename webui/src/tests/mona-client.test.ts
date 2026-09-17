import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MonaClient } from "@/lib/mona-client";

/**
 * Minimal fake WebSocket implementing the subset MonaClient touches.
 * Every instance is retrievable via ``FakeSocket.instances`` so tests can
 * drive open/close/message lifecycles deterministically.
 */
class FakeSocket {
  static instances: FakeSocket[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  url: string;
  readyState = FakeSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((ev?: { code?: number }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  }

  /** Simulate a server-initiated drop with a specific wire-level close code
   * (e.g. ``1009`` for Message Too Big). */
  fakeCloseWithCode(code: number) {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.({ code });
  }

  fakeOpen() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  fakeMessage(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent);
  }
}

function lastSocket(): FakeSocket {
  const s = FakeSocket.instances.at(-1);
  if (!s) throw new Error("no socket created yet");
  return s;
}

beforeEach(() => {
  FakeSocket.instances = [];
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("MonaClient", () => {
  it("starts and follows a persistent skill setup job", async () => {
    const client = new MonaClient({
      url: "ws://test",
      reconnect: false,
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    client.connect();
    lastSocket().fakeOpen();
    const pending = client.startAgentSkillSetup("agent.demo", "analysis-experiment");
    const request = JSON.parse(lastSocket().sent.at(-1) ?? "{}") as Record<string, string>;
    expect(request).toMatchObject({
      type: "agent_skill_setup_start",
      agent_id: "agent.demo",
      name: "analysis-experiment",
    });
    lastSocket().fakeMessage({
      event: "agent_skill_setup_start_result",
      ok: true,
      request_id: request.request_id,
      job: {
        schemaVersion: 1,
        jobId: "setup-1",
        agentId: "agent.demo",
        skillName: "analysis-experiment",
        contentHash: "a".repeat(64),
        state: "queued",
        stage: "queued",
        createdAt: 1,
        updatedAt: 1,
      },
    });

    await expect(pending).resolves.toMatchObject({ jobId: "setup-1", state: "queued" });
  });

  it("routes events to the matching chat handler", () => {
    const client = new MonaClient({
      url: "ws://test",
      reconnect: false,
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    const handler = vi.fn();
    client.onChat("chat-a", handler);
    client.connect();
    lastSocket().fakeOpen();
    lastSocket().fakeMessage({ event: "message", chat_id: "chat-a", text: "hi" });
    lastSocket().fakeMessage({ event: "message", chat_id: "chat-b", text: "no" });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({
      event: "message",
      chat_id: "chat-a",
      text: "hi",
    });
  });

  it("buffers chat events while no chat handler is registered and replays on subscribe", async () => {
    const client = new MonaClient({
      url: "ws://test",
      reconnect: false,
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    client.connect();
    lastSocket().fakeOpen();
    // Nobody listening yet — deltas must not be dropped (user switched away).
    lastSocket().fakeMessage({ event: "delta", chat_id: "chat-queue", text: "a" });
    lastSocket().fakeMessage({ event: "delta", chat_id: "chat-queue", text: "b" });
    const handler = vi.fn();
    client.onChat("chat-queue", handler);
    await Promise.resolve();
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[0][0]).toMatchObject({ event: "delta", text: "a" });
    expect(handler.mock.calls[1][0]).toMatchObject({ event: "delta", text: "b" });
    lastSocket().fakeMessage({ event: "delta", chat_id: "chat-queue", text: "c" });
    expect(handler).toHaveBeenCalledTimes(3);
  });

  it("records goal_status run strip without an onChat subscriber", () => {
    const client = new MonaClient({
      url: "ws://test",
      reconnect: false,
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    client.connect();
    lastSocket().fakeOpen();
    lastSocket().fakeMessage({
      event: "goal_status",
      chat_id: "chat-strip",
      status: "running",
      started_at: 12_345,
    });
    expect(client.getRunStartedAt("chat-strip")).toBe(12_345);
    lastSocket().fakeMessage({
      event: "goal_status",
      chat_id: "chat-strip",
      status: "idle",
    });
    expect(client.getRunStartedAt("chat-strip")).toBeNull();
  });

  it("notifies run status subscribers and replays running chats", () => {
    const client = new MonaClient({
      url: "ws://test",
      reconnect: false,
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    const handler = vi.fn();
    client.onRunStatus(handler);
    client.connect();
    lastSocket().fakeOpen();
    lastSocket().fakeMessage({
      event: "goal_status",
      chat_id: "chat-status",
      status: "running",
      started_at: 12_345,
    });
    expect(handler).toHaveBeenCalledWith("chat-status", 12_345);

    const lateHandler = vi.fn();
    client.onRunStatus(lateHandler);
    expect(lateHandler).toHaveBeenCalledWith("chat-status", 12_345);

    lastSocket().fakeMessage({
      event: "goal_status",
      chat_id: "chat-status",
      status: "idle",
    });
    expect(handler).toHaveBeenCalledWith("chat-status", null);
    expect(lateHandler).toHaveBeenCalledWith("chat-status", null);
  });

  it("records goal_state per chat_id without an onChat subscriber", () => {
    const client = new MonaClient({
      url: "ws://test",
      reconnect: false,
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    client.connect();
    lastSocket().fakeOpen();
    lastSocket().fakeMessage({
      event: "goal_state",
      chat_id: "chat-goal-a",
      goal_state: { active: true, ui_summary: "Docs" },
    });
    lastSocket().fakeMessage({
      event: "goal_state",
      chat_id: "chat-goal-b",
      goal_state: { active: true, objective: "Ship API" },
    });
    expect(client.getGoalState("chat-goal-a")).toEqual({ active: true, ui_summary: "Docs" });
    expect(client.getGoalState("chat-goal-b")).toEqual({
      active: true,
      objective: "Ship API",
    });
    lastSocket().fakeMessage({
      event: "goal_state",
      chat_id: "chat-goal-a",
      goal_state: { active: false },
    });
    expect(client.getGoalState("chat-goal-a")).toEqual({ active: false });
  });

  it("records goal_state from turn_end payload when present", () => {
    const client = new MonaClient({
      url: "ws://test",
      reconnect: false,
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    client.connect();
    lastSocket().fakeOpen();
    lastSocket().fakeMessage({
      event: "turn_end",
      chat_id: "chat-te",
      goal_state: { active: true, objective: "Long task" },
    });
    expect(client.getGoalState("chat-te")).toEqual({ active: true, objective: "Long task" });
  });

  it("buffers after unsubscribe until the chat is subscribed again", async () => {
    const client = new MonaClient({
      url: "ws://test",
      reconnect: false,
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    const h1 = vi.fn();
    const unsub = client.onChat("chat-rejoin", h1);
    client.connect();
    lastSocket().fakeOpen();
    lastSocket().fakeMessage({ event: "delta", chat_id: "chat-rejoin", text: "live" });
    expect(h1).toHaveBeenCalledTimes(1);
    unsub();
    lastSocket().fakeMessage({ event: "delta", chat_id: "chat-rejoin", text: "queued" });
    expect(h1).toHaveBeenCalledTimes(1);
    const h2 = vi.fn();
    client.onChat("chat-rejoin", h2);
    await Promise.resolve();
    expect(h2).toHaveBeenCalledTimes(1);
    expect(h2.mock.calls[0][0]).toMatchObject({ event: "delta", text: "queued" });
  });

  it("replays a queued Office open event to every subscriber registered in the same turn", async () => {
    const client = new MonaClient({
      url: "ws://test",
      reconnect: false,
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    client.connect();
    lastSocket().fakeOpen();
    const event = {
      event: "message",
      chat_id: "chat-office",
      text: "",
      kind: "progress",
      agent_ui: { kind: "office_session", data: { session: { sessionId: "office_1" } } },
    };
    lastSocket().fakeMessage(event);
    const streamHandler = vi.fn();
    const officeHandler = vi.fn();

    client.onChat("chat-office", streamHandler);
    client.onChat("chat-office", officeHandler);
    await Promise.resolve();

    expect(streamHandler).toHaveBeenCalledWith(expect.objectContaining(event));
    expect(officeHandler).toHaveBeenCalledWith(expect.objectContaining(event));
  });

  it("dispatches runtime model updates globally", () => {
    const client = new MonaClient({
      url: "ws://test",
      reconnect: false,
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    const handler = vi.fn();
    client.onRuntimeModelUpdate(handler);
    client.connect();
    lastSocket().fakeOpen();

    lastSocket().fakeMessage({
      event: "runtime_model_updated",
      model_name: "openai/gpt-4.1",
      model_preset: "fast",
    });

    expect(handler).toHaveBeenCalledWith("openai/gpt-4.1", "fast");
  });

  it("dispatches session updates globally", () => {
    const client = new MonaClient({
      url: "ws://test",
      reconnect: false,
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    const globalHandler = vi.fn();
    const chatHandler = vi.fn();
    client.onSessionUpdate(globalHandler);
    client.onChat("chat-title", chatHandler);
    client.connect();
    lastSocket().fakeOpen();

    lastSocket().fakeMessage({
      event: "session_updated",
      chat_id: "chat-title",
      scope: "metadata",
    });

    expect(globalHandler).toHaveBeenCalledWith("chat-title", "metadata");
    expect(chatHandler).not.toHaveBeenCalled();
  });

  it("routes a chat-scoped error event to that chat's subscribers", () => {
    const client = new MonaClient({
      url: "ws://test",
      reconnect: false,
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    const chatHandler = vi.fn();
    client.onChat("chat-video", chatHandler);
    client.connect();
    lastSocket().fakeOpen();

    lastSocket().fakeMessage({
      event: "error",
      chat_id: "chat-video",
      detail: "invalid_agent_kind_context",
    });

    expect(chatHandler).toHaveBeenCalledWith({
      event: "error",
      chat_id: "chat-video",
      detail: "invalid_agent_kind_context",
    });
  });

  it("drops a chat-scoped error for an unsubscribed chat", () => {
    const client = new MonaClient({
      url: "ws://test",
      reconnect: false,
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    const otherHandler = vi.fn();
    client.onChat("other-chat", otherHandler);
    client.connect();
    lastSocket().fakeOpen();

    lastSocket().fakeMessage({
      event: "error",
      chat_id: "chat-video",
      detail: "invalid_agent_kind_context",
    });

    expect(otherHandler).not.toHaveBeenCalled();
  });

  it("resolves newChat() via the server-assigned chat_id", async () => {
    const client = new MonaClient({
      url: "ws://test",
      reconnect: false,
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    client.connect();
    lastSocket().fakeOpen();
    const promise = client.newChat(1_000);
    const request = JSON.parse(lastSocket().sent.at(-1) ?? "{}") as Record<string, unknown>;
    expect(request).toMatchObject({ type: "new_chat" });
    expect(request.request_id).toEqual(expect.any(String));
    let resolved = false;
    void promise.then(() => {
      resolved = true;
    });
    lastSocket().fakeMessage({ event: "attached", chat_id: "unrelated-id" });
    await Promise.resolve();
    expect(resolved).toBe(false);
    lastSocket().fakeMessage({
      event: "attached",
      chat_id: "fresh-id",
      request_id: request.request_id,
    });
    await expect(promise).resolves.toBe("fresh-id");
  });

  it("requests a server-side branch and resolves the new chat id", async () => {
    const client = new MonaClient({
      url: "ws://test",
      reconnect: false,
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    client.connect();
    lastSocket().fakeOpen();

    const promise = client.branchChat("source-chat", 2, "task-2", 1_000);
    const request = JSON.parse(lastSocket().sent.at(-1) ?? "{}") as Record<string, unknown>;
    expect(request).toMatchObject({
      type: "branch_chat",
      source_chat_id: "source-chat",
      assistant_ordinal: 2,
      source_task_id: "task-2",
    });
    expect(request.request_id).toEqual(expect.any(String));
    lastSocket().fakeMessage({
      event: "attached",
      chat_id: "branch-chat",
      request_id: request.request_id,
    });
    await expect(promise).resolves.toBe("branch-chat");
  });

  it("queues sends while connecting and flushes on open", () => {
    const client = new MonaClient({
      url: "ws://test",
      reconnect: false,
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    client.connect();
    client.sendMessage("chat-x", "hello");
    expect(lastSocket().sent).toEqual([]);
    lastSocket().fakeOpen();
    // Attach is sent first because sendMessage adds to knownChats, which
    // handleOpen re-attaches; then the queued message follows.
    expect(lastSocket().sent).toContain(
      JSON.stringify({ type: "message", chat_id: "chat-x", content: "hello", webui: true }),
    );
  });

  it("re-attaches known chats after a reconnect", async () => {
    const client = new MonaClient({
      url: "ws://test",
      reconnect: true,
      maxBackoffMs: 10,
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    client.onChat("chat-z", () => {});
    client.connect();
    lastSocket().fakeOpen();
    expect(lastSocket().sent).toContain(
      JSON.stringify({ type: "attach", chat_id: "chat-z" }),
    );
    // Drop the socket.
    lastSocket().close();
    // Advance the backoff timer.
    await vi.advanceTimersByTimeAsync(20);
    const reconnected = lastSocket();
    expect(reconnected).not.toBe(FakeSocket.instances[0]);
    reconnected.fakeOpen();
    expect(reconnected.sent).toContain(
      JSON.stringify({ type: "attach", chat_id: "chat-z" }),
    );
  });

  it("reports status transitions through onStatus", () => {
    const client = new MonaClient({
      url: "ws://test",
      reconnect: false,
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    const seen: string[] = [];
    client.onStatus((s) => seen.push(s));
    client.connect();
    lastSocket().fakeOpen();
    lastSocket().close();
    expect(seen).toEqual(["idle", "connecting", "open", "closed"]);
  });

  it("does not schedule a reconnect when close() is called explicitly", async () => {
    const client = new MonaClient({
      url: "ws://test",
      reconnect: true,
      maxBackoffMs: 10,
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    const seen: string[] = [];
    client.onStatus((s) => seen.push(s));
    client.connect();
    lastSocket().fakeOpen();
    client.close();
    // Advance past any possible backoff window to prove no reconnect was scheduled.
    await vi.advanceTimersByTimeAsync(200);
    expect(FakeSocket.instances).toHaveLength(1);
    // "reconnecting" must never appear after an intentional close.
    expect(seen).not.toContain("reconnecting");
    expect(seen.at(-1)).toBe("closed");
  });

  it("passes media through into the message envelope", () => {
    const client = new MonaClient({
      url: "ws://test",
      reconnect: false,
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    client.connect();
    lastSocket().fakeOpen();
    client.sendMessage("chat-x", "look", [
      { data_url: "data:image/png;base64,AAAA", name: "shot.png" },
    ]);
    const lastFrame = JSON.parse(lastSocket().sent.at(-1) as string);
    expect(lastFrame).toEqual({
      type: "message",
      chat_id: "chat-x",
      content: "look",
      media: [{ data_url: "data:image/png;base64,AAAA", name: "shot.png" }],
      webui: true,
    });
  });

  it("omits media from the envelope when no images are attached", () => {
    const client = new MonaClient({
      url: "ws://test",
      reconnect: false,
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    client.connect();
    lastSocket().fakeOpen();
    client.sendMessage("chat-x", "hello");
    const lastFrame = JSON.parse(lastSocket().sent.at(-1) as string);
    expect(lastFrame).not.toHaveProperty("media");
    expect(lastFrame).toEqual({
      type: "message",
      chat_id: "chat-x",
      content: "hello",
      webui: true,
    });
  });

  it("includes the browser tab identity in the message envelope", () => {
    const client = new MonaClient({
      url: "ws://test",
      reconnect: false,
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    client.connect();
    lastSocket().fakeOpen();

    client.sendMessage("chat-x", "inspect this page", undefined, {
      browserTabId: "tab-123",
    });

    expect(JSON.parse(lastSocket().sent.at(-1) as string)).toMatchObject({
      type: "message",
      chat_id: "chat-x",
      content: "inspect this page",
      browser_tab_id: "tab-123",
    });
  });

  it("includes the active Office document in the message envelope", () => {
    const client = new MonaClient({
      url: "ws://test",
      reconnect: false,
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    client.connect();
    lastSocket().fakeOpen();

    client.sendMessage("chat-office", "修改当前演示文稿", undefined, {
      officeSessionId: "office_123",
      officeDocumentType: "slides",
      officeDisplayName: "季度汇报.pptx",
    });

    expect(JSON.parse(lastSocket().sent.at(-1) as string)).toMatchObject({
      type: "message",
      chat_id: "chat-office",
      office_session_id: "office_123",
      office_document_type: "slides",
      office_display_name: "季度汇报.pptx",
    });
  });

  it("includes the active canvas in the message envelope", () => {
    const client = new MonaClient({
      url: "ws://test",
      reconnect: false,
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    client.connect();
    lastSocket().fakeOpen();

    client.sendMessage("chat-canvas", "修改当前架构图", undefined, {
      canvasId: "canvas-123",
    });

    expect(JSON.parse(lastSocket().sent.at(-1) as string)).toMatchObject({
      type: "message",
      chat_id: "chat-canvas",
      canvas_id: "canvas-123",
    });
  });

  it("includes a quote preview in the message envelope", () => {
    const client = new MonaClient({
      url: "ws://test",
      reconnect: false,
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    client.connect();
    lastSocket().fakeOpen();

    client.sendMessage("chat-quote", "引用 Mona 的消息：\n原消息\n\n请解释", undefined, {
      displayContent: "请解释",
      quote: { author: "Mona", content: "原消息" },
    });

    expect(JSON.parse(lastSocket().sent.at(-1) as string)).toMatchObject({
      type: "message",
      chat_id: "chat-quote",
      content: "引用 Mona 的消息：\n原消息\n\n请解释",
      display_content: "请解释",
      quote: { author: "Mona", content: "原消息" },
    });
  });

  it("routes a video turn with agent_kind in the message envelope", () => {
    const client = new MonaClient({
      url: "ws://test",
      reconnect: false,
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    client.connect();
    lastSocket().fakeOpen();

    client.sendMessage("chat-video", "继续制作当前视频", undefined, { agentKind: "video" });

    expect(JSON.parse(lastSocket().sent.at(-1) as string)).toMatchObject({
      type: "message",
      chat_id: "chat-video",
      content: "继续制作当前视频",
      agent_kind: "video",
    });
  });

  it("omits agent_kind when no dedicated agent is selected", () => {
    const client = new MonaClient({
      url: "ws://test",
      reconnect: false,
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    client.connect();
    lastSocket().fakeOpen();

    client.sendMessage("chat-default", "继续讨论", undefined);

    expect(JSON.parse(lastSocket().sent.at(-1) as string)).not.toHaveProperty("agent_kind");
  });

  it("sends resolve_workflow_approval and surfaces server error codes", async () => {
    const client = new MonaClient({
      url: "ws://test",
      reconnect: false,
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    client.connect();
    lastSocket().fakeOpen();

    const okPromise = client.resolveWorkflowApproval(
      "room1",
      "run_1",
      "ok",
      "tok-1",
      true,
    );
    const sent = JSON.parse(lastSocket().sent.at(-1) as string);
    expect(sent).toMatchObject({
      type: "resolve_workflow_approval",
      chat_id: "room1",
      run_id: "run_1",
      step_id: "ok",
      token: "tok-1",
      approve: true,
    });
    lastSocket().fakeMessage({
      event: "resolve_workflow_approval_result",
      ok: true,
      chat_id: "room1",
      request_id: sent.request_id,
      run_id: "run_1",
      step_id: "ok",
    });
    await okPromise;

    const failPromise = client.resolveWorkflowApproval(
      "room1",
      "run_1",
      "ok",
      "tok-1",
      false,
    );
    const sent2 = JSON.parse(lastSocket().sent.at(-1) as string);
    lastSocket().fakeMessage({
      event: "resolve_workflow_approval_result",
      ok: false,
      code: "approval_expired",
      detail: "approval for step 'ok' has expired",
      chat_id: "room1",
      request_id: sent2.request_id,
    });
    await expect(failPromise).rejects.toMatchObject({
      name: "RoomCommandError",
      code: "approval_expired",
    });
  });

  it("serializes a topic discussion separately from ordinary Agent mentions", () => {
    const client = new MonaClient({
      url: "ws://test",
      reconnect: false,
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    client.connect();
    lastSocket().fakeOpen();

    client.sendMessage("room-1", "增长还是利润？", undefined, {
      targetAgentIds: ["agent.a", "agent.b"],
      discussion: {
        mode: "debate",
        maxRounds: 99,
        participantIds: ["agent.a", "agent.b"],
        positions: { "agent.a": "增长", "agent.b": "利润" },
        styles: { "agent.a": "sharp_punchline", "agent.b": "value_reframe" },
        summaryAgentId: null,
      },
    });

    expect(JSON.parse(lastSocket().sent.at(-1) as string)).toMatchObject({
      type: "start_discussion",
      chat_id: "room-1",
      target_agent_ids: ["agent.a", "agent.b"],
      discussion: {
        mode: "debate",
        max_rounds: 99,
        positions: { "agent.a": "增长", "agent.b": "利润" },
        styles: { "agent.a": "sharp_punchline", "agent.b": "value_reframe" },
        summary_agent_id: null,
      },
    });

    client.sendMessage("room-1", "增长还是利润？", undefined, {
      targetAgentIds: ["agent.a", "agent.b"],
      discussion: {
        mode: "debate",
        maxRounds: 99,
        participantIds: ["agent.a", "agent.b"],
        positions: { "agent.a": "增长", "agent.b": "利润" },
        styles: { "agent.a": "sharp_punchline", "agent.b": "value_reframe" },
        summaryAgentId: "agent.judge",
      },
    });

    expect(JSON.parse(lastSocket().sent.at(-1) as string)).toMatchObject({
      type: "start_discussion",
      discussion: {
        summary_agent_id: "agent.judge",
      },
    });
  });

  it("records authoritative task plans without an onChat subscriber", () => {
    const client = new MonaClient({
      url: "ws://test",
      reconnect: false,
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    client.connect();
    lastSocket().fakeOpen();
    lastSocket().fakeMessage({
      event: "task_plan",
      chat_id: "chat-plan",
      task_plan: {
        task_id: "task-1",
        revision: 2,
        steps: [{ id: "verify", step: "Verify output", status: "in_progress" }],
        source: "ai",
      },
    });
    expect(client.getTaskPlan("chat-plan")).toEqual({
      task_id: "task-1",
      revision: 2,
      steps: [{ id: "verify", step: "Verify output", status: "in_progress" }],
      source: "ai",
    });
    lastSocket().fakeMessage({
      event: "artifact_task_started",
      chat_id: "chat-plan",
      task_id: "task-2",
    });
    lastSocket().fakeMessage({
      event: "task_plan",
      chat_id: "chat-plan",
      task_plan: {
        task_id: "task-1",
        revision: 3,
        steps: [{ id: "stale", step: "Stale", status: "in_progress" }],
        source: "ai",
      },
    });
    expect(client.getTaskPlan("chat-plan")).toBeUndefined();
  });

  it("carries task identity on message envelopes", () => {
    const client = new MonaClient({
      url: "ws://test",
      reconnect: false,
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    client.connect();
    lastSocket().fakeOpen();

    client.sendMessage("chat-x", "continue", undefined, { taskId: "task-1" });
    expect(JSON.parse(lastSocket().sent.at(-1) as string)).toMatchObject({
      type: "message",
      chat_id: "chat-x",
      task_id: "task-1",
    });

  });

  it("carries the bounded profile advice origin on message envelopes", () => {
    const client = new MonaClient({
      url: "ws://test",
      reconnect: false,
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    client.connect();
    lastSocket().fakeOpen();

    client.sendMessage("chat-x", "start", undefined, {
      origin: "profile_advice",
      profileAdviceId: "advice-1",
    });
    expect(JSON.parse(lastSocket().sent.at(-1) as string)).toMatchObject({
      type: "message",
      chat_id: "chat-x",
      origin: "profile_advice",
      profile_advice_id: "advice-1",
    });
  });

  it("sends retry_workflow_step and surfaces server error codes", async () => {
    const client = new MonaClient({
      url: "ws://test",
      reconnect: false,
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    client.connect();
    lastSocket().fakeOpen();

    const okPromise = client.retryWorkflowStep("room1", "run_1", "failed");
    const sent = JSON.parse(lastSocket().sent.at(-1) as string);
    expect(sent).toMatchObject({
      type: "retry_workflow_step",
      chat_id: "room1",
      run_id: "run_1",
      step_id: "failed",
    });
    lastSocket().fakeMessage({
      event: "retry_workflow_step_result",
      ok: true,
      chat_id: "room1",
      request_id: sent.request_id,
      run_id: "run_1",
      step_id: "failed",
    });
    await okPromise;

    const failPromise = client.retryWorkflowStep("room1", "run_1", "failed");
    const sent2 = JSON.parse(lastSocket().sent.at(-1) as string);
    lastSocket().fakeMessage({
      event: "retry_workflow_step_result",
      ok: false,
      code: "step_not_retryable",
      detail: "step is not retryable",
      chat_id: "room1",
      request_id: sent2.request_id,
    });
    await expect(failPromise).rejects.toMatchObject({
      name: "RoomCommandError",
      code: "step_not_retryable",
    });
  });

  it("sends run_workflow with optional run inputs (stock-module design §4.2)", async () => {
    const client = new MonaClient({
      url: "ws://test",
      reconnect: false,
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    client.connect();
    lastSocket().fakeOpen();

    // No inputs → the field is omitted entirely (legacy behavior).
    const plainPromise = client.runWorkflow("room1");
    const plain = JSON.parse(lastSocket().sent.at(-1) as string);
    expect(plain).toMatchObject({ type: "run_workflow", chat_id: "room1" });
    expect("inputs" in plain).toBe(false);
    lastSocket().fakeMessage({
      event: "run_workflow_result",
      ok: true,
      chat_id: "room1",
      request_id: plain.request_id,
    });
    await plainPromise;

    // With inputs → the object rides along verbatim.
    const inputsPromise = client.runWorkflow("room1", {
      symbols: ["XSHG:600519"],
    });
    const withInputs = JSON.parse(lastSocket().sent.at(-1) as string);
    expect(withInputs).toMatchObject({
      type: "run_workflow",
      chat_id: "room1",
      inputs: { symbols: ["XSHG:600519"] },
    });
    lastSocket().fakeMessage({
      event: "run_workflow_result",
      ok: true,
      chat_id: "room1",
      request_id: withInputs.request_id,
    });
    await inputsPromise;

    const selectionPromise = client.runWorkflow(
      "room1",
      { mode: "stock_selection", strategy_id: "quality_growth" },
      "package://com.mona.a-share-team/workflows/stock-selection.json",
    );
    const selectionSent = JSON.parse(lastSocket().sent.at(-1) as string);
    expect(selectionSent).toMatchObject({
      type: "run_workflow",
      chat_id: "room1",
      template_ref: "package://com.mona.a-share-team/workflows/stock-selection.json",
    });
    lastSocket().fakeMessage({
      event: "run_workflow_result",
      ok: true,
      chat_id: "room1",
      request_id: selectionSent.request_id,
    });
    await selectionPromise;

    // Server-side rejection (e.g. run_conflict) rejects the promise.
    const conflictPromise = client.runWorkflow("room1", { symbols: [] });
    const conflictSent = JSON.parse(lastSocket().sent.at(-1) as string);
    lastSocket().fakeMessage({
      event: "run_workflow_result",
      ok: false,
      code: "run_conflict",
      detail: "room already has an active run",
      chat_id: "room1",
      request_id: conflictSent.request_id,
    });
    await expect(conflictPromise).rejects.toMatchObject({
      name: "RoomCommandError",
      code: "run_conflict",
    });
  });

  it("synchronizes stock selection schedules and exposes unavailable status", async () => {
    const client = new MonaClient({
      url: "ws://test",
      reconnect: false,
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    client.connect();
    lastSocket().fakeOpen();

    const syncPromise = client.syncStockScreenSchedule("stock_research", "quality_growth", {
      mode: "daily_after_close",
      enabled: true,
      time: "15:30",
      timezone: "Asia/Shanghai",
    });
    const sent = JSON.parse(lastSocket().sent.at(-1) as string);
    expect(sent).toMatchObject({
      type: "sync_stock_selection_schedule",
      chat_id: "stock_research",
      strategy_id: "quality_growth",
      schedule: { mode: "daily_after_close", enabled: true, time: "15:30" },
    });
    lastSocket().fakeMessage({
      event: "sync_stock_selection_schedule_result",
      ok: true,
      chat_id: "stock_research",
      request_id: sent.request_id,
      status: "unavailable",
      code: "cron_service_unavailable",
    });
    await expect(syncPromise).resolves.toMatchObject({ status: "unavailable", code: "cron_service_unavailable" });
  });

  it("dispatches approval_requested broadcasts to subscribers", () => {
    const client = new MonaClient({
      url: "ws://test",
      reconnect: false,
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    const handler = vi.fn();
    client.onApprovalRequested(handler);
    client.connect();
    lastSocket().fakeOpen();
    lastSocket().fakeMessage({
      event: "approval_requested",
      chat_id: "room1",
      run_id: "run_1",
      approvals: [{ stepId: "ok", message: "Confirm?", token: "tok-1" }],
    });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({
      chatId: "room1",
      runId: "run_1",
      approvals: [{ stepId: "ok", message: "Confirm?", token: "tok-1" }],
    });
  });

  it("emits a message_too_big error when the socket closes with code 1009", () => {
    const client = new MonaClient({
      url: "ws://test",
      reconnect: false,
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    const errors: Array<{ kind: string }> = [];
    client.onError((e) => errors.push(e));
    client.connect();
    lastSocket().fakeOpen();
    // Server rejected an outbound frame as too large.
    lastSocket().fakeCloseWithCode(1009);
    expect(errors).toEqual([{ kind: "message_too_big" }]);
  });

  it("isolates throwing error handlers so reconnect bookkeeping still runs", async () => {
    const client = new MonaClient({
      url: "ws://test",
      reconnect: true,
      maxBackoffMs: 5,
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    // First handler explodes; subsequent reconnect state must be untouched.
    client.onError(() => {
      throw new Error("subscriber blew up");
    });
    const seenStatuses: string[] = [];
    client.onStatus((s) => seenStatuses.push(s));
    client.connect();
    lastSocket().fakeOpen();
    lastSocket().fakeCloseWithCode(1009);
    // Despite the throwing handler, the client must still schedule a reconnect.
    expect(seenStatuses).toContain("reconnecting");
    await vi.advanceTimersByTimeAsync(20);
    expect(FakeSocket.instances.length).toBeGreaterThan(1);
  });

  it("does not emit a stream error on a vanilla socket close", () => {
    const client = new MonaClient({
      url: "ws://test",
      reconnect: false,
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    const errors: Array<{ kind: string }> = [];
    client.onError((e) => errors.push(e));
    client.connect();
    lastSocket().fakeOpen();
    lastSocket().close();
    expect(errors).toEqual([]);
  });

  it("surfaces 'reconnecting' only on an unexpected drop", async () => {
    const client = new MonaClient({
      url: "ws://test",
      reconnect: true,
      maxBackoffMs: 5,
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    const seen: string[] = [];
    client.onStatus((s) => seen.push(s));
    client.connect();
    lastSocket().fakeOpen();
    // Simulate the remote side hanging up (no client.close() call).
    lastSocket().close();
    await vi.advanceTimersByTimeAsync(50);
    expect(seen).toContain("reconnecting");
    expect(FakeSocket.instances.length).toBeGreaterThan(1);
  });
});
