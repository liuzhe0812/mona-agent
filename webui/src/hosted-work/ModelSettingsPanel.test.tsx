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
  discoveryStatus?: number; discoveryError?: string; conflictOnce?: boolean; discoveredPath?: string | null };

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
        connection: { state: "not_checked", message: "尚未检测。", models: sourceModels },
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

describe("automatically discovered work models", () => {
  it("loads the supplier catalog automatically and associates the old Qwen platform ID", async () => {
    render(<ModelSettingsPanel token="work-admin-token" />);
    await card("Qwen3.7 Plus");
    for (const model of ["kimi-k2.5", "qwen3.5-plus", "glm-5", "MiniMax-M2.5", "qwen3.6-plus"]) await card(model);
    expect(screen.getByText("已获取 6 个模型。")).toBeInTheDocument();
    expect(screen.getByText(/供应商返回列表，实际调用权限未验证/)).toBeInTheDocument();
    expect(screen.queryByLabelText("推理强度（可选）")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("模型 ID")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("平台模型标识")).not.toBeInTheDocument();
    expect(within(await card("Qwen3.7 Plus")).getByRole("checkbox", { name: "开放 Qwen3.7 Plus" })).toBeChecked();
    const discovery = vi.mocked(fetch).mock.calls.find(([url]) => String(url) === "/api/work/admin/models/discover")!;
    expect(JSON.parse(discovery[1]!.body as string)).toEqual({ api_base: "https://model.example/v1", api_key_env: keyName });
    expect(discovery[1]!.headers).toMatchObject({ Authorization: "Bearer work-admin-token" });
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).startsWith("/admin/credits/model-prices"))).toBe(false);
  });

  it("keeps multiple model drafts without a PUT and saves only the chosen row", async () => {
    render(<ModelSettingsPanel token="work-admin-token" />);
    let kimi = await card("kimi-k2.5");
    let glm = await card("glm-5");
    fireEvent.click(within(kimi).getByRole("checkbox", { name: "开放 kimi-k2.5" }));
    enterPrice(kimi, "1", "0", "2");
    fireEvent.click(within(glm).getByRole("checkbox", { name: "开放 glm-5" }));
    enterPrice(glm, "3", "0.2", "4");
    expect(puts()).toHaveLength(0);
    expect(within(kimi).getByText(/未保存/)).toBeInTheDocument();
    expect(within(glm).getByText(/未保存/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Codex CLI" }));
    fireEvent.click(screen.getByRole("button", { name: "自定义 API" }));
    kimi = await card("kimi-k2.5");
    glm = await card("glm-5");
    expect(within(kimi).getByLabelText("输入价格")).toHaveValue("1");
    expect(within(glm).getByLabelText("输入价格")).toHaveValue("3");
    expect(puts()).toHaveLength(0);
    fireEvent.click(within(glm).getByRole("button", { name: "保存 glm-5" }));
    await screen.findByText("glm-5 已保存。");
    expect(puts()).toHaveLength(1);
    const body = JSON.parse(puts()[0][1]!.body as string);
    expect(body.model_id).toBe(`api-${"3".repeat(24)}`);
    expect(body.configuration).toMatchObject({ source: "mona", model: "glm-5", enabled: true, billing_mode: "wallet",
      price: { input_amount_per_million: "3", cached_input_amount_per_million: "0.2", output_amount_per_million: "4" } });
    expect(body.configuration).not.toHaveProperty("reasoning_effort");
    expect(body.configuration).not.toHaveProperty("billing_model");
    expect(within(await card("kimi-k2.5")).getByLabelText("输入价格")).toHaveValue("1");
    expect(within(await card("kimi-k2.5")).getByText(/未保存/)).toBeInTheDocument();
  });

  it("updates the legacy Qwen price using its existing ID and preserves hidden settings", async () => {
    render(<ModelSettingsPanel token="work-admin-token" />);
    const qwen = await card("Qwen3.7 Plus");
    enterPrice(qwen);
    fireEvent.click(within(qwen).getByRole("button", { name: "保存 Qwen3.7 Plus" }));
    await screen.findByText("Qwen3.7 Plus 已保存。");
    const body = JSON.parse(puts()[0][1]!.body as string);
    expect(body.model_id).toBe("qwen");
    expect(body.configuration.price).toEqual(price);
    expect(body.configuration).not.toHaveProperty("reasoning_effort");
    expect(body.configuration).not.toHaveProperty("billing_model");
  });

  it("preserves an edited display name across provider switches and saves it on the original model", async () => {
    render(<ModelSettingsPanel token="work-admin-token" />);
    let qwen = await card("Qwen3.7 Plus");
    fireEvent.change(within(qwen).getByLabelText("显示名称"), { target: { value: "我的 Qwen" } });
    fireEvent.click(screen.getByRole("button", { name: "Codex CLI" }));
    fireEvent.click(screen.getByRole("button", { name: "自定义 API" }));
    qwen = await card("Qwen3.7 Plus");
    expect(within(qwen).getByLabelText("显示名称")).toHaveValue("我的 Qwen");
    fireEvent.click(within(qwen).getByRole("button", { name: "保存 Qwen3.7 Plus" }));
    await screen.findByText("Qwen3.7 Plus 已保存。");
    expect((await card("我的 Qwen"))).toBeInTheDocument();
    const body = JSON.parse(puts()[0][1]!.body as string);
    expect(body.model_id).toBe("qwen");
    expect(body.configuration.label).toBe("我的 Qwen");
    expect(body.configuration).not.toHaveProperty("price");
  });

  it("requires an explicit complete price before opening a new model", async () => {
    render(<ModelSettingsPanel token="work-admin-token" />);
    const kimi = await card("kimi-k2.5");
    fireEvent.click(within(kimi).getByRole("checkbox", { name: "开放 kimi-k2.5" }));
    fireEvent.click(within(kimi).getByRole("button", { name: "保存 kimi-k2.5" }));
    expect(within(kimi).getAllByText("请填写三项价格，或关闭模型。")).toHaveLength(3);
    expect(puts()).toHaveLength(0);
    enterPrice(kimi, "0", "0", "0");
    fireEvent.click(within(kimi).getByRole("button", { name: "保存 kimi-k2.5" }));
    await screen.findByText("kimi-k2.5 已保存。");
    expect(JSON.parse(puts()[0][1]!.body as string).configuration.price.input_amount_per_million).toBe("0");
  });

  it("keeps a configured model visible and closable when its directory cannot be read", async () => {
    setup({ discoveryStatus: 404 });
    render(<ModelSettingsPanel token="work-admin-token" />);
    await screen.findByText("供应商未提供可读取的完整模型列表，请检查接口支持情况后重试。", {}, { timeout: 4000 });
    expect(screen.getByText("已配置但当前目录未返回")).toBeInTheDocument();
    expect(screen.queryByText("glm-5")).not.toBeInTheDocument();
    const qwen = await card("Qwen3.7 Plus");
    fireEvent.click(within(qwen).getByRole("checkbox", { name: "开放 Qwen3.7 Plus" }));
    fireEvent.click(within(qwen).getByRole("button", { name: "保存 Qwen3.7 Plus" }));
    await screen.findByText("Qwen3.7 Plus 已保存。");
    const body = JSON.parse(puts()[0][1]!.body as string);
    expect(body.configuration.enabled).toBe(false);
    expect(body.configuration).not.toHaveProperty("price");
    expect(body.configuration.api_base).toBe(firstBase);
  });

  it("can close a model without discarding an incomplete price draft", async () => {
    render(<ModelSettingsPanel token="work-admin-token" />);
    const qwen = await card("Qwen3.7 Plus");
    fireEvent.change(within(qwen).getByLabelText("输入价格"), { target: { value: "5" } });
    fireEvent.click(within(qwen).getByRole("checkbox", { name: "开放 Qwen3.7 Plus" }));
    fireEvent.click(within(qwen).getByRole("button", { name: "保存 Qwen3.7 Plus" }));
    await screen.findByText("Qwen3.7 Plus 已保存。价格草稿尚未保存。");
    expect(JSON.parse(puts()[0][1]!.body as string).configuration).not.toHaveProperty("price");
    expect(within(await card("Qwen3.7 Plus")).getByLabelText("输入价格")).toHaveValue("5");
    expect(within(await card("Qwen3.7 Plus")).getByText(/未保存/)).toBeInTheDocument();
  });

  it.each([
    [422, "model_credentials_unavailable", "模型凭据尚未载入或无法读取列表，请检查服务器凭据后重试。"],
    [400, "invalid_model_endpoint", "模型地址无效或不允许访问，请检查 API Base URL。"],
    [503, "model_catalog_unavailable", "供应商未提供可读取的完整模型列表，请检查接口支持情况后重试。"],
  ])("explains a catalog failure %s without exposing raw upstream errors", async (status, code, message) => {
    setup({ discoveryStatus: status, discoveryError: code });
    render(<ModelSettingsPanel token="work-admin-token" />);
    expect(await screen.findByText(message, {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("uses the existing login dialog when model discovery loses admin authorization", async () => {
    setup({ discoveryStatus: 403 });
    render(<ModelSettingsPanel token="work-admin-token" />);
    expect(within(await screen.findByRole("dialog", {}, { timeout: 4000 })).getByText("没有管理权限")).toBeInTheDocument();
    expect(screen.queryByText(/供应商未提供可读取的完整模型列表/)).not.toBeInTheDocument();
  });

  it("preserves an edited price across a revision conflict without overwriting a changed value", async () => {
    const originalPrice = { input_amount_per_million: "1", cached_input_amount_per_million: "0", output_amount_per_million: "2" };
    const controls = setup({ conflictOnce: true, models: [{ ...initialModel, configuration: { ...initialConfiguration, price: originalPrice } }] });
    render(<ModelSettingsPanel token="work-admin-token" />);
    let qwen = await card("Qwen3.7 Plus");
    fireEvent.change(within(qwen).getByLabelText("输入价格"), { target: { value: "5" } });
    fireEvent.click(within(qwen).getByRole("button", { name: "保存 Qwen3.7 Plus" }));
    await screen.findByText("配置已变化");
    controls.setRevision("rev-2");
    controls.setModels([{ ...initialModel, configuration: { ...initialConfiguration,
      price: { ...originalPrice, input_amount_per_million: "7" } } }]);
    fireEvent.click(screen.getByRole("button", { name: "刷新配置状态" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    qwen = await card("Qwen3.7 Plus");
    expect(within(qwen).getByLabelText("输入价格")).toHaveValue("5");
    await waitFor(() => expect(within(qwen).getByRole("button", { name: "保存 Qwen3.7 Plus" })).toBeEnabled());
    fireEvent.click(within(qwen).getByRole("button", { name: "保存 Qwen3.7 Plus" }));
    await screen.findByText("配置已变化");
    expect(puts()).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    fireEvent.click(within(qwen).getByRole("button", { name: "放弃此模型草稿" }));
    expect(within(qwen).getByLabelText("输入价格")).toHaveValue("7");
  });

  it("keeps models with the same supplier ID separate across different connections", async () => {
    const controls = setup({ models: [{ ...initialModel, configuration: { ...initialConfiguration, price } }] });
    render(<ModelSettingsPanel token="work-admin-token" />);
    let qwen = await card("Qwen3.7 Plus");
    expect(within(qwen).getByLabelText("输入价格")).toHaveValue("1.25");
    fireEvent.change(screen.getByLabelText("API Base URL"), { target: { value: "https://second.example/v1" } });
    const second = await card("qwen3.7-plus");
    fireEvent.click(within(second).getByRole("checkbox", { name: "开放 qwen3.7-plus" }));
    enterPrice(second, "9", "1", "11");
    fireEvent.click(within(second).getByRole("button", { name: "保存 qwen3.7-plus" }));
    await screen.findByText("qwen3.7-plus 已保存。");
    expect(controls.models().find((item: any) => item.id === "qwen").configuration.price).toEqual(price);
    fireEvent.change(screen.getByLabelText("API Base URL"), { target: { value: firstBase } });
    qwen = await card("Qwen3.7 Plus");
    expect(within(qwen).getByLabelText("输入价格")).toHaveValue("1.25");
  });

  it("retains an unsaved draft when switching supplier connections", async () => {
    render(<ModelSettingsPanel token="work-admin-token" />);
    let kimi = await card("kimi-k2.5");
    fireEvent.click(within(kimi).getByRole("checkbox", { name: "开放 kimi-k2.5" }));
    enterPrice(kimi, "8", "0", "9");
    fireEvent.change(screen.getByLabelText("API Base URL"), { target: { value: "https://second.example/v1" } });
    await card("qwen3.7-plus");
    fireEvent.change(screen.getByLabelText("API Base URL"), { target: { value: firstBase } });
    kimi = await card("kimi-k2.5");
    expect(within(kimi).getByLabelText("输入价格")).toHaveValue("8");
    expect(within(kimi).getByText(/未保存/)).toBeInTheDocument();
    expect(puts()).toHaveLength(0);
  });

  it("ignores a superseded supplier discovery response", async () => {
    let finishFirst: ((value: Response) => void) | undefined;
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (String(url) === "/api/work/admin/models/discover" && JSON.parse(init?.body as string).api_base.includes("model.example")) {
        return await new Promise<Response>(resolve => { finishFirst = resolve; });
      }
      return await original(url, init);
    });
    render(<ModelSettingsPanel token="work-admin-token" />);
    await waitFor(() => expect(finishFirst).toBeTypeOf("function"), { timeout: 4000 });
    fireEvent.change(screen.getByLabelText("API Base URL"), { target: { value: "https://second.example/v1" } });
    await card("qwen3.7-plus");
    await act(async () => { finishFirst!(response({ models: catalog })); });
    expect(screen.queryByRole("group", { name: "模型 kimi-k2.5" })).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "模型 qwen3.7-plus" })).toBeInTheDocument();
  });

  it("shows no fabricated Codex models and never starts authentication on page load", async () => {
    render(<ModelSettingsPanel token="work-admin-token" />);
    await card("Qwen3.7 Plus");
    fireEvent.click(screen.getByRole("button", { name: "Codex CLI" }));
    expect(await screen.findByText("尚未取得 Codex 模型；请完成终端登录并检测连接。")).toBeInTheDocument();
    expect(screen.getByText("Codex CLI 执行接入尚未完成，暂不可调用。")).toBeInTheDocument();
    expect(screen.getByText("Ubuntu 登录说明")).toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === "/api/work/admin/codex/probe")).toHaveLength(0);
    expect(puts("/api/work/admin/codex")).toHaveLength(0);
  });

  it("lets the administrator price separate CLI models without altering the connection draft", async () => {
    const codex = { ...initialCodex, model: "gpt-5-codex", price };
    const controls = setup({ codex, codexModels: [{ id: "gpt-5-codex", label: "GPT-5 Codex" },
      { id: "gpt-5-mini", label: "GPT-5 Mini" }] });
    render(<ModelSettingsPanel token="work-admin-token" />);
    await card("Qwen3.7 Plus");
    fireEvent.click(screen.getByRole("button", { name: "Codex CLI" }));
    const first = await card("GPT-5 Codex");
    const second = await card("GPT-5 Mini");
    expect(screen.getByText("显示上次缓存，实际权限未验证。")).toBeInTheDocument();
    fireEvent.click(within(first).getByRole("checkbox", { name: "开放 GPT-5 Codex" }));
    expect(within(first).getByLabelText("输入价格")).toHaveValue("1.25");
    fireEvent.click(within(second).getByRole("checkbox", { name: "开放 GPT-5 Mini" }));
    enterPrice(second, "3", "0", "5");
    await selectOption(second, "计费方式 GPT-5 Mini", "免费");
    fireEvent.click(within(first).getByRole("button", { name: "保存 GPT-5 Codex" }));
    await screen.findByText("GPT-5 Codex 已保存。");
    const body = JSON.parse(puts()[0][1]!.body as string);
    const suffix = createHash("sha256").update("codex\0gpt-5-codex").digest("hex").slice(0, 24);
    expect(body.model_id).toBe(`codex-${suffix}`);
    expect(body.configuration).toMatchObject({ source: "codex", model: "gpt-5-codex", enabled: true, price });
    expect(body.configuration).not.toHaveProperty("reasoning_effort");
    expect(within(await card("GPT-5 Mini")).getByLabelText("输入价格")).toHaveValue("3");
    expect(within(await card("GPT-5 Mini")).getByText(/未保存/)).toBeInTheDocument();
    fireEvent.click(within(await card("GPT-5 Mini")).getByRole("button", { name: "保存 GPT-5 Mini" }));
    await screen.findByText("GPT-5 Mini 已保存。");
    expect(puts()).toHaveLength(2);
    expect(JSON.parse(puts()[1][1]!.body as string).configuration).toMatchObject({ source: "codex", model: "gpt-5-mini",
      enabled: true, billing_mode: "free", price: { input_amount_per_million: "3", cached_input_amount_per_million: "0", output_amount_per_million: "5" } });
    expect(controls.codex()).toEqual(codex);
    expect(puts("/api/work/admin/codex")).toHaveLength(0);
  });

  it("does not revive a cleared CLI model price or budget from the legacy connection draft", async () => {
    const codex = { ...initialCodex, model: "gpt-5-codex", price, context_window_tokens: 64000 };
    const existing = { id: "codex-existing", configuration: { ...initialConfiguration, source: "codex", label: "Codex Existing",
      model: "gpt-5-codex", api_base: "", api_key_env: "", enabled: false, price: null, context_window_tokens: null },
      credentials: { configured: false }, availability: { ready: false, message: "暂未开放。" } };
    setup({ codex, models: [initialModel, existing], codexModels: [{ id: "gpt-5-codex", label: "GPT-5 Codex" }] });
    render(<ModelSettingsPanel token="work-admin-token" />);
    await card("Qwen3.7 Plus");
    fireEvent.click(screen.getByRole("button", { name: "Codex CLI" }));
    const existingCard = await card("Codex Existing");
    expect(within(existingCard).getByLabelText("输入价格")).toHaveValue("");
    expect(within(existingCard).getByLabelText("输入预算上限（可选）")).toHaveValue(null);
    fireEvent.change(within(existingCard).getByLabelText("显示名称"), { target: { value: "新名称" } });
    fireEvent.click(within(existingCard).getByRole("button", { name: "保存 Codex Existing" }));
    await screen.findByText("Codex Existing 已保存。");
    const body = JSON.parse(puts()[0][1]!.body as string);
    expect(body.configuration).not.toHaveProperty("price");
    expect(body.configuration.context_window_tokens).toBeNull();
    expect(body.model_id).toBe("codex-existing");
  });

  it("prefills a discovered CLI path but never overwrites a manually edited one", async () => {
    const controls = setup({ codex: { ...initialCodex, cli_path: "" }, discoveredPath: "/opt/codex-a" });
    render(<ModelSettingsPanel token="work-admin-token" />);
    await card("Qwen3.7 Plus");
    fireEvent.click(screen.getByRole("button", { name: "Codex CLI" }));
    const path = screen.getByLabelText("CLI 程序路径");
    await waitFor(() => expect(path).toHaveValue("/opt/codex-a"));
    fireEvent.change(path, { target: { value: "/opt/manual-codex" } });
    controls.setDiscoveredPath("/opt/codex-b");
    fireEvent.click(screen.getByRole("button", { name: "刷新配置" }));
    await screen.findByText("已检测到 Codex CLI：/opt/codex-b");
    expect(path).toHaveValue("/opt/manual-codex");
    expect(puts("/api/work/admin/codex")).toHaveLength(0);
  });

  it("accepts only bounded exact decimal prices", () => {
    for (const value of ["0", "0.000001", "1", "1000000000", "1000000000.000000"]) expect(isValidPriceAmount(value)).toBe(true);
    for (const value of ["", "01", "-1", "+1", "1e3", "1.0000001", "1000000000.000001", "1000000001"]) {
      expect(isValidPriceAmount(value)).toBe(false);
    }
  });

  it("accepts the backend catalog limit of 2048 models", async () => {
    const many = Array.from({ length: 2048 }, (_, index) => ({ id: `model-${index}`, label: `model-${index}`,
      suggested_id: `api-${index.toString(16).padStart(24, "0")}` }));
    vi.mocked(fetch).mockResolvedValue(response({ models: many }));
    expect(await requestModelDiscovery("admin", "https://model.example/v1", keyName)).toHaveLength(2048);
    vi.mocked(fetch).mockResolvedValue(response({ models: [...many, { id: "more", label: "more", suggested_id: `api-${"f".repeat(24)}` }] }));
    await expect(requestModelDiscovery("admin", "https://model.example/v1", keyName)).rejects.toMatchObject({ code: "invalid_response" });
  });
});
