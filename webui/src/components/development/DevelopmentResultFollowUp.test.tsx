import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DevCollaboration, DevSession, DevSnapshot } from "@/lib/development-api";
import { DevelopmentResultFollowUp } from "./DevelopmentResultFollowUp";
import { useDevelopmentStore } from "./store";

const api = vi.hoisted(() => ({ inspectCollaborationResult: vi.fn(), continueCollaborationResult: vi.fn(), reviewSource: vi.fn() }));
vi.mock("@/lib/development-api", async (load) => ({ ...(await load<typeof import("@/lib/development-api")>()), developmentApi: api }));
vi.mock("./useDevelopmentSession", () => ({ refreshDevelopmentSession: vi.fn() }));
const session: DevSession = { id: "parent_one", projectId: "project_one", title: "当前任务", executor: "codex", model: "selected-model",
  modelProvider: null, readonly: false, parentSessionId: null, pinned: false, archived: false, revision: 4, updatedAt: "" };
const record: DevCollaboration = { id: "collab_one", parentSessionId: session.id, childSessionId: "child_one", requestId: "review_one",
  executor: "mona", goal: "审查输入校验", expectedOutput: "findings", readonly: true, state: "returned", returnMessageId: "return_one",
  sourceDiffSha: null, latestRun: { id: "review_run", sessionId: "child_one", executor: "mona", status: "succeeded", revision: 3, createdAt: "" }, followUp: null };
const accepted: DevCollaboration = { ...record, followUp: { requestId: "result_one", input: null,
  run: { id: "parent_followup", sessionId: session.id, executor: "codex", status: "running", revision: 2, createdAt: "" } } };
const snapshot = (): DevSnapshot => ({ session, messages: [], before: null, messageCount: 0, runs: [], events: [], eventCursor: 0, pendingInputs: [], live: null });
function Harness({ value = record, available = true }: { value?: DevCollaboration; available?: boolean }) {
  const [current, setCurrent] = useState(value);
  return <DevelopmentResultFollowUp record={current} session={session} available={available} onUpdated={setCurrent} />;
}
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); useDevelopmentStore.setState(useDevelopmentStore.getInitialState(), true);
  useDevelopmentStore.getState().setSnapshot(session.id, snapshot());
  useDevelopmentStore.getState().setDraft(session.id, "用户尚未发送的草稿");
  api.inspectCollaborationResult.mockResolvedValue(record);
  api.continueCollaborationResult.mockResolvedValue(accepted);
});
afterEach(cleanup);
async function confirm() {
  fireEvent.click(screen.getByRole("button", { name: "交给主会话处理" }));
  await screen.findByRole("dialog", { name: "处理子任务结果" });
}

