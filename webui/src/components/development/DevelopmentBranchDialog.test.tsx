import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DevSession } from "@/lib/development-api";
import type { GitAction, GitBranchContext } from "./git-actions-api";
import { DevelopmentBranchDialog } from "./DevelopmentBranchDialog";

const api = vi.hoisted(() => ({ branches: vi.fn(), prepare: vi.fn(), execute: vi.fn(), get: vi.fn(), acknowledge: vi.fn() }));
vi.mock("./git-actions-api", () => ({ gitActionsApi: api }));

const session: DevSession = { id: "dev_branch", projectId: "project_branch", executor: "mona", title: "开发任务", model: null,
  readonly: false, parentSessionId: null, pinned: false, archived: false, revision: 0, updatedAt: "" };
const baseAction: GitAction = { id: "git_branch_1", sessionId: session.id, projectId: session.projectId,
  kind: "create_branch", paths: [], message: "", branch: "feature/new", expectedHead: "abc", remote: "", targetBranch: "feature/new",
  destination: "", status: "prepared", phase: "prepared", reason: "", commit: null, exitCode: null, createdAt: "", steps: [] };
const context: GitBranchContext = { branch: "main", head: "abc", branches: ["main", "develop"], pendingAction: null };

beforeEach(() => {
  vi.clearAllMocks();
  api.branches.mockResolvedValue(context);
  api.prepare.mockResolvedValue(baseAction);
  api.execute.mockResolvedValue({ ...baseAction, status: "succeeded" });
  api.get.mockResolvedValue(baseAction);
  api.acknowledge.mockResolvedValue({ ...baseAction, status: "acknowledged" });
});
afterEach(cleanup);

describe("DevelopmentBranchDialog", () => {
  it("creates and switches in one explicit action, then refreshes the view", async () => {
    const onChanged = vi.fn();
    const onOpenChange = vi.fn();
    render(<DevelopmentBranchDialog session={session} mode="create" open onOpenChange={onOpenChange} onChanged={onChanged} />);

    fireEvent.change(await screen.findByRole("textbox", { name: "新分支名称" }), { target: { value: "feature/new" } });
    fireEvent.click(screen.getByRole("button", { name: "创建并切换" }));
    expect(api.prepare).toHaveBeenCalledWith(session.id, expect.objectContaining({ kind: "create_branch", branch: "feature/new", paths: [] }));
    await waitFor(() => expect(api.execute).toHaveBeenCalledWith(session.id, baseAction.id));
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("does not replay an unknown operation and requires explicit branch verification before acknowledging", async () => {
    const otherSessionAction = { ...baseAction, sessionId: "dev_other", status: "unknown" as const };
    api.branches.mockResolvedValue({ ...context, pendingAction: otherSessionAction });
    const onChanged = vi.fn();
    const onOpenChange = vi.fn();
    render(<DevelopmentBranchDialog session={session} mode="create" open onOpenChange={onOpenChange} onChanged={onChanged} />);

    expect(await screen.findByText(/系统无法确认操作结果/)).toBeInTheDocument();
    expect(api.execute).not.toHaveBeenCalled();
    const acknowledge = screen.getByRole("button", { name: "已核对当前分支" });
    expect(acknowledge).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "确认已核对当前分支" }));
    fireEvent.click(acknowledge);

    await waitFor(() => expect(api.acknowledge).toHaveBeenCalledWith(otherSessionAction.sessionId, baseAction.id));
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    expect(api.execute).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
