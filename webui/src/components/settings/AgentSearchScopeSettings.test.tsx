import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAgentSearchScope: vi.fn(),
  setAgentSearchScope: vi.fn(),
  getNotesVaultPath: vi.fn(),
  loadDesktopNotesState: vi.fn(),
  listAccounts: vi.fn(),
  getFolders: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ({
  getAgentSearchScope: mocks.getAgentSearchScope,
  setAgentSearchScope: mocks.setAgentSearchScope,
  getNotesVaultPath: mocks.getNotesVaultPath,
  loadDesktopNotesState: mocks.loadDesktopNotesState,
}));
vi.mock("@/components/email/lib/emailApi", () => ({
  listAccounts: mocks.listAccounts,
  getFolders: mocks.getFolders,
}));

import { AgentSearchScopeSettings } from "./AgentSearchScopeSettings";

const scope = {
  notes: { mode: "specific", allowedNotebookIds: ["notebook-a"] },
  email: { mode: "none", allowedFolders: ["INBOX"] },
};

beforeEach(() => {
  mocks.getAgentSearchScope.mockReset().mockResolvedValue(scope);
  mocks.setAgentSearchScope.mockReset().mockResolvedValue(undefined);
  mocks.getNotesVaultPath.mockReset().mockResolvedValue("/notes-vault");
  mocks.loadDesktopNotesState.mockReset().mockResolvedValue({
    notebooks: [
      { id: "notebook-a", name: "研究" },
      { id: "notebook-b", name: "个人" },
    ],
  });
  mocks.listAccounts.mockReset().mockResolvedValue([]);
  mocks.getFolders.mockReset().mockResolvedValue([]);
});

describe("AgentSearchScopeSettings", () => {
  it("reads notebook metadata, includes the root folder, and preserves email scope on save", async () => {
    render(<AgentSearchScopeSettings source="notes" />);

    fireEvent.click(await screen.findByRole("button", { name: "配置" }));
    const root = await screen.findByRole("checkbox", { name: "根目录（未分类笔记）" });
    expect(root).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "研究" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "个人" })).not.toBeChecked();
    expect(mocks.listAccounts).not.toHaveBeenCalled();
    expect(mocks.getFolders).not.toHaveBeenCalled();

    fireEvent.click(root);

    await waitFor(() => expect(mocks.setAgentSearchScope).toHaveBeenCalledWith({
      notes: { mode: "specific", allowedNotebookIds: ["notebook-a", ""] },
      email: { mode: "none", allowedFolders: ["INBOX"] },
    }));
  });

  it("does not write the default on load and retains all, none, and specific modes", async () => {
    const emptyDefault = {
      notes: { mode: "", allowedNotebookIds: ["notebook-a"] },
      email: { mode: "", allowedFolders: ["INBOX"] },
    };
    mocks.getAgentSearchScope.mockResolvedValue(emptyDefault);
    render(<AgentSearchScopeSettings source="notes" />);

    const mode = await screen.findByRole("button", { name: "笔记搜索范围" });
    const user = userEvent.setup();
    expect(mode).toHaveTextContent("全部允许");
    expect(mocks.setAgentSearchScope).not.toHaveBeenCalled();

    await user.click(mode);
    await user.click(screen.getByRole("menuitem", { name: "全部不允许" }));
    await waitFor(() => expect(mocks.setAgentSearchScope).toHaveBeenLastCalledWith({
      notes: { mode: "none", allowedNotebookIds: ["notebook-a"] },
      email: { mode: "", allowedFolders: ["INBOX"] },
    }));

    await user.click(screen.getByRole("button", { name: "笔记搜索范围" }));
    await user.click(screen.getByRole("menuitem", { name: "指定文件夹允许" }));
    await waitFor(() => expect(mocks.setAgentSearchScope).toHaveBeenLastCalledWith({
      notes: { mode: "specific", allowedNotebookIds: ["notebook-a"] },
      email: { mode: "", allowedFolders: ["INBOX"] },
    }));
    expect(mocks.setAgentSearchScope).toHaveBeenCalledTimes(2);
  });

  it("loads only email folders and retains the notes scope when saving folder names", async () => {
    mocks.getAgentSearchScope.mockResolvedValue({
      notes: { mode: "specific", allowedNotebookIds: ["notebook-a"] },
      email: { mode: "specific", allowedFolders: ["INBOX"] },
    });
    const account = {
      id: "account-1",
      displayName: "工作邮箱",
      fromAddress: "work@example.invalid",
      imapUsername: "work",
    };
    mocks.listAccounts.mockResolvedValue([account]);
    mocks.getFolders.mockResolvedValue([
      { name: "INBOX", delimiter: "/", hasChildren: false, flags: "" },
      { name: "Projects", delimiter: "/", hasChildren: false, flags: "" },
    ]);

    render(<AgentSearchScopeSettings source="email" />);

    fireEvent.click(await screen.findByRole("button", { name: "配置" }));
    expect(await screen.findByRole("checkbox", { name: "收件箱" })).toBeChecked();
    const projects = screen.getByRole("checkbox", { name: "Projects" });
    expect(projects).not.toBeChecked();
    expect(mocks.getNotesVaultPath).not.toHaveBeenCalled();
    expect(mocks.loadDesktopNotesState).not.toHaveBeenCalled();
    expect(mocks.getFolders).toHaveBeenCalledWith("account-1");

    fireEvent.click(projects);

    await waitFor(() => expect(mocks.setAgentSearchScope).toHaveBeenCalledWith({
      notes: { mode: "specific", allowedNotebookIds: ["notebook-a"] },
      email: { mode: "specific", allowedFolders: ["INBOX", "Projects"] },
    }));
  });

  it("does not save a default scope when the stored scope cannot be read", async () => {
    mocks.getAgentSearchScope.mockRejectedValueOnce(new Error("storage unavailable"));
    render(<AgentSearchScopeSettings source="notes" />);

    expect(await screen.findByRole("alert")).toHaveTextContent("搜索范围暂时无法读取，请点击“重试”后再试。");
    expect(screen.queryByRole("button", { name: "笔记搜索范围" })).not.toBeInTheDocument();
    expect(mocks.setAgentSearchScope).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByRole("button", { name: "笔记搜索范围" })).toBeInTheDocument();
    expect(mocks.setAgentSearchScope).not.toHaveBeenCalled();
  });

  it("keeps the last saved selection until a failed write is retried successfully", async () => {
    mocks.setAgentSearchScope
      .mockRejectedValueOnce(new Error("write failed"))
      .mockResolvedValue(undefined);
    render(<AgentSearchScopeSettings source="notes" />);

    fireEvent.click(await screen.findByRole("button", { name: "配置" }));
    const root = await screen.findByRole("checkbox", { name: "根目录（未分类笔记）" });
    fireEvent.click(root);

    expect(await screen.findByRole("alert")).toHaveTextContent("搜索范围保存失败，请重试。");
    expect(root).not.toBeChecked();
    expect(mocks.setAgentSearchScope).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "重试" }));

    expect(await screen.findByRole("checkbox", { name: "根目录（未分类笔记）" })).toBeChecked();
    expect(mocks.setAgentSearchScope).toHaveBeenCalledTimes(2);
  });
});
