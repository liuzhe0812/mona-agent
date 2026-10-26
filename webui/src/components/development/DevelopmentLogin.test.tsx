import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeLoginStatus } from "@/lib/development-api";

const api = vi.hoisted(() => ({ login: vi.fn(), loginStatus: vi.fn(), cancelLogin: vi.fn(), send: vi.fn(), interrupt: vi.fn() }));
const openExternalUrl = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@/lib/development-api", async (original) => ({ ...(await original<typeof import("@/lib/development-api")>()), developmentApi: api }));
vi.mock("@/lib/tauri", () => ({ openExternalUrl }));

import { DevelopmentLogin } from "./DevelopmentLogin";

const idle: NativeLoginStatus = { state: "idle", loginId: null, authUrl: "", reason: "" };
const waiting: NativeLoginStatus = { state: "waiting", loginId: "login_first", authUrl: "https://auth.openai.com/test-only-login", reason: "等待官方登录" };
const finished: NativeLoginStatus = { ...waiting, state: "succeeded", authUrl: "", reason: "官方认证完成，不代表开发任务已完成" };

beforeEach(() => { vi.resetAllMocks(); api.loginStatus.mockResolvedValue(idle); });
afterEach(async () => { await act(async () => { cleanup(); }); });

function view(onChanged = vi.fn()) {
  return render(<DevelopmentLogin projectId="project_a" executor="codex" disabled={false} configRevision="one" onChanged={onChanged} />);
}

