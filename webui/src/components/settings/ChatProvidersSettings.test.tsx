import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({
  fetchSettings: vi.fn(),
  fetchProviderModels: vi.fn(),
  fetchGitHubCopilotLogin: vi.fn(),
  startGitHubCopilotLogin: vi.fn(),
  cancelGitHubCopilotLogin: vi.fn(),
  updateProviderSettings: vi.fn(),
  updateSettings: vi.fn(),
}));

import { ChatProvidersSettings } from "./ChatProvidersSettings";
import { cancelGitHubCopilotLogin, fetchGitHubCopilotLogin, fetchProviderModels, fetchSettings, startGitHubCopilotLogin, updateProviderSettings, updateSettings } from "@/lib/api";
import { developmentApi, type EngineResource, type ExecutorSettings, type NativeProbe } from "@/lib/development-api";
import * as tauri from "@/lib/tauri";
import { modelKey, useModelPreferences } from "@/components/models/model-sources";
import type { SettingsPayload } from "@/lib/types";

function openModelMenu(name: string) {
  fireEvent.pointerDown(screen.getByRole("button", { name: `设置 ${name}` }), {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
}

function chooseCustomProtocol(label: string) {
  fireEvent.pointerDown(screen.getByRole("button", { name: "协议" }), { button: 0, ctrlKey: false, pointerType: "mouse" });
  fireEvent.click(screen.getByRole("menuitem", { name: label }));
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
    vi.mocked(fetchGitHubCopilotLogin).mockReset().mockResolvedValue({ status: "idle" });
    vi.mocked(startGitHubCopilotLogin).mockReset();
    vi.mocked(cancelGitHubCopilotLogin).mockReset();
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

  it("shows all official models and removes visibility controls even with old hidden settings", async () => {
    const previousHidden = {
      ...settings,
      image_generation: { ...settings.image_generation, providers: [{
        name: "mona_managed", label: "Mona AI", configured: true, image_models: ["official-image"],
      }] },
      chat_providers: settings.chat_providers!.map((provider) => provider.name === "mona_managed"
        ? { ...provider, models: [
          { id: "existing", name: "已有模型", enabled: true },
          { id: "new-official", name: "官方新模型", enabled: false },
        ] }
        : provider),
    } as SettingsPayload;
    vi.mocked(updateSettings).mockResolvedValueOnce(previousHidden);
    render(<ChatProvidersSettings settings={previousHidden} token="test-token" onSettingsChanged={vi.fn()} onModelNameChange={vi.fn()} />);

    expect(screen.getByText("已有模型")).toBeInTheDocument();
    expect(screen.getByText("官方新模型")).toBeInTheDocument();
    expect(screen.getByText("official-image")).toBeInTheDocument();
    expect(screen.getByText("可用模型 3")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /未显示/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();

    openManagementMenu();
    expect(screen.getByRole("menuitemradio", { name: "按品牌分组" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "全部显示" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "全部隐藏" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "重置显示偏好" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "分别调整" }));

    const row = screen.getByRole("button", { name: "设置 官方新模型" }).closest(".group");
    expect(row).not.toBeNull();
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: "设为默认" }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith("test-token", {
      provider: "mona_managed", model: "new-official", providerModel: "new-official",
    }));
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
      model_details: [{ id: "new-model", name: "Reference Name", context_window: 1_000_000, reasoning_efforts: ["high"],
        discovered_metadata: { context_window: 196_608 } }],
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
    expect(vi.mocked(updateProviderSettings).mock.lastCall?.[1].discoveredModels?.find((model) => model.id === "new-model"))
      .toEqual({ id: "new-model", name: "new-model", contextWindow: 196_608 });
  });

  it("lists any unconfigured provider presets returned by the backend", () => {
    const entries = [
      ["lm-studio", "LM Studio"], ["llama-cpp", "llama.cpp"], ["vllm", "vLLM"],
      ["ollama-cloud", "Ollama Cloud"], ["sub2api", "Sub2API"], ["future-provider", "Future Provider"],
    ];
    const available = { ...settings, chat_providers: [settings.chat_providers![0], ...entries.map(([name, label]) => ({
      name, label, configured: false, api_key_required: false, api_base_editable: true,
      api_base: "http://localhost:1234/v1", default_api_base: "http://localhost:1234/v1", models: [],
    }))] } as SettingsPayload;
    render(<ChatProvidersSettings settings={available} token="test-token" onSettingsChanged={vi.fn()} onModelNameChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "添加供应商" }));
    const dialog = screen.getByRole("dialog");
    for (const [, label] of entries) expect(within(dialog).getByRole("button", { name: label })).toBeInTheDocument();
  });

  it.each([
    ["openai", "OpenAI", "https://api.openai.com/v1"],
    ["anthropic", "Anthropic", "https://api.anthropic.com"],
  ])("configures and manages %s API models under the existing source", async (provider, label, base) => {
    const source = { name: provider, label, configured: false, api_key_required: true, api_base_editable: true,
      api_base: base, default_api_base: base, models: [] };
    const initial = { ...settings, chat_providers: [settings.chat_providers![0], source] } as SettingsPayload;
    const saved = { ...initial, chat_providers: [initial.chat_providers![0], { ...source, configured: true, api_key_hint: "test•••key",
      models: [{ id: "api-model", name: "API Model", type: "chat", enabled: true, recommended: false }] }] } as SettingsPayload;
    vi.spyOn(developmentApi, "providerExecutors").mockResolvedValue({ executors: [] });
    vi.mocked(fetchProviderModels).mockReset().mockResolvedValueOnce({ models: ["api-model"], model_details: [{ id: "api-model", name: "API Model", type: "chat" }] });
    vi.mocked(updateProviderSettings).mockReset().mockResolvedValueOnce(saved);
    const onSettingsChanged = vi.fn();
    const view = render(<ChatProvidersSettings settings={initial} token="test-token" onSettingsChanged={onSettingsChanged} onModelNameChange={vi.fn()} />);
    fireEvent.click(within(screen.getByRole("complementary")).getByRole("button", { name: new RegExp(label) }));
    expect(screen.getByText("API 接入")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "配置 API" }));
    fireEvent.change(screen.getByPlaceholderText("请输入 API Key"), { target: { value: "test-api-key" } });
    fireEvent.click(screen.getByRole("button", { name: "拉取模型" }));
    expect(await screen.findByRole("checkbox", { name: "API Model" })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "完成" }));
    await waitFor(() => expect(updateProviderSettings).toHaveBeenLastCalledWith("test-token", expect.objectContaining({
      provider, apiBase: base, apiKey: "test-api-key", enabledModels: ["api-model"],
      discoveredModels: [{ id: "api-model", name: "API Model", type: "chat" }],
    })));
    view.rerender(<ChatProvidersSettings settings={saved} token="test-token" onSettingsChanged={onSettingsChanged} onModelNameChange={vi.fn()} />);
    expect(await screen.findByRole("button", { name: "编辑 API 配置" })).toBeInTheDocument();
    expect(screen.getByText("API 模型")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "API Model 不在对话中显示" })).toBeChecked();
    expect(within(screen.getByRole("complementary")).getByRole("button", { name: new RegExp(label) })).not.toHaveTextContent("待准备");
  });

  it("updates API and subscription model visibility together only after the API save succeeds", async () => {
    const source = { name: "openai", label: "OpenAI", configured: true, api_key_required: true, api_base_editable: true,
      api_base: "https://api.openai.com/v1", default_api_base: "https://api.openai.com/v1",
      models: [{ id: "api-model", name: "API Model", type: "chat", enabled: true, recommended: false }] };
    const configured = { ...settings, chat_providers: [settings.chat_providers![0], source] } as SettingsPayload;
    const codex = { id: "codex", name: "Codex", available: true, executable: "test/codex", reason: "",
      models: [{ id: "native-model", label: "Native Model" }], probe: { state: "ready", authentication: "ready", authMode: "chatgpt", reason: "" } };
    vi.spyOn(developmentApi, "providerExecutors").mockResolvedValue({ executors: [codex] } as Awaited<ReturnType<typeof developmentApi.providerExecutors>>);
    vi.spyOn(developmentApi, "probe").mockResolvedValue(codex.probe as NativeProbe);
    vi.mocked(updateProviderSettings).mockReset().mockRejectedValueOnce(new Error("unavailable")).mockResolvedValueOnce(configured);
    render(<ChatProvidersSettings settings={configured} token="test-token" onSettingsChanged={vi.fn()} onModelNameChange={vi.fn()} />);
    fireEvent.click(within(screen.getByRole("complementary")).getByRole("button", { name: /OpenAI/ }));
    await screen.findByRole("checkbox", { name: "Codex Native Model 在选择器中显示" });
    const nativeKey = modelKey({ provider: "native:codex", model: "native-model", executor: "codex" });
    fireEvent.pointerDown(screen.getByRole("button", { name: "筛选模型" }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: "全部隐藏" }));
    await waitFor(() => expect(updateProviderSettings).toHaveBeenCalledTimes(1));
    expect(useModelPreferences.getState().hiddenNative).not.toContain(nativeKey);
    await screen.findByText("保存失败，请稍后重试。");
    fireEvent.pointerDown(screen.getByRole("button", { name: "筛选模型" }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: "全部隐藏" }));
    await waitFor(() => expect(useModelPreferences.getState().hiddenNative).toContain(nativeKey));
    expect(updateProviderSettings).toHaveBeenLastCalledWith("test-token", { provider: "openai", enabledModels: [] });
  });

  it("labels Azure model input as a deployment name", () => {
    const available = { ...settings, chat_providers: [settings.chat_providers![0], {
      name: "azure-openai-responses", label: "Azure OpenAI", configured: false, api_key_required: true, api_base_editable: true,
      wire_api: "azure-openai-responses", model_discovery_supported: false,
      api_base: "https://{resource}.openai.azure.com/openai/v1", default_api_base: "https://{resource}.openai.azure.com/openai/v1", models: [],
    }] } as SettingsPayload;
    render(<ChatProvidersSettings settings={available} token="test-token" onSettingsChanged={vi.fn()} onModelNameChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "添加供应商" }));
    fireEvent.click(screen.getByRole("button", { name: "Azure OpenAI" }));
    expect(screen.getByText("模型名称请填写 Azure 部署名称。")).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("请输入 API Key"), { target: { value: "test-azure-key" } });
    fireEvent.change(screen.getByLabelText("API Base"), { target: { value: "https://resource.openai.azure.com/openai/v1" } });
    fireEvent.click(screen.getByRole("button", { name: "手动添加模型" }));
    expect(screen.getByText("请使用 Azure 部署名称；目录候选需与部署名称一致。")).toBeInTheDocument();
  });

  it.each(["", "optional-key"])("fetches and enables a local preset model with optional key %s", async (apiKey) => {
    const available = { ...settings, chat_providers: [settings.chat_providers![0], {
      name: "lm-studio", label: "LM Studio", configured: false, api_key_required: false, api_base_editable: true, auth_method: "none",
      api_base: "http://127.0.0.1:1234/v1", default_api_base: "http://127.0.0.1:1234/v1", models: [],
    }] } as SettingsPayload;
    vi.mocked(fetchProviderModels).mockReset().mockResolvedValueOnce({
      models: ["local-model"], model_details: [{ id: "local-model", name: "Local Model", type: "chat", context_window: 32_768 }],
    });
    vi.mocked(updateProviderSettings).mockReset().mockResolvedValueOnce(available);
    render(<ChatProvidersSettings settings={available} token="test-token" onSettingsChanged={vi.fn()} onModelNameChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "添加供应商" }));
    fireEvent.click(screen.getByRole("button", { name: "LM Studio" }));
    const base = screen.getByLabelText("API Base");
    expect(base).toHaveValue("http://127.0.0.1:1234/v1");
    expect(base).not.toHaveAttribute("readonly");
    expect(screen.getByPlaceholderText("可选")).toHaveValue("");
    if (apiKey) fireEvent.change(screen.getByPlaceholderText("可选"), { target: { value: apiKey } });
    fireEvent.click(screen.getByRole("button", { name: "拉取模型" }));
    expect(await screen.findByRole("checkbox", { name: "Local Model" })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "完成" }));

    await waitFor(() => expect(updateProviderSettings).toHaveBeenLastCalledWith("test-token", expect.objectContaining({
      provider: "lm-studio", apiBase: "http://127.0.0.1:1234/v1", enabledModels: ["local-model"],
      discoveredModels: [{ id: "local-model", name: "Local Model", type: "chat", contextWindow: 32_768 }],
    })));
    expect(fetchProviderModels).toHaveBeenCalledWith("test-token", { provider: "lm-studio", apiKey: apiKey || undefined, apiBase: "http://127.0.0.1:1234/v1" });
    if (apiKey) expect(vi.mocked(updateProviderSettings).mock.lastCall?.[1]).toHaveProperty("apiKey", apiKey);
    else expect(vi.mocked(updateProviderSettings).mock.lastCall?.[1]).not.toHaveProperty("apiKey");
  });

  it("requires a concrete preset address before discovery or manual model entry", async () => {
    const available = { ...settings, chat_providers: [settings.chat_providers![0], {
      name: "sub2api", label: "Sub2API", configured: false, api_key_required: true, api_base_editable: true,
      api_base: "https://{endpoint}/v1", default_api_base: "https://{endpoint}/v1", models: [],
    }] } as SettingsPayload;
    vi.mocked(fetchProviderModels).mockReset();
    vi.mocked(updateProviderSettings).mockReset().mockResolvedValueOnce(available);
    render(<ChatProvidersSettings settings={available} token="test-token" onSettingsChanged={vi.fn()} onModelNameChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "添加供应商" }));
    fireEvent.click(screen.getByRole("button", { name: "Sub2API" }));
    const base = screen.getByLabelText("API Base");
    expect(base).toHaveValue("");
    expect(screen.queryByText(/\{endpoint\}/)).not.toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("请输入 API Key"), { target: { value: "test-sub2api-key" } });
    fireEvent.click(screen.getByRole("button", { name: "拉取模型" }));
    expect(base).toHaveAttribute("aria-invalid", "true");
    expect(fetchProviderModels).not.toHaveBeenCalled();
    fireEvent.change(base, { target: { value: "https://relay.example/v1" } });
    fireEvent.click(screen.getByRole("button", { name: "手动添加模型" }));
    fireEvent.change(screen.getByPlaceholderText("手动添加模型 ID（逗号分隔）"), { target: { value: "manual-id" } });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    expect(screen.getByRole("checkbox", { name: "manual-id" })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "完成" }));
    await waitFor(() => expect(updateProviderSettings).toHaveBeenLastCalledWith("test-token", expect.objectContaining({
      provider: "sub2api", apiBase: "https://relay.example/v1", apiKey: "test-sub2api-key", enabledModels: ["manual-id"],
      discoveredModels: [{ id: "manual-id", name: "manual-id", type: "chat" }],
    })));
    expect(fetchProviderModels).not.toHaveBeenCalled();
  });

  it("allows a custom endpoint to add a model without querying the server", async () => {
    vi.mocked(fetchProviderModels).mockReset();
    vi.mocked(updateProviderSettings).mockReset().mockResolvedValueOnce(settings);
    render(<ChatProvidersSettings settings={settings} token="test-token" onSettingsChanged={vi.fn()} onModelNameChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "添加供应商" }));
    fireEvent.click(screen.getByRole("button", { name: /自定义端点/ }));
    fireEvent.change(screen.getByPlaceholderText("例如：我的本地模型"), { target: { value: "本地供应商" } });
    fireEvent.change(screen.getByPlaceholderText("https://example.com/v1"), { target: { value: "http://127.0.0.1:9000/v1" } });
    fireEvent.click(screen.getByRole("button", { name: "手动添加模型" }));
    fireEvent.change(screen.getByPlaceholderText("手动添加模型 ID（逗号分隔）"), { target: { value: "local-id" } });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    fireEvent.click(screen.getByRole("button", { name: "完成" }));
    await waitFor(() => expect(updateProviderSettings).toHaveBeenLastCalledWith("test-token", expect.objectContaining({
      provider: "custom", apiBase: "http://127.0.0.1:9000/v1", enabledModels: ["local-id"],
      discoveredModels: [{ id: "local-id", name: "local-id", type: "chat" }],
    })));
    expect(fetchProviderModels).not.toHaveBeenCalled();
  });

  it.each([
    ["OpenAI Chat Completions", "openai-completions"],
    ["OpenAI Responses", "openai-responses"],
    ["Anthropic Messages", "anthropic-messages"],
  ])("uses %s for custom discovery and saving", async (label, wireApi) => {
    vi.mocked(fetchProviderModels).mockReset().mockResolvedValueOnce({
      models: ["remote-model"], model_details: [{ id: "remote-model", name: "Remote Model", type: "chat" }],
    });
    vi.mocked(updateProviderSettings).mockReset().mockResolvedValueOnce(settings);
    render(<ChatProvidersSettings settings={settings} token="test-token" onSettingsChanged={vi.fn()} onModelNameChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "添加供应商" }));
    fireEvent.click(screen.getByRole("button", { name: /自定义端点/ }));
    fireEvent.change(screen.getByPlaceholderText("例如：我的本地模型"), { target: { value: "本地供应商" } });
    fireEvent.change(screen.getByPlaceholderText("https://example.com/v1"), { target: { value: "https://relay.example/v1" } });
    expect(screen.getByRole("button", { name: "协议" })).toHaveTextContent("自动");
    chooseCustomProtocol(label);
    fireEvent.click(screen.getByRole("button", { name: "拉取模型列表" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Remote Model" }));
    expect(fetchProviderModels).toHaveBeenCalledWith("test-token", {
      provider: "custom", apiKey: undefined, apiBase: "https://relay.example/v1", wireApi,
    });
    fireEvent.click(screen.getByRole("button", { name: "完成" }));
    await waitFor(() => expect(updateProviderSettings).toHaveBeenLastCalledWith("test-token", expect.objectContaining({
      provider: "custom", apiBase: "https://relay.example/v1", wireApi, enabledModels: ["remote-model"],
    })));
  });

  it("clears old capabilities when an existing custom protocol is reset to auto", async () => {
    const configured = { ...settings, chat_providers: [settings.chat_providers![0], {
      name: "custom-relay", label: "本地供应商", is_custom: true, configured: true, api_key_required: false,
      api_base: "https://relay.example/v1", default_api_base: "https://relay.example/v1", wire_api: "openai-responses",
      model_overrides: { "model-a": { context_window: 240_000, reasoning_efforts: ["low", "high"] } },
      models: [{ id: "model-a", name: "Old Model", type: "chat", enabled: true, recommended: false,
        discovered_metadata: { name: "Old Model", type: "chat", context_window: 131_072, reasoning_efforts: ["low", "high"] } }],
    }] } as SettingsPayload;
    vi.mocked(fetchProviderModels).mockReset().mockResolvedValueOnce({ models: ["model-a"], model_details: [] });
    vi.mocked(updateProviderSettings).mockReset().mockResolvedValueOnce(configured);
    render(<ChatProvidersSettings settings={configured} token="test-token" onSettingsChanged={vi.fn()} onModelNameChange={vi.fn()} />);
    fireEvent.click(within(screen.getByRole("complementary")).getByRole("button", { name: /本地供应商/ }));
    fireEvent.click(screen.getByRole("button", { name: "编辑供应商" }));
    expect(screen.getByRole("button", { name: "协议" })).toHaveTextContent("OpenAI Responses");
    chooseCustomProtocol("自动");
    fireEvent.click(screen.getByRole("button", { name: "拉取模型列表" }));
    expect(await screen.findByRole("checkbox", { name: "model-a" })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "model-a 能力设置" }));
    expect(screen.getByRole("textbox", { name: "model-a 上下文窗口" })).toHaveValue("");
    expect(screen.getByRole("textbox", { name: "model-a 支持的思考档位" })).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "完成" }));
    await waitFor(() => expect(updateProviderSettings).toHaveBeenLastCalledWith("test-token", expect.objectContaining({
      provider: "custom-relay", wireApi: "auto", enabledModels: ["model-a"],
      discoveredModels: [{ id: "model-a", name: "model-a", type: "chat" }],
    })));
    expect(vi.mocked(updateProviderSettings).mock.lastCall?.[1]).not.toHaveProperty("modelOverrides");
  });

  it("ignores a late custom discovery response after changing protocol on the same endpoint", async () => {
    let finishOld!: (value: Awaited<ReturnType<typeof fetchProviderModels>>) => void;
    const oldRequest = new Promise<Awaited<ReturnType<typeof fetchProviderModels>>>((resolve) => { finishOld = resolve; });
    vi.mocked(fetchProviderModels).mockReset().mockReturnValueOnce(oldRequest).mockResolvedValueOnce({
      models: ["new-model"], model_details: [{ id: "new-model", name: "New Model", type: "chat", context_window: 32_768 }],
    });
    vi.mocked(updateProviderSettings).mockReset().mockResolvedValueOnce(settings);
    render(<ChatProvidersSettings settings={settings} token="test-token" onSettingsChanged={vi.fn()} onModelNameChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "添加供应商" }));
    fireEvent.click(screen.getByRole("button", { name: /自定义端点/ }));
    fireEvent.change(screen.getByPlaceholderText("例如：我的本地模型"), { target: { value: "本地供应商" } });
    fireEvent.change(screen.getByPlaceholderText("https://example.com/v1"), { target: { value: "https://relay.example/v1" } });
    fireEvent.click(screen.getByRole("button", { name: "拉取模型列表" }));
    chooseCustomProtocol("Anthropic Messages");
    fireEvent.click(screen.getByRole("button", { name: "拉取模型列表" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "New Model" }));
    await act(async () => {
      finishOld({ models: ["old-model"], model_details: [{ id: "old-model", name: "Old Model", type: "chat", context_window: 131_072 }] });
      await oldRequest;
    });
    expect(screen.queryByText("Old Model")).not.toBeInTheDocument();
    expect(vi.mocked(fetchProviderModels).mock.calls.map(([, params]) => params.wireApi)).toEqual(["auto", "anthropic-messages"]);
    fireEvent.click(screen.getByRole("button", { name: "完成" }));
    await waitFor(() => expect(updateProviderSettings).toHaveBeenLastCalledWith("test-token", expect.objectContaining({
      wireApi: "anthropic-messages", enabledModels: ["new-model"],
      discoveredModels: [{ id: "new-model", name: "New Model", type: "chat", contextWindow: 32_768 }],
    })));
  });

  it("refreshes a saved custom source using its configured protocol", async () => {
    const configured = { ...settings, chat_providers: [settings.chat_providers![0], {
      name: "custom-relay", label: "本地供应商", is_custom: true, configured: true, api_key_required: false,
      api_base: "https://relay.example/v1", default_api_base: "https://relay.example/v1", wire_api: "anthropic-messages",
      models: [{ id: "model-a", name: "Model A", type: "chat", enabled: true, recommended: false, discovered_metadata: {} }],
    }] } as SettingsPayload;
    vi.mocked(fetchProviderModels).mockReset().mockResolvedValueOnce({ models: ["model-a"], model_details: [{
      id: "model-a", name: "Reference Name", type: "chat", context_window: 1_000_000, reasoning_efforts: ["high"], discovered_metadata: {},
    }] });
    vi.mocked(updateProviderSettings).mockReset().mockResolvedValueOnce(configured);
    render(<ChatProvidersSettings settings={configured} token="test-token" onSettingsChanged={vi.fn()} onModelNameChange={vi.fn()} />);
    fireEvent.click(within(screen.getByRole("complementary")).getByRole("button", { name: /本地供应商/ }));
    fireEvent.click(screen.getByRole("button", { name: "刷新模型" }));
    await waitFor(() => expect(fetchProviderModels).toHaveBeenCalledWith("test-token", {
      provider: "custom-relay", apiBase: "https://relay.example/v1", wireApi: "anthropic-messages",
    }));
    await waitFor(() => expect(updateProviderSettings).toHaveBeenCalledWith("test-token", expect.objectContaining({
      discoveredModels: [{ id: "model-a", name: "model-a" }],
    })));
  });

  it("keeps enriched model labels visible without saving catalog values as custom discoveries", async () => {
    vi.mocked(fetchProviderModels).mockReset().mockResolvedValueOnce({ models: ["remote-model"], model_details: [{
      id: "remote-model", name: "Reference Name", type: "chat", context_window: 1_000_000, reasoning_efforts: ["low", "high"],
      discovered_metadata: { type: "chat", context_window: 32_768, context_window_max: 65_536 },
    }] });
    vi.mocked(updateProviderSettings).mockReset().mockResolvedValueOnce(settings);
    render(<ChatProvidersSettings settings={settings} token="test-token" onSettingsChanged={vi.fn()} onModelNameChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "添加供应商" }));
    fireEvent.click(screen.getByRole("button", { name: /自定义端点/ }));
    fireEvent.change(screen.getByPlaceholderText("例如：我的本地模型"), { target: { value: "本地供应商" } });
    fireEvent.change(screen.getByPlaceholderText("https://example.com/v1"), { target: { value: "https://relay.example/v1" } });
    fireEvent.click(screen.getByRole("button", { name: "拉取模型列表" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Reference Name" }));
    fireEvent.click(screen.getByRole("button", { name: "完成" }));
    await waitFor(() => expect(updateProviderSettings).toHaveBeenLastCalledWith("test-token", expect.objectContaining({
      discoveredModels: [{ id: "remote-model", name: "remote-model", type: "chat", contextWindow: 32_768, contextWindowMax: 65_536 }],
    })));
  });

  it("does not carry an editable preset's old route metadata to a new endpoint", async () => {
    const configured = { ...settings, chat_providers: [settings.chat_providers![0], {
      name: "vllm", label: "vLLM", configured: true, api_key_required: false, api_base_editable: true,
      api_base: "http://127.0.0.1:8000/v1", default_api_base: "http://127.0.0.1:8000/v1",
      models: [{ id: "model-a", name: "Old Name", type: "chat", enabled: true, recommended: false,
        context_window: 131_072, discovered_metadata: { name: "Old Name", type: "chat", context_window: 131_072, reasoning_efforts: ["high"] } }],
    }] } as SettingsPayload;
    vi.mocked(fetchProviderModels).mockReset().mockResolvedValueOnce({ models: ["model-a"], model_details: [
      { id: "model-a", name: "New Name", type: "chat", context_window: 32_768, reasoning_efforts: ["low", "medium"], default_reasoning_effort: "medium" },
    ] });
    vi.mocked(updateProviderSettings).mockReset().mockResolvedValueOnce(configured);
    render(<ChatProvidersSettings settings={configured} token="test-token" onSettingsChanged={vi.fn()} onModelNameChange={vi.fn()} />);
    fireEvent.click(within(screen.getByRole("complementary")).getByRole("button", { name: /vLLM/ }));
    fireEvent.click(screen.getByRole("button", { name: "编辑供应商" }));
    fireEvent.change(screen.getByLabelText("API Base"), { target: { value: "http://127.0.0.1:9000/v1" } });
    fireEvent.click(screen.getByRole("button", { name: "拉取模型" }));
    expect(await screen.findByRole("checkbox", { name: "New Name" })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "完成" }));
    await waitFor(() => expect(updateProviderSettings).toHaveBeenLastCalledWith("test-token", expect.objectContaining({
      provider: "vllm", apiBase: "http://127.0.0.1:9000/v1", enabledModels: ["model-a"],
      discoveredModels: [{ id: "model-a", name: "New Name", type: "chat", contextWindow: 32_768,
        reasoningEfforts: ["low", "medium"], defaultReasoningEffort: "medium" }],
    })));
  });

  it("ignores a late preset discovery response after its endpoint changes", async () => {
    const available = { ...settings, chat_providers: [settings.chat_providers![0], {
      name: "vllm", label: "vLLM", configured: false, api_key_required: false, api_base_editable: true,
      api_base: "http://127.0.0.1:8000/v1", default_api_base: "http://127.0.0.1:8000/v1", models: [],
    }] } as SettingsPayload;
    let finishOld!: (value: Awaited<ReturnType<typeof fetchProviderModels>>) => void;
    const oldRequest = new Promise<Awaited<ReturnType<typeof fetchProviderModels>>>((resolve) => { finishOld = resolve; });
    vi.mocked(fetchProviderModels).mockReset().mockReturnValueOnce(oldRequest).mockResolvedValueOnce({
      models: ["new-model"], model_details: [{ id: "new-model", name: "New Model", type: "chat" }],
    });
    vi.mocked(updateProviderSettings).mockReset().mockResolvedValueOnce(available);
    render(<ChatProvidersSettings settings={available} token="test-token" onSettingsChanged={vi.fn()} onModelNameChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "添加供应商" }));
    fireEvent.click(screen.getByRole("button", { name: "vLLM" }));
    fireEvent.click(screen.getByRole("button", { name: "拉取模型" }));
    fireEvent.change(screen.getByLabelText("API Base"), { target: { value: "http://127.0.0.1:9000/v1" } });
    fireEvent.click(screen.getByRole("button", { name: "拉取模型" }));
    expect(await screen.findByRole("checkbox", { name: "New Model" })).toBeChecked();
    await act(async () => {
      finishOld({ models: ["old-model"], model_details: [{ id: "old-model", name: "Old Model", type: "chat" }] });
      await oldRequest;
    });
    expect(screen.queryByText("Old Model")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "完成" }));
    await waitFor(() => expect(updateProviderSettings).toHaveBeenLastCalledWith("test-token", expect.objectContaining({
      apiBase: "http://127.0.0.1:9000/v1", enabledModels: ["new-model"],
      discoveredModels: [{ id: "new-model", name: "New Model", type: "chat" }],
    })));
  });

  it("offers offline Bedrock catalog models only after explicit selection", async () => {
    const available = { ...settings, chat_providers: [settings.chat_providers![0], {
      name: "bedrock-us", label: "AWS Bedrock", configured: false, api_key_required: false, api_base_editable: false,
      auth_method: "aws", model_discovery_supported: false,
      api_base: "https://bedrock-runtime.us-east-1.amazonaws.com", default_api_base: "https://bedrock-runtime.us-east-1.amazonaws.com", models: [],
      catalog_candidates: [
        { id: "anthropic.claude-3", name: "Claude", type: "chat", discovered_metadata: {} },
        { id: "amazon.nova", name: "Nova", type: "chat", discovered_metadata: {} },
      ],
    }] } as SettingsPayload;
    vi.mocked(fetchProviderModels).mockReset();
    vi.mocked(updateProviderSettings).mockReset().mockResolvedValueOnce(available);
    render(<ChatProvidersSettings settings={available} token="test-token" onSettingsChanged={vi.fn()} onModelNameChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "添加供应商" }));
    fireEvent.click(screen.getByRole("button", { name: "AWS Bedrock" }));
    expect(screen.getByText("可使用本机 AWS 凭据，也可填写 Bedrock API Key。" )).toBeInTheDocument();
    expect(screen.getByLabelText("Bedrock API Key")).toHaveValue("");
    expect(screen.queryByRole("button", { name: "拉取模型" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "选择模型" }));
    expect(screen.getByText("选择模型；目录候选是否可用取决于账号权限。")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Claude" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Nova" })).not.toBeChecked();
    expect(screen.getByRole("button", { name: "完成" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Claude" }));
    fireEvent.click(screen.getByRole("button", { name: "完成" }));
    await waitFor(() => expect(updateProviderSettings).toHaveBeenLastCalledWith("test-token", expect.objectContaining({
      provider: "bedrock-us", enabledModels: ["anthropic.claude-3"],
      discoveredModels: [{ id: "anthropic.claude-3", name: "anthropic.claude-3", type: "chat" }],
    })));
    expect(fetchProviderModels).not.toHaveBeenCalled();
  });

  it("does not offer model refresh for a provider that cannot discover models", () => {
    const configured = { ...settings, chat_providers: [settings.chat_providers![0], {
      name: "bedrock-us", label: "AWS Bedrock", configured: true, api_key_required: false, api_base_editable: false,
      auth_method: "aws", model_discovery_supported: false,
      api_base: "https://bedrock-runtime.us-east-1.amazonaws.com", default_api_base: "https://bedrock-runtime.us-east-1.amazonaws.com",
      models: [{ id: "anthropic.claude-3", name: "Claude", type: "chat", enabled: true, recommended: false }],
    }] } as SettingsPayload;
    vi.mocked(fetchProviderModels).mockReset();
    render(<ChatProvidersSettings settings={configured} token="test-token" onSettingsChanged={vi.fn()} onModelNameChange={vi.fn()} />);
    fireEvent.click(within(screen.getByRole("complementary")).getByRole("button", { name: /AWS Bedrock/ }));
    expect(screen.queryByRole("button", { name: "刷新模型" })).not.toBeInTheDocument();
    expect(fetchProviderModels).not.toHaveBeenCalled();
  });

  it("explains how to resolve a Bedrock model discovery failure", async () => {
    const available = { ...settings, chat_providers: [settings.chat_providers![0], {
      name: "bedrock-us", label: "AWS Bedrock", configured: false, api_key_required: false, api_base_editable: false,
      auth_method: "aws", model_discovery_supported: true,
      api_base: "https://bedrock-runtime.us-east-1.amazonaws.com", default_api_base: "https://bedrock-runtime.us-east-1.amazonaws.com", models: [],
    }] } as SettingsPayload;
    vi.mocked(fetchProviderModels).mockReset().mockRejectedValueOnce(new Error("internal credentials error"));
    render(<ChatProvidersSettings settings={available} token="test-token" onSettingsChanged={vi.fn()} onModelNameChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "添加供应商" }));
    fireEvent.click(screen.getByRole("button", { name: "AWS Bedrock" }));
    fireEvent.click(screen.getByRole("button", { name: "拉取模型" }));
    expect(await screen.findByText("无法拉取模型，请检查 AWS 凭据、区域和模型权限。")).toBeInTheDocument();
    expect(screen.queryByText("internal credentials error")).not.toBeInTheDocument();
  });

  it.each([
    ["google-adc", "Google Vertex", "使用 Google 应用默认凭据，请填写项目和区域对应的地址。"],
    ["github-copilot", "GitHub Copilot", "使用 GitHub Copilot 账号的设备授权。"],
  ])("does not present ordinary API key authentication for %s", async (authMethod, label, help) => {
    const available = { ...settings, chat_providers: [settings.chat_providers![0], {
      name: authMethod, label, configured: false, api_key_required: false, api_base_editable: true,
      auth_method: authMethod, model_discovery_supported: false, models: [],
      api_base: "https://api.example/v1", default_api_base: "https://api.example/v1",
    }] } as SettingsPayload;
    render(<ChatProvidersSettings settings={available} token="test-token" onSettingsChanged={vi.fn()} onModelNameChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "添加供应商" }));
    fireEvent.click(screen.getByRole("button", { name: label }));
    expect(screen.getByText(help)).toBeInTheDocument();
    expect(screen.queryByLabelText("API Key")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "拉取模型" })).not.toBeInTheDocument();
    if (authMethod === "github-copilot") await waitFor(() => expect(screen.getByRole("button", { name: "登录 GitHub" })).toBeEnabled());
  });

  it("starts GitHub device login only on request and allows model selection after authorization", async () => {
    const available = { ...settings, chat_providers: [settings.chat_providers![0], {
      name: "github-copilot", label: "GitHub Copilot", configured: false, api_key_required: false, api_base_editable: false,
      auth_method: "github-copilot", model_discovery_supported: false,
      api_base: "https://api.githubcopilot.com", default_api_base: "https://api.githubcopilot.com", models: [],
      catalog_candidates: [{ id: "openai/gpt-test", name: "GPT Test", type: "chat", discovered_metadata: {} }],
    }] } as SettingsPayload;
    let resolveStatus!: (value: { status: "authorized" }) => void;
    const pendingStatus = new Promise<{ status: "authorized" }>((resolve) => { resolveStatus = resolve; });
    vi.mocked(fetchGitHubCopilotLogin).mockResolvedValueOnce({ status: "idle" }).mockReturnValueOnce(pendingStatus);
    vi.mocked(startGitHubCopilotLogin).mockResolvedValueOnce({ status: "waiting", user_code: "ABCD-1234", verification_url: "https://github.com/login/device" });
    vi.mocked(updateProviderSettings).mockReset().mockResolvedValueOnce(available);
    const open = vi.spyOn(tauri, "openExternalUrl").mockResolvedValue();
    render(<ChatProvidersSettings settings={available} token="test-token" onSettingsChanged={vi.fn()} onModelNameChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "添加供应商" }));
    fireEvent.click(screen.getByRole("button", { name: "GitHub Copilot" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "登录 GitHub" })).toBeEnabled());
    expect(startGitHubCopilotLogin).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "选择模型" }));
    expect(screen.getByText("请先登录 GitHub。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "登录 GitHub" }));
    expect(await screen.findByText("ABCD-1234")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "打开 GitHub 授权页面" }));
    expect(open).toHaveBeenCalledWith("https://github.com/login/device");
    await waitFor(() => expect(fetchGitHubCopilotLogin).toHaveBeenCalledTimes(2));
    await act(async () => { resolveStatus({ status: "authorized" }); await pendingStatus; });
    expect(await screen.findByText("已登录 GitHub")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "选择模型" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "GPT Test" }));
    fireEvent.click(screen.getByRole("button", { name: "完成" }));
    await waitFor(() => expect(updateProviderSettings).toHaveBeenLastCalledWith("test-token", expect.objectContaining({
      provider: "github-copilot", enabledModels: ["openai/gpt-test"],
      discoveredModels: [{ id: "openai/gpt-test", name: "openai/gpt-test", type: "chat" }],
    })));
    expect(startGitHubCopilotLogin).toHaveBeenCalledTimes(1);
  });

  it("cancels GitHub login explicitly and never opens an untrusted authorization URL", async () => {
    const available = { ...settings, chat_providers: [settings.chat_providers![0], {
      name: "github-copilot", label: "GitHub Copilot", configured: false, api_key_required: false, api_base_editable: false,
      auth_method: "github-copilot", model_discovery_supported: false,
      api_base: "https://api.githubcopilot.com", default_api_base: "https://api.githubcopilot.com", models: [],
    }] } as SettingsPayload;
    let resolveOld!: (value: { status: "waiting" }) => void;
    const pendingStatus = new Promise<{ status: "waiting" }>((resolve) => { resolveOld = resolve; });
    vi.mocked(fetchGitHubCopilotLogin).mockResolvedValueOnce({ status: "idle" }).mockReturnValueOnce(pendingStatus).mockResolvedValue({ status: "idle" });
    vi.mocked(startGitHubCopilotLogin).mockResolvedValueOnce({ status: "waiting", user_code: "ABCD-1234", verification_url: "https://github.com.example/login/device" });
    vi.mocked(cancelGitHubCopilotLogin).mockResolvedValueOnce({ status: "idle" });
    const open = vi.spyOn(tauri, "openExternalUrl").mockResolvedValue();
    render(<ChatProvidersSettings settings={available} token="test-token" onSettingsChanged={vi.fn()} onModelNameChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "添加供应商" }));
    fireEvent.click(screen.getByRole("button", { name: "GitHub Copilot" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "登录 GitHub" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "登录 GitHub" }));
    expect(await screen.findByText("无法识别授权页面，请取消后重试。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "打开 GitHub 授权页面" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "取消登录" }));
    await waitFor(() => expect(cancelGitHubCopilotLogin).toHaveBeenCalledWith("test-token"));
    await act(async () => { resolveOld({ status: "waiting" }); await pendingStatus; });
    await waitFor(() => expect(screen.getByRole("button", { name: "登录 GitHub" })).toBeEnabled());
    expect(screen.queryByText("ABCD-1234")).not.toBeInTheDocument();
    expect(open).not.toHaveBeenCalled();
  });

  it("shows a clear GitHub authorization failure without exposing raw errors", async () => {
    const available = { ...settings, chat_providers: [settings.chat_providers![0], {
      name: "github-copilot", label: "GitHub Copilot", configured: false, api_key_required: false, api_base_editable: false,
      auth_method: "github-copilot", model_discovery_supported: false,
      api_base: "https://api.githubcopilot.com", default_api_base: "https://api.githubcopilot.com", models: [],
    }] } as SettingsPayload;
    vi.mocked(fetchGitHubCopilotLogin).mockResolvedValueOnce({ status: "idle" })
      .mockResolvedValueOnce({ status: "failed", message: "GitHub 授权被拒绝，请重新登录。" });
    vi.mocked(startGitHubCopilotLogin).mockResolvedValueOnce({ status: "starting" });
    render(<ChatProvidersSettings settings={available} token="test-token" onSettingsChanged={vi.fn()} onModelNameChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "添加供应商" }));
    fireEvent.click(screen.getByRole("button", { name: "GitHub Copilot" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "登录 GitHub" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "登录 GitHub" }));
    const dialog = await screen.findByRole("alertdialog", { name: "GitHub 登录操作失败" });
    expect(within(dialog).getByText("GitHub 授权被拒绝，请重新登录。")).toBeInTheDocument();
  });

  it("stops polling GitHub login when leaving the provider step", async () => {
    const available = { ...settings, chat_providers: [settings.chat_providers![0], {
      name: "github-copilot", label: "GitHub Copilot", configured: false, api_key_required: false, api_base_editable: false,
      auth_method: "github-copilot", model_discovery_supported: false,
      api_base: "https://api.githubcopilot.com", default_api_base: "https://api.githubcopilot.com", models: [],
    }] } as SettingsPayload;
    vi.mocked(fetchGitHubCopilotLogin).mockResolvedValue({ status: "waiting", user_code: "ABCD-1234", verification_url: "https://github.com/login/device" });
    const schedule = vi.spyOn(window, "setTimeout");
    const clear = vi.spyOn(window, "clearTimeout");
    render(<ChatProvidersSettings settings={available} token="test-token" onSettingsChanged={vi.fn()} onModelNameChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "添加供应商" }));
    fireEvent.click(screen.getByRole("button", { name: "GitHub Copilot" }));
    await screen.findByText("ABCD-1234");
    const index = schedule.mock.calls.findIndex(([callback, delay]) => typeof callback === "function" && callback.name === "poll" && delay === 1000);
    expect(index).toBeGreaterThanOrEqual(0);
    const timer = schedule.mock.results[index].value;
    fireEvent.click(screen.getByRole("button", { name: "返回" }));
    expect(clear).toHaveBeenCalledWith(timer);
    expect(cancelGitHubCopilotLogin).not.toHaveBeenCalled();
  });

  it("keeps discovered names and capabilities while enabling manually added custom models", async () => {
    vi.mocked(fetchProviderModels).mockReset().mockResolvedValueOnce({
      models: ["remote-model"],
      model_details: [{ id: "remote-model", name: "Friendly Model", type: "chat", context_window: 131_072, context_window_max: 200_000, opaque_model_id: true,
        input_modalities: ["text", "image"], reasoning_efforts: ["low", "high", "max"], default_reasoning_effort: "high" }],
    });
    vi.mocked(updateProviderSettings).mockReset().mockResolvedValueOnce(settings);
    render(<ChatProvidersSettings settings={settings} token="test-token" onSettingsChanged={vi.fn()} onModelNameChange={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "添加供应商" }));
    fireEvent.click(screen.getByRole("button", { name: /自定义端点/ }));
    fireEvent.change(screen.getByPlaceholderText("例如：我的本地模型"), { target: { value: "本地供应商" } });
    fireEvent.change(screen.getByPlaceholderText("https://example.com/v1"), { target: { value: "https://relay.example/v1" } });
    fireEvent.click(screen.getByRole("button", { name: "拉取模型列表" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Friendly Model" }));
    fireEvent.change(screen.getByPlaceholderText("手动添加模型 ID（逗号分隔）"), { target: { value: "manual-model" } });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    expect(screen.getByRole("checkbox", { name: "manual-model" })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "manual-model 能力设置" }));
    fireEvent.change(screen.getByRole("textbox", { name: "manual-model 上下文窗口" }), { target: { value: "240000" } });
    fireEvent.change(screen.getByRole("textbox", { name: "manual-model 支持的思考档位" }), { target: { value: "low, high, max" } });
    fireEvent.change(screen.getByRole("textbox", { name: "manual-model 默认思考档位" }), { target: { value: "high" } });
    fireEvent.click(screen.getByRole("button", { name: "完成" }));

    await waitFor(() => expect(updateProviderSettings).toHaveBeenLastCalledWith("test-token", expect.objectContaining({
      enabledModels: ["remote-model", "manual-model"],
      modelOverrides: { "manual-model": { context_window: 240_000, reasoning_efforts: ["low", "high", "max"], default_reasoning_effort: "high" } },
      discoveredModels: expect.arrayContaining([
        expect.objectContaining({ id: "remote-model", name: "Friendly Model", contextWindow: 131_072, contextWindowMax: 200_000, opaque_model_id: true,
          inputModalities: ["text", "image"], reasoningEfforts: ["low", "high", "max"], defaultReasoningEffort: "high" }),
        { id: "manual-model", name: "manual-model", type: "chat" },
      ]),
    })));
  });

  it("preserves a custom model's known fields and clears an unsupported old default after discovery", async () => {
    const configured = {
      ...settings,
      chat_providers: [settings.chat_providers![0], { name: "custom-relay", label: "本地供应商", is_custom: true,
        configured: true, api_key_required: false, api_base: "https://relay.example/v1", default_api_base: "https://relay.example/v1",
        models: [{ id: "model-one", name: "Known Model", type: "chat", enabled: true, recommended: false,
          context_window: 131_072, reasoning_efforts: ["low", "high"], default_reasoning_effort: "high", supports_adaptive_thinking: true }],
      }],
    } as SettingsPayload;
    vi.mocked(fetchProviderModels).mockReset().mockResolvedValueOnce({
      models: ["model-one"], model_details: [{ id: "model-one", name: "Other Model Name", reasoning_efforts: ["low", "medium"] }],
    });
    vi.mocked(updateProviderSettings).mockReset().mockResolvedValueOnce(configured);
    render(<ChatProvidersSettings settings={configured} token="test-token" onSettingsChanged={vi.fn()} onModelNameChange={vi.fn()} />);

    fireEvent.click(within(screen.getByRole("complementary")).getByRole("button", { name: /本地供应商/ }));
    fireEvent.click(screen.getByRole("button", { name: "编辑供应商" }));
    fireEvent.click(screen.getByRole("button", { name: "拉取模型列表" }));
    expect(await screen.findByRole("checkbox", { name: "Known Model" })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "完成" }));

    await waitFor(() => expect(updateProviderSettings).toHaveBeenLastCalledWith("test-token", expect.objectContaining({
      discoveredModels: [expect.objectContaining({ id: "model-one", name: "Known Model", contextWindow: 131_072,
        reasoningEfforts: ["low", "medium"], defaultReasoningEffort: null, supportsAdaptiveThinking: true })],
    })));
  });

  it("clears only the edited model override without saving resolved values as discoveries", async () => {
    const configured = {
      ...settings,
      chat_providers: [settings.chat_providers![0], { name: "custom-relay", label: "本地供应商", is_custom: true,
        configured: true, api_key_required: false, api_base: "https://relay.example/v1", default_api_base: "https://relay.example/v1",
        model_overrides: { alpha: { context_window: 240_000, reasoning_efforts: ["low", "high"], default_reasoning_effort: "high" },
          beta: { context_window: 180_000 } },
        models: [
          { id: "alpha", name: "Alpha", type: "chat", enabled: true, recommended: false, context_window: 240_000,
            reasoning_efforts: ["low", "high"], default_reasoning_effort: "high", discovered_metadata: {} },
          { id: "beta", name: "Beta", type: "chat", enabled: true, recommended: false, context_window: 180_000,
            discovered_metadata: { name: "Beta Raw", context_window: 100_000, context_window_max: 150_000 } },
        ],
      }],
    } as SettingsPayload;
    vi.mocked(fetchProviderModels).mockReset().mockResolvedValueOnce({ models: ["alpha", "beta"], model_details: [] });
    vi.mocked(updateProviderSettings).mockReset().mockResolvedValueOnce(configured);
    render(<ChatProvidersSettings settings={configured} token="test-token" onSettingsChanged={vi.fn()} onModelNameChange={vi.fn()} />);
    fireEvent.click(within(screen.getByRole("complementary")).getByRole("button", { name: /本地供应商/ }));
    fireEvent.click(screen.getByRole("button", { name: "编辑供应商" }));
    fireEvent.click(screen.getByRole("button", { name: "拉取模型列表" }));
    fireEvent.click(await screen.findByRole("button", { name: "Alpha 能力设置" }));
    expect(screen.getByRole("textbox", { name: "Alpha 上下文窗口" })).toHaveValue("240000");
    fireEvent.click(screen.getByRole("button", { name: "恢复自动识别" }));
    fireEvent.click(screen.getByRole("button", { name: "完成" }));

    await waitFor(() => expect(updateProviderSettings).toHaveBeenLastCalledWith("test-token", expect.objectContaining({
      modelOverrides: { alpha: null },
      discoveredModels: [
        { id: "alpha", name: "alpha" },
        { id: "beta", name: "Beta Raw", contextWindow: 100_000, contextWindowMax: 150_000 },
      ],
    })));
  });

  it.each([
    ["https://old.example/v1", "https://new.example/v2"],
    ["https://old.example/v1?route=a", "https://new.example/v2?route=b"],
    ["https://relay.example/v2", "https://relay.example/v1/../v2"],
  ])("keeps model choices but clears old-route capabilities when the custom endpoint changes from %s to %s", async (oldBase, newBase) => {
    const configured = {
      ...settings,
      chat_providers: [settings.chat_providers![0], { name: "custom-relay", label: "本地供应商", is_custom: true,
        configured: true, api_key_required: false, api_base: oldBase, default_api_base: oldBase,
        model_overrides: { alpha: { context_window: 240_000, reasoning_efforts: ["low", "high"] }, beta: { context_window: 180_000 } },
        models: [
          { id: "alpha", name: "Old Alpha", type: "chat", enabled: true, recommended: false,
            discovered_metadata: { name: "Old Alpha", type: "chat", context_window: 131_072, reasoning_efforts: ["low", "high"] } },
          { id: "beta", name: "Old Beta", type: "image", enabled: false, recommended: false,
            discovered_metadata: { name: "Old Beta", type: "image", context_window: 180_000 } },
        ],
      }],
    } as SettingsPayload;
    vi.mocked(fetchProviderModels).mockReset().mockResolvedValueOnce({
      models: ["alpha", "new-model"], model_details: [
        { id: "alpha", name: "New Alpha", type: "chat", context_window: 32_768, reasoning_efforts: ["medium", "high"], default_reasoning_effort: "medium" },
        { id: "new-model", name: "New Model", type: "chat" },
      ],
    });
    vi.mocked(updateProviderSettings).mockReset().mockResolvedValueOnce(configured);
    render(<ChatProvidersSettings settings={configured} token="test-token" onSettingsChanged={vi.fn()} onModelNameChange={vi.fn()} />);
    fireEvent.click(within(screen.getByRole("complementary")).getByRole("button", { name: /本地供应商/ }));
    fireEvent.click(screen.getByRole("button", { name: "编辑供应商" }));
    fireEvent.change(screen.getByPlaceholderText("https://example.com/v1"), { target: { value: newBase } });
    fireEvent.click(screen.getByRole("button", { name: "拉取模型列表" }));
    expect(await screen.findByRole("checkbox", { name: "New Alpha" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "beta" })).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "New Alpha 能力设置" }));
    expect(screen.getByRole("textbox", { name: "New Alpha 上下文窗口" })).toHaveValue("");
    expect(screen.getByRole("textbox", { name: "New Alpha 支持的思考档位" })).toHaveValue("");
    fireEvent.change(screen.getByRole("textbox", { name: "New Alpha 上下文窗口" }), { target: { value: "65536" } });
    fireEvent.click(screen.getByRole("button", { name: "完成" }));

    await waitFor(() => expect(updateProviderSettings).toHaveBeenLastCalledWith("test-token", expect.objectContaining({
      apiBase: newBase,
      enabledModels: ["alpha"],
      modelOverrides: { alpha: { context_window: 65_536 } },
      discoveredModels: expect.arrayContaining([
        { id: "alpha", name: "New Alpha", type: "chat", contextWindow: 32_768,
          reasoningEfforts: ["medium", "high"], defaultReasoningEffort: "medium" },
        { id: "beta", name: "beta", type: "image" },
        { id: "new-model", name: "New Model", type: "chat" },
      ]),
    })));
  });

  it("retains discovered data and overrides for an equivalent normalized custom endpoint", async () => {
    const configured = {
      ...settings,
      chat_providers: [settings.chat_providers![0], { name: "custom-relay", label: "本地供应商", is_custom: true,
        configured: true, api_key_required: false, api_base: "https://relay.example/v1", default_api_base: "https://relay.example/v1",
        model_overrides: { alpha: { context_window: 240_000 } },
        models: [{ id: "alpha", name: "Alpha", type: "chat", enabled: true, recommended: false,
          discovered_metadata: { name: "Alpha", type: "chat", context_window: 131_072 } }],
      }],
    } as SettingsPayload;
    vi.mocked(fetchProviderModels).mockReset().mockResolvedValueOnce({ models: ["alpha"], model_details: [] });
    vi.mocked(updateProviderSettings).mockReset().mockResolvedValueOnce(configured);
    render(<ChatProvidersSettings settings={configured} token="test-token" onSettingsChanged={vi.fn()} onModelNameChange={vi.fn()} />);
    fireEvent.click(within(screen.getByRole("complementary")).getByRole("button", { name: /本地供应商/ }));
    fireEvent.click(screen.getByRole("button", { name: "编辑供应商" }));
    fireEvent.change(screen.getByPlaceholderText("https://example.com/v1"), { target: { value: "https://RELAY.example:443/v1/" } });
    fireEvent.click(screen.getByRole("button", { name: "拉取模型列表" }));
    fireEvent.click(await screen.findByRole("button", { name: "Alpha 能力设置" }));
    expect(screen.getByRole("textbox", { name: "Alpha 上下文窗口" })).toHaveValue("240000");
    fireEvent.click(screen.getByRole("button", { name: "完成" }));

    await waitFor(() => expect(updateProviderSettings).toHaveBeenLastCalledWith("test-token", expect.objectContaining({
      discoveredModels: [{ id: "alpha", name: "Alpha", type: "chat", contextWindow: 131_072 }],
    })));
    expect(vi.mocked(updateProviderSettings).mock.lastCall?.[1]).not.toHaveProperty("modelOverrides");
  });

  it("ignores a late discovery response for a previous custom endpoint", async () => {
    let finishOld!: (value: Awaited<ReturnType<typeof fetchProviderModels>>) => void;
    const oldRequest = new Promise<Awaited<ReturnType<typeof fetchProviderModels>>>((resolve) => { finishOld = resolve; });
    vi.mocked(fetchProviderModels).mockReset().mockReturnValueOnce(oldRequest).mockResolvedValueOnce({
      models: ["new-model"], model_details: [{ id: "new-model", name: "New Model", type: "chat", context_window: 32_768 }],
    });
    vi.mocked(updateProviderSettings).mockReset().mockResolvedValueOnce(settings);
    render(<ChatProvidersSettings settings={settings} token="test-token" onSettingsChanged={vi.fn()} onModelNameChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "添加供应商" }));
    fireEvent.click(screen.getByRole("button", { name: /自定义端点/ }));
    fireEvent.change(screen.getByPlaceholderText("例如：我的本地模型"), { target: { value: "本地供应商" } });
    const apiBase = screen.getByPlaceholderText("https://example.com/v1");
    fireEvent.change(apiBase, { target: { value: "https://old.example/v1" } });
    fireEvent.click(screen.getByRole("button", { name: "拉取模型列表" }));
    fireEvent.change(apiBase, { target: { value: "https://new.example/v1" } });
    fireEvent.click(screen.getByRole("button", { name: "拉取模型列表" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "New Model" }));
    await act(async () => {
      finishOld({ models: ["old-model"], model_details: [{ id: "old-model", name: "Old Model", type: "chat", context_window: 131_072 }] });
      await oldRequest;
    });
    expect(screen.queryByText("Old Model")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "完成" }));
    await waitFor(() => expect(updateProviderSettings).toHaveBeenLastCalledWith("test-token", expect.objectContaining({
      apiBase: "https://new.example/v1", enabledModels: ["new-model"],
      discoveredModels: [{ id: "new-model", name: "New Model", type: "chat", contextWindow: 32_768 }],
    })));
  });

  it("validates model overrides beside fields and shows backend default errors", async () => {
    vi.mocked(fetchProviderModels).mockReset().mockResolvedValueOnce({ models: [], model_details: [] });
    vi.mocked(updateProviderSettings).mockReset().mockRejectedValueOnce(new Error("模型 manual-model 的默认思考档位必须属于支持列表"));
    render(<ChatProvidersSettings settings={settings} token="test-token" onSettingsChanged={vi.fn()} onModelNameChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "添加供应商" }));
    fireEvent.click(screen.getByRole("button", { name: /自定义端点/ }));
    fireEvent.change(screen.getByPlaceholderText("例如：我的本地模型"), { target: { value: "本地供应商" } });
    fireEvent.change(screen.getByPlaceholderText("https://example.com/v1"), { target: { value: "https://relay.example/v1" } });
    fireEvent.click(screen.getByRole("button", { name: "拉取模型列表" }));
    fireEvent.change(await screen.findByPlaceholderText("手动添加模型 ID（逗号分隔）"), { target: { value: "manual-model" } });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    fireEvent.click(screen.getByRole("button", { name: "manual-model 能力设置" }));
    const window = screen.getByRole("textbox", { name: "manual-model 上下文窗口" });
    fireEvent.change(window, { target: { value: "-1" } });
    expect(window).toHaveAttribute("aria-invalid", "true");
    fireEvent.click(screen.getByRole("button", { name: "完成" }));
    expect(updateProviderSettings).not.toHaveBeenCalled();
    fireEvent.change(window, { target: { value: "" } });
    fireEvent.change(screen.getByRole("textbox", { name: "manual-model 默认思考档位" }), { target: { value: "high" } });
    fireEvent.click(screen.getByRole("button", { name: "完成" }));

    await waitFor(() => expect(updateProviderSettings).toHaveBeenLastCalledWith("test-token", expect.objectContaining({
      modelOverrides: { "manual-model": { default_reasoning_effort: "high" } },
    })));
    expect(await screen.findByText("默认档位必须属于支持列表")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "manual-model 默认思考档位" })).toHaveAttribute("aria-invalid", "true");
    expect(screen.queryByText("保存失败，请检查设置后重试。")).not.toBeInTheDocument();
    vi.mocked(updateProviderSettings).mockResolvedValueOnce(settings);
    fireEvent.click(screen.getByRole("checkbox", { name: "不支持思考强度" }));
    fireEvent.click(screen.getByRole("button", { name: "完成" }));
    await waitFor(() => expect(updateProviderSettings).toHaveBeenLastCalledWith("test-token", expect.objectContaining({
      modelOverrides: { "manual-model": { reasoning_efforts: [] } },
    })));
  });

  it("keeps manually added and discovered models and metadata when fetching a provider again", async () => {
    const unconfigured = {
      ...settings,
      chat_providers: [settings.chat_providers![0], { ...settings.chat_providers![1], configured: false, models: [
        { id: "catalog-only", name: "Catalog Model", enabled: true, recommended: false, context_window: 262_144,
          reasoning_efforts: ["low", "high"], default_reasoning_effort: "high" },
        { id: "overlay-only", name: "Resolved Name", enabled: true, recommended: false, context_window: 1_000_000,
          reasoning_efforts: ["low", "high"], default_reasoning_effort: "high", discovered_metadata: {} },
      ] }],
    } as SettingsPayload;
    vi.mocked(fetchProviderModels).mockReset()
      .mockResolvedValueOnce({ models: ["catalog-only", "new-model"], model_details: [
        { id: "catalog-only", name: "catalog-only", input_modalities: ["text", "image"], reasoning_efforts: ["low", "medium"] },
        { id: "new-model", name: "Discovered Model", type: "chat", context_window: 196_608,
          reasoning_efforts: ["low", "high"], default_reasoning_effort: "high" },
      ] })
      .mockResolvedValueOnce({ models: ["new-model"], model_details: [] });
    vi.mocked(updateProviderSettings).mockReset().mockResolvedValueOnce(settings);
    render(<ChatProvidersSettings settings={unconfigured} token="test-token" onSettingsChanged={vi.fn()} onModelNameChange={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "添加供应商" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "DeepSeek" }));
    fireEvent.change(screen.getByPlaceholderText("请输入 API Key"), { target: { value: "test-key" } });
    fireEvent.click(screen.getByRole("button", { name: "拉取模型" }));
    await screen.findByRole("checkbox", { name: "Discovered Model" });
    fireEvent.change(screen.getByPlaceholderText("手动添加模型 ID（逗号分隔）"), { target: { value: "manual-model" } });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    fireEvent.click(screen.getByRole("button", { name: "返回" }));
    fireEvent.click(screen.getByRole("button", { name: "拉取模型" }));
    expect(await screen.findByRole("checkbox", { name: "manual-model" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Discovered Model" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "完成" }));

    await waitFor(() => expect(updateProviderSettings).toHaveBeenLastCalledWith("test-token", expect.objectContaining({
      enabledModels: expect.arrayContaining(["manual-model"]),
      discoveredModels: expect.arrayContaining([
        expect.objectContaining({ id: "catalog-only", name: "Catalog Model", contextWindow: 262_144,
          inputModalities: ["text", "image"], reasoningEfforts: ["low", "medium"], defaultReasoningEffort: null }),
        expect.objectContaining({ id: "new-model", name: "Discovered Model", contextWindow: 196_608,
          reasoningEfforts: ["low", "high"], defaultReasoningEffort: "high" }),
        expect.objectContaining({ id: "manual-model", type: "chat" }),
      ]),
    })));
    expect(vi.mocked(updateProviderSettings).mock.lastCall?.[1].discoveredModels?.find((model) => model.id === "overlay-only"))
      .toEqual({ id: "overlay-only", name: "overlay-only" });
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
    expect(screen.getByText("Legacy API Model")).toBeInTheDocument();
    expect(screen.getByText("API 接入")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
