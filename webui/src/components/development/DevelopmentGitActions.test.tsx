import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DevProject, DevSession } from "@/lib/development-api";
import type { GitAction, GitCommitPreview } from "./git-actions-api";
import { useGitActionDrafts } from "./git-action-drafts";
import { DevelopmentGitActions } from "./DevelopmentGitActions";

const api = vi.hoisted(() => ({
  preview: vi.fn(),
  generateMessage: vi.fn(),
  recent: vi.fn(),
  prepare: vi.fn(),
  execute: vi.fn(),
  get: vi.fn(),
  acknowledge: vi.fn(),
  branches: vi.fn(),
}));
vi.mock("./git-actions-api", () => ({ gitActionsApi: api }));

const project: DevProject = { id: "project_git", rootPath: "D:/project", displayName: "示例项目", lastOpenedAt: "" };
const session: DevSession = {
  id: "dev_git", projectId: project.id, executor: "mona", title: "开发任务", model: null,
  readonly: false, parentSessionId: null, pinned: false, archived: false, revision: 0, updatedAt: "",
};
const preview = (includeUnstaged = true): GitCommitPreview => ({
  head: "a".repeat(40), branch: "feature/test", defaultBranch: "main", writable: true,
  files: includeUnstaged
    ? [
      { path: "staged.ts", status: "M ", additions: 3, deletions: 1, staged: true, unstaged: false },
      { path: "working.ts", status: " M", additions: 5, deletions: 2, staged: false, unstaged: true },
    ]
    : [{ path: "staged.ts", status: "M ", additions: 3, deletions: 1, staged: true, unstaged: false }],
  remotes: ["origin"], defaultRemote: "origin", identity: { name: "Mona User", email: "mona@example.invalid" },
  trackingBranch: "origin/main", ahead: 2, behind: 1, canPush: true,
  stagedCount: 1, unstagedCount: 1, additions: includeUnstaged ? 8 : 3, deletions: includeUnstaged ? 3 : 1,
  contextToken: includeUnstaged ? "token-all" : "token-staged", includeUnstaged,
});
const action: GitAction = {
  id: "git_one", sessionId: session.id, projectId: project.id, kind: "commit", paths: ["staged.ts"],
  message: "修复输入校验", branch: "feature/test", expectedHead: "a".repeat(40), remote: "", targetBranch: "", destination: "",
  status: "prepared", phase: "prepared", steps: [], reason: "", commit: null, exitCode: null, createdAt: "",
};
const makeProps = (switchAfterCommit?: string) => ({
  project, session, open: true, onOpenChange: vi.fn(), onChanged: vi.fn(), ...(switchAfterCommit ? { switchAfterCommit } : {}),
});

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useGitActionDrafts.setState({ drafts: {} });
  api.preview.mockImplementation(async (_session: string, include = true) => preview(include));
  api.generateMessage.mockResolvedValue({ message: "自动生成的提交说明" });
  api.recent.mockResolvedValue([]);
  api.branches.mockResolvedValue({ branch: "feature/test", head: "a".repeat(40), branches: ["feature/test", "main"], pendingAction: null });
  api.prepare.mockResolvedValue(action);
  api.execute.mockResolvedValue({ ...action, status: "succeeded", commit: "b".repeat(40) });
  api.get.mockResolvedValue({ ...action, status: "succeeded", commit: "b".repeat(40) });
  api.acknowledge.mockResolvedValue({ ...action, status: "acknowledged" });
});
afterEach(cleanup);

