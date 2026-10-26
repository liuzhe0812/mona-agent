import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(), logout: vi.fn(),
  license: { active: true, trial: false, days: 30, expiresAt: "2027-08-27" as string | null },
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/lib/tauri", () => ({ isTauri: () => true }));
vi.mock("@/lib/cloud-sync", () => ({
  cloudSyncApi: { status: () => Promise.resolve({ available: true, enabled: false, plan: "free" }) },
}));
vi.mock("@/hooks/useLicense", () => ({
  useLicense: () => ({
    loggedIn: true,
    licenseInfo: { account: "mona-user", email: "user@example.com", expires_at: mocks.license.expiresAt },
    licenseActive: mocks.license.active,
    serverTrial: mocks.license.trial,
    remainingDays: mocks.license.days,
    logout: mocks.logout,
  }),
}));

import { AccountSettings } from "./AccountSettings";

describe("AccountSettings", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.logout.mockReset();
    mocks.license = { active: true, trial: false, days: 30, expiresAt: "2027-08-27" };
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "list_login_devices") return Promise.resolve({
        devices: [{ id: "a".repeat(32), revision: 1, name: "测试电脑", platform: "windows", current: true,
          bound_at: "2026-10-12T00:00:00Z", last_seen_at: "2026-10-12T08:00:00Z" }], device_limit: 3, plan: "pro",
      });
      if (command === "get_credit_balance") return Promise.resolve({ available_amount: "120", reserved_amount: "5" });
      if (command === "get_credit_products") return Promise.resolve({ recharge_enabled: true,
        products: [{ code: "starter", name: "入门包", price: "10.00", balance_amount: "10" }],
      });
      if (command === "get_credit_orders") return Promise.resolve({ orders: [{
        order_id: 1, trade_order_id: "credit_order_1", amount: "10.00", status: "paid",
        fulfillment_status: "succeeded", balance_amount: "10", payment_url: null, created_at: "2026-10-12T00:00:00Z",
      }], has_more: false });
      return Promise.reject(new Error(`unexpected command: ${command}`));
    });
  });

  it.each([
    { active: true, trial: false, days: 30, expiresAt: "2027-08-27", status: "剩余 30 天" },
    { active: true, trial: true, days: 7, expiresAt: "2027-08-27", status: "试用剩余 7 天" },
    { active: true, trial: false, days: 0, expiresAt: null, status: "长期有效" },
    { active: false, trial: false, days: 0, expiresAt: null, status: "未开通" },
  ])("shows Mona Pro with $status and the subscribe action", async ({ status, ...license }) => {
    mocks.license = license;
    const onManageSubscription = vi.fn();
    render(<AccountSettings onManageSubscription={onManageSubscription} />);

    const proTitle = screen.getByText("Mona Pro", { exact: true });
    expect(proTitle).toBeInTheDocument();
    expect(within(proTitle.parentElement!).getByText(status, { exact: true })).toBeInTheDocument();
    const subscribe = screen.getByRole("button", { name: "订阅", exact: true });
    expect(within(subscribe.parentElement!).queryByText(status, { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText("当前软件权益")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "管理订阅" })).not.toBeInTheDocument();
    fireEvent.click(subscribe);
    expect(onManageSubscription).toHaveBeenCalledOnce();
    await screen.findByText("测试电脑");
  });

  it("exposes the real login device list directly under account settings", async () => {
    render(<AccountSettings />);
    await screen.findByText("测试电脑");
    expect(screen.getByRole("region", { name: "登录设备" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "云同步" })).toBeInTheDocument();
    expect(screen.getByLabelText("设备名额")).toHaveTextContent("1 / 3 台");
    expect(screen.queryByRole("button", { name: "移除 测试电脑" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "管理设备" })).not.toBeInTheDocument();
    const accountActions = screen.getByRole("button", { name: "修改密码" }).parentElement!;
    expect(within(accountActions).getByRole("button", { name: "退出登录" })).toBeInTheDocument();
    expect(screen.queryByText("账户安全", { exact: true })).not.toBeInTheDocument();
  });

  it("surfaces failed logout in a dialog without exposing the native exception", async () => {
    mocks.logout.mockRejectedValue(new Error("network stack SENSITIVE"));
    render(<AccountSettings />);
    fireEvent.click(screen.getByRole("button", { name: "退出登录" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("退出登录未确认");
    expect(dialog).not.toHaveTextContent("SENSITIVE");
  });

  it("keeps recharge choices in a dialog and refreshes the summary after closing", async () => {
    render(<AccountSettings />);

    await waitFor(() => expect(screen.getByText(/可用 ¥120/)).toBeInTheDocument());
    expect(screen.queryByText("入门包")).not.toBeInTheDocument();
    expect(mocks.invoke).not.toHaveBeenCalledWith("get_credit_products");
    expect(mocks.invoke).not.toHaveBeenCalledWith("get_credit_orders", expect.anything());
    fireEvent.click(screen.getByRole("button", { name: "充值", exact: true }));

    const dialog = await screen.findByRole("dialog", { name: "余额充值" });
    expect(await within(dialog).findByRole("button", { name: "¥10.00", exact: true })).toBeInTheDocument();
    expect(within(dialog).queryByText("最近充值订单")).not.toBeInTheDocument();
    const readsBeforeClose = mocks.invoke.mock.calls.filter(([command]) => command === "get_credit_balance").length;
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(mocks.invoke.mock.calls.filter(([command]) => command === "get_credit_balance"))
      .toHaveLength(readsBeforeClose + 1));
    expect(screen.queryByRole("button", { name: /查看用量/ })).not.toBeInTheDocument();
  });

  it("opens order history separately from recharge choices", async () => {
    render(<AccountSettings />);
    await screen.findByText(/可用 ¥120/);
    expect(screen.queryByText("已到账")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "订单记录" }));

    const dialog = await screen.findByRole("dialog", { name: "充值订单" });
    expect(await within(dialog).findByText("已到账")).toBeInTheDocument();
    expect(within(dialog).queryByText("入门包")).not.toBeInTheDocument();
    expect(mocks.invoke).not.toHaveBeenCalledWith("get_credit_products");
  });
});
