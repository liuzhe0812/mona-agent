import { createHash, webcrypto } from "node:crypto";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ModelSettingsPanel } from "./ModelSettingsPanel";
import { isValidPriceAmount, requestModelDiscovery } from "./model-admin-api";

const firstBase = "https://model.example/v1/";
const keyName = "MONA_WORK_MODEL_CUSTOM";
const initialConfiguration = { label: "Qwen3.7 Plus", source: "mona", api_base: firstBase,
  api_key_env: keyName, model: "qwen3.7-plus", context_window_tokens: null, max_output_tokens: 4096,
  reasoning_effort: "medium", billing_mode: "free", billing_model: "old-reference", price: null, enabled: true };
const initialModel = { id: "qwen", configuration: initialConfiguration, credentials: { configured: true },
  availability: { ready: true, message: "模型可用。" } };
const initialCodex = { label: "Codex", cli_path: "/usr/local/bin/codex", model: "", auth_mode: "chatgpt",
  context_window_tokens: null, max_output_tokens: 4096, reasoning_effort: null, billing_mode: "wallet",
  billing_model: "", price: null };
const price = { input_amount_per_million: "1.25", cached_input_amount_per_million: "0", output_amount_per_million: "2.75" };
const catalog = ["kimi-k2.5", "qwen3.5-plus", "glm-5", "MiniMax-M2.5", "qwen3.6-plus", "qwen3.7-plus"]
  .map((id, index) => ({ id, label: id, suggested_id: `api-${String(index + 1).repeat(24)}` }));
const secondCatalog = [{ id: "qwen3.7-plus", label: "qwen3.7-plus", suggested_id: `api-${"a".repeat(24)}` }];
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "Content-Type": "application/json" },
});

type Options = { models?: any[]; codex?: any; codexModels?: Array<{ id: string; label: string }>;
  discoveryStatus?: number; discoveryError?: string; conflictOnce?: boolean; discoveredPath?: string | null;
  connectionState?: string };

function setup(options: Options = {}) {
  let revision = "rev-1";
  let models = structuredClone(options.models ?? [initialModel]);
  let codex = structuredClone(options.codex ?? initialCodex);
  let conflict = options.conflictOnce ?? false;
  let path = options.discoveredPath ?? null;
  let sourceModels = options.codexModels ?? [];
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === "/api/work/admin/models/discover") {
      if (options.discoveryStatus) return response({ error: options.discoveryError ?? "model_catalog_unavailable" }, options.discoveryStatus);
      const body = JSON.parse(init?.body as string);
      return response({ models: body.api_base.includes("second") ? secondCatalog : catalog });
    }
    if (url === "/api/work/admin/models") {
      if (init?.method === "PUT") {
        const body = JSON.parse(init.body as string);
        if (conflict || body.expected_revision !== revision) {
          conflict = false;
          return response({ error: "configuration_changed" }, 409);
        }
        revision = `rev-${Number(revision.slice(4)) + 1}`;
        const old = models.find((item: any) => item.id === body.model_id);
        const configuration = { ...initialConfiguration, ...(old?.configuration ?? {}), ...body.configuration };
        const model = { id: body.model_id, configuration, credentials: { configured: configuration.source === "mona" },
          availability: { ready: configuration.enabled && configuration.source === "mona" && configuration.billing_mode === "free",
            message: configuration.source === "codex" ? "Codex CLI 执行接入尚未完成。" : "当前状态。" } };
        models = [...models.filter((item: any) => item.id !== body.model_id), model];
      }
      return response({ revision, synchronized: true, models, billing: { mode: "shared_wallet", ready: false } });
    }
    if (url === "/api/work/admin/codex" || url === "/api/work/admin/codex/probe") {
      if (init?.method === "PUT") {
        const body = JSON.parse(init.body as string);
        if (body.expected_revision !== revision) return response({ error: "configuration_changed" }, 409);
        codex = { ...codex, ...body.configuration };
        revision = `rev-${Number(revision.slice(4)) + 1}`;
      }
      return response({ revision, configuration: codex,
        connection: { state: options.connectionState ?? "not_checked", message: "尚未检测。", models: sourceModels },
        billing: { mode: codex.billing_mode, ready: false, message: "余额计费尚未接通。" },
        execution: { ready: false, message: "Codex CLI 执行接入尚未完成，暂不可调用。" },
        public_enabled: false, login_commands: ["codex login"],
        discovery: path ? { state: "found", path } : { state: "not_found", path: null } });
    }
    throw new Error(`Unexpected request ${url}`);
  });
  return { models: () => models, codex: () => codex, setModels: (value: any[]) => { models = value; },
    setRevision: (value: string) => { revision = value; }, setDiscoveredPath: (value: string | null) => { path = value; },
    setCodexModels: (value: Array<{ id: string; label: string }>) => { sourceModels = value; } };
}

