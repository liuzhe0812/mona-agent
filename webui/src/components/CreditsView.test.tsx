import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
  account: "account-a",
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/lib/tauri", () => ({ isTauri: () => mocks.isTauri() }));
vi.mock("@/hooks/useLicense", () => ({
  useLicense: () => ({
    licenseActive: false,
    serverTrial: false,
    remainingDays: 0,
    licenseInfo: { account: mocks.account, email: `${mocks.account}@example.com` },
  }),
}));
vi.mock("@/components/PaymentDialog", () => ({
  PaymentDialog: ({ title }: { title: string }) => <div>{title}</div>,
}));

import { CreditsView } from "./CreditsView";

function confirmRecharge() {
  expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "确认充值" }));
}

describe("CreditsView", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.isTauri.mockReturnValue(true);
    mocks.account = "account-a";
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "get_credit_balance") {
        return Promise.resolve({
          available_amount: mocks.account === "account-a" ? "120" : "220",
          reserved_amount: "5",
          updated_at: "2026-08-26T00:00:00Z",
        });
      }
      if (command === "get_credit_products") {
        return Promise.resolve({
          recharge_enabled: true,
          products: [{ code: "starter", name: "入门包", price: "10.00", balance_amount: "10" }],
        });
      }
      if (command === "create_credit_order") {
        return Promise.resolve({ order_id: 7, payment_url: "https://pay.example/7" });
      }
      if (command === "get_credit_orders") {
        return Promise.resolve({ orders: [], has_more: false });
      }
      return Promise.reject(new Error(`unexpected command: ${command}`));
    });
  });

  it("shows balance, products and creates a server-priced order", async () => {
    render(<CreditsView onBack={() => undefined} />);

    await waitFor(() => expect(screen.getByText("120.00")).toBeInTheDocument());
    expect(screen.getByText(/生成中预留 ¥5/)).toBeInTheDocument();
    expect(screen.getByText("入门包")).toBeInTheDocument();
    expect(screen.queryByText("余额明细")).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "预置充值额度" })).toHaveClass("sm:grid-cols-3");

    fireEvent.click(screen.getByRole("button", { name: "¥10.00" }));
    expect(mocks.invoke.mock.calls.some(([command]) => command === "create_credit_order")).toBe(false);
    confirmRecharge();

    await waitFor(() => expect(screen.getByText("余额充值")).toBeInTheDocument());
    expect(mocks.invoke).toHaveBeenCalledWith("create_credit_order", {
      productCode: "starter",
      idempotencyKey: expect.any(String),
    });
    expect(mocks.invoke.mock.calls.some(([command]) => command === "get_credit_ledger")).toBe(false);
  });

  it("keeps software entitlement out of the balance and recharge page", async () => {
    render(<CreditsView />);

    await waitFor(() => expect(screen.getByText("120.00")).toBeInTheDocument());
    expect(screen.queryByText("当前软件权益")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "管理订阅" })).not.toBeInTheDocument();
  });

  it("shows the active recharge promotion and granted Pro days", async () => {
    const initialImplementation = mocks.invoke.getMockImplementation();
    mocks.invoke.mockImplementation((command: string, args?: unknown) => {
      if (command === "get_credit_products") {
        return Promise.resolve({
          recharge_enabled: true,
          promotion: {
            enabled: true,
            active: true,
            min_amount: "100.00",
            gift_days: 30,
            start_at: null,
            end_at: null,
            description: "活动期间单笔充值满 ¥100，赠送 30 天 Pro；每笔均可参与",
          },
          products: [{ code: "starter", name: "入门包", price: "100.00", balance_amount: "100" }],
        });
      }
      if (command === "get_credit_orders") {
        return Promise.resolve({
          orders: [{
            order_id: 10,
            trade_order_id: "credit_paid_order_123456",
            amount: "100.00",
            status: "paid",
            fulfillment_status: "succeeded",
            balance_amount: "100",
            payment_url: null,
            created_at: "2026-09-01T00:00:00Z",
            bonus_pro_days: 30,
            bonus_pro_revoked: false,
          }],
          has_more: false,
        });
      }
      return initialImplementation?.(command, args);
    });

    render(<CreditsView onBack={() => undefined} />);

    await waitFor(() => expect(screen.getByText("充值赠 Pro")).toBeInTheDocument());
    expect(screen.getByText(/每笔均可参与/)).toBeInTheDocument();
    expect(screen.getByText("已赠送 30 天 Pro")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "¥100.00" }));
    expect(screen.getByText(/同时赠送 30 天 Pro/)).toBeInTheDocument();
  });

  it("fails closed outside the desktop client", async () => {
    mocks.isTauri.mockReturnValue(false);

    render(<CreditsView onBack={() => undefined} />);

    await waitFor(() =>
      expect(screen.getByText("请在 Mona 桌面客户端中使用余额服务")).toBeInTheDocument(),
    );
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("shows a server order error without opening the payment dialog", async () => {
    const initialImplementation = mocks.invoke.getMockImplementation();
    mocks.invoke.mockImplementation((command: string, args?: unknown) => {
      if (command === "create_credit_order") {
        return Promise.reject(new Error("余额充值暂未开放 (503)"));
      }
      return initialImplementation?.(command, args);
    });
    render(<CreditsView onBack={() => undefined} />);
    await waitFor(() => expect(screen.getByText("入门包")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "¥10.00" }));
    confirmRecharge();

    await waitFor(() =>
      expect(screen.getByText("余额充值暂未开放 (503)")).toBeInTheDocument(),
    );
    expect(screen.queryByText("余额充值")).not.toBeInTheDocument();
  });

  it("disables recharge actions while the admin switch is off", async () => {
    const initialImplementation = mocks.invoke.getMockImplementation();
    mocks.invoke.mockImplementation((command: string, args?: unknown) => {
      if (command === "get_credit_products") {
        return Promise.resolve({
          recharge_enabled: false,
          products: [{ code: "starter", name: "入门包", price: "10.00", balance_amount: "10" }],
        });
      }
      return initialImplementation?.(command, args);
    });

    render(<CreditsView onBack={() => undefined} />);

    await waitFor(() =>
      expect(screen.getByText("充值服务维护中，暂时无法创建订单。")).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "¥10.00" })).toBeDisabled();
  });

  it("shows custom recharge within the server-provided range", async () => {
    const initialImplementation = mocks.invoke.getMockImplementation();
    mocks.invoke.mockImplementation((command: string, args?: unknown) => {
      if (command === "get_credit_products") {
        return Promise.resolve({
          recharge_enabled: true,
          custom_recharge: { enabled: true, min_amount: "1.00", max_amount: "200.00" },
          products: [{ code: "starter", name: "入门包", price: "10.00", balance_amount: "10" }],
        });
      }
      if (command === "create_custom_credit_order") {
        return Promise.resolve({ order_id: 12, payment_url: "https://pay.example/12" });
      }
      return initialImplementation?.(command, args);
    });

    render(<CreditsView onBack={() => undefined} />);

    const input = await waitFor(() => screen.getByRole("textbox", { name: "自定义充值金额" }));
    expect(screen.getByText(/可充值 ¥1.00 至 ¥200.00/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "充值" })).toBeDisabled();

    fireEvent.change(input, { target: { value: "12.50" } });
    expect(screen.getByRole("button", { name: "充值" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "充值" }));
    confirmRecharge();

    await waitFor(() => expect(screen.getByText("余额充值")).toBeInTheDocument());
    expect(mocks.invoke).toHaveBeenCalledWith("create_custom_credit_order", {
      amount: "12.50",
      idempotencyKey: expect.any(String),
    });
  });

  it("rejects custom amounts outside the server-provided range and enforces two decimals", async () => {
    const initialImplementation = mocks.invoke.getMockImplementation();
    mocks.invoke.mockImplementation((command: string, args?: unknown) => {
      if (command === "get_credit_products") {
        return Promise.resolve({
          recharge_enabled: true,
          custom_recharge: { enabled: true, min_amount: "1.00", max_amount: "20.00" },
          products: [],
        });
      }
      return initialImplementation?.(command, args);
    });

    render(<CreditsView />);

    const input = await waitFor(() => screen.getByRole("textbox", { name: "自定义充值金额" }));
    fireEvent.change(input, { target: { value: "0.99" } });
    expect(screen.getByText("充值金额需在 ¥1.00 至 ¥20.00 之间")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "充值" })).toBeDisabled();

    fireEvent.change(input, { target: { value: "20.01" } });
    expect(screen.getByText("充值金额需在 ¥1.00 至 ¥20.00 之间")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "充值" })).toBeDisabled();

    fireEvent.change(input, { target: { value: "10.123" } });
    expect(input).toHaveValue("20.01");
    expect(mocks.invoke.mock.calls.some(([command]) => command === "create_custom_credit_order")).toBe(
      false,
    );
  });

  it("clears custom amount and scopes retry keys to the active account", async () => {
    const initialImplementation = mocks.invoke.getMockImplementation();
    let createAttempts = 0;
    mocks.invoke.mockImplementation((command: string, args?: unknown) => {
      if (command === "get_credit_products") {
        return Promise.resolve({
          recharge_enabled: true,
          custom_recharge: { enabled: true, min_amount: "1.00", max_amount: "20.00" },
          products: [],
        });
      }
      if (command === "create_custom_credit_order") {
        createAttempts += 1;
        return createAttempts === 1
          ? Promise.reject(new Error("Request failed: connection reset"))
          : Promise.resolve({ order_id: 13, payment_url: "https://pay.example/13" });
      }
      return initialImplementation?.(command, args);
    });

    const view = render(<CreditsView />);
    let input = await waitFor(() => screen.getByRole("textbox", { name: "自定义充值金额" }));
    fireEvent.change(input, { target: { value: "10.00" } });
    fireEvent.click(screen.getByRole("button", { name: "充值" }));
    confirmRecharge();
    await waitFor(() => expect(screen.getByText(/connection reset/)).toBeInTheDocument());

    mocks.account = "account-b";
    view.rerender(<CreditsView />);
    input = await waitFor(() => screen.getByRole("textbox", { name: "自定义充值金额" }));
    expect(input).toHaveValue("");
    fireEvent.change(input, { target: { value: "10.00" } });
    fireEvent.click(screen.getByRole("button", { name: "充值" }));
    confirmRecharge();
    await waitFor(() => expect(screen.getByText("余额充值")).toBeInTheDocument());

    const createCalls = mocks.invoke.mock.calls.filter(
      ([command]) => command === "create_custom_credit_order",
    );
    expect(createCalls).toHaveLength(2);
    expect(createCalls[0][1].idempotencyKey).not.toBe(createCalls[1][1].idempotencyKey);
  });

  it("shows recent orders and resumes a pending payment", async () => {
    const initialImplementation = mocks.invoke.getMockImplementation();
    mocks.invoke.mockImplementation((command: string, args?: unknown) => {
      if (command === "get_credit_orders") {
        return Promise.resolve({
          orders: [
            {
              order_id: 9,
              trade_order_id: "credit_pending_order_123456",
              amount: "10.00",
              status: "pending",
              fulfillment_status: "not_started",
              balance_amount: "10",
              payment_url: "https://pay.example/9",
              created_at: "2026-08-26T00:00:00Z",
            },
          ],
          has_more: false,
        });
      }
      return initialImplementation?.(command, args);
    });

    render(<CreditsView onBack={() => undefined} />);

    await waitFor(() => expect(screen.getByText("最近充值订单")).toBeInTheDocument());
    expect(screen.getByText("等待支付")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "继续支付" }));
    expect(screen.getByText("余额充值")).toBeInTheDocument();
  });

  it("reuses the checkout idempotency key after an ambiguous network failure", async () => {
    const initialImplementation = mocks.invoke.getMockImplementation();
    let createAttempts = 0;
    mocks.invoke.mockImplementation((command: string, args?: unknown) => {
      if (command === "create_credit_order") {
        createAttempts += 1;
        return createAttempts === 1
          ? Promise.reject(new Error("Request failed: connection reset"))
          : Promise.resolve({ order_id: 11, payment_url: "https://pay.example/11" });
      }
      return initialImplementation?.(command, args);
    });
    render(<CreditsView onBack={() => undefined} />);
    await waitFor(() => expect(screen.getByText("入门包")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "¥10.00" }));
    confirmRecharge();
    await waitFor(() => expect(screen.getByText(/connection reset/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "¥10.00" }));
    confirmRecharge();
    await waitFor(() => expect(screen.getByText("余额充值")).toBeInTheDocument());

    const createCalls = mocks.invoke.mock.calls.filter(
      ([command]) => command === "create_credit_order",
    );
    expect(createCalls).toHaveLength(2);
    expect(createCalls[0][1].idempotencyKey).toBe(createCalls[1][1].idempotencyKey);
  });

  it("does not misrepresent a failed balance request as zero", async () => {
    const initialImplementation = mocks.invoke.getMockImplementation();
    mocks.invoke.mockImplementation((command: string, args?: unknown) => {
      if (command === "get_credit_balance") {
        return Promise.reject(new Error("余额服务不可用"));
      }
      return initialImplementation?.(command, args);
    });

    render(<CreditsView onBack={() => undefined} />);

    await waitFor(() => expect(screen.getByText("余额暂不可用")).toBeInTheDocument());
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("clears and reloads account-owned data after an account switch", async () => {
    const view = render(<CreditsView onBack={() => undefined} />);
    await waitFor(() => expect(screen.getByText("120.00")).toBeInTheDocument());

    mocks.account = "account-b";
    view.rerender(<CreditsView onBack={() => undefined} />);

    expect(screen.queryByText("120.00")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("220.00")).toBeInTheDocument());
  });

  it("discards an old account checkout response after an account switch", async () => {
    const initialImplementation = mocks.invoke.getMockImplementation();
    let resolveCheckout!: (value: { order_id: number; payment_url: string }) => void;
    const checkout = new Promise<{ order_id: number; payment_url: string }>((resolve) => {
      resolveCheckout = resolve;
    });
    mocks.invoke.mockImplementation((command: string, args?: unknown) => {
      if (command === "create_credit_order") return checkout;
      return initialImplementation?.(command, args);
    });
    const view = render(<CreditsView onBack={() => undefined} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "¥10.00" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "¥10.00" }));
    confirmRecharge();

    mocks.account = "account-b";
    view.rerender(<CreditsView onBack={() => undefined} />);
    await act(async () => {
      resolveCheckout({ order_id: 99, payment_url: "https://pay.example/99" });
      await checkout;
    });

    expect(screen.queryByText("余额充值")).not.toBeInTheDocument();
  });
});
