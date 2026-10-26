import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EmailAccount, EmailMessage } from "../lib/types";

const mocks = vi.hoisted(() => ({
  getMessages: vi.fn(),
  getUnifiedInbox: vi.fn(),
  syncEmail: vi.fn(),
  getUnreadCounts: vi.fn(),
  fetchEmailBody: vi.fn(),
  showNotification: vi.fn(),
}));

vi.mock("../lib/emailApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/emailApi")>()),
  getMessages: mocks.getMessages,
  getUnifiedInbox: mocks.getUnifiedInbox,
  syncEmail: mocks.syncEmail,
  getUnreadCounts: mocks.getUnreadCounts,
  fetchEmailBody: mocks.fetchEmailBody,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(vi.fn()) }));
vi.mock("@/lib/tauri", () => ({ showNotification: mocks.showNotification }));

import { useEmailStore } from "./emailStore";

const makeAccount = (id: string): EmailAccount => ({
  id,
  displayName: `Account ${id}`,
  imapHost: "imap.example.invalid",
  imapPort: 993,
  imapUsername: "user",
  imapPassword: "",
  smtpHost: "smtp.example.invalid",
  smtpPort: 465,
  smtpUsername: "user",
  smtpPassword: "",
  fromAddress: "user@example.invalid",
  imapUseSsl: true,
  smtpUseSsl: true,
});

const makeMessage = (overrides: Partial<EmailMessage> = {}): EmailMessage => ({
  uid: "42",
  accountId: "account-a",
  folder: "INBOX",
  subject: "Original subject",
  fromAddress: "sender@example.invalid",
  fromName: "Original sender",
  toAddresses: "",
  date: "2026-10-26T00:00:00Z",
  bodyText: "",
  bodyHtml: null,
  attachments: [],
  bodyFetched: false,
  hasAttachments: false,
  isRead: false,
  isStarred: false,
  rawSize: 100,
  ...overrides,
});

