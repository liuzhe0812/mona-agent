import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/lib/tauri", () => ({ isTauri: () => true }));
vi.mock("qrcode", () => ({
  default: { toDataURL: () => Promise.resolve("data:image/png;base64,test") },
}));

import { PaymentDialog, type PaymentDialogProps } from "./PaymentDialog";

async function flushMicrotasks() {
  await act(async () => {
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

function renderDialog(overrides: Partial<PaymentDialogProps> = {}) {
  return render(
    <PaymentDialog
      open
      onOpenChange={() => undefined}
      orderId={7}
      paymentUrl="https://pay.example/7"
      paymentMethod="alipay_page"
      pollCommand="get_credit_order_status"
      onSuccess={() => undefined}
      onCancel={() => undefined}
      {...overrides}
    />,
  );
}

describe("PaymentDialog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.invoke.mockReset();
    mocks.invoke.mockResolvedValue({ status: "pending" });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("calls onSuccess exactly once 1200ms after paid+succeeded", async () => {
    const onSuccess = vi.fn();
    mocks.invoke
      .mockResolvedValueOnce({ status: "pending" })
      .mockResolvedValueOnce({ status: "paid", fulfillment_status: "succeeded" });

    renderDialog({ onSuccess });
    await flushMicrotasks();
    expect(mocks.invoke).toHaveBeenCalledWith("get_credit_order_status", { orderId: 7 });

    await advanceTimers(3000);
    expect(screen.getByText("支付成功")).toBeInTheDocument();
    expect(onSuccess).not.toHaveBeenCalled();

    await advanceTimers(1199);
    expect(onSuccess).not.toHaveBeenCalled();
    await advanceTimers(1);
    expect(onSuccess).toHaveBeenCalledOnce();

    await advanceTimers(5000);
    expect(onSuccess).toHaveBeenCalledOnce();
  });

  it("shows paid-but-not-fulfilled as processing without payment controls", async () => {
    const onSuccess = vi.fn();
    mocks.invoke
      .mockResolvedValueOnce({ status: "paid", fulfillment_status: "not_started" })
      .mockResolvedValueOnce({ status: "paid", fulfillment_status: "succeeded" });

    renderDialog({ onSuccess });
    await flushMicrotasks();

    expect(screen.getByText("付款已成功，正在确认到账")).toBeInTheDocument();
    expect(screen.queryByAltText("支付二维码")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "在浏览器中付款" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "刷新支付结果" }));
    await flushMicrotasks();
    expect(screen.getByText("支付成功")).toBeInTheDocument();
    await advanceTimers(1200);
    expect(onSuccess).toHaveBeenCalledOnce();
  });

  it("shows query errors and uses reconcile on a manual refresh", async () => {
    mocks.invoke
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValueOnce({ status: "pending" });

    renderDialog();
    await flushMicrotasks();

    expect(screen.getByText("暂时无法查询支付结果，正在重试。也可手动刷新结果。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "我已付款，刷新结果" }));
    await flushMicrotasks();

    expect(mocks.invoke).toHaveBeenLastCalledWith("get_credit_order_status", {
      orderId: 7,
      reconcile: true,
    });
  });

  it("shows a failed payment state with the updated retry wording", async () => {
    mocks.invoke.mockResolvedValueOnce({ status: "failed" });

    renderDialog();
    await flushMicrotasks();

    expect(screen.getByText("订单未完成")).toBeInTheDocument();
    expect(screen.getByText("订单未完成。如已扣款，请刷新结果或联系客服核对。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "刷新支付结果" })).toBeInTheDocument();
    expect(screen.queryByText("支付失败，请重试")).not.toBeInTheDocument();
  });

  it("passes reconcile=true to the automatic server check at 15 seconds", async () => {
    renderDialog();
    await flushMicrotasks();

    expect(
      mocks.invoke.mock.calls.some(([, args]) => (args as { reconcile?: boolean }).reconcile === true),
    ).toBe(false);
    await advanceTimers(14_999);
    expect(
      mocks.invoke.mock.calls.some(([, args]) => (args as { reconcile?: boolean }).reconcile === true),
    ).toBe(false);

    await advanceTimers(1);
    expect(mocks.invoke).toHaveBeenCalledWith("get_credit_order_status", {
      orderId: 7,
      reconcile: true,
    });
  });

  it("does not overlap a long-running status query", async () => {
    let resolveSecond!: (value: { status: string }) => void;
    const secondQuery = new Promise<{ status: string }>((resolve) => {
      resolveSecond = resolve;
    });
    mocks.invoke.mockImplementationOnce(() => Promise.resolve({ status: "pending" }));
    mocks.invoke.mockImplementationOnce(() => secondQuery);

    renderDialog();
    await flushMicrotasks();
    expect(mocks.invoke).toHaveBeenCalledTimes(1);

    await advanceTimers(3000);
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "正在查询..." })).toBeDisabled();

    await advanceTimers(30_000);
    expect(mocks.invoke).toHaveBeenCalledTimes(2);

    resolveSecond({ status: "pending" });
    await flushMicrotasks();
  });

  it("does not restart polling when onSuccess changes and calls the latest callback", async () => {
    const firstSuccess = vi.fn();
    const latestSuccess = vi.fn();
    const view = renderDialog({ onSuccess: firstSuccess });
    await flushMicrotasks();
    expect(mocks.invoke).toHaveBeenCalledTimes(1);

    view.rerender(
      <PaymentDialog
        open
        onOpenChange={() => undefined}
        orderId={7}
        paymentUrl="https://pay.example/7"
        paymentMethod="alipay_page"
        pollCommand="get_credit_order_status"
        onSuccess={latestSuccess}
        onCancel={() => undefined}
      />,
    );
    await flushMicrotasks();
    expect(mocks.invoke).toHaveBeenCalledTimes(1);

    mocks.invoke.mockResolvedValueOnce({ status: "paid", fulfillment_status: "succeeded" });
    await advanceTimers(3000);
    await advanceTimers(1200);
    expect(firstSuccess).not.toHaveBeenCalled();
    expect(latestSuccess).toHaveBeenCalledOnce();
  });

  it("cancels a delayed success callback when the dialog closes", async () => {
    const onSuccess = vi.fn();
    mocks.invoke.mockResolvedValueOnce({ status: "paid", fulfillment_status: "succeeded" });
    const view = renderDialog({ onSuccess });
    await flushMicrotasks();
    expect(screen.getByText("支付成功")).toBeInTheDocument();

    view.rerender(
      <PaymentDialog
        open={false}
        onOpenChange={() => undefined}
        orderId={7}
        paymentUrl="https://pay.example/7"
        paymentMethod="alipay_page"
        pollCommand="get_credit_order_status"
        onSuccess={onSuccess}
        onCancel={() => undefined}
      />,
    );
    await advanceTimers(1200);
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("ignores a late response from the previous order after switching orders", async () => {
    let resolveOld!: (value: { status: string; fulfillment_status?: string }) => void;
    const oldQuery = new Promise<{ status: string; fulfillment_status?: string }>((resolve) => {
      resolveOld = resolve;
    });
    const onSuccess = vi.fn();
    mocks.invoke.mockImplementation((_command: string, args: { orderId: number }) =>
      args.orderId === 7 ? oldQuery : Promise.resolve({ status: "pending" }),
    );

    const view = renderDialog({ onSuccess });
    await flushMicrotasks();
    expect(mocks.invoke).toHaveBeenCalledWith("get_credit_order_status", { orderId: 7 });

    view.rerender(
      <PaymentDialog
        open
        onOpenChange={() => undefined}
        orderId={8}
        paymentUrl="https://pay.example/8"
        paymentMethod="alipay_page"
        pollCommand="get_credit_order_status"
        onSuccess={onSuccess}
        onCancel={() => undefined}
      />,
    );
    await flushMicrotasks();
    resolveOld({ status: "paid", fulfillment_status: "succeeded" });
    await flushMicrotasks();
    await advanceTimers(1200);

    expect(onSuccess).not.toHaveBeenCalled();
    expect(screen.getByText("使用支付宝扫码完成支付")).toBeInTheDocument();
  });

  it("allows a timed-out payment to be manually reconciled and completed", async () => {
    const onSuccess = vi.fn();
    renderDialog({ onSuccess });
    await flushMicrotasks();

    await advanceTimers(600_000);
    expect(screen.getByText("支付结果待确认")).toBeInTheDocument();
    expect(screen.getByText("暂未确认支付结果。如已付款，请刷新结果或稍后查看充值记录。")).toBeInTheDocument();
    expect(screen.queryByText(/支付失败|订单未完成|重新支付/)).not.toBeInTheDocument();

    mocks.invoke.mockResolvedValueOnce({ status: "paid", fulfillment_status: "succeeded" });
    fireEvent.click(screen.getByRole("button", { name: "刷新支付结果" }));
    await flushMicrotasks();
    expect(screen.getByText("支付成功")).toBeInTheDocument();
    await advanceTimers(1200);
    expect(onSuccess).toHaveBeenCalledOnce();
  });

  it("notifies the caller when payment is cancelled", async () => {
    const onCancel = vi.fn();
    renderDialog({ onCancel });
    await flushMicrotasks();

    fireEvent.click(screen.getByRole("button", { name: "取消支付" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("opens payment only through the restricted Tauri payment command", async () => {
    mocks.invoke.mockImplementation((command: string) =>
      Promise.resolve(command === "get_credit_order_status" ? { status: "pending" } : undefined),
    );

    renderDialog({ paymentUrl: "https://openapi.alipay.com/gateway.do?order=10" });
    await flushMicrotasks();
    fireEvent.click(screen.getByRole("button", { name: "在浏览器中付款" }));
    await flushMicrotasks();
    expect(mocks.invoke).toHaveBeenCalledWith("open_payment_url", {
      url: "https://openapi.alipay.com/gateway.do?order=10",
    });
  });
});
