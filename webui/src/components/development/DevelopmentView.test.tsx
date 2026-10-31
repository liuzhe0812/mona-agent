import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { DevelopmentApiError, type DevelopmentSessionOptions, type DevProject, type DevRun, type DevSession, type DevSnapshot, type ExecutorId } from "@/lib/development-api";
import type { MonaClient } from "@/lib/mona-client";
import { ClientProvider } from "@/providers/ClientProvider";
import * as tauri from "@/lib/tauri";
import { TooltipProvider } from "./zcode/primitives/tooltip";

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", async (original) => ({ ...(await original<typeof import("@tauri-apps/api/core")>()), invoke: native.invoke }));

const api = vi.hoisted(() => ({
  collaborations: vi.fn().mockResolvedValue([]), delegate: vi.fn(), switchExecutor: vi.fn(), selectModelSource: vi.fn(), decide: vi.fn(), recover: vi.fn(),
  executorSettings: vi.fn(), updateExecutorSettings: vi.fn(), probe: vi.fn(), login: vi.fn(), message: vi.fn(),
  projects: vi.fn(), capabilities: vi.fn(), sessions: vi.fn(), snapshot: vi.fn(), openProject: vi.fn(),
  createSession: vi.fn(), forkSession: vi.fn(), updateSession: vi.fn(), deleteSession: vi.fn(), send: vi.fn(), model: vi.fn(), interrupt: vi.fn(),
  cancelInput: vi.fn(), guideInput: vi.fn(), cancelSessionCreation: vi.fn(), resources: vi.fn(), directory: vi.fn(), file: vi.fn(), saveFile: vi.fn(), git: vi.fn(), diff: vi.fn(),
}));
vi.mock("@/lib/development-api", async (original) => ({ ...(await original<typeof import("@/lib/development-api")>()), developmentApi: api }));
vi.mock("@/components/MarkdownText", () => ({ MarkdownText: ({ children }: { children: string }) => <div>{children}</div> }));
const terminal = vi.hoisted(() => ({ kill: vi.fn() }));
vi.mock("@/components/terminal/ipc", () => ({ shellKill: terminal.kill,
  onTerminalOutput: vi.fn().mockResolvedValue(() => {}), onTerminalSessionStatus: vi.fn().mockResolvedValue(() => {}),
  onTerminalMaintenanceUpdated: vi.fn().mockResolvedValue(() => {}), terminalListSessions: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/components/deliver/SidebarLocalTerminal", () => ({ SidebarLocalTerminal: () => <div>手动终端测试视图</div> }));

const subagents = vi.hoisted(() => ({ list: vi.fn(), save: vi.fn(), run: vi.fn() }));
const projectApi = vi.hoisted(() => ({ info: vi.fn().mockResolvedValue({ repository: null, repositoryState: "local", reason: "" }), update: vi.fn(), archiveChats: vi.fn() }));
vi.mock("./workspace-api", () => ({ subagentApi: subagents, projectApi }));
const gitApi = vi.hoisted(() => ({ preview: vi.fn(), recent: vi.fn() }));
vi.mock("./git-actions-api", () => ({ gitActionsApi: gitApi }));

import { DevelopmentView } from "./DevelopmentView";
import { useDevelopmentStore } from "./store";
import { nativeProvidersChanged, useNativeProviderState } from "@/lib/native-provider-state";

const project: DevProject = { id: "project_a", rootPath: "D:/project", displayName: "测试项目", lastOpenedAt: "" };
const session = (id: string, title: string): DevSession => ({ id, title, projectId: project.id, executor: "mona", model: null,
  readonly: false, parentSessionId: null, pinned: false, archived: false, revision: 0, updatedAt: "" });
const first = session("dev_first", "实现登录"), second = session("dev_second", "检查接口");
const snapshots: Record<string, DevSnapshot> = {};
function makeSnapshot(s: DevSession): DevSnapshot { return { session: s, messages: [], before: null, messageCount: 0,
  runs: [], events: [], eventCursor: 0, pendingInputs: [], live: null }; }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
type DocUploadResultHandler = Parameters<MonaClient["onDocUploadResult"]>[0];
function documentUploadClient() {
  let resultHandler: DocUploadResultHandler | undefined;
  const sendDocUpload = vi.fn((chatId: string, files: Array<{ name: string }>) => {
    resultHandler?.({ chatId, ok: true, files: files.map(({ name }) => ({ name, path: `uploads/${name}` })) });
  });
  const client = {
    isChatDeleted: vi.fn().mockReturnValue(false),
    onSessionDeleted: vi.fn(() => () => {}),
    onDocUploadResult: (handler: DocUploadResultHandler) => {
      resultHandler = handler;
      return () => { if (resultHandler === handler) resultHandler = undefined; };
    },
    sendDocUpload,
  } as unknown as MonaClient;
  return { client, sendDocUpload };
}

beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); useDevelopmentStore.setState(useDevelopmentStore.getInitialState(), true);
  native.invoke.mockResolvedValue(true);
  HTMLElement.prototype.scrollIntoView = vi.fn();
  useNativeProviderState.setState({ revision: 0 });
  Object.keys(snapshots).forEach((key) => delete snapshots[key]);
  snapshots.dev_first = makeSnapshot(first); snapshots.dev_second = makeSnapshot(second);
  gitApi.preview.mockResolvedValue({ head: "base", branch: "feature/test",
    files: [{ path: "index.ts", status: " M", additions: 7, deletions: 3, staged: false, unstaged: true }],
    remotes: ["origin"], defaultRemote: "origin", defaultBranch: "feature/test", writable: true,
    identity: { name: "Test", email: "test@example.invalid" }, trackingBranch: null, ahead: 0, behind: 0,
    canPush: true, stagedCount: 0, unstagedCount: 1, additions: 7, deletions: 3,
    contextToken: "a".repeat(64), includeUnstaged: true });
  gitApi.recent.mockResolvedValue([]);
  projectApi.info.mockResolvedValue({ repository: null, repositoryState: "local", reason: "" });
  api.projects.mockResolvedValue([project]);
  api.sessions.mockImplementation(async (id: string) => Object.values(snapshots).map((value) => value.session).filter((value) => value.projectId === id));
  api.createSession.mockImplementation(async (projectId: string, options: DevelopmentSessionOptions = {}) => {
    const { requestId: _requestId, ...fields } = options;
    const value = { ...session(`dev_created_${Object.keys(snapshots).length}`, "新开发任务"), ...fields, projectId };
    snapshots[value.id] = makeSnapshot(value); return value;
  });
  api.selectModelSource.mockImplementation(async (current: DevSession, route: { executor: ExecutorId; model: string | null; provider: string | null; effort: string | null }) => {
    const value = { ...current, executor: route.executor, model: route.model, modelProvider: route.provider,
      modelReasoningEffort: route.effort, revision: current.revision + 1 };
    snapshots[value.id] = { ...snapshots[value.id], session: value }; return value;
  });
  api.collaborations.mockResolvedValue([]);
  api.updateSession.mockImplementation(async (current: DevSession, changes: Partial<DevSession>) => {
    const value = { ...current, ...changes, revision: current.revision + 1 };
    snapshots[value.id] = { ...snapshots[value.id], session: value }; return value;
  });
  api.deleteSession.mockImplementation(async (current: DevSession) => {
    delete snapshots[current.id];
    return { deleted: [current.id] };
  });
  subagents.list.mockResolvedValue({ revision: 0, presets: [] });
  api.collaborations.mockResolvedValue([]);
  subagents.save.mockImplementation(async (_project, value) => ({ ...value, revision: value.revision + 1 }));
  api.capabilities.mockResolvedValue({ executors: [
    { id: "mona", name: "Mona Coding", available: true, reason: "", models: [{ id: "", label: "默认模型" }] },
    { id: "codex", name: "Codex", available: false, reason: "原生尚未接入", models: [] },
    { id: "claude", name: "Claude Code", available: false, reason: "原生尚未接入", models: [] },
    { id: "codebuddy", name: "CodeBuddy", available: false, reason: "原生尚未接入", models: [] },
  ] });
  api.snapshot.mockImplementation(async (id: string) => snapshots[id]);
  api.resources.mockResolvedValue({ rules: [{ path: "AGENTS.md", sha256: "rule" }], skills: [], issues: [] });
  api.directory.mockResolvedValue({ entries: [{ name: "index.ts", path: "index.ts", kind: "file" }], nextOffset: null, total: 1 });
  api.git.mockResolvedValue({ available: false, files: [], reason: "不是 Git 项目" });
  api.file.mockResolvedValue({ path: "index.ts", content: "original", sha256: "filehash", bom: false });
  api.send.mockResolvedValue({ queued: false, run: { id: "run_first" } });
  api.cancelSessionCreation.mockResolvedValue({ state: "cancelled", sessionId: null });
  api.guideInput.mockImplementation(async (sessionId: string, inputId: string, revision: number, targetRunId: string) => {
    const snapshot = snapshots[sessionId];
    const queued = snapshot.pendingInputs.find((item) => item.id === inputId);
    if (!queued) throw new Error("未找到排队消息");
    const input = { ...queued, runId: targetRunId, intent: "steering" as const, revision: revision + 1 };
    snapshot.pendingInputs = snapshot.pendingInputs.map((item) => item.id === inputId ? input : item);
    return { input, queued: false };
  });
  const store = useDevelopmentStore.getState(); store.selectProject(project.id); store.openSession(project.id, first.id);
});
afterEach(async () => { await act(async () => { cleanup(); }); vi.restoreAllMocks(); vi.useRealTimers(); });

async function openMoreAction(name: string) {
  fireEvent.pointerDown(screen.getByRole("button", { name: "会话更多操作", exact: true }), { button: 0, ctrlKey: false });
  fireEvent.click(await screen.findByRole("menuitem", { name, exact: true }));
}

async function openWorkTab(title: string) {
  const opener = await waitFor(() => {
    const sidebar = screen.queryByRole("button", { name: "打开工作侧栏", exact: true });
    const tabs = screen.queryByRole("button", { name: "打开工作标签", exact: true });
    if (!sidebar && !tabs) throw new Error("工作侧栏尚未加载");
    return sidebar;
  }, { timeout: 5000 });
  if (opener) fireEvent.click(opener);
  fireEvent.pointerDown(await screen.findByRole("button", { name: "打开工作标签", exact: true }, { timeout: 5000 }), { button: 0, ctrlKey: false });
  fireEvent.click(await screen.findByRole("menuitem", { name: title, exact: true }));
}

