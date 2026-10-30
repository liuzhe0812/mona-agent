import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { useEffect, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MessageRejectionDialog } from "@/components/thread/MessageRejectionDialog";
import { useMonaStream } from "@/hooks/useMonaStream";
import { reconcileHistoryMessages } from "@/hooks/useSessions";
import { MonaClient } from "@/lib/mona-client";
import type { InboundEvent, UIMessage } from "@/lib/types";
import { ClientProvider } from "@/providers/ClientProvider";

class Socket {
  readyState = 1;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  send(frame: string) { this.sent.push(frame); }
  close() { this.readyState = 3; this.onclose?.(); }
  emit(event: InboundEvent) { this.onmessage?.({ data: JSON.stringify(event) } as MessageEvent); }
  get messages() { return this.sent.map((frame) => JSON.parse(frame)).filter((frame) => frame.type === "message"); }
}

const clients: MonaClient[] = [];
const empty: UIMessage[] = [];
const trace: UIMessage = { id: "old-trace", role: "tool", kind: "trace", content: "Using tools", createdAt: 1, historyPosition: 1 };

function setup() {
  const socket = new Socket();
  const client = new MonaClient({ url: "ws://test", reconnect: false, socketFactory: () => socket as unknown as WebSocket });
  clients.push(client);
  client.connect();
  socket.onopen?.();
  function wrapper({ children }: { children: ReactNode }) {
    return <ClientProvider client={client} token="test-token" runtimeStatus="ready">{children}</ClientProvider>;
  }
  return { client, socket, wrapper };
}

afterEach(() => clients.splice(0).forEach((client) => client.close()));

