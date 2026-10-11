import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DevProject, DevSession, DevSnapshot } from "@/lib/development-api";
import { useDevelopmentStore } from "./store";
import { DevelopmentPane } from "./DevelopmentPane";

const api = vi.hoisted(() => ({ send: vi.fn() }));
const live = vi.hoisted(() => ({ snapshot: null as DevSnapshot | null }));
vi.mock("@/lib/development-api", async (original) => ({ ...(await original<typeof import("@/lib/development-api")>()), developmentApi: api }));
vi.mock("./useDevelopmentSession", () => ({ useDevelopmentSession: () => live.snapshot, refreshDevelopmentSession: vi.fn() }));
// The transcript renderer is being migrated separately; exercise the real pane,
// header menu and dialogs without depending on its unfinished content modules.
vi.mock("./DevelopmentTranscript", () => ({ DevelopmentTranscript: () => <article>会话正文</article> }));
vi.mock("./DevelopmentOverview", () => ({ DevelopmentOverview: () => <p>摘要内容</p> }));
vi.mock("@/components/thread/ThreadComposer", () => ({ ThreadComposer: ({ onSend }: { onSend: (text: string) => void }) => <button onClick={() => onSend("继续任务")}>发送测试消息</button> }));

const project: DevProject = { id: "project", displayName: "项目", rootPath: "D:/project", lastOpenedAt: "" };
const session: DevSession = { id: "session", projectId: project.id, title: "任务", executor: "codex", model: null, readonly: false, parentSessionId: null, pinned: false, archived: false, revision: 1, updatedAt: "" };
const executors = [{ id: "codex" as const, name: "Codex", available: true, reason: "", models: [] }];
const show = () => render(<DevelopmentPane project={project} session={session} executors={executors} />);

beforeEach(() => {
  vi.clearAllMocks();
  useDevelopmentStore.setState(useDevelopmentStore.getInitialState(), true);
  live.snapshot = { session, messages: [], runs: [], events: [], eventCursor: 0, messageCount: 0, before: null, pendingInputs: [], live: null,
    nativeBinding: { id: "binding", turnHistory: true, replacesBindingId: "old", replacementReason: "history_missing" } };
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it.each([false, true])("returns to the latest message from above the composer without a header button (compact=%s)", (compact) => {
  live.snapshot!.messages = [{ id: "input", role: "user", content: "继续任务", toolCalls: [], truncated: false, queued: false }];
  live.snapshot!.messageCount = 1;
  live.snapshot!.runs = [{ id: "run", sessionId: session.id, executor: "codex", status: compact ? "succeeded" : "running", revision: 1, createdAt: "2026-10-10T05:00:00Z" }];
  render(<DevelopmentPane project={project} session={session} executors={executors} compact={compact} />);
  const conversation = screen.getByLabelText("开发会话记录");
  Object.defineProperties(conversation, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 200 } });
  expect(screen.queryByRole("button", { name: "返回最新消息" })).toBeNull();
  conversation.scrollTop = 600;
  fireEvent.wheel(conversation, { deltaY: -40 });
  const button = screen.getByRole("button", { name: "返回最新消息" });
  expect(button.closest("footer")).toBe(screen.getByRole("button", { name: "发送测试消息" }).closest("footer"));
  expect(button.closest("header")).toBeNull();
  fireEvent.click(button);
  expect(conversation.scrollTop).toBe(1000);
  expect(screen.queryByRole("button", { name: "返回最新消息" })).toBeNull();
});