describe("development workbench", () => {
  it("restores the selected conversation in parallel and keeps loading separate from empty states", async () => {
    vi.useFakeTimers();
    const projectRead = deferred<DevProject[]>(), sessionRead = deferred<DevSession[]>(), historyRead = deferred<DevSnapshot>();
    api.projects.mockReturnValue(projectRead.promise);
    api.sessions.mockReturnValue(sessionRead.promise);
    api.snapshot.mockReturnValue(historyRead.promise);
    useDevelopmentStore.getState().setDraft(first.id, "加载时保留草稿");
    await act(async () => { render(<DevelopmentView />); });
    expect(api.snapshot).toHaveBeenCalledWith(first.id, 0, undefined, undefined);
    expect(screen.queryByText("添加本地项目后，会话显示在项目下方。")).toBeNull();
    expect(screen.queryByText("开始编程")).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(399); });
    expect(screen.queryByText("正在读取项目…")).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getAllByRole("status", { name: "正在读取项目…" })).toHaveLength(2);
    await act(async () => { projectRead.resolve([project]); });
    expect(screen.getByRole("status", { name: "正在恢复任务…" })).toBeVisible();
    expect(screen.queryByText("从左侧打开任务，或创建新的开发会话。")).toBeNull();
    await act(async () => { sessionRead.resolve([first, second]); });
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    const input = screen.getByRole("textbox", { name: "开发任务输入" });
    expect(input).toHaveValue("加载时保留草稿");
    expect(screen.getByRole("status", { name: "正在读取会话…" })).toBeVisible();
    expect(screen.getByRole("button", { name: "发送开发任务" })).toBeDisabled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(api.send).not.toHaveBeenCalled();
    await act(async () => { historyRead.resolve(makeSnapshot(first)); });
    expect(screen.queryByText("正在读取会话…")).toBeNull();
    expect(screen.getByRole("button", { name: "发送开发任务" })).toBeEnabled();
    expect(input).toHaveValue("加载时保留草稿");
    expect(api.createSession).not.toHaveBeenCalled();
  });
  it("renders restored history before a slow task list finishes", async () => {
    const sessionRead = deferred<DevSession[]>();
    api.sessions.mockReturnValue(sessionRead.promise);
    snapshots[first.id].messages = [{ id: "history", role: "user", content: "已恢复的历史记录", truncated: false, queued: false, toolCalls: [] }];
    snapshots[first.id].messageCount = 1;
    render(<DevelopmentView />);
    expect(await screen.findByText("已恢复的历史记录")).toBeVisible();
    expect(screen.queryByRole("button", { name: "打开开发任务：实现登录" })).toBeNull();
    expect(api.send).not.toHaveBeenCalled();
  });
  it("keeps project-read failures retryable when the conversation has already been restored", async () => {
    api.projects.mockRejectedValueOnce(new Error("项目目录读取失败"));
    useDevelopmentStore.getState().setDraft(first.id, "恢复后保留");
    render(<DevelopmentView />);
    expect(await screen.findByRole("alert")).toHaveTextContent("项目目录读取失败");
    expect(screen.queryByText("添加本地项目后，会话显示在项目下方。")).toBeNull();
    expect(screen.queryByText("开始编程")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "重试读取" }));
    expect(await screen.findByRole("textbox", { name: "开发任务输入" })).toHaveValue("恢复后保留");
    expect(api.send).not.toHaveBeenCalled();
    expect(api.createSession).not.toHaveBeenCalled();
  });
  it("keeps new-task drafts editable while models load without claiming the model is unavailable", async () => {
    const modelsRead = deferred<{ executors: { id: "mona"; name: string; available: boolean; reason: string; models: { id: string; label: string }[] }[] }>();
    api.capabilities.mockReturnValue(modelsRead.promise);
    render(<DevelopmentView />);
    await screen.findByRole("textbox", { name: "开发任务输入" });
    fireEvent.click(screen.getByRole("button", { name: "在 测试项目 新建会话", exact: true }));
    const input = await screen.findByRole("textbox", { name: "新开发任务输入" });
    fireEvent.change(input, { target: { value: "先写好需求" } });
    expect(screen.getByRole("button", { name: "创建并发送开发任务" })).toBeDisabled();
    expect(await screen.findByText("正在读取模型…")).toBeVisible();
    expect(screen.queryByText(/执行者不可用|当前执行引擎不可用|当前模型不可用/)).toBeNull();
    await act(async () => { modelsRead.resolve({ executors: [{ id: "mona", name: "Mona", available: true, reason: "", models: [{ id: "", label: "默认模型" }] }] }); });
    expect(input).toHaveValue("先写好需求");
    expect(screen.getByRole("button", { name: "创建并发送开发任务" })).toBeEnabled();
    expect(api.createSession).not.toHaveBeenCalled();
    expect(api.send).not.toHaveBeenCalled();
  });
  it("opens a forked task, returns through its source marker, and does not send a message", async () => {
    await i18n.changeLanguage("zh-CN");
    const sourceRun: DevRun = { id: "run_fork_source", sessionId: first.id, executor: "mona", status: "succeeded", revision: 1,
      createdAt: "2026-10-01T00:00:00Z", finishedAt: "2026-10-01T00:00:10Z", resultMessageId: "fork_source_answer" };
    const activeRun: DevRun = { ...sourceRun, id: "run_fork_current", status: "running", resultMessageId: undefined, finishedAt: undefined };
    snapshots[first.id] = { ...makeSnapshot(first), messageCount: 1, runs: [activeRun, sourceRun], messages: [{ id: "fork_source_answer", role: "assistant",
      content: "源任务的最终回复", toolCalls: [], truncated: false, queued: false, runId: sourceRun.id }] };
    const child = { ...session("dev_forked", "实现登录（分叉）"), forkSource: { sourceSessionId: first.id,
      sourceMessageId: "fork_source_answer", sourceTitle: first.title, requestId: "fork_generated", messageCount: 1 } };
    const forkRun: DevRun = { ...sourceRun, id: "run_forked", sessionId: child.id, resultMessageId: "fork_source_answer" };
    const childSnapshot = { ...makeSnapshot(child), messageCount: 2, runs: [forkRun], messages: [
      { id: "fork_source_answer", role: "assistant", content: "源任务的最终回复", toolCalls: [], truncated: false, queued: false, runId: forkRun.id },
      { id: "fork_child_input", role: "user", content: "继续实现登录", toolCalls: [], truncated: false, queued: false },
    ] };
    api.forkSession.mockImplementationOnce(async () => { snapshots[child.id] = childSnapshot; return child; });

    render(<TooltipProvider><DevelopmentView /></TooltipProvider>);
    fireEvent.click(await screen.findByTestId("v4-fork-fork_source_answer"));
    await waitFor(() => expect(screen.getByTestId("development-pane")).toHaveAttribute("aria-label", child.title));
    expect(api.forkSession).toHaveBeenCalledWith(first, "fork_source_answer", expect.stringMatching(/^fork_[\da-f]{32}$/i));
    const childText = screen.getByTestId("development-pane").textContent!;
    expect(childText.indexOf("源任务的最终回复")).toBeLessThan(childText.indexOf("从对话中派生"));
    expect(childText.indexOf("从对话中派生")).toBeLessThan(childText.indexOf("继续实现登录"));

    fireEvent.click(screen.getByRole("button", { name: "从对话中派生" }));
    await waitFor(() => expect(screen.getByTestId("development-pane")).toHaveAttribute("aria-label", first.title));
    expect(api.createSession).not.toHaveBeenCalled();
    expect(api.send).not.toHaveBeenCalled();
  });
  it("keeps the selected task when a fork request finishes after navigation", async () => {
    const sourceRun: DevRun = { id: "run_fork_late", sessionId: first.id, executor: "mona", status: "succeeded", revision: 1,
      createdAt: "2026-10-01T00:00:00Z", finishedAt: "2026-10-01T00:00:10Z", resultMessageId: "late_answer" };
    snapshots[first.id] = { ...makeSnapshot(first), messageCount: 1, runs: [sourceRun], messages: [{ id: "late_answer", role: "assistant",
      content: "源任务完成", toolCalls: [], truncated: false, queued: false, runId: sourceRun.id }] };
    const pendingFork = deferred<DevSession>();
    api.forkSession.mockReturnValueOnce(pendingFork.promise);

    render(<TooltipProvider><DevelopmentView /></TooltipProvider>);
    fireEvent.click(await screen.findByTestId("v4-fork-late_answer"));
    fireEvent.click(await screen.findByRole("button", { name: `打开开发任务：${second.title}` }));
    await waitFor(() => expect(screen.getByTestId("development-pane")).toHaveAttribute("aria-label", second.title));

    const child = { ...session("dev_late_fork", "实现登录（分叉）"), forkSource: { sourceSessionId: first.id,
      sourceMessageId: "late_answer", sourceTitle: first.title, requestId: "fork_late", messageCount: 1 } };
    snapshots[child.id] = makeSnapshot(child);
    await act(async () => { pendingFork.resolve(child); await pendingFork.promise; });

    expect(screen.getByTestId("development-pane")).toHaveAttribute("aria-label", second.title);
    expect(useDevelopmentStore.getState().views[project.id]?.sessionId).toBe(second.id);
    expect(api.createSession).not.toHaveBeenCalled();
    expect(api.send).not.toHaveBeenCalled();
  });
  it("does not requery the model directory when renaming a task", async () => {
    render(<DevelopmentView />);
    await screen.findByRole("textbox", { name: "开发任务输入" });
    await openMoreAction("重命名");
    fireEvent.change(screen.getByRole("textbox", { name: "新的任务名称" }), { target: { value: "仅修改任务名称" } });
    fireEvent.click(screen.getByRole("button", { name: "保存", exact: true }));
    await waitFor(() => expect(api.updateSession).toHaveBeenCalledWith(first, { title: "仅修改任务名称" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "重命名开发任务" })).toBeNull());
    expect(api.capabilities).toHaveBeenCalledOnce();
  });
  it("loads projects, tasks and subtasks through transient read failures without opening an error dialog", async () => {
    const { developmentRequest } = await import("@/lib/development-api");
    const reads = new Map<string, number>();
    vi.spyOn(tauri, "httpFetch").mockImplementation(async (url) => {
      const path = url.split("/api/development")[1];
      const count = (reads.get(path) ?? 0) + 1;
      reads.set(path, count);
      if (count === 1) throw new TypeError("Failed to fetch");
      const value = path === "/projects" ? [project]
        : path === `/projects/${project.id}/sessions` ? [first, second] : [];
      return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
    });
    api.projects.mockImplementation(() => developmentRequest("/projects"));
    api.sessions.mockImplementation((id: string) => developmentRequest(`/projects/${id}/sessions`));
    api.collaborations.mockImplementation((id: string) => developmentRequest(`/sessions/${id}/collaborations`));
    useDevelopmentStore.getState().setSide(first.id, { tab: "agent", expanded: true, openTabs: ["agent"] });
    render(<DevelopmentView />);
    await screen.findByRole("button", { name: "打开开发任务：实现登录" });
    expect(screen.getByRole("button", { name: "打开开发任务：检查接口" })).toBeVisible();
    expect(screen.queryByRole("dialog", { name: "子任务读取失败" })).toBeNull();
    const sidebar = await screen.findByRole("complementary", { name: "开发工作侧栏" }, { timeout: 5000 });
    expect(await within(sidebar).findByText("暂无已完成任务")).toBeVisible();
    expect(screen.queryByRole("dialog", { name: "子任务读取失败" })).toBeNull();
    expect([...reads.values()]).toEqual([2, 2, 2]);
    expect(api.send).not.toHaveBeenCalled();
    expect(api.createSession).not.toHaveBeenCalled();
  });
  it("opens a returned subagent from its original tool row", async () => {
    const child = { ...session("dev_linked_child", "协作 · 核对完整操作授权历史与归属关系"), parentSessionId: first.id, model: "test-model" };
    const childRun = { id: "linked_run", sessionId: child.id, executor: "mona" as const, status: "succeeded" as const, revision: 1,
      createdAt: "2026-10-08T00:00:00Z", finishedAt: "2026-10-08T00:00:10Z", resultMessageId: "linked_result" };
    snapshots[child.id] = { ...makeSnapshot(child), messageCount: 1, runs: [childRun], messages: [{ id: "linked_result", role: "assistant",
      content: "完整的子任务核对结果", toolCalls: [], truncated: false, queued: false, runId: childRun.id }] };
    const parentRun: DevRun = { id: "parent_run", sessionId: first.id, executor: "mona", status: "succeeded", revision: 1,
      createdAt: "2026-10-08T00:00:00Z", finishedAt: "2026-10-08T00:00:12Z", resultMessageId: "parent_result" };
    const task = { id: "linked_collaboration", parentSessionId: first.id, childSessionId: child.id, requestId: "linked_request",
      title: "授权历史核对", executor: "mona", goal: "完整的任务目标", expectedOutput: "", readonly: true, state: "submitted", latestRun: childRun, returnMessageId: "returned_child", sourceDiffSha: null };
    snapshots[first.id].runs = [parentRun];
    snapshots[first.id].messages = [
      { id: "returned_child", role: "user", sourceKind: "collaboration", childSessionId: child.id,
        content: "主会话不应展开的结果正文", toolCalls: [], truncated: false, queued: false },
      { id: "parent_result", role: "assistant", runId: parentRun.id, content: "已处理协作结果", toolCalls: [], truncated: false, queued: false },
    ];
    snapshots[first.id].messageCount = 2;
    snapshots[first.id].events = [
      { id: "event_child_start", sequence: 1, runId: parentRun.id, type: "tool.started", payload: { itemId: "child_call", name: "development_collaboration", arguments: { action: "start", goal: task.goal } } },
      { id: "event_child_done", sequence: 2, runId: parentRun.id, type: "tool.completed", payload: { itemId: "child_call", name: "development_collaboration", content: JSON.stringify(task) } },
      { id: "event_parent_done", sequence: 3, runId: parentRun.id, type: "agent.message.completed", payload: { messageId: "parent_result" } },
    ];
    snapshots[first.id].eventCursor = 3;
    api.collaborations.mockResolvedValue([task]);
    render(<DevelopmentView />);
    fireEvent.click(await screen.findByRole("button", { name: "工作过程" }));
    const link = await screen.findByRole("button", { name: "查看子智能体任务：授权历史核对" });
    expect(link).toHaveTextContent("授权历史核对已完成");
    expect(screen.queryByText("主会话不应展开的结果正文")).toBeNull();
    fireEvent.click(link);
    const sidebar = await screen.findByRole("complementary", { name: "开发工作侧栏" });
    await within(sidebar).findByText("完整的子任务核对结果");
    expect(within(sidebar).getByRole("region", { name: "子智能体任务详情" })).toHaveTextContent("授权历史核对");
    expect(useDevelopmentStore.getState().sides[first.id]).toMatchObject({ tab: "agent", expanded: true, agentSessionId: child.id });
    expect(useDevelopmentStore.getState().sides[first.id].openTabs).toContain("agent");
    expect(api.send).not.toHaveBeenCalled();
    expect(api.createSession).not.toHaveBeenCalled();
    expect(subagents.run).not.toHaveBeenCalled();
  });
  it("opens completed subagent tasks from the overview and returns from readonly details", async () => {
    const child = { ...session("dev_child", "检查登录实现"), parentSessionId: first.id, model: "test-model" };
    const run = { id: "child_run", sessionId: child.id, executor: "mona" as const, status: "succeeded" as const, revision: 1,
      createdAt: "2026-10-01T00:00:00Z", startedAt: "2026-10-01T00:00:00Z", finishedAt: "2026-10-01T00:00:10Z", resultMessageId: "child_result" };
    snapshots[child.id] = { ...makeSnapshot(child), messageCount: 1, runs: [run], messages: [{ id: "child_result", role: "assistant",
      content: "子任务检查结果已保存", toolCalls: [], truncated: false, queued: false, runId: run.id }] };
    api.collaborations.mockResolvedValue([{ id: "collab_child", parentSessionId: first.id, childSessionId: child.id, requestId: "request_child",
      title: child.title, executor: "mona", goal: "检查登录实现", expectedOutput: "", readonly: false, state: "submitted", latestRun: run, returnMessageId: null, sourceDiffSha: null }]);
    render(<DevelopmentView />);
    await screen.findByRole("textbox", { name: "开发任务输入" });
    fireEvent.click(screen.getByRole("button", { name: "任务概览", exact: true }));
    await screen.findByText("1 完成");
    fireEvent.click(screen.getByRole("button", { name: "查看子智能体任务" }));
    const sidebar = await screen.findByRole("complementary", { name: "开发工作侧栏" });
    fireEvent.click(await within(sidebar).findByRole("button", { name: child.title }));
    await within(sidebar).findByText("子任务检查结果已保存");
    const detail = within(sidebar).getByRole("region", { name: "子智能体任务详情" });
    expect(within(detail).queryByRole("textbox")).toBeNull();
    expect(within(detail).queryByRole("button", { name: /发送|调用|派发/ })).toBeNull();
    await act(async () => fireEvent.click(within(sidebar).getByRole("button", { name: "返回子智能体列表" })));
    expect(within(sidebar).getByRole("button", { name: child.title })).toBeVisible();
    expect(api.send).not.toHaveBeenCalled(); expect(api.createSession).not.toHaveBeenCalled(); expect(subagents.run).not.toHaveBeenCalled();
  });
  it("permanently deletes a confirmed sidebar task and focuses the remaining task", async () => {
    render(<DevelopmentView />); await screen.findByRole("textbox", { name: "开发任务输入" });
    fireEvent.pointerDown(screen.getByRole("button", { name: "实现登录 更多操作" }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: "永久删除" }));
    fireEvent.click(await screen.findByRole("button", { name: "永久删除" }));
    await waitFor(() => expect(api.deleteSession).toHaveBeenCalledWith(first));
    await waitFor(() => expect(useDevelopmentStore.getState().views[project.id].sessionId).toBe(second.id));
    expect(useDevelopmentStore.getState().snapshots[first.id]).toBeUndefined();
    expect(screen.queryByRole("button", { name: "打开开发任务：实现登录" })).not.toBeInTheDocument();
  });

  it("deletes a task whose latest run status is unknown", async () => {
    const unresolved = { ...first, latestRun: { id: "run_unknown", sessionId: first.id, executor: "mona" as const,
      status: "unknown" as const, revision: 1, createdAt: "" } };
    snapshots.dev_first = makeSnapshot(unresolved);
    render(<DevelopmentView />); await screen.findByRole("textbox", { name: "开发任务输入" });
    fireEvent.pointerDown(screen.getByRole("button", { name: "实现登录 更多操作" }), { button: 0, ctrlKey: false });
    const deleteItem = await screen.findByRole("menuitem", { name: "永久删除" });
    expect(deleteItem).not.toHaveAttribute("data-disabled");
    fireEvent.click(deleteItem);
    await screen.findByRole("dialog", { name: "永久删除任务" });
    fireEvent.click(screen.getByRole("button", { name: "永久删除" }));
    await waitFor(() => expect(api.deleteSession).toHaveBeenCalledWith(unresolved));
    expect(screen.queryByRole("button", { name: "打开开发任务：实现登录" })).not.toBeInTheDocument();
  });

  it.each(["codex", "mona"] as const)("keeps unknown %s status out of the summary and in pending actions", async (executor) => {
    api.capabilities.mockResolvedValue({ executors: [{ id: executor, name: executor, available: true, reason: "", models: [] }] });
    const run = { id: "run_unknown", sessionId: first.id, executor,
      status: "unknown" as const, revision: 1, createdAt: "" };
    const unresolved = { ...first, executor, latestRun: run };
    snapshots.dev_first = { ...makeSnapshot(unresolved), runs: [run], messageCount: 1,
      messages: [{ id: "question", role: "user", content: "你是什么模型", toolCalls: [], queued: false, truncated: false }],
      nativeBinding: executor === "codex" ? { id: "binding", turnHistory: true, replacesBindingId: null, replacementReason: null } : null };
    render(<DevelopmentView />);
    const scroll = await screen.findByLabelText("开发会话记录");
    expect(within(scroll).queryByText("未收到任务完成结果")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "任务概览", exact: true }));
    const overview = screen.getByRole("region", { name: "任务概览浮卡" });
    expect(within(overview).queryByText(/未收到任务完成结果|请勿重复发送相同任务/)).toBeNull();
    expect(within(overview).queryByRole("button", { name: "停止任务" })).toBeNull();
    expect(within(overview).queryByRole("button", { name: "结束等待并继续" })).toBeNull();
    expect(await within(overview).findByText("项目规则与 Skills")).toBeVisible();
    const composer = screen.getByRole("textbox", { name: "开发任务输入" }).closest("footer")!;
    expect(within(composer).queryByText("未收到任务完成结果")).toBeNull();
    await openMoreAction("待处理事项");
    const statusDialog = await screen.findByRole("dialog", { name: "任务状态与操作" });
    const status = within(statusDialog).getByRole("status", { name: "任务结果暂未收到" });
    expect(status).toHaveTextContent("未收到任务完成结果");
    expect(status).toHaveTextContent("请勿重复发送相同任务");
    expect(within(status).queryByRole("button", { name: "获取任务结果" })).not.toBeInTheDocument();
    api.interrupt.mockImplementationOnce(async () => { snapshots.dev_first.runs = [{ ...run, status: "interrupted" }]; });
    fireEvent.click(within(status).getByRole("button", { name: "停止任务" }));
    await waitFor(() => expect(api.interrupt).toHaveBeenCalledWith(first.id, run.id));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "任务状态与操作" })).toBeNull());
    expect(api.recover).not.toHaveBeenCalled();
  });

  it("blocks new sends while a Mona result is unknown and exposes stop from pending actions", async () => {
    const run: DevRun = { id: "run_unknown_mona", sessionId: first.id, executor: "mona",
      status: "unknown", revision: 1, createdAt: "" };
    const unresolved = { ...first, latestRun: run };
    snapshots.dev_first = { ...makeSnapshot(unresolved), runs: [run], messageCount: 1,
      messages: [{ id: "question", role: "user", content: "继续任务", toolCalls: [], queued: false, truncated: false }] };
    render(<DevelopmentView />);
    const input = await screen.findByRole("textbox", { name: "开发任务输入" });
    fireEvent.change(input, { target: { value: "不要重复执行" } });
    expect(screen.getByRole("button", { name: "发送开发任务" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "默认模型", exact: true })).toBeDisabled();
    expect(screen.getByRole("button", { name: "权限模式：请求批准" })).toBeDisabled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(api.send).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "中断当前轮次" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "任务概览", exact: true }));
    const summary = screen.getByRole("region", { name: "任务概览浮卡" });
    expect(within(summary).queryByText("未收到任务完成结果")).toBeNull();
    await openMoreAction("待处理事项");
    const status = within(await screen.findByRole("dialog", { name: "任务状态与操作" }))
      .getByRole("status", { name: "任务结果暂未收到" });
    api.interrupt.mockImplementationOnce(async () => { snapshots.dev_first.runs = [{ ...run, status: "interrupted" }]; });
    fireEvent.click(within(status).getByRole("button", { name: "停止任务" }));
    await waitFor(() => expect(api.interrupt).toHaveBeenCalledWith(first.id, run.id));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "任务状态与操作" })).toBeNull());
  });

  it("answers a pending question through the task status dialog, outside the summary", async () => {
    const run: DevRun = { id: "run_question", sessionId: first.id, executor: "mona",
      status: "waiting_user", revision: 1, createdAt: "" };
    snapshots.dev_first = { ...makeSnapshot(first), runs: [run], messageCount: 1, pendingDecisions: [{
      id: "question_one", sessionId: first.id, runId: run.id, kind: "question",
      details: { questions: [{ id: "q1", question: "应保留哪个方案？", options: [] }] },
    }] };
    render(<DevelopmentView />);
    await screen.findByRole("textbox", { name: "开发任务输入" });
    fireEvent.click(screen.getByRole("button", { name: "任务概览", exact: true }));
    const summary = screen.getByRole("region", { name: "任务概览浮卡" });
    expect(within(summary).queryByText("需要你的回答")).toBeNull();
    expect(within(summary).queryByRole("textbox", { name: "应保留哪个方案？" })).toBeNull();
    await openMoreAction("待处理事项");
    const statusDialog = await screen.findByRole("dialog", { name: "任务状态与操作" });
    const answer = within(statusDialog).getByRole("textbox", { name: "应保留哪个方案？" });
    api.decide.mockImplementationOnce(async () => { snapshots.dev_first.pendingDecisions = []; });
    fireEvent.change(answer, { target: { value: "保留当前方案" } });
    fireEvent.click(within(statusDialog).getByRole("button", { name: "提交回答" }));
    await waitFor(() => expect(api.decide).toHaveBeenCalledWith(first.id, "question_one", { q1: ["保留当前方案"] }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "任务状态与操作" })).toBeNull());
  });

  it("observes the saved request while its run is unknown without sending a new request", async () => {
    const run: DevRun = { id: "run_unknown", sessionId: first.id, executor: "mona",
      status: "unknown", revision: 1, createdAt: "", requestId: "request_original" };
    snapshots.dev_first = { ...makeSnapshot(first), runs: [run] };
    useDevelopmentStore.getState().setSend(first.id, { id: "request_original", content: "原请求内容", uncertain: true });
    useDevelopmentStore.getState().setDraft(first.id, "保留新草稿");
    api.send.mockResolvedValueOnce({ run, queued: false, reused: true });
    render(<DevelopmentView />);
    await screen.findByRole("textbox", { name: "开发任务输入" });
    await openMoreAction("待处理事项");
    fireEvent.click(within(await screen.findByRole("dialog", { name: "任务状态与操作" })).getByRole("button", { name: "核对发送" }));
    await waitFor(() => expect(api.send).toHaveBeenCalledWith(first.id, "request_original", "原请求内容"));
    expect(api.send).toHaveBeenCalledTimes(1);
    expect(useDevelopmentStore.getState().drafts[first.id]).toBe("保留新草稿");
  });

  it("keeps a project-opening failure inside its dialog", async () => {
    api.openProject.mockRejectedValueOnce(new Error("目录当前不可访问"));
    render(<DevelopmentView />);
    fireEvent.click(await screen.findByRole("button", { name: "打开开发项目" }));
    const dialog = await screen.findByRole("dialog", { name: "打开本地项目" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "项目目录" }), { target: { value: "D:/missing" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "打开项目" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("目录当前不可访问");
    expect(document.querySelector("main")?.textContent).not.toContain("目录当前不可访问");
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    fireEvent.click(screen.getByRole("button", { name: "打开开发项目" }));
    expect(within(await screen.findByRole("dialog", { name: "打开本地项目" })).queryByText("目录当前不可访问")).toBeNull();
  });

  it("shows a task update failure in its operation dialog", async () => {
    api.updateSession.mockRejectedValueOnce(new Error("置顶状态冲突"));
    render(<DevelopmentView />);
    const row = await screen.findByTestId("development-session-dev_first");
    fireEvent.click(within(row).getByRole("button", { name: "置顶任务" }));
    const dialog = await screen.findByRole("dialog", { name: "任务操作未完成" });
    expect(within(dialog).getByRole("alert")).toHaveTextContent("置顶状态冲突");
    expect(document.querySelector("main")?.textContent).not.toContain("置顶状态冲突");
  });

  it("keeps a new-task failure next to the draft instead of the page header", async () => {
    api.createSession.mockRejectedValueOnce(new DevelopmentApiError(422, "invalid_model", "新任务未创建"));
    render(<DevelopmentView />);
    fireEvent.click(await screen.findByRole("button", { name: "在 测试项目 新建会话" }));
    const form = await screen.findByTestId("development-new-task");
    fireEvent.change(within(form).getByRole("textbox", { name: "新开发任务输入" }), { target: { value: "检查项目" } });
    fireEvent.click(within(form).getByRole("button", { name: "创建并发送开发任务" }));
    const alert = await within(form).findByRole("alert");
    expect(alert).toHaveTextContent("新任务未创建");
    expect(alert.closest("footer")).not.toBeNull();
  });

  it("keeps uncertain send status in pending actions and reuses its request id", async () => {
    useDevelopmentStore.getState().setSend(first.id, { id: "request_once", content: "只发送一次", uncertain: true });
    render(<DevelopmentView />);
    const scroll = await screen.findByLabelText("开发会话记录");
    expect(within(scroll).queryByText(/上次发送结果待核对/)).toBeNull();
    expect(within(screen.getByRole("textbox", { name: "开发任务输入" }).closest("footer")!).queryByText(/上次发送结果待核对/)).toBeNull();
    await openMoreAction("待处理事项");
    const status = within(await screen.findByRole("dialog", { name: "任务状态与操作" })).getByRole("status", { name: "发送状态待核对" });
    expect(status).toHaveTextContent("不会重复启动任务");
    fireEvent.click(within(status as HTMLElement).getByRole("button", { name: "核对发送" }));
    await waitFor(() => expect(api.send).toHaveBeenCalledWith(first.id, "request_once", "只发送一次"));
  });

  it("keeps history-loading failures out of the transcript", async () => {
    snapshots.dev_first.before = 2;
    api.snapshot.mockImplementation(async (id: string, _after: number, before?: number) => {
      if (before === 2) throw new Error("历史暂不可读取");
      return snapshots[id];
    });
    render(<DevelopmentView />);
    const scroll = await screen.findByLabelText("开发会话记录");
    expect(within(scroll).queryByRole("button", { name: "读取较早消息" })).toBeNull();
    await openMoreAction("待处理事项");
    fireEvent.click(within(await screen.findByRole("dialog", { name: "任务状态与操作" })).getByRole("button", { name: "读取较早消息" }));
    expect(await screen.findByRole("dialog", { name: "操作未完成" })).toHaveTextContent("历史暂不可读取");
    expect(within(scroll).queryByText("历史暂不可读取")).toBeNull();
    expect(scroll.querySelector("footer")?.textContent).not.toContain("历史暂不可读取");
  });

  it("keeps connection guidance out of the transcript and input area", async () => {
    const native = { ...first, executor: "codex" as const };
    snapshots.dev_first = { ...makeSnapshot(native), messages: [{ id: "q", role: "user", content: "继续任务", truncated: false, queued: false, toolCalls: [] }], messageCount: 1,
      nativeBinding: { id: "binding", turnHistory: true, replacesBindingId: "old", replacementReason: "history_missing" } };
    api.capabilities.mockResolvedValue({ executors: [{ id: "codex", name: "Codex", available: true, reason: "", models: [] }] });
    render(<DevelopmentView />);
    const scroll = await screen.findByLabelText("开发会话记录");
    expect(within(scroll).queryByText(/原执行历史无法恢复/)).toBeNull();
    expect(within(scroll).queryByRole("button", { name: "重新连接执行者" })).toBeNull();
    expect(screen.queryByText(/原执行历史无法恢复/)).toBeNull();
    fireEvent.pointerDown(screen.getByRole("button", { name: "会话更多操作" }), { button: 0, ctrlKey: false });
    expect(await screen.findByRole("menu")).not.toHaveTextContent("重新连接执行者");
    expect(screen.queryByRole("dialog", { name: "在当前任务中重新连接？" })).toBeNull();
  });

  it("leaves a new conversation blank above its composer", async () => {
    render(<DevelopmentView />);
    const scroll = await screen.findByLabelText("开发会话记录");
    expect(within(scroll).queryByText(/在当前项目中继续工作|描述你要完成的修改/)).toBeNull();
    expect(screen.getByRole("textbox", { name: "开发任务输入" })).toBeInTheDocument();
  });

  it("places permission requests at the input and sends the decision once", async () => {
    snapshots.dev_first.pendingDecisions = [{ id: "decision_one", sessionId: first.id, runId: "run_one", kind: "permission", details: { reason: "需要确认本次操作" } }];
    render(<DevelopmentView />);
    const scroll = await screen.findByLabelText("开发会话记录");
    const confirmation = within(scroll.querySelector("footer")!).getByLabelText("当前任务确认");
    expect(confirmation).toHaveTextContent("需要确认本次操作");
    expect(screen.queryByRole("textbox", { name: "开发任务输入" })).toBeNull();
    fireEvent.click(within(confirmation).getByRole("button", { name: "允许一次" }));
    await waitFor(() => expect(api.decide).toHaveBeenCalledWith(first.id, "decision_one", "accept"));
    expect(api.decide).toHaveBeenCalledTimes(1);
  });

  it("keeps a side-chat failure in that tab and gives a working retry", async () => {
    api.createSession.mockRejectedValueOnce(new Error("侧边会话暂不可用"));
    render(<DevelopmentView />);
    await screen.findByRole("textbox", { name: "开发任务输入" });
    fireEvent.pointerDown(screen.getByRole("button", { name: "会话更多操作" }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: "打开侧边聊天" }));
    const sidebar = await screen.findByRole("complementary", { name: "开发工作侧栏" });
    const alert = await within(sidebar).findByRole("alert");
    expect(alert).toHaveTextContent("侧边会话暂不可用");
    const retry = within(sidebar).getByRole("button", { name: "重试打开侧边聊天" });
    fireEvent.click(retry);
    await waitFor(() => expect(api.createSession).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(within(sidebar).queryByText("侧边会话暂不可用")).toBeNull());
  });

  it("does not change the current task when an older deletion finishes", async () => {
    const third = session("dev_third", "继续其他任务");
    snapshots[third.id] = makeSnapshot(third);
    const deleting = deferred<{ deleted: string[] }>();
    api.deleteSession.mockReturnValueOnce(deleting.promise);
    render(<DevelopmentView />); await screen.findByRole("textbox", { name: "开发任务输入" });
    fireEvent.pointerDown(screen.getByRole("button", { name: "实现登录 更多操作" }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: "永久删除" }));
    fireEvent.click(await screen.findByRole("button", { name: "永久删除" }));
    act(() => { useDevelopmentStore.getState().openSession(project.id, third.id); });
    await act(async () => { delete snapshots[first.id]; deleting.resolve({ deleted: [first.id] }); await deleting.promise; });
    await waitFor(() => expect(useDevelopmentStore.getState().snapshots[first.id]).toBeUndefined());
    expect(useDevelopmentStore.getState().views[project.id].sessionId).toBe(third.id);
  });

  it("allows archiving a session with an active run and calls the update API", async () => {
    const running = { ...first, latestRun: { id: "run_active", sessionId: first.id, executor: "mona" as const,
      status: "running" as const, revision: 1, createdAt: "" } };
    snapshots.dev_first = makeSnapshot(running);
    render(<DevelopmentView />); await screen.findByRole("textbox", { name: "开发任务输入" });
    fireEvent.pointerDown(screen.getByRole("button", { name: "实现登录 更多操作" }), { button: 0, ctrlKey: false });
    const archiveItem = await screen.findByRole("menuitem", { name: "归档" });
    expect(archiveItem).not.toHaveAttribute("data-disabled");
    fireEvent.click(archiveItem);
    await waitFor(() => expect(api.updateSession).toHaveBeenCalledWith(running, { archived: true }));
  });

  it("removes a deleted task without waiting for its terminal to exit", async () => {
    const killing = deferred<void>();
    terminal.kill.mockReturnValueOnce(killing.promise);
    useDevelopmentStore.getState().setTerminal(first.id, { id: "owned_terminal", status: "ready" });
    render(<DevelopmentView />); await screen.findByRole("textbox", { name: "开发任务输入" });
    fireEvent.pointerDown(screen.getByRole("button", { name: "实现登录 更多操作" }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: "永久删除" }));
    await screen.findByRole("dialog", { name: "永久删除任务" });
    fireEvent.click(screen.getByRole("button", { name: "永久删除" }));

    await waitFor(() => expect(api.deleteSession).toHaveBeenCalledWith(first));
    await waitFor(() => expect(terminal.kill).toHaveBeenCalledWith("owned_terminal"));
    await waitFor(() => expect(screen.queryByRole("button", { name: "打开开发任务：实现登录" })).not.toBeInTheDocument());
    expect(useDevelopmentStore.getState().snapshots[first.id]).toBeUndefined();
    expect(useDevelopmentStore.getState().terminals[first.id]).toMatchObject({ id: "owned_terminal", status: "closing" });

    await act(async () => { killing.resolve(undefined); await killing.promise; });
    await waitFor(() => expect(useDevelopmentStore.getState().terminals[first.id]).toBeUndefined());
  });

  it("keeps a failed terminal cleanup visible without blocking session deletion", async () => {
    api.deleteSession.mockImplementationOnce(async () => {
      delete snapshots[first.id];
      return { deleted: [first.id], warnings: ["项目清理未完成"] };
    });
    terminal.kill.mockRejectedValueOnce(new Error("终端连接中断"));
    useDevelopmentStore.getState().setTerminal(first.id, { id: "owned_terminal", status: "ready" });
    render(<DevelopmentView />); await screen.findByRole("textbox", { name: "开发任务输入" });
    fireEvent.pointerDown(screen.getByRole("button", { name: "实现登录 更多操作" }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: "永久删除" }));
    await screen.findByRole("dialog", { name: "永久删除任务" });
    fireEvent.click(screen.getByRole("button", { name: "永久删除" }));

    await waitFor(() => expect(api.deleteSession).toHaveBeenCalledWith(first));
    await screen.findByText("项目清理未完成");
    await screen.findByText(/关联终端未确认结束。请在系统任务管理器检查/);
    expect(screen.queryByRole("button", { name: "打开开发任务：实现登录" })).not.toBeInTheDocument();
    expect(useDevelopmentStore.getState().snapshots[first.id]).toBeUndefined();
    expect(useDevelopmentStore.getState().terminals[first.id]).toMatchObject({ id: "owned_terminal", status: "error" });
    expect(useDevelopmentStore.getState().terminals[first.id].error).toContain("终端连接中断");
  });

  it("opens the task project in a system terminal without changing the selected task or workspace", async () => {
    useDevelopmentStore.getState().openSession(project.id, second.id);
    render(<DevelopmentView />); await screen.findByRole("textbox", { name: "开发任务输入" });
    vi.spyOn(tauri, "isTauri").mockReturnValue(true);
    const sides = useDevelopmentStore.getState().sides;
    const terminals = useDevelopmentStore.getState().terminals;
    fireEvent.pointerDown(screen.getByRole("button", { name: "实现登录 更多操作" }), { button: 0, ctrlKey: false });
    const openWith = await screen.findByRole("menuitem", { name: /打开方式/ });
    fireEvent.pointerMove(openWith, { pointerType: "mouse" });
    fireEvent.keyDown(openWith, { key: "ArrowRight" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "终端" }));
    await waitFor(() => expect(native.invoke).toHaveBeenCalledWith("system_open_in_terminal", { path: project.rootPath }));
    expect(useDevelopmentStore.getState().views[project.id].sessionId).toBe(second.id);
    expect(useDevelopmentStore.getState().sides).toBe(sides);
    expect(useDevelopmentStore.getState().terminals).toBe(terminals);
  });

  it("opens a terminal for the menu's project while another project is selected", async () => {
    const otherProject = { ...project, id: "project_b", rootPath: "D:/另一个 项目", displayName: "另一个项目" };
    const otherSession = { ...second, id: "dev_other", projectId: otherProject.id, title: "修改样式" };
    snapshots[otherSession.id] = makeSnapshot(otherSession);
    api.projects.mockResolvedValue([project, otherProject]);
    render(<DevelopmentView />); await screen.findByRole("textbox", { name: "开发任务输入" });
    vi.spyOn(tauri, "isTauri").mockReturnValue(true);
    fireEvent.pointerDown(await screen.findByRole("button", { name: "修改样式 更多操作" }), { button: 0, ctrlKey: false });
    const openWith = await screen.findByRole("menuitem", { name: /打开方式/ });
    fireEvent.pointerMove(openWith, { pointerType: "mouse" });
    fireEvent.keyDown(openWith, { key: "ArrowRight" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "终端" }));
    await waitFor(() => expect(native.invoke).toHaveBeenCalledWith("system_open_in_terminal", { path: otherProject.rootPath }));
    expect(useDevelopmentStore.getState().projectId).toBe(project.id);
    expect(useDevelopmentStore.getState().views[project.id].sessionId).toBe(first.id);
    expect(useDevelopmentStore.getState().sides[otherSession.id]).toBeUndefined();
  });

  it("updates the current session through the header menu and keeps its cached revision current", async () => {
    render(<DevelopmentView />); await screen.findByRole("textbox", { name: "开发任务输入" });
    await openMoreAction("重命名");
    fireEvent.change(screen.getByRole("textbox", { name: "新的任务名称" }), { target: { value: "新的任务标题" } });
    fireEvent.click(screen.getByRole("button", { name: "保存", exact: true }));
    await screen.findByRole("heading", { name: "新的任务标题" });
    await openMoreAction("置顶");
    await waitFor(() => expect(useDevelopmentStore.getState().snapshots[first.id].session.pinned).toBe(true));
    await openMoreAction("归档会话");
    await waitFor(() => expect(screen.getByRole("button", { name: "发送开发任务" })).toBeDisabled());
    expect(api.updateSession).toHaveBeenLastCalledWith(expect.objectContaining({ id: first.id, revision: 2, pinned: true }), { archived: true });
    expect(api.send).not.toHaveBeenCalled(); expect(api.interrupt).not.toHaveBeenCalled();
  });

  it("opens an overview card without taking a workspace column and restores focus on Escape", async () => {
    render(<DevelopmentView />); await screen.findByRole("textbox", { name: "开发任务输入" });
    const trigger = screen.getByRole("button", { name: "任务概览", exact: true });
    fireEvent.click(trigger);
    expect(screen.getByRole("region", { name: "任务概览浮卡" })).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "开发工作侧栏" })).not.toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "任务概览浮卡" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("opens a single readonly side chat from the header and restores it after collapsing", async () => {
    render(<DevelopmentView />); await screen.findByRole("textbox", { name: "开发任务输入" });
    await openMoreAction("打开侧边聊天");
    await screen.findByRole("textbox", { name: "侧边聊天输入" });
    expect(api.createSession).toHaveBeenCalledWith(project.id, expect.objectContaining({ parentSessionId: first.id, readonly: true }));
    fireEvent.click(screen.getByRole("button", { name: "收起侧边栏" }));
    fireEvent.click(screen.getByRole("button", { name: "打开工作侧栏" }));
    await screen.findByRole("textbox", { name: "侧边聊天输入" });
    expect(api.createSession).toHaveBeenCalledTimes(1);
    expect(api.send).not.toHaveBeenCalled(); expect(api.interrupt).not.toHaveBeenCalled();
  });

  it("keeps pinned projects above a newly opened unpinned project", async () => {
    api.projects.mockResolvedValue([{ ...project, pinned: true }]);
    const opened = { ...project, id: "project_new", displayName: "新项目", rootPath: "D:/new-project", pinned: false, lastOpenedAt: "2026-09-29T00:00:00Z" };
    api.openProject.mockResolvedValue(opened);
    render(<DevelopmentView />);
    await screen.findByRole("textbox", { name: "开发任务输入" });
    fireEvent.click(screen.getByRole("button", { name: "打开开发项目", exact: true }));
    fireEvent.change(screen.getByRole("textbox", { name: "项目目录" }), { target: { value: opened.rootPath } });
    fireEvent.click(screen.getByRole("button", { name: "打开项目", exact: true }));
    await waitFor(() => expect(useDevelopmentStore.getState().projectId).toBe(opened.id));
    const list = screen.getByRole("complementary", { name: "开发项目列表" });
    expect(within(list).getAllByRole("region").map((item) => item.getAttribute("aria-label"))).toEqual(["项目 测试项目", "项目 新项目"]);
    expect(api.send).not.toHaveBeenCalled();
  });

  it("keeps the project rail width stable across content interactions", async () => {
    render(<DevelopmentView />); await screen.findByRole("textbox", { name: "开发任务输入" });
    const rail = screen.getByTestId("development-projects");
    const initial = rail.getAttribute("style");

    fireEvent.click(within(screen.getByRole("complementary", { name: "开发项目列表" }))
      .getByRole("button", { name: "打开开发任务：检查接口", exact: true }));
    await waitFor(() => expect(useDevelopmentStore.getState().views[project.id].sessionId).toBe(second.id));
    expect(rail.getAttribute("style")).toBe(initial);

    fireEvent.pointerDown(screen.getByRole("button", { name: "检查接口 更多操作" }), { button: 0, ctrlKey: false });
    await screen.findByRole("menu");
    expect(rail.getAttribute("style")).toBe(initial);
    fireEvent.keyDown(document, { key: "Escape" });

    fireEvent.click(screen.getByRole("button", { name: "打开工作侧栏" }));
    await screen.findByRole("separator", { name: "调整工作侧栏宽度" });
    expect(rail.getAttribute("style")).toBe(initial);

  });

  it("starts with a full conversation and opens the tools panel on demand", async () => {
    render(<DevelopmentView />); await screen.findByRole("textbox", { name: "开发任务输入" });
    expect(screen.getByRole("separator", { name: "调整项目列表宽度" })).toHaveAttribute("tabindex", "0");
    expect(screen.queryByRole("separator", { name: "调整工作侧栏宽度" })).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "开发工作侧栏" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "打开工作侧栏" }));
    expect(screen.getByRole("separator", { name: "调整工作侧栏宽度" })).toHaveAttribute("tabindex", "0");
    expect(screen.queryByRole("button", { name: "打开工作侧栏" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "隐藏工作侧栏" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "搜索或输入网址" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "工具" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "浏览器", exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "子智能体配置", exact: true })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "文件", exact: true })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "打开工作标签" })).toHaveLength(1);
    await openWorkTab("文件");
    expect(await screen.findByRole("tab", { name: "文件", exact: true })).toHaveAttribute("aria-selected", "true");
    expect(api.send).not.toHaveBeenCalled(); expect(api.delegate).not.toHaveBeenCalled();
  });

  it("keeps the work divider and conversation draft when the project list is hidden", async () => {
    render(<DevelopmentView />);
    fireEvent.change(await screen.findByRole("textbox", { name: "开发任务输入" }), { target: { value: "保留草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "打开工作侧栏" }));
    const projectList = screen.getByRole("complementary", { name: "开发项目列表" });
    const collapse = within(projectList).getByRole("button", { name: "切换项目列表" });
    expect(within(projectList).getByRole("button", { name: "打开开发项目" }).nextElementSibling).toBe(collapse);
    expect(screen.getAllByRole("button", { name: "切换项目列表" })).toHaveLength(1);
    fireEvent.click(collapse);
    expect(screen.queryByRole("separator", { name: "调整项目列表宽度" })).not.toBeInTheDocument();
    expect(screen.getByRole("separator", { name: "调整工作侧栏宽度" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "切换项目列表" }));
    expect(screen.getByRole("separator", { name: "调整项目列表宽度" })).toBeInTheDocument();
    expect(within(screen.getByRole("complementary", { name: "开发项目列表" })).getByRole("button", { name: "切换项目列表" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "开发任务输入" })).toHaveValue("保留草稿");
    expect(api.send).not.toHaveBeenCalled(); expect(api.interrupt).not.toHaveBeenCalled();
  });

  it("uses project sessions with exactly one main conversation and no split-screen entry", async () => {
    render(<DevelopmentView />);
    const input = await screen.findByRole("textbox", { name: "开发任务输入" });
    expect(screen.getByRole("complementary", { name: "开发项目列表" })).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "开发工作侧栏" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /单屏|双屏|四屏/ })).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: "保留当前草稿" } });
    fireEvent.click(within(screen.getByRole("complementary", { name: "开发项目列表" })).getByRole("button", { name: "打开开发任务：检查接口", exact: true }));
    await waitFor(() => expect(useDevelopmentStore.getState().views[project.id].sessionId).toBe(second.id));
    expect(screen.getAllByTestId("development-pane")).toHaveLength(1);
    expect(useDevelopmentStore.getState().drafts[first.id]).toBe("保留当前草稿");
    expect(api.interrupt).not.toHaveBeenCalled(); expect(api.send).not.toHaveBeenCalled();
  });
  it("only shows structured plan state, never hardcoded completed TODOs", async () => {
    snapshots.dev_first.plan = { runId: "run_plan", plan: [{ step: "核对真实文件", status: "completed" }, { step: "运行项目测试", status: "in_progress" }] };
    api.git.mockResolvedValue({ available: true, branch: "main", count: 0, files: [] });
    render(<DevelopmentView />); await screen.findByRole("textbox", { name: "开发任务输入" });
    fireEvent.click(screen.getByRole("button", { name: "任务概览", exact: true }));
    const plan = screen.getByRole("region", { name: "任务待办" });
    expect(within(plan).getByText("1/2")).toBeInTheDocument();
    expect(within(plan).getByText("核对真实文件")).toBeInTheDocument();
    expect(screen.queryByText("分析任务范围")).not.toBeInTheDocument();
    expect(screen.queryByText("已启用")).not.toBeInTheDocument();
  });
  it("manually saves a project subagent and does not start a task", async () => {
    render(<DevelopmentView />); await screen.findByRole("textbox", { name: "开发任务输入" });
    fireEvent.click(screen.getByRole("button", { name: "任务概览", exact: true }));
    fireEvent.click(screen.getByRole("button", { name: "子智能体配置", exact: true }));
    fireEvent.click(await screen.findByRole("button", { name: "添加子智能体", exact: true }));
    fireEvent.change(screen.getByRole("textbox", { name: "子智能体名称" }), { target: { value: "我的审查员" } });
    fireEvent.change(screen.getByRole("textbox", { name: "子智能体描述" }), { target: { value: "核对本次差异，不修改文件" } });
    fireEvent.click(screen.getByRole("button", { name: "保存子智能体" }));
    await waitFor(() => expect(subagents.save).toHaveBeenCalledWith(project.id, expect.objectContaining({ revision: 0, presets: [expect.objectContaining({ name: "我的审查员", executor: "mona", readonly: true, enabled: true })] })));
    expect(api.send).not.toHaveBeenCalled(); expect(subagents.run).not.toHaveBeenCalled();
  });
  it("refreshes the mounted model directory after a native probe without changing the task route", async () => {
    render(<DevelopmentView />);
    await screen.findByRole("textbox", { name: "开发任务输入" });
    const reads = api.capabilities.mock.calls.length;
    api.capabilities.mockResolvedValue({ executors: [
      { id: "mona", name: "Mona Coding", available: true, reason: "", models: [{ id: "", label: "默认模型" }] },
      { id: "codebuddy", name: "CodeBuddy", available: true, reason: "", models: [{ id: "fresh-model", label: "新同步模型" }] },
    ] });
    act(() => nativeProvidersChanged());
    await waitFor(() => expect(api.capabilities.mock.calls.length).toBeGreaterThan(reads));
    expect(useDevelopmentStore.getState().views[project.id].sessionId).toBe(first.id);
    expect(snapshots[first.id].session.executor).toBe("mona");
    expect(api.selectModelSource).not.toHaveBeenCalled();
    expect(api.createSession).not.toHaveBeenCalled();
  });

  it("opens the real Git confirmation flow without sending a chat instruction", async () => {
    api.git.mockResolvedValue({ available: true, branch: "feature/test", count: 2, additions: 7, deletions: 3, untrackedFiles: 1, files: [] });
    render(<DevelopmentView />); await screen.findByRole("textbox", { name: "开发任务输入" });
    fireEvent.click(screen.getByRole("button", { name: "任务概览", exact: true }));
    const panel = await screen.findByRole("region", { name: "Git 工具" });
    await within(panel).findByText("feature/test");
    expect(within(panel).getByText("+7")).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole("button", { name: "提交或推送" }));
    const dialog = await screen.findByRole("dialog", { name: "测试项目 Git 操作" });
    expect(await within(dialog).findByRole("textbox", { name: "提交信息" })).toBeInTheDocument();
    expect(within(dialog).getByRole("option", { name: /提交并推送/ })).toBeInTheDocument();
    expect(useDevelopmentStore.getState().drafts[first.id]).toBeUndefined();
    expect(api.send).not.toHaveBeenCalled();
  });
  it("sends to the current session and clears only its acknowledged draft", async () => {
    render(<DevelopmentView />);
    const input = await screen.findByRole("textbox", { name: "开发任务输入" });
    fireEvent.change(input, { target: { value: "修复登录页面" } });
    fireEvent.click(screen.getByRole("button", { name: "发送开发任务" }));
    await waitFor(() => expect(api.send).toHaveBeenCalledWith(first.id, expect.stringMatching(/^request_/), "修复登录页面"));
    await waitFor(() => expect(useDevelopmentStore.getState().drafts[first.id]).toBe(""));
  });
  it("retains unknown send identity and never automatically retries after network failure", async () => {
    api.send.mockRejectedValueOnce(new Error("连接中断"));
    render(<DevelopmentView />);
    fireEvent.change(await screen.findByRole("textbox", { name: "开发任务输入" }), { target: { value: "只运行一次" } });
    fireEvent.click(screen.getByRole("button", { name: "发送开发任务" }));
    await waitFor(() => expect(api.send).toHaveBeenCalledTimes(1));
    const firstId = api.send.mock.calls[0][1];
    expect(useDevelopmentStore.getState().drafts[first.id]).toBe("只运行一次");
    const scroll = screen.getByLabelText("开发会话记录");
    expect(within(scroll).queryByText("连接中断")).toBeNull();
    const failure = await screen.findByRole("dialog", { name: "操作未完成" });
    expect(failure).toHaveTextContent("连接中断");
    fireEvent.click(within(failure).getByRole("button", { name: "知道了" }));
    await openMoreAction("待处理事项");
    fireEvent.click(within(await screen.findByRole("dialog", { name: "任务状态与操作" })).getByRole("button", { name: "核对发送" }));
    await waitFor(() => expect(api.send).toHaveBeenCalledTimes(2));
    expect(api.send.mock.calls[1][1]).toBe(firstId);
  });
  it("opens the shared right sidebar and preserves a dirty file after save conflict", async () => {
    api.saveFile.mockRejectedValueOnce(new Error("文件已被其他操作修改"));
    render(<DevelopmentView />); await screen.findByRole("textbox", { name: "开发任务输入" });
    await openWorkTab("文件");
    fireEvent.click(await screen.findByRole("button", { name: "index.ts" }));
    const editor = await screen.findByRole("textbox", { name: "项目文件编辑器" });
    fireEvent.change(editor, { target: { value: "my unsaved change" } });
    fireEvent.keyDown(editor, { key: "s", code: "KeyS", ctrlKey: true });
    await screen.findByText("文件已被其他操作修改");
    expect(editor).toHaveValue("my unsaved change");
    expect(api.saveFile).toHaveBeenCalledWith(project.id, expect.objectContaining({ sha256: "filehash" }), "my unsaved change");
    fireEvent.click(screen.getByRole("button", { name: "收起侧边栏" }));
    expect(screen.queryByRole("complementary", { name: "开发工作侧栏" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "打开工作侧栏" }));
    expect(await screen.findByRole("textbox", { name: "项目文件编辑器" })).toHaveValue("my unsaved change");
    expect(api.interrupt).not.toHaveBeenCalled();
  });
  it("closing a terminal view preserves the owned process until explicitly ended", async () => {
    useDevelopmentStore.getState().setTerminal(first.id, { id: "owned_terminal", status: "ready" });
    render(<DevelopmentView />);
    await screen.findByRole("textbox", { name: "开发任务输入" });
    expect(screen.queryByRole("button", { name: "关闭 终端", exact: true })).not.toBeInTheDocument();
    await openWorkTab("终端");
    fireEvent.click(screen.getByRole("button", { name: "关闭 终端", exact: true }));
    await waitFor(() => expect(useDevelopmentStore.getState().sides[first.id].tab).toBe("overview"));
    expect(useDevelopmentStore.getState().terminals[first.id].id).toBe("owned_terminal");
    expect(terminal.kill).not.toHaveBeenCalled();
    expect(api.interrupt).not.toHaveBeenCalled();
    await act(async () => { await Promise.resolve(); });
  });

  it("collapses after closing all sidebar tabs and reopens the new tab", async () => {
    render(<DevelopmentView />);
    await screen.findByRole("textbox", { name: "开发任务输入" });
    await openWorkTab("文件");
    fireEvent.click(screen.getByRole("button", { name: "关闭 新标签页", exact: true }));
    expect(screen.queryByRole("tab", { name: "新标签页", exact: true })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "文件", exact: true })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("button", { name: "关闭 文件", exact: true }));
    expect(screen.queryByRole("complementary", { name: "开发工作侧栏" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "打开工作侧栏", exact: true }));
    expect(screen.getByRole("tab", { name: "新标签页", exact: true })).toHaveAttribute("aria-selected", "true");
    expect(api.interrupt).not.toHaveBeenCalled();
  });

  it("rejects a stale side-chat binding from a different project rather than displaying it", async () => {
    const foreign = { ...session("foreign_chat", "不属于当前项目"), projectId: "project_b", parentSessionId: first.id, readonly: true };
    snapshots.foreign_chat = makeSnapshot(foreign);
    useDevelopmentStore.getState().setSideChat(first.id, foreign.id);
    render(<DevelopmentView />); await screen.findByRole("textbox", { name: "开发任务输入" });
    await openWorkTab("辅助对话");
    await waitFor(() => expect(screen.getAllByText(/侧边会话归属或只读权限不匹配/).length).toBeGreaterThan(0));
    expect(screen.queryByRole("textbox", { name: "侧边聊天输入" })).not.toBeInTheDocument();
    expect(api.createSession).not.toHaveBeenCalled(); expect(api.send).not.toHaveBeenCalled();
  });

  it("keeps unavailable Git rows disabled without inventing change counts", async () => {
    render(<DevelopmentView />); await screen.findByRole("textbox", { name: "开发任务输入" });
    fireEvent.click(screen.getByRole("button", { name: "任务概览", exact: true }));
    const block = screen.getByRole("region", { name: "Git 工具" });
    expect(within(block).getByRole("button", { name: "提交或推送" })).toBeDisabled();
    expect(within(block).getByRole("button", { name: "切换 Git 分支" })).toBeDisabled();
    expect(within(block).queryByText("+0")).toBeNull();
  });

  it("keeps the launcher first and supports keyboard tool selection", async () => {
    render(<DevelopmentView />); await screen.findByRole("textbox", { name: "开发任务输入" });
    fireEvent.click(screen.getByRole("button", { name: "打开工作侧栏" }));
    const sidebar = await screen.findByRole("complementary", { name: "开发工作侧栏" });
    expect(within(sidebar).getByRole("tab", { name: "新标签页", exact: true })).toHaveAttribute("aria-selected", "true");
    await openWorkTab("文件");
    const overview = within(sidebar).getByRole("tab", { name: "新标签页", exact: true });
    overview.focus(); fireEvent.keyDown(overview, { key: "ArrowRight" });
    expect(within(sidebar).getByRole("tab", { name: "文件", exact: true })).toHaveFocus();
    expect(useDevelopmentStore.getState().sides[first.id].tab).toBe("workspace");
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(overview).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByText("协作者", { exact: true })).not.toBeInTheDocument();
    expect(api.send).not.toHaveBeenCalled(); expect(api.interrupt).not.toHaveBeenCalled();
  });

  it("does not cancel running work when the module is hidden", async () => {
    const view = render(<DevelopmentView visible />);
    await screen.findByRole("textbox", { name: "开发任务输入" });
    act(() => { useDevelopmentStore.getState().setDraft(first.id, "未发送草稿"); });
    view.rerender(<DevelopmentView visible={false} />);
    expect(useDevelopmentStore.getState().drafts[first.id]).toBe("未发送草稿");
    expect(api.interrupt).not.toHaveBeenCalled(); expect(api.send).not.toHaveBeenCalled();
  });
  it("does not show session ages in the development project list", async () => {
    const ui = render(<DevelopmentView />);
    await screen.findByRole("textbox", { name: "开发任务输入" });
    expect(ui.container.querySelector("time")).toBeNull();
  });
  it("uses the ordinary plus attachment entry on the new-task page", async () => {
    render(<DevelopmentView />);
    await screen.findByRole("textbox", { name: "开发任务输入" });
    fireEvent.click(screen.getByRole("button", { name: "在 测试项目 新建会话", exact: true }));
    const form = await screen.findByTestId("development-new-task");
    expect(within(form).getByRole("button", { name: i18n.t("thread.composer.attachFile") })).toBeInTheDocument();
    expect(within(form).queryByRole("button", { name: "引用项目文件" })).toBeNull();
    expect(api.createSession).not.toHaveBeenCalled();
  });

  it("opens a draft page from the project list and only creates the conversation on first send", async () => {
    render(<DevelopmentView />);
    fireEvent.change(await screen.findByRole("textbox", { name: "开发任务输入" }), { target: { value: "旧会话草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "在 测试项目 新建会话", exact: true }));
    const draft = await screen.findByRole("textbox", { name: "新开发任务输入" });
    expect(draft).toHaveFocus();
    expect(screen.getByRole("heading", { name: "你想让我们在 测试项目 中构建什么？" })).toBeInTheDocument();
    expect(api.createSession).not.toHaveBeenCalled();
    expect(api.send).not.toHaveBeenCalled();
    expect(useDevelopmentStore.getState().drafts[first.id]).toBe("旧会话草稿");
    const detail = "🧭".repeat(210);
    const sentContent = `实现\n新的   开发需求 ${detail}`;
    const titleSource = `实现 新的 开发需求 ${detail}`;
    const title = `${Array.from(titleSource).slice(0, 199).join("")}…`;
    fireEvent.change(draft, { target: { value: `  ${sentContent}  ` } });
    fireEvent.click(screen.getByRole("button", { name: "创建并发送开发任务" }));
    expect(Array.from(title)).toHaveLength(200);
    await waitFor(() => expect(api.createSession).toHaveBeenCalledWith(project.id, expect.objectContaining({ title })));
    await waitFor(() => expect(api.send).toHaveBeenCalledWith("dev_created_2", expect.any(String), sentContent));
    expect(useDevelopmentStore.getState().views[project.id].sessionId).toBe("dev_created_2");
    expect(screen.getByTestId("development-pane")).toHaveAttribute("aria-label", title);
    await waitFor(() => expect(screen.getByTestId("development-session-dev_created_2")).toHaveTextContent(title));
    expect(api.interrupt).not.toHaveBeenCalled();
  });
  it("uses the first attached document name as an attachment-only task title", async () => {
    const { client, sendDocUpload } = documentUploadClient();
    render(<ClientProvider client={client} token="" runtimeStatus="ready"><DevelopmentView /></ClientProvider>);
    await screen.findByRole("textbox", { name: "开发任务输入" });
    fireEvent.click(screen.getByRole("button", { name: "在 测试项目 新建会话", exact: true }));
    const form = await screen.findByTestId("development-new-task");
    const file = new File(["spec"], "requirements.md", { type: "text/markdown" });
    Object.defineProperty(file, "path", { value: "D:/project/requirements.md" });
    const fileInput = form.querySelector<HTMLInputElement>('input[type="file"]')!;
    fireEvent.change(fileInput, { target: { files: [file] } });
    await waitFor(() => expect(sendDocUpload).toHaveBeenCalledOnce());
    fireEvent.click(await screen.findByRole("button", { name: "创建并发送开发任务" }));

    await waitFor(() => expect(api.createSession).toHaveBeenCalledWith(project.id, expect.objectContaining({ title: "requirements.md" })));
    await waitFor(() => expect(screen.getByTestId("development-pane")).toHaveAttribute("aria-label", "requirements.md"));
    await waitFor(() => expect(screen.getByTestId("development-session-dev_created_2")).toHaveTextContent("requirements.md"));
  });
  it("restores an unsent new-task draft, attachment and route after the workbench reloads", async () => {
    snapshots.dev_first.session = { ...first, model: "same-model", modelProvider: "custom-relay", modelReasoningEffort: "high" };
    const { client, sendDocUpload } = documentUploadClient();
    const workbench = () => <ClientProvider client={client} token="" runtimeStatus="ready"><DevelopmentView /></ClientProvider>;
    const view = render(workbench());
    await screen.findByRole("textbox", { name: "开发任务输入" });
    fireEvent.click(screen.getByRole("button", { name: "在 测试项目 新建会话", exact: true }));
    const input = await screen.findByRole("textbox", { name: "新开发任务输入" });
    fireEvent.change(input, { target: { value: "稍后完成的需求" } });
    const file = new File(["spec"], "requirements.md", { type: "text/markdown" });
    Object.defineProperty(file, "path", { value: "D:/project/requirements.md" });
    fireEvent.change(screen.getByTestId("development-new-task").querySelector<HTMLInputElement>('input[type="file"]')!, { target: { files: [file] } });
    await waitFor(() => expect(sendDocUpload).toHaveBeenCalledOnce());
    await screen.findByText("requirements.md");
    const key = "mona.development.workbench.v1";
    const persisted = localStorage.getItem(key)!;
    expect(JSON.parse(persisted).state.newTaskDrafts[project.id]).toMatchObject({ draft: "稍后完成的需求", model: "same-model", provider: "custom-relay", effort: "high", documents: [{ name: "requirements.md" }] });
    view.unmount();
    useDevelopmentStore.setState(useDevelopmentStore.getInitialState(), true);
    localStorage.setItem(key, persisted);
    await act(async () => { await useDevelopmentStore.persist.rehydrate(); });
    render(workbench());
    expect(await screen.findByRole("textbox", { name: "新开发任务输入" })).toHaveValue("稍后完成的需求");
    expect(screen.getByText("requirements.md")).toBeInTheDocument();
    expect(api.createSession).not.toHaveBeenCalled();
    expect(api.send).not.toHaveBeenCalled();
  });
  it("continues an uncertain creation after reload with the original identity, route, text and attachments", async () => {
    snapshots.dev_first.session = { ...first, model: "original-model", modelProvider: "original-provider", modelReasoningEffort: "high" };
    api.createSession.mockRejectedValueOnce(new TypeError("response lost"));
    api.createSession.mockRejectedValueOnce(new DevelopmentApiError(401, "unauthorized", "请重新登录后继续"));
    const { client, sendDocUpload } = documentUploadClient();
    const workbench = () => <ClientProvider client={client} token="" runtimeStatus="ready"><DevelopmentView /></ClientProvider>;
    const view = render(workbench());
    await screen.findByRole("textbox", { name: "开发任务输入" });
    fireEvent.click(screen.getByRole("button", { name: "在 测试项目 新建会话", exact: true }));
    const input = await screen.findByRole("textbox", { name: "新开发任务输入" });
    fireEvent.change(input, { target: { value: "原任务内容" } });
    const file = new File(["original"], "original.txt", { type: "text/plain" });
    Object.defineProperty(file, "path", { value: "D:/project/original.txt" });
    fireEvent.change(screen.getByTestId("development-new-task").querySelector<HTMLInputElement>('input[type="file"]')!, { target: { files: [file] } });
    await waitFor(() => expect(sendDocUpload).toHaveBeenCalledOnce());
    await screen.findByText("original.txt");
    fireEvent.click(screen.getByRole("button", { name: "创建并发送开发任务" }));
    await screen.findByRole("button", { name: "继续上次提交" });
    const originalRequest = useDevelopmentStore.getState().pendingNewTasks[project.id];
    const createOptions = api.createSession.mock.calls[0][1];
    expect(createOptions).toMatchObject({ requestId: originalRequest.requestId, model: "original-model", modelProvider: "original-provider", modelReasoningEffort: "high", title: "原任务内容" });
    expect(api.send).not.toHaveBeenCalled();
    const key = "mona.development.workbench.v1";
    const persisted = localStorage.getItem(key)!;
    view.unmount();
    useDevelopmentStore.setState(useDevelopmentStore.getInitialState(), true);
    localStorage.setItem(key, persisted);
    await act(async () => { await useDevelopmentStore.persist.rehydrate(); });
    render(workbench());
    const restored = await screen.findByRole("textbox", { name: "新开发任务输入" });
    fireEvent.change(restored, { target: { value: "修改后的新草稿" } });
    act(() => {
      const state = useDevelopmentStore.getState();
      state.setNewTaskDraft(project.id, { ...state.newTaskDrafts[project.id], model: "new-model", provider: "new-provider", documents: [{ name: "new.txt", path: "uploads/new.txt" }] });
    });
    expect(api.createSession).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "创建并发送开发任务" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "继续上次提交" }));
    await waitFor(() => expect(api.createSession).toHaveBeenCalledTimes(2));
    expect(api.createSession.mock.calls[1][1]).toEqual(createOptions);
    expect(await screen.findByText("请重新登录后继续")).toBeInTheDocument();
    expect(useDevelopmentStore.getState().pendingNewTasks[project.id].requestId).toBe(originalRequest.requestId);
    expect(api.send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "继续上次提交" }));
    await waitFor(() => expect(api.createSession).toHaveBeenCalledTimes(3));
    expect(api.createSession.mock.calls[2][1]).toEqual(createOptions);
    await waitFor(() => expect(api.send).toHaveBeenCalledWith("dev_created_2", originalRequest.sendRequestId, "原任务内容", undefined, originalRequest.attachments));
    expect(useDevelopmentStore.getState().newTaskDrafts[project.id]).toMatchObject({ draft: "修改后的新草稿", model: "new-model", provider: "new-provider", documents: [{ name: "new.txt", path: "uploads/new.txt" }] });
    expect(useDevelopmentStore.getState().pendingNewTasks[project.id]).toBeUndefined();
  });
  it("ignores an older failed creation attempt after the same request is continued", async () => {
    let rejectFirst!: (reason: Error) => void;
    let resolveSecond!: (value: DevSession) => void;
    api.createSession.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFirst = reject; }));
    api.createSession.mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve; }));
    const view = render(<DevelopmentView />);
    await screen.findByRole("textbox", { name: "开发任务输入" });
    fireEvent.click(screen.getByRole("button", { name: "在 测试项目 新建会话", exact: true }));
    fireEvent.change(await screen.findByRole("textbox", { name: "新开发任务输入" }), { target: { value: "保持原提交" } });
    fireEvent.click(screen.getByRole("button", { name: "创建并发送开发任务" }));
    await waitFor(() => expect(api.createSession).toHaveBeenCalledOnce());
    const requestId = useDevelopmentStore.getState().pendingNewTasks[project.id].requestId;
    view.unmount();
    render(<DevelopmentView />);
    fireEvent.click(await screen.findByRole("button", { name: "继续上次提交" }));
    await waitFor(() => expect(api.createSession).toHaveBeenCalledTimes(2));
    expect(api.createSession.mock.calls[1][1].requestId).toBe(requestId);
    await act(async () => rejectFirst(new DevelopmentApiError(422, "invalid_model", "旧尝试被拒绝")));
    expect(useDevelopmentStore.getState().pendingNewTasks[project.id].requestId).toBe(requestId);
    const created = session("dev_continued", "保持原提交");
    snapshots[created.id] = makeSnapshot(created);
    await act(async () => resolveSecond(created));
    await waitFor(() => expect(api.send).toHaveBeenCalledOnce());
    expect(api.send).toHaveBeenCalledWith(created.id, expect.any(String), "保持原提交");
    expect(useDevelopmentStore.getState().pendingNewTasks[project.id]).toBeUndefined();
  });
  it("preserves an existing session draft when a lost creation response is recovered", async () => {
    const created = session("dev_already_created", "原提交");
    api.createSession.mockRejectedValueOnce(new TypeError("response lost")).mockResolvedValueOnce(created);
    render(<DevelopmentView />);
    await screen.findByRole("textbox", { name: "开发任务输入" });
    fireEvent.click(screen.getByRole("button", { name: "在 测试项目 新建会话", exact: true }));
    fireEvent.change(await screen.findByRole("textbox", { name: "新开发任务输入" }), { target: { value: "原提交" } });
    fireEvent.click(screen.getByRole("button", { name: "创建并发送开发任务" }));
    await screen.findByRole("button", { name: "继续上次提交" });
    snapshots[created.id] = makeSnapshot(created);
    act(() => {
      useDevelopmentStore.getState().setDraft(created.id, "已在新会话输入的草稿");
      useDevelopmentStore.getState().setDocumentDraft(created.id, [{ name: "existing.txt", path: "uploads/existing.txt" }]);
    });
    fireEvent.click(screen.getByRole("button", { name: "继续上次提交" }));
    await waitFor(() => expect(api.send).toHaveBeenCalledWith(created.id, expect.any(String), "原提交"));
    expect(useDevelopmentStore.getState().drafts[created.id]).toBe("已在新会话输入的草稿");
    expect(useDevelopmentStore.getState().documentDrafts[created.id]).toEqual([{ name: "existing.txt", path: "uploads/existing.txt" }]);
  });
  it("does not replace another unconfirmed send in the recovered session", async () => {
    const created = session("dev_busy_created", "原提交");
    api.createSession.mockRejectedValueOnce(new TypeError("response lost")).mockResolvedValueOnce(created);
    render(<DevelopmentView />);
    await screen.findByRole("textbox", { name: "开发任务输入" });
    fireEvent.click(screen.getByRole("button", { name: "在 测试项目 新建会话", exact: true }));
    fireEvent.change(await screen.findByRole("textbox", { name: "新开发任务输入" }), { target: { value: "原提交" } });
    fireEvent.click(screen.getByRole("button", { name: "创建并发送开发任务" }));
    await screen.findByRole("button", { name: "继续上次提交" });
    const requestId = useDevelopmentStore.getState().pendingNewTasks[project.id].requestId;
    act(() => useDevelopmentStore.getState().setSend(created.id, { id: "request_other", content: "另一个发送", uncertain: true }));
    fireEvent.click(screen.getByRole("button", { name: "继续上次提交" }));
    expect(await screen.findByText(/此任务还有未确认的发送/)).toBeInTheDocument();
    expect(useDevelopmentStore.getState().sends[created.id]).toMatchObject({ id: "request_other", content: "另一个发送" });
    expect(useDevelopmentStore.getState().pendingNewTasks[project.id].requestId).toBe(requestId);
    expect(api.send).not.toHaveBeenCalled();
  });
  it("requires confirmed abandonment before starting a new task after a creation conflict", async () => {
    api.createSession.mockRejectedValueOnce(new DevelopmentApiError(409, "creation_request_conflict", "提交参数不一致"));
    api.cancelSessionCreation.mockResolvedValueOnce({ state: "rejected", sessionId: "dev_existing" });
    render(<DevelopmentView />);
    await screen.findByRole("textbox", { name: "开发任务输入" });
    fireEvent.click(screen.getByRole("button", { name: "在 测试项目 新建会话", exact: true }));
    const input = await screen.findByRole("textbox", { name: "新开发任务输入" });
    fireEvent.change(input, { target: { value: "保留当前输入" } });
    fireEvent.click(screen.getByRole("button", { name: "创建并发送开发任务" }));
    expect(await screen.findByText(/上次提交无法继续/)).toBeInTheDocument();
    const originalId = useDevelopmentStore.getState().pendingNewTasks[project.id].requestId;
    expect(screen.queryByRole("button", { name: "继续上次提交" })).toBeNull();
    expect(api.createSession).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "在 测试项目 新建会话", exact: true }));
    expect(screen.getByRole("textbox", { name: "新开发任务输入" })).toHaveValue("保留当前输入");
    expect(useDevelopmentStore.getState().pendingNewTasks[project.id].requestId).toBe(originalId);
    fireEvent.click(screen.getByRole("button", { name: "放弃本次提交" }));
    await waitFor(() => expect(useDevelopmentStore.getState().pendingNewTasks[project.id]).toBeUndefined());
    expect(api.cancelSessionCreation).toHaveBeenCalledWith(project.id, originalId, expect.any(Object), expect.any(String));
    expect(screen.getByText(/提交信息与已有记录不一致，已结束本地等待/)).toBeInTheDocument();
    expect(api.send).not.toHaveBeenCalled();
    expect(api.deleteSession).not.toHaveBeenCalled();
    expect(api.interrupt).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "创建并发送开发任务" }));
    await waitFor(() => expect(api.createSession).toHaveBeenCalledTimes(2));
    expect(api.createSession.mock.calls[1][1].requestId).not.toBe(originalId);
  });
  it("retries an unconfirmed abandonment after reload and preserves the current draft", async () => {
    api.createSession.mockRejectedValueOnce(new TypeError("create response lost"));
    api.cancelSessionCreation.mockRejectedValueOnce(new TypeError("cancel response lost"))
      .mockResolvedValueOnce({ state: "accepted", sessionId: "dev_existing" });
    const view = render(<DevelopmentView />);
    await screen.findByRole("textbox", { name: "开发任务输入" });
    fireEvent.click(screen.getByRole("button", { name: "在 测试项目 新建会话", exact: true }));
    const input = await screen.findByRole("textbox", { name: "新开发任务输入" });
    fireEvent.change(input, { target: { value: "原提交" } });
    fireEvent.click(screen.getByRole("button", { name: "创建并发送开发任务" }));
    await screen.findByRole("button", { name: "放弃本次提交" });
    const original = useDevelopmentStore.getState().pendingNewTasks[project.id];
    act(() => {
      const state = useDevelopmentStore.getState();
      state.setNewTaskDraft(project.id, { ...state.newTaskDrafts[project.id], draft: "修改后的草稿", documents: [{ name: "new.txt", path: "uploads/new.txt" }] });
    });
    fireEvent.click(screen.getByRole("button", { name: "放弃本次提交" }));
    expect(await screen.findByText(/暂未确认放弃/)).toBeInTheDocument();
    expect(useDevelopmentStore.getState().pendingNewTasks[project.id]).toMatchObject({ requestId: original.requestId, state: "cancelling" });
    expect(api.cancelSessionCreation).toHaveBeenCalledWith(project.id, original.requestId, original.options, original.sendRequestId);
    expect(api.send).not.toHaveBeenCalled();
    const key = "mona.development.workbench.v1";
    const persisted = localStorage.getItem(key)!;
    view.unmount();
    useDevelopmentStore.setState(useDevelopmentStore.getInitialState(), true);
    localStorage.setItem(key, persisted);
    await act(async () => { await useDevelopmentStore.persist.rehydrate(); });
    render(<DevelopmentView />);
    expect(await screen.findByRole("textbox", { name: "新开发任务输入" })).toHaveValue("修改后的草稿");
    expect(screen.queryByRole("button", { name: "继续上次提交" })).toBeNull();
    expect(api.cancelSessionCreation).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "继续放弃本次提交" }));
    expect(await screen.findByText(/原提交已被接收，任务状态可在原会话查看/)).toBeInTheDocument();
    expect(api.cancelSessionCreation).toHaveBeenCalledTimes(2);
    expect(api.cancelSessionCreation.mock.calls[1]).toEqual(api.cancelSessionCreation.mock.calls[0]);
    expect(useDevelopmentStore.getState().pendingNewTasks[project.id]).toBeUndefined();
    expect(useDevelopmentStore.getState().newTaskDrafts[project.id]).toMatchObject({ draft: "修改后的草稿", documents: [{ name: "new.txt", path: "uploads/new.txt" }] });
    expect(api.send).not.toHaveBeenCalled();
    expect(api.deleteSession).not.toHaveBeenCalled();
    expect(api.interrupt).not.toHaveBeenCalled();
  });
  it("keeps unconfirmed abandonment after another window persists stale workbench state", async () => {
    api.createSession.mockRejectedValueOnce(new TypeError("create response lost"));
    api.cancelSessionCreation.mockRejectedValueOnce(new TypeError("cancel request did not arrive"));
    const view = render(<DevelopmentView />);
    await screen.findByRole("textbox", { name: "开发任务输入" });
    fireEvent.click(screen.getByRole("button", { name: "在 测试项目 新建会话", exact: true }));
    fireEvent.change(await screen.findByRole("textbox", { name: "新开发任务输入" }), { target: { value: "跨窗口保留草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "创建并发送开发任务" }));
    await screen.findByRole("button", { name: "放弃本次提交" });
    const original = useDevelopmentStore.getState().pendingNewTasks[project.id];
    const key = "mona.development.workbench.v1";
    const stale = localStorage.getItem(key)!;
    fireEvent.click(screen.getByRole("button", { name: "放弃本次提交" }));
    expect(await screen.findByText(/暂未确认放弃/)).toBeInTheDocument();
    expect(useDevelopmentStore.getState().pendingNewTasks[project.id].state).toBe("cancelling");
    localStorage.setItem(key, stale);
    view.unmount();
    useDevelopmentStore.setState(useDevelopmentStore.getInitialState(), true);
    localStorage.setItem(key, stale);
    await act(async () => { await useDevelopmentStore.persist.rehydrate(); });
    render(<DevelopmentView />);
    expect(await screen.findByRole("button", { name: "继续放弃本次提交" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "继续上次提交" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "继续放弃本次提交" }));
    await waitFor(() => expect(api.cancelSessionCreation).toHaveBeenCalledTimes(2));
    expect(api.cancelSessionCreation.mock.calls[1]).toEqual([project.id, original.requestId, original.options, original.sendRequestId]);
    expect(api.send).not.toHaveBeenCalled();
  });
  it("keeps another project's cancellation outbox when the first is confirmed", async () => {
    const otherProject: DevProject = { id: "project_other", rootPath: "D:/other", displayName: "其他项目", lastOpenedAt: "" };
    api.projects.mockResolvedValue([project, otherProject]);
    api.createSession.mockRejectedValue(new TypeError("response lost"));
    api.cancelSessionCreation.mockRejectedValueOnce(new TypeError("first response lost"))
      .mockRejectedValueOnce(new TypeError("second response lost"));
    render(<DevelopmentView />);
    await screen.findByRole("textbox", { name: "开发任务输入" });
    fireEvent.click(screen.getByRole("button", { name: "在 测试项目 新建会话", exact: true }));
    fireEvent.change(await screen.findByRole("textbox", { name: "新开发任务输入" }), { target: { value: "项目一草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "创建并发送开发任务" }));
    fireEvent.click(await screen.findByRole("button", { name: "放弃本次提交" }));
    await screen.findByText(/暂未确认放弃/);
    const first = useDevelopmentStore.getState().pendingNewTasks[project.id];
    fireEvent.click(screen.getByRole("button", { name: "在 其他项目 新建会话", exact: true }));
    fireEvent.change(await screen.findByRole("textbox", { name: "新开发任务输入" }), { target: { value: "项目二草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "创建并发送开发任务" }));
    fireEvent.click(await screen.findByRole("button", { name: "放弃本次提交" }));
    await screen.findByText(/暂未确认放弃/);
    const second = useDevelopmentStore.getState().pendingNewTasks[otherProject.id];
    const prefix = "mona.development.creation-cancel.pending.v1:";
    const firstKey = `${prefix}${encodeURIComponent(project.id)}:${encodeURIComponent(first.requestId)}`;
    const secondKey = `${prefix}${encodeURIComponent(otherProject.id)}:${encodeURIComponent(second.requestId)}`;
    expect(localStorage.getItem(firstKey)).not.toBeNull();
    expect(localStorage.getItem(secondKey)).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "在 测试项目 新建会话", exact: true }));
    fireEvent.click(await screen.findByRole("button", { name: "继续放弃本次提交" }));
    await waitFor(() => expect(localStorage.getItem(firstKey)).toBeNull());
    expect(localStorage.getItem(secondKey)).not.toBeNull();
    expect(useDevelopmentStore.getState().pendingNewTasks[otherProject.id].requestId).toBe(second.requestId);
    expect(api.cancelSessionCreation.mock.calls[2]).toEqual([project.id, first.requestId, first.options, first.sendRequestId]);
    expect(api.send).not.toHaveBeenCalled();
  });
  it("resolves an older cancellation without overwriting another pending request in the same project", async () => {
    api.createSession.mockRejectedValueOnce(new TypeError("response lost"));
    api.cancelSessionCreation.mockRejectedValueOnce(new TypeError("cancel response lost"));
    render(<DevelopmentView />);
    await screen.findByRole("textbox", { name: "开发任务输入" });
    fireEvent.click(screen.getByRole("button", { name: "在 测试项目 新建会话", exact: true }));
    fireEvent.change(await screen.findByRole("textbox", { name: "新开发任务输入" }), { target: { value: "第一个提交" } });
    fireEvent.click(screen.getByRole("button", { name: "创建并发送开发任务" }));
    fireEvent.click(await screen.findByRole("button", { name: "放弃本次提交" }));
    await screen.findByText(/暂未确认放弃/);
    const first = useDevelopmentStore.getState().pendingNewTasks[project.id];
    const other = { ...first, requestId: "request_other", sendRequestId: "request_other_send", content: "第二个提交",
      options: { ...first.options, title: "第二个提交" }, draft: { ...first.draft, draft: "第二个草稿" }, state: "pending" as const };
    act(() => {
      const state = useDevelopmentStore.getState();
      state.setPendingNewTask(project.id, other);
      state.setNewTaskDraft(project.id, other.draft);
    });
    expect(screen.getByRole("textbox", { name: "新开发任务输入" })).toHaveValue("第二个草稿");
    fireEvent.click(screen.getByRole("button", { name: "继续放弃本次提交" }));
    await waitFor(() => expect(api.cancelSessionCreation).toHaveBeenCalledTimes(2));
    expect(api.cancelSessionCreation.mock.calls[1]).toEqual([project.id, first.requestId, first.options, first.sendRequestId]);
    await waitFor(() => expect(screen.getByRole("button", { name: "继续上次提交" })).toBeInTheDocument());
    expect(useDevelopmentStore.getState().pendingNewTasks[project.id]).toMatchObject({ requestId: other.requestId, content: "第二个提交", state: "pending" });
    expect(useDevelopmentStore.getState().newTaskDrafts[project.id].draft).toBe("第二个草稿");
    expect(api.send).not.toHaveBeenCalled();
  });
  it("preserves another window's newer pending request when confirming an older cancellation", async () => {
    api.createSession.mockRejectedValueOnce(new TypeError("response lost"));
    api.cancelSessionCreation.mockRejectedValueOnce(new TypeError("cancel response lost"));
    render(<DevelopmentView />);
    await screen.findByRole("textbox", { name: "开发任务输入" });
    fireEvent.click(screen.getByRole("button", { name: "在 测试项目 新建会话", exact: true }));
    fireEvent.change(await screen.findByRole("textbox", { name: "新开发任务输入" }), { target: { value: "旧提交" } });
    fireEvent.click(screen.getByRole("button", { name: "创建并发送开发任务" }));
    fireEvent.click(await screen.findByRole("button", { name: "放弃本次提交" }));
    await screen.findByText(/暂未确认放弃/);
    const first = useDevelopmentStore.getState().pendingNewTasks[project.id];
    const other = { ...first, requestId: "request_new_window", sendRequestId: "request_new_window_send", content: "另一提交",
      options: { ...first.options, title: "另一提交" }, draft: { ...first.draft, draft: "另一窗口草稿" }, state: "pending" };
    const key = "mona.development.workbench.v1";
    const saved = JSON.parse(localStorage.getItem(key)!);
    saved.state.pendingNewTasks[project.id] = other;
    saved.state.newTaskDrafts[project.id] = other.draft;
    localStorage.setItem(key, JSON.stringify(saved));
    fireEvent.change(screen.getByRole("textbox", { name: "新开发任务输入" }), { target: { value: "不能覆盖另一提交" } });
    expect(screen.getByText("此项目在其他窗口有待确认提交，请先在原窗口处理。")).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(key)!).state.pendingNewTasks[project.id].requestId).toBe(other.requestId);
    fireEvent.click(screen.getByRole("button", { name: "继续放弃本次提交" }));
    await waitFor(() => expect(api.cancelSessionCreation).toHaveBeenCalledTimes(2));
    await screen.findByText("上次提交已放弃，当前草稿已保留。");
    const persisted = JSON.parse(localStorage.getItem(key)!);
    expect(persisted.state.pendingNewTasks[project.id].requestId).toBe(other.requestId);
    expect(persisted.state.newTaskDrafts[project.id].draft).toBe("另一窗口草稿");
    expect(api.cancelSessionCreation.mock.calls[1]).toEqual([project.id, first.requestId, first.options, first.sendRequestId]);
    expect(api.send).not.toHaveBeenCalled();
  });
  it("keeps the current window's edited draft when another window starts abandonment", async () => {
    api.createSession.mockRejectedValueOnce(new TypeError("response lost"));
    api.cancelSessionCreation.mockRejectedValueOnce(new TypeError("cancel response lost"));
    const view = render(<DevelopmentView />);
    await screen.findByRole("textbox", { name: "开发任务输入" });
    fireEvent.click(screen.getByRole("button", { name: "在 测试项目 新建会话", exact: true }));
    const input = await screen.findByRole("textbox", { name: "新开发任务输入" });
    fireEvent.change(input, { target: { value: "原提交" } });
    fireEvent.click(screen.getByRole("button", { name: "创建并发送开发任务" }));
    await screen.findByRole("button", { name: "放弃本次提交" });
    fireEvent.change(input, { target: { value: "本窗口的新草稿" } });
    const pending = useDevelopmentStore.getState().pendingNewTasks[project.id];
    const key = `mona.development.creation-cancel.pending.v1:${encodeURIComponent(project.id)}:${encodeURIComponent(pending.requestId)}`;
    const remote = JSON.stringify({ projectId: project.id, pending: { ...pending, state: "cancelling" }, draft: { ...pending.draft, draft: "另一窗口的草稿" } });
    localStorage.setItem(key, remote);
    await act(async () => window.dispatchEvent(new StorageEvent("storage", { key, newValue: remote })));
    expect(screen.getByRole("textbox", { name: "新开发任务输入" })).toHaveValue("本窗口的新草稿");
    fireEvent.click(screen.getByRole("button", { name: "继续放弃本次提交" }));
    await screen.findByText(/暂未确认放弃/);
    const rootKey = "mona.development.workbench.v1";
    const persisted = localStorage.getItem(rootKey)!;
    view.unmount();
    useDevelopmentStore.setState(useDevelopmentStore.getInitialState(), true);
    localStorage.setItem(rootKey, persisted);
    await act(async () => { await useDevelopmentStore.persist.rehydrate(); });
    render(<DevelopmentView />);
    expect(await screen.findByRole("textbox", { name: "新开发任务输入" })).toHaveValue("本窗口的新草稿");
    fireEvent.click(screen.getByRole("button", { name: "继续放弃本次提交" }));
    await screen.findByText("上次提交已放弃，当前草稿已保留。");
    expect(useDevelopmentStore.getState().newTaskDrafts[project.id].draft).toBe("本窗口的新草稿");
    expect(api.send).not.toHaveBeenCalled();
  });
  it("does not release an abandonment rejected for conflicting message identity", async () => {
    api.createSession.mockRejectedValueOnce(new TypeError("response lost"));
    api.cancelSessionCreation.mockRejectedValueOnce(new DevelopmentApiError(409, "creation_request_conflict", "消息标识不一致"));
    render(<DevelopmentView />);
    await screen.findByRole("textbox", { name: "开发任务输入" });
    fireEvent.click(screen.getByRole("button", { name: "在 测试项目 新建会话", exact: true }));
    fireEvent.change(await screen.findByRole("textbox", { name: "新开发任务输入" }), { target: { value: "保留草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "创建并发送开发任务" }));
    await screen.findByRole("button", { name: "放弃本次提交" });
    const original = useDevelopmentStore.getState().pendingNewTasks[project.id];
    fireEvent.click(screen.getByRole("button", { name: "放弃本次提交" }));
    expect(await screen.findByText(/暂未确认放弃/)).toBeInTheDocument();
    expect(useDevelopmentStore.getState().pendingNewTasks[project.id]).toMatchObject({ requestId: original.requestId, state: "cancelling" });
    fireEvent.click(screen.getByRole("button", { name: "在 测试项目 新建会话", exact: true }));
    expect(useDevelopmentStore.getState().pendingNewTasks[project.id].requestId).toBe(original.requestId);
    expect(screen.getByRole("textbox", { name: "新开发任务输入" })).toHaveValue("保留草稿");
    expect(api.createSession).toHaveBeenCalledTimes(1);
    expect(api.send).not.toHaveBeenCalled();
  });
  it("does not request abandonment until its local outbox is saved", async () => {
    api.createSession.mockRejectedValueOnce(new TypeError("response lost"));
    render(<DevelopmentView />);
    await screen.findByRole("textbox", { name: "开发任务输入" });
    fireEvent.click(screen.getByRole("button", { name: "在 测试项目 新建会话", exact: true }));
    fireEvent.change(await screen.findByRole("textbox", { name: "新开发任务输入" }), { target: { value: "保留草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "创建并发送开发任务" }));
    await screen.findByRole("button", { name: "放弃本次提交" });
    const original = localStorage.setItem.bind(localStorage);
    const write = vi.spyOn(localStorage, "setItem").mockImplementation((key, value) => {
      if (key.startsWith("mona.development.creation-cancel.pending.v1:")) throw new Error("storage unavailable");
      return original(key, value);
    });
    fireEvent.click(screen.getByRole("button", { name: "放弃本次提交" }));
    expect(await screen.findByText("无法保存放弃状态，请检查本地存储后重试。")).toBeInTheDocument();
    expect(api.cancelSessionCreation).not.toHaveBeenCalled();
    expect(api.send).not.toHaveBeenCalled();
    write.mockRestore();
    fireEvent.click(screen.getByRole("button", { name: "放弃本次提交" }));
    await waitFor(() => expect(api.cancelSessionCreation).toHaveBeenCalledOnce());
  });
  it("does not dispatch a late creation response while abandonment is pending", async () => {
    let resolveCreate!: (value: DevSession) => void;
    let resolveCancel!: (value: { state: "cancelled"; sessionId: string | null }) => void;
    api.createSession.mockImplementationOnce(() => new Promise((resolve) => { resolveCreate = resolve; }));
    api.cancelSessionCreation.mockImplementationOnce(() => new Promise((resolve) => { resolveCancel = resolve; }));
    const view = render(<DevelopmentView />);
    await screen.findByRole("textbox", { name: "开发任务输入" });
    fireEvent.click(screen.getByRole("button", { name: "在 测试项目 新建会话", exact: true }));
    fireEvent.change(await screen.findByRole("textbox", { name: "新开发任务输入" }), { target: { value: "不要迟到发送" } });
    fireEvent.click(screen.getByRole("button", { name: "创建并发送开发任务" }));
    await waitFor(() => expect(api.createSession).toHaveBeenCalledOnce());
    const requestId = useDevelopmentStore.getState().pendingNewTasks[project.id].requestId;
    view.unmount();
    render(<DevelopmentView />);
    fireEvent.click(await screen.findByRole("button", { name: "放弃本次提交" }));
    await waitFor(() => expect(api.cancelSessionCreation).toHaveBeenCalledOnce());
    expect(useDevelopmentStore.getState().pendingNewTasks[project.id]).toMatchObject({ requestId, state: "cancelling" });
    const created = session("dev_late_create", "不要迟到发送");
    snapshots[created.id] = makeSnapshot(created);
    await act(async () => resolveCreate(created));
    expect(api.send).not.toHaveBeenCalled();
    await act(async () => resolveCancel({ state: "cancelled", sessionId: created.id }));
    expect(await screen.findByText("上次提交已放弃，当前草稿已保留。")).toBeInTheDocument();
    expect(useDevelopmentStore.getState().newTaskDrafts[project.id].draft).toBe("不要迟到发送");
    expect(api.send).not.toHaveBeenCalled();
    expect(api.deleteSession).not.toHaveBeenCalled();
  });
  it("observes cancellation from another window before dispatching a late creation response", async () => {
    let resolveCreate!: (value: DevSession) => void;
    api.createSession.mockImplementationOnce(() => new Promise((resolve) => { resolveCreate = resolve; }));
    render(<DevelopmentView />);
    await screen.findByRole("textbox", { name: "开发任务输入" });
    fireEvent.click(screen.getByRole("button", { name: "在 测试项目 新建会话", exact: true }));
    fireEvent.change(await screen.findByRole("textbox", { name: "新开发任务输入" }), { target: { value: "跨窗口取消" } });
    fireEvent.click(screen.getByRole("button", { name: "创建并发送开发任务" }));
    await waitFor(() => expect(api.createSession).toHaveBeenCalledOnce());
    const key = "mona.development.workbench.v1";
    const saved = JSON.parse(localStorage.getItem(key)!);
    saved.state.pendingNewTasks[project.id].state = "cancelling";
    const remote = JSON.stringify(saved);
    localStorage.setItem(key, remote);
    await act(async () => window.dispatchEvent(new StorageEvent("storage", { key, newValue: remote })));
    expect(screen.getByText("正在放弃上次提交…")).toBeInTheDocument();
    const created = session("dev_other_window", "跨窗口取消");
    snapshots[created.id] = makeSnapshot(created);
    await act(async () => resolveCreate(created));
    expect(api.send).not.toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: "继续放弃本次提交" })).toBeInTheDocument();
  });
  it("accepts the server cancellation tombstone for a late creation retry", async () => {
    api.createSession.mockRejectedValueOnce(new TypeError("response lost"))
      .mockRejectedValueOnce(new DevelopmentApiError(409, "creation_request_cancelled", "提交已放弃"));
    render(<DevelopmentView />);
    await screen.findByRole("textbox", { name: "开发任务输入" });
    fireEvent.click(screen.getByRole("button", { name: "在 测试项目 新建会话", exact: true }));
    fireEvent.change(await screen.findByRole("textbox", { name: "新开发任务输入" }), { target: { value: "保留原稿" } });
    fireEvent.click(screen.getByRole("button", { name: "创建并发送开发任务" }));
    fireEvent.click(await screen.findByRole("button", { name: "继续上次提交" }));
    expect(await screen.findByText(/上次提交不会继续发送/)).toBeInTheDocument();
    expect(useDevelopmentStore.getState().pendingNewTasks[project.id]).toBeUndefined();
    expect(useDevelopmentStore.getState().newTaskDrafts[project.id].draft).toBe("保留原稿");
    expect(api.send).not.toHaveBeenCalled();
  });
  it("settles a pending abandonment when a late creation request sees the tombstone", async () => {
    let rejectCreate!: (reason: Error) => void;
    let resolveCancel!: (value: { state: "cancelled"; sessionId: string | null }) => void;
    api.createSession.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectCreate = reject; }));
    api.cancelSessionCreation.mockImplementationOnce(() => new Promise((resolve) => { resolveCancel = resolve; }));
    const view = render(<DevelopmentView />);
    await screen.findByRole("textbox", { name: "开发任务输入" });
    fireEvent.click(screen.getByRole("button", { name: "在 测试项目 新建会话", exact: true }));
    fireEvent.change(await screen.findByRole("textbox", { name: "新开发任务输入" }), { target: { value: "原提交" } });
    fireEvent.click(screen.getByRole("button", { name: "创建并发送开发任务" }));
    await waitFor(() => expect(api.createSession).toHaveBeenCalledOnce());
    view.unmount();
    render(<DevelopmentView />);
    fireEvent.click(await screen.findByRole("button", { name: "放弃本次提交" }));
    await waitFor(() => expect(api.cancelSessionCreation).toHaveBeenCalledOnce());
    await act(async () => rejectCreate(new DevelopmentApiError(409, "creation_request_cancelled", "提交已放弃")));
    expect(useDevelopmentStore.getState().pendingNewTasks[project.id]).toBeUndefined();
    expect(api.send).not.toHaveBeenCalled();
    await act(async () => resolveCancel({ state: "cancelled", sessionId: "dev_created" }));
    expect(await screen.findByText("上次提交已放弃，当前草稿已保留。")).toBeInTheDocument();
    expect(api.send).not.toHaveBeenCalled();
  });
  it("does not create a task until its stable request can be saved", async () => {
    render(<DevelopmentView />);
    await screen.findByRole("textbox", { name: "开发任务输入" });
    fireEvent.click(screen.getByRole("button", { name: "在 测试项目 新建会话", exact: true }));
    fireEvent.change(await screen.findByRole("textbox", { name: "新开发任务输入" }), { target: { value: "需要可靠保存" } });
    const storage = useDevelopmentStore.persist.getOptions().storage!;
    const write = vi.spyOn(storage, "setItem").mockImplementation(() => { throw new Error("storage unavailable"); });
    fireEvent.click(screen.getByRole("button", { name: "创建并发送开发任务" }));
    expect(await screen.findByText("无法保存提交信息，请检查本地存储后重试。")).toBeInTheDocument();
    expect(api.createSession).not.toHaveBeenCalled();
    expect(api.send).not.toHaveBeenCalled();
    write.mockRestore();
    fireEvent.click(screen.getByRole("button", { name: "继续上次提交" }));
    await waitFor(() => expect(api.createSession).toHaveBeenCalledOnce());
  });
  it("carries the exact channel, model and effort into the deferred new conversation", async () => {
    snapshots.dev_first.session = { ...first, model: "same-model", modelProvider: "custom-relay", modelReasoningEffort: "high" };
    render(<DevelopmentView />); await screen.findByRole("textbox", { name: "开发任务输入" });
    fireEvent.click(screen.getByRole("button", { name: "在 测试项目 新建会话", exact: true }));
    expect(api.createSession).not.toHaveBeenCalled();
    fireEvent.change(await screen.findByRole("textbox", { name: "新开发任务输入" }), { target: { value: "沿用当前模型" } });
    fireEvent.click(screen.getByRole("button", { name: "创建并发送开发任务" }));
    await waitFor(() => expect(api.createSession).toHaveBeenCalledWith(project.id, expect.objectContaining({
      executor: "mona", model: "same-model", modelProvider: "custom-relay", modelReasoningEffort: "high",
      title: "沿用当前模型",
      requestId: expect.stringMatching(/^request_/),
    })));
    expect(api.selectModelSource).not.toHaveBeenCalled();
  });
  it("deduplicates first send and does not steal focus after the user switches sessions", async () => {
    let finish!: (value: DevSession) => void;
    api.createSession.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    render(<DevelopmentView />); await screen.findByRole("textbox", { name: "开发任务输入" });
    fireEvent.click(screen.getByRole("button", { name: "在 测试项目 新建会话", exact: true }));
    fireEvent.change(await screen.findByRole("textbox", { name: "新开发任务输入" }), { target: { value: "后台创建" } });
    const send = screen.getByRole("button", { name: "创建并发送开发任务" });
    fireEvent.click(send); fireEvent.click(send);
    expect(api.createSession).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByRole("textbox", { name: "新开发任务输入" }), { target: { value: "创建期间的新草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "打开开发任务：检查接口", exact: true }));
    await act(async () => { finish(session("dev_late", "新开发任务")); });
    await waitFor(() => expect(api.send).toHaveBeenCalledWith("dev_late", expect.any(String), "后台创建"));
    expect(useDevelopmentStore.getState().views[project.id].sessionId).toBe(second.id);
    expect(useDevelopmentStore.getState().newTaskDrafts[project.id].draft).toBe("创建期间的新草稿");
  });
  it("keeps the new-task input when creation fails and does not retry automatically", async () => {
    api.createSession.mockRejectedValueOnce(new DevelopmentApiError(422, "invalid_model", "新建请求失败"));
    render(<DevelopmentView />); await screen.findByRole("textbox", { name: "开发任务输入" });
    fireEvent.click(screen.getByRole("button", { name: "在 测试项目 新建会话", exact: true }));
    const draft = await screen.findByRole("textbox", { name: "新开发任务输入" });
    fireEvent.change(draft, { target: { value: "保留输入" } });
    fireEvent.click(screen.getByRole("button", { name: "创建并发送开发任务" }));
    await screen.findByText("新建请求失败");
    expect(useDevelopmentStore.getState().views[project.id].sessionId).toBe(first.id);
    expect(screen.getByRole("textbox", { name: "新开发任务输入" })).toHaveValue("保留输入");
    expect(api.createSession).toHaveBeenCalledTimes(1);
    expect(api.send).not.toHaveBeenCalled();
  });
  it.each([
    ["codex", "OpenAI", null], ["claude", "Anthropic", null], ["codebuddy", "WorkBuddy", null], ["mona", "内部渠道", "custom-relay"],
  ] as const)("selecting a %s model is the only action needed to route execution", async (engine, label, provider) => {
    api.capabilities.mockResolvedValue({ executors: [
      { id: "mona", name: "Mona Coding", available: true, reason: "", models: [{ id: "", label: "默认模型" },
        { id: "same-model", label: "同名模型", provider: "custom-relay", providerLabel: "内部渠道", preset: false }] },
      ...(["codex", "claude", "codebuddy"] as const).map((id) => ({ id, name: id, available: true, reason: "", models: [{ id: "same-model", label: "同名模型" }] })),
    ] });
    render(<DevelopmentView />); await screen.findByRole("textbox", { name: "开发任务输入" });
    fireEvent.pointerDown(screen.getByRole("button", { name: "默认模型", exact: true }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: `${label} · 同名模型`, exact: true }));
    await waitFor(() => expect(useDevelopmentStore.getState().snapshots[first.id].session).toMatchObject({ executor: engine, model: "same-model", modelProvider: provider }));
    expect(api.selectModelSource).toHaveBeenCalledTimes(1);
    expect(api.selectModelSource).toHaveBeenCalledWith(first, { executor: engine, model: "same-model", provider, effort: null });
    expect(api.switchExecutor).not.toHaveBeenCalled();
    expect(api.send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "在 测试项目 新建会话", exact: true }));
    expect(api.createSession).not.toHaveBeenCalled();
    fireEvent.change(await screen.findByRole("textbox", { name: "新开发任务输入" }), { target: { value: "使用所选模型创建任务" } });
    fireEvent.click(screen.getByRole("button", { name: "创建并发送开发任务" }));
    await waitFor(() => expect(api.createSession).toHaveBeenCalledWith(project.id, expect.objectContaining({ executor: engine, model: "same-model", modelProvider: provider, modelReasoningEffort: null, title: "使用所选模型创建任务", requestId: expect.stringMatching(/^request_/) })));
  });
  it("queues active Code input using the shared shortcut without a mode selector", async () => {
    snapshots.dev_first.runs = [{ id: "run_active", sessionId: first.id, executor: "mona", status: "running", revision: 1, createdAt: "2026-09-26T01:00:00Z" }];
    render(<DevelopmentView />);
    const input = await screen.findByRole("textbox", { name: "开发任务输入" });
    expect(screen.queryByRole("button", { name: "运行中消息处理方式" })).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: "保留已有实现，增加边界校验" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(api.send).toHaveBeenCalledWith(first.id, expect.any(String), "保留已有实现，增加边界校验", "follow_up"));
    expect(screen.getByRole("button", { name: "中断当前轮次" })).toBeInTheDocument();
    expect(api.interrupt).not.toHaveBeenCalled(); expect(api.createSession).not.toHaveBeenCalled();
    expect(api.switchExecutor).not.toHaveBeenCalled();
  });

  it.each(["append", "edit", "delete"] as const)("uses the shared queue %s action with the original input identity", async (action) => {
    snapshots.dev_first.runs = [{ id: "run_active", sessionId: first.id, executor: "mona", status: "running", revision: 1, createdAt: "" }];
    snapshots.dev_first.pendingInputs = [{ id: "queued_1", messageId: "message_queued", runId: "run_active", state: "pending", revision: 0, intent: "follow_up" }];
    snapshots.dev_first.messages = [{ id: "message_queued", role: "user", content: "检查新需求", queued: true, toolCalls: [], truncated: false }];
    snapshots.dev_first.messageCount = 1;
    api.cancelInput.mockImplementation(async () => { snapshots.dev_first.pendingInputs = []; });
    render(<DevelopmentView />); await screen.findByRole("textbox", { name: "开发任务输入" });
    if (action === "edit") {
      fireEvent.pointerDown(screen.getByRole("button", { name: /^(更多操作|More actions)$/ }), { button: 0, ctrlKey: false });
      fireEvent.click(await screen.findByRole("menuitem", { name: i18n.t("thread.composer.pendingQueue.editAria") }));
    } else fireEvent.click(screen.getByRole("button", { name: i18n.t(`thread.composer.pendingQueue.${action}Aria`) }));
    if (action === "append") {
      await waitFor(() => expect(api.guideInput).toHaveBeenCalledWith(first.id, "queued_1", 0, "run_active"));
      expect(api.cancelInput).not.toHaveBeenCalled();
      expect(api.send).not.toHaveBeenCalled();
      expect(snapshots.dev_first.pendingInputs[0]).toMatchObject({ id: "queued_1", messageId: "message_queued", intent: "steering" });
    } else {
      await waitFor(() => expect(api.cancelInput).toHaveBeenCalledWith(first.id, "queued_1"));
      expect(api.send).not.toHaveBeenCalled();
      if (action === "edit") await waitFor(() => expect(screen.getByRole("textbox", { name: "开发任务输入" })).toHaveValue("检查新需求"));
    }
  });

  it("keeps a queued message when cancelling it fails and does not duplicate its execution", async () => {
    snapshots.dev_first.pendingInputs = [{ id: "queued_1", messageId: "message_queued", runId: "run_active", state: "pending", revision: 0, intent: "follow_up" }];
    snapshots.dev_first.messages = [{ id: "message_queued", role: "user", content: "保留排队内容", queued: true, toolCalls: [], truncated: false }];
    snapshots.dev_first.messageCount = 1;
    api.cancelInput.mockRejectedValueOnce(new Error("消息已开始执行"));
    render(<DevelopmentView />); await screen.findByRole("textbox", { name: "开发任务输入" });
    fireEvent.click(screen.getByRole("button", { name: i18n.t("thread.composer.pendingQueue.deleteAria") }));
    await waitFor(() => expect(api.cancelInput).toHaveBeenCalledTimes(1));
    expect(within(screen.getByLabelText("开发会话记录")).queryByText("消息已开始执行")).toBeNull();
    const failure = await screen.findByRole("dialog", { name: "操作未完成" });
    expect(failure).toHaveTextContent("消息已开始执行");
    fireEvent.click(within(failure).getByRole("button", { name: "知道了" }));
    expect(api.send).not.toHaveBeenCalled();
    expect(within(screen.getByRole("list", { name: i18n.t("thread.composer.pendingQueue.empty") })).getByText("保留排队内容")).toBeInTheDocument();
  });
  it("does not expose the Code steering contract on a native CLI session", async () => {
    snapshots.dev_first.session = { ...first, executor: "codex" };
    snapshots.dev_first.runs = [{ id: "run_native", sessionId: first.id, executor: "codex", status: "running", revision: 1, createdAt: "2026-09-26T01:00:00Z" }];
    api.capabilities.mockResolvedValue({ executors: [{ id: "codex", name: "Codex", available: true, reason: "", models: [] }] });
    render(<DevelopmentView />);
    fireEvent.change(await screen.findByRole("textbox", { name: "开发任务输入" }), { target: { value: "稍后处理" } });
    expect(screen.queryByRole("button", { name: "运行中消息处理方式" })).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "开发任务输入" }), { key: "Enter" });
    await waitFor(() => expect(api.send).toHaveBeenCalledWith(first.id, expect.any(String), "稍后处理"));
    expect(screen.queryByRole("button", { name: i18n.t("thread.composer.pendingQueue.appendAria") })).not.toBeInTheDocument();
  });
  it("keeps unavailable routes disabled inside the single model selector", async () => {
    api.capabilities.mockResolvedValue({ executors: [
      { id: "mona", name: "Mona Coding", available: true, reason: "", models: [{ id: "", label: "默认模型" }] },
      { id: "codex", name: "Codex", available: false, reason: "尚未连接", models: [{ id: "native-model", label: "原生模型" }] },
    ] });
    render(<DevelopmentView />); await screen.findByRole("textbox", { name: "开发任务输入" });
    fireEvent.pointerDown(screen.getByRole("button", { name: "默认模型", exact: true }), { button: 0, ctrlKey: false });
    const choice = await screen.findByRole("menuitem", { name: "OpenAI · 原生模型" });
    expect(choice).toHaveAttribute("data-disabled");
    fireEvent.click(choice);
    expect(api.selectModelSource).not.toHaveBeenCalled(); expect(api.switchExecutor).not.toHaveBeenCalled();
  });
});
