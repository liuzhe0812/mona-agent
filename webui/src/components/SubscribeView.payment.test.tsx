import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  accountStatusReads: 0,
  subscriptionOrderCreates: 0,
  paymentStatus: "paid",
  paidOnRefresh: true,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => undefined),
}));
vi.mock("@/lib/tauri", () => ({ isTauri: () => true }));
vi.mock("qrcode", () => ({
  default: { toDataURL: () => Promise.resolve("data:image/png;base64,test") },
}));

import { LicenseProvider } from "@/hooks/useLicense";
import { SubscribeView } from "./SubscribeView";

function accountStatus(paid: boolean) {
  return {
    status: paid ? "valid" : "invalid",
    expires_at: paid ? "2027-11-25" : null,
    trial: false,
    remaining_days: paid ? 30 : 0,
    plan: paid ? "pro" : "free",
    logged_in: true,
    email: "member@example.com",
    account: "member",
  };
}

function renderSubscription() {
  return render(
    <LicenseProvider>
      <SubscribeView
        userEmail="member@example.com"
        onBackToLogin={() => undefined}
        embed
      />
    </LicenseProvider>,
  );
}

async function startSubscription() {
  const subscribe = await screen.findByRole("button", { name: "立即订阅" });
  await waitFor(() => expect(subscribe).toBeEnabled());
  fireEvent.click(subscribe);
  await screen.findByRole("dialog", { name: "支付宝支付" });
}

describe("SubscribeView payment lifecycle", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.accountStatusReads = 0;
    mocks.subscriptionOrderCreates = 0;
    mocks.paymentStatus = "paid";
    mocks.paidOnRefresh = true;
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: { invoke: mocks.invoke },
    });
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "get_pricing") {
        return Promise.resolve({
          plans: [{ id: "monthly", name: "月付", price: 5.9, duration_months: 1 }],
          contact: { email: "", wechat: "" },
          promotional_banner: null,
          promo_trial: null,
        });
      }
      if (command === "check_account_status") {
        mocks.accountStatusReads += 1;
        const paid = mocks.paidOnRefresh && mocks.accountStatusReads > 1;
        return Promise.resolve(accountStatus(paid));
      }
      if (command === "create_subscription") {
        mocks.subscriptionOrderCreates += 1;
        return Promise.resolve({
          order_id: 7,
          trade_order_id: "subscription-order-7",
          payment_url: "https://openapi.alipay.com/gateway.do?order=7",
          payment_method: "alipay_page",
        });
      }
      if (command === "poll_payment_status") {
        return Promise.resolve({ status: mocks.paymentStatus });
      }
      if (command === "get_subscription_info") {
        return Promise.resolve({ auto_renew: false });
      }
      return Promise.reject(new Error(`unexpected command: ${command}`));
    });
  });

  it.each(["close button", "Escape key"])("refreshes the paid account when the user closes immediately after payment confirmation with %s", async (closeAction) => {
    renderSubscription();
    await screen.findByText("未开通");
    await startSubscription();
    await screen.findByText("支付成功");

    if (closeAction === "Escape key") {
      fireEvent.keyDown(document, { key: "Escape", code: "Escape", keyCode: 27 });
    } else {
      fireEvent.click(screen.getByRole("button", { name: "关闭", exact: true }));
    }

    await waitFor(() => expect(mocks.accountStatusReads).toBe(2));
    expect(await screen.findByText("剩余 30 天")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "支付宝支付" })).not.toBeInTheDocument();
    expect(mocks.subscriptionOrderCreates).toBe(1);
  });

  it("does not create another order when closing an unpaid payment", async () => {
    mocks.paymentStatus = "pending";
    mocks.paidOnRefresh = false;
    renderSubscription();
    await screen.findByText("未开通");
    await startSubscription();
    await screen.findByText("使用支付宝扫码完成支付");

    fireEvent.click(screen.getByRole("button", { name: "取消支付", exact: true }));

    await waitFor(() => expect(mocks.accountStatusReads).toBe(2));
    expect(mocks.subscriptionOrderCreates).toBe(1);
    expect(screen.queryByRole("dialog", { name: "支付宝支付" })).not.toBeInTheDocument();
    expect(screen.getByText("未开通")).toBeInTheDocument();
  });

  it("still refreshes the account through the normal delayed success callback", async () => {
    renderSubscription();
    await screen.findByText("未开通");
    await startSubscription();
    await screen.findByText("支付成功");

    expect(await screen.findByText("剩余 30 天", {}, { timeout: 4_000 })).toBeInTheDocument();
    expect(mocks.accountStatusReads).toBe(2);
    expect(mocks.subscriptionOrderCreates).toBe(1);
    expect(screen.queryByRole("dialog", { name: "支付宝支付" })).not.toBeInTheDocument();
  });
});
