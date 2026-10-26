import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({
  fetchSettings: vi.fn(),
  fetchProviderModels: vi.fn(),
  updateProviderSettings: vi.fn(),
  updateSettings: vi.fn(),
}));

import { ChatProvidersSettings } from "./ChatProvidersSettings";
import { fetchProviderModels, fetchSettings, updateProviderSettings } from "@/lib/api";
import { developmentApi, type EngineResource, type ExecutorSettings, type NativeProbe } from "@/lib/development-api";
import { useModelPreferences } from "@/components/models/model-sources";
import type { SettingsPayload } from "@/lib/types";

function openModelMenu(name: string) {
  fireEvent.pointerDown(screen.getByRole("button", { name: `设置 ${name}` }), {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
}

function openManagementMenu() {
  const trigger = screen.getByRole("button", { name: "筛选模型" });
  expect(trigger.querySelector("svg.lucide-filter")).not.toBeNull();
  fireEvent.pointerDown(trigger, {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
}

function providerButtons() {
  return [...screen.getByRole("complementary").querySelectorAll<HTMLElement>("[data-provider-id]")]
    .map((row) => row.querySelector<HTMLButtonElement>('button:not([aria-label="调整顺序"])'))
    .filter((button): button is HTMLButtonElement => button !== null);
}

function installedNativeResource(executor: string): EngineResource {
  return {
    executor, source: "managed_runtime", executable: `test/${executor}`, systemAvailable: false,
    installed: true, managedInstalled: true, canPrepare: false, canUpdate: false,
    repairRequired: false, explicitPath: false, packRef: `${executor}-pack`, version: "1.0.0",
    installedVersion: "1.0.0", downloadBytes: 0, reason: "", job: null,
  };
}

const nativeExecutorSettings: ExecutorSettings = {
  revision: "test-revision", values: { codexPath: null, claudePath: null },
  credentialPresent: {}, enabledEngines: [],
};

const settings = {
  agent: { provider: "deepseek", model: "deepseek-v4-flash" },
  chat_providers: [
    {
      name: "mona_managed",
      label: "Mona AI",
      is_builtin: true,
      configured: true,
      api_key_required: false,
      api_base: "https://mona-ai.cn/v1",
      default_api_base: "https://mona-ai.cn/v1",
      models: [{ id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", enabled: true }],
    },
    {
      name: "deepseek",
      label: "DeepSeek",
      configured: true,
      api_key_required: true,
      api_base: "https://api.deepseek.com",
      default_api_base: "https://api.deepseek.com",
      models: [{ id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", enabled: true }],
    },
  ],
  image_generation: {
    provider: "deepseek",
    model: "deepseek-image",
    providers: [{ name: "deepseek", label: "DeepSeek", configured: true, image_models: ["deepseek-image"] }],
  },
  video_generation: {
    provider: "deepseek",
    model: "deepseek-video",
    providers: [{ name: "deepseek", label: "DeepSeek", configured: true, video_models: ["deepseek-video"] }],
  },
} as unknown as SettingsPayload;

describe("ChatProvidersSettings", () => {
  beforeEach(() => {
    useModelPreferences.setState({ hiddenNative: [], providerOrder: [] });
    vi.spyOn(developmentApi, "accountUsage").mockResolvedValue({
      revision: 0,
      connected: true,
      email: null,
      planType: null,
      limits: [],
      credits: null,
      availableResets: null,
      fetchedAt: null,
      error: null,
    });
    vi.spyOn(developmentApi, "accountUsageChanges").mockImplementation((_executor, _revision, signal) =>
      new Promise((_resolve, reject) => {
        const rejectOnAbort = () => reject(new DOMException("Aborted", "AbortError"));
        if (signal?.aborted) rejectOnAbort();
        else signal?.addEventListener("abort", rejectOnAbort, { once: true });
      }),
    );
  });
  afterEach(() => vi.restoreAllMocks());
  it("shows Mona AI as an immutable provider in the existing provider layout", async () => {
    const onSelectImageModel = vi.fn();
    const onSelectVideoModel = vi.fn();
    const onOpenImageSettings = vi.fn();
    const onOpenVideoSettings = vi.fn();
    const onSettingsChanged = vi.fn();
    vi.mocked(fetchSettings).mockReset().mockResolvedValueOnce(settings);
    render(
      <ChatProvidersSettings
        settings={settings}
        token="test-token"
        onSettingsChanged={onSettingsChanged}
        onModelNameChange={vi.fn()}
        onSelectImageModel={onSelectImageModel}
        onSelectVideoModel={onSelectVideoModel}
        onOpenImageSettings={onOpenImageSettings}
        onOpenVideoSettings={onOpenVideoSettings}
      />,
    );

    expect(screen.getAllByText("DeepSeek").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Mona AI")).toHaveLength(2);
    expect(screen.getByText("内置")).toBeInTheDocument();
    const sourceList = within(screen.getByRole("complementary"));
    expect(sourceList.queryByText(/\d+ 个模型/)).not.toBeInTheDocument();
    expect(sourceList.queryByLabelText("已配置")).not.toBeInTheDocument();
    expect(sourceList.queryByLabelText("默认")).not.toBeInTheDocument();
    expect(screen.getByText(/按实际 Token 从 Mona AI 余额扣费/)).toBeInTheDocument();
    expect(screen.getByText("可用余额")).toBeInTheDocument();
    expect(await screen.findByText("可用")).toBeInTheDocument();
    expect(screen.queryByText("已连接")).not.toBeInTheDocument();
    expect(screen.queryByText("我的 API Key")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "编辑供应商" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "删除供应商" })).not.toBeInTheDocument();

    const sources = providerButtons();
    expect(sources[0]).toHaveTextContent("Mona AI");
    expect(sources[0].querySelector("img")).toHaveAttribute("src", "/brand/mona_icon.png?v=a829e97b8751");
    expect(sources[1].querySelector("img")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "刷新模型" }));
    await waitFor(() => expect(fetchSettings).toHaveBeenCalledWith("test-token"));
    await waitFor(() => expect(onSettingsChanged).toHaveBeenCalledWith(settings));

    fireEvent.click(sources[1]);
    expect(screen.queryByText("默认对话")).not.toBeInTheDocument();
    openManagementMenu();
    expect(screen.getByRole("menuitem", { name: "分别调整" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "全部显示" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "全部隐藏" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "重置显示偏好" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "分别调整" }));
    expect(screen.getByText("默认对话")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "设置 DeepSeek V4 Flash" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "设置 deepseek-image" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "设置 deepseek-video" })).toHaveLength(1);
    expect(screen.getAllByRole("switch")).toHaveLength(1);
    expect(screen.getAllByText("默认图片")).toHaveLength(1);
    expect(screen.getAllByText("默认视频")).toHaveLength(1);

    openModelMenu("deepseek-video");
    expect(screen.queryByRole("menuitem", { name: "设为默认图片模型" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "视频生成设置" }));

    openModelMenu("deepseek-image");
    fireEvent.click(screen.getByRole("menuitem", { name: "图片生成设置" }));
    expect(onOpenImageSettings).toHaveBeenCalledWith("deepseek", "deepseek-image");

    openModelMenu("deepseek-image");
    expect(screen.queryByRole("menuitem", { name: "设为默认视频模型" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "图片生成设置" }));

    openModelMenu("deepseek-video");
    fireEvent.click(screen.getByRole("menuitem", { name: "视频生成设置" }));
    expect(onOpenVideoSettings).toHaveBeenCalledWith("deepseek", "deepseek-video");
  });

  it("shows Mona AI as unavailable when the server catalog is empty", () => {
    const unavailable = {
      ...settings,
      chat_providers: settings.chat_providers?.map((provider) =>
        provider.name === "mona_managed"
          ? { ...provider, configured: false, model: null, models: [] }
          : provider,
      ),
    } as SettingsPayload;

    render(
      <ChatProvidersSettings
        settings={unavailable}
        token="test-token"
        onSettingsChanged={vi.fn()}
        onModelNameChange={vi.fn()}
      />,
    );

    expect(screen.getAllByText("暂无可用模型").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("暂无模型")).toBeInTheDocument();
    expect(screen.queryByText(/VPS|服务端|生效价格/)).not.toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });

  it("offers one custom model list independently to chat, image, and video", async () => {
    const customSettings = {
      ...settings,
      chat_providers: [
        settings.chat_providers![0],
        {
          name: "custom-relay",
          label: "自建模型",
          is_custom: true,
          configured: true,
          api_key_required: false,
          api_base: "https://relay.example/v1",
          default_api_base: "https://relay.example/v1",
          models: ["qwen", "z-image", "h3-video", "songgen", "world3d", "misc", "mystery"].map((id) => ({
            id,
            name: id,
            type: id === "qwen"
              ? "chat"
              : id === "z-image"
                ? "image"
                : id === "h3-video"
                  ? "video"
                  : id === "songgen"
                    ? "audio"
                    : id === "world3d"
                      ? "world3d"
                      : id === "misc"
                        ? "other"
                        : undefined,
            enabled: id === "qwen",
            recommended: id === "qwen",
          })),
        },
      ],
      image_generation: {
        ...settings.image_generation,
        provider: "custom-relay",
        model: "songgen",
        providers: [
          {
            name: "custom-relay",
            label: "自建模型",
            configured: true,
            image_models: ["qwen", "z-image", "h3-video"],
          },
        ],
      },
      video_generation: {
        ...settings.video_generation,
        provider: "custom-relay",
        model: "songgen",
        providers: [
          {
            name: "custom-relay",
            label: "自建模型",
            configured: true,
            video_models: ["qwen", "z-image", "h3-video"],
          },
        ],
      },
    } as SettingsPayload;
    const onSelectImageModel = vi.fn();
    const onSelectVideoModel = vi.fn();
    const onOpenImageSettings = vi.fn();
    const onOpenVideoSettings = vi.fn();

    const view = render(
      <ChatProvidersSettings
        settings={customSettings}
        token="test-token"
        onSettingsChanged={vi.fn()}
        onModelNameChange={vi.fn()}
        onSelectImageModel={onSelectImageModel}
        onSelectVideoModel={onSelectVideoModel}
        onOpenImageSettings={onOpenImageSettings}
        onOpenVideoSettings={onOpenVideoSettings}
      />,
    );

    fireEvent.click(providerButtons()[1]);
    expect(screen.queryByText("推荐")).not.toBeInTheDocument();
    expect(screen.queryByText("默认对话")).not.toBeInTheDocument();
    openManagementMenu();
    expect(screen.getByRole("menuitemradio", { name: "按品牌分组" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemradio", { name: "按名称排序" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "分别调整" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "全部隐藏" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "分别调整" }));
    expect(await screen.findByText("推荐")).toBeInTheDocument();
    expect(screen.getAllByRole("switch")).toHaveLength(1);
    const qwenSwitch = screen.getByRole("switch", { name: "qwen 不在对话中显示" });
    const qwenDefaultButton = screen.getByRole("button", { name: "设为默认" });
    const qwenRowChildren = [...qwenSwitch.parentElement!.children];
    expect(qwenRowChildren.indexOf(qwenDefaultButton)).toBeLessThan(qwenRowChildren.indexOf(qwenSwitch));
    expect(screen.getAllByRole("button", { name: /^设置 / })).toHaveLength(7);
    expect(screen.getByRole("tab", { name: "对话" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "图像" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "视频" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "音频" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "3D" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "其他" })).toBeInTheDocument();
    const zImageSettings = screen.getByRole("button", { name: "设置 z-image" });
    const videoSettings = screen.getByRole("button", { name: "设置 h3-video" });
    expect(within(zImageSettings.parentElement!).getByText("图片")).toBeInTheDocument();
    expect(within(videoSettings.parentElement!).getByText("视频")).toBeInTheDocument();
    expect(within(screen.getByRole("button", { name: "设置 songgen" }).parentElement!).getByText("音频")).toBeInTheDocument();
    expect(within(screen.getByRole("button", { name: "设置 world3d" }).parentElement!).getByText("3D")).toBeInTheDocument();
    expect(within(screen.getByRole("button", { name: "设置 misc" }).parentElement!).getByText("其他")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "设置 z-image" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "设置 h3-video" })).toHaveLength(1);
    expect(screen.getAllByText("默认图片")).toHaveLength(1);
    expect(screen.getAllByText("默认视频")).toHaveLength(1);
    openModelMenu("z-image");
    fireEvent.click(screen.getByRole("menuitem", { name: "设为默认图片模型" }));
    expect(onSelectImageModel).toHaveBeenCalledWith("custom-relay", "z-image");
    openModelMenu("z-image");
    expect(screen.queryByRole("menuitem", { name: "设为默认视频模型" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "图片生成设置" }));
    expect(onOpenImageSettings).toHaveBeenCalledWith("custom-relay", "z-image");
    openModelMenu("h3-video");
    expect(screen.queryByRole("menuitem", { name: "设为默认图片模型" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "设为默认视频模型" }));
    expect(onSelectVideoModel).toHaveBeenCalledWith("custom-relay", "h3-video");
    openModelMenu("h3-video");
    fireEvent.click(screen.getByRole("menuitem", { name: "视频生成设置" }));
    expect(onOpenVideoSettings).toHaveBeenCalledWith("custom-relay", "h3-video");
    openModelMenu("mystery");
    expect(screen.queryByRole("menuitem", { name: "设为默认图片模型" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "设为默认视频模型" })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: "其他" })).toHaveAttribute("aria-checked", "true");
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    const updatedSettings = {
      ...customSettings,
      image_generation: { ...customSettings.image_generation, model: "qwen" },
      video_generation: { ...customSettings.video_generation, model: "qwen" },
    } as SettingsPayload;
    view.rerender(
      <ChatProvidersSettings
        settings={updatedSettings}
        token="test-token"
        onSettingsChanged={vi.fn()}
        onModelNameChange={vi.fn()}
        onSelectImageModel={onSelectImageModel}
        onSelectVideoModel={onSelectVideoModel}
        onOpenImageSettings={onOpenImageSettings}
        onOpenVideoSettings={onOpenVideoSettings}
      />,
    );
    const qwenRow = screen.getByTitle("qwen").parentElement!.parentElement!.parentElement!;
    expect(within(qwenRow).getByText("默认图片")).toBeInTheDocument();
    expect(within(qwenRow).getByText("默认视频")).toBeInTheDocument();
    expect(screen.getAllByText("默认图片")).toHaveLength(1);
    expect(screen.getAllByText("默认视频")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "设为默认" })).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("搜索模型"), { target: { value: "h3-video" } });
    expect(screen.getAllByRole("button", { name: /^设置 / })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "设置 h3-video" })).toBeInTheDocument();
  });

  it("folds brand groups and filters friendly model names by category and search", async () => {
    const catalog = {
      ...settings,
      chat_providers: [settings.chat_providers![0], {
        name: "custom-media", label: "媒体供应商", is_custom: true,
        configured: true, api_key_required: false,
        api_base: "https://relay.example/v1", default_api_base: "https://relay.example/v1",
        models: [
          { id: "deepseek-v4-flash-test", name: "deepseek-v4-flash-test", type: "chat", enabled: true },
          { id: "qwen-3.7-plus", name: "qwen-3.7-plus", type: "image", enabled: false },
          { id: "h3-video-v2", name: "h3-video-v2", type: "video", enabled: false },
        ],
      }],
    } as SettingsPayload;
    vi.spyOn(developmentApi, "providerExecutors").mockResolvedValue({ executors: [] });
    render(<ChatProvidersSettings settings={catalog} token="test-token" onSettingsChanged={vi.fn()} onModelNameChange={vi.fn()} />);

    fireEvent.click(within(screen.getByRole("complementary")).getByRole("button", { name: /媒体供应商/ }));
    expect(screen.getByTitle("deepseek-v4-flash-test")).toHaveTextContent(/^DeepSeek/);
    expect(screen.getByTitle("deepseek-v4-flash-test")).not.toHaveTextContent("deepseek-v4-flash-test");
    const deepseekGroup = screen.getByRole("button", { name: /深度求索/ });
    expect(deepseekGroup).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(deepseekGroup);
    expect(deepseekGroup).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTitle("deepseek-v4-flash-test")).not.toBeInTheDocument();
    fireEvent.click(deepseekGroup);
    expect(screen.getByTitle("deepseek-v4-flash-test")).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByRole("tab", { name: "图像" }), { button: 0, ctrlKey: false });
    expect(screen.getByRole("tab", { name: "图像" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTitle("qwen-3.7-plus")).toHaveTextContent(/^Qwen/);
    expect(screen.queryByTitle("deepseek-v4-flash-test")).not.toBeInTheDocument();
    expect(screen.queryByTitle("h3-video-v2")).not.toBeInTheDocument();

    fireEvent.mouseDown(screen.getByRole("tab", { name: "全部" }), { button: 0, ctrlKey: false });
    fireEvent.change(screen.getByPlaceholderText("搜索模型"), { target: { value: "阿里巴巴" } });
    expect(screen.getByTitle("qwen-3.7-plus")).toBeInTheDocument();
    expect(screen.queryByTitle("deepseek-v4-flash-test")).not.toBeInTheDocument();
    expect(screen.queryByTitle("h3-video-v2")).not.toBeInTheDocument();
  });

  it("lets a misidentified text model be changed to chat while adding it", async () => {
    vi.mocked(fetchProviderModels).mockResolvedValueOnce({
      models: ["text-model"],
      model_details: [{ id: "text-model", name: "text-model", type: "image", context_window: 131_072 }],
    });
    vi.mocked(updateProviderSettings).mockResolvedValueOnce(settings);
    render(<ChatProvidersSettings settings={settings} token="test-token" onSettingsChanged={vi.fn()} onModelNameChange={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "添加供应商" }));
    fireEvent.click(screen.getByRole("button", { name: /自定义端点/ }));
    fireEvent.change(screen.getByPlaceholderText("例如：我的本地模型"), { target: { value: "本地供应商" } });
    fireEvent.change(screen.getByPlaceholderText("https://example.com/v1"), { target: { value: "https://relay.example/v1" } });
    fireEvent.click(screen.getByRole("button", { name: "拉取模型列表" }));
    await screen.findByRole("button", { name: "text-model 模型类型" });
    fireEvent.pointerDown(screen.getByRole("button", { name: "text-model 模型类型" }), { button: 0, pointerType: "mouse" });
    fireEvent.click(screen.getByRole("menuitem", { name: "对话" }));
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "完成" }));

    await waitFor(() => expect(updateProviderSettings).toHaveBeenCalledWith("test-token", expect.objectContaining({
      enabledModels: ["text-model"],
      discoveredModels: [expect.objectContaining({ id: "text-model", type: "chat", contextWindow: 131_072 })],
    })));
  });

  it("saves discovered context windows from the provider wizard", async () => {
    const unconfigured = {
      ...settings,
      chat_providers: [settings.chat_providers![0], {
        ...settings.chat_providers![1], configured: false, models: [],
      }],
    } as SettingsPayload;
    vi.mocked(fetchProviderModels).mockResolvedValueOnce({
      models: ["new-model"],
      model_details: [{ id: "new-model", context_window: 196_608 }],
    });
    vi.mocked(updateProviderSettings).mockResolvedValueOnce(settings);
    render(<ChatProvidersSettings settings={unconfigured} token="test-token" onSettingsChanged={vi.fn()} onModelNameChange={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "添加供应商" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "DeepSeek" }));
    fireEvent.change(screen.getByPlaceholderText("请输入 API Key"), { target: { value: "test-key" } });
    fireEvent.click(screen.getByRole("button", { name: "拉取模型" }));
    await waitFor(() => expect(fetchProviderModels).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole("button", { name: "完成" }));

    await waitFor(() => expect(updateProviderSettings).toHaveBeenCalledWith("test-token", expect.objectContaining({
      discoveredModels: expect.arrayContaining([
        expect.objectContaining({ id: "new-model", contextWindow: 196_608 }),
      ]),
    })));
  });

  it("lets an already added model be reclassified for chat selection", async () => {
    const misclassified = {
      ...settings,
      chat_providers: [settings.chat_providers![0], {
        name: "custom-relay", label: "本地供应商", is_custom: true,
        configured: true, api_key_required: false,
        api_base: "https://relay.example/v1", default_api_base: "https://relay.example/v1",
        models: [{ id: "text-model", name: "text-model", type: "image", context_window: 131_072, enabled: false, recommended: false }],
      }],
    } as SettingsPayload;
    vi.mocked(updateProviderSettings).mockResolvedValueOnce({
      ...misclassified,
      chat_providers: [misclassified.chat_providers![0], {
        ...misclassified.chat_providers![1],
        models: [{ id: "text-model", name: "text-model", type: "chat", enabled: false, recommended: false }],
      }],
    } as SettingsPayload);
    const onSettingsChanged = vi.fn();
    const view = render(<ChatProvidersSettings settings={misclassified} token="test-token" onSettingsChanged={onSettingsChanged} onModelNameChange={vi.fn()} />);
    fireEvent.click(within(screen.getByRole("complementary")).getByRole("button", { name: /本地供应商/ }));
    expect(screen.queryByRole("switch", { name: /text-model/ })).not.toBeInTheDocument();
    openModelMenu("text-model");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "对话" }));
    await waitFor(() => expect(updateProviderSettings).toHaveBeenCalledWith("test-token", expect.objectContaining({
      provider: "custom-relay",
      discoveredModels: [{ id: "text-model", name: "text-model", type: "chat", contextWindow: 131_072 }],
    })));
    view.rerender(<ChatProvidersSettings settings={onSettingsChanged.mock.calls[0][0]} token="test-token" onSettingsChanged={onSettingsChanged} onModelNameChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "未显示 1" }));
    expect(screen.getByRole("switch", { name: "text-model 在对话中显示" })).toBeInTheDocument();

    vi.mocked(fetchProviderModels).mockResolvedValueOnce({
      models: ["text-model"],
      model_details: [{ id: "text-model", name: "text-model", type: "image", context_window: 262_144 }],
    });
    vi.mocked(updateProviderSettings).mockResolvedValueOnce(onSettingsChanged.mock.calls[0][0]);
    fireEvent.click(screen.getByRole("button", { name: "刷新模型" }));
    await waitFor(() => expect(updateProviderSettings).toHaveBeenLastCalledWith("test-token", expect.objectContaining({
      discoveredModels: [expect.objectContaining({ id: "text-model", type: "chat", contextWindow: 262_144 })],
    })));

    vi.mocked(fetchProviderModels).mockResolvedValueOnce({
      models: ["text-model"],
      model_details: [{ id: "text-model", name: "text-model", type: "image" }],
    });
    vi.mocked(updateProviderSettings).mockResolvedValueOnce(misclassified);
    fireEvent.click(screen.getByRole("button", { name: "刷新模型" }));
    await waitFor(() => expect(updateProviderSettings).toHaveBeenLastCalledWith("test-token", expect.objectContaining({
      discoveredModels: [expect.objectContaining({ id: "text-model", type: "chat" })],
    })));
    expect(vi.mocked(updateProviderSettings).mock.lastCall?.[1].discoveredModels?.[0])
      .not.toHaveProperty("contextWindow");
  });

  it("lets an unknown model select its type in settings and only offers matching media actions", async () => {
    const payloadFor = (type?: string) => ({
      ...settings,
      chat_providers: [{ name: "custom-media", label: "媒体供应商", is_custom: true,
        configured: true, api_key_required: false, api_base: "https://relay.example/v1", default_api_base: "https://relay.example/v1",
        models: [{ id: "media-model", name: "Media Model", type, enabled: false, recommended: false }],
      }],
    } as SettingsPayload);
    vi.spyOn(developmentApi, "providerExecutors").mockResolvedValue({ executors: [] });
    const onSettingsChanged = vi.fn();
    const props = { token: "test-token", onSettingsChanged, onModelNameChange: vi.fn(),
      onSelectImageModel: vi.fn(), onOpenImageSettings: vi.fn(), onSelectVideoModel: vi.fn(), onOpenVideoSettings: vi.fn() };
    const view = render(<ChatProvidersSettings {...props} settings={payloadFor()} />);
    openModelMenu("Media Model");
    expect(screen.getByRole("menuitemradio", { name: "其他" })).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByRole("menuitem", { name: /生成设置/ })).not.toBeInTheDocument();

    for (const [type, label, opposite] of [["image", "图片", "视频"], ["video", "视频", "图片"]]) {
      vi.mocked(updateProviderSettings).mockResolvedValueOnce(payloadFor(type));
      fireEvent.click(screen.getByRole("menuitemradio", { name: label }));
      await waitFor(() => expect(updateProviderSettings).toHaveBeenLastCalledWith("test-token", {
        provider: "custom-media", discoveredModels: [{ id: "media-model", name: "Media Model", type }],
      }));
      await waitFor(() => expect(onSettingsChanged).toHaveBeenLastCalledWith(payloadFor(type)));
      view.rerender(<ChatProvidersSettings {...props} settings={payloadFor(type)} />);
      openModelMenu("Media Model");
      expect(screen.getByRole("menuitem", { name: `${label}生成设置` })).toBeInTheDocument();
      expect(screen.queryByRole("menuitem", { name: `${opposite}生成设置` })).not.toBeInTheDocument();
      expect(screen.queryByRole("menuitem", { name: `设为默认${opposite}模型` })).not.toBeInTheDocument();
    }
  });

  it("keeps OpenAI connection settings free of the redundant image key form", async () => {
    const official = {
      ...settings,
      chat_providers: [settings.chat_providers![0], {
        name: "openai", label: "OpenAI", configured: false, api_key_required: true,
        api_base: "https://api.openai.com/v1", default_api_base: "https://api.openai.com/v1", models: [],
      }],
    } as SettingsPayload;
    vi.spyOn(developmentApi, "providerExecutors").mockResolvedValue({ executors: [] });
    vi.spyOn(developmentApi, "loginStatus").mockResolvedValue({ loginId: null, state: "idle", authUrl: "", reason: "" });
    render(<ChatProvidersSettings settings={official} token="test-token" onSettingsChanged={vi.fn()} onModelNameChange={vi.fn()} />);

    fireEvent.click(within(screen.getByRole("complementary")).getByRole("button", { name: /OpenAI/ }));
    expect(screen.queryByLabelText("OpenAI 图像生成 API Key")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "保存" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "OpenAI" })).toBeInTheDocument();
    expect(screen.getByText("ChatGPT 订阅 · Codex")).toBeInTheDocument();
    expect(screen.getByText("已选 0 个模型")).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "视频" })).not.toBeInTheDocument();

  });

  it("shows detected ChatGPT models with per-model visibility checkboxes", async () => {
    const official = {
      ...settings,
      chat_providers: [settings.chat_providers![0], {
        name: "openai", label: "OpenAI", configured: false, api_key_required: true,
        api_base: "https://api.openai.com/v1", default_api_base: "https://api.openai.com/v1", models: [],
      }],
    } as SettingsPayload;
    vi.spyOn(developmentApi, "providerExecutors").mockResolvedValue({ executors: [{
      id: "codex", name: "Codex", available: true, reason: "", executable: "codex",
      probe: { state: "ready", reason: "", authentication: "ready", authMode: "chatgpt" },
      models: [{ id: "gpt-6-astra", label: "GPT-6 Astra", contextWindow: 272000 }],
    }] });
    vi.spyOn(developmentApi, "probe").mockResolvedValue({ state: "ready", reason: "", models: ["gpt-6-astra"] });
    vi.spyOn(developmentApi, "loginStatus").mockResolvedValue({ loginId: null, state: "idle", authUrl: "", reason: "" });
    render(<ChatProvidersSettings settings={official} token="test-token" onSettingsChanged={vi.fn()} onModelNameChange={vi.fn()} />);

    fireEvent.click(within(screen.getByRole("complementary")).getByRole("button", { name: /OpenAI/ }));
    const toggle = await screen.findByRole("checkbox", { name: "Codex GPT-6 Astra 在选择器中显示" });
    expect(screen.queryByText("272K")).not.toBeInTheDocument();
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    fireEvent.click(await screen.findByRole("button", { name: "未显示 1" }));
    const hiddenToggle = screen.getByRole("checkbox", { name: "Codex GPT-6 Astra 在选择器中显示" });
    expect(hiddenToggle).not.toBeChecked();
    fireEvent.click(hiddenToggle);
    expect(await screen.findByRole("checkbox", { name: "Codex GPT-6 Astra 在选择器中显示" })).toBeChecked();
  });

  it("keeps API models on Mona and does not expose a per-model engine choice", () => {
    const initial = {
      ...settings,
      chat_providers: [settings.chat_providers![0], {
        name: "custom-relay", label: "自建模型", is_custom: true,
        configured: true, api_key_required: false,
        api_base: "https://relay.example/v1", default_api_base: "https://relay.example/v1",
        models: [{ id: "qwen3.7-plus", name: "千问 3.7-Plus", type: "chat", enabled: true }],
      }],
    } as SettingsPayload;
    render(<ChatProvidersSettings settings={initial} token="test-token" onSettingsChanged={vi.fn()} onModelNameChange={vi.fn()} />);

    fireEvent.click(within(screen.getByRole("complementary")).getByRole("button", { name: /自建模型/ }));
    expect(screen.getByRole("button", { name: "设置 千问 3.7-Plus" })).toBeInTheDocument();
    openModelMenu("千问 3.7-Plus");
    expect(screen.queryByRole("menuitem", { name: /执行引擎/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: /引擎管理/ })).not.toBeInTheDocument();
  });

  it("authenticates the built-in Anthropic source inline through the local Claude Code account", async () => {
    const official = { ...settings, chat_providers: [settings.chat_providers![0], {
      name: "anthropic", label: "Anthropic", configured: true, api_key_required: true,
      api_base: "https://api.anthropic.com", default_api_base: "https://api.anthropic.com",
      models: [{ id: "legacy-api-model", name: "Legacy API Model", enabled: true, type: "chat" }],
    }] } as SettingsPayload;
    let authenticated = false;
    const unauthenticatedProbe: NativeProbe = { state: "detected", reason: "", authentication: "unknown" };
    const authenticatedProbe: NativeProbe = { state: "ready", reason: "已认证", authentication: "ready" };
    const claude = { id: "claude", name: "Claude Code", available: true, programAvailable: true,
      executable: "test/claude", reason: "", models: [], probe: unauthenticatedProbe };
    vi.spyOn(developmentApi, "providerExecutors").mockImplementation(async () => ({ executors: [
      { ...claude, models: authenticated ? [{ id: "claude-sonnet", label: "Claude Sonnet" }] : [],
        probe: authenticated ? authenticatedProbe : unauthenticatedProbe },
    ] }));
    vi.spyOn(developmentApi, "probe").mockImplementation(async () => authenticated ? authenticatedProbe : unauthenticatedProbe);
    vi.spyOn(developmentApi, "engineResources").mockResolvedValue({
      components: [installedNativeResource("claude")], catalogAvailable: true,
    });
    vi.spyOn(developmentApi, "executorSettings").mockResolvedValue(nativeExecutorSettings);
    const loginStatus = vi.spyOn(developmentApi, "loginStatus").mockResolvedValue({ loginId: null, state: "idle", authUrl: "", reason: "" });
    const login = vi.spyOn(developmentApi, "login").mockImplementation(async () => {
      authenticated = true;
      loginStatus.mockResolvedValue({ loginId: "claude-account", state: "succeeded", authUrl: "", reason: "已完成" });
      return { loginId: "claude-account", state: "succeeded", authUrl: "", reason: "已完成" };
    });
    vi.mocked(fetchProviderModels).mockClear();
    render(<ChatProvidersSettings settings={official} token="test-token" onSettingsChanged={vi.fn()} onModelNameChange={vi.fn()} />);
    const source = within(screen.getByRole("complementary")).getByRole("button", { name: /Anthropic/ });
    fireEvent.click(source);
    expect(source).toHaveAttribute("aria-current", "true");
    expect(screen.queryByRole("dialog", { name: "连接 · Anthropic" })).not.toBeInTheDocument();
    const connect = await screen.findByRole("button", { name: "认证 Claude" });
    await waitFor(() => expect(connect).toBeEnabled());
    fireEvent.click(connect);
    await waitFor(() => expect(login).toHaveBeenCalledWith(undefined, "claude"));
    expect(await screen.findByRole("heading", { name: "Claude Code 已准备就绪" })).toBeInTheDocument();
    expect(screen.getByText("已认证")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Claude Code Claude Sonnet 在选择器中显示" })).toBeInTheDocument();
    expect(fetchProviderModels).not.toHaveBeenCalled();
    expect(screen.queryByText("Legacy API Model")).not.toBeInTheDocument();
    expect(screen.queryByText("API Key 接入")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