describe("email mailbox refresh", () => {
  beforeEach(() => {
    mocks.getMessages.mockReset().mockResolvedValue([]);
    mocks.getUnifiedInbox.mockReset().mockResolvedValue([]);
    mocks.syncEmail.mockReset().mockResolvedValue({ newCount: 0, newMessages: [] });
    mocks.getUnreadCounts.mockReset().mockResolvedValue({});
    mocks.fetchEmailBody.mockReset().mockResolvedValue({ bodyText: "", bodyHtml: null, attachments: [] });
    mocks.showNotification.mockReset().mockResolvedValue(undefined);
    useEmailStore.setState({
      accounts: [],
      selectedAccountId: "account-a",
      selectedFolder: "INBOX",
      messages: [],
      selectedMessage: null,
      selectedUids: new Set(),
      anchorUid: null,
      isUnifiedInbox: false,
      lastMailboxUpdate: null,
      bodyCache: {},
      backgroundSyncing: false,
    });
  });

  it("merges local identity and flags while preserving loaded body, attachment and selection", async () => {
    const attachment = { filename: "report.pdf", contentType: "application/pdf", size: 20, partId: "1" };
    const original = makeMessage({
      messageId: "<same@example.invalid>",
      bodyText: "cached body",
      bodyHtml: "<p>cached body</p>",
      attachments: [attachment],
      bodyFetched: true,
    });
    const selectedUids = new Set(["42:account-a"]);
    useEmailStore.setState({
      messages: [original],
      selectedMessage: original,
      selectedUids,
      anchorUid: "42:account-a",
    });
    mocks.getMessages.mockResolvedValue([
      makeMessage({
        subject: "Updated subject",
        fromAddress: "updated@example.invalid",
        fromName: "Updated sender",
        messageId: "<same@example.invalid>",
        bodyFetched: true,
        isRead: true,
        isStarred: true,
      }),
    ]);

    await useEmailStore.getState().refreshMailboxFromDb("account-a", "INBOX");

    const state = useEmailStore.getState();
    expect(mocks.getMessages).toHaveBeenCalledWith("account-a", "INBOX", null, 50);
    expect(state.messages[0]).toMatchObject({
      subject: "Updated subject",
      fromAddress: "updated@example.invalid",
      fromName: "Updated sender",
      isRead: true,
      isStarred: true,
      bodyText: "cached body",
      bodyHtml: "<p>cached body</p>",
      attachments: [attachment],
      bodyFetched: true,
    });
    expect(state.selectedMessage).toMatchObject({
      uid: "42",
      subject: "Updated subject",
      isRead: true,
      isStarred: true,
      bodyText: "cached body",
      attachments: [attachment],
    });
    expect(state.selectedUids).toBe(selectedUids);
    expect(state.anchorUid).toBe("42:account-a");
    expect(state.lastMailboxUpdate).toMatchObject({ accountId: "account-a", folder: "INBOX", version: 1 });
    expect(mocks.syncEmail).not.toHaveBeenCalled();
    expect(mocks.showNotification).not.toHaveBeenCalled();
  });

  it("invalidates a reused UID body and reloads the selected message without mixing identities", async () => {
    type BodyResult = {
      bodyText: string;
      bodyHtml: string | null;
      attachments: NonNullable<EmailMessage["attachments"]>;
      header: {
        subject: string;
        fromAddress: string;
        fromName: string;
        toAddresses: string;
        ccAddresses: string;
      };
    };
    let resolveOldBody!: (value: BodyResult) => void;
    const oldBodyRequest = new Promise<BodyResult>((resolve) => {
      resolveOldBody = resolve;
    });
    mocks.fetchEmailBody
      .mockReturnValueOnce(oldBodyRequest)
      .mockResolvedValueOnce({
        bodyText: "new message body",
        bodyHtml: "<p>new message body</p>",
        attachments: [],
        header: {
          subject: "New subject",
          fromAddress: "new@example.invalid",
          fromName: "New sender",
          toAddresses: "",
          ccAddresses: "",
        },
      });

    const oldMessage = makeMessage({
      messageId: "<old@example.invalid>",
      subject: "Old subject",
      bodyText: "old message body",
      bodyHtml: "<p>old message body</p>",
      bodyFetched: true,
    });
    const cacheKey = "42:account-a:INBOX";
    useEmailStore.setState({
      messages: [oldMessage],
      selectedMessage: oldMessage,
      bodyCache: {},
    });
    const oldBodyLoad = useEmailStore.getState().fetchBody(oldMessage);
    useEmailStore.setState({
      bodyCache: {
        [cacheKey]: {
          bodyText: "old message body",
          bodyHtml: "<p>old message body</p>",
          attachments: [],
        },
      },
    });
    mocks.getMessages.mockResolvedValue([
      makeMessage({
        messageId: "<new@example.invalid>",
        subject: "New subject",
        fromAddress: "new@example.invalid",
        fromName: "New sender",
        date: "2026-10-26T01:00:00Z",
        rawSize: 200,
        bodyFetched: false,
      }),
    ]);

    await useEmailStore.getState().refreshMailboxFromDb("account-a", "INBOX");

    expect(useEmailStore.getState().bodyCache[cacheKey]).toBeUndefined();
    expect(useEmailStore.getState().selectedMessage).toMatchObject({
      messageId: "<new@example.invalid>",
      bodyText: "",
    });

    resolveOldBody({
      bodyText: "old message body",
      bodyHtml: "<p>old message body</p>",
      attachments: [],
      header: {
        subject: "Old subject",
        fromAddress: "old@example.invalid",
        fromName: "Old sender",
        toAddresses: "",
        ccAddresses: "",
      },
    });
    await oldBodyLoad;
    await vi.waitFor(() => {
      expect(useEmailStore.getState().selectedMessage).toMatchObject({
        messageId: "<new@example.invalid>",
        subject: "New subject",
        bodyText: "new message body",
      });
    });

    const state = useEmailStore.getState();
    expect(state.messages[0]).toMatchObject({
      messageId: "<new@example.invalid>",
      subject: "New subject",
      bodyText: "new message body",
      bodyHtml: "<p>new message body</p>",
    });
    expect(mocks.fetchEmailBody).toHaveBeenCalledTimes(2);
  });

  it("does not reuse a cached body when the refreshed row says its body is missing", async () => {
    mocks.fetchEmailBody.mockResolvedValue({
      bodyText: "reloaded body",
      bodyHtml: null,
      attachments: [],
    });
    const message = makeMessage({ messageId: "<same@example.invalid>", bodyText: "cached body", bodyFetched: true });
    const cacheKey = "42:account-a:INBOX";
    useEmailStore.setState({
      messages: [message],
      selectedMessage: message,
      bodyCache: { [cacheKey]: { bodyText: "cached body", bodyHtml: null, attachments: [] } },
    });
    mocks.getMessages.mockResolvedValue([
      makeMessage({ messageId: "<same@example.invalid>", bodyFetched: false }),
    ]);

    await useEmailStore.getState().refreshMailboxFromDb("account-a", "INBOX");
    await vi.waitFor(() => {
      expect(useEmailStore.getState().selectedMessage?.bodyText).toBe("reloaded body");
    });

    expect(mocks.fetchEmailBody).toHaveBeenCalledOnce();
    expect(useEmailStore.getState().bodyCache[cacheKey]?.bodyText).toBe("reloaded body");
  });

  it("uses the account and mailbox supplied by an IDLE event and keeps default INBOX sync", async () => {
    const accountA = makeAccount("account-a");
    const accountB = makeAccount("account-b");
    useEmailStore.setState({ accounts: [accountA, accountB], selectedAccountId: "account-b", selectedFolder: "Archive" });

    await useEmailStore.getState().syncAllAccounts("http://127.0.0.1:17174", true, "account-b", "Archive");

    expect(mocks.syncEmail).toHaveBeenCalledTimes(1);
    expect(mocks.syncEmail).toHaveBeenCalledWith("http://127.0.0.1:17174", accountB, "Archive");

    mocks.syncEmail.mockClear();
    await useEmailStore.getState().syncAllAccounts("http://127.0.0.1:17174", true);

    expect(mocks.syncEmail).toHaveBeenCalledTimes(2);
    expect(mocks.syncEmail).toHaveBeenNthCalledWith(1, "http://127.0.0.1:17174", accountA, "INBOX");
    expect(mocks.syncEmail).toHaveBeenNthCalledWith(2, "http://127.0.0.1:17174", accountB, "INBOX");
  });

  it("deduplicates a background notification for the same message", async () => {
    useEmailStore.setState({ accounts: [makeAccount("account-a")] });
    const message = makeMessage({ uid: "background-notification-unique" });

    await useEmailStore.getState().notifyBackgroundNewMail("account-a", 1, [message]);
    await useEmailStore.getState().notifyBackgroundNewMail("account-a", 1, [message]);

    expect(mocks.showNotification).toHaveBeenCalledOnce();
  });
});
