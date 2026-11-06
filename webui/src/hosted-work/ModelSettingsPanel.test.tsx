import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ModelSettingsPanel } from "./ModelSettingsPanel";

const apiConfiguration = { label: "Qwen", source: "mona", api_base: "https://model.example/v1",
  api_key_env: "MONA_WORK_MODEL_CUSTOM", model: "actual-provider-model", context_window_tokens: null,
  max_output_tokens: 4096, reasoning_effort: null, billing_mode: "free", billing_model: "" };
const codexConfiguration = { label: "Codex", cli_path: "/usr/local/bin/codex", model: "codex-model",
  auth_mode: "chatgpt", context_window_tokens: null, max_output_tokens: 4096, reasoning_effort: null,
  billing_mode: "wallet", billing_model: "paid-model" };
const modelRow = { id: "qwen", configuration: apiConfiguration, credentials: { configured: true },
  availability: { ready: true, message: "模型可用。" } };
const modelStatus = { revision: "rev-1", synchronized: true, models: [modelRow], billing: { mode: "shared_wallet", ready: false,
  prices_endpoint: "/admin/credits/model-prices", admin_url: "/admin" } };
const codexStatus = { revision: "rev-1", configuration: codexConfiguration,
  connection: { state: "configured", message: "尚未检测。", models: [] },
  billing: { mode: "wallet", ready: false, message: "余额计费尚未接通。" },
  execution: { ready: false, message: "Codex CLI 执行接入尚未完成，暂不可调用。" },
  public_enabled: false, login_commands: ["codex login"] };
const price = (version: number, enabled = true, model = "paid-model") => ({ model, version, enabled,
  billing_type: "token", input_amount_per_million: String(version), cached_input_amount_per_million: "0.25",
  output_amount_per_million: "12.50" });
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "Content-Type": "application/json" },
});

function setup() {
  let revision = "rev-1";
  let models = [modelRow];
  let configuration = codexConfiguration;
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    if (url === "/admin/credits/model-prices") return response({ prices: [price(1), price(3), price(9, false),
      price(8, true, "other-model"), { ...price(10), billing_type: "image" }] });
    if (url === "/api/work/admin/models") {
      if (init?.method === "PUT") {
        const body = JSON.parse(init.body as string);
        if (body.expected_revision !== revision) return response({ error: "configuration_changed" }, 409);
        revision = revision === "rev-1" ? "rev-2" : "rev-3";
        const row = { ...modelRow, id: body.model_id, configuration: body.configuration,
          availability: { ready: body.configuration.billing_mode === "free", message: "实际状态" } };
        models = [...models.filter(item => item.id !== body.model_id), row];
      }
      return response({ ...modelStatus, revision, models });
    }
    if (url === "/api/work/admin/codex" || url === "/api/work/admin/codex/probe") {
      if (init?.method === "PUT") {
        const body = JSON.parse(init.body as string);
        if (body.expected_revision !== revision) return response({ error: "configuration_changed" }, 409);
        configuration = body.configuration;
        revision = revision === "rev-1" ? "rev-2" : "rev-3";
      }
      return response({ ...codexStatus, revision, configuration, billing: { ...codexStatus.billing, mode: configuration.billing_mode },
        connection: { ...codexStatus.connection, message: init?.method === "POST" ? "连接检测完成。" : "尚未检测。" } });
    }
    throw new Error("Unexpected request");
  });
}

async function selectOption(label: string, option: string) {
  const trigger = screen.getByRole("button", { name: label });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  fireEvent.click(trigger);
  fireEvent.click(await screen.findByRole("menuitem", { name: option }));
}

