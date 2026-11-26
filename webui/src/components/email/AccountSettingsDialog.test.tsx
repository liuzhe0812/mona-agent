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

describe("AccountSettingsDialog", () => {
  beforeEach(() => {
    mocks.updateAccount.mockReset().mockResolvedValue(undefined);
    mocks.listRules.mockReset().mockResolvedValue([]);
  });
  afterEach(cleanup);

  it("defaults older accounts to three months and restores a saved choice", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const { rerender } = render(<AccountSettingsDialog open account={account} onOpenChange={onOpenChange} />);

    await user.click(screen.getByText("更多设置"));
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
    await user.click(screen.getByText("更多设置"));
    expect(screen.getByRole("button", { name: "历史正文离线保存" })).toHaveTextContent("近一年");
  });

  it("saves the account and untrimmed password while preserving the sender name", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<AccountSettingsDialog open account={{ ...account, fromName: "原发信名称" }} onOpenChange={onOpenChange} />);

    expect(screen.queryByRole("tab", { name: "密码" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("发信名称")).not.toBeInTheDocument();
    const password = screen.getByLabelText(/密码.*授权码/);
    expect(password).toBeVisible();

    const address = screen.getByLabelText(/^(邮箱|邮件)账号$/);
    await user.clear(address);
    await user.type(address, "updated@example.invalid");
    await user.type(password, "  新密码  ");
    await user.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(mocks.updateAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        fromAddress: "updated@example.invalid",
        imapUsername: "updated@example.invalid",
        smtpUsername: "updated@example.invalid",
        fromName: "原发信名称",
      }),
      "  新密码  ",
    ));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it.each([110, 995])("blocks POP3 port %i until the IMAP settings are corrected", async (port) => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<AccountSettingsDialog open account={{ ...account, imapPort: port }} onOpenChange={onOpenChange} />);

    const message = "这是 POP3 端口，Mona 收信需要 IMAP。请使用邮箱服务商提供的 IMAP 地址和端口（SSL 通常为 993）。";
    expect(screen.getByLabelText("收件端口（IMAP）")).toHaveAccessibleDescription(message);
    expect(screen.getByLabelText("收件端口（IMAP）")).toHaveAttribute("aria-invalid", "true");

    await user.click(screen.getByRole("tab", { name: "签名" }));
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(mocks.updateAccount).not.toHaveBeenCalled();
    expect(screen.getByText(message)).toBeVisible();

    const host = screen.getByLabelText("收件服务器（IMAP）");
    await user.clear(host);
    await user.type(host, "imap.example.invalid");
    const portInput = screen.getByLabelText("收件端口（IMAP）");
    await user.clear(portInput);
    await user.type(portInput, "993");
    expect(screen.queryByText(message)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(mocks.updateAccount).toHaveBeenCalledWith(
      expect.objectContaining({ imapHost: "imap.example.invalid", imapPort: 993 }),
      null,
    ));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
