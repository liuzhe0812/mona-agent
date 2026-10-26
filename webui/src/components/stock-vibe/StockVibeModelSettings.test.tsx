import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { developmentApi, type DevExecutor } from "@/lib/development-api";

const api = vi.hoisted(() => ({
  getOptions: vi.fn(),
  getRequest: vi.fn(),
  selectModel: vi.fn(),
}));

vi.mock("@/lib/stock-vibe-api", () => ({
  getStockVibeModelOptions: api.getOptions,
  getStockVibeRequest: api.getRequest,
  selectStockVibeModel: api.selectModel,
  StockVibeApiError: class StockVibeApiError extends Error {},
}));

import { StockVibeModelSettings } from "./StockVibeModelSettings";

const HASH = "a".repeat(64);
const providerExecutors = vi.spyOn(developmentApi, "providerExecutors");

function options(modelPreset: string | null, modelBinding?: unknown) {
  return {
    model_preset: modelPreset,
    ...(modelBinding !== undefined ? { model_binding: modelBinding } : {}),
    choices: [{
      preset: "default",
      label: "沿用 Mona API",
      model: "Mona API",
      protocol_supported: true,
      credentials_configured: true,
    }],
  };
}

function completedRequest(requestId: string, modelPreset: unknown, modelBinding?: unknown) {
  return {
    request_id: requestId,
    status: "completed",
    receipt_owner: "mona_settings",
    source: null,
    receipt: { status_code: 200, body: {
      model_preset: modelPreset,
      ...(modelBinding !== undefined ? { model_binding: modelBinding } : {}),
    } },
    receipt_sha256: HASH,
  };
}

function readyExecutor(id: "codex" | "claude" | "codebuddy", models: DevExecutor["models"]): DevExecutor {
  return {
    id,
    name: id === "codebuddy" ? "CodeBuddy" : id === "claude" ? "Claude" : "Codex",
    available: true,
    enabled: true,
    programAvailable: true,
    reason: "",
    probe: { state: "ready", reason: "", authentication: "ready", protocolVerified: true, modelCatalogState: "ready" },
    models,
  };
}

beforeEach(() => {
  localStorage.clear();
  for (const mock of Object.values(api)) mock.mockReset();
  api.getRequest.mockResolvedValue({ status: "unknown" });
  providerExecutors.mockReset().mockResolvedValue({ executors: [] });
});

