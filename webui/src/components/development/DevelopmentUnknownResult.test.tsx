import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
const api = vi.hoisted(() => ({ closeUnknown: vi.fn(), recover: vi.fn(), send: vi.fn(), refresh: vi.fn() }));
vi.mock("@/lib/development-api", async (original) => ({ ...await original<typeof import("@/lib/development-api")>(), developmentApi: api }));
vi.mock("./useDevelopmentSession", () => ({ refreshDevelopmentSession: api.refresh }));
import { DevelopmentUnknownResult } from "./DevelopmentUnknownResult";
import { useDevelopmentStore } from "./store";
import { isRunActive, type DevNativeBinding, type DevRun, type DevSnapshot } from "@/lib/development-api";
const run: DevRun = { id: "run_unknown", sessionId: "dev_unknown", requestId: "req_original", status: "unknown", executor: "codebuddy", revision: 7, createdAt: "" };
const binding: DevNativeBinding = { id: "binding_unknown", turnHistory: false, replacesBindingId: null, replacementReason: null };
const snapshot: DevSnapshot = { session: { id: run.sessionId, projectId: "project_a", title: "任务", executor: "codebuddy", model: "model_a", parentSessionId: null, readonly: false, pinned: false, archived: false, revision: 3, updatedAt: "" },
  messages: [], runs: [run], nativeBinding: binding, events: [], pendingInputs: [], eventCursor: 0, messageCount: 0, before: null, live: null };
beforeEach(() => {
  vi.clearAllMocks(); useDevelopmentStore.setState(useDevelopmentStore.getInitialState(), true);
  useDevelopmentStore.getState().setSnapshot(run.sessionId, snapshot);
  useDevelopmentStore.getState().setDraft(run.sessionId, "下一条新任务");
  api.closeUnknown.mockResolvedValue({ ...run, revision: 8, status: "closed_unknown" });
});
afterEach(cleanup);
describe("uncertain native result continuation", () => {
  it("requires explicit verification, preserves the draft, and never replays or sends", async () => {
    render(<DevelopmentUnknownResult run={run} binding={binding} />);
    fireEvent.click(screen.getByRole("button", { name: "结束等待并继续" }));
    const confirm = screen.getByRole("button", { name: "确认并继续" });
    expect(confirm).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(confirm);
    await waitFor(() => expect(api.closeUnknown).toHaveBeenCalledWith(run.sessionId, run.id, run.revision, binding.id));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(useDevelopmentStore.getState().drafts[run.sessionId]).toBe("下一条新任务");
    expect(isRunActive(useDevelopmentStore.getState().snapshots[run.sessionId].runs[0])).toBe(false);
    expect(api.send).not.toHaveBeenCalled();
    expect(api.refresh).toHaveBeenCalledWith(run.sessionId);
  });
  it("cancelling the dialog does not change the unknown run", () => {
    render(<DevelopmentUnknownResult run={run} binding={binding} />);
    fireEvent.click(screen.getByRole("button", { name: "结束等待并继续" }));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(api.closeUnknown).not.toHaveBeenCalled();
    expect(useDevelopmentStore.getState().snapshots[run.sessionId].runs[0].status).toBe("unknown");
  });
  it("keeps the original state when the host cannot confirm cleanup", async () => {
    api.closeUnknown.mockRejectedValueOnce(new Error("原任务状态已变化"));
    render(<DevelopmentUnknownResult run={run} binding={binding} />);
    fireEvent.click(screen.getByRole("button", { name: "结束等待并继续" }));
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "确认并继续" }));
    await screen.findByRole("alert");
    expect(useDevelopmentStore.getState().snapshots[run.sessionId].runs[0].status).toBe("unknown");
    expect(api.send).not.toHaveBeenCalled();
  });
  it.each(["codex", "mona"] as const)("offers %s an explicit stop and does not fetch results manually", (executor) => {
    const onStop = vi.fn();
    const unresolved = { ...run, executor };
    render(<DevelopmentUnknownResult run={unresolved} binding={{ ...binding, turnHistory: true }} onStop={onStop} />);
    expect(screen.getByRole("status")).toHaveTextContent("未收到任务完成结果");
    expect(screen.getByRole("status")).toHaveTextContent("请勿重复发送相同任务");
    expect(isRunActive(unresolved)).toBe(false);
    expect(screen.queryByRole("button", { name: "获取任务结果" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "停止任务" }));
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(api.recover).not.toHaveBeenCalled();
    expect(api.closeUnknown).not.toHaveBeenCalled();
    expect(api.send).not.toHaveBeenCalled();
  });
});
