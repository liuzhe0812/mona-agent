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

const modelSettings = { revision: "version-1", synchronized: true, models: [{ id: "actual-model", configuration: {
  source: "mona", label: "实际免费模型", api_base: "https://models.example/v1", api_key_env: "MONA_WORK_MODEL_EXAMPLE",
  model: "provider-model", context_window_tokens: null, max_output_tokens: 4096, reasoning_effort: null,
}, credentials: { configured: true } }],
billing: { mode: "shared_wallet", ready: false, prices_endpoint: "/admin/credits/model-prices", admin_url: "/admin" } };

function routes(codex: (init?: RequestInit) => Response = () => response(originalStatus)) {
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    if (input === "/api/work/admin/models") return response(modelSettings);
    if (input === "/admin/credits/model-prices") return response({ prices: [] });
    return codex(init);
  });
}

beforeEach(() => {
  sessionStorage.clear();
  vi.stubGlobal("fetch", vi.fn());
  routes();
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
    expect(await screen.findByText(/当前服务已加载凭据/)).toBeInTheDocument();
    expect(screen.getByText("实际免费模型")).toBeInTheDocument();
    expect(screen.queryByText("Qwen3.7")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /开放|启用|上线/ })).not.toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith("/api/work/admin/codex", expect.objectContaining({
      method: "GET", credentials: "omit", cache: "no-store", redirect: "error",
      headers: expect.objectContaining({ Authorization: "Bearer admin-session" }),
    }));
  });

  it("validates the path, saves only the requested fields, and probes the saved version", async () => {
    sessionStorage.setItem("mona-website-session-v1", JSON.stringify({ token: "website-session", user: { id: "admin" } }));
    const fetchMock = vi.mocked(fetch);
    routes(init => init?.method === "PUT" ? response({ ...originalStatus, revision: "version-2", configuration: {
        ...originalStatus.configuration, cli_path: "/usr/local/bin/codex", model: "codex-model", billing_model: "price-model",
      } }) : init?.method === "POST" ? response({ ...originalStatus, revision: "version-2", configuration: {
        ...originalStatus.configuration, cli_path: "/usr/local/bin/codex", model: "codex-model", billing_model: "price-model",
      }, connection: { ...originalStatus.connection, message: "已检测到登录" } }) : response(originalStatus));
    render(<AdminApp />);
    const path = await screen.findByLabelText("CLI 程序路径");
    fireEvent.change(path, { target: { value: "relative/codex" } });
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
    expect(screen.getByText("请输入 Ubuntu 上的绝对程序路径。")).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/work/admin/codex")).toHaveLength(1);
    fireEvent.change(path, { target: { value: "/usr/local/bin/codex" } });
    fireEvent.change(screen.getByLabelText("模型 ID"), { target: { value: "codex-model" } });
    fireEvent.change(screen.getByLabelText("账务模型 ID"), { target: { value: "price-model" } });
    expect(screen.getByRole("button", { name: "检测连接" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
    await screen.findByText(/配置已保存/);
    const saveCall = fetchMock.mock.calls.find(([url, init]) => url === "/api/work/admin/codex" && init?.method === "PUT")!;
    expect(saveCall[0]).toBe("/api/work/admin/codex");
    expect(saveCall[1]).toMatchObject({ method: "PUT", credentials: "omit", cache: "no-store", redirect: "error",
      headers: { Authorization: "Bearer website-session", Accept: "application/json", "Content-Type": "application/json" } });
    expect(JSON.parse(saveCall[1]!.body as string)).toEqual({ expected_revision: "version-1", configuration: {
      cli_path: "/usr/local/bin/codex", model: "codex-model", billing_model: "price-model", label: "Codex", auth_mode: "chatgpt",
    } });
    fireEvent.click(screen.getByRole("button", { name: "检测连接" }));
    expect(await screen.findByText("已检测到登录")).toBeInTheDocument();
    const probeCall = fetchMock.mock.calls.find(([url]) => url === "/api/work/admin/codex/probe")!;
    expect(probeCall[1]).toMatchObject({ method: "POST", body: "{}", credentials: "omit", cache: "no-store", redirect: "error" });
  });

  it("explains denied access without clearing other sessions", async () => {
    sessionStorage.setItem("admin_token", "admin-session");
    sessionStorage.setItem("mona-website-session-v1", "other-session");
    routes(() => response({}, 403));
    render(<AdminApp />);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("没有管理权限")).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: "前往管理员登录" })).toHaveAttribute("href", "/admin");
    expect(sessionStorage.getItem("admin_token")).toBe("admin-session");
    expect(sessionStorage.getItem("mona-website-session-v1")).toBe("other-session");
  });

  it("preserves an edited draft when another administrator changes the configuration", async () => {
    sessionStorage.setItem("admin_token", "admin-session");
    routes(init => init?.method === "PUT" ? response({ error: "configuration_changed" }, 409) : response(originalStatus));
    render(<AdminApp />);
    const model = await screen.findByLabelText("模型 ID");
    fireEvent.change(model, { target: { value: "new-model" } });
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
    expect(await screen.findByText("配置已变化")).toBeInTheDocument();
    await waitFor(() => expect(model).toHaveValue("new-model"));
  });

  it("shares revisions in both directions without losing an unsaved Codex draft", async () => {
    sessionStorage.setItem("admin_token", "admin-session");
    let revision = "version-1";
    let codex = originalStatus.configuration;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (url === "/admin/credits/model-prices") return response({ prices: [] });
      if (url === "/api/work/admin/models") {
        if (init?.method === "PUT") {
          const body = JSON.parse(init.body as string);
          expect(body.expected_revision).toBe(revision);
          revision = revision === "version-1" ? "version-2" : "version-4";
          return response({ ...modelSettings, revision, models: [{ ...modelSettings.models[0], configuration: body.configuration }] });
        }
        return response({ ...modelSettings, revision });
      }
      if (init?.method === "PUT") {
        const body = JSON.parse(init.body as string);
        expect(body.expected_revision).toBe("version-2");
        codex = body.configuration;
        revision = "version-3";
      }
      return response({ ...originalStatus, configuration: codex, revision });
    });
    render(<AdminApp />);
    const model = await screen.findByLabelText("模型 ID");
    const apiLabel = await screen.findByDisplayValue("实际免费模型");
    fireEvent.change(model, { target: { value: "unsaved-codex-model" } });
    fireEvent.change(apiLabel, { target: { value: "免费线路新名称" } });
    fireEvent.click(screen.getByRole("button", { name: "保存免费 API 配置" }));
    await screen.findByText(/免费 API 配置已保存/);
    expect(model).toHaveValue("unsaved-codex-model");
    expect(screen.getByRole("button", { name: "检测连接" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
    await screen.findByText(/配置已保存。请检测连接/);
    fireEvent.change(apiLabel, { target: { value: "再次更新免费线路" } });
    fireEvent.click(screen.getByRole("button", { name: "保存免费 API 配置" }));
    await waitFor(() => expect(revision).toBe("version-4"));
    expect(model).toHaveValue("unsaved-codex-model");
  });
});
