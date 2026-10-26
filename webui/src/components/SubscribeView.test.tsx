import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(), refreshLicense: vi.fn(), fetchPricing: vi.fn(),
  paid: false, trial: false, days: 0, expiresAt: null as string | null,
  hasPricing: true, pricingError: null as string | null,
  pricing: {
    plans: [
      { id: "monthly", name: "月付", price: 5.9, durationMonths: 1 },
      { id: "quarterly", name: "季付", price: 14.9, durationMonths: 3 },
      { id: "yearly", name: "年付", price: 49.9, originalPrice: 69.9, durationMonths: 12, badge: "推荐" },
    ],
    contact: { email: "developer@example.invalid", wechat: "" },
    promotionalBanner: null, promoTrial: null,
  },
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/lib/tauri", () => ({ isTauri: () => true }));
vi.mock("@/hooks/useLicense", () => ({
  useLicense: () => ({
    pricingConfig: mocks.hasPricing ? mocks.pricing : null,
    pricingError: mocks.pricingError,
    refreshLicense: mocks.refreshLicense,
    licenseActive: mocks.paid,
    serverTrial: mocks.trial,
    remainingDays: mocks.days,
    licenseInfo: { expires_at: mocks.expiresAt },
    fetchPricing: mocks.fetchPricing,
  }),
}));
vi.mock("@/components/PaymentDialog", () => ({
  PaymentDialog: ({ onSuccess }: { onSuccess: () => void }) => (
    <div role="dialog" aria-label="订阅支付"><button onClick={onSuccess}>完成支付</button></div>
  ),
}));

import { SubscribeView } from "./SubscribeView";

const props = { userEmail: "user@example.com", onBackToLogin: vi.fn() };

