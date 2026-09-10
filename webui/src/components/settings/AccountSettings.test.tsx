import { render, screen, waitFor } from "@testing-library/react";
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
    mocks.invoke.mockResolvedValue({ available_amount: "120", reserved_amount: "5" });
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