describe("StockVibeModelSettings default selection", () => {
  it("shows a concise model name without changing the preset saved to configuration", async () => {
    const preset = "股票研究:百炼CodingPlan";
    api.getOptions.mockResolvedValue({ model_preset: null, choices: [{ preset, label: preset, model: "qwen3.7-plus", protocol_supported: true, credentials_configured: true }] });
    api.selectModel.mockImplementation(async (requestId: string, modelPreset: string) => completedRequest(requestId, modelPreset));
    render(<StockVibeModelSettings open onOpenChange={vi.fn()} onSaved={vi.fn()} />);

    const select = await screen.findByRole("button", { name: "选择模型" });
    expect(screen.queryByText(/凭据已配置|协议兼容|只保存已有/)).not.toBeInTheDocument();
    fireEvent.pointerDown(select, { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: /百炼CodingPlan · qwen3.7-plus/ }));
    const selected = await screen.findByRole("button", { name: "百炼CodingPlan · qwen3.7-plus" });
    await waitFor(() => expect(selected).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "保存模型选择" }));
    await waitFor(() => expect(api.selectModel).toHaveBeenCalledOnce());
    expect(api.selectModel.mock.calls[0][1]).toBe(preset);
    expect(api.selectModel.mock.calls[0]).toHaveLength(2);
  });

  it("keeps an unconfigured null distinct and explicitly saves the preselected default", async () => {
    api.getOptions.mockResolvedValue(options(null));
    api.selectModel.mockImplementation(async (requestId: string, modelPreset: string | null) =>
      completedRequest(requestId, modelPreset));
    const onSaved = vi.fn();

    render(<StockVibeModelSettings open onOpenChange={vi.fn()} onSaved={onSaved} />);

    const modelSelect = await screen.findByRole("button", { name: "默认 · Mona API" });
    const save = screen.getByRole("button", { name: "保存模型选择" });
    await waitFor(() => expect(save).toBeEnabled());
    expect(api.selectModel).not.toHaveBeenCalled();

    fireEvent.click(save);

    await waitFor(() => expect(api.selectModel).toHaveBeenCalledOnce());
    const [requestId, modelPreset] = api.selectModel.mock.calls[0] as [string, string | null];
    expect(requestId).toMatch(/^[a-f0-9]{32}$/);
    expect(modelPreset).toBe("default");
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  });

  it("does not mark an already-saved default as changed", async () => {
    api.getOptions.mockResolvedValue(options("default"));

    render(<StockVibeModelSettings open onOpenChange={vi.fn()} onSaved={vi.fn()} />);

    const modelSelect = await screen.findByRole("button", { name: "默认 · Mona API" });
    expect(screen.getByRole("button", { name: "保存模型选择" })).toBeDisabled();
    expect(api.selectModel).not.toHaveBeenCalled();
  });

  it("lists CodeBuddy account models, skips empty ids, and saves a native selection only on confirmation", async () => {
    const modelBinding = { executor: "codebuddy", model: "qwen3.7-plus", provider: null, effort: "medium" };
    api.getOptions.mockResolvedValue(options("default"));
    providerExecutors.mockResolvedValue({ executors: [readyExecutor("codebuddy", [
      { id: "qwen3.7-plus", label: "Qwen 3.7 Plus", reasoningEfforts: ["low", "medium"], reasoningEffort: "medium" },
      { id: "", label: "默认" },
    ])] });
    api.selectModel.mockImplementation(async (requestId: string, _modelPreset: null, _binding: unknown) =>
      completedRequest(requestId, null, { executor: "codebuddy", model: "qwen3.7-plus", effort: "medium" }));
    const onSaved = vi.fn();
    render(<StockVibeModelSettings open onOpenChange={vi.fn()} onSaved={onSaved} />);

    expect(providerExecutors).toHaveBeenCalledOnce();
    const trigger = await screen.findByRole("button", { name: "默认 · Mona API" });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    expect(await screen.findByRole("menuitem", { name: /CodeBuddy · Qwen 3\.7 Plus · qwen3\.7-plus/ })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /CodeBuddy · 默认/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: /CodeBuddy · Qwen 3\.7 Plus · qwen3\.7-plus/ }));
    expect(api.selectModel).not.toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: "Qwen 3.7 Plus · qwen3.7-plus" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "保存模型选择" }));

    await waitFor(() => expect(api.selectModel).toHaveBeenCalledOnce());
    expect(api.selectModel.mock.calls[0]).toHaveLength(3);
    expect(api.selectModel.mock.calls[0][1]).toBeNull();
    expect(api.selectModel.mock.calls[0][2]).toEqual(modelBinding);
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  });

  it("clears the saved native binding when switching back to Mona API", async () => {
    const native = { executor: "codex", model: "gpt-5-codex", provider: null, effort: null };
    api.getOptions.mockResolvedValue(options(null, native));
    providerExecutors.mockResolvedValue({ executors: [readyExecutor("codex", [
      { id: "gpt-5-codex", label: "GPT-5 Codex" },
    ])] });
    api.selectModel.mockImplementation(async (requestId: string, modelPreset: string | null) =>
      completedRequest(requestId, modelPreset, null));
    const onSaved = vi.fn();
    render(<StockVibeModelSettings open onOpenChange={vi.fn()} onSaved={onSaved} />);

    const trigger = await screen.findByRole("button", { name: "GPT-5 Codex · gpt-5-codex" });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: /默认 · Mona API/ }));
    await screen.findByRole("button", { name: "默认 · Mona API" });
    expect(api.selectModel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "保存模型选择" }));

    await waitFor(() => expect(api.selectModel).toHaveBeenCalledOnce());
    expect(api.selectModel.mock.calls[0]).toHaveLength(2);
    expect(api.selectModel.mock.calls[0][1]).toBe("default");
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  });

  it("does not claim a native selection was saved when the binding in its receipt differs", async () => {
    api.getOptions.mockResolvedValue(options("default"));
    providerExecutors.mockResolvedValue({ executors: [readyExecutor("codebuddy", [
      { id: "qwen3.7-plus", label: "Qwen 3.7 Plus" },
    ])] });
    api.selectModel.mockImplementation(async (requestId: string) => completedRequest(requestId, null, {
      executor: "codebuddy", model: "another-model", provider: null, effort: null,
    }));
    const onSaved = vi.fn();
    render(<StockVibeModelSettings open onOpenChange={vi.fn()} onSaved={onSaved} />);

    const trigger = await screen.findByRole("button", { name: "默认 · Mona API" });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: /CodeBuddy · Qwen 3\.7 Plus/ }));
    await screen.findByRole("button", { name: "Qwen 3.7 Plus · qwen3.7-plus" });
    fireEvent.click(screen.getByRole("button", { name: "保存模型选择" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/不会重复提交/);
    expect(onSaved).not.toHaveBeenCalled();
    expect(api.selectModel).toHaveBeenCalledOnce();
  });

  it("keeps API choices available when native model loading fails and opens engine settings", async () => {
    api.getOptions.mockResolvedValue(options("default"));
    providerExecutors.mockRejectedValue(new Error("offline"));
    const onOpenEngineSettings = vi.fn();
    render(<StockVibeModelSettings open onOpenChange={vi.fn()} onSaved={vi.fn()} onOpenEngineSettings={onOpenEngineSettings} />);

    const trigger = await screen.findByRole("button", { name: "默认 · Mona API" });
    expect(await screen.findByRole("status")).toHaveTextContent(/本机模型列表暂不可用/);
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    expect(await screen.findByRole("menuitem", { name: /Mona API · 默认 · Mona API/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "添加模型" }));
    expect(onOpenEngineSettings).toHaveBeenCalledOnce();
  });

  it("disables native models until their account is ready and keeps the settings route available", async () => {
    api.getOptions.mockResolvedValue(options("default"));
    providerExecutors.mockResolvedValue({ executors: [{
      ...readyExecutor("codebuddy", [{ id: "qwen3.7-plus", label: "Qwen 3.7 Plus" }]),
      probe: { state: "detected", reason: "", authentication: "required", protocolVerified: true },
    }] });
    const onOpenEngineSettings = vi.fn();
    render(<StockVibeModelSettings open onOpenChange={vi.fn()} onSaved={vi.fn()} onOpenEngineSettings={onOpenEngineSettings} />);

    const trigger = await screen.findByRole("button", { name: "默认 · Mona API" });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    const nativeChoice = await screen.findByRole("menuitem", { name: /CodeBuddy · Qwen 3\.7 Plus/ });
    expect(nativeChoice).toHaveAttribute("aria-disabled", "true");
    expect(nativeChoice).toHaveAttribute("aria-description", "请先连接此引擎账号。");
    fireEvent.click(screen.getByRole("button", { name: "添加模型" }));
    expect(onOpenEngineSettings).toHaveBeenCalledOnce();
    expect(api.selectModel).not.toHaveBeenCalled();
  });

  it("restores an older v1 pending API selection by querying its request id without resending", async () => {
    const requestId = "b".repeat(32);
    localStorage.setItem("mona.stock-vibe.model-selection.v1", JSON.stringify({
      requestId, modelPreset: "default", phase: "checking",
    }));
    api.getOptions.mockResolvedValue(options("default"));
    api.getRequest.mockResolvedValue({ request_id: requestId, status: "unknown" });
    render(<StockVibeModelSettings open onOpenChange={vi.fn()} onSaved={vi.fn()} />);

    await waitFor(() => expect(api.getRequest).toHaveBeenCalledWith(requestId));
    expect(api.selectModel).not.toHaveBeenCalled();
    expect(api.getRequest).toHaveBeenCalledOnce();
  });
});