describe("SubscribeView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.paid = false;
    mocks.trial = false;
    mocks.days = 0;
    mocks.expiresAt = null;
    mocks.hasPricing = true;
    mocks.pricingError = null;
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "create_subscription") {
        return Promise.resolve({ order_id: 7, trade_order_id: "order-7", payment_url: "https://pay.example/7" });
      }
      if (command === "get_subscription_info") return Promise.resolve({ auto_renew: false });
      return Promise.reject(new Error(`unexpected command: ${command}`));
    });
    mocks.refreshLicense.mockResolvedValue(undefined);
    mocks.fetchPricing.mockResolvedValue(undefined);
  });

  it("keeps Pro benefits and pricing without developer contact or duplicated titles", () => {
    render(<SubscribeView {...props} embed />);

    expect(screen.getByText("最多 3 台设备登录")).toBeInTheDocument();
    expect(screen.getByText("10GB 个人云空间")).toBeInTheDocument();
    expect(screen.getByText("Work 会话与关联文件同步")).toBeInTheDocument();
    expect(screen.queryByText("解锁笔记 AI、邮件 AI 与知识库 AI")).not.toBeInTheDocument();
    expect(screen.queryByText("解锁数据库 AI 与终端 AI")).not.toBeInTheDocument();
    expect(screen.getByText(/本地 AI 功能免费；Pro 不含模型额度/)).toBeInTheDocument();
    expect(screen.getByText("早期用户价")).toBeInTheDocument();
    expect(screen.queryByText("联系开发者")).not.toBeInTheDocument();
    expect(screen.queryByText("developer@example.invalid")).not.toBeInTheDocument();
    expect(screen.queryByText("升级至 Mona Pro")).not.toBeInTheDocument();
    expect(screen.queryByText("订阅已生效，请返回主界面。")).not.toBeInTheDocument();
    expect(mocks.invoke).not.toHaveBeenCalledWith("get_subscription_info");
  });

  it("selects a plan before creating its order and refreshes status after payment", async () => {
    render(<SubscribeView {...props} embed />);

    expect(screen.getByRole("button", { name: /^年付/ })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: /^月付/ }));
    expect(screen.getByRole("button", { name: /^月付/ })).toHaveAttribute("aria-pressed", "true");
    expect(mocks.invoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "立即订阅" }));

    await screen.findByRole("dialog", { name: "订阅支付" });
    expect(mocks.invoke).toHaveBeenCalledWith("create_subscription", { planCode: "monthly", paymentMethod: "alipay_page" });
    fireEvent.click(screen.getByRole("button", { name: "完成支付" }));
    await waitFor(() => expect(mocks.refreshLicense).toHaveBeenCalledOnce());
    expect(screen.queryByRole("dialog", { name: "订阅支付" })).not.toBeInTheDocument();
  });

  it("keeps plan choices visible for paid users but disables repeat purchases", async () => {
    mocks.paid = true;
    let resolveStatus!: (value: { auto_renew: boolean }) => void;
    const statusRequest = new Promise<{ auto_renew: boolean }>((resolve) => {
      resolveStatus = resolve;
    });
    const initialImplementation = mocks.invoke.getMockImplementation();
    mocks.invoke.mockImplementation((command: string) => command === "get_subscription_info"
      ? statusRequest
      : initialImplementation?.(command));
    render(<SubscribeView {...props} embed onManageSubscription={vi.fn()} />);

    expect(screen.getByText("长期有效")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "订阅套餐" })).toBeInTheDocument();
    const monthly = screen.getByRole("button", { name: /^月付/ });
    expect(screen.getByRole("button", { name: /^季付/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^年付/ })).toBeInTheDocument();
    const purchase = screen.getByRole("button", { name: "已开通", exact: true });
    expect(purchase).toBeDisabled();
    fireEvent.click(monthly);
    expect(monthly).toHaveAttribute("aria-pressed", "true");
    expect(purchase).toBeDisabled();
    expect(screen.queryByRole("button", { name: "管理订阅" })).not.toBeInTheDocument();

    await waitFor(() => expect(mocks.invoke.mock.calls.filter(([command]) => command === "get_subscription_info")).toHaveLength(1));
    await act(async () => {
      resolveStatus({ auto_renew: false });
      await statusRequest;
    });
    expect(screen.queryByRole("button", { name: "自动续费设置", exact: true })).not.toBeInTheDocument();
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "create_subscription")).toHaveLength(0);
  });

  it("shows auto-renew settings for paid users when auto-renew is enabled", async () => {
    mocks.paid = true;
    mocks.expiresAt = "2027-08-27";
    const initialImplementation = mocks.invoke.getMockImplementation();
    mocks.invoke.mockImplementation((command: string) => command === "get_subscription_info"
      ? Promise.resolve({ auto_renew: true })
      : initialImplementation?.(command));
    const onManageSubscription = vi.fn();
    render(<SubscribeView {...props} embed onManageSubscription={onManageSubscription} />);

    const autoRenewSettings = await screen.findByRole("button", { name: "自动续费设置", exact: true });
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "get_subscription_info")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "管理订阅" })).not.toBeInTheDocument();
    fireEvent.click(autoRenewSettings);
    expect(onManageSubscription).toHaveBeenCalledOnce();
  });

  it("hides disabled auto-renew and allows retry after a status read failure", async () => {
    mocks.paid = true;
    const initialImplementation = mocks.invoke.getMockImplementation();
    let infoReads = 0;
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "get_subscription_info") {
        infoReads += 1;
        if (infoReads === 1) return Promise.resolve({ auto_renew: false });
        if (infoReads === 2) return Promise.reject(new Error("native status error"));
        return Promise.resolve({ auto_renew: true });
      }
      return initialImplementation?.(command);
    });
    const onManageSubscription = vi.fn();
    render(<SubscribeView {...props} embed onManageSubscription={onManageSubscription} />);

    await waitFor(() => expect(infoReads).toBe(1));
    expect(screen.queryByRole("button", { name: "自动续费设置", exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText("自动续费状态暂时无法读取，请点击“刷新状态”重试。", { exact: true })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "刷新状态" }));
    expect(await screen.findByText("自动续费状态暂时无法读取，请点击“刷新状态”重试。", { exact: true })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "刷新状态" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "刷新状态" }));

    const autoRenewSettings = await screen.findByRole("button", { name: "自动续费设置", exact: true });
    expect(infoReads).toBe(3);
    fireEvent.click(autoRenewSettings);
    expect(onManageSubscription).toHaveBeenCalledOnce();
  });

  it("keeps trial limitations and subscription choices visible", () => {
    mocks.paid = true;
    mocks.trial = true;
    mocks.days = 7;
    const onManageSubscription = vi.fn();
    render(<SubscribeView {...props} embed onManageSubscription={onManageSubscription} />);

    expect(screen.getByText("试用剩余 7 天")).toBeInTheDocument();
    expect(screen.getByText("历史软件试用不包含多设备登录和云空间权益。")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "订阅套餐" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "立即订阅" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "自动续费设置" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "管理订阅" })).not.toBeInTheDocument();
    expect(mocks.invoke).not.toHaveBeenCalledWith("get_subscription_info");
  });

  it("explains unavailable payment without directing users to developer contact", async () => {
    const initialImplementation = mocks.invoke.getMockImplementation();
    mocks.invoke.mockImplementation((command: string) => command === "create_subscription"
      ? Promise.reject(new Error("alipay_disabled"))
      : initialImplementation?.(command));
    render(<SubscribeView {...props} embed />);
    fireEvent.click(screen.getByRole("button", { name: "立即订阅" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("支付宝支付暂未开启，请稍后重试。");
    expect(screen.queryByText(/联系作者|联系开发者/)).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "订阅支付" })).not.toBeInTheDocument();
  });

  it("lets users retry when pricing cannot be loaded", () => {
    mocks.hasPricing = false;
    mocks.pricingError = "服务暂不可用";
    render(<SubscribeView {...props} embed />);

    expect(screen.getByText("加载失败：服务暂不可用")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(mocks.fetchPricing).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "立即订阅" })).not.toBeInTheDocument();
  });
});