async function card(name: string) {
  return await screen.findByRole("group", { name: `模型 ${name}` }, { timeout: 4000 });
}
function enterPrice(container: HTMLElement, input = "1.25", cached = "0", output = "2.75") {
  fireEvent.change(within(container).getByLabelText("输入价格"), { target: { value: input } });
  fireEvent.change(within(container).getByLabelText("缓存输入价格"), { target: { value: cached } });
  fireEvent.change(within(container).getByLabelText("输出价格"), { target: { value: output } });
}
async function selectOption(container: HTMLElement, label: string, option: string) {
  const trigger = within(container).getByRole("button", { name: label });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  fireEvent.click(trigger);
  fireEvent.click(await screen.findByRole("menuitem", { name: option }));
}
function puts(url = "/api/work/admin/models") {
  return vi.mocked(fetch).mock.calls.filter(([path, init]) => String(path) === url && init?.method === "PUT");
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  vi.stubGlobal("crypto", webcrypto);
  setup();
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function openSettings(name: string) {
  fireEvent.click(within(await card(name)).getByRole("button", { name: "设置 " + name }));
  return await screen.findByRole("dialog", { name: "设置 " + name });
}

describe("automatically discovered work models", () => {
  it("shows a compact list with one switch and settings action per model", async () => {
    render(<ModelSettingsPanel token="work-admin-token" />);
    await card("Qwen3.7 Plus");
    for (const model of ["kimi-k2.5", "qwen3.5-plus", "glm-5", "MiniMax-M2.5", "qwen3.6-plus"]) await card(model);
    const qwen = await card("Qwen3.7 Plus");
    expect(screen.getByText("已获取 6 个模型。")).toBeInTheDocument();
    expect(screen.getByText("模型权限以实际调用为准。")).toBeInTheDocument();
    expect(within(qwen).getByRole("switch", { name: "开放 Qwen3.7 Plus" })).toHaveAttribute("aria-checked", "true");
    expect(within(qwen).getByRole("button", { name: "设置 Qwen3.7 Plus" })).toBeInTheDocument();
    expect(within(qwen).queryByText("qwen3.7-plus")).not.toBeInTheDocument();
    expect(within(qwen).queryByLabelText("输入价格")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("推理强度（可选）")).not.toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).startsWith("/admin/credits/model-prices"))).toBe(false);
  });

  it("cancels settings without writing and saves a legacy model price under its original ID", async () => {
    render(<ModelSettingsPanel token="work-admin-token" />);
    let dialog = await openSettings("Qwen3.7 Plus");
    enterPrice(dialog, "9", "0", "10");
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(puts()).toHaveLength(0);
    dialog = await openSettings("Qwen3.7 Plus");
    expect(within(dialog).getByLabelText("输入价格")).toHaveValue("");
    enterPrice(dialog);
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    await screen.findByText("Qwen3.7 Plus 已保存。");
    const body = JSON.parse(puts()[0][1]!.body as string);
    expect(body.model_id).toBe("qwen");
    expect(body.configuration.price).toEqual(price);
    expect(body.configuration).not.toHaveProperty("reasoning_effort");
    expect(body.configuration).not.toHaveProperty("billing_model");
  });

  it("requires a new model price before opening and cancels without a write", async () => {
    render(<ModelSettingsPanel token="work-admin-token" />);
    const kimi = await card("kimi-k2.5");
    fireEvent.click(within(kimi).getByRole("switch", { name: "开放 kimi-k2.5" }));
    let dialog = await screen.findByRole("dialog", { name: "设置 kimi-k2.5" });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    expect(within(dialog).getAllByText("请填写三项价格，或关闭模型。")).toHaveLength(3);
    expect(puts()).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(within(kimi).getByRole("switch", { name: "开放 kimi-k2.5" })).toHaveAttribute("aria-checked", "false");
    expect(puts()).toHaveLength(0);
    fireEvent.click(within(kimi).getByRole("switch", { name: "开放 kimi-k2.5" }));
    dialog = await screen.findByRole("dialog", { name: "设置 kimi-k2.5" });
    enterPrice(dialog, "0", "0", "0");
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    await screen.findByText("kimi-k2.5 已保存。");
    expect(JSON.parse(puts()[0][1]!.body as string).configuration).toMatchObject({ enabled: true,
      price: { input_amount_per_million: "0", cached_input_amount_per_million: "0", output_amount_per_million: "0" } });
    expect(within(await card("kimi-k2.5")).getByRole("switch", { name: "开放 kimi-k2.5" })).toHaveAttribute("aria-checked", "true");
  });

  it("opens settings before enabling a previously configured model without a price", async () => {
    setup({ models: [{ ...initialModel, configuration: { ...initialConfiguration, enabled: false } }] });
    render(<ModelSettingsPanel token="work-admin-token" />);
    await screen.findByText("已获取 6 个模型。");
    const qwen = await card("Qwen3.7 Plus");
    fireEvent.click(within(qwen).getByRole("switch", { name: "开放 Qwen3.7 Plus" }));
    const dialog = await screen.findByRole("dialog", { name: "设置 Qwen3.7 Plus" });
    expect(puts()).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(within(qwen).getByRole("switch", { name: "开放 Qwen3.7 Plus" })).toHaveAttribute("aria-checked", "false");
    expect(puts()).toHaveLength(0);
  });

  it("closes the old unpriced Qwen immediately even if the supplier catalog fails", async () => {
    setup({ discoveryStatus: 404 });
    render(<ModelSettingsPanel token="work-admin-token" />);
    await screen.findByText("供应商未提供可读取的完整模型列表，请检查接口支持情况后重试。", {}, { timeout: 4000 });
    const qwen = await card("Qwen3.7 Plus");
    fireEvent.click(within(qwen).getByRole("switch", { name: "开放 Qwen3.7 Plus" }));
    await screen.findByText("Qwen3.7 Plus 已保存。");
    expect(JSON.parse(puts()[0][1]!.body as string).configuration).toMatchObject({ enabled: false, api_base: firstBase });
    expect(JSON.parse(puts()[0][1]!.body as string).configuration).not.toHaveProperty("price");
    expect(within(await card("Qwen3.7 Plus")).getByRole("switch", { name: "开放 Qwen3.7 Plus" })).toHaveAttribute("aria-checked", "false");
  });

  it("opens a priced disabled model immediately and rolls the switch back on failure", async () => {
    const model = { ...initialModel, configuration: { ...initialConfiguration, enabled: false, price } };
    setup({ models: [model] });
    render(<ModelSettingsPanel token="work-admin-token" />);
    await screen.findByText("已获取 6 个模型。");
    let qwen = await card("Qwen3.7 Plus");
    fireEvent.click(within(qwen).getByRole("switch", { name: "开放 Qwen3.7 Plus" }));
    await screen.findByText("Qwen3.7 Plus 已保存。");
    expect(within(await card("Qwen3.7 Plus")).getByRole("switch", { name: "开放 Qwen3.7 Plus" })).toHaveAttribute("aria-checked", "true");
    expect(JSON.parse(puts()[0][1]!.body as string).configuration).not.toHaveProperty("price");
    cleanup();
    vi.mocked(fetch).mockReset();
    setup({ conflictOnce: true, models: [model] });
    render(<ModelSettingsPanel token="work-admin-token" />);
    await screen.findByText("已获取 6 个模型。");
    qwen = await card("Qwen3.7 Plus");
    fireEvent.click(within(qwen).getByRole("switch", { name: "开放 Qwen3.7 Plus" }));
    await screen.findByText("配置已变化");
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(within(await card("Qwen3.7 Plus")).getByRole("switch", { name: "开放 Qwen3.7 Plus" })).toHaveAttribute("aria-checked", "false");
  });

  it("keeps a model draft across dialog dismissal and provider changes", async () => {
    render(<ModelSettingsPanel token="work-admin-token" />);
    let dialog = await openSettings("Qwen3.7 Plus");
    fireEvent.change(within(dialog).getByLabelText("输入价格"), { target: { value: "5" } });
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(within(await card("Qwen3.7 Plus")).getByText("未保存")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Codex CLI" }));
    fireEvent.click(screen.getByRole("button", { name: "自定义 API" }));
    dialog = await openSettings("Qwen3.7 Plus");
    expect(within(dialog).getByLabelText("输入价格")).toHaveValue("5");
    expect(puts()).toHaveLength(0);
  });

  it("preserves drafts when closing a model with an incomplete price", async () => {
    render(<ModelSettingsPanel token="work-admin-token" />);
    const dialog = await openSettings("Qwen3.7 Plus");
    fireEvent.change(within(dialog).getByLabelText("输入价格"), { target: { value: "5" } });
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    fireEvent.click(within(await card("Qwen3.7 Plus")).getByRole("switch", { name: "开放 Qwen3.7 Plus" }));
    await screen.findByText("Qwen3.7 Plus 已保存。");
    expect(JSON.parse(puts()[0][1]!.body as string).configuration).not.toHaveProperty("price");
    const reopened = await openSettings("Qwen3.7 Plus");
    expect(within(reopened).getByLabelText("输入价格")).toHaveValue("5");
  });

  it("keeps a conflicting price draft and refuses to overwrite the updated model", async () => {
    const originalPrice = { input_amount_per_million: "1", cached_input_amount_per_million: "0", output_amount_per_million: "2" };
    const controls = setup({ conflictOnce: true, models: [{ ...initialModel, configuration: { ...initialConfiguration, price: originalPrice } }] });
    render(<ModelSettingsPanel token="work-admin-token" />);
    let dialog = await openSettings("Qwen3.7 Plus");
    fireEvent.change(within(dialog).getByLabelText("输入价格"), { target: { value: "5" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    await screen.findByText("配置已变化");
    controls.setRevision("rev-2");
    controls.setModels([{ ...initialModel, configuration: { ...initialConfiguration,
      price: { ...originalPrice, input_amount_per_million: "7" } } }]);
    fireEvent.click(screen.getByRole("button", { name: "刷新配置状态" }));
    dialog = await screen.findByRole("dialog", { name: "设置 Qwen3.7 Plus" });
    expect(within(dialog).getByLabelText("输入价格")).toHaveValue("5");
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "保存" })).toBeEnabled());
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    await screen.findByText("配置已变化");
    expect(puts()).toHaveLength(1);
  });

  it("keeps prices separate across different models", async () => {
    const glm = { ...initialModel, id: "glm-id", configuration: { ...initialConfiguration, label: "GLM", model: "glm-5",
      price: { input_amount_per_million: "3", cached_input_amount_per_million: "0", output_amount_per_million: "4" } } };
    const controls = setup({ models: [{ ...initialModel, configuration: { ...initialConfiguration, price } }, glm] });
    render(<ModelSettingsPanel token="work-admin-token" />);
    let dialog = await openSettings("Qwen3.7 Plus");
    fireEvent.change(within(dialog).getByLabelText("输入价格"), { target: { value: "8" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    await screen.findByText("Qwen3.7 Plus 已保存。");
    dialog = await openSettings("GLM");
    expect(within(dialog).getByLabelText("输入价格")).toHaveValue("3");
    expect(controls.models().find((item: any) => item.id === "qwen").configuration.price.input_amount_per_million).toBe("8");
  });

  it.each([
    [422, "model_credentials_unavailable", "模型凭据尚未载入或无法读取列表，请检查服务器凭据后重试。"],
    [400, "invalid_model_endpoint", "模型地址无效或不允许访问，请检查 API Base URL。"],
    [503, "model_catalog_unavailable", "供应商未提供可读取的完整模型列表，请检查接口支持情况后重试。"],
  ])("explains a catalog failure %s", async (status, code, message) => {
    setup({ discoveryStatus: status, discoveryError: code });
    render(<ModelSettingsPanel token="work-admin-token" />);
    expect(await screen.findByText(message, {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("uses the existing login dialog when administrator authorization is lost", async () => {
    setup({ discoveryStatus: 403 });
    render(<ModelSettingsPanel token="work-admin-token" />);
    expect(within(await screen.findByRole("dialog", {}, { timeout: 4000 })).getByText("没有管理权限")).toBeInTheDocument();
  });

  it("shows compact Codex rows and does not claim unavailable models can run", async () => {
    const existing = { ...initialModel, id: "codex-existing", configuration: { ...initialConfiguration, source: "codex",
      label: "Codex Existing", model: "gpt-5-codex", api_base: "", api_key_env: "", enabled: true, price },
      credentials: { configured: false }, availability: { ready: false, message: "内部执行说明" } };
    setup({ models: [initialModel, existing], codexModels: [{ id: "gpt-5-codex", label: "GPT-5 Codex" },
      { id: "gpt-5-mini", label: "GPT-5 Mini" }] });
    render(<ModelSettingsPanel token="work-admin-token" />);
    await card("Qwen3.7 Plus");
    fireEvent.click(screen.getByRole("button", { name: "Codex CLI" }));
    expect(within(await card("Codex Existing")).getByText("暂不可用")).toBeInTheDocument();
    expect(within(await card("GPT-5 Mini")).queryByText("暂不可用")).not.toBeInTheDocument();
    const dialog = await openSettings("Codex Existing");
    expect(within(dialog).getByLabelText("输入价格")).toHaveValue("1.25");
    expect(screen.queryByText("内部执行说明")).not.toBeInTheDocument();
  });

  it("detects and saves an unconfigured Codex path without displaying it", async () => {
    const controls = setup({ codex: { ...initialCodex, cli_path: "" }, discoveredPath: "/opt/codex-a" });
    render(<ModelSettingsPanel token="work-admin-token" />);
    await card("Qwen3.7 Plus");
    fireEvent.click(screen.getByRole("button", { name: "Codex CLI" }));
    const save = screen.getByRole("button", { name: "保存连接" });
    await waitFor(() => expect(save).toBeEnabled());
    expect(screen.queryByLabelText("CLI 程序路径")).not.toBeInTheDocument();
    expect(screen.queryByText("/opt/codex-a")).not.toBeInTheDocument();
    expect(screen.queryByText("Ubuntu 登录说明")).not.toBeInTheDocument();
    expect(screen.queryByText(/执行接入尚未完成/)).not.toBeInTheDocument();
    fireEvent.click(save);
    await screen.findByText("Codex 连接配置已保存。");
    expect(controls.codex().cli_path).toBe("/opt/codex-a");
    fireEvent.click(screen.getByRole("button", { name: "检测连接" }));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === "/api/work/admin/codex/probe")).toHaveLength(1));
    expect(screen.queryByText("检测已完成，请查看连接状态和模型列表。")).not.toBeInTheDocument();
  });

  it("shows an actionable message when Codex is not found", async () => {
    setup({ codex: { ...initialCodex, cli_path: "" }, discoveredPath: null });
    render(<ModelSettingsPanel token="work-admin-token" />);
    await card("Qwen3.7 Plus");
    fireEvent.click(screen.getByRole("button", { name: "Codex CLI" }));
    expect(await screen.findByText("未检测到 Codex，请先在 Ubuntu 安装。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存连接" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "检测连接" })).toBeDisabled();
  });

  it("requires an explicit action to replace an unavailable saved Codex installation", async () => {
    const controls = setup({ codex: { ...initialCodex, cli_path: "/opt/old-codex" }, discoveredPath: "/opt/new-codex",
      connectionState: "unavailable" });
    render(<ModelSettingsPanel token="work-admin-token" />);
    await card("Qwen3.7 Plus");
    fireEvent.click(screen.getByRole("button", { name: "Codex CLI" }));
    const replace = await screen.findByRole("button", { name: "使用新安装的 Codex" });
    expect(controls.codex().cli_path).toBe("/opt/old-codex");
    expect(screen.queryByText("/opt/old-codex")).not.toBeInTheDocument();
    expect(screen.queryByText("/opt/new-codex")).not.toBeInTheDocument();
    fireEvent.click(replace);
    fireEvent.click(screen.getByRole("button", { name: "保存连接" }));
    await screen.findByText("Codex 连接配置已保存。");
    expect(controls.codex().cli_path).toBe("/opt/new-codex");
  });

  it("does not suggest replacing a working saved Codex installation", async () => {
    setup({ codex: { ...initialCodex, cli_path: "/opt/working-codex" }, discoveredPath: "/opt/other-codex",
      connectionState: "ready" });
    render(<ModelSettingsPanel token="work-admin-token" />);
    await card("Qwen3.7 Plus");
    fireEvent.click(screen.getByRole("button", { name: "Codex CLI" }));
    expect(screen.queryByRole("button", { name: "使用新安装的 Codex" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存连接" })).toBeDisabled();
  });

  it("accepts only bounded exact decimal prices", () => {
    for (const value of ["0", "0.000001", "1", "1000000000", "1000000000.000000"]) expect(isValidPriceAmount(value)).toBe(true);
    for (const value of ["", "01", "-1", "+1", "1e3", "1.0000001", "1000000000.000001", "1000000001"]) {
      expect(isValidPriceAmount(value)).toBe(false);
    }
  });

  it("accepts the backend catalog limit of 2048 models", async () => {
    const many = Array.from({ length: 2048 }, (_, index) => ({ id: "model-" + index, label: "model-" + index,
      suggested_id: "api-" + index.toString(16).padStart(24, "0") }));
    vi.mocked(fetch).mockResolvedValue(response({ models: many }));
    expect(await requestModelDiscovery("admin", "https://model.example/v1", keyName)).toHaveLength(2048);
    vi.mocked(fetch).mockResolvedValue(response({ models: [...many, { id: "more", label: "more", suggested_id: "api-" + "f".repeat(24) }] }));
    await expect(requestModelDiscovery("admin", "https://model.example/v1", keyName)).rejects.toMatchObject({ code: "invalid_response" });
  });
});
