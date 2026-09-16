import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { useMonaStream } from "@/hooks/useMonaStream";
import type { InboundEvent, GoalStateWsPayload, TaskPlanWsPayload } from "@/lib/types";
import { ClientProvider } from "@/providers/ClientProvider";

const EMPTY_MESSAGES: import("@/lib/types").UIMessage[] = [];

function fakeClient() {
  const handlers = new Map<string, Set<(ev: InboundEvent) => void>>();
  const runStartedAtByChatId = new Map<string, number>();
  const goalStateByChatId = new Map<string, GoalStateWsPayload>();
  const taskPlanByChatId = new Map<string, TaskPlanWsPayload>();
  const taskIdByChatId = new Map<string, string>();

  function recordGoalStatusForRunStrip(chatId: string, ev: InboundEvent) {
    if (ev.event !== "goal_status") return;
    if (ev.status === "running" && typeof ev.started_at === "number") {
      runStartedAtByChatId.set(chatId, ev.started_at);
    } else {
      runStartedAtByChatId.delete(chatId);
    }
  }

  function recordGoalStateSnapshot(chatId: string, ev: InboundEvent) {
    if (ev.event === "goal_state") {
      goalStateByChatId.set(chatId, ev.goal_state);
      return;
    }
    if (ev.event === "turn_end" && ev.goal_state != null && typeof ev.goal_state === "object") {
      goalStateByChatId.set(chatId, ev.goal_state);
    }
  }

  return {
    client: {
      status: "open" as const,
      defaultChatId: null as string | null,
      onStatus: () => () => {},
      onError: () => () => {},
      getRunStartedAt(chatId: string) {
        const v = runStartedAtByChatId.get(chatId);
        return v === undefined ? null : v;
      },
      getGoalState(chatId: string) {
        return goalStateByChatId.get(chatId);
      },
      getTaskPlan(chatId: string) {
        return taskPlanByChatId.get(chatId);
      },
      onChat(chatId: string, h: (ev: InboundEvent) => void) {
        let set = handlers.get(chatId);
        if (!set) {
          set = new Set();
          handlers.set(chatId, set);
        }
        set.add(h);
        return () => set!.delete(h);
      },
      sendMessage: vi.fn(),
      newChat: vi.fn(),
      attach: vi.fn(),
      connect: vi.fn(),
      close: vi.fn(),
      updateUrl: vi.fn(),
    },
    emit(chatId: string, ev: InboundEvent) {
      recordGoalStatusForRunStrip(chatId, ev);
      recordGoalStateSnapshot(chatId, ev);
      if (ev.event === "artifact_task_started") {
        taskIdByChatId.set(chatId, ev.task_id);
        taskPlanByChatId.delete(chatId);
      } else if (ev.event === "task_plan") {
        const currentTaskId = taskIdByChatId.get(chatId);
        if (!currentTaskId || !ev.task_plan.task_id || ev.task_plan.task_id === currentTaskId) {
          taskPlanByChatId.set(chatId, ev.task_plan);
        }
      }
      const set = handlers.get(chatId);
      set?.forEach((h) => h(ev));
    },
  };
}

function wrap(client: ReturnType<typeof fakeClient>["client"]) {
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

async function flushStreamFrame() {
  await act(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  });
}