it("switches the summary between a docked column and an overlay without remounting the conversation", async () => {
  const observers: { target?: Element; callback: ResizeObserverCallback }[] = [];
  vi.stubGlobal("ResizeObserver", class {
    record: (typeof observers)[number];
    constructor(callback: ResizeObserverCallback) { this.record = { callback }; observers.push(this.record); }
    observe(target: Element) { this.record.target = target; }
    unobserve() {}
    disconnect() {}
  });
  show();
  const pane = screen.getByTestId("development-pane");
  let width = 1200;
  Object.defineProperty(pane, "clientWidth", { configurable: true, get: () => width });
  const observer = observers.find((item) => item.target === pane)!;
  act(() => observer.callback([], {} as ResizeObserver));
  const conversation = screen.getByLabelText("开发会话记录");
  const body = screen.getByText("会话正文");
  conversation.scrollTop = 80;
  fireEvent.click(screen.getByRole("button", { name: "任务概览" }));
  await screen.findByText("摘要内容");
  const summary = screen.getByRole("complementary", { name: "任务摘要" });
  expect(summary.style.width).toBe("300px");
  fireEvent.pointerDown(body);
  expect(screen.getByRole("region", { name: "任务概览浮卡" })).toBeInTheDocument();
  width = 900;
  act(() => observer.callback([], {} as ResizeObserver));
  expect(summary.style.width).toBe("300px");
  expect(screen.getByLabelText("开发会话记录")).toBe(conversation);
  expect(screen.getByText("会话正文")).toBe(body);
  expect(conversation.scrollTop).toBe(80);
  fireEvent.pointerDown(body);
  expect(screen.queryByRole("region", { name: "任务概览浮卡" })).toBeNull();
  expect(screen.queryByRole("complementary", { name: "任务摘要" })).toBeNull();
});

it("does not expose connection notices or a manual reconnect action", async () => {
  show();
  const conversation = screen.getByLabelText("开发会话记录");
  expect(conversation).not.toHaveTextContent("原执行历史无法恢复");
  expect(within(conversation).queryByRole("button", { name: "重新连接执行者" })).toBeNull();
  fireEvent.pointerDown(screen.getByRole("button", { name: "会话更多操作" }), { button: 0, ctrlKey: false });
  expect(await screen.findByRole("menu")).not.toHaveTextContent("重新连接执行者");
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("automatically shows a send error in a dismissible dialog", async () => {
  api.send.mockRejectedValueOnce(new Error("发送测试失败"));
  show();
  fireEvent.click(screen.getByRole("button", { name: "发送测试消息" }));
  const dialog = await screen.findByRole("dialog", { name: "操作未完成" });
  expect(dialog).toHaveTextContent("发送测试失败");
  expect(screen.getByLabelText("开发会话记录")).not.toHaveTextContent("发送测试失败");
  fireEvent.click(within(dialog).getByRole("button", { name: "知道了" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "操作未完成" })).toBeNull());
});

it("does not offer a reconnect action in a side conversation", () => {
  render(<DevelopmentPane project={project} session={session} executors={executors} compact />);
  expect(screen.queryByRole("button", { name: "重新连接执行者" })).toBeNull();
  expect(screen.queryByRole("button", { name: "任务状态与操作" })).toBeNull();
  expect(screen.getByLabelText("开发会话记录")).not.toHaveTextContent("原执行历史无法恢复");
});

it("keeps the existing compact status dialog available for an unknown task", async () => {
  live.snapshot!.runs = [{ id: "unknown-run", sessionId: session.id, executor: "codex", status: "unknown", revision: 1, createdAt: "" }];
  render(<DevelopmentPane project={project} session={session} executors={executors} compact />);
  fireEvent.click(screen.getByRole("button", { name: "任务状态与操作" }));
  const status = within(await screen.findByRole("dialog", { name: "任务状态与操作" }))
    .getByRole("status", { name: "任务结果暂未收到" });
  expect(status).toHaveTextContent("未收到任务完成结果");
  expect(within(status).getByRole("button", { name: "停止任务" })).toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "任务概览浮卡" })).toBeNull();
});

it("shows a missing execution session as a popup without adding a transcript notice", async () => {
  live.snapshot!.runs = [{ id: "failed-run", sessionId: session.id, executor: "codex", status: "failed", errorCode: "native_session_not_found", revision: 1, createdAt: "" }];
  show();
  expect(await screen.findByRole("dialog", { name: "操作未完成" })).toHaveTextContent("请重新发送消息，系统会自动恢复连接");
  expect(screen.getByLabelText("开发会话记录")).not.toHaveTextContent("连接已失效");
});
