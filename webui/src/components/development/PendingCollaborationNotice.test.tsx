import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DevCollaboration } from "@/lib/development-api";
import { collaborationSlot, PendingCollaborationNotice } from "./collaboration-requests";
import { useDevelopmentStore } from "./store";

const api = vi.hoisted(() => ({ collaborationRequest: vi.fn(), delegate: vi.fn() }));
const presets = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("@/lib/development-api", async (original) => ({ ...(await original<typeof import("@/lib/development-api")>()), developmentApi: api }));
vi.mock("./workspace-api", () => ({ subagentApi: presets }));
vi.mock("./useDevelopmentSession", () => ({ refreshDevelopmentSession: vi.fn() }));
const payload = { executor: "mona" as const, goal: "Review confirmed change", expectedOutput: "Findings", readonly: true, presetId: "saved_reviewer" };
const record: DevCollaboration = { id: "collab_original", parentSessionId: "dev_a", childSessionId: "dev_child", requestId: "request_original",
  executor: "mona", goal: payload.goal, expectedOutput: payload.expectedOutput, readonly: true, state: "submitted",
  returnMessageId: null, sourceDiffSha: null, latestRun: null };
const slot = collaborationSlot("dev_a", "review");
const resolved = vi.fn();
const show = () => render(<PendingCollaborationNotice sessionId="dev_a" surface="review" onResolved={resolved} />);
beforeEach(() => {
  vi.resetAllMocks(); localStorage.clear(); useDevelopmentStore.setState(useDevelopmentStore.getInitialState(), true);
  useDevelopmentStore.getState().setCollaborationRequest(slot, { requestId: record.requestId, payload });
  api.collaborationRequest.mockResolvedValue(null); presets.run.mockResolvedValue(record);
});
afterEach(cleanup);

describe("pending collaboration recovery intent", () => {
  it("allows clearing a missing legacy temporary request but never redispatches it", async () => {
    useDevelopmentStore.getState().setCollaborationRequest(slot, { requestId: record.requestId, payload: { ...payload, presetId: undefined } });
    show(); fireEvent.click(screen.getByRole("button", { name: "核对原派发" }));
    const clear = await screen.findByRole("button", { name: "清除此待确认记录" });
    expect(screen.queryByRole("button", { name: "按原请求重试" })).not.toBeInTheDocument();
    expect(useDevelopmentStore.getState().collaborationRequests[slot]).toBeDefined();
    fireEvent.click(clear);
    expect(useDevelopmentStore.getState().collaborationRequests[slot]).toBeUndefined();
    expect(api.delegate).not.toHaveBeenCalled(); expect(presets.run).not.toHaveBeenCalled(); expect(resolved).not.toHaveBeenCalled();
  });
  it("still reads an accepted legacy temporary task without redispatching it", async () => {
    useDevelopmentStore.getState().setCollaborationRequest(slot, { requestId: record.requestId, payload: { ...payload, presetId: undefined } });
    api.collaborationRequest.mockResolvedValue(record); show();
    fireEvent.click(screen.getByRole("button", { name: "核对原派发" }));
    await waitFor(() => expect(resolved).toHaveBeenCalledWith(record));
    expect(api.delegate).not.toHaveBeenCalled(); expect(presets.run).not.toHaveBeenCalled();
  });
  it("only observes a missing request until the user explicitly retries", async () => {
    show(); fireEvent.click(screen.getByRole("button", { name: "核对原派发" }));
    const retry = await screen.findByRole("button", { name: "按原请求重试" });
    expect(presets.run).not.toHaveBeenCalled(); expect(resolved).not.toHaveBeenCalled();
    expect(useDevelopmentStore.getState().collaborationRequests[slot]?.requestId).toBe(record.requestId);
    fireEvent.click(retry);
    await waitFor(() => expect(resolved).toHaveBeenCalledWith(record));
    expect(presets.run).toHaveBeenCalledTimes(1);
    expect(presets.run).toHaveBeenCalledWith("dev_a", payload.presetId, record.requestId, payload.goal, payload.expectedOutput, true, undefined);
    expect(api.delegate).not.toHaveBeenCalled();
    expect(useDevelopmentStore.getState().collaborationRequests[slot]).toBeUndefined();
  });
  it("recovers an accepted request without posting or rerunning its task", async () => {
    api.collaborationRequest.mockResolvedValue(record); show();
    fireEvent.click(screen.getByRole("button", { name: "核对原派发" }));
    await waitFor(() => expect(resolved).toHaveBeenCalledWith(record));
    expect(api.delegate).not.toHaveBeenCalled(); expect(presets.run).not.toHaveBeenCalled();
    expect(useDevelopmentStore.getState().collaborationRequests[slot]).toBeUndefined();
  });
  it("retains unknown state and does not offer a retry when observation fails", async () => {
    api.collaborationRequest.mockRejectedValue(new Error("状态读取失败")); show();
    fireEvent.click(screen.getByRole("button", { name: "核对原派发" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("状态读取失败");
    expect(screen.queryByRole("button", { name: "按原请求重试" })).not.toBeInTheDocument();
    expect(api.delegate).not.toHaveBeenCalled(); expect(presets.run).not.toHaveBeenCalled(); expect(resolved).not.toHaveBeenCalled();
    expect(useDevelopmentStore.getState().collaborationRequests[slot]?.requestId).toBe(record.requestId);
  });
});
