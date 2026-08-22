import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async (command: string) =>
    command === "email_unread_counts" ? { INBOX: 0 } : undefined,
  ),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(vi.fn()),
}));
vi.mock("@/lib/tauri", () => ({ showNotification: vi.fn() }));

import { syncEmailReadChange, useEmailStore } from "./emailStore";
import type { EmailMessage } from "../lib/types";

const unreadMessage = (accountId: string): EmailMessage => ({
  uid: "42",
  accountId,
  folder: "INBOX",
  subject: "subject",
  fromAddress: "sender@example.com",
  toAddresses: "user@example.com",
  date: "2026-08-20",
  bodyText: "",
  hasAttachments: false,
  isRead: false,
  isStarred: false,
  rawSize: 0,
});

describe("email read synchronization", () => {
  beforeEach(() => {
    mocks.invoke.mockClear();
    const message = unreadMessage("account-a");
    useEmailStore.setState({
      folders: [{ name: "INBOX", delimiter: "/", hasChildren: false, flags: "", unreadCount: 1 }],
      foldersByAccount: {
        "account-a": [{ name: "INBOX", delimiter: "/", hasChildren: false, flags: "", unreadCount: 1 }],
      },
      messages: [message, unreadMessage("account-b")],
      selectedMessage: message,
      selectedAccountId: "account-a",
      selectedFolder: "INBOX",
      totalUnreadCount: 1,
    });
  });

  it("updates only the matching mail and refreshes unread badges", async () => {
    syncEmailReadChange({
      accountId: "account-a",
      folder: "INBOX",
      uid: "42",
      isRead: true,
    });

    expect(useEmailStore.getState().messages.map((message) => message.isRead)).toEqual([true, false]);
    expect(useEmailStore.getState().selectedMessage?.isRead).toBe(true);
    await vi.waitFor(() => expect(useEmailStore.getState().totalUnreadCount).toBe(0));
    expect(mocks.invoke).toHaveBeenCalledWith("set_tray_unread_count", { count: 0 });
  });
});
