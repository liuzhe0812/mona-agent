import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { VideoModelSelector } from "./VideoModelSelector";
import * as api from "@/lib/api";
import { developmentApi, type DevExecutor } from "@/lib/development-api";
import { nativeProvidersChanged, useNativeProviderState } from "@/lib/native-provider-state";
import type { AgentModelBinding, SettingsPayload } from "@/lib/types";
import { useModelPreferences } from "@/components/models/model-sources";
import { ClientProvider } from "@/providers/ClientProvider";
import type { MonaClient } from "@/lib/mona-client";

const settings = {
  agent: { provider: "mona_managed", model: "mona-model", executor: "mona" },
  chat_providers: [{
    name: "third-party-api-id",
    label: "第三方 API",
    configured: true,
    models: [{
      id: "api-chat",
      name: "API Chat",
      enabled: true,
      type: "chat",
      reasoning_efforts: ["low", "high"],
      default_reasoning_effort: "low",
    }],
  }],
} as unknown as SettingsPayload;

function nativeExecutor(id: "codex" | "claude" | "codebuddy", name: string, model: string): DevExecutor {
  return {
    id,
    name,
    available: true,
    enabled: true,
    reason: "已连接",
    programAvailable: true,
    probe: {
      state: "ready",
      authentication: "ready",
      authMode: "chatgpt",
      protocolVerified: id === "codebuddy",
      modelCatalogState: id === "codebuddy" ? "ready" : undefined,
      reason: "已连接",
    },
    models: [{ id: model, label: `${name} 模型`, reasoningEfforts: ["low", "high"], reasoningEffort: "high" }],
  };
}

const executors = [
  nativeExecutor("codex", "Codex CLI", "codex-model"),
  nativeExecutor("claude", "Claude Code", "claude-model"),
  nativeExecutor("codebuddy", "CodeBuddy", "codebuddy-model"),
];