describe("useMonaStream", () => {
  it("attaches early delivered files to the final assistant message", () => {
    const fake = fakeClient();
    const { result } = renderHook(() => useMonaStream("chat-deliver", EMPTY_MESSAGES), {
      wrapper: wrap(fake.client),
    });

    const file = {
      path: "clip.mp4",
      absolute_path: "C:/work/clip.mp4",
      name: "clip.mp4",
      size: 12,
      size_human: "12 B",
      mime: "video/mp4",
    };

    act(() => {
      fake.emit("chat-deliver", {
        event: "deliver_files",
        chat_id: "chat-deliver",
        files: [file],
        media_urls: [{
          kind: "video",
          url: "/api/media/sig/video",
          name: "clip.mp4",
        }],
      });
    });

    expect(result.current.messages).toHaveLength(0);

    act(() => {
      fake.emit("chat-deliver", {
        event: "message",
        chat_id: "chat-deliver",
        text: "done",
      });
    });

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0]).toMatchObject({
      role: "assistant",
      content: "done",
      deliveredFiles: [file],
      media: [{
        kind: "video",
        url: "/api/media/sig/video",
        name: "clip.mp4",
      }],
    });
  });

  it("batches answer deltas into one animation-frame update", async () => {
    const fake = fakeClient();
    const requestFrame = vi.spyOn(window, "requestAnimationFrame");
    const { result } = renderHook(() => useMonaStream("chat-batch", EMPTY_MESSAGES), {
      wrapper: wrap(fake.client),
    });

    act(() => {
      fake.emit("chat-batch", {
        event: "delta",
        chat_id: "chat-batch",
        text: "Hello",
      });
      fake.emit("chat-batch", {
        event: "delta",
        chat_id: "chat-batch",
        text: " world",
      });
    });

    expect(requestFrame).toHaveBeenCalledTimes(1);
    expect(result.current.messages).toHaveLength(0);

    await flushStreamFrame();

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0]).toMatchObject({
      role: "assistant",
      content: "Hello world",
      isStreaming: true,
    });
    requestFrame.mockRestore();
  });

  it("keeps a Mona stream intact when a partner job completes between deltas", async () => {
    const fake = fakeClient();
    const { result } = renderHook(() => useMonaStream("chat-room-streams", EMPTY_MESSAGES), {
      wrapper: wrap(fake.client),
    });

    act(() => {
      fake.emit("chat-room-streams", {
        event: "delta",
        chat_id: "chat-room-streams",
        text: "Mona 前半段",
        stream_id: "mona-stream-1",
        author_id: "mona",
      });
    });
    await flushStreamFrame();

    act(() => {
      fake.emit("chat-room-streams", {
        event: "message",
        chat_id: "chat-room-streams",
        text: "A 股分析师的回答",
        author_id: "com.mona.a-share-analyst",
        job_id: "job-a-share-1",
      });
      fake.emit("chat-room-streams", {
        event: "delta",
        chat_id: "chat-room-streams",
        text: "Mona 后半段",
        stream_id: "mona-stream-1",
        author_id: "mona",
      });
      fake.emit("chat-room-streams", {
        event: "stream_end",
        chat_id: "chat-room-streams",
        stream_id: "mona-stream-1",
      });
    });
    await flushStreamFrame();

    const assistantMessages = result.current.messages.filter((message) => message.role === "assistant");
    expect(assistantMessages).toHaveLength(2);
    expect(assistantMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ authorId: "mona", content: "Mona 前半段Mona 后半段" }),
      expect.objectContaining({
        authorId: "com.mona.a-share-analyst",
        jobId: "job-a-share-1",
        content: "A 股分析师的回答",
      }),
    ]));
  });

  it("upserts a replayed partner complete frame by job_id", () => {
    const fake = fakeClient();
    const { result } = renderHook(() => useMonaStream("chat-room-replay", EMPTY_MESSAGES), {
      wrapper: wrap(fake.client),
    });

    const partnerMessage: InboundEvent = {
      event: "message",
      chat_id: "chat-room-replay",
      text: "第一次结果",
      author_id: "com.mona.a-share-analyst",
      job_id: "job-replay-1",
    };
    act(() => {
      fake.emit("chat-room-replay", partnerMessage);
      fake.emit("chat-room-replay", { ...partnerMessage, text: "同一结果重放" });
    });

    const assistantMessages = result.current.messages.filter((message) => message.role === "assistant");
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]).toMatchObject({
      authorId: "com.mona.a-share-analyst",
      jobId: "job-replay-1",
      content: "同一结果重放",
    });
  });

  it("keeps separate workflow step messages in the same run", () => {
    const fake = fakeClient();
    const { result } = renderHook(() => useMonaStream("chat-workflow-steps", EMPTY_MESSAGES), {
      wrapper: wrap(fake.client),
    });

    act(() => {
      fake.emit("chat-workflow-steps", {
        event: "message",
        chat_id: "chat-workflow-steps",
        text: "步骤一结果",
        author_id: "agent-one",
        workflow_run_id: "run-shared",
      });
      fake.emit("chat-workflow-steps", {
        event: "message",
        chat_id: "chat-workflow-steps",
        text: "步骤二结果",
        author_id: "agent-two",
        workflow_run_id: "run-shared",
      });
    });

    const assistantMessages = result.current.messages.filter((message) => message.role === "assistant");
    expect(assistantMessages).toHaveLength(2);
    expect(assistantMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ authorId: "agent-one", content: "步骤一结果" }),
      expect.objectContaining({ authorId: "agent-two", content: "步骤二结果" }),
    ]));
  });

  it("flushes pending delta text before turn_end finalizes the turn", () => {
    const fake = fakeClient();
    const { result } = renderHook(() => useMonaStream("chat-flush", EMPTY_MESSAGES), {
      wrapper: wrap(fake.client),
    });

    act(() => {
      fake.emit("chat-flush", {
        event: "delta",
        chat_id: "chat-flush",
        text: "final chunk",
      });
      fake.emit("chat-flush", {
        event: "turn_end",
        chat_id: "chat-flush",
      });
    });

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0]).toMatchObject({
      role: "assistant",
      content: "final chunk",
      isStreaming: false,
    });
    expect(result.current.isStreaming).toBe(false);
  });

  it("drops pending stream work when switching chats", async () => {
    const fake = fakeClient();
    const { result, rerender } = renderHook(
      ({ chatId }: { chatId: string }) => useMonaStream(chatId, EMPTY_MESSAGES),
      {
        wrapper: wrap(fake.client),
        initialProps: { chatId: "chat-old" },
      },
    );

    act(() => {
      fake.emit("chat-old", {
        event: "delta",
        chat_id: "chat-old",
        text: "stale",
      });
    });

    rerender({ chatId: "chat-new" });

    act(() => {
      fake.emit("chat-new", {
        event: "delta",
        chat_id: "chat-new",
        text: "fresh",
      });
    });
    await flushStreamFrame();

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0]).toMatchObject({
      role: "assistant",
      content: "fresh",
    });
  });

  it("starts in streaming mode when history shows pending tool calls", () => {
    const fake = fakeClient();
    const initialMessages = [{
      id: "m1",
      role: "assistant" as const,
      content: "Using tools",
      createdAt: Date.now(),
    }];
    const { result } = renderHook(
      () => useMonaStream("chat-p", initialMessages, true),
      {
        wrapper: wrap(fake.client),
      },
    );

    expect(result.current.isStreaming).toBe(true);
  });

  it("collapses consecutive tool_hint frames into one trace row", () => {
    const fake = fakeClient();
    const { result } = renderHook(() => useMonaStream("chat-t", EMPTY_MESSAGES), {
      wrapper: wrap(fake.client),
    });

    act(() => {
      fake.emit("chat-t", {
        event: "message",
        chat_id: "chat-t",
        text: 'weather("get")',
        kind: "tool_hint",
      });
      fake.emit("chat-t", {
        event: "message",
        chat_id: "chat-t",
        text: 'search "hk weather"',
        kind: "tool_hint",
      });
    });

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].kind).toBe("trace");
    expect(result.current.messages[0].role).toBe("tool");
    expect(result.current.messages[0].traces).toEqual([
      'weather("get")',
      'search "hk weather"',
    ]);

    act(() => {
      fake.emit("chat-t", {
        event: "message",
        chat_id: "chat-t",
        text: "## Summary",
      });
    });

    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages[1].role).toBe("assistant");
    expect(result.current.messages[1].kind).toBeUndefined();
  });

  it("treats progress with arbitrary agent_ui like ordinary trace text", () => {
    const fake = fakeClient();
    const { result } = renderHook(() => useMonaStream("chat-au", EMPTY_MESSAGES), {
      wrapper: wrap(fake.client),
    });
    act(() => {
      fake.emit("chat-au", {
        event: "message",
        chat_id: "chat-au",
        text: "progress · panel tick",
        kind: "progress",
        agent_ui: {
          kind: "panel",
          data: { version: 1, event: "tick", id: "x1" },
        },
      });
    });
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].kind).toBe("trace");
    expect(result.current.messages[0].content).toContain("panel tick");
  });

  it("renders live tool traces from structured tool events", () => {
    const fake = fakeClient();
    const { result } = renderHook(() => useMonaStream("chat-tool-events", EMPTY_MESSAGES), {
      wrapper: wrap(fake.client),
    });

    act(() => {
      fake.emit("chat-tool-events", {
        event: "message",
        chat_id: "chat-tool-events",
        text: 'search "hermes"',
        kind: "tool_hint",
        task_id: "task-tool-events",
        tool_events: [
          {
            phase: "start",
            name: "web_search",
            arguments: { query: "NousResearch hermes-agent", count: 8 },
          },
          {
            phase: "start",
            name: "web_search",
            arguments: { query: "hermes-agent GitHub stars", count: 8 },
          },
        ],
      });
    });

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].traces).toEqual([
      'web_search({"query":"NousResearch hermes-agent","count":8})',
      'web_search({"query":"hermes-agent GitHub stars","count":8})',
    ]);
    expect(result.current.messages[0].content).toBe(
      'web_search({"query":"hermes-agent GitHub stars","count":8})',
    );
    expect(result.current.messages[0].toolEvents).toHaveLength(2);
    expect(result.current.messages[0].taskId).toBe("task-tool-events");
  });

  it("dedupes finish-phase tool events after their start trace", () => {
    const fake = fakeClient();
    const { result } = renderHook(() => useMonaStream("chat-tool-finish", EMPTY_MESSAGES), {
      wrapper: wrap(fake.client),
    });

    act(() => {
      fake.emit("chat-tool-finish", {
        event: "message",
        chat_id: "chat-tool-finish",
        text: 'exec({"cmd":"ls"})',
        kind: "tool_hint",
        tool_events: [{
          phase: "start",
          call_id: "call-exec",
          name: "exec",
          arguments: { cmd: "ls" },
        }],
      });
      fake.emit("chat-tool-finish", {
        event: "message",
        chat_id: "chat-tool-finish",
        text: "",
        kind: "progress",
        tool_events: [
          {
            phase: "end",
            call_id: "call-exec",
            name: "exec",
            arguments: { cmd: "ls" },
            result: "ok",
          },
          {
            phase: "error",
            call_id: "call-read",
            name: "read_file",
            arguments: { path: "notes.md" },
            error: "missing",
          },
        ],
      });
    });

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].traces).toEqual([
      'exec({"cmd":"ls"})',
      'read_file({"path":"notes.md"})',
    ]);
  });

  it("renders live file_edit events as their own activity trace", () => {
    const fake = fakeClient();
    const { result } = renderHook(() => useMonaStream("chat-file-edit", EMPTY_MESSAGES), {
      wrapper: wrap(fake.client),
    });

    act(() => {
      fake.emit("chat-file-edit", {
        event: "message",
        chat_id: "chat-file-edit",
        text: 'write_file({"path":"foo.txt"})',
        kind: "tool_hint",
      });
      fake.emit("chat-file-edit", {
        event: "file_edit",
        chat_id: "chat-file-edit",
        edits: [{
          call_id: "call-write",
          tool: "write_file",
          path: "foo.txt",
          phase: "start",
          added: 1,
          deleted: 0,
          approximate: true,
          status: "editing",
        }],
      });
      fake.emit("chat-file-edit", {
        event: "file_edit",
        chat_id: "chat-file-edit",
        edits: [{
          call_id: "call-write",
          tool: "write_file",
          path: "foo.txt",
          phase: "end",
          added: 3,
          deleted: 1,
          approximate: false,
          status: "done",
        }],
      });
    });

    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages[0]).toMatchObject({
      role: "tool",
      kind: "trace",
      traces: ['write_file({"path":"foo.txt"})'],
    });
    expect(result.current.messages[1]).toMatchObject({
      role: "tool",
      kind: "trace",
      fileEdits: [{
        call_id: "call-write",
        status: "done",
        added: 3,
        deleted: 1,
        approximate: false,
      }],
    });
    expect(result.current.messages[1].activitySegmentId).toBeTruthy();
    expect(result.current.messages[1].activitySegmentId).not.toBe(
      result.current.messages[0].activitySegmentId,
    );
  });

  it("upgrades pending file_edit placeholders when the path arrives", () => {
    const fake = fakeClient();
    const { result } = renderHook(() => useMonaStream("chat-file-edit-pending", EMPTY_MESSAGES), {
      wrapper: wrap(fake.client),
    });

    act(() => {
      fake.emit("chat-file-edit-pending", {
        event: "file_edit",
        chat_id: "chat-file-edit-pending",
        edits: [{
          call_id: "call-write",
          tool: "write_file",
          path: "",
          phase: "start",
          added: 1,
          deleted: 0,
          approximate: true,
          status: "editing",
          pending: true,
        }],
      });
      fake.emit("chat-file-edit-pending", {
        event: "file_edit",
        chat_id: "chat-file-edit-pending",
        edits: [{
          call_id: "call-write",
          tool: "write_file",
          path: "foo.txt",
          phase: "start",
          added: 12,
          deleted: 0,
          approximate: true,
          status: "editing",
        }],
      });
    });

    const fileEditMessages = result.current.messages.filter((message) => message.fileEdits?.length);
    expect(fileEditMessages).toHaveLength(1);
    expect(fileEditMessages[0].fileEdits).toEqual([{
      call_id: "call-write",
      tool: "write_file",
      path: "foo.txt",
      phase: "start",
      added: 12,
      deleted: 0,
      approximate: true,
      status: "editing",
    }]);
  });

  it("merges file_edit updates after interleaved progress events", () => {
    const fake = fakeClient();
    const { result } = renderHook(() => useMonaStream("chat-file-edit-progress", EMPTY_MESSAGES), {
      wrapper: wrap(fake.client),
    });

    act(() => {
      fake.emit("chat-file-edit-progress", {
        event: "message",
        chat_id: "chat-file-edit-progress",
        text: 'write_file({"path":"foo.txt"})',
        kind: "tool_hint",
      });
      fake.emit("chat-file-edit-progress", {
        event: "file_edit",
        chat_id: "chat-file-edit-progress",
        edits: [{
          call_id: "call-write",
          tool: "write_file",
          path: "foo.txt",
          phase: "start",
          added: 12,
          deleted: 0,
          approximate: true,
          status: "editing",
        }],
      });
      fake.emit("chat-file-edit-progress", {
        event: "message",
        chat_id: "chat-file-edit-progress",
        text: "still working",
        kind: "progress",
      });
      fake.emit("chat-file-edit-progress", {
        event: "file_edit",
        chat_id: "chat-file-edit-progress",
        edits: [{
          call_id: "call-write",
          tool: "write_file",
          path: "foo.txt",
          phase: "end",
          added: 30,
          deleted: 0,
          approximate: false,
          status: "done",
        }],
      });
    });

    const fileEditMessages = result.current.messages.filter((message) => message.fileEdits?.length);
    expect(fileEditMessages).toHaveLength(1);
    expect(fileEditMessages[0].fileEdits).toEqual([{
      call_id: "call-write",
      tool: "write_file",
      path: "foo.txt",
      phase: "end",
      added: 30,
      deleted: 0,
      approximate: false,
      status: "done",
    }]);
  });

  it("starts a new assistant bubble for deltas after stream_end and activity", async () => {
    const fake = fakeClient();
    const { result } = renderHook(() => useMonaStream("chat-stream-segments", EMPTY_MESSAGES), {
      wrapper: wrap(fake.client),
    });

    act(() => {
      fake.emit("chat-stream-segments", {
        event: "delta",
        chat_id: "chat-stream-segments",
        text: "I created the files.",
      });
      fake.emit("chat-stream-segments", {
        event: "stream_end",
        chat_id: "chat-stream-segments",
      });
      fake.emit("chat-stream-segments", {
        event: "message",
        chat_id: "chat-stream-segments",
        text: 'write_file({"path":"minecraft-fps/options.txt"})',
        kind: "tool_hint",
      });
      fake.emit("chat-stream-segments", {
        event: "delta",
        chat_id: "chat-stream-segments",
        text: "Now I will summarize the edits.",
      });
    });

    await flushStreamFrame();

    expect(result.current.messages).toHaveLength(3);
    expect(result.current.messages[0]).toMatchObject({
      role: "assistant",
      content: "I created the files.",
    });
    expect(result.current.messages[1]).toMatchObject({
      role: "tool",
      kind: "trace",
      traces: ['write_file({"path":"minecraft-fps/options.txt"})'],
    });
    expect(result.current.messages[2]).toMatchObject({
      role: "assistant",
      content: "Now I will summarize the edits.",
    });
  });

  it("opens a new activity segment for reasoning after file edit activity", async () => {
    const fake = fakeClient();
    const { result } = renderHook(() => useMonaStream("chat-file-segments", EMPTY_MESSAGES), {
      wrapper: wrap(fake.client),
    });

    act(() => {
      fake.emit("chat-file-segments", {
        event: "reasoning_delta",
        chat_id: "chat-file-segments",
        text: "Plan.",
      });
      fake.emit("chat-file-segments", {
        event: "reasoning_end",
        chat_id: "chat-file-segments",
      });
      fake.emit("chat-file-segments", {
        event: "message",
        chat_id: "chat-file-segments",
        text: 'edit_file({"path":"foo.txt"})',
        kind: "tool_hint",
      });
      fake.emit("chat-file-segments", {
        event: "file_edit",
        chat_id: "chat-file-segments",
        edits: [{
          call_id: "call-edit",
          tool: "edit_file",
          path: "foo.txt",
          phase: "start",
          added: 1,
          deleted: 1,
          approximate: true,
          status: "editing",
        }],
      });
      fake.emit("chat-file-segments", {
        event: "reasoning_delta",
        chat_id: "chat-file-segments",
        text: "Review result.",
      });
    });

    await flushStreamFrame();

    expect(result.current.messages).toHaveLength(4);
    const firstSegment = result.current.messages[0].activitySegmentId;
    expect(firstSegment).toBeTruthy();
    expect(result.current.messages[1].activitySegmentId).toBe(firstSegment);
    expect(result.current.messages[2].activitySegmentId).toBeTruthy();
    expect(result.current.messages[2].activitySegmentId).not.toBe(firstSegment);
    expect(result.current.messages[3].activitySegmentId).toBeTruthy();
    expect(result.current.messages[3].activitySegmentId).not.toBe(result.current.messages[2].activitySegmentId);
  });

  it("keeps file edit blocks ordered across a new reasoning phase", async () => {
    const fake = fakeClient();
    const { result } = renderHook(() => useMonaStream("chat-file-order", EMPTY_MESSAGES), {
      wrapper: wrap(fake.client),
    });

    act(() => {
      fake.emit("chat-file-order", {
        event: "file_edit",
        chat_id: "chat-file-order",
        edits: [{
          call_id: "call-one",
          tool: "write_file",
          path: "one.txt",
          phase: "start",
          added: 10,
          deleted: 0,
          approximate: true,
          status: "editing",
        }],
      });
      fake.emit("chat-file-order", {
        event: "reasoning_delta",
        chat_id: "chat-file-order",
        text: "Check the next file.",
      });
    });

    await flushStreamFrame();

    act(() => {
      fake.emit("chat-file-order", {
        event: "file_edit",
        chat_id: "chat-file-order",
        edits: [{
          call_id: "call-two",
          tool: "write_file",
          path: "two.txt",
          phase: "start",
          added: 20,
          deleted: 0,
          approximate: true,
          status: "editing",
        }],
      });
    });

    expect(result.current.messages.map((message) => message.fileEdits?.[0]?.path ?? message.reasoning)).toEqual([
      "one.txt",
      "Check the next file.",
      "two.txt",
    ]);
    const fileEditSegments = result.current.messages
      .filter((message) => message.fileEdits?.length)
      .map((message) => message.activitySegmentId);
    expect(fileEditSegments).toHaveLength(2);
    expect(fileEditSegments[0]).not.toBe(fileEditSegments[1]);
  });

  it("accumulates reasoning_delta chunks on a placeholder until reasoning_end", async () => {
    const fake = fakeClient();
    const { result } = renderHook(() => useMonaStream("chat-r", EMPTY_MESSAGES), {
      wrapper: wrap(fake.client),
    });

    act(() => {
      fake.emit("chat-r", {
        event: "reasoning_delta",
        chat_id: "chat-r",
        text: "Let me think ",
      });
      fake.emit("chat-r", {
        event: "reasoning_delta",
        chat_id: "chat-r",
        text: "step by step.",
      });
    });

    await flushStreamFrame();

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].role).toBe("assistant");
    expect(result.current.messages[0].reasoning).toBe("Let me think step by step.");
    expect(result.current.messages[0].reasoningStreaming).toBe(true);

    act(() => {
      fake.emit("chat-r", { event: "reasoning_end", chat_id: "chat-r" });
    });

    expect(result.current.messages[0].reasoningStreaming).toBe(false);
    expect(result.current.messages[0].reasoning).toBe("Let me think step by step.");
  });

  it("absorbs a streaming reasoning placeholder into the answer turn that follows", () => {
    const fake = fakeClient();
    const { result } = renderHook(() => useMonaStream("chat-r2", EMPTY_MESSAGES), {
      wrapper: wrap(fake.client),
    });

    act(() => {
      fake.emit("chat-r2", {
        event: "reasoning_delta",
        chat_id: "chat-r2",
        text: "Plan first.",
      });
      fake.emit("chat-r2", { event: "reasoning_end", chat_id: "chat-r2" });
      fake.emit("chat-r2", {
        event: "delta",
        chat_id: "chat-r2",
        text: "The answer is 42.",
      });
      fake.emit("chat-r2", { event: "stream_end", chat_id: "chat-r2" });
    });

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].content).toBe("The answer is 42.");
    expect(result.current.messages[0].reasoning).toBe("Plan first.");
    expect(result.current.messages[0].reasoningStreaming).toBe(false);
  });

  it("ignores empty reasoning_delta frames", () => {
    const fake = fakeClient();
    const { result } = renderHook(() => useMonaStream("chat-r3", EMPTY_MESSAGES), {
      wrapper: wrap(fake.client),
    });

    act(() => {
      fake.emit("chat-r3", {
        event: "reasoning_delta",
        chat_id: "chat-r3",
        text: "",
      });
    });

    expect(result.current.messages).toHaveLength(0);
  });

  it("treats legacy kind=reasoning messages as a complete delta + end pair", () => {
    const fake = fakeClient();
    const { result } = renderHook(() => useMonaStream("chat-r4", EMPTY_MESSAGES), {
      wrapper: wrap(fake.client),
    });

    act(() => {
      fake.emit("chat-r4", {
        event: "message",
        chat_id: "chat-r4",
        text: "one-shot reasoning",
        kind: "reasoning",
      });
    });

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].reasoning).toBe("one-shot reasoning");
    expect(result.current.messages[0].reasoningStreaming).toBe(false);
  });

  it("attaches post-hoc reasoning to the same assistant turn above the answer", () => {
    const fake = fakeClient();
    const { result } = renderHook(() => useMonaStream("chat-r5", EMPTY_MESSAGES), {
      wrapper: wrap(fake.client),
    });

    act(() => {
      fake.emit("chat-r5", {
        event: "delta",
        chat_id: "chat-r5",
        text: "hi~",
      });
      fake.emit("chat-r5", { event: "stream_end", chat_id: "chat-r5" });
      fake.emit("chat-r5", {
        event: "reasoning_delta",
        chat_id: "chat-r5",
        text: "This reasoning arrived after the answer stream.",
      });
      fake.emit("chat-r5", { event: "reasoning_end", chat_id: "chat-r5" });
    });

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].content).toBe("hi~");
    expect(result.current.messages[0].reasoning).toBe(
      "This reasoning arrived after the answer stream.",
    );
    expect(result.current.messages[0].reasoningStreaming).toBe(false);
  });

  it("does not attach a new turn's reasoning across the latest user boundary", async () => {
    const fake = fakeClient();
    const initialMessages = [
      {
        id: "a-prev",
        role: "assistant" as const,
        content: "Previous answer.",
        reasoning: "Previous thought.",
        createdAt: Date.now(),
      },
      {
        id: "u-next",
        role: "user" as const,
        content: "Next question",
        createdAt: Date.now(),
      },
    ];
    const { result } = renderHook(
      () => useMonaStream("chat-r6", initialMessages),
      { wrapper: wrap(fake.client) },
    );

    act(() => {
      fake.emit("chat-r6", {
        event: "reasoning_delta",
        chat_id: "chat-r6",
        text: "New turn thinking.",
      });
    });

    await flushStreamFrame();

    expect(result.current.messages).toHaveLength(3);
    expect(result.current.messages[0].reasoning).toBe("Previous thought.");
    expect(result.current.messages[2].role).toBe("assistant");
    expect(result.current.messages[2].content).toBe("");
    expect(result.current.messages[2].reasoning).toBe("New turn thinking.");
    expect(result.current.messages[2].reasoningStreaming).toBe(true);
  });

  it("does not attach reasoning across a tool trace boundary", async () => {
    const fake = fakeClient();
    const { result } = renderHook(() => useMonaStream("chat-r7", EMPTY_MESSAGES), {
      wrapper: wrap(fake.client),
    });

    act(() => {
      fake.emit("chat-r7", {
        event: "reasoning_delta",
        chat_id: "chat-r7",
        text: "First reasoning.",
      });
      fake.emit("chat-r7", { event: "reasoning_end", chat_id: "chat-r7" });
      fake.emit("chat-r7", {
        event: "message",
        chat_id: "chat-r7",
        text: "web_search({\"query\":\"OpenClaw\"})",
        kind: "tool_hint",
      });
      fake.emit("chat-r7", {
        event: "reasoning_delta",
        chat_id: "chat-r7",
        text: "Second reasoning.",
      });
    });

    await flushStreamFrame();

    expect(result.current.messages).toHaveLength(3);
    expect(result.current.messages.map((m) => m.kind ?? "message")).toEqual([
      "message",
      "trace",
      "message",
    ]);
    expect(result.current.messages[0].reasoning).toBe("First reasoning.");
    expect(result.current.messages[1].traces).toEqual([
      "web_search({\"query\":\"OpenClaw\"})",
    ]);
    expect(result.current.messages[2].reasoning).toBe("Second reasoning.");
  });

  it("keeps tool-call reasoning before the matching live tool trace", () => {
    const fake = fakeClient();
    const { result } = renderHook(() => useMonaStream("chat-tool-reasoning", EMPTY_MESSAGES), {
      wrapper: wrap(fake.client),
    });

    act(() => {
      fake.emit("chat-tool-reasoning", {
        event: "reasoning_delta",
        chat_id: "chat-tool-reasoning",
        text: "I should search first.",
      });
      fake.emit("chat-tool-reasoning", {
        event: "reasoning_end",
        chat_id: "chat-tool-reasoning",
      });
      fake.emit("chat-tool-reasoning", {
        event: "message",
        chat_id: "chat-tool-reasoning",
        text: "web_search({\"query\":\"hermes\"})",
        kind: "tool_hint",
      });
      fake.emit("chat-tool-reasoning", {
        event: "turn_end",
        chat_id: "chat-tool-reasoning",
      });
    });

    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages[0]).toMatchObject({
      role: "assistant",
      content: "",
      reasoning: "I should search first.",
      reasoningStreaming: false,
      isStreaming: false,
    });
    expect(result.current.messages[1]).toMatchObject({
      role: "tool",
      kind: "trace",
      traces: ["web_search({\"query\":\"hermes\"})"],
    });
  });

  it("absorbs non-streamed final answers into the preceding reasoning placeholder", () => {
    const fake = fakeClient();
    const { result } = renderHook(() => useMonaStream("chat-final-reasoning", EMPTY_MESSAGES), {
      wrapper: wrap(fake.client),
    });

    act(() => {
      fake.emit("chat-final-reasoning", {
        event: "message",
        chat_id: "chat-final-reasoning",
        text: "web_search({\"query\":\"hermes\"})",
        kind: "tool_hint",
      });
      fake.emit("chat-final-reasoning", {
        event: "reasoning_delta",
        chat_id: "chat-final-reasoning",
        text: "Got results; now summarize.",
      });
      fake.emit("chat-final-reasoning", {
        event: "reasoning_end",
        chat_id: "chat-final-reasoning",
      });
      fake.emit("chat-final-reasoning", {
        event: "message",
        chat_id: "chat-final-reasoning",
        text: "Hermes is an open-source agent project.",
      });
      fake.emit("chat-final-reasoning", {
        event: "turn_end",
        chat_id: "chat-final-reasoning",
      });
    });

    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages[0]).toMatchObject({
      role: "tool",
      kind: "trace",
    });
    expect(result.current.messages[1]).toMatchObject({
      role: "assistant",
      content: "Hermes is an open-source agent project.",
      reasoning: "Got results; now summarize.",
      reasoningStreaming: false,
      isStreaming: false,
    });
  });

  it("prunes reasoning-only placeholders when a turn ends without an answer", () => {
    const fake = fakeClient();
    const { result } = renderHook(() => useMonaStream("chat-empty-thinking", EMPTY_MESSAGES), {
      wrapper: wrap(fake.client),
    });

    act(() => {
      fake.emit("chat-empty-thinking", {
        event: "reasoning_delta",
        chat_id: "chat-empty-thinking",
        text: "thinking without final text",
      });
      fake.emit("chat-empty-thinking", {
        event: "reasoning_end",
        chat_id: "chat-empty-thinking",
      });
      fake.emit("chat-empty-thinking", {
        event: "turn_end",
        chat_id: "chat-empty-thinking",
      });
    });

    expect(result.current.messages).toHaveLength(0);
    expect(result.current.isStreaming).toBe(false);
  });

  it("drops stale reasoning-only placeholders before sending the next user turn", () => {
    const fake = fakeClient();
    const initialMessages = [
      {
        id: "stale-thinking",
        role: "assistant" as const,
        content: "",
        reasoning: "leftover thinking",
        reasoningStreaming: false,
        createdAt: Date.now(),
      },
    ];
    const { result } = renderHook(
      () => useMonaStream("chat-stale-thinking", initialMessages),
      { wrapper: wrap(fake.client) },
    );

    act(() => {
      result.current.send("fine");
    });

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].role).toBe("user");
    expect(result.current.messages[0].content).toBe("fine");
  });

  it("attaches final task-plan snapshots to assistant history messages", () => {
    const fake = fakeClient();
    const { result } = renderHook(() => useMonaStream("chat-plan-message", EMPTY_MESSAGES), {
      wrapper: wrap(fake.client),
    });
    act(() => {
      fake.emit("chat-plan-message", {
        event: "message",
        chat_id: "chat-plan-message",
        text: "done",
        task_plan: {
          task_id: "task-1",
          revision: 2,
          steps: [{ id: "one", step: "Deliver", status: "completed" }],
          source: "ai",
        },
      });
    });
    expect(result.current.messages[0].taskPlan?.steps[0].step).toBe("Deliver");
  });

  it("sends uploaded document paths without requiring message text", () => {
    const fake = fakeClient();
    const { result } = renderHook(() => useMonaStream("chat-doc", EMPTY_MESSAGES), {
      wrapper: wrap(fake.client),
    });

    act(() => {
      result.current.send("", undefined, { docPaths: ["uploads/chat-doc/report.xlsx"] });
    });

    expect(fake.client.sendMessage).toHaveBeenCalledWith(
      "chat-doc",
      "",
      undefined,
      expect.objectContaining({ docPaths: ["uploads/chat-doc/report.xlsx"] }),
    );
  });

  it("renders uploaded documents as optimistic file attachments", () => {
    const fake = fakeClient();
    const { result } = renderHook(() => useMonaStream("chat-pdf", EMPTY_MESSAGES), {
      wrapper: wrap(fake.client),
    });

    act(() => {
      result.current.send("总结这份资料", undefined, {
        displayContent: "总结这份资料",
        docPaths: ["uploads/chat-pdf/reference.pdf"],
        documentNames: ["reference.pdf"],
      });
    });

    expect(result.current.messages[0]).toMatchObject({
      content: "总结这份资料",
      displayContent: "总结这份资料",
      media: [{ kind: "file", name: "reference.pdf" }],
    });
  });

  it("forwards the browser tab identity with a user turn", () => {
    const fake = fakeClient();
    const { result } = renderHook(() => useMonaStream("chat-browser", EMPTY_MESSAGES), {
      wrapper: wrap(fake.client),
    });

    act(() => {
      result.current.send("inspect this page", undefined, { browserTabId: "tab-123" });
    });

    expect(fake.client.sendMessage).toHaveBeenCalledWith(
      "chat-browser",
      "inspect this page",
      undefined,
      expect.objectContaining({ browserTabId: "tab-123" }),
    );
  });

  it("forwards the active Office document with a user turn", () => {
    const fake = fakeClient();
    const { result } = renderHook(() => useMonaStream("chat-office", EMPTY_MESSAGES), {
      wrapper: wrap(fake.client),
    });

    act(() => {
      result.current.send("修改当前演示文稿", undefined, {
        officeSessionId: "office_123",
        officeDocumentType: "slides",
        officeDisplayName: "季度汇报.pptx",
      });
    });

    expect(fake.client.sendMessage).toHaveBeenCalledWith(
      "chat-office",
      "修改当前演示文稿",
      undefined,
      expect.objectContaining({
        officeSessionId: "office_123",
        officeDocumentType: "slides",
        officeDisplayName: "季度汇报.pptx",
      }),
    );
  });

  it("forwards the active canvas with a user turn", () => {
    const fake = fakeClient();
    const { result } = renderHook(() => useMonaStream("chat-canvas", EMPTY_MESSAGES), {
      wrapper: wrap(fake.client),
    });

    act(() => {
      result.current.send("修改当前架构图", undefined, { canvasId: "canvas-123" });
    });

    expect(fake.client.sendMessage).toHaveBeenCalledWith(
      "chat-canvas",
      "修改当前架构图",
      undefined,
      expect.objectContaining({ canvasId: "canvas-123" }),
    );
  });

  it("attaches assistant media_urls to complete messages", () => {
    const fake = fakeClient();
    const { result } = renderHook(() => useMonaStream("chat-m", EMPTY_MESSAGES), {
      wrapper: wrap(fake.client),
    });

    act(() => {
      fake.emit("chat-m", {
        event: "message",
        chat_id: "chat-m",
        text: "video ready",
        media_urls: [{ url: "/api/media/sig/payload", name: "demo.mp4" }],
      });
    });

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].media).toEqual([
      { kind: "video", url: "/api/media/sig/payload", name: "demo.mp4" },
    ]);
  });

  it("suppresses redundant stream confirmation after assistant media", () => {
    const fake = fakeClient();
    const { result } = renderHook(() => useMonaStream("chat-img-result", EMPTY_MESSAGES), {
      wrapper: wrap(fake.client),
    });

    act(() => {
      fake.emit("chat-img-result", {
        event: "message",
        chat_id: "chat-img-result",
        text: "image ready",
        media_urls: [{ url: "/api/media/sig/image", name: "generated.png" }],
      });
      fake.emit("chat-img-result", {
        event: "message",
        chat_id: "chat-img-result",
        text: "message()",
        kind: "tool_hint",
      });
      fake.emit("chat-img-result", {
        event: "delta",
        chat_id: "chat-img-result",
        text: "发送成功",
      });
      fake.emit("chat-img-result", {
        event: "stream_end",
        chat_id: "chat-img-result",
      });
      fake.emit("chat-img-result", {
        event: "turn_end",
        chat_id: "chat-img-result",
      });
    });

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].content).toBe("image ready");
    expect(result.current.messages[0].media).toHaveLength(1);
  });

  it("stops the active turn without adding a user slash command bubble", () => {
    const fake = fakeClient();
    const { result } = renderHook(() => useMonaStream("chat-stop", EMPTY_MESSAGES), {
      wrapper: wrap(fake.client),
    });

    act(() => {
      result.current.send("long task");
    });
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.isStreaming).toBe(true);

    act(() => {
      result.current.stop();
      result.current.stop();
    });

    expect(fake.client.sendMessage).toHaveBeenCalledTimes(2);

    expect(fake.client.sendMessage).toHaveBeenLastCalledWith(
      "chat-stop",
      "/stop",
      undefined,
      { taskId: result.current.currentTaskId },
    );
    expect(result.current.isStreaming).toBe(true);
    expect(result.current.stopping).toBe(true);
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].content).toBe("long task");

    act(() => {
      fake.emit("chat-stop", {
        event: "goal_status",
        chat_id: "chat-stop",
        status: "idle",
      });
    });

    expect(result.current.isStreaming).toBe(false);
    expect(result.current.stopping).toBe(false);
  });

  it("keeps the local loading state until direct agent mentions complete", () => {
    const fake = fakeClient();
    const { result } = renderHook(() => useMonaStream("chat-mentions", EMPTY_MESSAGES), {
      wrapper: wrap(fake.client),
    });

    act(() => {
      result.current.send("@甲 @乙 请分别回答", undefined, {
        targetAgentIds: ["agent-a", "agent-b"],
      });
    });
    expect(result.current.isStreaming).toBe(true);

    act(() => {
      fake.emit("chat-mentions", {
        event: "agent_mentions_routed",
        chat_id: "chat-mentions",
        agents: ["agent-a", "agent-b"],
      });
    });

    expect(result.current.isStreaming).toBe(true);

    act(() => {
      fake.emit("chat-mentions", {
        event: "goal_status",
        chat_id: "chat-mentions",
        status: "idle",
      });
    });

    expect(result.current.isStreaming).toBe(false);
  });

  it("keeps a topic card separate from workflows and completes on its terminal update", () => {
    const fake = fakeClient();
    const onTurnEnd = vi.fn();
    const { result } = renderHook(
      () => useMonaStream("room-topic", EMPTY_MESSAGES, false, onTurnEnd),
      { wrapper: wrap(fake.client) },
    );
    const workflow = {
      schemaVersion: 1,
      id: "discussion-debate-1",
      roomId: "room-topic",
      revision: 1,
      status: "active" as const,
      goal: "增长还是利润？",
      trigger: { type: "manual" as const },
      steps: [],
      createdAt: "2026-08-29T00:00:00Z",
      createdBy: "user",
    };

    act(() => {
      fake.emit("room-topic", {
        event: "discussion_updated",
        chat_id: "room-topic",
        id: "run-topic",
        roomId: "room-topic",
        status: "running",
        workflow,
        steps: {},
      });
    });
    expect(result.current.messages).toEqual([
      expect.objectContaining({ id: "discussion:run-topic", kind: "discussion" }),
    ]);
    expect(result.current.isStreaming).toBe(true);

    act(() => {
      fake.emit("room-topic", {
        event: "discussion_updated",
        chat_id: "room-topic",
        id: "run-topic",
        roomId: "room-topic",
        status: "succeeded",
        workflow,
        steps: {},
      });
    });
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.isStreaming).toBe(false);
    expect(onTurnEnd).toHaveBeenCalledTimes(1);
  });

  it("keeps streaming alive across stream_end and completes on turn_end", async () => {
    const fake = fakeClient();
    const onTurnEnd = vi.fn();
    const { result } = renderHook(() => useMonaStream("chat-s", EMPTY_MESSAGES, false, onTurnEnd), {
      wrapper: wrap(fake.client),
    });

    act(() => {
      fake.emit("chat-s", {
        event: "delta",
        chat_id: "chat-s",
        text: "Hello",
      });
    });

    await flushStreamFrame();

    expect(result.current.isStreaming).toBe(true);
    expect(result.current.messages[0]).toMatchObject({
      role: "assistant",
      content: "Hello",
      isStreaming: true,
    });

    act(() => {
      fake.emit("chat-s", {
        event: "stream_end",
        chat_id: "chat-s",
      });
    });

    expect(result.current.isStreaming).toBe(true);
    expect(result.current.messages[0].isStreaming).toBe(true);

    act(() => {
      fake.emit("chat-s", {
        event: "message",
        chat_id: "chat-s",
        text: "Hello world",
      });
    });

    expect(result.current.isStreaming).toBe(true);
    expect(result.current.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: "Hello world",
    });

    act(() => {
      fake.emit("chat-s", {
        event: "turn_end",
        chat_id: "chat-s",
      });
    });

    expect(result.current.isStreaming).toBe(false);
    expect(result.current.messages.every((message) => !message.isStreaming)).toBe(true);
    expect(onTurnEnd).toHaveBeenCalledTimes(1);
  });

  it("stamps latency on the last assistant bubble from turn_end", () => {
    const fake = fakeClient();
    const { result } = renderHook(() => useMonaStream("chat-lat", EMPTY_MESSAGES), {
      wrapper: wrap(fake.client),
    });

    act(() => {
      fake.emit("chat-lat", {
        event: "delta",
        chat_id: "chat-lat",
        text: "Hi",
      });
    });

    act(() => {
      fake.emit("chat-lat", {
        event: "turn_end",
        chat_id: "chat-lat",
        latency_ms: 2400,
        task_id: "task-lat",
        token_usage: {
          prompt_tokens: 1_000,
          completion_tokens: 250,
          total_tokens: 1_250,
        },
      });
    });

    const lastAssistant = [...result.current.messages].reverse().find((m) => m.role === "assistant");
    expect(lastAssistant?.latencyMs).toBe(2400);
    expect(lastAssistant?.taskId).toBe("task-lat");
    expect(lastAssistant?.tokenUsage).toEqual({
      promptTokens: 1_000,
      completionTokens: 250,
      cachedTokens: 0,
      totalTokens: 1_250,
    });
  });

  it("shows turn token usage on streamed text when the completion also delivers media", async () => {
    const fake = fakeClient();
    const { result } = renderHook(() => useMonaStream("chat-media-usage", EMPTY_MESSAGES), {
      wrapper: wrap(fake.client),
    });

    act(() => {
      fake.emit("chat-media-usage", {
        event: "delta",
        chat_id: "chat-media-usage",
        text: "海报已生成",
        stream_id: "stream-media-usage",
        task_id: "task-media-usage",
      });
    });
    await flushStreamFrame();

    act(() => {
      fake.emit("chat-media-usage", {
        event: "stream_end",
        chat_id: "chat-media-usage",
        stream_id: "stream-media-usage",
        task_id: "task-media-usage",
      });
      fake.emit("chat-media-usage", {
        event: "message",
        chat_id: "chat-media-usage",
        text: "",
        author_id: "mona",
        media_urls: [{ url: "/api/media/poster", name: "poster.png" }],
        task_id: "task-media-usage",
        token_usage: {
          prompt_tokens: 54_381,
          completion_tokens: 409,
          total_tokens: 54_790,
        },
      });
      fake.emit("chat-media-usage", {
        event: "turn_end",
        chat_id: "chat-media-usage",
        task_id: "task-media-usage",
        latency_ms: 36_904,
        token_usage: {
          prompt_tokens: 54_381,
          completion_tokens: 409,
          total_tokens: 54_790,
        },
      });
    });

    const textMessage = result.current.messages.find((message) => message.content === "海报已生成");
    const mediaMessage = result.current.messages.find((message) => message.media?.length);
    expect(textMessage?.tokenUsage?.totalTokens).toBe(54_790);
    expect(textMessage?.latencyMs).toBe(36_904);
    expect(mediaMessage?.tokenUsage).toBeUndefined();
  });

  it("tracks goal_status running and clears on idle", () => {
    const fake = fakeClient();
    const { result } = renderHook(() => useMonaStream("chat-g", EMPTY_MESSAGES), {
      wrapper: wrap(fake.client),
    });

    expect(result.current.runStartedAt).toBeNull();

    act(() => {
      fake.emit("chat-g", {
        event: "goal_status",
        chat_id: "chat-g",
        status: "running",
        started_at: 1700,
      });
    });
    expect(result.current.runStartedAt).toBe(1700);
    expect(result.current.isStreaming).toBe(true);

    act(() => {
      fake.emit("chat-g", {
        event: "goal_status",
        chat_id: "chat-g",
        status: "idle",
      });
    });
    expect(result.current.runStartedAt).toBeNull();
    expect(result.current.isStreaming).toBe(false);
  });

  it("tracks context compaction progress independently of model output", () => {
    const fake = fakeClient();
    const { result } = renderHook(() => useMonaStream("chat-compaction", EMPTY_MESSAGES), {
      wrapper: wrap(fake.client),
    });

    act(() => {
      fake.emit("chat-compaction", {
        event: "message",
        chat_id: "chat-compaction",
        text: "正在整理上下文",
        kind: "progress",
        context_compacting: true,
      });
    });
    expect(result.current.isCompacting).toBe(true);
    expect(result.current.messages).toEqual([]);

    act(() => {
      fake.emit("chat-compaction", {
        event: "message",
        chat_id: "chat-compaction",
        text: "",
        kind: "progress",
        context_compacting: false,
      });
    });
    expect(result.current.isCompacting).toBe(false);
  });

  it("starts the run timer immediately when a message is sent", () => {
    const fake = fakeClient();
    const { result } = renderHook(() => useMonaStream("chat-local-start", EMPTY_MESSAGES), {
      wrapper: wrap(fake.client),
    });
    const before = Date.now() / 1000;

    act(() => result.current.send("hello"));

    const after = Date.now() / 1000;
    expect(result.current.isStreaming).toBe(true);
    expect(result.current.isAwaitingModelResponse).toBe(true);
    expect(result.current.runStartedAt).not.toBeNull();
    expect(result.current.runStartedAt!).toBeGreaterThanOrEqual(before);
    expect(result.current.runStartedAt!).toBeLessThanOrEqual(after);
  });

  it("leaves the waiting phase when the model emits its first response", async () => {
    const fake = fakeClient();
    const { result } = renderHook(() => useMonaStream("chat-awaiting-response", EMPTY_MESSAGES), {
      wrapper: wrap(fake.client),
    });

    act(() => result.current.send("hello"));
    expect(result.current.isAwaitingModelResponse).toBe(true);

    act(() => {
      fake.emit("chat-awaiting-response", {
        event: "delta",
        chat_id: "chat-awaiting-response",
        text: "Hi",
      });
    });
    await flushStreamFrame();

    expect(result.current.isAwaitingModelResponse).toBe(false);
    expect(result.current.isStreaming).toBe(true);
  });

  it("restores streaming when the selected chat is already running", () => {
    const fake = fakeClient();
    fake.emit("chat-running", {
      event: "goal_status",
      chat_id: "chat-running",
      status: "running",
      started_at: 1701,
    });

    const { result } = renderHook(() => useMonaStream("chat-running", EMPTY_MESSAGES), {
      wrapper: wrap(fake.client),
    });

    expect(result.current.isStreaming).toBe(true);
    expect(result.current.runStartedAt).toBe(1701);
  });

  it("restores runStartedAt after switching away and back when goal_status was recorded without a subscriber", () => {
    const fake = fakeClient();
    const { result, rerender } = renderHook(
      ({ chatId }: { chatId: string }) => useMonaStream(chatId, EMPTY_MESSAGES),
      {
        wrapper: wrap(fake.client),
        initialProps: { chatId: "chat-a" },
      },
    );

    act(() => {
      fake.emit("chat-a", {
        event: "goal_status",
        chat_id: "chat-a",
        status: "running",
        started_at: 4242,
      });
    });
    expect(result.current.runStartedAt).toBe(4242);

    rerender({ chatId: "chat-b" });
    expect(result.current.runStartedAt).toBeNull();

    act(() => {
      fake.emit("chat-a", {
        event: "goal_status",
        chat_id: "chat-a",
        status: "running",
        started_at: 9001,
      });
    });

    rerender({ chatId: "chat-a" });
    expect(result.current.runStartedAt).toBe(9001);
  });

  it("tracks goal_state per chat and restores after switching sessions", () => {
    const fake = fakeClient();
    const { result, rerender } = renderHook(
      ({ chatId }: { chatId: string }) => useMonaStream(chatId, EMPTY_MESSAGES),
      {
        wrapper: wrap(fake.client),
        initialProps: { chatId: "chat-a" },
      },
    );

    act(() => {
      fake.emit("chat-a", {
        event: "goal_state",
        chat_id: "chat-a",
        goal_state: { active: true, ui_summary: "Alpha" },
      });
    });
    expect(result.current.goalState).toEqual({ active: true, ui_summary: "Alpha" });

    act(() => {
      fake.emit("chat-b", {
        event: "goal_state",
        chat_id: "chat-b",
        goal_state: { active: true, objective: "Beta task" },
      });
    });

    rerender({ chatId: "chat-b" });
    expect(result.current.goalState).toEqual({ active: true, objective: "Beta task" });

    rerender({ chatId: "chat-a" });
    expect(result.current.goalState).toEqual({ active: true, ui_summary: "Alpha" });

    act(() => {
      fake.emit("chat-a", {
        event: "goal_state",
        chat_id: "chat-a",
        goal_state: { active: false },
      });
    });
    expect(result.current.goalState).toEqual({ active: false });
  });

  it("starts a fresh task for each top-level request", () => {
    const fake = fakeClient();
    const { result } = renderHook(
      () => useMonaStream("chat-task", EMPTY_MESSAGES),
      { wrapper: wrap(fake.client) },
    );

    act(() => result.current.send("first request"));
    const firstTask = result.current.currentTaskId;
    expect(firstTask).toMatch(/^task_/);

    act(() => result.current.send("second request"));
    const secondTask = result.current.currentTaskId;
    expect(secondTask).toMatch(/^task_/);
    expect(secondTask).not.toBe(firstTask);
    expect(fake.client.sendMessage).toHaveBeenLastCalledWith(
      "chat-task",
      "second request",
      undefined,
      { taskId: secondTask },
    );
  });

  it("does not manufacture a plan from the user's wording", () => {
    const fake = fakeClient();
    const { result } = renderHook(
      () => useMonaStream("chat-seeded-plan", EMPTY_MESSAGES),
      { wrapper: wrap(fake.client) },
    );
    act(() => result.current.send("查询今天的github热榜，制作html报告"));
    expect(result.current.taskPlan).toBeUndefined();
  });

  it("tracks task_plan per chat and does not restore a stale plan after a new task", () => {
    const fake = fakeClient();
    const { result, rerender } = renderHook(
      ({ chatId }: { chatId: string }) => useMonaStream(chatId, EMPTY_MESSAGES),
      { wrapper: wrap(fake.client), initialProps: { chatId: "chat-a" } },
    );
    const plan: TaskPlanWsPayload = {
      task_id: "task-a",
      revision: 1,
      steps: [{ id: "one", step: "Inspect", status: "in_progress" }],
      source: "ai",
    };
    act(() => fake.emit("chat-a", { event: "task_plan", chat_id: "chat-a", task_plan: plan }));
    expect(result.current.taskPlan).toEqual(plan);

    act(() => fake.emit("chat-a", { event: "artifact_task_started", chat_id: "chat-a", task_id: "task-b" }));
    expect(result.current.taskPlan).toBeUndefined();
    act(() => fake.emit("chat-a", { event: "task_plan", chat_id: "chat-a", task_plan: plan }));
    expect(result.current.taskPlan).toBeUndefined();

    rerender({ chatId: "chat-b" });
    rerender({ chatId: "chat-a" });
    expect(result.current.taskPlan).toBeUndefined();
  });

  it("inject() sends a message without resetting streaming state", async () => {
    const fake = fakeClient();
    const { result } = renderHook(
      () => useMonaStream("chat-inject", EMPTY_MESSAGES),
      { wrapper: wrap(fake.client) },
    );

    act(() => {
      result.current.send("start");
    });
    expect(result.current.isStreaming).toBe(true);
    const taskId = result.current.currentTaskId;
    expect(taskId).toMatch(/^task_/);
    expect(fake.client.sendMessage).toHaveBeenCalledWith(
      "chat-inject",
      "start",
      undefined,
      { taskId },
    );

    act(() => {
      fake.emit("chat-inject", { event: "delta", text: "thinking" });
    });
    await flushStreamFrame();

    act(() => {
      result.current.inject("correction");
    });

    expect(fake.client.sendMessage).toHaveBeenCalledWith(
      "chat-inject",
      "correction",
      undefined,
      { taskId },
    );
    expect(result.current.isStreaming).toBe(true);

    const injectedBubble = result.current.messages.find(
      (m) => m.role === "user" && m.isInjected,
    );
    expect(injectedBubble).toBeDefined();
    expect(injectedBubble!.content).toBe("correction");
  });

  it("inject() keeps the active Office context on the current task", () => {
    const fake = fakeClient();
    const { result } = renderHook(
      () => useMonaStream("chat-office-inject", EMPTY_MESSAGES),
      { wrapper: wrap(fake.client) },
    );

    act(() => {
      result.current.send("start");
      result.current.inject("继续修改当前文档", undefined, {
        officeSessionId: "office_123",
        officeDocumentType: "slides",
        officeDisplayName: "季度汇报.pptx",
      });
    });

    expect(fake.client.sendMessage).toHaveBeenLastCalledWith(
      "chat-office-inject",
      "继续修改当前文档",
      undefined,
      expect.objectContaining({
        officeSessionId: "office_123",
        officeDocumentType: "slides",
        officeDisplayName: "季度汇报.pptx",
      }),
    );
  });

  it("inject() forwards attached images to the active task", () => {
    const fake = fakeClient();
    const { result } = renderHook(
      () => useMonaStream("chat-inject-image", EMPTY_MESSAGES),
      { wrapper: wrap(fake.client) },
    );
    const image = {
      media: { data_url: "data:image/png;base64,AAAA", name: "followup.png" },
      preview: { url: "data:image/png;base64,AAAA", name: "followup.png" },
    };

    act(() => {
      result.current.inject("look at this", [image]);
    });

    expect(fake.client.sendMessage).toHaveBeenCalledWith(
      "chat-inject-image",
      "look at this",
      [image.media],
      { taskId: expect.any(String) },
    );
    expect(result.current.messages.at(-1)?.images).toEqual([image.preview]);
  });

  it("inject() does not clear the active assistant stream buffer", async () => {
    const fake = fakeClient();
    const { result } = renderHook(
      () => useMonaStream("chat-inject-buffer", EMPTY_MESSAGES),
      { wrapper: wrap(fake.client) },
    );

    act(() => {
      result.current.send("start");
    });

    act(() => {
      fake.emit("chat-inject-buffer", { event: "delta", text: "part1" });
    });
    await flushStreamFrame();

    const messagesBefore = result.current.messages.filter(
      (m) => m.role === "assistant",
    );
    expect(messagesBefore).toHaveLength(1);

    act(() => {
      result.current.inject("followup");
    });

    act(() => {
      fake.emit("chat-inject-buffer", { event: "delta", text: "part2" });
    });
    await flushStreamFrame();

    const allAssistant = result.current.messages.filter(
      (m) => m.role === "assistant",
    );
    const combined = allAssistant.map((m) => m.content).join("");
    expect(combined).toContain("part1");
  });

});
