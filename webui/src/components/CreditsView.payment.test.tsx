import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  balanceReads: 0,
  orderReads: 0,
  statusReads: 0,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/lib/tauri", () => ({ isTauri: () => true }));
vi.mock("@/hooks/useLicense", () => ({
  useLicense: () => ({
    licenseActive: false,
    serverTrial: false,
    remainingDays: 0,
    licenseInfo: { account: "credit-test-account", email: "credit-test@example.com" },
  }),
}));
vi.mock("qrcode", () => ({
  default: { toDataURL: () => Promise.resolve("data:image/png;base64,test") },
}));

import { CreditsView } from "./CreditsView";

const paidOrder = {
  order_id: 42,
  trade_order_id: "credit_paid_order_42",
  amount: "1.00",
  status: "paid",
  fulfillment_status: "succeeded",
  balance_amount: "1.00",
  payment_url: null,
  created_at: "2026-09-08T00:00:00Z",
};

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function advanceTimers(milliseconds: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
  await flushMicrotasks();
}

describe("CreditsView payment flow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.invoke.mockReset();
    mocks.balanceReads = 0;
    mocks.orderReads = 0;
    mocks.statusReads = 0;
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "get_credit_balance") {
        mocks.balanceReads += 1;
        return Promise.resolve({
          available_amount: mocks.balanceReads >= 3 ? "1.00" : "0.00",
          reserved_amount: "0.00",
          updated_at: "2026-09-08T00:00:00Z",
        });
      }
      if (command === "get_credit_products") {
        return Promise.resolve({
          recharge_enabled: true,
          custom_recharge: { enabled: true, min_amount: "1.00", max_amount: "200.00" },
          products: [],
        });
      }
      if (command === "get_credit_orders") {
        mocks.orderReads += 1;
        return Promise.resolve({
          orders: mocks.orderReads >= 3 ? [paidOrder] : [],
          has_more: false,
        });
      }
      if (command === "create_custom_credit_order") {
        return Promise.resolve({ order_id: 42, payment_url: "https://pay.example/42" });
      }
      if (command === "get_credit_order_status") {
        mocks.statusReads += 1;
        return Promise.resolve(
          mocks.statusReads === 1
            ? { status: "pending" }
            : { status: "paid", fulfillment_status: "succeeded" },
        );
      }
      return Promise.reject(new Error(`unexpected command: ${command}`));
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("closes after a 1-yuan payment succeeds and refreshes balance and orders", async () => {
    render(<CreditsView />);
    await flushMicrotasks();

    const input = screen.getByRole("textbox", { name: "自定义充值金额" });
    fireEvent.change(input, { target: { value: "1.00" } });
    fireEvent.click(screen.getByRole("button", { name: "充值" }));
    fireEvent.click(screen.getByRole("button", { name: "确认充值" }));
    await flushMicrotasks();

    expect(screen.getByText("余额充值")).toBeInTheDocument();
    expect(mocks.invoke).toHaveBeenCalledWith("create_custom_credit_order", {
      amount: "1.00",
      idempotencyKey: expect.any(String),
    });
    expect(mocks.statusReads).toBe(1);

    await advanceTimers(3000);
    expect(screen.getByText("支付成功")).toBeInTheDocument();
    await advanceTimers(1200);

    expect(screen.queryByText("余额充值")).not.toBeInTheDocument();
    expect(screen.getByText("1.00")).toBeInTheDocument();
    expect(screen.getByText("已到账")).toBeInTheDocument();
    expect(mocks.balanceReads).toBeGreaterThanOrEqual(3);
    expect(mocks.orderReads).toBeGreaterThanOrEqual(3);
  });
});
