import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const onOpenChange = vi.fn();

vi.mock("./store/emailStore", () => ({
  useEmailStore: (selector: (state: { addAccount: () => Promise<void>; updateAccount: () => Promise<void> }) => unknown) =>
    selector({ addAccount: async () => {}, updateAccount: async () => {} }),
}));
vi.mock("./lib/emailApi", () => ({ testConnection: vi.fn() }));
vi.mock("@/lib/tauri", () => ({ openExternalUrl: vi.fn() }));

import { NewAccountDialog } from "./NewAccountDialog";

describe("NewAccountDialog", () => {
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
});