describe("chat admission and runtime recovery", () => {
  it("observes an unknown original send without new task identity, duplicate bubbles or replay", () => {
    const { socket, wrapper } = setup();
    const { result } = renderHook(() => useMonaStream("chat", empty), { wrapper });
    vi.spyOn(socket, "send").mockImplementationOnce(() => { throw new Error("synthetic send interruption"); });
    act(() => result.current.send("original input", undefined, { inputId: "same-input" }));
    const originalTask = result.current.currentTaskId;
    const observer = vi.fn();
    act(() => result.current.send("original input", undefined, { inputId: "same-input", onAdmission: observer }));
    expect(observer).toHaveBeenCalledWith("unknown");
    expect(result.current.currentTaskId).toBe(originalTask);
    expect(result.current.messages).toHaveLength(1);
    expect(socket.messages).toEqual([]);
  });

  it("reports explicit admission for a stable normal input without treating it as model output", () => {
    const { socket, wrapper } = setup();
    const admission = vi.fn();
    const { result } = renderHook(() => useMonaStream("chat", empty), { wrapper });
    act(() => result.current.send("normal request", undefined, { inputId: "normal-input", onAdmission: admission }));
    expect(socket.messages[0]).toMatchObject({ input_id: "normal-input", content: "normal request" });
    expect(admission).not.toHaveBeenCalled();
    act(() => socket.emit({ event: "message_accepted", chat_id: "chat", input_id: "normal-input" }));
    expect(admission).toHaveBeenCalledTimes(1);
    expect(admission).toHaveBeenCalledWith("accepted");
    expect(result.current.messages[0]).toMatchObject({ id: "normal-input", sendState: undefined });
    expect(result.current.messages[0].isInjected).toBeUndefined();
    expect(result.current.isAwaitingModelResponse).toBe(true);
  });

  it.each(["accepted", "cancelled"] as const)("restores a normal %s input without a guide badge or pending execution", (state) => {
    const { client, socket, wrapper } = setup();
    if (state === "cancelled") socket.close();
    client.sendMessage("chat", "normal input", undefined, { inputId: "normal-input" });
    if (state === "accepted") socket.emit({ event: "message_accepted", chat_id: "chat", input_id: "normal-input" });
    else expect(client.cancelUnsentInput("chat", "normal-input")).toBe(true);
    const initial: UIMessage[] = [{ id: "normal-input", role: "user", content: "normal input", taskId: "normal-task", sendState: "pending", createdAt: 1 }];
    const { result } = renderHook(() => useMonaStream("chat", initial), { wrapper });
    expect(result.current.messages[0].sendState).toBe(state === "accepted" ? undefined : "rejected");
    expect(result.current.messages[0].isInjected).toBeUndefined();
    expect(result.current.currentTaskId).toBeNull();
    expect(result.current.isStreaming).toBe(false);
  });

  it("withdraws an offline original input without dispatching it or a stop command", async () => {
    const { socket, wrapper, client } = setup();
    socket.close();
    const { result } = renderHook(() => useMonaStream("chat", empty), { wrapper });
    const admission = vi.fn();
    act(() => result.current.send("original draft", undefined, { docPaths: ["uploads/a.pdf"], documentNames: ["a.pdf"], onAdmission: admission }));
    const inputId = result.current.messages[0].id;
    expect(result.current.isStreaming).toBe(true);
    await act(async () => result.current.stop());
    expect(result.current.isStreaming).toBe(false);
    expect(result.current.isAwaitingModelResponse).toBe(false);
    expect(result.current.messageRejection).toBeNull();
    expect(result.current.messages[0]).toMatchObject({ id: inputId, content: "original draft", sendState: "rejected", media: [{ kind: "file", name: "a.pdf" }] });
    expect(admission).toHaveBeenCalledTimes(1);
    expect(admission).toHaveBeenCalledWith("cancelled");
    client.connect(); socket.readyState = 1; socket.onopen?.();
    expect(socket.messages).toEqual([]);
    expect(socket.sent.map((frame) => JSON.parse(frame)).some((frame) => frame.type === "stop_work_turn")).toBe(false);
  });

  it("keeps a dispatched original input unknown until its exact turn can be stopped", async () => {
    const { socket, wrapper } = setup();
    const { result } = renderHook(() => useMonaStream("chat", empty), { wrapper });
    act(() => result.current.send("original request"));
    const inputId = result.current.messages[0].id;
    expect(socket.messages[0].input_id).toBe(inputId);
    await act(async () => result.current.stop());
    expect(result.current.messageRejection?.stopOutcome).toBe("unsupported");
    expect(result.current.isStreaming).toBe(true);
    act(() => socket.emit({ event: "goal_status", chat_id: "chat", status: "running", started_at: 10, turn_id: "original-turn", input_id: inputId }));
    act(() => result.current.stop());
    const stop = socket.sent.map((frame) => JSON.parse(frame)).find((frame) => frame.type === "stop_work_turn");
    expect(stop.expected_turn_id).toBe("original-turn");
    await act(async () => socket.emit({ event: "work_turn_stop_result", request_id: stop.request_id,
      ok: true, chat_id: "chat", turn_id: "original-turn", outcome: "stopped" }));
    expect(result.current.isStreaming).toBe(false);
    expect(socket.messages).toHaveLength(1);
  });

  it("keeps the newer turn running when an older stop finishes", async () => {
    const { socket, wrapper } = setup();
    const { result } = renderHook(() => useMonaStream("chat", empty), { wrapper });
    act(() => socket.emit({ event: "goal_status", chat_id: "chat", status: "running", started_at: 10, turn_id: "turn-a" }));
    act(() => result.current.stop());
    const stop = socket.sent.map((frame) => JSON.parse(frame)).find((frame) => frame.type === "stop_work_turn");
    expect(stop.expected_turn_id).toBe("turn-a");
    expect(socket.messages).toEqual([]);
    act(() => socket.emit({ event: "goal_status", chat_id: "chat", status: "running", started_at: 20, turn_id: "turn-b" }));
    await act(async () => socket.emit({ event: "work_turn_stop_result", request_id: stop.request_id, ok: true,
      chat_id: "chat", turn_id: "turn-a", outcome: "already_finished" }));
    expect(result.current.isStreaming).toBe(true);
    expect(result.current.stopping).toBe(false);
    expect(result.current.runStartedAt).toBe(20);
    expect(result.current.messageRejection).toBeNull();
  });

  it("does not apply a late stop result to a different visible chat", async () => {
    const { socket, wrapper } = setup();
    const { result, rerender } = renderHook(({ chat }) => useMonaStream(chat, empty), {
      wrapper, initialProps: { chat: "chat-a" },
    });
    act(() => socket.emit({ event: "goal_status", chat_id: "chat-a", status: "running", started_at: 10, turn_id: "turn-a" }));
    act(() => result.current.stop());
    const stop = socket.sent.map((frame) => JSON.parse(frame)).find((frame) => frame.type === "stop_work_turn");
    rerender({ chat: "chat-b" });
    act(() => socket.emit({ event: "goal_status", chat_id: "chat-b", status: "running", started_at: 20, turn_id: "turn-b" }));
    await act(async () => socket.emit({ event: "work_turn_stop_result", request_id: stop.request_id, ok: true,
      chat_id: "chat-a", turn_id: "turn-a", outcome: "stopped" }));
    expect(result.current.isStreaming).toBe(true);
    expect(result.current.runStartedAt).toBe(20);
    expect(result.current.messages).toEqual([]);
  });

  it("reports an unconfirmed stop instead of falling back to a session command", async () => {
    const { socket, wrapper } = setup();
    const { result } = renderHook(() => useMonaStream("chat", empty), { wrapper });
    act(() => socket.emit({ event: "goal_status", chat_id: "chat", status: "running", started_at: 10 }));
    await act(async () => result.current.stop());
    expect(socket.messages).toEqual([]);
    expect(socket.sent.map((frame) => JSON.parse(frame)).some((frame) => frame.type === "stop_work_turn")).toBe(false);
    expect(result.current.messageRejection).toEqual({ runActive: true, stopOutcome: "unsupported" });
    expect(result.current.isStreaming).toBe(true);
  });

  it("releases only the rejected send, retains its attachments, and allows a plain retry without stop", () => {
    const { socket, wrapper, client } = setup();
    const transportError = vi.fn();
    client.onError(transportError);
    const { result } = renderHook(() => useMonaStream("chat", empty), { wrapper });
    act(() => result.current.send("保留这段输入", undefined, {
      taskId: "rejected", agentKind: "video", docPaths: ["uploads/brief.pdf"], documentNames: ["brief.pdf"],
    }));
    expect(socket.messages[0].task_id).toBe("rejected");
    act(() => {
      socket.emit({ event: "goal_state", chat_id: "chat", goal_state: { active: false } });
      socket.emit({ event: "goal_status", chat_id: "chat", status: "idle" });
      socket.emit({ event: "artifact_task_started", chat_id: "chat", task_id: "old-hydrated-task" });
    });
    expect(result.current.currentTaskId).toBe("rejected");
    expect(result.current.isAwaitingModelResponse).toBe(true);
    act(() => socket.emit({ event: "error", chat_id: "chat", task_id: "rejected", message_rejected: true, detail: "invalid_agent_kind_context" }));

    expect(result.current.isStreaming).toBe(false);
    expect(result.current.isAwaitingModelResponse).toBe(false);
    expect(result.current.runStartedAt).toBeNull();
    expect(result.current.messageRejection).toEqual({ runActive: false });
    expect(result.current.messages).toEqual([expect.objectContaining({
      content: "保留这段输入", sendState: "rejected", media: [{ kind: "file", name: "brief.pdf" }],
    })]);
    act(() => result.current.stop());
    expect(socket.messages).toHaveLength(1);
    act(() => result.current.send("继续普通聊天"));
    expect(socket.messages).toHaveLength(2);
    expect(socket.messages[1]).toMatchObject({ content: "继续普通聊天" });
    expect(socket.messages[1]).not.toHaveProperty("agent_kind");
    expect(transportError).not.toHaveBeenCalled();
  });

  it.each(["new-task", "running-task"])("keeps a confirmed earlier run when request %s is rejected", (taskId) => {
    const { socket, wrapper } = setup();
    const { result } = renderHook(() => useMonaStream("chat", empty), { wrapper });
    act(() => {
      socket.emit({ event: "artifact_task_started", chat_id: "chat", task_id: "running-task" });
      socket.emit({ event: "goal_status", chat_id: "chat", status: "running", started_at: 100 });
    });
    act(() => result.current.send("切换任务", undefined, { taskId, agentKind: "video" }));
    act(() => {
      socket.emit({ event: "artifact_task_started", chat_id: "chat", task_id: "running-task" });
      socket.emit({ event: "message", chat_id: "chat", text: "", kind: "progress", context_compacting: true });
      socket.emit({ event: "error", chat_id: "chat", task_id: taskId, message_rejected: true, code: "run_active" });
    });

    expect(result.current.isStreaming).toBe(true);
    expect(result.current.isAwaitingModelResponse).toBe(false);
    expect(result.current.currentTaskId).toBe("running-task");
    expect(result.current.runStartedAt).toBe(100);
    expect(result.current.isCompacting).toBe(true);
    expect(result.current.messageRejection).toEqual({ runActive: true });
    expect(socket.messages.map((message) => message.content)).toEqual(["切换任务"]);
  });

  it("ignores unrelated and non-admission errors during a pending send or an accepted run", () => {
    const { socket, wrapper } = setup();
    const { result } = renderHook(() => useMonaStream("chat", empty), { wrapper });
    act(() => result.current.send("hello", undefined, { taskId: "current" }));
    act(() => {
      socket.emit({ event: "error", chat_id: "chat", task_id: "different", message_rejected: true });
      socket.emit({ event: "error", chat_id: "chat", task_id: "current", detail: "control failed" });
      socket.emit({ event: "error", task_id: "current", message_rejected: true });
    });
    expect(result.current.isAwaitingModelResponse).toBe(true);
    expect(result.current.messageRejection).toBeNull();
    act(() => {
      socket.emit({ event: "artifact_task_started", chat_id: "chat", task_id: "current" });
      socket.emit({ event: "goal_status", chat_id: "chat", status: "running", started_at: 200 });
      socket.emit({ event: "error", chat_id: "chat", task_id: "current", message_rejected: true });
    });
    expect(result.current.isStreaming).toBe(true);
    expect(result.current.messageRejection).toBeNull();
    expect(result.current.messages[0].sendState).toBeUndefined();
  });

  it("uses idle to recover an old trace and keeps a new send across attach and history refresh", async () => {
    const { socket, wrapper } = setup();
    socket.emit({ event: "goal_status", chat_id: "chat", status: "idle" });
    const { result, rerender } = renderHook(({ initial }) => useMonaStream("chat", initial, true), {
      wrapper, initialProps: { initial: [trace] },
    });
    expect(result.current.isStreaming).toBe(false);
    act(() => result.current.send("new input", undefined, { taskId: "new" }));
    await act(async () => { await Promise.resolve(); });
    act(() => {
      socket.emit({ event: "turn_end", chat_id: "chat", task_id: "old" });
      socket.emit({ event: "goal_status", chat_id: "chat", status: "idle" });
    });
    rerender({ initial: [{ ...trace }] });
    act(() => result.current.setMessages((messages) => reconcileHistoryMessages(messages, [trace], { isStreaming: false })));
    expect(result.current.isAwaitingModelResponse).toBe(true);
    expect(result.current.isStreaming).toBe(true);
    expect(result.current.messages.at(-1)).toMatchObject({ content: "new input", sendState: "pending" });
    act(() => socket.emit({ event: "error", chat_id: "chat", task_id: "new", message_rejected: true }));
    act(() => result.current.setMessages((messages) => reconcileHistoryMessages(messages, [trace])));
    expect(result.current.isStreaming).toBe(false);
    expect(result.current.messages.at(-1)).toMatchObject({ content: "new input", sendState: "rejected" });
  });

  it("shows running from the client cache and does not revive it from history after completion or a chat switch", async () => {
    const { socket, wrapper } = setup();
    socket.emit({ event: "goal_status", chat_id: "chat", status: "running", started_at: 300 });
    const { result, rerender } = renderHook(({ chat }) => useMonaStream(chat, [trace], true), {
      wrapper, initialProps: { chat: "chat" },
    });
    expect(result.current.isStreaming).toBe(true);
    expect(result.current.runStartedAt).toBe(300);
    await act(async () => { await Promise.resolve(); });
    act(() => socket.emit({ event: "goal_status", chat_id: "chat", status: "idle" }));
    rerender({ chat: "other" });
    rerender({ chat: "chat" });
    expect(result.current.isStreaming).toBe(false);
    expect(result.current.runStartedAt).toBeNull();
    expect(result.current.messages).toEqual([trace]);
  });

  it("restores a running status even when its optional start time is absent", async () => {
    const { socket, wrapper } = setup();
    socket.emit({ event: "goal_status", chat_id: "chat", status: "running" });
    const { result } = renderHook(() => useMonaStream("chat", empty), { wrapper });
    await act(async () => { await Promise.resolve(); });
    expect(result.current.isStreaming).toBe(true);
    expect(result.current.runStartedAt).toEqual(expect.any(Number));
  });

  it("keeps wire order when a live idle frame arrives before cached running frames replay", async () => {
    const { socket, wrapper } = setup();
    socket.emit({ event: "goal_status", chat_id: "chat", status: "running", started_at: 400 });
    const { result } = renderHook(() => useMonaStream("chat", [trace], true), { wrapper });
    act(() => socket.emit({ event: "goal_status", chat_id: "chat", status: "idle" }));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.isStreaming).toBe(false);
    expect(result.current.runStartedAt).toBeNull();
  });

  it("retains cached unconfirmed input without reviving a run that the server reports idle", async () => {
    const { socket, wrapper } = setup();
    socket.emit({ event: "goal_status", chat_id: "chat", status: "idle" });
    const pending: UIMessage = { id: "local", role: "user", content: "keep me", taskId: "pending", sendState: "pending", createdAt: 2 };
    const { result } = renderHook(() => useMonaStream("chat", [trace, pending], true), { wrapper });
    await act(async () => { await Promise.resolve(); });
    expect(result.current.isStreaming).toBe(false);
    expect(result.current.isAwaitingModelResponse).toBe(false);
    expect(result.current.messages.at(-1)).toEqual(pending);
    act(() => socket.emit({ event: "error", chat_id: "chat", task_id: "pending", message_rejected: true }));
    expect(result.current.messages.at(-1)?.sendState).toBe("rejected");
    expect(result.current.messageRejection).toEqual({ runActive: false });
  });

  it("presents one safe error dialog only for the hook that sent the rejected message", () => {
    const { socket, wrapper } = setup();
    let sender!: ReturnType<typeof useMonaStream>;
    function Sender() {
      sender = useMonaStream("chat", empty);
      return <MessageRejectionDialog rejection={sender.messageRejection} onDismiss={sender.dismissMessageRejection} />;
    }
    function Observer() {
      const observer = useMonaStream("chat", empty);
      return <MessageRejectionDialog rejection={observer.messageRejection} onDismiss={observer.dismissMessageRejection} />;
    }
    render(<><Sender /><Observer /></>, { wrapper });
    act(() => sender.send("hello", undefined, { taskId: "mine" }));
    act(() => socket.emit({ event: "error", chat_id: "chat", task_id: "mine", message_rejected: true, detail: "invalid_agent_kind_context" }));
    expect(screen.getAllByRole("alertdialog")).toHaveLength(1);
    expect(screen.getByRole("alertdialog")).toHaveTextContent("Message not sent");
    expect(screen.getByRole("alertdialog")).not.toHaveTextContent("invalid_agent_kind_context");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("retains a send started during mount while an earlier idle snapshot is replayed", async () => {
    const { socket, wrapper } = setup();
    socket.emit({ event: "goal_status", chat_id: "chat", status: "idle" });
    const { result } = renderHook(() => {
      const stream = useMonaStream("chat", empty);
      useEffect(() => stream.send("first input", undefined, { taskId: "first" }), []);
      return stream;
    }, { wrapper });
    await act(async () => { await Promise.resolve(); });
    expect(result.current.isStreaming).toBe(true);
    expect(result.current.isAwaitingModelResponse).toBe(true);
    expect(result.current.messages[0]).toMatchObject({ content: "first input", sendState: "pending" });
  });

  it("keeps an accepted guide pending until consumption and retains attachments for an explicit retry", () => {
    const { socket, wrapper } = setup();
    const receipt = vi.fn();
    const { result } = renderHook(() => useMonaStream("chat", empty), { wrapper });
    act(() => socket.emit({ event: "artifact_task_started", chat_id: "chat", task_id: "same-task" }));
    act(() => socket.emit({ event: "goal_status", chat_id: "chat", status: "running", turn_id: "turn-a" }));
    const options = { inputId: "input-one", docPaths: ["uploads/brief.pdf"], documentNames: ["brief.pdf"], onAdmission: receipt };
    act(() => result.current.inject("", undefined, options));
    expect(socket.messages[0]).toMatchObject({ input_id: "input-one", task_id: "same-task", target_turn_id: "turn-a", doc_paths: options.docPaths });
    expect(result.current.messages.at(-1)).toMatchObject({ id: "input-one", sendState: "pending", isInjected: false });
    act(() => socket.emit({ event: "error", chat_id: "chat", task_id: "same-task", input_id: "unrelated-input", message_rejected: true }));
    expect(receipt).not.toHaveBeenCalled();
    expect(result.current.messageRejection).toBeNull();
    act(() => socket.emit({ event: "error", chat_id: "chat", task_id: "same-task", input_id: "input-one", target_turn_id: "turn-a", message_rejected: true }));
    expect(receipt).toHaveBeenLastCalledWith("rejected");
    expect(result.current.messages.at(-1)).toMatchObject({ sendState: "rejected", media: [{ kind: "file", name: "brief.pdf" }] });
    act(() => result.current.inject("", undefined, options));
    expect(socket.messages[1]).toMatchObject({ input_id: "input-one", doc_paths: options.docPaths });
    act(() => socket.emit({ event: "message_accepted", chat_id: "chat", input_id: "input-one" }));
    expect(receipt).toHaveBeenLastCalledWith("rejected");
    act(() => socket.emit({ event: "work_input_state", chat_id: "chat", input_id: "input-one", turn_id: "turn-a", state: "accepted" }));
    expect(receipt).toHaveBeenLastCalledWith("accepted");
    expect(result.current.messages[0]).toMatchObject({ isInjected: false, sendState: "pending" });
    act(() => socket.emit({ event: "work_input_state", chat_id: "chat", input_id: "input-one", turn_id: "turn-a", state: "consumed" }));
    expect(receipt).toHaveBeenLastCalledWith("consumed");
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0]).toMatchObject({ isInjected: true, sendState: undefined });
    expect(result.current.messageRejection).toBeNull();
  });

  it("retains an unknown append without replay, and settles a late receipt in the original chat", () => {
    vi.useFakeTimers();
    try {
      const { client, socket, wrapper } = setup();
      const receipt = vi.fn();
      const { result, rerender } = renderHook(({ chatId }) => useMonaStream(chatId, empty), { wrapper, initialProps: { chatId: "chat" } });
      act(() => socket.emit({ event: "goal_status", chat_id: "chat", status: "running", turn_id: "turn-a" }));
      act(() => result.current.inject("do this once", undefined, { inputId: "input-one", onAdmission: receipt }));
      act(() => vi.advanceTimersByTime(15_000));
      expect(receipt).toHaveBeenLastCalledWith("unknown");
      expect(result.current.messageRejection?.uncertain).toBe(true);
      act(() => result.current.inject("do this once", undefined, { inputId: "input-one", onAdmission: receipt }));
      expect(socket.messages).toHaveLength(1);
      rerender({ chatId: "other-chat" });
      act(() => socket.emit({ event: "work_input_state", chat_id: "chat", input_id: "input-one", turn_id: "turn-a", state: "consumed" }));
      expect(receipt).toHaveBeenLastCalledWith("consumed");
      expect(client.getMessageAdmission("chat", "input-one")).toBe("consumed");
      expect(result.current.messages).toEqual([]);
      expect(result.current.messageRejection).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it("preserves an unconsumed guide on stop and resumes it once under the user's selected new turn", () => {
    const { socket, wrapper } = setup();
    const receipt = vi.fn();
    const { result } = renderHook(() => useMonaStream("chat", empty), { wrapper });
    act(() => socket.emit({ event: "goal_status", chat_id: "chat", status: "running", turn_id: "turn-a" }));
    const options = { inputId: "paused-input", docPaths: ["uploads/brief.pdf"], documentNames: ["brief.pdf"], onAdmission: receipt };
    act(() => result.current.inject("supplement", undefined, options));
    act(() => socket.emit({ event: "work_input_state", chat_id: "chat", input_id: "paused-input", turn_id: "turn-a", state: "accepted" }));
    act(() => socket.emit({ event: "work_input_state", chat_id: "chat", input_id: "paused-input", turn_id: "turn-a", state: "paused" }));
    expect(result.current.messages[0]).toMatchObject({ isInjected: false, sendState: "rejected", media: [{ name: "brief.pdf" }] });
    expect(result.current.messageRejection).toBeNull();
    act(() => socket.emit({ event: "goal_status", chat_id: "chat", status: "running", turn_id: "turn-b" }));
    act(() => result.current.inject("supplement", undefined, { ...options, resumeInput: true }));
    expect(socket.messages).toHaveLength(2);
    expect(socket.messages[1]).toMatchObject({ input_id: "paused-input", target_turn_id: "turn-b", resume_input: true, doc_paths: options.docPaths });
    act(() => socket.emit({ event: "work_input_state", chat_id: "chat", input_id: "paused-input", turn_id: "turn-a", state: "consumed" }));
    expect(result.current.messages[0].isInjected).toBe(false);
    act(() => socket.emit({ event: "work_input_state", chat_id: "chat", input_id: "paused-input", turn_id: "turn-b", state: "consumed" }));
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0]).toMatchObject({ isInjected: true, sendState: undefined });
    expect(receipt).toHaveBeenLastCalledWith("consumed");
  });

  it("rejects a guide when a running task has no confirmed turn instead of starting another task", () => {
    const { socket, wrapper } = setup();
    const receipt = vi.fn();
    const { result } = renderHook(() => useMonaStream("chat", empty), { wrapper });
    act(() => socket.emit({ event: "goal_status", chat_id: "chat", status: "running" }));
    act(() => result.current.inject("keep this supplement", undefined, { inputId: "input-a", onAdmission: receipt }));
    expect(receipt).toHaveBeenCalledWith("rejected");
    expect(socket.messages).toEqual([]);
    expect(result.current.isStreaming).toBe(true);
  });

  it("starts an explicitly selected idle queued input and waits for consumption before clearing it", () => {
    const { socket, wrapper } = setup();
    const receipt = vi.fn();
    const { result } = renderHook(() => useMonaStream("chat", empty), { wrapper });
    act(() => result.current.inject("queued input", undefined, { inputId: "idle-input", onAdmission: receipt }));
    expect(socket.messages[0]).toMatchObject({ input_id: "idle-input", content: "queued input" });
    expect(socket.messages[0]).not.toHaveProperty("target_turn_id");
    act(() => socket.emit({ event: "message_accepted", chat_id: "chat", input_id: "idle-input" }));
    expect(receipt.mock.calls).toEqual([["accepted"]]);
    act(() => socket.emit({ event: "work_input_state", chat_id: "chat", input_id: "idle-input", state: "consumed" }));
    expect(receipt.mock.calls).toEqual([["accepted"], ["consumed"]]);
    expect(result.current.messages[0].isInjected).toBeUndefined();
  });
});
