import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { DevSnapshot } from "@/lib/development-api";
import { DevelopmentPane } from "./DevelopmentPane";
import { useDevelopmentStore } from "./store";

const api = vi.hoisted(() => ({ send: vi.fn(), cancelInput: vi.fn(), guideInput: vi.fn(), interrupt: vi.fn() }));
vi.mock("@/lib/development-api", async (original) => ({ ...await original<typeof import("@/lib/development-api")>(), developmentApi: api }));
vi.mock("./useDevelopmentSession", () => ({
  useDevelopmentSession: (id: string) => useDevelopmentStore((state) => state.snapshots[id]),
  refreshDevelopmentSession: vi.fn(),
}));
vi.mock("./zcode/markdown", () => ({ ZCodeMarkdown: ({ children }: { children: string }) => <div>{children}</div> }));

beforeEach(async () => {
  vi.clearAllMocks();
  useDevelopmentStore.setState(useDevelopmentStore.getInitialState(), true);
  await i18n.changeLanguage("zh-CN");
});
afterEach(cleanup);

it("shows an admitted guide separately until the model receives the original input", async () => {
  const session = { id: "guide-session", projectId: "guide-project", title: "任务", executor: "mona" as const, model: null,
    readonly: false, parentSessionId: null, pinned: false, archived: false, revision: 1, updatedAt: "" };
  const run = { id: "guide-run", sessionId: session.id, executor: "mona" as const, status: "running" as const, revision: 1, createdAt: "2026-10-15T08:00:00Z" };
  const original = { id: "original", role: "user", content: "运行项目", runId: run.id, toolCalls: [], queued: false, truncated: false };
  const queued = { id: "queued", role: "user", content: "怎么卡住了", toolCalls: [], queued: true, truncated: false };
  const value: DevSnapshot = { session, runs: [run], messages: [original, queued], messageCount: 2, before: null,
    events: [], eventCursor: 0, live: null,
    pendingInputs: [{ id: "queue-request", messageId: queued.id, runId: run.id, state: "pending", intent: "follow_up", revision: 0 }] };
  let acknowledged = value;
  api.guideInput.mockImplementationOnce(async () => {
    const input = { ...value.pendingInputs![0], intent: "steering" as const, revision: 1 };
    acknowledged = { ...value, pendingInputs: [input] };
    useDevelopmentStore.getState().setSnapshot(session.id, acknowledged);
    return { input, queued: true };
  });
  useDevelopmentStore.getState().setSnapshot(session.id, value);
  render(<DevelopmentPane project={{ id: session.projectId, displayName: "项目", rootPath: "D:/project", lastOpenedAt: "" }} session={session}
    executors={[{ id: "mona", name: "Mona", available: true, reason: "", models: [] }]} />);
  const conversation = within(screen.getByLabelText("开发会话记录"));
  expect(screen.getByRole("listitem")).toHaveTextContent(queued.content);
  expect(screen.getAllByText(queued.content)).toHaveLength(1);
  expect(api.send).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "引导到当前任务" }));
  await waitFor(() => expect(screen.queryByRole("listitem")).toBeNull());
  expect(conversation.getByText(queued.content)).toBeVisible();
  expect(conversation.getByText("等待引导当前任务…")).toBeVisible();
  expect(api.guideInput).toHaveBeenCalledWith(session.id, "queue-request", 0, run.id);
  expect(api.send).not.toHaveBeenCalled();
  expect(api.cancelInput).not.toHaveBeenCalled();

  act(() => useDevelopmentStore.getState().setSnapshot(session.id, { ...acknowledged, messageCount: 4, pendingInputs: [],
    messages: [original, { ...queued, id: "delivered-guide", runId: run.id, queued: false, sourceKind: "steering" }] }));
  expect(conversation.getAllByText(queued.content)).toHaveLength(1);
  expect(conversation.queryByText("等待引导当前任务…")).toBeNull();
  expect(screen.queryByRole("listitem")).toBeNull();
  expect(api.guideInput).toHaveBeenCalledOnce();
});

