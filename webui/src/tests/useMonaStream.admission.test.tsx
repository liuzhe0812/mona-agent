import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { useEffect, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MessageRejectionDialog } from "@/components/thread/MessageRejectionDialog";
import { ThreadComposer } from "@/components/thread/ThreadComposer";
import { useMonaStream } from "@/hooks/useMonaStream";
import { reconcileHistoryMessages } from "@/hooks/useSessions";
import i18n from "@/i18n";
import { configureHostedPlatform } from "@/lib/hosted-platform";
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
const hostedReleases: (() => void)[] = [];
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

afterEach(() => {
  clients.splice(0).forEach((client) => client.close());
  hostedReleases.splice(0).forEach((release) => release());
});

describe("chat admission and runtime recovery", () => {

  it("finishes the matching hosted task and lets the user send the next message", async () => {
    const { client, socket, wrapper } = setup();
    let stream!: ReturnType<typeof useMonaStream>;
    function Composer() {
      stream = useMonaStream("chat", empty);
      return <ThreadComposer onSend={stream.send} onStop={() => void stream.stop()}
        isStreaming={stream.isStreaming} isAwaitingModelResponse={stream.isAwaitingModelResponse}
        isCompacting={stream.isCompacting} runStartedAt={stream.runStartedAt} stopping={stream.stopping} />;
    }
    render(<Composer />, { wrapper });
    act(() => stream.send("first request"));
    const { input_id: inputId, task_id: taskId } = socket.messages[0];
    const turnId = "a".repeat(32);
    expect(taskId).toMatch(/^task_/);
    expect(taskId).not.toBe(turnId);
    expect(stream.currentTaskId).toBe(taskId);
    act(() => {
      socket.emit({ event: "message_accepted", chat_id: "chat", input_id: inputId });
      socket.emit({ event: "artifact_task_started", chat_id: "chat", task_id: taskId });
      socket.emit({ event: "goal_status", chat_id: "chat", status: "running", started_at: 100, turn_id: turnId, input_id: inputId });
      socket.emit({ event: "delta", chat_id: "chat", text: "The answer is complete.", task_id: taskId, stream_id: `${turnId}:1` });
      socket.emit({ event: "stream_end", chat_id: "chat", stream_id: `${turnId}:1` });
    });
    expect(stream.messages.at(-1)?.content).toBe("The answer is complete.");
    expect(stream.isStreaming).toBe(true);
    expect(screen.getByRole("status")).toHaveTextContent("Running");
    expect(screen.getByRole("button", { name: "Stop response" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "keep this draft" } });

    act(() => socket.emit({ event: "turn_end", chat_id: "chat", turn_id: turnId, input_id: inputId, task_id: taskId }));
    expect(client.getRunStartedAt("chat")).toBeNull();
    expect(stream.isStreaming).toBe(false);
    expect(stream.stopping).toBe(false);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
    expect(screen.getByRole("textbox")).toHaveValue("keep this draft");
    act(() => socket.emit({ event: "goal_status", chat_id: "chat", status: "idle", turn_id: turnId }));
    expect(stream.runStartedAt).toBeNull();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(socket.messages).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(socket.messages).toHaveLength(2));
    expect(socket.messages[1]).toMatchObject({ content: "keep this draft", chat_id: "chat" });
    expect(socket.messages[1].task_id).toMatch(/^task_/);
    expect(socket.messages[1].task_id).not.toBe(taskId);
    expect(stream.isStreaming).toBe(true);
    expect(screen.getByRole("button", { name: "Stop response" })).toBeInTheDocument();
  });

  it("keeps a newer turn running when the previous turn's completion arrives late", () => {
    const { client, socket, wrapper } = setup();
    const { result } = renderHook(() => useMonaStream("chat", empty), { wrapper });
    act(() => {
      socket.emit({ event: "goal_status", chat_id: "chat", status: "running", started_at: 100, turn_id: "turn-a" });
      socket.emit({ event: "goal_status", chat_id: "chat", status: "running", started_at: 200, turn_id: "turn-b" });
      socket.emit({ event: "turn_end", chat_id: "chat", turn_id: "turn-a" });
      socket.emit({ event: "goal_status", chat_id: "chat", status: "idle", turn_id: "turn-a" });
    });
    expect(client.getWorkTurn("chat")?.turnId).toBe("turn-b");
    expect(result.current.isStreaming).toBe(true);
    expect(result.current.runStartedAt).toBe(200);
    act(() => socket.emit({ event: "turn_end", chat_id: "chat", turn_id: "turn-b" }));
    expect(result.current.isStreaming).toBe(false);
    expect(result.current.runStartedAt).toBeNull();
  });

  it("restores the timer for remaining agent activity after the main turn completes", () => {
    const { socket, wrapper } = setup();
    const { result } = renderHook(() => useMonaStream("chat", empty), { wrapper });
    act(() => socket.emit({ event: "goal_status", chat_id: "chat", status: "running", started_at: 100, turn_id: "turn-a" }));
    act(() => socket.emit({ event: "turn_end", chat_id: "chat", turn_id: "turn-a" }));
    expect(result.current.runStartedAt).toBeNull();
    act(() => {
      socket.emit({ event: "goal_status", chat_id: "chat", status: "running", started_at: 110 });
      socket.emit({ event: "goal_status", chat_id: "chat", status: "idle", turn_id: "turn-a" });
    });
    expect(result.current.isStreaming).toBe(true);
    expect(result.current.runStartedAt).toBe(110);
    act(() => socket.emit({ event: "goal_status", chat_id: "chat", status: "idle" }));
    expect(result.current.isStreaming).toBe(false);
    expect(result.current.runStartedAt).toBeNull();
  });

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

  it("waits for the dispatched input's exact turn and stops it once", async () => {
    const { socket, wrapper } = setup();
    const { result } = renderHook(() => useMonaStream("chat", empty), { wrapper });
    act(() => result.current.send("original request"));
    const inputId = result.current.messages[0].id;
    expect(socket.messages[0].input_id).toBe(inputId);
    await act(async () => result.current.stop());
    expect(result.current.messageRejection).toBeNull();
    expect(result.current.isStreaming).toBe(true);
    expect(result.current.stopping).toBe(true);
    act(() => socket.emit({ event: "goal_status", chat_id: "chat", status: "idle" }));
    expect(result.current.stopping).toBe(true);
    expect(result.current.isStreaming).toBe(true);
    act(() => socket.emit({ event: "goal_status", chat_id: "chat", status: "running", started_at: 9,
      turn_id: "other-turn", input_id: "other-input" }));
    expect(socket.sent.map((frame) => JSON.parse(frame)).filter((frame) => frame.type === "stop_work_turn")).toHaveLength(0);
    await act(async () => socket.emit({ event: "goal_status", chat_id: "chat", status: "running", started_at: 10,
      turn_id: "original-turn", input_id: inputId }));
    const stop = socket.sent.map((frame) => JSON.parse(frame)).find((frame) => frame.type === "stop_work_turn");
    expect(stop.expected_turn_id).toBe("original-turn");
    expect(socket.sent.map((frame) => JSON.parse(frame)).filter((frame) => frame.type === "stop_work_turn")).toHaveLength(1);
    await act(async () => socket.emit({ event: "work_turn_stop_result", request_id: stop.request_id,
      ok: true, chat_id: "chat", turn_id: "original-turn", outcome: "stopped" }));
    expect(result.current.isStreaming).toBe(false);
    expect(socket.messages).toHaveLength(1);
  });

  it("does not dispatch stop if the matching input finishes before a turn id arrives", async () => {
    const { socket, wrapper } = setup();
    const { result } = renderHook(() => useMonaStream("chat", empty), { wrapper });
    act(() => result.current.send("quick request"));
    const input = socket.messages[0];
    act(() => result.current.stop());
    await act(async () => socket.emit({ event: "turn_end", chat_id: "chat", turn_id: "finished-turn",
      input_id: input.input_id, task_id: input.task_id } as InboundEvent));
    expect(result.current.stopping).toBe(false);
    expect(result.current.messageRejection).toBeNull();
    expect(result.current.isStreaming).toBe(false);
    expect(socket.sent.map((frame) => JSON.parse(frame)).filter((frame) => frame.type === "stop_work_turn")).toHaveLength(0);
    expect(socket.messages).toHaveLength(1);
  });

  it("does not dispatch or show an unknown dialog if the matched turn finishes in the same event batch", async () => {
    const { socket, wrapper } = setup();
    const { result } = renderHook(() => useMonaStream("chat", empty), { wrapper });
    act(() => result.current.send("quick request"));
    const input = socket.messages[0];
    act(() => result.current.stop());
    await act(async () => {
      socket.emit({ event: "goal_status", chat_id: "chat", status: "running", started_at: 10,
        turn_id: "quick-turn", input_id: input.input_id });
      socket.emit({ event: "turn_end", chat_id: "chat", turn_id: "quick-turn",
        input_id: input.input_id, task_id: input.task_id, stop_confirmed: true } as InboundEvent);
    });
    expect(result.current.stopping).toBe(false);
    expect(result.current.messageRejection).toBeNull();
    expect(socket.sent.map((frame) => JSON.parse(frame)).filter((frame) => frame.type === "stop_work_turn")).toHaveLength(0);
  });

  it("does not replay a queued stop after disconnect before the turn is identified", async () => {
    const { socket, client, wrapper } = setup();
    const { result } = renderHook(() => useMonaStream("chat", empty), { wrapper });
    act(() => result.current.send("original input"));
    const inputId = socket.messages[0].input_id;
    act(() => result.current.stop());
    await act(async () => socket.close());
    expect(result.current.stopping).toBe(false);
    expect(result.current.messageRejection?.stopOutcome).toBe("unknown");
    client.connect(); socket.readyState = 1; socket.onopen?.();
    await act(async () => socket.emit({ event: "goal_status", chat_id: "chat", status: "running",
      started_at: 10, turn_id: "original-turn", input_id: inputId }));
    expect(socket.sent.map((frame) => JSON.parse(frame)).filter((frame) => frame.type === "stop_work_turn")).toHaveLength(0);
    expect(socket.messages).toHaveLength(1);
  });

  it("does not dispatch a stop after the turn identity wait times out", async () => {
    vi.useFakeTimers();
    try {
      const { socket, wrapper } = setup();
      const { result } = renderHook(() => useMonaStream("chat", empty), { wrapper });
      act(() => result.current.send("original input"));
      const inputId = socket.messages[0].input_id;
      act(() => result.current.stop());
      await act(async () => vi.advanceTimersByTime(10_000));
      expect(result.current.stopping).toBe(false);
      expect(result.current.messageRejection?.stopOutcome).toBe("unknown");
      await act(async () => socket.emit({ event: "goal_status", chat_id: "chat", status: "running",
        started_at: 10, turn_id: "late-turn", input_id: inputId }));
      expect(socket.sent.map((frame) => JSON.parse(frame)).filter((frame) => frame.type === "stop_work_turn")).toHaveLength(0);
      expect(socket.messages).toHaveLength(1);
      act(() => socket.emit({ event: "turn_end", chat_id: "chat", turn_id: "late-turn", input_id: inputId,
        task_id: socket.messages[0].task_id, stop_confirmed: true } as InboundEvent));
      expect(result.current.messageRejection).toBeNull();
    } finally {
      vi.useRealTimers();
    }
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

  it("does not show a stale unknown stop after the exact hosted turn is confirmed finished", async () => {
    const { socket, wrapper } = setup();
    const onTurnEnd = vi.fn();
    const { result } = renderHook(() => useMonaStream("chat", empty, false, onTurnEnd), { wrapper });
    act(() => socket.emit({ event: "goal_status", chat_id: "chat", status: "running", started_at: 10, turn_id: "turn-a" }));
    act(() => result.current.stop());
    const stop = socket.sent.map((frame) => JSON.parse(frame)).find((frame) => frame.type === "stop_work_turn");
    act(() => socket.emit({ event: "turn_end", chat_id: "chat", turn_id: "turn-a", stop_confirmed: true } as InboundEvent));
    await act(async () => socket.emit({ event: "work_turn_stop_result", request_id: stop.request_id, ok: true,
      chat_id: "chat", turn_id: "turn-a", outcome: "unknown" }));
    expect(result.current.messageRejection).toBeNull();
    expect(result.current.isStreaming).toBe(false);
    expect(onTurnEnd).toHaveBeenCalledTimes(1);
    expect(socket.sent.map((frame) => JSON.parse(frame)).filter((frame) => frame.type === "stop_work_turn")).toHaveLength(1);
  });

  it("keeps waiting without a dialog while the stopped turn is still cleaning up", async () => {
    const { socket, wrapper } = setup();
    const { result } = renderHook(() => useMonaStream("chat", empty), { wrapper });
    act(() => socket.emit({ event: "goal_status", chat_id: "chat", status: "running", started_at: 10, turn_id: "turn-a" }));
    act(() => result.current.stop());
    const stop = socket.sent.map((frame) => JSON.parse(frame)).find((frame) => frame.type === "stop_work_turn");
    await act(async () => socket.emit({ event: "work_turn_stop_result", request_id: stop.request_id, ok: true,
      chat_id: "chat", turn_id: "turn-a", outcome: "pending" }));
    expect(result.current.stopping).toBe(true);
    expect(result.current.messageRejection).toBeNull();
    act(() => result.current.stop());
    expect(socket.sent.map((frame) => JSON.parse(frame)).filter((frame) => frame.type === "stop_work_turn")).toHaveLength(1);
    act(() => socket.emit({ event: "turn_end", chat_id: "chat", turn_id: "turn-a", stop_confirmed: true } as InboundEvent));
    expect(result.current.stopping).toBe(false);
    expect(result.current.messageRejection).toBeNull();
    expect(result.current.isStreaming).toBe(false);
  });

  it.each(["unknown", "unsupported"] as const)("does not show a hosted stop dialog for %s", async (outcome) => {
    hostedReleases.push(configureHostedPlatform({ apiBase: "/api/work/desktop", token: "test-account" }));
    const { socket, wrapper } = setup();
    let stream!: ReturnType<typeof useMonaStream>;
    function View() {
      stream = useMonaStream("chat", empty);
      return <MessageRejectionDialog rejection={stream.messageRejection} onDismiss={stream.dismissMessageRejection} />;
    }
    render(<View />, { wrapper });
    act(() => stream.send("original input", undefined, { inputId: "input-one" }));
    act(() => {
      socket.emit({ event: "message_accepted", chat_id: "chat", input_id: "input-one" });
      socket.emit({ event: "goal_status", chat_id: "chat", status: "running", started_at: 10,
        turn_id: "turn-a", input_id: "input-one" });
    });
    act(() => stream.stop());
    const requests = socket.sent.map((frame) => JSON.parse(frame)).filter((frame) => frame.type === "stop_work_turn");
    expect(requests).toHaveLength(1);
    expect(requests[0].expected_turn_id).toBe("turn-a");
    await act(async () => socket.emit({ event: "work_turn_stop_result", request_id: requests[0].request_id,
      ok: true, chat_id: "chat", turn_id: "turn-a", outcome }));
    expect(stream.stopping).toBe(false);
    expect(stream.messageRejection).toBeNull();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(socket.messages).toHaveLength(1);
  });

  it("does not show a hosted stop dialog when pending cleanup becomes unknown", async () => {
    hostedReleases.push(configureHostedPlatform({ apiBase: "/api/work/desktop", token: "test-account" }));
    const { socket, wrapper } = setup();
    const { result } = renderHook(() => useMonaStream("chat", empty), { wrapper });
    act(() => socket.emit({ event: "goal_status", chat_id: "chat", status: "running", started_at: 10, turn_id: "turn-a" }));
    act(() => result.current.stop());
    const stop = socket.sent.map((frame) => JSON.parse(frame)).find((frame) => frame.type === "stop_work_turn");
    await act(async () => socket.emit({ event: "work_turn_stop_result", request_id: stop.request_id, ok: true,
      chat_id: "chat", turn_id: "turn-a", outcome: "pending" }));
    expect(result.current.stopping).toBe(true);
    act(() => socket.emit({ event: "goal_status", chat_id: "chat", status: "running", turn_id: "turn-a",
      turn_state: "unknown", started_at: 10 }));
    expect(result.current.stopping).toBe(false);
    expect(result.current.messageRejection).toBeNull();
    expect(socket.sent.map((frame) => JSON.parse(frame)).filter((frame) => frame.type === "stop_work_turn")).toHaveLength(1);
  });

  it("still shows hosted message admission failures", () => {
    hostedReleases.push(configureHostedPlatform({ apiBase: "/api/work/desktop", token: "test-account" }));
    const { socket, wrapper } = setup();
    let stream!: ReturnType<typeof useMonaStream>;
    function View() {
      stream = useMonaStream("chat", empty);
      return <MessageRejectionDialog rejection={stream.messageRejection} onDismiss={stream.dismissMessageRejection} />;
    }
    render(<View />, { wrapper });
    act(() => stream.send("keep draft", undefined, { inputId: "input-one" }));
    act(() => socket.emit({ event: "error", chat_id: "chat", input_id: "input-one", message_rejected: true,
      code: "insufficient_balance" }));
    expect(stream.messageRejection?.reason).toBe("insufficient_balance");
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(socket.messages).toHaveLength(1);
  });

  it("shows the unknown result once cleanup actually ends without confirmation", async () => {
    const { socket, wrapper } = setup();
    const { result } = renderHook(() => useMonaStream("chat", empty), { wrapper });
    act(() => socket.emit({ event: "goal_status", chat_id: "chat", status: "running", started_at: 10, turn_id: "turn-a" }));
    act(() => result.current.stop());
    const stop = socket.sent.map((frame) => JSON.parse(frame)).find((frame) => frame.type === "stop_work_turn");
    await act(async () => socket.emit({ event: "work_turn_stop_result", request_id: stop.request_id, ok: true,
      chat_id: "chat", turn_id: "turn-a", outcome: "pending" }));
    act(() => socket.emit({ event: "goal_status", chat_id: "chat", status: "running", turn_id: "turn-a",
      turn_state: "unknown", started_at: 10 }));
    expect(result.current.stopping).toBe(false);
    expect(result.current.messageRejection?.stopOutcome).toBe("unknown");
    expect(result.current.messageRejection?.stopTurnId).toBe("turn-a");
  });

  it("does not let a late pending reply hide an already unknown outcome", async () => {
    const { socket, wrapper } = setup();
    const { result } = renderHook(() => useMonaStream("chat", empty), { wrapper });
    act(() => socket.emit({ event: "goal_status", chat_id: "chat", status: "running", started_at: 10, turn_id: "turn-a" }));
    act(() => result.current.stop());
    const stop = socket.sent.map((frame) => JSON.parse(frame)).find((frame) => frame.type === "stop_work_turn");
    act(() => socket.emit({ event: "goal_status", chat_id: "chat", status: "running", turn_id: "turn-a",
      turn_state: "unknown", started_at: 10 }));
    await act(async () => socket.emit({ event: "work_turn_stop_result", request_id: stop.request_id, ok: true,
      chat_id: "chat", turn_id: "turn-a", outcome: "pending" }));
    expect(result.current.stopping).toBe(false);
    expect(result.current.messageRejection?.stopOutcome).toBe("unknown");
  });

  it("dismisses an unknown stop only after the same hosted turn is confirmed finished", async () => {
    const { socket, wrapper } = setup();
    const { result } = renderHook(() => useMonaStream("chat", empty), { wrapper });
    act(() => socket.emit({ event: "goal_status", chat_id: "chat", status: "running", started_at: 10, turn_id: "turn-a" }));
    act(() => result.current.stop());
    const stop = socket.sent.map((frame) => JSON.parse(frame)).find((frame) => frame.type === "stop_work_turn");
    await act(async () => socket.emit({ event: "work_turn_stop_result", request_id: stop.request_id, ok: true,
      chat_id: "chat", turn_id: "turn-a", outcome: "unknown" }));
    expect(result.current.messageRejection?.stopOutcome).toBe("unknown");
    act(() => socket.emit({ event: "goal_status", chat_id: "chat", status: "idle", turn_id: "other", stop_confirmed: true } as InboundEvent));
    expect(result.current.messageRejection?.stopOutcome).toBe("unknown");
    act(() => socket.emit({ event: "goal_status", chat_id: "chat", status: "idle", turn_id: "turn-a", stop_confirmed: true } as InboundEvent));
    expect(result.current.messageRejection).toBeNull();
    expect(result.current.isStreaming).toBe(false);
    expect(socket.sent.map((frame) => JSON.parse(frame)).filter((frame) => frame.type === "stop_work_turn")).toHaveLength(1);
  });

  it("resolves the exact stopped turn after reconnect when its admission reply was lost", async () => {
    const { socket, wrapper } = setup();
    const { result } = renderHook(() => useMonaStream("chat", empty), { wrapper });
    act(() => result.current.send("original input"));
    const inputId = socket.messages[0].input_id;
    act(() => socket.emit({ event: "goal_status", chat_id: "chat", status: "running", started_at: 10,
      turn_id: "turn-a", input_id: inputId }));
    act(() => result.current.stop());
    const stop = socket.sent.map((frame) => JSON.parse(frame)).find((frame) => frame.type === "stop_work_turn");
    await act(async () => socket.emit({ event: "work_turn_stop_result", request_id: stop.request_id, ok: true,
      chat_id: "chat", turn_id: "turn-a", outcome: "unknown" }));
    act(() => socket.emit({ event: "goal_status", chat_id: "chat", status: "idle", turn_id: "turn-a", stop_confirmed: true } as InboundEvent));
    expect(result.current.messageRejection).toBeNull();
    expect(result.current.isStreaming).toBe(false);
    expect(socket.messages).toHaveLength(1);
  });

  it("retains a truly unknown stop after an unconfirmed desktop turn end", async () => {
    const { socket, wrapper } = setup();
    const { result } = renderHook(() => useMonaStream("chat", empty), { wrapper });
    act(() => socket.emit({ event: "goal_status", chat_id: "chat", status: "running", started_at: 10, turn_id: "turn-a" }));
    act(() => result.current.stop());
    const stop = socket.sent.map((frame) => JSON.parse(frame)).find((frame) => frame.type === "stop_work_turn");
    act(() => socket.emit({ event: "turn_end", chat_id: "chat", turn_id: "turn-a" }));
    await act(async () => socket.emit({ event: "work_turn_stop_result", request_id: stop.request_id, ok: true,
      chat_id: "chat", turn_id: "turn-a", outcome: "unknown", external_unknown: true } as InboundEvent));
    expect(result.current.messageRejection?.stopOutcome).toBe("unknown");
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

  it("shows the balance reason only for the matching rejected input and does not reopen or resend it", () => {
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
    act(() => sender.send("keep my input", undefined, { taskId: "mine", inputId: "my-input" }));
    act(() => {
      socket.emit({ event: "error", chat_id: "chat", input_id: "other-input", message_rejected: true, code: "insufficient_balance" });
      socket.emit({ event: "error", chat_id: "other-chat", input_id: "my-input", message_rejected: true, code: "insufficient_balance" });
      socket.emit({ event: "error", chat_id: "chat", input_id: "my-input", code: "insufficient_balance" });
    });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    const rejection = { event: "error", chat_id: "chat", input_id: "my-input", message_rejected: true,
      code: "insufficient_balance", detail: "DO_NOT_RENDER_SERVER_DETAIL" } as const;
    act(() => socket.emit(rejection));
    expect(screen.getAllByRole("alertdialog")).toHaveLength(1);
    expect(screen.getByRole("alertdialog")).toHaveTextContent("Your balance is insufficient. Please top up and try again.");
    expect(screen.getByRole("alertdialog")).not.toHaveTextContent("DO_NOT_RENDER_SERVER_DETAIL");
    expect(i18n.t("errors.messageRejected.insufficientBalance", { lng: "zh-CN" })).toBe("余额不足，请充值后重试。");
    expect(sender.messages.at(-1)).toMatchObject({ id: "my-input", content: "keep my input", sendState: "rejected" });
    expect(socket.messages).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    act(() => socket.emit(rejection));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(socket.messages).toHaveLength(1);
  });

  it("explains a previously unconfirmed task without claiming it is still running or resending the new input", () => {
    const { socket, wrapper, client } = setup();
    let sender!: ReturnType<typeof useMonaStream>;
    function Sender() {
      sender = useMonaStream("chat", empty);
      return <MessageRejectionDialog rejection={sender.messageRejection} onDismiss={sender.dismissMessageRejection} />;
    }
    render(<Sender />, { wrapper });
    act(() => sender.send("keep the draft", undefined, { taskId: "mine", inputId: "input" }));
    act(() => socket.emit({ event: "error", chat_id: "chat", input_id: "input", message_rejected: true,
      code: "work_result_unknown", detail: "DO_NOT_RENDER_SERVER_DETAIL" }));
    expect(client.getMessageAdmission("chat", "input")).toBe("rejected");
    expect(sender.messages.at(-1)).toMatchObject({ content: "keep the draft", sendState: "rejected" });
    expect(sender.messageRejection).toMatchObject({ inputId: "input", reason: "work_result_unknown" });
    expect(screen.getByRole("alertdialog")).toHaveTextContent("previous task's result is unconfirmed");
    expect(screen.getByRole("alertdialog")).not.toHaveTextContent("DO_NOT_RENDER_SERVER_DETAIL");
    expect(i18n.t("errors.messageRejected.workResultUnknown", { lng: "zh-CN" }))
      .toBe("上一任务的结果待核对，这条消息未被接收。输入和附件已保留；请核对上一任务后再继续。");
    expect(socket.messages).toHaveLength(1);
  });

  it.each([
    ["history_media_limit", "This conversation contains too many images", "会话中的图片超过处理上限"],
    ["invalid_history_media", "Images in this conversation cannot be read", "会话中的图片无法读取或已损坏"],
    ["history_media_unavailable", "Images in this conversation are temporarily unavailable", "会话中的图片暂时无法读取或保存"],
  ] as const)("explains %s without losing input or attachments", (code, english, chinese) => {
    const { socket, wrapper, client } = setup();
    let sender!: ReturnType<typeof useMonaStream>;
    function Sender() {
      sender = useMonaStream("chat", empty);
      return <MessageRejectionDialog rejection={sender.messageRejection} onDismiss={sender.dismissMessageRejection} />;
    }
    render(<Sender />, { wrapper });
    const image = { media: { data_url: "data:image/png;base64,YQ==", name: "image.png" },
                    preview: { url: "blob:local", name: "image.png" } };
    act(() => sender.send("keep the draft", [image], { taskId: "mine", inputId: "input" }));
    act(() => socket.emit({ event: "error", chat_id: "chat", input_id: "input", message_rejected: true,
      code, detail: "DO_NOT_RENDER_SERVER_DETAIL" }));
    expect(client.getMessageAdmission("chat", "input")).toBe("rejected");
    expect(sender.messages.at(-1)).toMatchObject({ content: "keep the draft", sendState: "rejected",
      images: [{ name: "image.png" }] });
    expect(sender.messageRejection).toMatchObject({ inputId: "input", reason: code });
    expect(screen.getByRole("alertdialog")).toHaveTextContent(english);
    expect(screen.getByRole("alertdialog")).not.toHaveTextContent("DO_NOT_RENDER_SERVER_DETAIL");
    const key = { history_media_limit: "historyMediaLimit", invalid_history_media: "invalidHistoryMedia",
                  history_media_unavailable: "historyMediaUnavailable" }[code];
    expect(i18n.t(`errors.messageRejected.${key}`, { lng: "zh-CN" })).toContain(chinese);
    expect(socket.messages).toHaveLength(1);
  });

  it.each(["history_media_limit", "invalid_history_media", "history_media_unavailable"] as const)(
    "keeps a task follow-up rejected with %s rather than claiming it is running", (code) => {
      const { socket, wrapper, client } = setup();
      const { result } = renderHook(() => useMonaStream("chat", empty), { wrapper });
      act(() => socket.emit({ event: "goal_status", chat_id: "chat", status: "running", turn_id: "turn-a" }));
      act(() => result.current.inject("keep follow-up", undefined, { inputId: "input", taskId: "task" }));
      act(() => socket.emit({ event: "error", chat_id: "chat", input_id: "input", target_turn_id: "turn-a",
        message_rejected: true, code }));
      expect(client.getMessageAdmission("chat", "input")).toBe("rejected");
      expect(result.current.messageRejection).toMatchObject({ inputId: "input", reason: code });
      expect(result.current.messages.at(-1)).toMatchObject({ content: "keep follow-up", sendState: "rejected" });
      expect(socket.messages).toHaveLength(1);
    },
  );

  it("preserves an injected input rejected because its original task result is unknown", () => {
    const { socket, wrapper, client } = setup();
    const { result } = renderHook(() => useMonaStream("chat", empty), { wrapper });
    act(() => socket.emit({ event: "goal_status", chat_id: "chat", status: "running", turn_state: "unknown", turn_id: "turn-a" }));
    act(() => result.current.inject("keep the follow-up", undefined, { inputId: "input", taskId: "task" }));
    act(() => socket.emit({ event: "error", chat_id: "chat", input_id: "input", target_turn_id: "turn-a",
      message_rejected: true, code: "work_result_unknown" }));
    expect(client.getMessageAdmission("chat", "input")).toBe("rejected");
    expect(result.current.messageRejection).toMatchObject({ inputId: "input", reason: "work_result_unknown" });
    expect(result.current.messages.at(-1)).toMatchObject({ content: "keep the follow-up", sendState: "rejected" });
    expect(socket.messages).toHaveLength(1);
  });

  it("shows the safe previous-result reason for a matching legacy rejection", () => {
    const { socket, wrapper } = setup();
    const { result } = renderHook(() => useMonaStream("chat", empty), { wrapper });
    act(() => result.current.send("keep draft", undefined, { inputId: "input", taskId: "task" }));
    act(() => socket.emit({ event: "error", chat_id: "chat", task_id: "other", message_rejected: true,
      code: "work_result_unknown" }));
    expect(result.current.messageRejection).toBeNull();
    act(() => socket.emit({ event: "error", chat_id: "chat", task_id: "task", message_rejected: true,
      code: "work_result_unknown" }));
    expect(result.current.messageRejection).toEqual({ runActive: false, reason: "work_result_unknown" });
    expect(result.current.messages.at(-1)).toMatchObject({ content: "keep draft", sendState: "rejected" });
    expect(socket.messages).toHaveLength(1);
  });

  it("keeps unrelated error codes and arbitrary detail on the existing generic rejection path", () => {
    const { socket, wrapper } = setup();
    let sender!: ReturnType<typeof useMonaStream>;
    function Sender() {
      sender = useMonaStream("chat", empty);
      return <MessageRejectionDialog rejection={sender.messageRejection} onDismiss={sender.dismissMessageRejection} />;
    }
    render(<Sender />, { wrapper });
    act(() => sender.send("hello", undefined, { inputId: "input", taskId: "task" }));
    act(() => socket.emit({ event: "error", chat_id: "chat", input_id: "input", message_rejected: true,
      code: "other_error", detail: "余额不足，请充值后重试。" }));
    expect(screen.getByRole("alertdialog")).toHaveTextContent("This message was not accepted.");
    expect(screen.getByRole("alertdialog")).not.toHaveTextContent("余额不足");
    expect(sender.messageRejection).toEqual({ runActive: false, inputId: "input" });
    expect(socket.messages).toHaveLength(1);
  });

  it("keeps an uncertain billing request pending and warns not to resend it", () => {
    const { socket, wrapper, client } = setup();
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
    act(() => sender.send("do once", undefined, { inputId: "input", taskId: "task" }));
    const frame = { event: "error", chat_id: "chat", input_id: "input", message_rejected: true,
      code: "billing_unknown", detail: "DO_NOT_RENDER_SERVER_DETAIL" } as const;
    act(() => socket.emit(frame));
    expect(client.getMessageAdmission("chat", "input")).toBe("unknown");
    expect(sender.messageRejection).toEqual({ runActive: false, uncertain: true, inputId: "input", reason: "billing_unknown" });
    expect(sender.messages.at(-1)).toMatchObject({ id: "input", content: "do once", sendState: "pending" });
    expect(screen.getAllByRole("alertdialog")).toHaveLength(1);
    expect(screen.getByRole("alertdialog")).toHaveTextContent("Billing status is unconfirmed. Please do not resend.");
    expect(screen.getByRole("alertdialog")).not.toHaveTextContent("DO_NOT_RENDER_SERVER_DETAIL");
    expect(i18n.t("errors.messageRejected.billingUnknown", { lng: "zh-CN" })).toBe("计费状态待核对，请勿重复发送。");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    act(() => { socket.emit(frame); sender.send("do once", undefined, { inputId: "input", taskId: "task" }); });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(socket.messages).toHaveLength(1);
  });

  it("marks a matching legacy billing error unknown without replaying the input", () => {
    const { socket, wrapper, client } = setup();
    const { result } = renderHook(() => useMonaStream("chat", empty), { wrapper });
    act(() => result.current.send("legacy request", undefined, { inputId: "input", taskId: "task" }));
    act(() => socket.emit({ event: "error", chat_id: "chat", task_id: "other", message_rejected: true, code: "billing_unknown" }));
    expect(result.current.messageRejection).toBeNull();
    act(() => socket.emit({ event: "error", chat_id: "chat", task_id: "task", message_rejected: true, code: "billing_unknown" }));
    expect(client.getMessageAdmission("chat", "input")).toBe("unknown");
    expect(result.current.messageRejection).toEqual({ runActive: false, uncertain: true, inputId: "input", reason: "billing_unknown" });
    act(() => result.current.send("legacy request", undefined, { inputId: "input", taskId: "task" }));
    expect(socket.messages).toHaveLength(1);
  });

  it("ignores a balance rejection for an older target turn", () => {
    const { socket, wrapper } = setup();
    const { result } = renderHook(() => useMonaStream("chat", empty), { wrapper });
    act(() => socket.emit({ event: "goal_status", chat_id: "chat", status: "running", turn_id: "turn-a" }));
    act(() => result.current.inject("follow up", undefined, { inputId: "input", taskId: "task" }));
    act(() => socket.emit({ event: "error", chat_id: "chat", input_id: "input", target_turn_id: "old-turn",
      message_rejected: true, code: "insufficient_balance" }));
    expect(result.current.messageRejection).toBeNull();
    expect(result.current.messages.at(-1)).toMatchObject({ id: "input", sendState: "pending" });
    act(() => socket.emit({ event: "error", chat_id: "chat", input_id: "input", target_turn_id: "turn-a",
      message_rejected: true, code: "insufficient_balance" }));
    expect(result.current.messageRejection).toMatchObject({ runActive: true, inputId: "input", reason: "insufficient_balance" });
    expect(socket.messages).toHaveLength(1);
  });

  it.each(["insufficient_balance", "billing_unknown"] as const)(
    "retains unconfirmed delivery across reconnect until %s arrives", async (code) => {
    vi.useFakeTimers();
    try {
      const sockets: Socket[] = [];
      const client = new MonaClient({ url: "ws://test", reconnect: true,
        socketFactory: () => { const socket = new Socket(); sockets.push(socket); return socket as unknown as WebSocket; } });
      clients.push(client);
      client.connect();
      sockets[0].onopen?.();
      function wrapper({ children }: { children: ReactNode }) {
        return <ClientProvider client={client} token="test-token" runtimeStatus="ready">{children}</ClientProvider>;
      }
      const { result } = renderHook(() => useMonaStream("chat", empty), { wrapper });
      const admission = vi.fn();
      act(() => result.current.send("one request", undefined, { inputId: "input", taskId: "task", onAdmission: admission }));
      act(() => sockets[0].close());
      expect(result.current.messageRejection).toMatchObject({ uncertain: true, inputId: "input" });
      await act(async () => { await vi.advanceTimersByTimeAsync(500); });
      expect(sockets).toHaveLength(2);
      act(() => sockets[1].onopen?.());
      expect(sockets.flatMap((socket) => socket.messages)).toHaveLength(1);
      act(() => sockets[1].emit({ event: "error", chat_id: "chat", input_id: "input", message_rejected: true,
        code }));
      expect(result.current.messageRejection).toEqual(code === "insufficient_balance"
        ? { runActive: false, inputId: "input", reason: code }
        : { runActive: false, uncertain: true, inputId: "input", reason: code });
      expect(result.current.messages.at(-1)).toMatchObject({ content: "one request", sendState: code === "insufficient_balance" ? "rejected" : "pending" });
      expect(admission.mock.calls.filter(([state]) => state === "unknown")).toHaveLength(1);
      expect(sockets.flatMap((socket) => socket.messages)).toHaveLength(1);
    } finally { vi.useRealTimers(); }
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