describe("ZCode-style Git commit and push actions", () => {
  it("keeps a failed commit editable and preserves the message without replaying", async () => {
    useGitActionDrafts.getState().update(session.id, { message: "fix: 保留输入" });
    api.execute.mockResolvedValue({ ...action, status: "failed", reason: "提交检查未通过" });
    render(<DevelopmentGitActions {...makeProps()} />);
    fireEvent.click(await screen.findByRole("option", { name: /^提交 Ctrl/ }));
    expect(await screen.findByText("提交检查未通过")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "提交信息" })).toHaveValue("fix: 保留输入");
    expect(api.execute).toHaveBeenCalledTimes(1);
    expect(api.generateMessage).not.toHaveBeenCalled();
  });
  it("opens push confirmation directly for a clean branch with commits to push", async () => {
    api.preview.mockImplementation(async (_session: string, include = true) => ({ ...preview(include), files: [], stagedCount: 0, unstagedCount: 0, additions: 0, deletions: 0 }));
    render(<DevelopmentGitActions {...makeProps()} />);
    expect(await screen.findByRole("dialog", { name: "推送更改" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "提交信息" })).toBeNull();
    expect(api.prepare).not.toHaveBeenCalled();
    expect(api.generateMessage).not.toHaveBeenCalled();
  });
  it("generates an empty message and commits immediately without a second confirmation", async () => {
    const props = makeProps();
    render(<DevelopmentGitActions {...props} />);
    const commit = await screen.findByTestId("git-action-commit");
    fireEvent.click(commit);

    await waitFor(() => expect(api.generateMessage).toHaveBeenCalledWith(session.id, true, "token-all"));
    await waitFor(() => expect(api.prepare).toHaveBeenCalledWith(session.id, expect.objectContaining({
      kind: "commit", paths: ["staged.ts", "working.ts"], message: "自动生成的提交说明",
      includeUnstaged: true, contextToken: "token-all",
    })));
    await waitFor(() => expect(api.execute).toHaveBeenCalledWith(session.id, action.id));
    await waitFor(() => expect(props.onOpenChange).toHaveBeenCalledWith(false));
    expect(screen.queryByRole("button", { name: "确认提交" })).not.toBeInTheDocument();
  });

  it("refreshes the selected file scope when unstaged changes are unchecked", async () => {
    api.preview.mockImplementation(async (_session: string, include = true) => preview(include));
    render(<DevelopmentGitActions {...makeProps()} />);
    const include = await screen.findByRole("checkbox", { name: "包含未暂存的更改" });
    expect(include).toBeChecked();
    fireEvent.click(include);
    await waitFor(() => expect(api.preview).toHaveBeenCalledWith(session.id, false));
    await screen.findByText("1 个文件");

    fireEvent.change(screen.getByRole("textbox", { name: "提交信息" }), { target: { value: "只提交暂存内容" } });
    fireEvent.click(screen.getByTestId("git-action-commit"));
    await waitFor(() => expect(api.prepare).toHaveBeenCalledWith(session.id, expect.objectContaining({
      kind: "commit", paths: ["staged.ts"], message: "只提交暂存内容",
      includeUnstaged: false, contextToken: "token-staged",
    })));
  });

  it("uses arrow selection and Ctrl+Enter to choose commit and push", async () => {
    render(<DevelopmentGitActions {...makeProps()} />);
    const message = await screen.findByRole("textbox", { name: "提交信息" });
    fireEvent.change(message, { target: { value: "修复校验" } });
    fireEvent.keyDown(message, { key: "ArrowDown" });
    fireEvent.keyDown(message, { key: "Enter", ctrlKey: true });

    await waitFor(() => expect(api.prepare).toHaveBeenCalledWith(session.id, expect.objectContaining({
      kind: "commit_and_push", remote: "origin", branch: "main", message: "修复校验",
    })));
    await waitFor(() => expect(api.execute).toHaveBeenCalledWith(session.id, action.id));
    expect(screen.queryByRole("dialog", { name: "推送更改" })).not.toBeInTheDocument();
  });

  it("opens a separate push confirmation with the target and counts before preparing or executing", async () => {
    render(<DevelopmentGitActions {...makeProps()} />);
    fireEvent.click(await screen.findByRole("option", { name: /^推送/ }));
    expect(await screen.findByRole("dialog", { name: "推送更改" })).toBeInTheDocument();
    const pushDialog = screen.getByRole("dialog", { name: "推送更改" });
    expect(within(pushDialog).getAllByText("origin/main")).toHaveLength(2);
    expect(within(pushDialog).getByText("2")).toBeInTheDocument();
    expect(within(pushDialog).getByText("1")).toBeInTheDocument();
    expect(api.prepare).not.toHaveBeenCalled();
    expect(api.execute).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "推送", exact: true }));
    await waitFor(() => expect(api.prepare).toHaveBeenCalledWith(session.id, expect.objectContaining({
      kind: "push", paths: [], remote: "origin", branch: "main", contextToken: "token-all",
    })));
    await waitFor(() => expect(api.execute).toHaveBeenCalledWith(session.id, action.id));
  });

  it("restores an unknown operation for inspection without preparing or replaying it", async () => {
    api.recent.mockResolvedValue([{ ...action, status: "unknown", reason: "推送结果待核对" }]);
    render(<DevelopmentGitActions {...makeProps()} />);
    expect(await screen.findByRole("heading", { name: "提交 · 结果待核对" })).toBeInTheDocument();
    expect(screen.getByText("推送结果待核对")).toBeInTheDocument();
    expect(api.prepare).not.toHaveBeenCalled();
    expect(api.execute).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("checkbox", { name: "确认已人工核对 Git 状态" }));
    fireEvent.click(screen.getByRole("button", { name: "保存核对结果" }));
    await waitFor(() => expect(api.acknowledge).toHaveBeenCalledWith(session.id, action.id));
    expect(api.execute).not.toHaveBeenCalled();
  });

  it("only shows the targeted commit-and-switch action when invoked for a blocked switch", async () => {
    const props = makeProps("release/next");
    render(<DevelopmentGitActions {...props} />);
    expect(await screen.findByTestId("git-action-commit_and_switch")).toBeInTheDocument();
    expect(screen.queryByTestId("git-action-commit")).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "提交信息" }), { target: { value: "保存当前更改" } });
    fireEvent.click(screen.getByTestId("git-action-commit_and_switch"));
    await waitFor(() => expect(api.prepare).toHaveBeenCalledWith(session.id, expect.objectContaining({
      kind: "commit_and_switch", branch: "release/next", message: "保存当前更改",
    })));
  });
});
