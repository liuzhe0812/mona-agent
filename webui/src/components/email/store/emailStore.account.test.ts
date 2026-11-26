import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EmailAccount, EmailAnalysis, EmailFolder, EmailMessage } from "../lib/types";

const mocks = vi.hoisted(() => ({
  updateAccountSettings: vi.fn(),
  getFolders: vi.fn(),
  syncFolders: vi.fn(),
  getUnreadCounts: vi.fn(),
  startIdle: vi.fn(),
  stopIdle: vi.fn(),
  message: vi.fn(),
}));

vi.mock("../lib/emailApi", () => mocks);
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(vi.fn()) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ message: mocks.message }));
vi.mock("@/lib/tauri", () => ({ showNotification: vi.fn() }));

import { useEmailStore } from "./emailStore";

const gatewayUrl = "http://127.0.0.1:17174";
const oldAccount: EmailAccount = {
  id: "old-id", displayName: "Mailbox", fromAddress: "old@example.test",
  imapHost: "imap.old.test", imapPort: 993, imapUsername: "old@example.test", imapPassword: "encrypted",
  imapUseSsl: true, smtpHost: "smtp.old.test", smtpPort: 465, smtpUsername: "old@example.test",
  smtpPassword: "encrypted", smtpUseSsl: true,
};
const nextAccount: EmailAccount = {
  ...oldAccount, id: "new-id", fromAddress: "new@example.test",
  imapHost: "imap.new.test", imapUsername: "new@example.test",
};
const otherAccount = { ...oldAccount, id: "other-id" };
const folder = (name: string): EmailFolder => ({ name, delimiter: "/", flags: "", hasChildren: false, unreadCount: 0 });
const mail = (accountId: string, uid: string): EmailMessage => ({
  uid, accountId, folder: "INBOX", subject: uid, fromAddress: "sender@example.test",
  toAddresses: "", date: "2026-11-24", bodyText: "", hasAttachments: false,
  isRead: false, isStarred: false, rawSize: 0,
});