beforeEach(() => {
  useModelPreferences.setState({ hiddenNative: [], providerOrder: [] });
  useNativeProviderState.setState({ revision: 0 });
  vi.spyOn(api, "fetchSettings").mockResolvedValue(settings);
  vi.spyOn(developmentApi, "providerExecutors").mockResolvedValue({ executors });
  vi.spyOn(developmentApi, "selectWorkModelSource");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function openSelector(value: AgentModelBinding | null = null, onChange = vi.fn(), triggerName = `跟随 Mona · ${settings.agent.model}`) {
  render(<VideoModelSelector token="test-token" value={value} onChange={onChange} />);
  await waitFor(() => expect(developmentApi.providerExecutors).toHaveBeenCalled());
  await screen.findByRole("button", { name: triggerName });
  fireEvent.pointerDown(screen.getByRole("button", { name: triggerName }), { button: 0, ctrlKey: false });
  await screen.findByRole("textbox", { name: "搜索模型" });
  return onChange;
}

async function selectOption(name: string) {
  const option = await screen.findByRole("menuitem", { name });
  fireEvent.click(option);
}

describe("VideoModelSelector", () => {
  it("shows Mona's actual runtime model ahead of its global fallback setting", async () => {
    const client = { onRuntimeModelUpdate: vi.fn(() => () => {}) } as unknown as MonaClient;
    render(<ClientProvider client={client} token="test-token" modelName="agent-pinned-model" runtimeStatus="ready"><VideoModelSelector token="test-token" value={null} onChange={vi.fn()} /></ClientProvider>);
    expect(await screen.findByRole("button", { name: "跟随 Mona · agent-pinned-model" })).toBeInTheDocument();
  });
  it("maps Mona API choices to the original provider and restores inheritance as null", async () => {
    const onChange = await openSelector();
    await selectOption("第三方 API · API Chat");
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({
      executor: "mona", model: "api-chat", provider: "third-party-api-id", effort: "low",
    }));
    expect(developmentApi.selectWorkModelSource).not.toHaveBeenCalled();

    cleanup();
    const inheritChange = await openSelector(
      { executor: "mona", model: "api-chat", provider: "third-party-api-id", effort: "low" },
      vi.fn(),
      "第三方 API · API Chat",
    );
    await selectOption(`默认 · 跟随 Mona · ${settings.agent.model}`);
    await waitFor(() => expect(inheritChange).toHaveBeenCalledWith(null));

    cleanup();
    render(<VideoModelSelector token="test-token" value={{
      executor: "mona", model: "api-chat", provider: "third-party-api-id", effort: "high",
    }} onChange={vi.fn()} />);
    const trigger = await screen.findByRole("button", { name: "第三方 API · API Chat" });
    expect(trigger).toHaveTextContent("高");
  });

  it.each([
    ["OpenAI · Codex CLI 模型", "codex", "codex-model"],
    ["Anthropic · Claude Code 模型", "claude", "claude-model"],
    ["CodeBuddy · CodeBuddy 模型", "codebuddy", "codebuddy-model"],
  ] as const)("maps %s to an explicit native model without an API provider", async (choice, executor, model) => {
    const onChange = await openSelector();
    await selectOption(choice);
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ executor, model, provider: null, effort: "high" }));
    expect(developmentApi.selectWorkModelSource).not.toHaveBeenCalled();
  });

  it("keeps API choices available and offers a compact retry when the native catalog fails", async () => {
    vi.mocked(developmentApi.providerExecutors).mockRejectedValueOnce(new Error("native service unavailable"));
    const onChange = vi.fn();
    render(<VideoModelSelector token="test-token" value={null} onChange={onChange} />);
    expect(await screen.findByRole("status")).toHaveTextContent("第三方引擎列表未能加载");
    const triggerName = `跟随 Mona · ${settings.agent.model}`;
    await screen.findByRole("button", { name: triggerName });
    fireEvent.pointerDown(screen.getByRole("button", { name: triggerName }), { button: 0, ctrlKey: false });
    await screen.findByRole("textbox", { name: "搜索模型" });
    expect(await screen.findByRole("menuitem", { name: "第三方 API · API Chat" })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "搜索模型" }), { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(developmentApi.providerExecutors).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
    fireEvent.pointerDown(screen.getByRole("button", { name: triggerName }), { button: 0, ctrlKey: false });
    await screen.findByRole("textbox", { name: "搜索模型" });
    await selectOption("第三方 API · API Chat");
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({
      executor: "mona", model: "api-chat", provider: "third-party-api-id", effort: "low",
    }));
  });

  it("keeps native choices visible when Mona settings fail", async () => {
    vi.mocked(api.fetchSettings).mockRejectedValueOnce(new Error("settings unavailable"));
    render(<VideoModelSelector token="test-token" value={null} onChange={vi.fn()} />);
    expect(await screen.findByRole("status")).toHaveTextContent("Mona 模型列表未能加载");
    fireEvent.pointerDown(screen.getByRole("button", { name: "跟随 Mona" }), { button: 0, ctrlKey: false });
    const codexChoice = await screen.findByRole("menuitem", { name: "OpenAI · Codex CLI 模型" });
    expect(codexChoice).not.toHaveAttribute("aria-disabled", "true");
  });

  it("retains a selected model that disappeared from the catalog as disabled", async () => {
    render(<VideoModelSelector token="test-token" value={{
      executor: "codex", model: "retired-model", provider: null, effort: "high",
    }} onChange={vi.fn()} />);
    expect(await screen.findByRole("button", { name: "OpenAI · retired-model" })).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByRole("button", { name: "OpenAI · retired-model" }), { button: 0, ctrlKey: false });
    const oldChoice = await screen.findByRole("menuitem", { name: "OpenAI · retired-model" });
    expect(oldChoice).toHaveAttribute("aria-disabled", "true");
    expect(oldChoice).toHaveAttribute("aria-description", expect.stringContaining("已保留原选择"));
  });

  it("explains when the selected engine is disabled", async () => {
    vi.mocked(developmentApi.providerExecutors).mockResolvedValueOnce({ executors: [
      { ...executors[2], enabled: false, reason: "此引擎已停用" },
    ] });
    render(<VideoModelSelector token="test-token" value={{
      executor: "codebuddy", model: "codebuddy-model", provider: null, effort: "high",
    }} onChange={vi.fn()} />);
    const trigger = await screen.findByRole("button", { name: "CodeBuddy · CodeBuddy 模型" });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    const choice = await screen.findByRole("menuitem", { name: "CodeBuddy · CodeBuddy 模型" });
    expect(choice).toHaveAttribute("aria-disabled", "true");
    expect(choice).toHaveAttribute("aria-description", "此引擎已停用，请在模型设置中启用。");
  });

  it("refreshes native choices after the existing provider revision changes", async () => {
    const firstSettings = { ...settings, agent: {
      ...settings.agent, executor: "codex" as const, model: "api-default", native_model: "first-native-default",
    } };
    const updatedSettings = { ...firstSettings, agent: { ...firstSettings.agent, native_model: "updated-native-default" } };
    vi.mocked(api.fetchSettings).mockReset()
      .mockResolvedValueOnce(firstSettings)
      .mockResolvedValueOnce(updatedSettings)
      .mockResolvedValue(updatedSettings);
    render(<VideoModelSelector token="test-token" value={null} onChange={vi.fn()} />);
    await waitFor(() => expect(developmentApi.providerExecutors).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("button", { name: "跟随 Mona · first-native-default" })).toBeInTheDocument();
    act(() => nativeProvidersChanged());
    await waitFor(() => expect(developmentApi.providerExecutors).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(api.fetchSettings).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("button", { name: "跟随 Mona · updated-native-default" })).toBeInTheDocument();
  });

  it("reloads the inherited model after Mona announces a runtime model update", async () => {
    vi.mocked(api.fetchSettings).mockReset()
      .mockResolvedValueOnce({ ...settings, agent: { ...settings.agent, model: "before-runtime-change" } })
      .mockResolvedValue({ ...settings, agent: { ...settings.agent, model: "after-runtime-change" } });
    let updateModel: ((modelName: string | null, modelPreset?: string | null) => void) | undefined;
    const client = {
      onRuntimeModelUpdate: vi.fn((handler: (modelName: string | null, modelPreset?: string | null) => void) => {
        updateModel = handler;
        return vi.fn();
      }),
    } as unknown as MonaClient;
    render(<ClientProvider client={client} token="test-token" runtimeStatus="ready">
      <VideoModelSelector token="test-token" value={null} onChange={vi.fn()} />
    </ClientProvider>);
    expect(await screen.findByRole("button", { name: "跟随 Mona · before-runtime-change" })).toBeInTheDocument();
    act(() => updateModel?.("after-runtime-change", null));
    await waitFor(() => expect(api.fetchSettings).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("button", { name: "跟随 Mona · after-runtime-change" })).toBeInTheDocument();
  });
});
