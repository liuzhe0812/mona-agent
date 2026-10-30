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
  it("keeps an accepted guide observable through pause and resumes the same ID against a new turn", () => {
    const client = new MonaClient({ url: "ws://test", reconnect: false, socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket });
    client.connect(); lastSocket().fakeOpen();
    const firstReceipt = vi.fn();
    client.sendMessage("chat", "original guide", undefined, { inputId: "guide", targetTurnId: "turn-a", onAdmission: firstReceipt });
    expect(JSON.parse(lastSocket().sent.at(-1)!)).toMatchObject({ input_id: "guide", target_turn_id: "turn-a" });
    lastSocket().fakeMessage({ event: "message_accepted", chat_id: "chat", input_id: "guide" });
    expect(firstReceipt).not.toHaveBeenCalled();
    lastSocket().fakeMessage({ event: "work_input_state", chat_id: "chat", input_id: "guide", turn_id: "turn-a", state: "accepted" });
    expect(firstReceipt).toHaveBeenLastCalledWith("accepted");
    lastSocket().fakeMessage({ event: "work_input_state", chat_id: "chat", input_id: "guide", turn_id: "turn-a", state: "paused" });
    expect(firstReceipt).toHaveBeenLastCalledWith("paused");
    const sentBefore = lastSocket().sent.length;
    client.sendMessage("chat", "original guide", undefined, { inputId: "guide", targetTurnId: "turn-b" });
    expect(lastSocket().sent).toHaveLength(sentBefore);
    const resumedReceipt = vi.fn();
    client.sendMessage("chat", "original guide", undefined, { inputId: "guide", targetTurnId: "turn-b", resumeInput: true, onAdmission: resumedReceipt });
    expect(JSON.parse(lastSocket().sent.at(-1)!)).toMatchObject({ input_id: "guide", target_turn_id: "turn-b", resume_input: true });
    lastSocket().fakeMessage({ event: "work_input_state", chat_id: "chat", input_id: "guide", turn_id: "turn-a", state: "consumed" });
    lastSocket().fakeMessage({ event: "error", chat_id: "chat", input_id: "guide", target_turn_id: "turn-a", message_rejected: true });
    lastSocket().fakeMessage({ event: "agent_mentions_routed", chat_id: "chat", input_id: "guide", job_ids: [] });
    expect(resumedReceipt).not.toHaveBeenCalled();
    lastSocket().fakeMessage({ event: "work_input_state", chat_id: "chat", input_id: "guide", turn_id: "turn-b", state: "consumed" });
    expect(resumedReceipt.mock.calls).toEqual([["accepted"], ["consumed"]]);
    expect(firstReceipt).toHaveBeenCalledTimes(2);
    expect(client.getMessageAdmission("chat", "guide")).toBe("consumed");
    client.sendMessage("chat", "original guide", undefined, { inputId: "guide", targetTurnId: "turn-b", resumeInput: true });
    expect(lastSocket().sent).toHaveLength(sentBefore + 1);
    client.close();
  });

  it.each(["consumed", "paused"] as const)("settles a lost %s receipt after reconnect without resending the guide", (state) => {
    const client = new MonaClient({ url: "ws://test", reconnect: false, socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket });
    client.connect(); lastSocket().fakeOpen();
    const receipt = vi.fn();
    client.sendMessage("chat", "guide", undefined, { inputId: "guide", targetTurnId: "turn-a", onAdmission: receipt });
    lastSocket().fakeMessage({ event: "work_input_state", chat_id: "chat", input_id: "guide", turn_id: "turn-a", state: "accepted" });
    lastSocket().fakeCloseWithCode(1006);
    expect(receipt).toHaveBeenLastCalledWith("unknown");
    client.connect(); lastSocket().fakeOpen();
    expect(lastSocket().sent.map((frame) => JSON.parse(frame)).some((frame) => frame.type === "message")).toBe(false);
    lastSocket().fakeMessage({ event: "work_input_state", chat_id: "other", input_id: "guide", turn_id: "turn-a", state });
    expect(receipt).toHaveBeenLastCalledWith("unknown");
    lastSocket().fakeMessage({ event: "work_input_state", chat_id: "chat", input_id: "guide", turn_id: "turn-a", state });
    expect(receipt).toHaveBeenLastCalledWith(state);
    client.close();
  });

  it("preserves guide identity when a discussion payload must be rejected by the server", () => {
    const client = new MonaClient({ url: "ws://test", reconnect: false, socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket });
    client.connect(); lastSocket().fakeOpen();
    const receipt = vi.fn();
    client.sendMessage("chat", "topic", undefined, { inputId: "guide", targetTurnId: "turn-a", resumeInput: true,
      discussion: { participantIds: ["mona", "partner"], mode: "brainstorm", maxRounds: 1 }, onAdmission: receipt });
    expect(JSON.parse(lastSocket().sent.at(-1)!)).toMatchObject({ type: "start_discussion", input_id: "guide", target_turn_id: "turn-a", resume_input: true });
    lastSocket().fakeMessage({ event: "error", chat_id: "chat", input_id: "guide", target_turn_id: "turn-a", message_rejected: true });
    expect(receipt).toHaveBeenLastCalledWith("rejected");
    client.close();
  });

  it("withdraws only the original undispatched input and never revives it on reconnect", () => {
    const client = new MonaClient({ url: "ws://test", reconnect: false, socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket });
    const admission = vi.fn();
    client.sendMessage("chat-a", "withdraw me", undefined, { inputId: "input-a", onAdmission: admission });
    client.sendMessage("chat-b", "keep me", undefined, { inputId: "input-b" });
    expect(client.cancelUnsentInput("chat-a", "input-a")).toBe(true);
    expect(admission).toHaveBeenCalledTimes(1);
    expect(admission).toHaveBeenCalledWith("cancelled");
    client.connect(); lastSocket().fakeOpen();
    expect(lastSocket().sent.map((frame) => JSON.parse(frame)).filter((frame) => frame.type === "message"))
      .toEqual([expect.objectContaining({ chat_id: "chat-b", input_id: "input-b", content: "keep me" })]);
    lastSocket().fakeMessage({ event: "message_accepted", chat_id: "chat-a", input_id: "input-a" });
    expect(client.getMessageAdmission("chat-a", "input-a")).toBe("cancelled");
    expect(client.cancelUnsentInput("chat-b", "input-b")).toBe(false);
    client.close();
  });

  it("does not withdraw or replay an input whose send outcome is unknown", () => {
    const client = new MonaClient({ url: "ws://test", reconnect: false, socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket });
    client.connect(); lastSocket().fakeOpen();
    const original = lastSocket();
    vi.spyOn(original, "send").mockImplementationOnce(() => { throw new Error("synthetic interruption"); });
    client.sendMessage("chat", "unknown outcome", undefined, { inputId: "input-a" });
    expect(client.getMessageAdmission("chat", "input-a")).toBe("unknown");
    expect(client.cancelUnsentInput("chat", "input-a")).toBe(false);
    original.fakeCloseWithCode(1006);
    client.connect(); lastSocket().fakeOpen();
    expect(lastSocket().sent.map((frame) => JSON.parse(frame)).some((frame) => frame.type === "message")).toBe(false);
    client.close();
  });

  it("stops only the confirmed Work turn and never sends a slash command", async () => {
    const client = new MonaClient({ url: "ws://test", reconnect: false, socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket });
    client.connect(); lastSocket().fakeOpen();
    lastSocket().fakeMessage({ event: "goal_status", chat_id: "chat", status: "running", started_at: 10, turn_id: "turn-a", input_id: "input-a" });
    const stopping = client.stopWorkTurn("chat", client.getWorkTurn("chat")?.turnId);
    const frame = JSON.parse(lastSocket().sent.at(-1)!);
    expect(frame).toMatchObject({ type: "stop_work_turn", chat_id: "chat", expected_turn_id: "turn-a" });
    expect(lastSocket().sent.map((value) => JSON.parse(value))).not.toContainEqual(expect.objectContaining({ content: "/stop" }));
    lastSocket().fakeMessage({ event: "work_turn_stop_result", request_id: frame.request_id, ok: true, chat_id: "chat", turn_id: "turn-a", outcome: "stopped" });
    await expect(stopping).resolves.toBe("stopped");
    expect(client.getRunStartedAt("chat")).toBeNull();
    expect(client.getWorkTurn("chat")).toBeUndefined();
    client.close();
  });

  it("keeps a newer Work turn when an older stop result and terminal frames arrive", async () => {
    const client = new MonaClient({ url: "ws://test", reconnect: false, socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket });
    const delivered = vi.fn();
    client.onChat("chat", delivered);
    client.connect(); lastSocket().fakeOpen();
    lastSocket().fakeMessage({ event: "goal_status", chat_id: "chat", status: "running", started_at: 10, turn_id: "turn-a" });
    const stopping = client.stopWorkTurn("chat", "turn-a");
    const request = JSON.parse(lastSocket().sent.at(-1)!);
    lastSocket().fakeMessage({ event: "goal_status", chat_id: "chat", status: "running", started_at: 20, turn_id: "turn-b" });
    delivered.mockClear();
    for (const event of [
      { event: "goal_status", status: "idle" },
      { event: "goal_status", status: "running", started_at: 10 },
      { event: "turn_end" },
      { event: "delta", text: "old output" },
    ]) lastSocket().fakeMessage({ ...event, chat_id: "chat", turn_id: "turn-a" });
    lastSocket().fakeMessage({ event: "work_turn_stop_result", request_id: request.request_id, ok: true, chat_id: "chat", turn_id: "turn-a", outcome: "already_finished" });
    await expect(stopping).resolves.toBe("already_finished");
    expect(client.getWorkTurn("chat")?.turnId).toBe("turn-b");
    expect(client.getRunStartedAt("chat")).toBe(20);
    expect(delivered).not.toHaveBeenCalled();
    client.close();
  });

  it("keeps an unconfirmed stop outcome and refuses a stop without an original turn", async () => {
    const client = new MonaClient({ url: "ws://test", reconnect: false, socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket });
    client.connect(); lastSocket().fakeOpen();
    await expect(client.stopWorkTurn("chat")).resolves.toBe("unsupported");
    expect(lastSocket().sent).toEqual([]);
    lastSocket().fakeMessage({ event: "goal_status", chat_id: "chat", status: "running", started_at: 10, turn_id: "turn-a" });
    const stopping = client.stopWorkTurn("chat", "turn-a");
    const request = JSON.parse(lastSocket().sent.at(-1)!);
    lastSocket().fakeMessage({ event: "work_turn_stop_result", request_id: request.request_id, ok: true, chat_id: "chat", turn_id: "turn-a", outcome: "unknown" });
    await expect(stopping).resolves.toBe("unknown");
    expect(client.getWorkTurn("chat")?.turnId).toBe("turn-a");
    expect(client.getRunStartedAt("chat")).toBe(10);
    client.close();
  });

  it("drops only expired control commands that have never been dispatched", async () => {
    const client = new MonaClient({ url: "ws://test", reconnect: false, socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket });
    const expired = client.answerUserQuestion("chat-a", "question-old", null);
    const rejected = expect(expired).rejects.toThrow("answer_user_question_result timed out");
    vi.advanceTimersByTime(5_000);
    const current = client.answerUserQuestion("chat-b", "question-current", null);
    client.sendMessage("chat-c", "keep this queued message");
    vi.advanceTimersByTime(5_000);
    await rejected;

    client.connect(); lastSocket().fakeOpen();
    const frames = lastSocket().sent.map((frame) => JSON.parse(frame));
    const answers = frames.filter((frame) => frame.type === "answer_user_question");
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({ chat_id: "chat-b", question_id: "question-current" });
    expect(frames).toContainEqual(expect.objectContaining({ type: "message", chat_id: "chat-c", content: "keep this queued message" }));
    lastSocket().fakeMessage({ event: "answer_user_question_result", request_id: answers[0].request_id, ok: true });
    await expect(current).resolves.toBeUndefined();
    client.close();
  });

  it("does not revive an expired offline control command on later connections", async () => {
    const client = new MonaClient({ url: "ws://test", reconnect: false, socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket });
    const answer = client.answerUserQuestion("chat-a", "question-old", null);
    const rejected = expect(answer).rejects.toThrow("answer_user_question_result timed out");
    vi.advanceTimersByTime(10_000);
    await rejected;
    for (let connection = 0; connection < 2; connection++) {
      client.connect(); lastSocket().fakeOpen();
      expect(lastSocket().sent.map((frame) => JSON.parse(frame)).filter((frame) => frame.type === "answer_user_question")).toEqual([]);
      client.close();
    }
  });

  it("keeps the timeout result for an already-dispatched command when its reply arrives late", async () => {
    const client = new MonaClient({ url: "ws://test", reconnect: false, socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket });
    client.connect(); lastSocket().fakeOpen();
    const answer = client.answerUserQuestion("chat-a", "question-sent", null);
    const request = JSON.parse(lastSocket().sent.at(-1)!);
    const rejected = expect(answer).rejects.toThrow("answer_user_question_result timed out");
    vi.advanceTimersByTime(10_000);
    await rejected;
    expect(() => lastSocket().fakeMessage({ event: "answer_user_question_result", request_id: request.request_id, ok: true })).not.toThrow();
    expect(lastSocket().sent.map((frame) => JSON.parse(frame)).filter((frame) => frame.type === "answer_user_question")).toHaveLength(1);
    client.close();
  });

  it("expires a control command whose local serialization failed before socket.send", async () => {
    const client = new MonaClient({ url: "ws://test", reconnect: false, socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket });
    client.connect(); lastSocket().fakeOpen();
    const config: Record<string, unknown> = {};
    config.self = config;
    const update = client.updateAgentConfig("agent.fixture", config);
    const rejected = expect(update).rejects.toThrow("agent_config_update_result timed out");
    vi.advanceTimersByTime(10_000);
    await rejected;
    config.self = null;
    client.close(); client.connect(); lastSocket().fakeOpen();
    expect(lastSocket().sent.map((frame) => JSON.parse(frame)).filter((frame) => frame.type === "agent_config_update")).toEqual([]);
    client.close();
  });

  it("dispatches an offline identified input for the first time after connecting", () => {
    const client = new MonaClient({ url: "ws://test", reconnect: false, socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket });
    const admission = vi.fn();
    client.sendMessage("chat-a", "first dispatch", undefined, { inputId: "input-one", onAdmission: admission });
    vi.advanceTimersByTime(20_000);
    expect(admission).not.toHaveBeenCalled();
    client.connect(); lastSocket().fakeOpen();
    expect(lastSocket().sent.map((frame) => JSON.parse(frame)).filter((frame) => frame.type === "message")).toHaveLength(1);
    lastSocket().fakeMessage({ event: "message_accepted", chat_id: "chat-a", input_id: "input-one" });
    expect(admission).toHaveBeenLastCalledWith("accepted");
    client.close();
  });

  it("does not replay an identified input after send throws with an uncertain result", () => {
    const client = new MonaClient({ url: "ws://test", socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket });
    const admission = vi.fn();
    client.connect(); lastSocket().fakeOpen();
    lastSocket().send = () => { throw new Error("write result unknown"); };
    client.sendMessage("chat-a", "only once", undefined, { inputId: "input-one", onAdmission: admission });
    expect(admission).toHaveBeenLastCalledWith("unknown");
    lastSocket().fakeCloseWithCode(1006);
    vi.advanceTimersByTime(500);
    lastSocket().fakeOpen();
    client.sendMessage("chat-a", "only once", undefined, { inputId: "input-one", onAdmission: admission });
    expect(lastSocket().sent.map((frame) => JSON.parse(frame)).filter((frame) => frame.type === "message")).toEqual([]);
    client.close();
  });

  it("preserves unknown input identity across reconnect without resending and accepts a late receipt", () => {
    const client = new MonaClient({ url: "ws://test", socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket });
    const admission = vi.fn();
    client.connect(); lastSocket().fakeOpen();
    client.sendMessage("chat-a", "only once", undefined, { inputId: "input-one", onAdmission: admission });
    expect(JSON.parse(lastSocket().sent.at(-1)!)).toMatchObject({ input_id: "input-one", content: "only once" });
    lastSocket().fakeCloseWithCode(1006);
    expect(admission).toHaveBeenLastCalledWith("unknown");
    vi.advanceTimersByTime(500);
    lastSocket().fakeOpen();
    client.sendMessage("chat-a", "only once", undefined, { inputId: "input-one", onAdmission: admission });
    expect(lastSocket().sent.map((frame) => JSON.parse(frame)).filter((frame) => frame.type === "message")).toEqual([]);
    lastSocket().fakeMessage({ event: "message_accepted", chat_id: "other-chat", input_id: "input-one" });
    expect(client.getMessageAdmission("chat-a", "input-one")).toBe("unknown");
    lastSocket().fakeMessage({ event: "message_accepted", chat_id: "chat-a", input_id: "input-one" });
    expect(admission).toHaveBeenLastCalledWith("accepted");
    client.close();
  });

  it("keeps question snapshots isolated and correlates structured answers and cancellation", async () => {
    const client = new MonaClient({ url: "ws://test", reconnect: false, socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket });
    client.connect(); lastSocket().fakeOpen();
    const question = { request_id: "question-1", agent_id: "mona", questions: [{ id: "style", question: "选哪种风格？" }] };
    lastSocket().fakeMessage({ event: "user_questions", chat_id: "chat-a", requests: [question] });
    expect(client.getUserQuestions("chat-a")).toEqual([question]);
    expect(client.getUserQuestions("chat-b")).toEqual([]);
    const answers = [{ id: "style", selected: [], custom: "米白底、墨绿色" }];
    const answered = client.answerUserQuestion("chat-a", "question-1", answers);
    const request = JSON.parse(lastSocket().sent.at(-1)!);
    expect(request).toMatchObject({ type: "answer_user_question", chat_id: "chat-a", question_id: "question-1", answers });
    lastSocket().fakeMessage({ event: "answer_user_question_result", request_id: request.request_id, ok: true });
    await expect(answered).resolves.toBeUndefined();
    lastSocket().fakeMessage({ event: "user_questions", chat_id: "chat-a", requests: [] });
    expect(client.getUserQuestions("chat-a")).toEqual([]);
    const cancelled = client.answerUserQuestion("chat-b", "question-2", null);
    const cancelRequest = JSON.parse(lastSocket().sent.at(-1)!);
    expect(cancelRequest.answers).toBeNull();
    const rejected = expect(cancelled).rejects.toThrow("问题已结束");
    lastSocket().fakeMessage({ event: "answer_user_question_result", request_id: cancelRequest.request_id, ok: false, detail: "问题已结束" });
    await rejected;
    client.close();
  });

  it("sends the agent deletion command and resolves its correlated result", async () => {
    const client = new MonaClient({ url: "ws://test", reconnect: false, socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket });
    client.connect();
    lastSocket().fakeOpen();
    const pending = client.deleteAgent("agent.demo");
    const request = JSON.parse(lastSocket().sent.at(-1)!);
    expect(request).toMatchObject({ type: "agent_delete", agent_id: "agent.demo" });
    expect(request.request_id).toBeTruthy();
    lastSocket().fakeMessage({ event: "agent_delete_result", ok: true, agent_id: "agent.demo", request_id: request.request_id });
    await expect(pending).resolves.toBeUndefined();
    client.close();
  });

  it("restores only the previous Agent instruction without sending a commit id", async () => {
    const client = new MonaClient({ url: "ws://test", reconnect: false, socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket });
    client.connect();
    lastSocket().fakeOpen();
    const pending = client.restoreAgentInstruction("agent.demo", "memory");
    const request = JSON.parse(lastSocket().sent.at(-1)!);
    expect(request).toMatchObject({ type: "agent_instruction_restore", agent_id: "agent.demo", key: "memory" });
    expect(request).not.toHaveProperty("commit");
    const instruction = { key: "memory", filename: "MEMORY.md", content: "previous memory", contentHash: "hash", hasPrevious: true };
    lastSocket().fakeMessage({ event: "agent_instruction_restore_result", ok: true, request_id: request.request_id, instruction });
    await expect(pending).resolves.toEqual(instruction);
    client.close();
  });

  it("transports video model binding and preserves the difference between omitted and inherited", async () => {
    const client = new MonaClient({ url: "ws://test", reconnect: false, socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket });
    client.connect(); lastSocket().fakeOpen();
    const binding = { executor: "codex", model: "gpt-6.1-sol", provider: null, effort: "high" } as const;
    const created = client.newChat(45000, false, null, "video", binding);
    const request = JSON.parse(lastSocket().sent.at(-1)!);
    expect(request).toMatchObject({ type: "new_chat", agent_kind: "video", model_binding: binding });
    lastSocket().fakeMessage({ event: "attached", chat_id: "video-chat", request_id: request.request_id, model_binding: binding });
    await expect(created).resolves.toBe("video-chat");
    client.sendMessage("video-chat", "继续", undefined, { agentKind: "video" });
    expect(JSON.parse(lastSocket().sent.at(-1)!)).not.toHaveProperty("model_binding");
    client.sendMessage("video-chat", "跟随默认", undefined, { agentKind: "video", modelBinding: null });
    expect(JSON.parse(lastSocket().sent.at(-1)!)).toHaveProperty("model_binding", null);
    client.close();
  });

  it("waits for a video model selection receipt without broadcasting a global model change", async () => {
    const client = new MonaClient({ url: "ws://test", reconnect: false, socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket });
    client.connect(); lastSocket().fakeOpen();
    const globalChange = vi.fn(); client.onRuntimeModelUpdate(globalChange);
    const binding = { executor: "codex", model: "gpt-6.1-sol", provider: null, effort: "high" } as const;
    const changed = client.updateVideoModelBinding("video-chat", binding);
    const request = JSON.parse(lastSocket().sent.at(-1)!);
    expect(request).toMatchObject({ type: "video_model_binding_update", chat_id: "video-chat", model_binding: binding });
    await vi.advanceTimersByTimeAsync(12000);
    lastSocket().fakeMessage({ event: "video_model_binding_result", ok: true, chat_id: "video-chat", request_id: request.request_id, model_binding: binding });
    await expect(changed).resolves.toEqual(binding);
    expect(globalChange).not.toHaveBeenCalled();
    client.close();
  });

  it("rejects a failed video chat selection immediately using its request id", async () => {
    const client = new MonaClient({ url: "ws://test", reconnect: false, socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket });
    client.connect(); lastSocket().fakeOpen();
    const created = client.newChat(45000, false, null, "video", null);
    const rejected = expect(created).rejects.toThrow("模型暂不可用");
    const request = JSON.parse(lastSocket().sent.at(-1)!);
    lastSocket().fakeMessage({ event: "error", request_id: request.request_id, detail: "模型暂不可用" });
    await rejected;
    client.close();
  });

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

  it("clears a finished video run without a mounted chat panel or idle event", () => {
    const client = new MonaClient({ url: "ws://test", reconnect: false, socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket });
    const status = vi.fn();
    client.onRunStatus(status);
    client.connect();
    lastSocket().fakeOpen();
    lastSocket().fakeMessage({ event: "goal_status", chat_id: "video", status: "running", started_at: 12345 });
    lastSocket().fakeMessage({ event: "stream_end", chat_id: "video" });
    expect(client.getRunStartedAt("video")).toBe(12345);
    lastSocket().fakeMessage({ event: "turn_end", chat_id: "video" });
    expect(client.getRunStartedAt("video")).toBeNull();
    expect(status).toHaveBeenLastCalledWith("video", null);
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
      JSON.stringify({ type: "message", chat_id: "chat-x", content: "hello", webui: true, ui_theme: "light" }),
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
      ui_theme: "light",
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
      ui_theme: "light",
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

  it("sends the current theme as message metadata for generated visual colors", () => {
    const client = new MonaClient({
      url: "ws://test", reconnect: false,
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    client.connect();
    lastSocket().fakeOpen();
    document.documentElement.classList.add("dark");
    try {
      client.sendMessage("theme-chat", "画图");
      expect(JSON.parse(lastSocket().sent.at(-1) as string).ui_theme).toBe("dark");
    } finally {
      document.documentElement.classList.remove("dark");
    }
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

    client.sendMessage("room-1", "增长还是利润？", undefined, {
      targetAgentIds: ["agent.a", "agent.b"],
      taskId: "task-quarrel-1",
      discussion: {
        mode: "quarrel",
        maxRounds: 3,
        participantIds: ["agent.a", "agent.b"],
        positions: {},
        roles: { "agent.a": "张三", "agent.b": "李四" },
        styles: {},
        summaryAgentId: null,
      },
    });

    expect(JSON.parse(lastSocket().sent.at(-1) as string)).toMatchObject({
      type: "start_discussion",
      target_agent_ids: ["agent.a", "agent.b"],
      task_id: "task-quarrel-1",
      discussion: {
        mode: "quarrel",
        max_rounds: 3,
        positions: {},
        roles: { "agent.a": "张三", "agent.b": "李四" },
        styles: {},
        summary_agent_id: null,
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

  it("sends generic run_workflow inputs and template references", async () => {
    const client = new MonaClient({
      url: "ws://test",
      reconnect: false,
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    client.connect();
    lastSocket().fakeOpen();

    // No inputs means the field is omitted entirely.
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

    // Structured workflow inputs ride along verbatim.
    const inputsPromise = client.runWorkflow("room1", {
      discussion: { topic: "product launch" },
    });
    const withInputs = JSON.parse(lastSocket().sent.at(-1) as string);
    expect(withInputs).toMatchObject({
      type: "run_workflow",
      chat_id: "room1",
      inputs: { discussion: { topic: "product launch" } },
    });
    lastSocket().fakeMessage({
      event: "run_workflow_result",
      ok: true,
      chat_id: "room1",
      request_id: withInputs.request_id,
    });
    await inputsPromise;

    const templatePromise = client.runWorkflow(
      "room1",
      { discussion: { topic: "product launch" } },
      "package://com.example.team/workflows/research.json",
    );
    const templateSent = JSON.parse(lastSocket().sent.at(-1) as string);
    expect(templateSent).toMatchObject({
      type: "run_workflow",
      chat_id: "room1",
      template_ref: "package://com.example.team/workflows/research.json",
    });
    lastSocket().fakeMessage({
      event: "run_workflow_result",
      ok: true,
      chat_id: "room1",
      request_id: templateSent.request_id,
    });
    await templatePromise;

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
