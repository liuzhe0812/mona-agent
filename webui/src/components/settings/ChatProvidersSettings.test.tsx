import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SettingsPayload } from "@/lib/types";

const fetchProviderModels = vi.hoisted(() => vi.fn());
const updateProviderSettings = vi.hoisted(() => vi.fn());
const updateSettings = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", () => ({
  fetchProviderModels,
  updateProviderSettings,
  updateSettings,
}));

import { ChatProvidersSettings } from "./ChatProvidersSettings";

type ChatProvider = NonNullable<SettingsPayload["chat_providers"]>[number];

function provider(
  name: string,
  label: string,
  configured: boolean,
  models: Array<{ id: string; name: string; enabled?: boolean; recommended?: boolean }>,
  region?: string,
  isCustom = false,
): ChatProvider {
  return {
    name,
    label,
    configured,
    is_custom: isCustom,
    api_key_required: !isCustom,
    api_key_hint: configured ? "secr••••2345" : null,
    api_base: `https://${name}.example/v1`,
    default_api_base: `https://${name}.example/v1`,
    model: models[0]?.id ?? null,
    models: models.map((model, index) => ({
      id: model.id,
      name: model.name,
      context_window: null,
      enabled: model.enabled ?? true,
      recommended: model.recommended ?? index === 0,
    })),
    models_url: null,
    region: region ?? null,
    api_base_editable: isCustom || name === "litellm",
  };
}

function settingsWith(providers: ChatProvider[]): SettingsPayload {
  return {
    agent: {
      model: providers.find((item) => item.configured)?.models[0]?.id ?? "",
      provider: providers.find((item) => item.configured)?.name ?? "auto",
    },
    chat_providers: providers,
  } as SettingsPayload;
}

const noop = vi.fn();

