import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import i18n from "@/i18n";
import type { MonaClient } from "@/lib/mona-client";
import { ClientProvider } from "@/providers/ClientProvider";
import type { DevSession, DevSnapshot } from "@/lib/development-api";

const api = vi.hoisted(() => ({ send: vi.fn(), interrupt: vi.fn(), cancelInput: vi.fn(), decide: vi.fn() }));
vi.mock("@/lib/development-api", async (original) => ({ ...await original<typeof import("@/lib/development-api")>(), developmentApi: api }));
vi.mock("./DevelopmentTranscript", () => ({ DevelopmentTranscript: () => null }));
vi.mock("./DevelopmentHeader", () => ({ DevelopmentHeader: ({ statusContent }: { statusContent: ReactNode }) => <header>{statusContent}</header> }));
vi.mock("./useDevelopmentSession", () => ({
  useDevelopmentSession: (id: string) => useDevelopmentStore((state) => state.snapshots[id]),
  refreshDevelopmentSession: vi.fn(),
}));
import { DevelopmentPane } from "./DevelopmentPane";
import { useDevelopmentStore } from "./store";

function attachmentClient() {
  const handlers = new Set<Parameters<MonaClient["onDocUploadResult"]>[0]>();
  return {
    onDocUploadResult(handler: Parameters<MonaClient["onDocUploadResult"]>[0]) {
      handlers.add(handler);
      return () => { handlers.delete(handler); };
    },
    sendDocUpload: vi.fn(),
    complete(chatId: string, files: Array<{ name: string; path: string }>) {
      for (const handler of handlers) handler({ ok: true, chatId, files });
    },
  };
}
const project = { id: "project_composer", displayName: "项目", rootPath: "D:/project", lastOpenedAt: "" };
const session: DevSession = { id: "dev_composer", title: "开发任务", projectId: project.id, executor: "mona", model: null,
  readonly: false, parentSessionId: null, pinned: false, archived: false, revision: 0, updatedAt: "" };
const run = { id: "run_composer", sessionId: session.id, executor: "mona" as const, status: "running" as const, revision: 0, createdAt: "" };
const snapshot = (): DevSnapshot => ({ session, messages: [], messageCount: 0, before: null, runs: [], pendingInputs: [], events: [], eventCursor: 0, live: null });
function mount(value = snapshot(), client?: ReturnType<typeof attachmentClient>) {
  useDevelopmentStore.getState().setSnapshot(session.id, value);
  const pane = <DevelopmentPane project={project} session={value.session} executors={[
    { id: value.session.executor, name: "开发模型", available: true, reason: "", models: [{ id: "", label: "默认模型" }] },
  ]} />;
  return render(client
    ? <ClientProvider client={client as unknown as MonaClient} token="" runtimeStatus="ready">{pane}</ClientProvider>
    : pane);
}
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear();
  useDevelopmentStore.setState(useDevelopmentStore.getInitialState(), true);
  api.send.mockResolvedValue({ queued: false }); api.interrupt.mockResolvedValue({}); api.cancelInput.mockResolvedValue({});
});
afterEach(cleanup);