describe("explicit parent result follow-up", () => {
  it("does not prepare a new request if the engine disappears during inspection", async () => {
    let finish!: (value: DevCollaboration) => void;
    api.inspectCollaborationResult.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const view = render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "交给主会话处理" }));
    view.rerender(<Harness available={false} />);
    await act(async () => { finish(record); });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText("暂未查到处理请求。当前仅核对状态，不会重新发送。")).toBeInTheDocument();
    expect(api.continueCollaborationResult).not.toHaveBeenCalled();
  });
  it("keeps explicit submission disabled if the connection disappears after confirmation opens", async () => {
    const view = render(<Harness />); await confirm();
    view.rerender(<Harness available={false} />);
    const button = screen.getByRole("button", { name: "确认交给主会话" });
    expect(button).toBeDisabled(); fireEvent.click(button);
    expect(api.continueCollaborationResult).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it.each(["unavailable", "unknown", "pending-input"] as const)("recovers accepted receipts through read-only lookup while %s blocks new execution", async (condition) => {
    if (condition === "unknown") useDevelopmentStore.getState().setSnapshot(session.id, { ...snapshot(), runs: [{ ...accepted.followUp!.run!, status: "unknown" }] });
    if (condition === "pending-input") useDevelopmentStore.getState().setSend(session.id, { id: "pending", content: "unknown", uncertain: true });
    api.inspectCollaborationResult.mockResolvedValue(accepted);
    render(<Harness available={condition !== "unavailable"} />);
    fireEvent.click(screen.getByRole("button", { name: /交给主会话处理|核对处理状态/ }));
    await screen.findByText("主会话处理 · 执行中");
    expect(api.inspectCollaborationResult).toHaveBeenCalledWith(session.id, record.id);
    expect(api.continueCollaborationResult).not.toHaveBeenCalled();
    expect(api.reviewSource).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("reads missing follow-up state without preparing a new request when the engine is unavailable", async () => {
    render(<Harness available={false} />);
    fireEvent.click(screen.getByRole("button", { name: /交给主会话处理|核对处理状态/ }));
    await waitFor(() => expect(api.inspectCollaborationResult).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(api.reviewSource).not.toHaveBeenCalled();
    expect(api.continueCollaborationResult).not.toHaveBeenCalled();
    expect(useDevelopmentStore.getState().drafts[session.id]).toBe("用户尚未发送的草稿");
  });
  it("does not auto-run returned results and cancels confirmation without changing drafts", async () => {
    render(<Harness />);
    expect(api.inspectCollaborationResult).not.toHaveBeenCalled();
    await confirm();
    expect(api.continueCollaborationResult).not.toHaveBeenCalled();
    expect(screen.getByText("Codex · selected-model")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(useDevelopmentStore.getState().drafts[session.id]).toBe("用户尚未发送的草稿");
  });
  it("confirms the exact current session/model and sends only once on repeated clicks", async () => {
    render(<Harness />); await confirm();
    const button = screen.getByRole("button", { name: "确认交给主会话" });
    fireEvent.click(button); fireEvent.click(button);
    await screen.findByText("主会话处理 · 执行中");
    expect(api.continueCollaborationResult).toHaveBeenCalledTimes(1);
    expect(api.continueCollaborationResult).toHaveBeenCalledWith(expect.objectContaining({ id: session.id, revision: 4, executor: "codex", model: "selected-model" }), record.id);
    expect(useDevelopmentStore.getState().drafts[session.id]).toBe("用户尚未发送的草稿");
  });
  it("recovers an accepted response after remount by reading instead of sending another request", async () => {
    api.continueCollaborationResult.mockRejectedValueOnce(new Error("回复丢失"));
    const view = render(<Harness />); await confirm();
    fireEvent.click(screen.getByRole("button", { name: "确认交给主会话" }));
    await screen.findByRole("button", { name: "核对处理状态" });
    view.unmount();
    api.inspectCollaborationResult.mockResolvedValue(accepted);
    render(<Harness />);
    expect(api.continueCollaborationResult).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "交给主会话处理" }));
    await screen.findByText("主会话处理 · 执行中");
    expect(api.continueCollaborationResult).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("shows changed source evidence before asking the current owner to process it", async () => {
    const versioned = { ...record, reviewSource: { path: "source.py", version: "a".repeat(64) } };
    api.inspectCollaborationResult.mockResolvedValueOnce(versioned);
    api.reviewSource.mockResolvedValueOnce({ collaborationId: record.id, parentSessionId: session.id,
      state: "changed", path: "source.py", baselineVersion: "a".repeat(64), currentVersion: "b".repeat(64),
      reason: "", checkedAt: "2026-09-28T01:00:00Z" });
    render(<Harness value={versioned} />); await confirm();
    expect(screen.getByText("代码已变化，原审查需要重新确认")).toBeInTheDocument();
    expect(api.continueCollaborationResult).not.toHaveBeenCalled();
    expect(api.reviewSource).toHaveBeenCalledWith(session.id, record.id);
    fireEvent.click(screen.getByRole("button", { name: "确认交给主会话" }));
    await screen.findByText("主会话处理 · 执行中");
    expect(useDevelopmentStore.getState().drafts[session.id]).toBe("用户尚未发送的草稿");
  });
  it("uses the model captured in the confirmation rather than silently switching", async () => {
    render(<Harness />); await confirm();
    act(() => { useDevelopmentStore.getState().setSnapshot(session.id, { ...snapshot(), session: { ...session, revision: 5, executor: "mona", model: "different" } }); });
    api.continueCollaborationResult.mockRejectedValueOnce(new Error("主会话已变化，请重新确认"));
    fireEvent.click(screen.getByRole("button", { name: "确认交给主会话" }));
    await screen.findByText("主会话已变化，请重新确认");
    expect(api.continueCollaborationResult).toHaveBeenCalledWith(expect.objectContaining({ revision: 4, executor: "codex" }), record.id);
  });
  it("queues normal running work but blocks unknown execution and uncertain input", async () => {
    useDevelopmentStore.getState().setSnapshot(session.id, { ...snapshot(), runs: [accepted.followUp!.run!] });
    const queued: DevCollaboration = { ...record, followUp: { requestId: "result_one", run: null,
      input: { id: "result_one", runId: "current_run", messageId: "message_one", state: "pending", revision: 0 } } };
    api.continueCollaborationResult.mockResolvedValue(queued);
    const view = render(<Harness />); await confirm();
    fireEvent.click(screen.getByRole("button", { name: "确认交给主会话" }));
    await screen.findByText("主会话处理 · 已排队，等待当前任务成功结束");
    view.unmount();
    useDevelopmentStore.getState().setSnapshot(session.id, { ...snapshot(), runs: [{ ...accepted.followUp!.run!, status: "unknown" }] });
    render(<Harness />);
    expect(screen.getByRole("button", { name: "核对处理状态" })).toBeEnabled();
    act(() => { useDevelopmentStore.getState().setSnapshot(session.id, snapshot()); useDevelopmentStore.getState().setSend(session.id, { id: "pending", content: "unknown", uncertain: true }); });
    expect(screen.getByRole("button", { name: "核对处理状态" })).toBeEnabled();
  });
  it.each(["failed", "unknown", "interrupted", "succeeded"] as const)("shows actual %s run status without offering replay", (status) => {
    render(<Harness value={{ ...accepted, followUp: { ...accepted.followUp!, run: { ...accepted.followUp!.run!, status } } }} />);
    expect(screen.getByRole("status").textContent).toContain("主会话处理");
    expect(screen.queryByRole("button", { name: "交给主会话处理" })).not.toBeInTheDocument();
    expect(api.continueCollaborationResult).not.toHaveBeenCalled();
    expect(screen.queryByText("审查通过")).not.toBeInTheDocument();
  });
  it("does not dispatch or update a closed result view on a late observation", async () => {
    let finish!: (value: DevCollaboration) => void;
    api.inspectCollaborationResult.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const update = vi.fn();
    const view = render(<DevelopmentResultFollowUp record={record} session={session} available onUpdated={update} />);
    fireEvent.click(screen.getByRole("button", { name: "交给主会话处理" }));
    await waitFor(() => expect(api.inspectCollaborationResult).toHaveBeenCalledTimes(1));
    view.unmount();
    await act(async () => { finish(accepted); });
    expect(update).not.toHaveBeenCalled(); expect(api.continueCollaborationResult).not.toHaveBeenCalled();
  });
  it("offers no action before a durable result and only inspection for an unavailable engine", () => {
    const view = render(<Harness value={{ ...record, returnMessageId: null }} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    view.unmount(); render(<Harness available={false} />);
    expect(screen.getByRole("button", { name: "核对处理状态" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "确认交给主会话" })).not.toBeInTheDocument();
  });
});