describe("ChatProvidersSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("opens the three-step wizard and keeps manual fallback after discovery fails", async () => {
    const zhipu = provider(
      "zhipu-glm-cn",
      "智谱 GLM（中国大陆）",
      false,
      [{ id: "glm-5.2", name: "GLM-5.2" }],
      "cn",
    );
    fetchProviderModels.mockRejectedValueOnce(new Error("网络不可用"));
    updateProviderSettings.mockResolvedValueOnce(settingsWith([provider(zhipu.name, zhipu.label, true, zhipu.models)]));

    render(
      <ChatProvidersSettings
        settings={settingsWith([zhipu])}
        token="token"
        onSettingsChanged={noop}
        onModelNameChange={noop}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "添加供应商" }));
    fireEvent.click(screen.getByRole("button", { name: /智谱 GLM（中国大陆）/ }));
    const key = screen.getByPlaceholderText("请输入 API Key");
    expect(screen.getByDisplayValue(zhipu.api_base)).toHaveAttribute("readonly");
    fireEvent.change(key, { target: { value: "zhipu-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "拉取模型" }));

    expect(await screen.findByText("网络不可用")).toBeInTheDocument();
    const manual = screen.getByPlaceholderText("手动添加模型 ID（逗号分隔）");
    fireEvent.change(manual, { target: { value: "custom-model" } });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    fireEvent.click(screen.getByRole("button", { name: "完成" }));

    await waitFor(() => expect(updateProviderSettings).toHaveBeenCalled());
    expect(updateProviderSettings).toHaveBeenCalledWith(
      "token",
      expect.objectContaining({
        provider: "zhipu-glm-cn",
        apiKey: "zhipu-secret",
        enabledModels: expect.arrayContaining(["glm-5.2", "custom-model"]),
      }),
    );
  });

  it("keeps discovery disabled until a required API key is entered", () => {
    const deepseek = provider(
      "deepseek",
      "DeepSeek",
      false,
      [{ id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" }],
    );
    render(
      <ChatProvidersSettings
        settings={settingsWith([deepseek])}
        token="token"
        onSettingsChanged={noop}
        onModelNameChange={noop}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "添加供应商" }));
    fireEvent.click(screen.getByRole("button", { name: /DeepSeek/ }));

    expect(screen.getByRole("button", { name: "拉取模型" })).toBeDisabled();
    expect(updateProviderSettings).not.toHaveBeenCalled();
  });

  it("uses an independent search field in the add-provider wizard", () => {
    const configured = provider("zhipu-glm-cn", "智谱 GLM（中国大陆）", true, [{ id: "glm-5.2", name: "GLM-5.2" }], "cn");
    const deepseek = provider("deepseek", "DeepSeek", false, [{ id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" }]);
    const litellm = provider("litellm", "LiteLLM Proxy", false, []);
    render(
      <ChatProvidersSettings
        settings={settingsWith([configured, deepseek, litellm])}
        token="token"
        onSettingsChanged={noop}
        onModelNameChange={noop}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText("搜索供应商"), { target: { value: "not-a-provider" } });
    fireEvent.click(screen.getByRole("button", { name: "添加供应商" }));
    expect(screen.getByRole("button", { name: /DeepSeek/ })).toBeInTheDocument();
    fireEvent.change(screen.getAllByPlaceholderText("搜索供应商")[1], { target: { value: "LiteLLM" } });
    expect(screen.queryByRole("button", { name: /DeepSeek/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /LiteLLM Proxy/ })).toBeInTheDocument();
  });

  it("shows the default action when the same model belongs to another provider", () => {
    const zhipu = provider("zhipu-glm-cn", "智谱 GLM（中国大陆）", true, [{ id: "shared-model", name: "Shared model" }], "cn");
    const deepseek = provider("deepseek", "DeepSeek", true, [{ id: "shared-model", name: "Shared model" }]);
    const settings = settingsWith([zhipu, deepseek]);
    settings.agent.provider = "deepseek";
    settings.agent.model = "shared-model";
    render(
      <ChatProvidersSettings
        settings={settings}
        token="token"
        onSettingsChanged={noop}
        onModelNameChange={noop}
      />,
    );

    expect(screen.getByRole("button", { name: "设为默认" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /Shared model/ })).toBeInTheDocument();
  });

  it("allows disabling a provider's final model when another provider remains enabled", async () => {
    const deepseek = provider("deepseek", "DeepSeek", true, [{ id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" }]);
    const zhipu = provider("zhipu-glm-cn", "智谱 GLM", true, [{ id: "glm-5.2", name: "GLM-5.2" }]);
    updateProviderSettings.mockResolvedValueOnce(settingsWith([
      provider("deepseek", "DeepSeek", true, [{ id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", enabled: false }]),
      zhipu,
    ]));
    render(
      <ChatProvidersSettings
        settings={settingsWith([deepseek, zhipu])}
        token="token"
        onSettingsChanged={noop}
        onModelNameChange={noop}
      />,
    );

    fireEvent.click(screen.getByRole("switch", { name: "DeepSeek V4 Pro 关闭" }));

    await waitFor(() => expect(updateProviderSettings).toHaveBeenCalledWith(
      "token",
      { provider: "deepseek", enabledModels: [] },
    ));
  });

  it("edits a configured provider with enabled models preselected and preserves a blank key", async () => {
    const zhipu = provider(
      "zhipu-glm-cn",
      "智谱 GLM（中国大陆）",
      true,
      [
        { id: "glm-5.2", name: "GLM-5.2", enabled: true },
        { id: "glm-5.1", name: "GLM-5.1", enabled: false },
      ],
      "cn",
    );
    fetchProviderModels.mockResolvedValueOnce({ models: [] });
    updateProviderSettings.mockResolvedValueOnce(settingsWith([zhipu]));
    render(
      <ChatProvidersSettings
        settings={settingsWith([zhipu])}
        token="token"
        onSettingsChanged={noop}
        onModelNameChange={noop}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "编辑供应商" }));
    expect(screen.getByRole("dialog", { name: "编辑供应商" })).toBeInTheDocument();
    expect(screen.getByDisplayValue(zhipu.api_base)).toHaveAttribute("readonly");
    expect(screen.getByPlaceholderText(/已配置 secr/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "拉取模型" }));

    expect(await screen.findByText("选择可用模型")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /GLM-5.2/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "GLM-5.1" })).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "完成" }));

    await waitFor(() => expect(updateProviderSettings).toHaveBeenCalled());
    const update = updateProviderSettings.mock.calls[0][1] as Record<string, unknown>;
    expect(update).not.toHaveProperty("apiKey");
    expect(update).toEqual(expect.objectContaining({
      provider: "zhipu-glm-cn",
      enabledModels: ["glm-5.2"],
    }));
  });

  it("deduplicates repeated discovered model IDs in the wizard", async () => {
    const deepseek = provider(
      "deepseek",
      "DeepSeek",
      false,
      [{ id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" }],
    );
    fetchProviderModels.mockResolvedValueOnce({
      models: ["custom-model", "custom-model", "custom-other"],
    });
    render(
      <ChatProvidersSettings
        settings={settingsWith([deepseek])}
        token="token"
        onSettingsChanged={noop}
        onModelNameChange={noop}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "添加供应商" }));
    fireEvent.click(screen.getByRole("button", { name: /DeepSeek/ }));
    fireEvent.change(screen.getByPlaceholderText("请输入 API Key"), { target: { value: "deepseek-key" } });
    fireEvent.click(screen.getByRole("button", { name: "拉取模型" }));

    expect(await screen.findByText("选择可用模型")).toBeInTheDocument();
    expect(screen.getAllByRole("checkbox", { name: "custom-model" })).toHaveLength(1);
  });

  it("keeps the custom endpoint entry visible when the catalog search has no matches", () => {
    render(
      <ChatProvidersSettings
        settings={settingsWith([provider("deepseek", "DeepSeek", false, [{ id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" }])])}
        token="token"
        onSettingsChanged={noop}
        onModelNameChange={noop}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "添加供应商" }));
    fireEvent.change(screen.getAllByPlaceholderText("搜索供应商")[1], { target: { value: "no-such-provider" } });
    expect(screen.getByRole("button", { name: /自定义端点/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /自定义端点/ }));
    expect(screen.getByRole("dialog", { name: "添加自定义供应商" })).toBeInTheDocument();
    expect(screen.getByLabelText("显示名称")).toBeInTheDocument();
    expect(screen.getByLabelText("API Base")).toBeInTheDocument();
  });

  it("saves a custom endpoint with a manual model after discovery fails", async () => {
    fetchProviderModels.mockRejectedValueOnce(new Error("endpoint offline"));
    updateProviderSettings.mockResolvedValueOnce(settingsWith([
      provider("custom-local", "本地模型", true, [{ id: "local-chat", name: "local-chat" }], undefined, true),
    ]));
    render(
      <ChatProvidersSettings
        settings={settingsWith([provider("deepseek", "DeepSeek", false, [])])}
        token="token"
        onSettingsChanged={noop}
        onModelNameChange={noop}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "添加供应商" }));
    fireEvent.click(screen.getByRole("button", { name: /自定义端点/ }));
    fireEvent.change(screen.getByLabelText("显示名称"), { target: { value: "本地模型" } });
    fireEvent.change(screen.getByLabelText("API Base"), { target: { value: "http://127.0.0.1:1234/v1" } });
    fireEvent.click(screen.getByRole("button", { name: "拉取模型列表" }));
    expect(await screen.findByText("endpoint offline")).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("手动添加模型 ID（逗号分隔）"), { target: { value: "local-chat" } });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    fireEvent.click(screen.getByRole("button", { name: "完成" }));

    await waitFor(() => expect(updateProviderSettings).toHaveBeenCalled());
    expect(updateProviderSettings).toHaveBeenCalledWith(
      "token",
      expect.objectContaining({
        provider: "custom",
        customName: "本地模型",
        apiBase: "http://127.0.0.1:1234/v1",
        enabledModels: ["local-chat"],
      }),
    );
    expect(updateProviderSettings.mock.calls[0][1]).not.toHaveProperty("apiKey");
  });

  it("edits a custom endpoint with its enabled models preselected and keeps a blank key", async () => {
    const custom = provider(
      "custom-local",
      "本地模型",
      true,
      [{ id: "local-chat", name: "local-chat", enabled: true }],
      undefined,
      true,
    );
    fetchProviderModels.mockResolvedValueOnce({ models: [] });
    updateProviderSettings.mockResolvedValueOnce(settingsWith([custom]));
    render(
      <ChatProvidersSettings
        settings={settingsWith([custom])}
        token="token"
        onSettingsChanged={noop}
        onModelNameChange={noop}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "编辑供应商" }));
    expect(screen.getByRole("dialog", { name: "编辑自定义供应商" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "拉取模型列表" }));
    expect(fetchProviderModels).toHaveBeenCalledWith("token", expect.objectContaining({ provider: "custom-local" }));
    expect(await screen.findByText("选择可用模型")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /local-chat/ })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "完成" }));

    await waitFor(() => expect(updateProviderSettings).toHaveBeenCalled());
    expect(updateProviderSettings.mock.calls[0][1]).toEqual(expect.objectContaining({
      provider: "custom-local",
      customName: "本地模型",
      enabledModels: ["local-chat"],
    }));
    expect(updateProviderSettings.mock.calls[0][1]).not.toHaveProperty("apiKey");
  });
});
