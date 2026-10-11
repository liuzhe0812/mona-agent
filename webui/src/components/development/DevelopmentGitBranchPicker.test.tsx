import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DevSession } from "@/lib/development-api";
import type { GitAction, GitBranchContext } from "./git-actions-api";
import { DevelopmentGitBranchPicker } from "./DevelopmentGitBranchPicker";

const api = vi.hoisted(() => ({ branches: vi.fn(), prepare: vi.fn(), execute: vi.fn(), get: vi.fn(), acknowledge: vi.fn() }));
vi.mock("./git-actions-api", () => ({ gitActionsApi: api }));
vi.mock("./DevelopmentGitActions", () => ({
  DevelopmentGitActions: (props: { open: boolean; switchAfterCommit?: string }) => props.open ? <div data-testid="commit-and-switch-target">{props.switchAfterCommit}</div> : null,
}));

const session: DevSession = { id: "dev_picker", projectId: "project_picker", executor: "mona", title: "开发任务", model: null,
  readonly: false, parentSessionId: null, pinned: false, archived: false, revision: 0, updatedAt: "" };
const branchAction: GitAction = { id: "git_switch_1", sessionId: session.id, projectId: session.projectId,
  kind: "switch_branch", paths: [], message: "", branch: "feature/ui", expectedHead: "abc", remote: "", targetBranch: "feature/ui",
  destination: "", status: "prepared", phase: "prepared", reason: "", commit: null, exitCode: null, createdAt: "", steps: [] };
const context: GitBranchContext = { branch: "main", head: "abc", branches: ["main", "feature/ui", "release"], pendingAction: null };

beforeEach(() => {
  vi.clearAllMocks();
  api.branches.mockResolvedValue(context);
  api.prepare.mockResolvedValue(branchAction);
  api.execute.mockResolvedValue({ ...branchAction, status: "succeeded" });
  api.get.mockResolvedValue(branchAction);
});
afterEach(cleanup);

describe("DevelopmentGitBranchPicker", () => {
  it("searches branches and marks the current branch with its pending-change count", async () => {
    render(<DevelopmentGitBranchPicker session={session} branch="main" dirtyCount={3} disabled={false} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "切换 Git 分支" }));

    const current = await screen.findByRole("option", { name: /main/ });
    expect(current).toHaveAttribute("aria-selected", "true");
    expect(current).toHaveTextContent("未提交的更改：3 个文件");
    expect(screen.getByRole("button", { name: "Git 图谱" })).toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: "搜索分支" }), { target: { value: "release" } });
    expect(screen.getByRole("option", { name: "release" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /main/ })).not.toBeInTheDocument();
  });

  it("switches immediately after a branch is selected", async () => {
    const onChanged = vi.fn();
    render(<DevelopmentGitBranchPicker session={session} project={{ id: session.projectId, rootPath: "C:/work", displayName: "项目", lastOpenedAt: "" }} branch="main" dirtyCount={0} disabled={false} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("button", { name: "切换 Git 分支" }));
    fireEvent.click(await screen.findByRole("option", { name: "feature/ui" }));

    await waitFor(() => expect(api.prepare).toHaveBeenCalledWith(session.id, expect.objectContaining({ kind: "switch_branch", branch: "feature/ui" })));
    await waitFor(() => expect(api.execute).toHaveBeenCalledWith(session.id, branchAction.id));
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
  });

  it("shows affected files when switching would overwrite local changes", async () => {
    api.execute.mockResolvedValue({ ...branchAction, status: "failed", errorCode: "branch_overwrite", reason: "当前更改会被目标分支覆盖。", targetBranch: "feature/ui", affectedPaths: ["src/main.ts"] });
    render(<DevelopmentGitBranchPicker session={session} project={{ id: session.projectId, rootPath: "C:/work", displayName: "项目", lastOpenedAt: "" }} branch="main" dirtyCount={1} disabled={false} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "切换 Git 分支" }));
    fireEvent.click(await screen.findByRole("option", { name: "feature/ui" }));

    expect(await screen.findByRole("dialog", { name: "无法切换分支" })).toBeInTheDocument();
    expect(screen.getByText("src/main.ts")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "提交并切换分支…" }));
    expect(await screen.findByTestId("commit-and-switch-target")).toHaveTextContent("feature/ui");
  });
});