it("returns an unreceived guide to the same paused queue item when stopped", async () => {
  const session = { id: "stopped-session", projectId: "guide-project", title: "任务", executor: "mona" as const, model: null,
    readonly: false, parentSessionId: null, pinned: false, archived: false, revision: 1, updatedAt: "" };
  const run = { id: "stopped-run", sessionId: session.id, executor: "mona" as const, status: "running" as const, revision: 1, createdAt: "2026-10-15T08:00:00Z" };
  const value: DevSnapshot = { session, runs: [run],
    messages: [{ id: "one", role: "user", content: "1", runId: run.id, toolCalls: [], queued: false, truncated: false },
      { id: "queued-two", role: "user", content: "2", runId: run.id, toolCalls: [], queued: true, truncated: false }],
    pendingInputs: [{ id: "guided-two", messageId: "queued-two", runId: run.id, state: "pending", intent: "steering", revision: 1 }],
    messageCount: 2, before: null, events: [], eventCursor: 0, live: null };
  api.interrupt.mockImplementationOnce(async () => {
    useDevelopmentStore.getState().setSnapshot(session.id, { ...value,
      pendingInputs: [{ ...value.pendingInputs![0], intent: "follow_up", revision: 2 }],
      runs: [{ ...run, status: "interrupted", revision: 2 }] });
    return {};
  });
  useDevelopmentStore.getState().setSnapshot(session.id, value);
  render(<DevelopmentPane project={{ id: session.projectId, displayName: "项目", rootPath: "D:/project", lastOpenedAt: "" }} session={session}
    executors={[{ id: "mona", name: "Mona", available: true, reason: "", models: [] }]} />);
  expect(screen.getByText("等待引导当前任务…")).toBeVisible();
  expect(screen.queryByRole("listitem")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "中断当前轮次" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "中断当前轮次" })).toBeNull());
  expect(screen.getByRole("listitem")).toHaveTextContent("2");
  expect(screen.queryByText("等待引导当前任务…")).toBeNull();
  expect(screen.getAllByText("2")).toHaveLength(1);
  expect(useDevelopmentStore.getState().snapshots[session.id].pendingInputs?.[0].id).toBe("guided-two");
  expect(api.interrupt).toHaveBeenCalledWith(session.id, run.id);
  expect(api.send).not.toHaveBeenCalled();
  expect(api.cancelInput).not.toHaveBeenCalled();
});

it("keeps ordinary follow-ups and their saved text in the queue after interruption", () => {
  const session = { id: "interrupted-session", projectId: "guide-project", title: "任务", executor: "mona" as const, model: null,
    readonly: false, parentSessionId: null, pinned: false, archived: false, revision: 1, updatedAt: "" };
  const value: DevSnapshot = { session, runs: [{ id: "interrupted-run", sessionId: session.id, executor: "mona", status: "interrupted", revision: 2, createdAt: "2026-10-15T08:00:00Z" }],
    messages: [{ id: "last-response", role: "assistant", content: "最后的回复", runId: "interrupted-run", toolCalls: [], queued: false, truncated: false }],
    pendingInputs: [{ id: "unconsumed-request", messageId: "unconsumed", runId: "interrupted-run", state: "pending", intent: "follow_up", revision: 0,
      source: { content: "保留未处理的引导" } }],
    messageCount: 101, before: 100, events: [], eventCursor: 0, live: null };
  useDevelopmentStore.getState().setSnapshot(session.id, value);
  render(<DevelopmentPane project={{ id: session.projectId, displayName: "项目", rootPath: "D:/project", lastOpenedAt: "" }} session={session}
    executors={[{ id: "mona", name: "Mona", available: true, reason: "", models: [] }]} />);
  expect(screen.getByRole("listitem")).toHaveTextContent("保留未处理的引导");
  expect(screen.getAllByText("保留未处理的引导")).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "引导到当前任务" })).toBeNull();
  expect(api.send).not.toHaveBeenCalled();
});
