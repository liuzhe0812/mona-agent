import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DevCollaboration, DevReviewSourceState } from "@/lib/development-api";
import { DevelopmentReviewVersion } from "./DevelopmentReviewVersion";

const api = vi.hoisted(() => ({ reviewSource: vi.fn() }));
vi.mock("@/lib/development-api", async (load) => ({ ...(await load<typeof import("@/lib/development-api")>()), developmentApi: api }));
const record: DevCollaboration = { id: "collab_a", parentSessionId: "parent_a", childSessionId: "child_a", requestId: "request_a",
  executor: "mona", goal: "Review source", expectedOutput: "findings", readonly: true, state: "submitted",
  returnMessageId: "return_a", sourceDiffSha: "diff", latestRun: null, reviewSource: { path: "source.ts", version: "a".repeat(64) } };
const result: DevReviewSourceState = { collaborationId: record.id, parentSessionId: record.parentSessionId,
  state: "unchanged", path: "source.ts", baselineVersion: "a".repeat(64), currentVersion: "a".repeat(64), checkedAt: "2026-09-28T01:00:00Z", reason: "" };
beforeEach(() => { vi.resetAllMocks(); api.reviewSource.mockResolvedValue(result); });
afterEach(cleanup);

describe("review source verification", () => {
  it("does not silently run periodic Git work or treat a matching version as approval", async () => {
    render(<DevelopmentReviewVersion record={record} sessionId="parent_a" />);
    expect(api.reviewSource).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "核对代码版本" }));
    expect(await screen.findByText("核对时版本未变")).toBeInTheDocument();
    expect(screen.getByText(/版本一致不代表审查通过/)).toBeInTheDocument();
    expect(api.reviewSource).toHaveBeenCalledOnce();
    expect(api.reviewSource).toHaveBeenCalledWith("parent_a", "collab_a");
  });
  it("reports changed code and removes the old matching result if the next check fails", async () => {
    render(<DevelopmentReviewVersion record={record} sessionId="parent_a" />);
    fireEvent.click(screen.getByRole("button", { name: "核对代码版本" }));
    await screen.findByText("核对时版本未变");
    api.reviewSource.mockResolvedValueOnce({ ...result, state: "changed", currentVersion: "b".repeat(64) });
    fireEvent.click(screen.getByRole("button", { name: "核对代码版本" }));
    await screen.findByText("代码已变化，原审查需要重新确认");
    api.reviewSource.mockRejectedValueOnce(new Error("Git unavailable"));
    fireEvent.click(screen.getByRole("button", { name: "核对代码版本" }));
    await screen.findByRole("alert");
    expect(screen.queryByLabelText("审查版本核对结果")).not.toBeInTheDocument();
  });
  it("ignores a late source check after switching to another review", async () => {
    let finish!: (value: DevReviewSourceState) => void;
    api.reviewSource.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const view = render(<DevelopmentReviewVersion record={record} sessionId="parent_a" />);
    fireEvent.click(screen.getByRole("button", { name: "核对代码版本" }));
    view.rerender(<DevelopmentReviewVersion record={{ ...record, id: "collab_b", parentSessionId: "parent_b" }} sessionId="parent_b" />);
    await act(async () => { finish(result); });
    expect(screen.queryByText("核对时版本未变")).not.toBeInTheDocument();
  });
  it("keeps old unversioned records without inventing freshness", () => {
    render(<DevelopmentReviewVersion record={{ ...record, reviewSource: null }} sessionId="parent_a" />);
    expect(screen.getByRole("button", { name: "核对代码版本" })).toBeDisabled();
    expect(api.reviewSource).not.toHaveBeenCalled();
  });
  it("reports unavailable evidence separately from unchanged evidence", async () => {
    api.reviewSource.mockResolvedValueOnce({ ...result, state: "unavailable", currentVersion: null, reason: "Git 无法读取" });
    render(<DevelopmentReviewVersion record={record} sessionId="parent_a" />);
    fireEvent.click(screen.getByRole("button", { name: "核对代码版本" }));
    await screen.findByText("当前版本无法核对");
    expect(screen.queryByText("核对时版本未变")).not.toBeInTheDocument();
  });
});
