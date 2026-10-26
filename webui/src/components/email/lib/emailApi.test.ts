import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import {
  parseAddressList,
  parseEmailAddressList,
  fetchAttachment,
  getUnifiedInbox,
  saveDraft,
} from "./emailApi";
import type { EmailAccount } from "./types";

beforeEach(() => {
  mocks.invoke.mockReset().mockImplementation(async (command: string) => {
    if (command === "email_get_decrypted_password") return "";
    return { draftUid: "92", draftFolder: "Drafts" };
  });
});

describe("email address parsing", () => {
  it("preserves comma and space display names while splitting recipients", () => {
    const input = 'Doe, Jane <Jane@example.test>, "Smith, Ann" <ann@example.test>; third@example.test';

    expect(parseEmailAddressList(input)).toEqual([
      "Doe, Jane <Jane@example.test>",
      '"Smith, Ann" <ann@example.test>',
      "third@example.test",
    ]);
    expect(parseAddressList(input)).toEqual([
      "Jane@example.test",
      "ann@example.test",
      "third@example.test",
    ]);
  });
});

describe("getUnifiedInbox", () => {
  it("keeps cursorless first-page calls compatible and forwards the stable cursor", async () => {
    await getUnifiedInbox(null, 50);
    expect(mocks.invoke).toHaveBeenLastCalledWith("email_get_unified_inbox", {
      beforeDate: null,
      limit: 50,
    });

    await getUnifiedInbox("Tue, 12 Mar 2024 10:00:00 +0000", 50, "account-a", "51");
    expect(mocks.invoke).toHaveBeenLastCalledWith("email_get_unified_inbox", {
      beforeDate: "Tue, 12 Mar 2024 10:00:00 +0000",
      beforeAccountId: "account-a",
      beforeUid: "51",
      limit: 50,
    });
  });
});

describe("saveDraft", () => {
  it("sends bcc, text/html, attachments and the original draft identity", async () => {
    const account = {
      id: "account-1",
      imapHost: "imap.example.test",
      imapPort: 993,
      imapUsername: "user@example.test",
      imapPassword: "",
      imapUseSsl: true,
      smtpHost: "smtp.example.test",
      smtpPort: 465,
      smtpUsername: "user@example.test",
      smtpPassword: "",
      fromAddress: "user@example.test",
      displayName: "Test",
    } as EmailAccount;
    const result = await saveDraft(
      "http://127.0.0.1:17173",
      account,
      {
        toAddresses: "Doe, Jane <jane@example.test>",
        ccAddresses: '"Smith, Ann" <ann@example.test>',
        bccAddresses: "private@example.test",
        subject: "Draft",
        bodyText: "plain version",
        bodyHtml: "<p>html version</p>",
        inReplyTo: null,
        attachments: [{ filename: "file.txt", contentType: "text/plain", data: "eA==" }],
      },
      { draftUid: "91", draftFolder: "Drafts", draftRequestId: "draft-request-123456" },
    );

    expect(result).toEqual({ draftUid: "92", draftFolder: "Drafts" });
    expect(mocks.invoke).toHaveBeenCalledWith("email_save_draft", {
      gatewayUrl: "http://127.0.0.1:17173",
      req: expect.objectContaining({
        to: ["Doe, Jane <jane@example.test>"],
        cc: ['"Smith, Ann" <ann@example.test>'],
        bcc: ["private@example.test"],
        bodyText: "plain version",
        bodyHtml: "<p>html version</p>",
        draftUid: "91",
        draftFolder: "Drafts",
        draftRequestId: "draft-request-123456",
        attachments: [{ filename: "file.txt", contentType: "text/plain", data: "eA==" }],
      }),
    });
  });

  it("passes inline Content-ID through the local attachment IPC", async () => {
    await fetchAttachment(
      "http://127.0.0.1:17173",
      { id: "account-1", imapPort: 993 } as EmailAccount,
      "Drafts",
      "92",
      "inline.png",
      "inline-image-1",
    );

    expect(mocks.invoke).toHaveBeenLastCalledWith(
      "email_fetch_attachment",
      expect.objectContaining({
        gatewayUrl: "http://127.0.0.1:17173",
        req: expect.objectContaining({ contentId: "inline-image-1" }),
      }),
    );
  });
});