describe("official login lifecycle", () => {
  it("recovers an initial status read failure with a read-only check", async () => {
    api.loginStatus.mockRejectedValueOnce(new Error("status unavailable"));
    view();
    const retry = await screen.findByRole("button", { name: "重新检查" });
    expect(retry).toBeEnabled();
    fireEvent.click(retry);
    await waitFor(() => expect(screen.getByRole("button", { name: "获取官方登录链接" })).toBeEnabled());
    expect(api.loginStatus).toHaveBeenCalledTimes(2);
    expect(api.login).not.toHaveBeenCalled();
  });

  it("keeps inline reauthentication read-only after a lost response and cancels the restored attempt", async () => {
    api.login.mockRejectedValueOnce(new Error("lost response"));
    const changed = vi.fn();
    render(<DevelopmentLogin executor="codebuddy" disabled={false} authorizationRequired inline
      actionLabel="重新认证" actionVariant="ghost" onChanged={changed} />);
    const reauthenticate = screen.getByRole("button", { name: "重新认证" });
    await waitFor(() => expect(reauthenticate).toBeEnabled());
    fireEvent.click(reauthenticate);
    fireEvent.click(reauthenticate);
    expect(await screen.findByRole("alert")).toHaveTextContent("连接状态暂未确认，请重新检查。");
    expect(api.login).toHaveBeenCalledTimes(1);
    api.loginStatus.mockResolvedValue(waiting);
    fireEvent.click(screen.getByRole("button", { name: "重新检查" }));
    expect(await screen.findByText("等待浏览器认证…")).toBeInTheDocument();
    expect(screen.queryByText(waiting.reason)).not.toBeInTheDocument();
    const cancelled = { ...waiting, state: "cancelled", authUrl: "", reason: "本次认证已取消" } as NativeLoginStatus;
    api.cancelLogin.mockImplementation(async () => { api.loginStatus.mockResolvedValue(cancelled); return cancelled; });
    fireEvent.click(screen.getByRole("button", { name: "取消认证" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "重新认证" })).toBeEnabled());
    expect(api.cancelLogin).toHaveBeenCalledWith(undefined, "codebuddy", waiting.loginId);
    expect(api.login).toHaveBeenCalledTimes(1);
    expect(api.interrupt).not.toHaveBeenCalled();
  });

  it("restores pending login from the host and unmounting does not cancel it", async () => {
    api.loginStatus.mockResolvedValue(waiting);
    const ui = view();
    expect(await screen.findByRole("button", { name: "重新打开授权页" })).toBeInTheDocument();
    expect(api.login).not.toHaveBeenCalled();
    ui.unmount();
    expect(api.cancelLogin).not.toHaveBeenCalled();
    expect(api.interrupt).not.toHaveBeenCalled();
  });

  it("observes completion, removes the one-time URL and never sends a development task", async () => {
    const changed = vi.fn();
    api.login.mockImplementation(async () => { api.loginStatus.mockResolvedValue(waiting); return waiting; });
    view(changed);
    await waitFor(() => expect(screen.getByRole("button", { name: "获取官方登录链接" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "获取官方登录链接" }));
    await waitFor(() => expect(openExternalUrl).toHaveBeenCalledWith(waiting.authUrl));
    expect(await screen.findByRole("button", { name: "重新打开授权页" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "取消连接" })).toBeEnabled();
    api.loginStatus.mockResolvedValue(finished);
    expect(await screen.findByText("已授权", {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.queryByText("已连接")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重新打开授权页" })).not.toBeInTheDocument();
    expect(api.login).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(api.send).not.toHaveBeenCalled();
  });

  it("cancels only the displayed login and waits for the real outcome", async () => {
    api.loginStatus.mockResolvedValue(waiting);
    const cancelled: NativeLoginStatus = { ...waiting, state: "cancelled", authUrl: "", reason: "本次登录已取消" };
    api.cancelLogin.mockImplementation(async () => { api.loginStatus.mockResolvedValue(cancelled); return cancelled; });
    view();
    fireEvent.click(await screen.findByRole("button", { name: "取消连接" }));
    await screen.findByText(cancelled.reason);
    expect(api.cancelLogin).toHaveBeenCalledWith("project_a", "codex", "login_first");
    expect(api.interrupt).not.toHaveBeenCalled();
    expect(api.login).not.toHaveBeenCalled();
  });

  it("after a lost start response refreshes the same attempt instead of posting another login", async () => {
    api.login.mockRejectedValue(new Error("lost response"));
    view();
    await waitFor(() => expect(screen.getByRole("button", { name: "获取官方登录链接" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "获取官方登录链接" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "重新检查" })).toBeEnabled();
    api.loginStatus.mockResolvedValue(waiting);
    fireEvent.click(screen.getByRole("button", { name: "重新检查" }));
    await screen.findByRole("button", { name: "重新打开授权页" });
    expect(api.login).toHaveBeenCalledTimes(1);
  });

  it("does not let a historical login success hide a newly required authorization", async () => {
    let resolveStatus!: (value: NativeLoginStatus) => void;
    api.loginStatus.mockImplementationOnce(() => new Promise((resolve) => { resolveStatus = resolve; }));
    render(<DevelopmentLogin executor="codebuddy" disabled={false} authorizationRequired onChanged={vi.fn()} actionLabel="连接 CodeBuddy" />);
    const connect = screen.getByRole("button", { name: "连接 CodeBuddy" });
    expect(connect).toBeDisabled();
    await act(async () => { resolveStatus(finished); });
    expect(connect).toBeEnabled();
    expect(screen.queryByText("已授权")).not.toBeInTheDocument();
    expect(api.login).not.toHaveBeenCalled();
  });

  it("does not let an old project response replace the current panel", async () => {
    let resolve!: (value: NativeLoginStatus) => void;
    api.login.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const ui = view();
    await waitFor(() => expect(screen.getByRole("button", { name: "获取官方登录链接" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "获取官方登录链接" }));
    ui.rerender(<DevelopmentLogin projectId="project_b" executor="codebuddy" disabled={false} configRevision="one" onChanged={vi.fn()} />);
    await act(async () => { resolve({ ...waiting, reason: "OLD_PROJECT_RESULT" }); });
    expect(screen.queryByText("OLD_PROJECT_RESULT")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重新打开授权页" })).not.toBeInTheDocument();
    expect(api.cancelLogin).not.toHaveBeenCalled();
  });
});
