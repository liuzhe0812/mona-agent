import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const onOpenChange = vi.fn();
const mocks = vi.hoisted(() => ({ addAccount: vi.fn(), updateAccount: vi.fn() }));

vi.mock("./store/emailStore", () => ({
  useEmailStore: (selector: (state: { addAccount: () => Promise<void>; updateAccount: () => Promise<void> }) => unknown) =>
    selector(mocks),
}));
vi.mock("./lib/emailApi", () => ({ testConnection: vi.fn() }));
vi.mock("@/lib/tauri", () => ({ openExternalUrl: vi.fn() }));

import { NewAccountDialog } from "./NewAccountDialog";

describe("NewAccountDialog", () => {
  beforeEach(() => {
    onOpenChange.mockReset();
    mocks.addAccount.mockReset().mockResolvedValue(undefined);
    mocks.updateAccount.mockReset().mockResolvedValue(undefined);
  });

  it("closes only through the X button", () => {
    const { container } = render(
      <NewAccountDialog open onOpenChange={onOpenChange} />,
    );

    fireEvent.click(container.firstElementChild!);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "取消" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("applies the Tencent enterprise mailbox preset", () => {
    render(<NewAccountDialog open onOpenChange={onOpenChange} />);

    fireEvent.click(screen.getByRole("button", { name: "腾讯企业邮箱" }));

    expect(screen.getByPlaceholderText("imap.example.com")).toHaveValue("imap.exmail.qq.com");
    expect(screen.getByPlaceholderText("smtp.example.com")).toHaveValue("smtp.exmail.qq.com");
    expect(screen.getByDisplayValue("993")).toBeInTheDocument();
    expect(screen.getByDisplayValue("465")).toBeInTheDocument();
  });

  it("lets a new account choose its offline history before it is saved", async () => {
    const user = userEvent.setup();
    render(<NewAccountDialog open onOpenChange={onOpenChange} />);

    const range = screen.getByRole("button", { name: "历史正文离线保存" });
    expect(range).toHaveTextContent("近三个月");
    expect(screen.getByText(/正文搜索覆盖已下载的邮件/)).toBeVisible();
    expect(mocks.addAccount).not.toHaveBeenCalled();
    await user.click(range);
    await user.click(await screen.findByRole("menuitem", { name: "全部" }));
    expect(screen.getByText("保存全部历史正文需要更多时间和磁盘空间。")).toBeVisible();
    expect(mocks.addAccount).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "腾讯企业邮箱" }));
    fireEvent.change(screen.getByPlaceholderText("you@example.com"), { target: { value: "reader@example.invalid" } });
    fireEvent.change(screen.getByPlaceholderText("邮箱密码或授权码"), { target: { value: crypto.randomUUID() } });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));

    await waitFor(() => expect(mocks.addAccount).toHaveBeenCalledWith(expect.objectContaining({ offlineSyncDays: 0 })));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