describe("email account settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateAccountSettings.mockReset().mockResolvedValue(nextAccount);
    mocks.getFolders.mockReset().mockResolvedValue([]);
    mocks.syncFolders.mockReset().mockResolvedValue([folder("INBOX")]);
    mocks.getUnreadCounts.mockReset().mockResolvedValue({});
    mocks.startIdle.mockReset().mockResolvedValue(undefined);
    mocks.stopIdle.mockReset().mockResolvedValue(undefined);
    mocks.message.mockReset().mockResolvedValue(undefined);
    useEmailStore.setState({
      accounts: [oldAccount, otherAccount], gatewayUrl, selectedAccountId: oldAccount.id,
      selectedFolder: "Junk", folders: [folder("Junk")],
      foldersByAccount: { [oldAccount.id]: [folder("Junk")], [otherAccount.id]: [folder("INBOX")] },
      foldersLoading: false, foldersError: null, messages: [mail(oldAccount.id, "1")],
      selectedMessage: mail(oldAccount.id, "1"), selectedUids: new Set(["1:old-id"]),
      anchorUid: "1:old-id", isUnifiedInbox: false, hasMore: true, totalUnreadCount: 0, error: null,
      bodyCache: { "1:old-id:INBOX": { bodyText: "old body", bodyHtml: null }, "2:other-id:INBOX": { bodyText: "other", bodyHtml: null } },
      bodyLoadingStage: { "1:old-id:INBOX": "local" },
      analysisCache: { "1:old-id:INBOX": { accountId: oldAccount.id } as EmailAnalysis },
    });
  });

  it("switches identities, clears old state, and waits for the new folder refresh", async () => {
    let resolveFolders!: (folders: EmailFolder[]) => void;
    mocks.syncFolders.mockReturnValue(new Promise<EmailFolder[]>((resolve) => { resolveFolders = resolve; }));
    const saving = useEmailStore.getState().updateAccount({ ...nextAccount, id: oldAccount.id }, "new password");
    await vi.waitFor(() => expect(mocks.syncFolders).toHaveBeenCalledWith(gatewayUrl, nextAccount));

    let state = useEmailStore.getState();
    expect(state.accounts).toEqual([nextAccount, otherAccount]);
    expect(state.selectedAccountId).toBe(nextAccount.id);
    expect(state.selectedFolder).toBe("INBOX");
    expect(state.foldersByAccount[oldAccount.id]).toBeUndefined();
    expect(state.messages).toEqual([]);
    expect(state.selectedMessage).toBeNull();
    expect(state.selectedUids.size).toBe(0);
    expect(state.anchorUid).toBeNull();
    expect(state.bodyCache["1:old-id:INBOX"]).toBeUndefined();
    expect(state.bodyCache["2:other-id:INBOX"].bodyText).toBe("other");
    expect(state.analysisCache["1:old-id:INBOX"]).toBeUndefined();
    expect(state.bodyLoadingStage["1:old-id:INBOX"]).toBeUndefined();

    resolveFolders([folder("INBOX"), folder("垃圾邮件")]);
    await saving;
    state = useEmailStore.getState();
    expect(state.foldersByAccount[nextAccount.id].map((item) => item.name)).toEqual(["INBOX", "垃圾邮件"]);
    expect(state.folders).toEqual(state.foldersByAccount[nextAccount.id]);
    expect(mocks.stopIdle).toHaveBeenCalledWith(gatewayUrl, oldAccount.id);
    expect(mocks.startIdle).toHaveBeenCalledWith(gatewayUrl, nextAccount, "INBOX");
    expect(mocks.stopIdle.mock.invocationCallOrder[0]).toBeLessThan(mocks.startIdle.mock.invocationCallOrder[0]);
    expect(mocks.message).not.toHaveBeenCalled();
  });

  it("removes only the old identity from the unified inbox", async () => {
    const oldMessage = mail(oldAccount.id, "1");
    const otherMessage = mail(otherAccount.id, "2");
    useEmailStore.setState({
      isUnifiedInbox: true, selectedAccountId: null, messages: [oldMessage, otherMessage],
      selectedMessage: oldMessage, selectedUids: new Set(["1:old-id", "2:other-id"]), anchorUid: "1:old-id",
    });

    await useEmailStore.getState().updateAccount({ ...nextAccount, id: oldAccount.id });

    const state = useEmailStore.getState();
    expect(state.isUnifiedInbox).toBe(true);
    expect(state.selectedAccountId).toBeNull();
    expect(state.messages).toEqual([otherMessage]);
    expect(state.selectedMessage).toBeNull();
    expect([...state.selectedUids]).toEqual(["2:other-id"]);
    expect(state.anchorUid).toBeNull();
  });

  it("restarts the same identity for a password change but not for a display name change", async () => {
    mocks.updateAccountSettings.mockResolvedValue(oldAccount);
    await useEmailStore.getState().updateAccount(oldAccount, "  password  ");
    expect(mocks.startIdle).toHaveBeenCalledWith(gatewayUrl, oldAccount, "INBOX");
    expect(mocks.stopIdle).not.toHaveBeenCalled();
    expect(mocks.syncFolders).not.toHaveBeenCalled();
    expect(useEmailStore.getState().messages).toHaveLength(1);

    mocks.startIdle.mockClear();
    const renamed = { ...oldAccount, displayName: "Renamed" };
    mocks.updateAccountSettings.mockResolvedValue(renamed);
    await useEmailStore.getState().updateAccount(renamed);
    expect(mocks.startIdle).not.toHaveBeenCalled();
  });

  it("ignores a late folder response from the retired identity", async () => {
    let resolveOld!: (folders: EmailFolder[]) => void;
    mocks.getFolders.mockResolvedValue([folder("Junk")]);
    mocks.syncFolders.mockImplementation((_url, account: EmailAccount) => account.id === oldAccount.id
      ? new Promise<EmailFolder[]>((resolve) => { resolveOld = resolve; })
      : Promise.resolve([folder("INBOX"), folder("垃圾邮件")]));
    await useEmailStore.getState().loadFolders(gatewayUrl, oldAccount.id);
    await vi.waitFor(() => expect(resolveOld).toBeDefined());

    await useEmailStore.getState().updateAccount({ ...nextAccount, id: oldAccount.id });
    resolveOld([folder("Junk")]);
    await vi.waitFor(() => expect(mocks.getUnreadCounts).toHaveBeenCalledTimes(2));
    await Promise.resolve();

    const state = useEmailStore.getState();
    expect(state.foldersByAccount[oldAccount.id]).toBeUndefined();
    expect(state.folders.map((item) => item.name)).toEqual(["INBOX", "垃圾邮件"]);
  });

  it("reports follow-up failures without reporting that saving failed", async () => {
    mocks.syncFolders.mockRejectedValue(new Error("private detail"));
    mocks.startIdle.mockRejectedValue(new Error("private detail"));

    await expect(useEmailStore.getState().updateAccount({ ...nextAccount, id: oldAccount.id })).resolves.toBeUndefined();

    expect(useEmailStore.getState().accounts[0]).toEqual(nextAccount);
    expect(mocks.message).toHaveBeenCalledOnce();
    const message = mocks.message.mock.calls[0][0];
    expect(message).toContain("邮箱设置已保存");
    expect(message).toContain("文件夹刷新失败");
    expect(message).toContain("实时收信未能更新");
    expect(message).not.toContain("private detail");
  });
});
