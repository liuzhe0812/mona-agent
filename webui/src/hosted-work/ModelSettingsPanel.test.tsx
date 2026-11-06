import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ModelSettingsPanel } from "./ModelSettingsPanel";

const configuration = { label: "供应商免费线路", source: "mona", api_base: "https://model.example/v1",
  api_key_env: "MONA_WORK_MODEL_CUSTOM", model: "actual-provider-model", context_window_tokens: null,
  max_output_tokens: 4096, reasoning_effort: null };
const snapshot = { revision: "rev-1", synchronized: true, models: [{ id: "custom", configuration,
  credentials: { configured: true } }], billing: { mode: "shared_wallet", ready: false,
  prices_endpoint: "/admin/credits/model-prices", admin_url: "/admin" } };
const price = (version: number, enabled = true, model = "paid-model") => ({ model, version, enabled,
  billing_type: "token", input_amount_per_million: String(version), cached_input_amount_per_million: "0.25",
  output_amount_per_million: "12.50" });
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "Content-Type": "application/json" },
});

function setup(save: (body: Record<string, unknown>) => Response = body => response({ ...snapshot, revision: "rev-2",
  models: [{ ...snapshot.models[0], configuration: body.configuration }] })) {
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    if (url === "/admin/credits/model-prices") return response({ prices: [price(1), price(3), price(9, false),
      price(8, true, "other-model"), { ...price(10), billing_type: "image" }] });
    if (init?.method === "PUT") return save(JSON.parse(init.body as string));
    return response(snapshot);
  });
}

beforeEach(() => {
  sessionStorage.clear();
  sessionStorage.setItem("admin_token", "price-admin-token");
  vi.stubGlobal("fetch", vi.fn());
  setup();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function panel(billingModel = "paid-model") {
  const onRevisionChange = vi.fn();
  return { onRevisionChange, ...render(<ModelSettingsPanel token="work-admin-token" revision="rev-1"
    billingModel={billingModel} onRevisionChange={onRevisionChange} />) };
}

describe("work model and shared pricing settings", () => {
  it("loads real configured labels and reads the latest enabled token price with the existing admin token", async () => {
    panel();
    await screen.findByDisplayValue("actual-provider-model");
    const prices = screen.getByRole("region", { name: "共用模型价格" });
    expect(await within(prices).findByText("paid-model · 价格版本 3")).toBeInTheDocument();
    expect(within(prices).getByText("¥3 / 百万 token")).toBeInTheDocument();
    expect(within(prices).getByText("¥0.25 / 百万 token")).toBeInTheDocument();
    expect(within(prices).getByText("¥12.50 / 百万 token")).toBeInTheDocument();
    expect(within(prices).queryByText(/价格版本 (9|10)/)).not.toBeInTheDocument();
    expect(within(prices).getByText(/修改价格会同时影响应用和网站/)).toBeInTheDocument();
    expect(within(prices).getByRole("link", { name: "打开模型服务 → 模型计价" })).toHaveAttribute("href", "/admin");
    expect(fetch).toHaveBeenCalledWith("/admin/credits/model-prices", expect.objectContaining({ method: "GET",
      headers: expect.objectContaining({ Authorization: "Bearer price-admin-token" }), credentials: "omit" }));
    expect(fetch).toHaveBeenCalledWith("/api/work/admin/models", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer work-admin-token" }) }));
    expect(screen.queryByText("Qwen3.7")).not.toBeInTheDocument();
  });

  it("saves only the free API schema and credential reference, then publishes the shared revision", async () => {
    const { onRevisionChange } = panel();
    await screen.findByDisplayValue("actual-provider-model");
    fireEvent.change(screen.getByLabelText("API 显示名称"), { target: { value: "新免费线路" } });
    fireEvent.click(screen.getByRole("button", { name: "保存免费 API 配置" }));
    await screen.findByText(/免费 API 配置已保存/);
    const request = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === "PUT")!;
    expect(JSON.parse(request[1]!.body as string)).toEqual({ expected_revision: "rev-1", model_id: "custom",
      configuration: { ...configuration, label: "新免费线路" } });
    expect(onRevisionChange).toHaveBeenLastCalledWith("rev-2");
    expect(document.querySelector('input[type="password"]')).toBeNull();
    expect(screen.getByText(/只填写变量名称/)).toBeInTheDocument();
  });

  it.each([
    [409, "work_busy", "工作台正在处理任务"],
    [409, "configuration_changed", "配置已变化"],
    [422, "credential_not_ready", "当前服务尚未加载此环境变量。请由运维在服务器受限配置中配置并加载后重试。"],
    [400, "invalid_endpoint", "请输入公网 HTTPS API 地址，不要包含账号、密码或密钥。"],
  ])("preserves a rejected draft and distinguishes %s %s", async (status, code, message) => {
    setup(() => response({ error: code }, status as number));
    panel();
    const label = await screen.findByLabelText("API 显示名称");
    await waitFor(() => expect(label).toHaveValue(configuration.label));
    fireEvent.change(label, { target: { value: "保留这份草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "保存免费 API 配置" }));
    expect(await screen.findByText(message as string)).toBeInTheDocument();
    expect(label).toHaveValue("保留这份草稿");
    if (code === "credential_not_ready" || code === "invalid_endpoint") {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(screen.getByLabelText(code === "invalid_endpoint" ? "API Base URL" : "API Key 环境变量名称")).toHaveAttribute("aria-invalid", "true");
    }
    if (code === "work_busy") expect(screen.queryByText("配置已变化")).not.toBeInTheDocument();
  });

  it("refreshes a changed revision without replacing the unsaved API draft", async () => {
    let conflict = true;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (url === "/admin/credits/model-prices") return response({ prices: [] });
      if (init?.method === "PUT") { conflict = false; return response({ error: "configuration_changed" }, 409); }
      return response({ ...snapshot, revision: conflict ? "rev-1" : "rev-3" });
    });
    const { onRevisionChange } = panel();
    const model = await screen.findByDisplayValue("actual-provider-model");
    fireEvent.change(model, { target: { value: "draft-provider-model" } });
    fireEvent.click(screen.getByRole("button", { name: "保存免费 API 配置" }));
    await screen.findByText("配置已变化");
    fireEvent.click(screen.getByRole("button", { name: "刷新配置状态" }));
    await waitFor(() => expect(onRevisionChange).toHaveBeenLastCalledWith("rev-3"));
    expect(model).toHaveValue("draft-provider-model");
  });

  it("supports an administrator website login when no separate admin token is stored", async () => {
    sessionStorage.removeItem("admin_token");
    panel();
    expect(await screen.findByText("paid-model · 价格版本 3")).toBeInTheDocument();
    await screen.findByDisplayValue("actual-provider-model");
    expect(fetch).toHaveBeenCalledWith("/admin/credits/model-prices", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer work-admin-token" }),
    }));
  });
});
