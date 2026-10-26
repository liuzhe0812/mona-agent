import { fireEvent, render, screen, waitFor, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), sync: vi.fn() }));

vi.mock("@/lib/tauri", () => ({ isTauri: () => true }));
vi.mock("@/lib/cloud-sync", () => ({ cloudSyncApi: { sync: mocks.sync } }));

import { LicenseProvider, useLicense } from "./useLicense";
import { useState } from "react";

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

function AuthProbe() {
  const { login, register, loggedIn } = useLicense();
  const [error, setError] = useState("");
  return (
    <div>
      <span>{loggedIn ? "logged-in" : "logged-out"}</span>
      <button onClick={() => void login("fixture-account", "fixture-password").catch((e) => setError(String(e)))}>login</button>
      <button onClick={() => void register("fixture@example.invalid", "fixture-password", "fixture-code", "fixture-account").catch((e) => setError(String(e)))}>register</button>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

const pricing = { plans: [], contact: {}, promotional_banner: null };
const license = { status: "valid", email: "fixture@example.invalid", account: "fixture-account", trial: false, expires_at: null };

describe("LicenseProvider account isolation", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.sync.mockReset().mockResolvedValue({ scheduled: true });
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
    let resolveLogout!: (value: { success: boolean }) => void;
    const pendingLogout = new Promise<{ success: boolean }>((resolve) => {
      resolveLogout = resolve;
    });
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "check_account_status") return pendingLicense;
      if (command === "get_pricing") {
        return Promise.resolve({ plans: [], contact: {}, promotional_banner: null });
      }
      if (command === "auth_logout") return pendingLogout;
      return Promise.reject(new Error(`unexpected command: ${command}`));
    });

    render(
      <LicenseProvider>
        <Probe />
      </LicenseProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "logout" }));
    await waitFor(() => expect(mocks.invoke.mock.calls.some(([command]) => command === "auth_logout")).toBe(true));
    await act(async () => {
      resolveLogout({ success: true });
      await pendingLogout;
    });
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "auth_logout")).toHaveLength(1);

    await act(async () => {
      resolveLicense({
        status: "valid",
        expires_at: null,
        trial: false,
        email: "old@example.com",
        account: "old-account",
      });
      await pendingLicense;
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("none")).toBeInTheDocument();
    expect(screen.getByText("logged-out")).toBeInTheDocument();
  });

  it("wakes cloud sync once after an accepted login finishes its license refresh", async () => {
    let resolveRefresh!: (value: typeof license) => void;
    let checkCount = 0;
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "get_pricing") return Promise.resolve(pricing);
      if (command === "check_account_status") {
        checkCount += 1;
        return checkCount === 1
          ? Promise.resolve({ status: "invalid", logged_in: false })
          : new Promise<typeof license>((resolve) => { resolveRefresh = resolve; });
      }
      if (command === "auth_login") return Promise.resolve({ success: true });
      return Promise.reject(new Error(`unexpected command: ${command}`));
    });

    render(<LicenseProvider><AuthProbe /></LicenseProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "login" }));
    await waitFor(() => expect(checkCount).toBe(2));
    expect(mocks.sync).not.toHaveBeenCalled();

    await act(async () => resolveRefresh(license));
    await waitFor(() => expect(mocks.sync).toHaveBeenCalledTimes(1));
    expect(screen.getByText("logged-in")).toBeInTheDocument();
    expect(mocks.invoke.mock.calls.map(([command]) => command)).toEqual([
      "check_account_status", "get_pricing", "auth_login", "check_account_status",
    ]);
  });

  it("wakes cloud sync once after an accepted registration", async () => {
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "get_pricing") return Promise.resolve(pricing);
      if (command === "check_account_status") return Promise.resolve(license);
      if (command === "auth_register") return Promise.resolve({ success: true });
      return Promise.reject(new Error(`unexpected command: ${command}`));
    });

    render(<LicenseProvider><AuthProbe /></LicenseProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "register" }));
    await waitFor(() => expect(mocks.sync).toHaveBeenCalledTimes(1));
    expect(mocks.invoke.mock.calls.some(([command, args]) => command === "auth_register"
      && args.email === "fixture@example.invalid" && args.account === "fixture-account")).toBe(true);
  });

  it("keeps login successful when the cloud sync wake fails", async () => {
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "get_pricing") return Promise.resolve(pricing);
      if (command === "check_account_status") return Promise.resolve(license);
      if (command === "auth_login") return Promise.resolve({ success: true });
      return Promise.reject(new Error(`unexpected command: ${command}`));
    });
    mocks.sync.mockRejectedValue(new Error("private response details"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    render(<LicenseProvider><AuthProbe /></LicenseProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "login" }));
    await waitFor(() => expect(screen.getByText("logged-in")).toBeInTheDocument());
    await waitFor(() => expect(warn).toHaveBeenCalledWith("Cloud sync wake after login failed"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(warn.mock.calls.flat().join(" ")).not.toContain("private response details");
    warn.mockRestore();
  });

  it("quietly keeps an explicitly paused cloud sync disabled", async () => {
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "get_pricing") return Promise.resolve(pricing);
      if (command === "check_account_status") return Promise.resolve(license);
      if (command === "auth_login") return Promise.resolve({ success: true });
      return Promise.reject(new Error(`unexpected command: ${command}`));
    });
    mocks.sync.mockRejectedValue(Object.assign(new Error("paused"), { code: "sync_disabled" }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    render(<LicenseProvider><AuthProbe /></LicenseProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "login" }));
    await waitFor(() => expect(mocks.sync).toHaveBeenCalledTimes(1));
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("does not wake cloud sync when login is rejected", async () => {
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "get_pricing") return Promise.resolve(pricing);
      if (command === "check_account_status") return Promise.resolve({ status: "invalid", logged_in: false });
      if (command === "auth_login") return Promise.resolve({ success: false });
      return Promise.reject(new Error(`unexpected command: ${command}`));
    });

    render(<LicenseProvider><AuthProbe /></LicenseProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "login" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("登录未完成");
    expect(mocks.sync).not.toHaveBeenCalled();
  });
});
