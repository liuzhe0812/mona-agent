import { useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), unlisten: vi.fn() }));
vi.mock("@/lib/tauri", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
import { LicenseProvider, useLicense } from "./useLicense";

const deviceId = "a".repeat(32);
const account = { status: "valid", account: "current-user", email: "current@example.invalid", trial: false,
  expires_at: null, device_limit: 3, device_session_id: deviceId };

function Probe() {
  const { licenseInfo, loggedIn, licenseActive, removeLoginDevice, login, logout } = useLicense();
  const [error, setError] = useState("");
  return <div>
    <span>{licenseInfo?.account ?? "none"}</span>
    <span>{loggedIn ? "logged-in" : "logged-out"}</span>
    <span>{licenseActive ? "pro" : "free"}</span>
    <button onClick={() => void removeLoginDevice({ id: deviceId, revision: 1 }).catch((e) => setError(String(e)))}>remove</button>
    <button onClick={() => void login("another", "fixture-only").catch((e) => setError(String(e)))}>switch</button>
    <button onClick={() => void logout().catch((e) => setError(String(e)))}>logout</button>
    {error && <p role="alert">{error}</p>}
  </div>;
}

beforeEach(() => {
  vi.resetAllMocks();
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: { invoke: mocks.invoke } });
  mocks.listen.mockResolvedValue(mocks.unlisten);
  mocks.invoke.mockImplementation((command: string) => {
    if (command === "get_pricing") return Promise.resolve({ plans: [], contact: {} });
    if (command === "check_license") return Promise.resolve(account);
    throw new Error(`Unexpected native command ${command}`);
  });
});
const show = async () => {
  const view = render(<LicenseProvider><Probe /></LicenseProvider>);
  await screen.findByText("current-user");
  return view;
};

describe("device removal through the real account provider", () => {
  it("clears current login and Pro state immediately after confirmed self-removal", async () => {
    await show();
    mocks.invoke.mockResolvedValueOnce({ success: true, device_id: deviceId, current_device_removed: true });
    fireEvent.click(screen.getByRole("button", { name: "remove" }));
    await screen.findByText("logged-out");
    expect(screen.getByText("none")).toBeInTheDocument();
    expect(screen.getByText("free")).toBeInTheDocument();
    expect(mocks.invoke).toHaveBeenCalledWith("revoke_login_device", { device: { id: deviceId, revision: 1 } });
    expect(mocks.invoke.mock.calls.filter(([name]) => name === "check_license")).toHaveLength(1);
  });

  it("removing another device does not log out this one", async () => {
    await show();
    mocks.invoke.mockResolvedValueOnce({ success: true, device_id: deviceId, current_device_removed: false });
    fireEvent.click(screen.getByRole("button", { name: "remove" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("revoke_login_device", expect.anything()));
    expect(screen.getByText("current-user")).toBeInTheDocument();
    expect(screen.getByText("logged-in")).toBeInTheDocument();
  });

  it("false success never signs the account out", async () => {
    await show();
    mocks.invoke.mockResolvedValueOnce({ success: false });
    fireEvent.click(screen.getByRole("button", { name: "remove" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("尚未确认移除结果");
    expect(screen.getByText("logged-in")).toBeInTheDocument();
  });

  it("an old delayed removal cannot clear a newly logged-in account", async () => {
    await show();
    let finish!: (value: unknown) => void;
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "revoke_login_device") return new Promise((resolve) => { finish = resolve; });
      if (command === "auth_login") return Promise.resolve({ success: true });
      if (command === "check_license") return Promise.resolve({ ...account, account: "new-account", device_session_id: "b".repeat(32) });
      return Promise.resolve({ plans: [], contact: {} });
    });
    fireEvent.click(screen.getByRole("button", { name: "remove" }));
    fireEvent.click(screen.getByRole("button", { name: "switch" }));
    await screen.findByText("new-account");
    await act(async () => finish({ success: true, device_id: deviceId, current_device_removed: true }));
    expect(screen.getByText("new-account")).toBeInTheDocument();
    expect(screen.getByText("logged-in")).toBeInTheDocument();
  });

  it("confirmed sign-out events also update other open windows", async () => {
    const view = await show();
    await waitFor(() => expect(mocks.listen).toHaveBeenCalled());
    const callback = mocks.listen.mock.calls[0][1];
    act(() => callback({ payload: { loggedIn: false, devicesChanged: true } }));
    expect(screen.getByText("logged-out")).toBeInTheDocument();
    expect(screen.getByText("none")).toBeInTheDocument();
    view.unmount();
    expect(mocks.unlisten).toHaveBeenCalled();
  });

  it("network failure or false success keeps the current account intact", async () => {
    await show();
    mocks.invoke.mockResolvedValueOnce({ success: false });
    fireEvent.click(screen.getByRole("button", { name: "logout" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("尚未确认退出结果");
    expect(screen.getByText("logged-in")).toBeInTheDocument();
  });
});
