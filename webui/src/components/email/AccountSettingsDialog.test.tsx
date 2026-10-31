import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmailAccount } from "./lib/types";

const mocks = vi.hoisted(() => ({ updateAccount: vi.fn(), listRules: vi.fn() }));

vi.mock("./store/emailStore", () => ({
  useEmailStore: (selector: (state: { updateAccount: typeof mocks.updateAccount; gatewayUrl: string; foldersByAccount: object }) => unknown) =>
    selector({ updateAccount: mocks.updateAccount, gatewayUrl: "", foldersByAccount: {} }),
}));
vi.mock("./lib/emailApi", () => ({ listRules: mocks.listRules }));

import { AccountSettingsDialog } from "./AccountSettingsDialog";

const account: EmailAccount = {
  id: "account-a",
  displayName: "Example",
  imapHost: "imap.example.invalid",
  imapPort: 993,
  imapUsername: "reader@example.invalid",
  imapPassword: "",
  smtpHost: "smtp.example.invalid",
  smtpPort: 465,
  smtpUsername: "reader@example.invalid",
  smtpPassword: "",
  fromAddress: "reader@example.invalid",
  imapUseSsl: true,
  smtpUseSsl: true,
};

describe("AccountSettingsDialog offline history", () => {
  beforeEach(() => {
    mocks.updateAccount.mockReset().mockResolvedValue(undefined);
    mocks.listRules.mockReset().mockResolvedValue([]);
  });
  afterEach(cleanup);

  it("defaults older accounts to three months and restores a saved choice", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const { rerender } = render(<AccountSettingsDialog open account={account} onOpenChange={onOpenChange} />);

    expect(screen.getByRole("button", { name: "历史正文离线保存" })).toHaveTextContent("近三个月");
    expect(screen.getByText(/正文搜索覆盖已下载的邮件/)).toBeVisible();
    expect(mocks.updateAccount).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "历史正文离线保存" }));
    await user.click(await screen.findByRole("menuitem", { name: "近一年" }));
    await user.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(mocks.updateAccount).toHaveBeenCalledWith(expect.objectContaining({ offlineSyncDays: 365 }), null));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    rerender(<AccountSettingsDialog open={false} account={account} onOpenChange={onOpenChange} />);
    rerender(<AccountSettingsDialog open account={{ ...account, offlineSyncDays: 365 }} onOpenChange={onOpenChange} />);
    expect(screen.getByRole("button", { name: "历史正文离线保存" })).toHaveTextContent("近一年");
  });
});