describe("development uses the shared composer", () => {
  it("shows persisted context usage and updates the same indicator from new events", () => {
    const initial = { ...snapshot(), events: [{ id: "u1", sequence: 1, runId: run.id, type: "usage.updated", payload: { contextTokens: 50000, contextWindow: 200000 } }] };
    mount(initial);
    expect(screen.getByRole("img", { name: "25.0% · 50.0K / 200.0K 上下文已使用" })).toBeInTheDocument();
    act(() => useDevelopmentStore.getState().setSnapshot(session.id, { ...initial, events: [...initial.events,
      { id: "u2", sequence: 2, runId: run.id, type: "usage.updated", payload: { contextTokens: 10000, contextWindow: 200000 } },
    ] }));
    expect(screen.getByRole("img", { name: "5.0% · 10.0K / 200.0K 上下文已使用" })).toBeInTheDocument();
  });
  it("uses the ordinary plus attachment flow instead of a development-only file action", async () => {
    const client = attachmentClient();
    mount(snapshot(), client);
    expect(screen.getByRole("button", { name: i18n.t("thread.composer.attachFile") })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "引用项目文件" })).toBeNull();
    const input = screen.getByRole("textbox", { name: "开发任务输入" });
    const fileInput = input.closest("form")!.querySelector('input[type="file"]')!;
    const file = new File(["ATTACHMENT_SENTINEL"], "notes.txt", { type: "text/plain" });
    fireEvent.change(fileInput, { target: { files: [file] } });
    await waitFor(() => expect(client.sendDocUpload).toHaveBeenCalledTimes(1));
    const uploadId = client.sendDocUpload.mock.calls[0][0];
    act(() => client.complete(uploadId, [{ name: "notes.txt", path: `uploads/${uploadId}/notes.txt` }]));
    await screen.findByText("notes.txt");
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(api.send).toHaveBeenCalledWith(
      session.id, expect.any(String), "", undefined,
      { docPaths: [`uploads/${uploadId}/notes.txt`], documentNames: ["notes.txt"] },
    ));
  });
  it("keeps external drafts editable and sends with the shared Enter shortcut", async () => {
    mount();
    act(() => useDevelopmentStore.getState().setDraft(session.id, "引用 src/app.ts"));
    const input = screen.getByRole("textbox", { name: "开发任务输入" });
    expect(input).toHaveValue("引用 src/app.ts");
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(api.send).toHaveBeenCalledWith(session.id, expect.any(String), "引用 src/app.ts"));
    await waitFor(() => expect(input).toHaveValue(""));
  });
  it("queues while running and uses the same stop-button interaction", async () => {
    mount({ ...snapshot(), runs: [run] });
    const input = screen.getByRole("textbox", { name: "开发任务输入" });
    fireEvent.change(input, { target: { value: "下一项工作" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(api.send).toHaveBeenCalledWith(session.id, expect.any(String), "下一项工作", "follow_up"));
    expect(screen.queryByRole("button", { name: "运行中消息处理方式" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "中断当前轮次" }));
    await waitFor(() => expect(api.interrupt).toHaveBeenCalledWith(session.id, run.id));
  });
  it("keeps required-child waiting on the same composer and stops only the parent wait", async () => {
    mount({ ...snapshot(), runs: [{ ...run, status: "waiting_children" }],
      pendingInputs: [{ id: "queued_wait", messageId: "wait_message", runId: run.id, state: "pending", revision: 0 }],
      messages: [{ id: "wait_message", role: "user", content: "后续工作", toolCalls: [], queued: true, truncated: false }] });
    expect(screen.getAllByRole("textbox", { name: "开发任务输入" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: i18n.t("thread.composer.pendingQueue.appendAria") })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "停止等待子任务", exact: true }));
    await waitFor(() => expect(api.interrupt).toHaveBeenCalledWith(session.id, run.id));
    expect(api.interrupt).toHaveBeenCalledTimes(1);
    expect(api.send).not.toHaveBeenCalled();
    expect(api.cancelInput).not.toHaveBeenCalled();
  });
  it("preserves a queued native message until the server confirms editing, without an unsupported append action", async () => {
    let confirm!: () => void;
    api.cancelInput.mockImplementationOnce(() => new Promise<void>((resolve) => { confirm = resolve; }));
    mount({ ...snapshot(), session: { ...session, executor: "codex" }, runs: [{ ...run, executor: "codex" }], messageCount: 1,
      messages: [{ id: "queued_message", role: "user", content: "待编辑内容", toolCalls: [], queued: true, truncated: false }],
      pendingInputs: [{ id: "queued_input", messageId: "queued_message", runId: run.id, state: "pending", intent: "follow_up", revision: 0 }] });
    expect(screen.queryByRole("button", { name: i18n.t("thread.composer.pendingQueue.appendAria") })).toBeNull();
    fireEvent.pointerDown(screen.getByRole("button", { name: /更多操作|More actions/ }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: i18n.t("thread.composer.pendingQueue.editAria") }));
    expect(screen.getByRole("textbox", { name: "开发任务输入" })).toHaveValue("");
    expect(screen.getByText("待编辑内容")).toBeInTheDocument();
    await act(async () => confirm());
    await waitFor(() => expect(screen.getByRole("textbox", { name: "开发任务输入" })).toHaveValue("待编辑内容"));
    expect(api.send).not.toHaveBeenCalled();
    expect(useDevelopmentStore.getState().snapshots[session.id].pendingInputs).toEqual([]);
  });
  it("restores the raw queued input and its file references rather than the display bubble", async () => {
    mount({ ...snapshot(), runs: [run], messageCount: 1,
      messages: [{ id: "queued_message", role: "user", content: "检查要求\n\n附件：需求.txt", toolCalls: [], queued: true, truncated: false }],
      pendingInputs: [{ id: "queued_input", messageId: "queued_message", runId: run.id, state: "pending", revision: 0,
        source: { content: "检查要求", docPaths: ["uploads/spec.txt"], documentNames: ["需求.txt"] } }] });
    fireEvent.pointerDown(screen.getByRole("button", { name: /更多操作|More actions/ }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: i18n.t("thread.composer.pendingQueue.editAria") }));
    const input = screen.getByRole("textbox", { name: "开发任务输入" });
    await waitFor(() => expect(input).toHaveValue("检查要求"));
    expect(useDevelopmentStore.getState().documentDrafts[session.id]).toEqual([{ name: "需求.txt", path: "uploads/spec.txt" }]);
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(api.send).toHaveBeenCalledWith(session.id, expect.any(String), "检查要求", "follow_up",
      { docPaths: ["uploads/spec.txt"], documentNames: ["需求.txt"] }));
  });
  it("retains uploaded attachments after a definite rejection and across remount", async () => {
    const { DevelopmentApiError } = await import("@/lib/development-api");
    api.send.mockRejectedValueOnce(new DevelopmentApiError(422, "invalid_model", "请选择可用模型"));
    useDevelopmentStore.getState().setDocumentDraft(session.id, [{ name: "截图.png", path: "uploads/screen.png" }]);
    useDevelopmentStore.getState().setDraft(session.id, "按图修改");
    const first = mount();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "开发任务输入" }), { key: "Enter" });
    await screen.findByText("请选择可用模型");
    expect(useDevelopmentStore.getState().documentDrafts[session.id]).toHaveLength(1);
    expect(useDevelopmentStore.getState().sends[session.id]).toBeUndefined();
    first.unmount();
    mount();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "开发任务输入" }), { key: "Enter" });
    await waitFor(() => expect(api.send).toHaveBeenCalledTimes(2));
    expect(api.send.mock.calls[1][4]).toEqual({ docPaths: ["uploads/screen.png"], documentNames: ["截图.png"] });
    await waitFor(() => expect(useDevelopmentStore.getState().documentDrafts[session.id]).toEqual([]));
  });
  it("guides a supported native task on its original run using the raw queued content and attachments", async () => {
    const value: DevSnapshot = { ...snapshot(), session: { ...session, executor: "codex" }, runs: [{ ...run, executor: "codex" }],
      nativeBinding: { id: "binding", steering: true, turnHistory: true, replacesBindingId: null, replacementReason: null },
      messages: [{ id: "queued_message", role: "user", content: "消息及附件展示", toolCalls: [], queued: true, truncated: false }],
      pendingInputs: [{ id: "queued_input", messageId: "queued_message", runId: run.id, state: "pending", revision: 0,
        source: { content: "检查要求", docPaths: ["uploads/spec.txt"], documentNames: ["需求.txt"] } }] };
    mount(value);
    fireEvent.click(screen.getByRole("button", { name: /引导到当前任务|Append to current task/ }));
    await waitFor(() => expect(api.send).toHaveBeenCalledWith(session.id, expect.any(String), "检查要求", "steering",
      { docPaths: ["uploads/spec.txt"], documentNames: ["需求.txt"] }, run.id));
    expect(api.cancelInput).toHaveBeenCalledOnce();
    expect(api.cancelInput.mock.invocationCallOrder[0]).toBeLessThan(api.send.mock.invocationCallOrder[0]);
    expect(useDevelopmentStore.getState().snapshots[session.id].pendingInputs).toEqual([]);
  });
  it("keeps an unconfirmed native guide request across remount and checks the same identity", async () => {
    api.send.mockResolvedValue({ input: { state: "unknown" }, queued: false });
    const value: DevSnapshot = { ...snapshot(), session: { ...session, executor: "codex" }, runs: [{ ...run, executor: "codex" }],
      nativeBinding: { id: "binding", steering: true, turnHistory: true, replacesBindingId: null, replacementReason: null },
      messages: [{ id: "queued_message", role: "user", content: "不要改变范围", toolCalls: [], queued: true, truncated: false }],
      pendingInputs: [{ id: "queued_input", messageId: "queued_message", runId: run.id, state: "pending", revision: 0 }] };
    const first = mount(value);
    fireEvent.click(screen.getByRole("button", { name: /引导到当前任务|Append to current task/ }));
    await screen.findByText("未确认引导消息是否送达，请核对原任务。原输入已保留。");
    const request = useDevelopmentStore.getState().sends[session.id];
    expect(request).toMatchObject({ uncertain: true, intent: "steering", targetRunId: run.id });
    fireEvent.click(screen.getByRole("button", { name: "知道了" }));
    expect(screen.getByRole("textbox", { name: "开发任务输入" })).toHaveValue("不要改变范围");
    first.unmount();
    mount({ ...value, pendingInputs: [] });
    expect(api.send).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "核对发送" }));
    await waitFor(() => expect(api.send).toHaveBeenCalledTimes(2));
    expect(api.send.mock.calls[1][1]).toBe(request.id);
    expect(api.send.mock.calls[1][5]).toBe(run.id);
  });
  it("places sandbox approval at the input area and preserves the composer draft until the request is resolved", async () => {
    useDevelopmentStore.getState().setDraft(session.id, "稍后继续");
    useDevelopmentStore.getState().setDocumentDraft(session.id, [{ name: "需求.txt", path: "uploads/spec.txt" }]);
    const value: DevSnapshot = { ...snapshot(), runs: [{ ...run, status: "waiting_user" }],
      pendingDecisions: [{ id: "approval", sessionId: session.id, runId: run.id, kind: "permission",
        details: { reason: "允许编译项目吗？", command: "cargo build" } }] };
    mount(value);
    const card = screen.getByLabelText("操作授权");
    expect(card.closest("footer")).toBeInTheDocument();
    expect(screen.getByRole("banner")).not.toHaveTextContent("允许编译项目吗？");
    expect(screen.queryByRole("textbox", { name: "开发任务输入" })).toBeNull();
    act(() => useDevelopmentStore.getState().setSnapshot(session.id, { ...value, pendingDecisions: [], runs: [run] }));
    expect(screen.getByRole("textbox", { name: "开发任务输入" })).toHaveValue("稍后继续");
    expect(screen.getByText("需求.txt")).toBeVisible();
  });
  it("retains failed sends and retries the same request identity", async () => {
    api.send.mockRejectedValueOnce(new Error("连接中断"));
    mount();
    const input = screen.getByRole("textbox", { name: "开发任务输入" });
    fireEvent.change(input, { target: { value: "保留草稿" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await screen.findByText("连接中断");
    expect(input).toHaveValue("保留草稿");
    const request = api.send.mock.calls[0][1];
    fireEvent.click(screen.getByRole("button", { name: "知道了" }));
    fireEvent.click(await screen.findByRole("button", { name: "核对发送" }));
    await waitFor(() => expect(api.send).toHaveBeenCalledTimes(2));
    expect(api.send.mock.calls[1][1]).toBe(request);
  });
});
