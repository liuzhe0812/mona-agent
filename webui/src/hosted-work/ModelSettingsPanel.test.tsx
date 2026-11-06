import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ModelSettingsPanel } from "./ModelSettingsPanel";
import { isValidPriceAmount } from "./model-admin-api";

const apiConfiguration = { label: "Qwen", source: "mona", api_base: "https://model.example/v1",
  api_key_env: "MONA_WORK_MODEL_CUSTOM", model: "actual-provider-model", context_window_tokens: null,
  max_output_tokens: 4096, reasoning_effort: null, billing_mode: "free", billing_model: "" };
const codexConfiguration = { label: "Codex", cli_path: "/usr/local/bin/codex", model: "codex-model",
  auth_mode: "chatgpt", context_window_tokens: null, max_output_tokens: 4096, reasoning_effort: null,
  billing_mode: "wallet", billing_model: "paid-model" };
const modelRow = { id: "qwen", configuration: apiConfiguration, credentials: { configured: true },
  availability: { ready: true, message: "模型可用。" } };
const modelStatus = { revision: "rev-1", synchronized: true, models: [modelRow], billing: { mode: "shared_wallet", ready: false } };
const codexStatus = { revision: "rev-1", configuration: codexConfiguration,
  connection: { state: "configured", message: "尚未检测。", models: [] },
  billing: { mode: "wallet", ready: false, message: "余额计费尚未接通。" },
  execution: { ready: false, message: "Codex CLI 执行接入尚未完成，暂不可调用。" },
  public_enabled: false, login_commands: ["codex login"], discovery: { state: "not_found", path: null } };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "Content-Type": "application/json" },
});

