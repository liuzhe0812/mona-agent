import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DevProject, DevSession, DevSnapshot } from "@/lib/development-api";
import { DevelopmentSubagentDetail } from "./DevelopmentSubagentDetail";
import { useDevelopmentStore } from "./store";

const mocks = vi.hoisted(() => ({
  snapshot: vi.fn(),
  collaborations: vi.fn(),
  interrupt: vi.fn(),
  decide: vi.fn(),
  refresh: vi.fn(),
  transcriptProps: vi.fn(),
  session: undefined as unknown,
}));

vi.mock("@/lib/development-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/development-api")>();
  return { ...actual, developmentApi: { ...actual.developmentApi, snapshot: mocks.snapshot, collaborations: mocks.collaborations, interrupt: mocks.interrupt, decide: mocks.decide } };
});
vi.mock("./useDevelopmentSession", () => ({
  useDevelopmentSession: () => mocks.session,
  refreshDevelopmentSession: mocks.refresh,
}));
vi.mock("./DevelopmentMarkdown", () => ({
  DevelopmentMarkdown: ({ sessionId, children }: { sessionId: string; children: React.ReactNode }) =>
    <div data-testid="markdown-context" data-session-id={sessionId}>{children}</div>,
}));
vi.mock("./DevelopmentTranscript", () => ({
  DevelopmentTranscript: (props: Record<string, unknown>) => {
    mocks.transcriptProps(props);
    return <div data-testid="transcript" />;
  },
}));

const project: DevProject = { id: "project_parent", rootPath: "D:/project", displayName: "项目", lastOpenedAt: "" };
const parent: DevSession = { id: "parent_session", projectId: project.id, title: "主任务", executor: "mona", model: null,
  readonly: false, parentSessionId: null, pinned: false, archived: false, revision: 0, updatedAt: "" };
const child: DevSession = { id: "child_session", projectId: project.id, title: "最近完成的子任务", executor: "codex", model: "gpt-6-luna",
  modelReasoningEffort: "max", readonly: true, parentSessionId: parent.id, pinned: false, archived: false, revision: 0, updatedAt: "" };
const message = (id: string, content: string) => ({ id, role: "assistant", content, truncated: false, toolCalls: [], queued: false });
const snapshot = (session: DevSession = child, before: number | null = null, messages = [message("message_new", "任务结果")]): DevSnapshot => ({
  session, messages, before, messageCount: messages.length, runs: [], events: [], eventCursor: 0, pendingInputs: [], live: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  useDevelopmentStore.setState(useDevelopmentStore.getInitialState(), true);
  mocks.session = snapshot();
  mocks.collaborations.mockResolvedValue([{ parentSessionId: parent.id, childSessionId: child.id }]);
  mocks.snapshot.mockReset();
  mocks.interrupt.mockResolvedValue({});
  mocks.decide.mockResolvedValue({});
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(Date.now()), 0));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function show(onBack = vi.fn()) {
  render(<DevelopmentSubagentDetail parent={parent} project={project} childId={child.id} visible onBack={onBack} />);
  return onBack;
}

