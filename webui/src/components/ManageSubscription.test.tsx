import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/lib/tauri", () => ({ isTauri: () => true }));

import { ManageSubscription } from "./ManageSubscription";

const activeSubscription = {
  status: "active",
  current_period_end: "2027-12-31T00:00:00Z",
  plan_code: "monthly",
  auto_renew: true,
  agreement_status: "active",
  cancelled_at: null,
};

describe("ManageSubscription", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "get_subscription_info") return Promise.resolve(activeSubscription);
      if (command === "list_renewals") return Promise.resolve({ renewals: [] });
      return Promise.reject(new Error(`unexpected command: ${command}`));
    });
  });

  it("keeps an active subscription and its cancel flow when renewal history fails", async () => {
    let autoRenew = true;
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "get_subscription_info") {
        return Promise.resolve({ ...activeSubscription, auto_renew: autoRenew });
      }
      if (command === "list_renewals") return Promise.reject(new Error("native failure SECRET"));
      if (command === "cancel_auto_renew") {
        autoRenew = false;
        return Promise.resolve({ message: "已关闭自动续费" });
      }
      return Promise.reject(new Error(`unexpected command: ${command}`));
    });

    render(<ManageSubscription onBack={vi.fn()} />);

    expect(await screen.findByText("月度会员")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "关闭自动续费" })).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent("续费记录暂时无法获取");
    expect(screen.queryByText("暂无续费记录")).not.toBeInTheDocument();
    expect(screen.queryByText(/SECRET/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "关闭自动续费" }));
    const dialog = await screen.findByRole("dialog", { name: "关闭自动续费" });
    fireEvent.click(within(dialog).getByRole("button", { name: "确认关闭自动续费" }));

    expect(await screen.findByText("已关闭自动续费")).toBeInTheDocument();
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("cancel_auto_renew", { reason: null }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "关闭自动续费" })).not.toBeInTheDocument());
  });

  it("does not call a failed subscription read empty and can recover on retry", async () => {
    let reads = 0;
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "get_subscription_info") {
        reads += 1;
        return reads === 1
          ? Promise.reject(new Error("native failure SECRET"))
          : Promise.resolve(activeSubscription);
      }
      if (command === "list_renewals") return Promise.resolve({ renewals: [] });
      return Promise.reject(new Error(`unexpected command: ${command}`));
    });

    render(<ManageSubscription onBack={vi.fn()} />);

    expect(await screen.findByText("订阅信息暂时无法获取，请点击右上角刷新重试。")).toBeInTheDocument();
    expect(screen.queryByText("暂无有效订阅")).not.toBeInTheDocument();
    expect(screen.queryByText(/SECRET/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "刷新订阅信息" }));

    expect(await screen.findByText("月度会员")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "关闭自动续费" })).toBeInTheDocument();
    expect(screen.queryByText("订阅信息暂时无法获取，请点击右上角刷新重试。")).not.toBeInTheDocument();
  });

  it("keeps the last successful subscription visible after refresh failure and recovers", async () => {
    let reads = 0;
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "get_subscription_info") {
        reads += 1;
        if (reads === 2) return Promise.reject(new Error("native failure SECRET"));
        return Promise.resolve({ ...activeSubscription, auto_renew: reads < 3 });
      }
      if (command === "list_renewals") return Promise.resolve({ renewals: [] });
      return Promise.reject(new Error(`unexpected command: ${command}`));
    });

    render(<ManageSubscription onBack={vi.fn()} />);

    expect(await screen.findByText("已开启")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "刷新订阅信息" }));

    expect(await screen.findByText(/订阅信息暂时无法更新/)).toBeInTheDocument();
    expect(screen.getByText("月度会员")).toBeInTheDocument();
    expect(screen.getByText("已开启")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "关闭自动续费" })).toBeInTheDocument();
    expect(screen.queryByText(/SECRET/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "刷新订阅信息" }));

    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.getByText("月度会员")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "关闭自动续费" })).not.toBeInTheDocument();
    expect(screen.getByText("未开启")).toBeInTheDocument();
  });

  it("shows a safe retry message when cancelling auto-renew fails", async () => {
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "get_subscription_info") return Promise.resolve(activeSubscription);
      if (command === "list_renewals") return Promise.resolve({ renewals: [] });
      if (command === "cancel_auto_renew") return Promise.reject(new Error("native failure SECRET"));
      return Promise.reject(new Error(`unexpected command: ${command}`));
    });

    render(<ManageSubscription onBack={vi.fn()} />);
    await screen.findByText("月度会员");
    fireEvent.click(screen.getByRole("button", { name: "关闭自动续费" }));
    const dialog = await screen.findByRole("dialog", { name: "关闭自动续费" });
    fireEvent.click(within(dialog).getByRole("button", { name: "确认关闭自动续费" }));

    expect(await screen.findByText("关闭自动续费失败，请稍后重试。")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "关闭自动续费" })).toBeInTheDocument();
    expect(screen.queryByText(/SECRET/)).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "再想想" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("shows confirmed empty subscription and renewal results as empty", async () => {
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "get_subscription_info") return Promise.resolve(null);
      if (command === "list_renewals") return Promise.resolve({ renewals: [] });
      return Promise.reject(new Error(`unexpected command: ${command}`));
    });

    render(<ManageSubscription onBack={vi.fn()} />);

    expect(await screen.findByText("暂无有效订阅")).toBeInTheDocument();
    expect(screen.getByText("暂无续费记录")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
