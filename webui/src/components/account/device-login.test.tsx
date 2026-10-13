import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DeviceLimitError, requireLoginAccepted } from "@/lib/account-devices";

const mocks = vi.hoisted(() => ({ login: vi.fn(), invoke: vi.fn(), refreshLicense: vi.fn() }));
vi.mock("@/hooks/useLicense", () => ({ useLicense: () => ({ login: mocks.login,
  loggedIn: false, licenseInfo: null, pricingConfig: null, fetchPricing: vi.fn(), refreshLicense: mocks.refreshLicense,
}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/components/SubscribeView", () => ({ SubscribeView: () => null }));
vi.mock("@/components/ManageSubscription", () => ({ ManageSubscription: () => null }));
vi.mock("@/components/CreditsView", () => ({ CreditsView: () => null }));

import { LoginDialog } from "@/components/LoginDialog";

const device = { id: "a".repeat(32), revision: 2, name: "办公室电脑", platform: "windows", current: false,
  bound_at: "2026-10-12T00:00:00Z", last_seen_at: "2026-10-12T00:00:00Z" };
const limit = { error: "device_limit_exceeded", devices: [device], device_limit: 1, plan: "free", required_replacements: 1 };
const fill = () => {
  fireEvent.change(screen.getByPlaceholderText("账号或邮箱"), { target: { value: "tester" } });
  fireEvent.change(screen.getByPlaceholderText("密码"), { target: { value: "fixture-password" } });
};

beforeEach(() => { vi.clearAllMocks(); mocks.login.mockReset(); mocks.invoke.mockReset(); mocks.refreshLicense.mockResolvedValue(undefined); });

describe("desktop device admission UI", () => {
  it("rejects false success and shows the seat selection without signing in", async () => {
    expect(() => requireLoginAccepted({ success: false, ...limit })).toThrow(DeviceLimitError);
    mocks.login.mockRejectedValueOnce(new DeviceLimitError(limit)).mockResolvedValueOnce(undefined);
    const close = vi.fn();
    render(<LoginDialog open onOpenChange={close} />);
    fill(); fireEvent.click(screen.getByRole("button", { name: "登录", exact: true }));
    const confirm = await screen.findByRole("button", { name: "退出所选设备并登录" });
    expect(confirm).toBeDisabled();
    expect(close).not.toHaveBeenCalled(); expect(mocks.login).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("checkbox", { name: "退出 办公室电脑" }));
    fireEvent.click(confirm);
    await waitFor(() => expect(close).toHaveBeenCalledWith(false));
    expect(mocks.login.mock.calls[1]).toEqual(["tester", "fixture-password", {
      requestId: expect.any(String), replacements: [{ id: device.id, revision: 2 }],
    }]);
  });

  it("returning to login never silently replaces an existing device", async () => {
    mocks.login.mockRejectedValue(new DeviceLimitError(limit));
    render(<LoginDialog open onOpenChange={vi.fn()} />);
    fill(); fireEvent.click(screen.getByRole("button", { name: "登录", exact: true }));
    fireEvent.click(await screen.findByRole("button", { name: "返回登录" }));
    expect(screen.getByPlaceholderText("账号或邮箱")).toHaveValue("tester");
    expect(mocks.login).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("a transport retry retains its operation id until the user changes the login", async () => {
    mocks.login.mockRejectedValueOnce(new Error("网络暂不可用")).mockResolvedValueOnce(undefined);
    render(<LoginDialog open onOpenChange={vi.fn()} />);
    fill(); fireEvent.click(screen.getByRole("button", { name: "登录", exact: true }));
    await screen.findByText("网络暂不可用");
    fireEvent.click(screen.getByRole("button", { name: "登录", exact: true }));
    await waitFor(() => expect(mocks.login).toHaveBeenCalledTimes(2));
    expect(mocks.login.mock.calls[1][2].requestId).toBe(mocks.login.mock.calls[0][2].requestId);
  });
});