beforeEach(() => {
  sessionStorage.clear();
  sessionStorage.setItem("admin_token", "price-admin-token");
  vi.stubGlobal("fetch", vi.fn());
  setup();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("work model and shared pricing settings", () => {
  it("shows both providers with the stored billing choice and actual availability", async () => {
    render(<ModelSettingsPanel token="work-admin-token" />);
    await screen.findByDisplayValue("actual-provider-model");
    const providers = screen.getByRole("group", { name: "模型提供者" });
    expect(within(providers).getAllByRole("button").map(button => button.textContent)).toEqual(["自定义 API", "Codex CLI"]);
    expect(screen.getByRole("button", { name: "计费方式" })).toHaveTextContent("免费");
    expect(screen.getByText("当前已保存状态：模型可用。")).toBeInTheDocument();
    expect(screen.queryByText(/所有账号免费|不扣用户余额|免费 API/)).not.toBeInTheDocument();
    fireEvent.click(within(providers).getByRole("button", { name: "Codex CLI" }));
    expect(screen.getByRole("button", { name: "计费方式" })).toHaveTextContent("共用余额");
    expect(screen.getByText("Codex CLI 执行接入尚未完成，暂不可调用。")).toBeInTheDocument();
    expect(screen.getByText("当前已保存计费状态：余额计费尚未接通。")).toBeInTheDocument();
    expect(document.querySelector('input[type="password"]')).toBeNull();
  });

  it("applies the selected price mapping to either provider without changing the existing price table", async () => {
    render(<ModelSettingsPanel token="work-admin-token" />);
    await screen.findByDisplayValue("actual-provider-model");
    fireEvent.change(screen.getByLabelText("账务模型 ID"), { target: { value: "paid-model" } });
    const prices = screen.getByRole("region", { name: "共用模型价格" });
    expect(await within(prices).findByText("paid-model · 价格版本 3")).toBeInTheDocument();
    expect(within(prices).getByText("¥3 / 百万 token")).toBeInTheDocument();
    expect(within(prices).getByText("¥0.25 / 百万 token")).toBeInTheDocument();
    expect(within(prices).getByText("¥12.50 / 百万 token")).toBeInTheDocument();
    expect(within(prices).getByText("当前表单选择免费，模型不会按价格表扣费。")).toBeInTheDocument();
    expect(within(prices).getByRole("link", { name: "前往管理后台设置模型价格" })).toHaveAttribute("href", "/admin");
    await selectOption("计费方式", "共用余额");
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
    await screen.findByText(/模型配置已保存/);
    const request = vi.mocked(fetch).mock.calls.find(([url, init]) => url === "/api/work/admin/models" && init?.method === "PUT")!;
    expect(JSON.parse(request[1]!.body as string)).toEqual({ expected_revision: "rev-1", model_id: "qwen",
      configuration: { ...apiConfiguration, billing_mode: "wallet", billing_model: "paid-model" } });
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => url === "/admin/credits/model-prices")
      .every(([, init]) => init?.method === "GET")).toBe(true);
    expect(fetch).toHaveBeenCalledWith("/admin/credits/model-prices", expect.objectContaining({ method: "GET",
      headers: expect.objectContaining({ Authorization: "Bearer price-admin-token" }), credentials: "omit" }));
  });

  it("lets the administrator select free for Codex while still reporting the unavailable execution adapter", async () => {
    render(<ModelSettingsPanel token="work-admin-token" />);
    await screen.findByDisplayValue("actual-provider-model");
    fireEvent.click(screen.getByRole("button", { name: "Codex CLI" }));
    await selectOption("计费方式", "免费");
    fireEvent.change(screen.getByLabelText("最大输出 token"), { target: { value: "8192" } });
    fireEvent.change(screen.getByLabelText("输入预算上限（可选）"), { target: { value: "64000" } });
    expect(screen.getByRole("button", { name: "检测连接" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
    await screen.findByText(/模型配置已保存/);
    const request = vi.mocked(fetch).mock.calls.find(([url, init]) => url === "/api/work/admin/codex" && init?.method === "PUT")!;
    expect(JSON.parse(request[1]!.body as string)).toEqual({ expected_revision: "rev-1", configuration: {
      ...codexConfiguration, billing_mode: "free", max_output_tokens: 8192, context_window_tokens: 64000,
    } });
    expect(screen.getByText("Codex CLI 执行接入尚未完成，暂不可调用。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "检测连接" }));
    expect(await screen.findByText("连接检测完成。")).toBeInTheDocument();
  });

  it("preserves each provider's draft and uses the latest revision after saving the other one", async () => {
    render(<ModelSettingsPanel token="work-admin-token" />);
    const label = await screen.findByLabelText("显示名称");
    fireEvent.change(label, { target: { value: "未保存的自定义名称" } });
    fireEvent.click(screen.getByRole("button", { name: "Codex CLI" }));
    fireEvent.change(screen.getByLabelText("显示名称"), { target: { value: "新的 Codex 名称" } });
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
    await screen.findByText(/模型配置已保存/);
    fireEvent.click(screen.getByRole("button", { name: "自定义 API" }));
    expect(screen.getByLabelText("显示名称")).toHaveValue("未保存的自定义名称");
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url, init]) => url === "/api/work/admin/models" && init?.method === "PUT")).toBe(true));
    const request = vi.mocked(fetch).mock.calls.find(([url, init]) => url === "/api/work/admin/models" && init?.method === "PUT")!;
    expect(JSON.parse(request[1]!.body as string).expected_revision).toBe("rev-2");
    fireEvent.click(screen.getByRole("button", { name: "Codex CLI" }));
    expect(screen.getByLabelText("显示名称")).toHaveValue("新的 Codex 名称");
  });

  it("starts new models as unpriced wallet drafts instead of assuming they are free", async () => {
    render(<ModelSettingsPanel token="work-admin-token" />);
    await screen.findByDisplayValue("actual-provider-model");
    fireEvent.click(screen.getByRole("button", { name: "新增模型" }));
    expect(screen.getByRole("button", { name: "计费方式" })).toHaveTextContent("共用余额");
    expect(screen.getByLabelText("账务模型 ID")).toHaveValue("");
    expect(screen.getByText("余额计费尚未接通，选择共用余额的模型暂不可调用。")).toBeInTheDocument();
  });

  it("keeps the draft on a conflict and refreshes the shared version before retry", async () => {
    let conflict = true;
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (url === "/api/work/admin/models" && init?.method === "PUT" && conflict) {
        conflict = false;
        return response({ error: "configuration_changed" }, 409);
      }
      const result = await original(url, init);
      if (!conflict && init?.method === "GET" && (url === "/api/work/admin/models" || url === "/api/work/admin/codex")) {
        return response({ ...await result.json(), revision: "rev-3" });
      }
      return result;
    });
    render(<ModelSettingsPanel token="work-admin-token" />);
    const model = await screen.findByDisplayValue("actual-provider-model");
    fireEvent.change(model, { target: { value: "draft-provider-model" } });
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
    await screen.findByText("配置已变化");
    expect(model).toHaveValue("draft-provider-model");
    expect(document.querySelector('button[type="submit"]')).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "刷新配置状态" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "保存配置" })).toBeEnabled());
    expect(model).toHaveValue("draft-provider-model");
  });

  it("refreshes unchanged fields from another administrator while retaining edited drafts", async () => {
    let externalUpdate = false;
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      const result = await original(url, init);
      if (externalUpdate && init?.method === "GET" && url === "/api/work/admin/models") {
        return response({ ...modelStatus, revision: "rev-external", models: [{ ...modelRow,
          configuration: { ...apiConfiguration, label: "其他管理员更新" } }] });
      }
      if (externalUpdate && init?.method === "GET" && url === "/api/work/admin/codex") {
        return response({ ...codexStatus, revision: "rev-external" });
      }
      return result;
    });
    render(<ModelSettingsPanel token="work-admin-token" />);
    await screen.findByDisplayValue("actual-provider-model");
    fireEvent.click(screen.getByRole("button", { name: "Codex CLI" }));
    fireEvent.change(screen.getByLabelText("显示名称"), { target: { value: "未保存的 Codex" } });
    fireEvent.click(screen.getByRole("button", { name: "自定义 API" }));
    externalUpdate = true;
    fireEvent.click(screen.getByRole("button", { name: "刷新模型状态" }));
    await waitFor(() => expect(screen.getByLabelText("显示名称")).toHaveValue("其他管理员更新"));
    fireEvent.click(screen.getByRole("button", { name: "Codex CLI" }));
    expect(screen.getByLabelText("显示名称")).toHaveValue("未保存的 Codex");
  });

  it("does not adopt a newer revision from a connection probe over a stale model snapshot", async () => {
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (url, init) => url === "/api/work/admin/codex/probe"
      ? response({ ...codexStatus, revision: "rev-external" }) : original(url, init));
    render(<ModelSettingsPanel token="work-admin-token" />);
    await screen.findByDisplayValue("actual-provider-model");
    fireEvent.change(screen.getByLabelText("显示名称"), { target: { value: "未保存的自定义名称" } });
    fireEvent.click(screen.getByRole("button", { name: "Codex CLI" }));
    fireEvent.click(screen.getByRole("button", { name: "检测连接" }));
    await screen.findByText("配置已变化");
    expect(document.querySelector('button[type="submit"]')).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    fireEvent.click(screen.getByRole("button", { name: "自定义 API" }));
    expect(screen.getByLabelText("显示名称")).toHaveValue("未保存的自定义名称");
    expect(screen.getByRole("button", { name: "保存配置" })).toBeDisabled();
  });

  it("supports a website administrator session for both model status and prices", async () => {
    sessionStorage.removeItem("admin_token");
    render(<ModelSettingsPanel token="work-admin-token" />);
    await screen.findByDisplayValue("actual-provider-model");
    expect(fetch).toHaveBeenCalledWith("/admin/credits/model-prices", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer work-admin-token" }),
    }));
  });
});
