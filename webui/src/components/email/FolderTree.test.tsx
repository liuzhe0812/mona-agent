import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmailAccount, EmailFolder } from "./lib/types";

const mocks = vi.hoisted(() => {
  const markAllRead = vi.fn();
  const state = {
    accounts: [] as EmailAccount[],
    selectedAccountId: null as string | null,
    foldersByAccount: {} as Record<string, EmailFolder[]>,
    foldersLoading: false,
    foldersError: null as string | null,
    selectedFolder: "INBOX",
    isUnifiedInbox: false,
    selectAccount: vi.fn(),
    selectFolder: vi.fn(),
    selectUnifiedInbox: vi.fn(),
    loadFolders: vi.fn(),
    loadMessages: vi.fn(),
    reorderAccounts: vi.fn(),
    syncMail: vi.fn(),
    markAllRead,
    emptyFolder: vi.fn(),
    removeAccount: vi.fn(),
  };
  const useEmailStore = Object.assign(
    (selector: (current: typeof state) => unknown) => selector(state),
    { getState: () => state },
  );
  return {
    state,
    useEmailStore,
    markAllRead,
    deleteFolder: vi.fn(),
    renameFolder: vi.fn(),
  };
});

vi.mock("./store/emailStore", () => ({ useEmailStore: mocks.useEmailStore }));
vi.mock("./lib/emailApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/emailApi")>()),
  deleteFolder: mocks.deleteFolder,
  renameFolder: mocks.renameFolder,
}));
vi.mock("./EmailStatisticsDialog", () => ({ EmailStatisticsDialog: () => null }));
vi.mock("./NewFolderDialog", () => ({ NewFolderDialog: () => null }));
vi.mock("./AccountSettingsDialog", () => ({ AccountSettingsDialog: () => null }));
vi.mock("./NewAccountDialog", () => ({ NewAccountDialog: () => null }));

import { FolderTree } from "./FolderTree";

const account: EmailAccount = {
  id: "account-a",
  displayName: "Test account",
  imapHost: "imap.example.test",
  imapPort: 993,
  imapUsername: "user@example.test",
  imapPassword: "",
  smtpHost: "smtp.example.test",
  smtpPort: 465,
  smtpUsername: "user@example.test",
  smtpPassword: "",
  fromAddress: "user@example.test",
  imapUseSsl: true,
  smtpUseSsl: true,
};

const folder: EmailFolder = {
  name: "Archive",
  delimiter: "/",
  hasChildren: false,
  flags: "",
  unreadCount: 2,
};

function openFolderMenu(folderLabel = "归档") {
  fireEvent.contextMenu(screen.getByText(folderLabel), { button: 2, clientX: 20, clientY: 20 });
}

describe("FolderTree folder actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.markAllRead.mockReset();
    mocks.deleteFolder.mockReset();
    mocks.renameFolder.mockReset();
    Object.assign(mocks.state, {
      accounts: [account],
      selectedAccountId: account.id,
      foldersByAccount: { [account.id]: [folder] },
      foldersLoading: false,
      foldersError: null,
      selectedFolder: "INBOX",
      isUnifiedInbox: false,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows a spinner only for the active action and disables other writes", async () => {
    let finishMarkAllRead!: () => void;
    mocks.markAllRead.mockImplementation(
      () => new Promise<void>((resolve) => { finishMarkAllRead = resolve; }),
    );
    render(<FolderTree gatewayUrl="http://127.0.0.1:17173" />);

    openFolderMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "全部标为已读" }));
    expect(mocks.markAllRead).toHaveBeenCalledWith(
      "http://127.0.0.1:17173",
      account.id,
      folder.name,
    );

    openFolderMenu();
    const markReadItem = screen.getByRole("menuitem", { name: "全部标为已读" });
    const deleteItem = screen.getByRole("menuitem", { name: "删除文件夹" });
    expect(markReadItem.querySelector("svg.animate-spin")).not.toBeNull();
    expect(deleteItem.querySelector("svg.animate-spin")).toBeNull();
    expect(deleteItem).toHaveAttribute("data-disabled");
    expect(mocks.deleteFolder).not.toHaveBeenCalled();

    await act(async () => finishMarkAllRead());
    await waitFor(() => {
      expect(screen.getByRole("menuitem", { name: "全部标为已读" }).querySelector("svg.animate-spin"))
        .toBeNull();
    });
  });

  it("shows a safe timeout dialog and clears the delete spinner", async () => {
    const timeoutError = new Error("private server detail");
    timeoutError.name = "EmailFolderMutationTimeoutError";
    mocks.deleteFolder.mockRejectedValue(timeoutError);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const alert = vi.spyOn(window, "alert").mockImplementation(() => {});
    render(<FolderTree gatewayUrl="http://127.0.0.1:17173" />);

    openFolderMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "删除文件夹" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("操作结果未确认");
    expect(dialog).toHaveTextContent("刷新文件夹列表核对后再操作");
    expect(dialog).not.toHaveTextContent("private server detail");
    expect(confirm).toHaveBeenCalledOnce();
    expect(alert).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "知道了" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    openFolderMenu();
    expect(screen.getByRole("menuitem", { name: "删除文件夹" }).querySelector("svg.animate-spin"))
      .toBeNull();
  });

  it("treats a Noselect parent as a group and disables actions that need SELECT", () => {
    const group: EmailFolder = {
      ...folder,
      name: "Spam",
      delimiter: "/",
      hasChildren: true,
      flags: "\\noselect \\haschildren",
      unreadCount: 0,
    };
    const child: EmailFolder = {
      ...folder,
      name: "Spam/Archive",
      hasChildren: false,
      flags: "",
    };
    Object.assign(mocks.state, { foldersByAccount: { [account.id]: [group, child] } });
    render(<FolderTree gatewayUrl="http://127.0.0.1:17173" />);

    expect(screen.getByText("Spam/Archive")).toBeVisible();
    fireEvent.click(screen.getByText("Spam"));
    expect(mocks.state.selectAccount).not.toHaveBeenCalled();
    expect(mocks.state.selectFolder).not.toHaveBeenCalled();
    expect(screen.queryByText("Spam/Archive")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Spam"));
    expect(screen.getByText("Spam/Archive")).toBeVisible();

    openFolderMenu("Spam");
    expect(screen.getByRole("menuitem", { name: "全部标为已读" })).toHaveAttribute("data-disabled");
    expect(screen.getByRole("menuitem", { name: "清空垃圾邮件" })).toHaveAttribute("data-disabled");
  });
});