function setup() {
  let revision = "rev-1";
  let models = [modelRow];
  let configuration = codexConfiguration;
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    if (url === "/api/work/admin/models") {
      if (init?.method === "PUT") {
        const body = JSON.parse(init.body as string);
        if (body.expected_revision !== revision) return response({ error: "configuration_changed" }, 409);
        revision = revision === "rev-1" ? "rev-2" : "rev-3";
        const row = { ...modelRow, id: body.model_id, configuration: { ...modelRow.configuration, ...body.configuration },
          availability: { ready: body.configuration.billing_mode === "free", message: "实际状态" } };
        models = [...models.filter(item => item.id !== body.model_id), row];
      }
      return response({ ...modelStatus, revision, models });
    }
    if (url === "/api/work/admin/codex" || url === "/api/work/admin/codex/probe") {
      if (init?.method === "PUT") {
        const body = JSON.parse(init.body as string);
        if (body.expected_revision !== revision) return response({ error: "configuration_changed" }, 409);
        configuration = { ...configuration, ...body.configuration };
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
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("work model and independent pricing settings", () => {
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

  it("saves exact independent prices without reading or writing the app price table", async () => {
    render(<ModelSettingsPanel token="work-admin-token" />);
    await screen.findByDisplayValue("actual-provider-model");
    const prices = screen.getByRole("group", { name: "工作台模型价格" });
    expect(within(prices).getByText(/人民币 \/ 百万 token/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("输入价格"), { target: { value: "0" } });
    fireEvent.change(screen.getByLabelText("缓存输入价格"), { target: { value: "0.250001" } });
    fireEvent.change(screen.getByLabelText("输出价格"), { target: { value: "12.50" } });
    await selectOption("计费方式", "共用余额");
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
    await screen.findByText(/模型配置已保存/);
    const request = vi.mocked(fetch).mock.calls.find(([url, init]) => url === "/api/work/admin/models" && init?.method === "PUT")!;
    const { billing_model: _legacy, ...expected } = apiConfiguration;
    expect(JSON.parse(request[1]!.body as string)).toEqual({ expected_revision: "rev-1", model_id: "qwen",
      configuration: { ...expected, billing_mode: "wallet", price: { input_amount_per_million: "0",
        cached_input_amount_per_million: "0.250001", output_amount_per_million: "12.50" } } });
    expect(screen.queryByLabelText("账务模型 ID")).not.toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).startsWith("/admin/credits/model-prices"))).toBe(false);
  });

  it("lets the administrator select free for Codex while still reporting the unavailable execution adapter", async () => {
    render(<ModelSettingsPanel token="work-admin-token" />);
    await screen.findByDisplayValue("actual-provider-model");
    fireEvent.click(screen.getByRole("button", { name: "Codex CLI" }));
    await selectOption("计费方式", "免费");
    fireEvent.change(screen.getByLabelText("最大输出 token"), { target: { value: "8192" } });
    fireEvent.change(screen.getByLabelText("输入预算上限（可选）"), { target: { value: "64000" } });
    fireEvent.change(screen.getByLabelText("输入价格"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("缓存输入价格"), { target: { value: "0" } });
    fireEvent.change(screen.getByLabelText("输出价格"), { target: { value: "4.500000" } });
    expect(screen.getByRole("button", { name: "检测连接" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
    await screen.findByText(/模型配置已保存/);
    const request = vi.mocked(fetch).mock.calls.find(([url, init]) => url === "/api/work/admin/codex" && init?.method === "PUT")!;
    const { billing_model: _legacy, ...expected } = codexConfiguration;
    expect(JSON.parse(request[1]!.body as string)).toEqual({ expected_revision: "rev-1", configuration: {
      ...expected, billing_mode: "free", max_output_tokens: 8192, context_window_tokens: 64000,
      price: { input_amount_per_million: "2", cached_input_amount_per_million: "0", output_amount_per_million: "4.500000" },
    } });
    expect(screen.getByText("Codex CLI 执行接入尚未完成，暂不可调用。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "检测连接" }));
    expect(await screen.findByText("连接检测完成。")).toBeInTheDocument();
  });

  it("validates price precision and range using decimal strings", () => {
    for (const value of ["0", "0.000001", "1.00", "999999999.999999", "1000000000.000000"]) {
      expect(isValidPriceAmount(value), value).toBe(true);
    }
    for (const value of ["", "-1", "+1", "01", "1e3", "1.0000001", "1000000000.000001", "1000000001", "NaN"]) {
      expect(isValidPriceAmount(value), value).toBe(false);
    }
  });

  it("requires all three prices together and lets the administrator explicitly clear them", async () => {
    render(<ModelSettingsPanel token="work-admin-token" />);
    await screen.findByDisplayValue("actual-provider-model");
    const input = screen.getByLabelText("输入价格");
    const cached = screen.getByLabelText("缓存输入价格");
    const output = screen.getByLabelText("输出价格");
    fireEvent.change(input, { target: { value: "1e3" } });
    fireEvent.change(cached, { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(output).toHaveAttribute("aria-invalid", "true");
    expect(vi.mocked(fetch).mock.calls.some(([url, init]) => url === "/api/work/admin/models" && init?.method === "PUT")).toBe(false);
    fireEvent.change(input, { target: { value: "0" } });
    fireEvent.change(output, { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
    await screen.findByText(/模型配置已保存/);
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.change(cached, { target: { value: "" } });
    fireEvent.change(output, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.filter(([url, init]) => url === "/api/work/admin/models" && init?.method === "PUT")).toHaveLength(2));
    const saves = vi.mocked(fetch).mock.calls.filter(([url, init]) => url === "/api/work/admin/models" && init?.method === "PUT");
    expect(JSON.parse(saves[0][1]!.body as string).configuration.price).toEqual({ input_amount_per_million: "0",
      cached_input_amount_per_million: "0", output_amount_per_million: "0" });
    expect(JSON.parse(saves[1][1]!.body as string).configuration.price).toBeNull();
  });

  it("preserves existing prices and legacy mappings when editing unrelated settings", async () => {
    const savedPrice = { input_amount_per_million: "1.25", cached_input_amount_per_million: "0", output_amount_per_million: "3" };
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (url === "/api/work/admin/models") {
        const changes = init?.method === "PUT" ? JSON.parse(init.body as string).configuration : {};
        return response({ ...modelStatus, revision: init?.method === "PUT" ? "rev-2" : "rev-1",
          models: [{ ...modelRow, configuration: { ...apiConfiguration, billing_model: "legacy-unchanged", price: savedPrice, ...changes } }] });
      }
      return original(url, init);
    });
    render(<ModelSettingsPanel token="work-admin-token" />);
    await screen.findByDisplayValue("actual-provider-model");
    expect(screen.getByLabelText("输入价格")).toHaveValue("1.25");
    fireEvent.change(screen.getByLabelText("显示名称"), { target: { value: "新名称" } });
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
    await screen.findByText(/模型配置已保存/);
    const save = vi.mocked(fetch).mock.calls.find(([url, init]) => url === "/api/work/admin/models" && init?.method === "PUT")!;
    expect(JSON.parse(save[1]!.body as string).configuration).not.toHaveProperty("price");
    expect(JSON.parse(save[1]!.body as string).configuration).not.toHaveProperty("billing_model");
    expect(screen.getByLabelText("输入价格")).toHaveValue("1.25");
  });

  it("copies the visible price when changing a model ID to a new model", async () => {
    const savedPrice = { input_amount_per_million: "1.25", cached_input_amount_per_million: "0", output_amount_per_million: "3" };
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      const result = await original(url, init);
      if (url === "/api/work/admin/models" && init?.method === "GET") return response({ ...modelStatus,
        models: [{ ...modelRow, configuration: { ...apiConfiguration, price: savedPrice } }] });
      return result;
    });
    render(<ModelSettingsPanel token="work-admin-token" />);
    await screen.findByDisplayValue("actual-provider-model");
    expect(screen.getByLabelText("输入价格")).toHaveValue("1.25");
    fireEvent.change(screen.getByLabelText("平台模型标识"), { target: { value: "copy" } });
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
    await screen.findByText(/模型配置已保存/);
    const save = vi.mocked(fetch).mock.calls.find(([url, init]) => url === "/api/work/admin/models" && init?.method === "PUT")!;
    expect(JSON.parse(save[1]!.body as string).configuration.price).toEqual(savedPrice);
  });

  it("detects an installation after the page opens and preserves both providers' drafts", async () => {
    let installed = false;
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      const result = await original(url, init);
      if (url === "/api/work/admin/codex" && init?.method === "GET") {
        return response({ ...await result.json(), configuration: { ...codexConfiguration, cli_path: "" },
          discovery: installed ? { state: "found", path: "/home/mona/.local/bin/codex" } : { state: "not_found", path: null } });
      }
      return result;
    });
    render(<ModelSettingsPanel token="work-admin-token" />);
    await screen.findByDisplayValue("actual-provider-model");
    fireEvent.change(screen.getByLabelText("输出价格"), { target: { value: "3.25" } });
    vi.useFakeTimers();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Codex CLI" })); });
    expect(screen.getByText("尚未检测到 Codex CLI，安装后会自动重新检测。")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("模型 ID"), { target: { value: "unsaved-codex" } });
    fireEvent.change(screen.getByLabelText("输入价格"), { target: { value: "2.50" } });
    installed = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(screen.getByLabelText("CLI 程序路径")).toHaveValue("/home/mona/.local/bin/codex");
    expect(screen.getByLabelText("模型 ID")).toHaveValue("unsaved-codex");
    expect(screen.getByLabelText("输入价格")).toHaveValue("2.50");
    expect(screen.getByText("路径已填入，请保存配置后检查连接。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "自定义 API" }));
    expect(screen.getByLabelText("输出价格")).toHaveValue("3.25");
    expect(vi.mocked(fetch).mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  });

  it("never overwrites a manually entered or cleared CLI path without an explicit click", async () => {
    let installed = false;
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      const result = await original(url, init);
      if (url === "/api/work/admin/codex" && init?.method === "GET") return response({ ...await result.json(),
        configuration: { ...codexConfiguration, cli_path: "" },
        discovery: installed ? { state: "found", path: "/home/mona/.local/bin/codex" } : { state: "not_found", path: null } });
      return result;
    });
    render(<ModelSettingsPanel token="work-admin-token" />);
    await screen.findByDisplayValue("actual-provider-model");
    vi.useFakeTimers();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Codex CLI" })); });
    const path = screen.getByLabelText("CLI 程序路径");
    fireEvent.change(path, { target: { value: "/manual/codex" } });
    installed = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(path).toHaveValue("/manual/codex");
    fireEvent.change(path, { target: { value: "" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(path).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "使用检测到的路径" }));
    expect(path).toHaveValue("/home/mona/.local/bin/codex");
    expect(vi.mocked(fetch).mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  });

  it("keeps an already configured CLI path until the administrator chooses to replace it", async () => {
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      const result = await original(url, init);
      if (url === "/api/work/admin/codex" && init?.method === "GET") return response({ ...await result.json(),
        discovery: { state: "found", path: "/home/mona/.local/bin/codex" } });
      return result;
    });
    render(<ModelSettingsPanel token="work-admin-token" />);
    await screen.findByDisplayValue("actual-provider-model");
    fireEvent.click(screen.getByRole("button", { name: "Codex CLI" }));
    const path = screen.getByLabelText("CLI 程序路径");
    expect(path).toHaveValue("/usr/local/bin/codex");
    fireEvent.click(screen.getByRole("button", { name: "使用检测到的路径" }));
    expect(path).toHaveValue("/home/mona/.local/bin/codex");
  });

  it("blocks saving on a discovery revision conflict without losing price drafts", async () => {
    let changed = false;
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      const result = await original(url, init);
      if (url === "/api/work/admin/codex" && init?.method === "GET") return response({ ...await result.json(),
        revision: changed ? "rev-external" : "rev-1", configuration: { ...codexConfiguration, cli_path: "" } });
      return result;
    });
    render(<ModelSettingsPanel token="work-admin-token" />);
    await screen.findByDisplayValue("actual-provider-model");
    fireEvent.change(screen.getByLabelText("输入价格"), { target: { value: "6" } });
    vi.useFakeTimers();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Codex CLI" })); });
    fireEvent.change(screen.getByLabelText("输出价格"), { target: { value: "8" } });
    changed = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(screen.getByText("配置已变化")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(screen.getByLabelText("输出价格")).toHaveValue("8");
    expect(screen.getByRole("button", { name: "保存配置" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "自定义 API" }));
    expect(screen.getByLabelText("输入价格")).toHaveValue("6");
    expect(screen.getByRole("button", { name: "保存配置" })).toBeDisabled();
  });

  it("adopts another administrator's saved CLI path after refresh without losing other drafts", async () => {
    let changed = false;
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      const result = await original(url, init);
      if (url === "/api/work/admin/models" && init?.method === "GET") return response({ ...await result.json(),
        revision: changed ? "rev-external" : "rev-1" });
      if (url === "/api/work/admin/codex" && init?.method === "GET") return response({ ...await result.json(),
        revision: changed ? "rev-external" : "rev-1",
        configuration: { ...codexConfiguration, cli_path: changed ? "/other-admin/codex" : "" },
        discovery: { state: "found", path: "/detected/codex" } });
      return result;
    });
    render(<ModelSettingsPanel token="work-admin-token" />);
    await screen.findByDisplayValue("actual-provider-model");
    vi.useFakeTimers();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Codex CLI" })); });
    expect(screen.getByLabelText("CLI 程序路径")).toHaveValue("/detected/codex");
    fireEvent.change(screen.getByLabelText("模型 ID"), { target: { value: "unsaved-codex" } });
    fireEvent.change(screen.getByLabelText("输入价格"), { target: { value: "4.5" } });
    changed = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(screen.getByText("配置已变化")).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "刷新配置状态" })); });
    expect(screen.getByLabelText("CLI 程序路径")).toHaveValue("/other-admin/codex");
    expect(screen.getByLabelText("模型 ID")).toHaveValue("unsaved-codex");
    expect(screen.getByLabelText("输入价格")).toHaveValue("4.5");
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

  it("keeps the original model intact when saving a changed ID and refuses collisions", async () => {
    render(<ModelSettingsPanel token="work-admin-token" />);
    await screen.findByDisplayValue("actual-provider-model");
    fireEvent.change(screen.getByLabelText("平台模型标识"), { target: { value: "copy" } });
    fireEvent.change(screen.getByLabelText("显示名称"), { target: { value: "复制模型" } });
    for (const [label, value] of [["输入价格", "1"], ["缓存输入价格", "0"], ["输出价格", "2"]]) {
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    }
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
    await screen.findByText(/模型配置已保存/);
    await selectOption("选择模型", "Qwen (qwen)");
    expect(screen.getByLabelText("平台模型标识")).toHaveValue("qwen");
    expect(screen.getByLabelText("显示名称")).toHaveValue("Qwen");
    expect(screen.getByLabelText("输入价格")).toHaveValue("");
    fireEvent.change(screen.getByLabelText("平台模型标识"), { target: { value: "copy" } });
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
    expect(screen.getByText("此模型标识已存在，请先选择该模型。")).toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.filter(([url, init]) => url === "/api/work/admin/models" && init?.method === "PUT")).toHaveLength(1);
  });

  it("starts new models as unpriced wallet drafts instead of assuming they are free", async () => {
    render(<ModelSettingsPanel token="work-admin-token" />);
    await screen.findByDisplayValue("actual-provider-model");
    fireEvent.click(screen.getByRole("button", { name: "新增模型" }));
    expect(screen.getByRole("button", { name: "计费方式" })).toHaveTextContent("共用余额");
    expect(screen.getByLabelText("输入价格")).toHaveValue("");
    expect(screen.getByText("余额计费尚未接通，选择共用余额的模型暂不可调用。")).toBeInTheDocument();
  });

  it("clears the new-model form after a successful creation", async () => {
    render(<ModelSettingsPanel token="work-admin-token" />);
    await screen.findByDisplayValue("actual-provider-model");
    fireEvent.click(screen.getByRole("button", { name: "新增模型" }));
    for (const [label, value] of [["平台模型标识", "second"], ["显示名称", "第二个"], ["模型 ID", "provider-second"],
      ["API Base URL", "https://model.example/v1"], ["API Key 环境变量名称", "MONA_WORK_MODEL_CUSTOM"],
      ["输入价格", "3"], ["缓存输入价格", "0"], ["输出价格", "4"]]) {
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    }
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
    await screen.findByText(/模型配置已保存/);
    fireEvent.click(screen.getByRole("button", { name: "新增模型" }));
    expect(screen.getByLabelText("平台模型标识")).toHaveValue("");
    expect(screen.getByLabelText("输入价格")).toHaveValue("");
    expect(screen.getByLabelText("缓存输入价格")).toHaveValue("");
    expect(screen.getByLabelText("输出价格")).toHaveValue("");
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

  it("refreshes untouched prices while preserving explicit local price edits", async () => {
    let revision = "rev-1";
    let inputPrice = "1";
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      const result = await original(url, init);
      if (url === "/api/work/admin/models" && init?.method === "GET") return response({ ...modelStatus, revision,
        models: [{ ...modelRow, configuration: { ...apiConfiguration, price: { input_amount_per_million: inputPrice,
          cached_input_amount_per_million: "0", output_amount_per_million: "2" } } }] });
      if (url === "/api/work/admin/codex" && init?.method === "GET") return response({ ...codexStatus, revision });
      return result;
    });
    render(<ModelSettingsPanel token="work-admin-token" />);
    await screen.findByDisplayValue("actual-provider-model");
    fireEvent.change(screen.getByLabelText("显示名称"), { target: { value: "未保存的名称" } });
    revision = "rev-2"; inputPrice = "8.5";
    fireEvent.click(screen.getByRole("button", { name: "刷新模型状态" }));
    await waitFor(() => expect(screen.getByLabelText("输入价格")).toHaveValue("8.5"));
    expect(screen.getByLabelText("显示名称")).toHaveValue("未保存的名称");
    fireEvent.change(screen.getByLabelText("输入价格"), { target: { value: "9.5" } });
    revision = "rev-3"; inputPrice = "11";
    fireEvent.click(screen.getByRole("button", { name: "刷新模型状态" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "保存配置" })).toBeEnabled());
    expect(screen.getByLabelText("输入价格")).toHaveValue("9.5");
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

  it("supports a website administrator session without accessing application model prices", async () => {
    sessionStorage.removeItem("admin_token");
    render(<ModelSettingsPanel token="work-admin-token" />);
    await screen.findByDisplayValue("actual-provider-model");
    expect(fetch).toHaveBeenCalledWith("/api/work/admin/models", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer work-admin-token" }) }));
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).startsWith("/admin/credits/model-prices"))).toBe(false);
  });
});