describe("DevelopmentSubagentDetail", () => {
  it("shows a read-only transcript with parent project previews and actual model details", async () => {
    show();

    expect(await screen.findByText(child.title)).toBeInTheDocument();
    expect(screen.getByText("gpt-6-luna · 最高")).toBeInTheDocument();
    expect(screen.getByTestId("markdown-context")).toHaveAttribute("data-session-id", parent.id);
    expect(screen.getByTestId("transcript")).toBeInTheDocument();
    expect(mocks.transcriptProps).toHaveBeenCalledWith(expect.objectContaining({ sessionId: child.id, showRunHeaders: true }));
    expect(mocks.transcriptProps.mock.calls[0][0]).not.toHaveProperty("onUseAnswer");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /发送|继续/ })).not.toBeInTheDocument();
  });

  it("hides only the original dispatched prompt by its request message id", async () => {
    const dispatchPrompt = { ...message("dispatch_prompt", "协作目标：检查项目\n预期交付：说明结果\n本任务为只读审查。"), role: "user" };
    const laterUserMessage = { ...message("later_user", "协作目标：这是用户后续交流，必须保留。"), role: "user" };
    const current = snapshot(child, null, [dispatchPrompt, laterUserMessage, message("child_result", "实际执行结果")]);
    mocks.session = current;
    mocks.collaborations.mockResolvedValue([{ parentSessionId: parent.id, childSessionId: child.id, requestId: "dispatch_request",
      latestRun: { requestId: "dispatch_request", requestMessageId: dispatchPrompt.id } }]);
    show();

    await screen.findByText(child.title);
    const props = mocks.transcriptProps.mock.calls.at(-1)![0] as { messages: { id: string; content: string }[] };
    expect(props.messages.map((item) => item.id)).toEqual([laterUserMessage.id, "child_result"]);
    expect(props.messages[0].content).toContain("协作目标：");
    expect(current.messages.map((item) => item.id)).toEqual([dispatchPrompt.id, laterUserMessage.id, "child_result"]);
  });

  it("directs a child approval to the parent input area without duplicating its card", async () => {
    mocks.session = { ...snapshot(), runs: [{ id: "run_child", sessionId: child.id, executor: "codex", status: "waiting_user", revision: 2, createdAt: "" }],
      pendingDecisions: [{ id: "decision_child", sessionId: child.id, runId: "run_child", kind: "permission", details: { command: "npm test" } }] };
    show();
    const action = await screen.findByRole("button", { name: "处理子任务待办" });
    expect(screen.queryByRole("button", { name: "允许一次" })).toBeNull();
    fireEvent.click(action);
    expect(useDevelopmentStore.getState().sides[parent.id]).toMatchObject({ maximized: false, approvalDecisionId: "decision_child" });
    expect(screen.queryByLabelText("当前任务确认")).toBeNull();
    expect(mocks.decide).not.toHaveBeenCalled();
    expect(mocks.refresh).toHaveBeenCalledWith(parent.id);
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("stops only the selected child without stopping the parent", async () => {
    mocks.session = { ...snapshot(), runs: [{ id: "run_child", sessionId: child.id, executor: "codex", status: "running", revision: 2, createdAt: "" }] };
    show();
    fireEvent.click(await screen.findByRole("button", { name: "停止此子任务" }));
    await waitFor(() => expect(mocks.interrupt).toHaveBeenCalledTimes(1));
    expect(mocks.interrupt).toHaveBeenCalledWith(child.id, "run_child");
    expect(mocks.refresh).toHaveBeenCalledWith(parent.id);
  });

  it("stops an unknown child through its own result panel without interrupting the parent", async () => {
    mocks.session = { ...snapshot(), runs: [{ id: "run_child_unknown", sessionId: child.id, executor: "codex", status: "unknown", revision: 3, createdAt: "" }] };
    show();
    fireEvent.click(await screen.findByRole("button", { name: "处理子任务待办" }));
    expect(screen.queryByRole("button", { name: "获取任务结果" })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "停止任务" }));
    await waitFor(() => expect(mocks.interrupt).toHaveBeenCalledTimes(1));
    expect(mocks.interrupt).toHaveBeenCalledWith(child.id, "run_child_unknown");
  });

  it("does not show a snapshot owned by a different parent or project", async () => {
    mocks.session = snapshot({ ...child, parentSessionId: "other_parent" });
    show();

    expect(await screen.findByRole("dialog", { name: "子智能体任务暂不可用" })).toHaveTextContent("没有显示任务内容");
    expect(screen.queryByTestId("transcript")).not.toBeInTheDocument();
  });

  it("requires the child id to appear in the parent's collaboration records", async () => {
    mocks.collaborations.mockResolvedValue([{ parentSessionId: parent.id, childSessionId: "another_child" }]);
    show();

    expect(await screen.findByRole("dialog", { name: "子智能体任务暂不可用" })).toHaveTextContent("已不属于当前主任务");
    expect(screen.queryByTestId("transcript")).not.toBeInTheDocument();
  });

  it("reports a membership lookup failure without claiming the task is unrelated", async () => {
    mocks.collaborations.mockRejectedValueOnce(new Error("internal lookup details"));
    show();

    const dialog = await screen.findByRole("dialog", { name: "子智能体任务暂不可用" });
    expect(dialog).toHaveTextContent("暂时无法确认");
    expect(dialog).not.toHaveTextContent("已不属于");
    expect(dialog).not.toHaveTextContent("internal lookup details");
    expect(screen.queryByTestId("transcript")).not.toBeInTheDocument();
  });

  it("returns to the child task list", async () => {
    const onBack = show();

    await screen.findByText(child.title);
    fireEvent.click(screen.getByRole("button", { name: "返回子智能体列表" }));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("loads older history through the existing snapshot API and merges it", async () => {
    const current = snapshot(child, 5);
    mocks.session = current;
    useDevelopmentStore.getState().setSnapshot(child.id, current);
    const older = snapshot(child, null, [message("message_old", "较早结果")]);
    mocks.snapshot.mockResolvedValueOnce(older);
    show();

    fireEvent.click(await screen.findByRole("button", { name: "读取更早记录" }));
    await waitFor(() => expect(mocks.snapshot).toHaveBeenCalledWith(child.id, 0, 5));
    await waitFor(() => expect(useDevelopmentStore.getState().snapshots[child.id]?.messages.map((item) => item.id))
      .toEqual(["message_old", "message_new"]));
  });

  it("shows history failures in a retry dialog without exposing the raw error", async () => {
    const current = snapshot(child, 5);
    mocks.session = current;
    useDevelopmentStore.getState().setSnapshot(child.id, current);
    mocks.snapshot.mockRejectedValueOnce(new Error("internal stack details"));
    show();

    fireEvent.click(await screen.findByRole("button", { name: "读取更早记录" }));
    const dialog = await screen.findByRole("dialog", { name: "子智能体任务暂不可用" });
    expect(dialog).toHaveTextContent("更早的任务记录暂时无法读取");
    expect(dialog).not.toHaveTextContent("internal stack details");

    mocks.snapshot.mockResolvedValueOnce(snapshot(child, null, [message("message_old", "较早结果")]));
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "子智能体任务暂不可用" })).not.toBeInTheDocument());
  });

  it("shows a snapshot read failure even when cached task content remains visible", async () => {
    const cached = snapshot();
    mocks.session = cached;
    useDevelopmentStore.getState().setSnapshot(child.id, cached);
    useDevelopmentStore.getState().setError(child.id, "internal polling details");
    mocks.snapshot.mockResolvedValueOnce(cached);
    show();

    const dialog = await screen.findByRole("dialog", { name: "子智能体任务暂不可用" });
    expect(dialog).toHaveTextContent("无法读取子智能体任务内容");
    expect(dialog).not.toHaveTextContent("internal polling details");
    expect(screen.getByTestId("transcript")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "子智能体任务暂不可用" })).not.toBeInTheDocument());
  });
});
