import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@/lib/tauri", () => ({ isTauri: () => true }));

import { LicenseProvider, useLicense } from "./useLicense";

function Probe() {
  const { licenseInfo, loggedIn, logout } = useLicense();
  return (
    <div>
      <span>{licenseInfo?.account ?? "none"}</span>
      <span>{loggedIn ? "logged-in" : "logged-out"}</span>
      <button onClick={() => void logout()}>logout</button>
    </div>
  );
}

describe("LicenseProvider account isolation", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: { invoke: mocks.invoke },
    });
  });

  it("does not restore an old account when a license check returns after logout", async () => {
    let resolveLicense!: (value: Record<string, unknown>) => void;
    const pendingLicense = new Promise<Record<string, unknown>>((resolve) => {
      resolveLicense = resolve;
    });
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "check_license") return pendingLicense;
      if (command === "get_pricing") {
        return Promise.resolve({ plans: [], contact: {}, promotional_banner: null });
      }
      if (command === "auth_logout") return Promise.resolve({ success: true });
      return Promise.reject(new Error(`unexpected command: ${command}`));
    });

    render(
      <LicenseProvider>
        <Probe />
      </LicenseProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "logout" }));
    await waitFor(() => expect(screen.getByText("logged-out")).toBeInTheDocument());

    resolveLicense({
      status: "valid",
      expires_at: null,
      trial: false,
      email: "old@example.com",
      account: "old-account",
    });

    await waitFor(() => expect(screen.getByText("none")).toBeInTheDocument());
    expect(screen.getByText("logged-out")).toBeInTheDocument();
  });
});
