import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const state: Record<string, any> = {
    accounts: [],
    selectedAccountId: null,
    selectedFolder: "INBOX",
    selectedMessage: null,
    messages: [],
    foldersByAccount: {},
    foldersLoading: false,
    foldersError: null,
    isUnifiedInbox: false,
    syncing: false,
    backgroundSyncing: false,
    isOnline: true,
    selectedUids: new Set<string>(),
    loadAccounts: vi.fn(),
    loadContacts: vi.fn(),
    loadMessages: vi.fn(),
    loadFolders: vi.fn(),
    selectAccount: vi.fn(),
    selectFolder: vi.fn(),
    selectUnifiedInbox: vi.fn(),
    selectMessage: vi.fn(),
    toggleRead: vi.fn(),
    toggleStarred: vi.fn(),
    syncMail: vi.fn(),
    syncAllAccounts: vi.fn(),
    checkGatewayHealth: vi.fn(),
    setGatewayUrl: vi.fn(),
    reorderAccounts: vi.fn(),
    markAllRead: vi.fn(),
    emptyFolder: vi.fn(),
    removeAccount: vi.fn(),
    updateAccount: vi.fn(),
    addAccount: vi.fn(),
    gatewayUrl: "",
  };
  const useEmailStore = Object.assign(
    (selector: (current: typeof state) => unknown) => selector(state),
    { getState: () => state },
  );
  return { state, useEmailStore, addFromEmail: vi.fn(), getServicesHttpBase: vi.fn() };
});

vi.mock("./store/emailStore", () => ({ useEmailStore: mocks.useEmailStore }));
vi.mock("./lib/emailApi", () => ({
  openComposeWindow: vi.fn(),
  outboxProcess: vi.fn().mockResolvedValue(undefined),
  outboxList: vi.fn().mockResolvedValue([]),
  outboxDelete: vi.fn().mockResolvedValue(undefined),
  deleteFolder: vi.fn(),
  renameFolder: vi.fn(),
  listRules: vi.fn().mockResolvedValue([]),
  saveRule: vi.fn(),
  deleteRule: vi.fn(),
  applyRules: vi.fn(),
  getEmailStatistics: vi.fn().mockResolvedValue({ totalCount: 0, totalSize: 0, folders: [] }),
  createFolder: vi.fn(),
  testConnection: vi.fn(),
}));
vi.mock("@/lib/api", () => ({ getServicesHttpBase: mocks.getServicesHttpBase }));
vi.mock("@/components/schedule/todoStore", () => ({
  useTodoStore: (selector: (state: { addFromEmail: typeof mocks.addFromEmail }) => unknown) =>
    selector({ addFromEmail: mocks.addFromEmail }),
}));
vi.mock("@/components/settings/AgentSearchScopeSettings", () => ({
  AgentSearchScopeSettings: ({ source }: { source: "notes" | "email" }) => (
    <div data-testid="search-scope-settings" data-source={source} />
  ),
}));
vi.mock("./MailListView", () => ({ MailListView: () => <div /> }));
vi.mock("./MailView", () => ({ MailView: () => <div /> }));
vi.mock("./MailAgentPanel", () => ({ MailAgentPanel: () => <div /> }));
vi.mock("./contacts/ContactsView", () => ({ ContactsView: () => <div /> }));

import { EmailClientView } from "./EmailClientView";

const account = {
  id: "mail-account-1",
  displayName: "测试邮箱",
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

describe("EmailClientView settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(mocks.state, {
      accounts: [],
      selectedAccountId: null,
      foldersByAccount: {},
      gatewayUrl: "",
    });
    mocks.getServicesHttpBase.mockResolvedValue("");
  });

  it("opens module search-scope settings when no email account is configured", async () => {
    render(<EmailClientView />);

    expect(screen.getByText("还没有邮箱账号")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "设置" }));

    expect(await screen.findByRole("dialog", { name: "邮件设置" })).toBeInTheDocument();
    expect(screen.getByTestId("search-scope-settings")).toHaveAttribute("data-source", "email");

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "邮件设置" })).not.toBeInTheDocument());
  });

  it("keeps per-account settings reachable from the account menu", async () => {
    mocks.state.accounts = [account];
    render(<EmailClientView />);

    fireEvent.contextMenu(screen.getByText("测试邮箱"), { button: 2, clientX: 20, clientY: 20 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "设置..." }));

    const settingsDialog = await screen.findByRole("dialog", { name: "邮箱设置" });
    expect(settingsDialog).toBeInTheDocument();

    fireEvent.click(within(settingsDialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "邮箱设置" })).not.toBeInTheDocument());
  });
});
