import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminApp } from "./AdminApp";

const originalStatus = {
  revision: "version-1",
  configuration: { cli_path: "", model: "", billing_model: "", label: "Codex", auth_mode: "chatgpt" },
  connection: { state: "unconfigured", message: "尚未配置", models: [{ id: "codex-model", label: "Codex model" }] },
  billing: { mode: "wallet", ready: false, message: "余额计费尚未接通" },
  public_enabled: false,
  qwen: { free: true, all_accounts: true },
  login_commands: ["codex login"],
};

const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "Content-Type": "application/json" },
});

beforeEach(() => {
  sessionStorage.clear();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(originalStatus)));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("hosted model administration", () => {
  it("asks for an administrator login without making a request if there is no session", () => {
    render(<AdminApp />);
    expect(screen.getByRole("link", { name: "前往管理员登录" })).toHaveAttribute("href", "/admin");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("loads with the existing administrator session and states the actual availability", async () => {
    sessionStorage.setItem("admin_token", "admin-session");
    render(<AdminApp />);
    expect(await screen.findByText("余额计费尚未接通，Codex 未向用户开放。")).toBeInTheDocument();
    expect(screen.getByText("所有账号免费，不扣余额。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /开放|启用|上线/ })).not.toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith("/api/work/admin/codex", expect.objectContaining({
      method: "GET", credentials: "omit", cache: "no-store", redirect: "error",
      headers: expect.objectContaining({ Authorization: "Bearer admin-session" }),
    }));
  });

  it("validates the path, saves only the requested fields, and probes the saved version", async () => {
    sessionStorage.setItem("mona-website-session-v1", JSON.stringify({ token: "website-session", user: { id: "admin" } }));
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(response(originalStatus))
      .mockResolvedValueOnce(response({ ...originalStatus, revision: "version-2", configuration: {
        ...originalStatus.configuration, cli_path: "/usr/local/bin/codex", model: "codex-model", billing_model: "price-model",
      } }))
      .mockResolvedValueOnce(response({ ...originalStatus, revision: "version-2", configuration: {
        ...originalStatus.configuration, cli_path: "/usr/local/bin/codex", model: "codex-model", billing_model: "price-model",
      }, connection: { ...originalStatus.connection, message: "已检测到登录" } }));
    render(<AdminApp />);
    const path = await screen.findByLabelText("CLI 程序路径");
    fireEvent.change(path, { target: { value: "relative/codex" } });
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
    expect(screen.getByText("请输入 Ubuntu 上的绝对程序路径。")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fireEvent.change(path, { target: { value: "/usr/local/bin/codex" } });
    fireEvent.change(screen.getByLabelText("模型 ID"), { target: { value: "codex-model" } });
    fireEvent.change(screen.getByLabelText("账务模型 ID"), { target: { value: "price-model" } });
    expect(screen.getByRole("button", { name: "检测连接" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
    await screen.findByText(/配置已保存/);
    const saveCall = fetchMock.mock.calls[1];
    expect(saveCall[0]).toBe("/api/work/admin/codex");
    expect(saveCall[1]).toMatchObject({ method: "PUT", credentials: "omit", cache: "no-store", redirect: "error",
      headers: { Authorization: "Bearer website-session", Accept: "application/json", "Content-Type": "application/json" } });
    expect(JSON.parse(saveCall[1]!.body as string)).toEqual({ expected_revision: "version-1", configuration: {
      cli_path: "/usr/local/bin/codex", model: "codex-model", billing_model: "price-model", label: "Codex", auth_mode: "chatgpt",
    } });
    fireEvent.click(screen.getByRole("button", { name: "检测连接" }));
    expect(await screen.findByText("已检测到登录")).toBeInTheDocument();
    expect(fetchMock.mock.calls[2][0]).toBe("/api/work/admin/codex/probe");
    expect(fetchMock.mock.calls[2][1]).toMatchObject({ method: "POST", body: "{}", credentials: "omit", cache: "no-store", redirect: "error" });
  });

  it("explains denied access without clearing other sessions", async () => {
    sessionStorage.setItem("admin_token", "admin-session");
    sessionStorage.setItem("mona-website-session-v1", "other-session");
    vi.mocked(fetch).mockResolvedValue(response({}, 403));
    render(<AdminApp />);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("没有管理权限")).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: "前往管理员登录" })).toHaveAttribute("href", "/admin");
    expect(sessionStorage.getItem("admin_token")).toBe("admin-session");
    expect(sessionStorage.getItem("mona-website-session-v1")).toBe("other-session");
  });

  it("preserves an edited draft when another administrator changes the configuration", async () => {
    sessionStorage.setItem("admin_token", "admin-session");
    vi.mocked(fetch).mockResolvedValueOnce(response(originalStatus)).mockResolvedValueOnce(response({}, 409));
    render(<AdminApp />);
    const model = await screen.findByLabelText("模型 ID");
    fireEvent.change(model, { target: { value: "new-model" } });
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
    expect(await screen.findByText("配置已变化")).toBeInTheDocument();
    await waitFor(() => expect(model).toHaveValue("new-model"));
  });
});
