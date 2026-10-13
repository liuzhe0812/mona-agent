import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), logout: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/lib/tauri", () => ({ isTauri: () => true }));
vi.mock("@/hooks/useLicense", () => ({
  useLicense: () => ({
    loggedIn: true,
    licenseInfo: { account: "mona-user", email: "user@example.com", expires_at: "2027-08-27" },
    licenseActive: true,
    serverTrial: false,
    remainingDays: 0,
    logout: mocks.logout,
  }),
}));

import { AccountSettings } from "./AccountSettings";

describe("AccountSettings", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.logout.mockReset();
    mocks.invoke.mockImplementation((command: string) => Promise.resolve(command === "list_login_devices"
      ? { devices: [{ id: "a".repeat(32), revision: 1, name: "测试电脑", platform: "windows", current: true,
          bound_at: "2026-10-12T00:00:00Z", last_seen_at: "2026-10-12T08:00:00Z" }], device_limit: 3, plan: "pro" }
      : { available_amount: "120", reserved_amount: "5" }));
  });

  it("exposes the real login device list directly under account settings", async () => {
    render(<AccountSettings />);
    await screen.findByRole("button", { name: "移除 测试电脑" });
    expect(screen.getByRole("region", { name: "登录设备" })).toBeInTheDocument();
    expect(screen.getByLabelText("设备名额")).toHaveTextContent("1 / 3 台");
    expect(screen.queryByRole("button", { name: "管理设备" })).not.toBeInTheDocument();
  });

  it("surfaces failed logout in a dialog without exposing the native exception", async () => {
    mocks.logout.mockRejectedValue(new Error("network stack SENSITIVE"));
    render(<AccountSettings />);
    fireEvent.click(screen.getByRole("button", { name: "退出登录" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("退出登录未确认");
    expect(dialog).not.toHaveTextContent("SENSITIVE");
  });

  it("shows balance as a summary without duplicating navigation actions", async () => {
    const onOpenBilling = vi.fn();
    render(<AccountSettings onOpenBilling={onOpenBilling} />);

    await waitFor(() => expect(screen.getByText(/可用 ¥120/)).toBeInTheDocument());
    const billingButton = screen.getByRole("button", { name: "充值" });
    expect(billingButton).toBeInTheDocument();
    billingButton.click();
    expect(onOpenBilling).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: /查看用量/ })).not.toBeInTheDocument();
  });
});
