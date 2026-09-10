import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({
  fetchProviderModels: vi.fn(),
  updateProviderSettings: vi.fn(),
  updateSettings: vi.fn(),
}));

import { ChatProvidersSettings } from "./ChatProvidersSettings";
import type { SettingsPayload } from "@/lib/types";

function openModelMenu(name: string) {
  fireEvent.pointerDown(screen.getByRole("button", { name: `设置 ${name}` }), {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
}

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
  it("shows Mona AI as an immutable provider in the existing provider layout", () => {
    const onSelectImageModel = vi.fn();
    const onSelectVideoModel = vi.fn();
    const onOpenImageSettings = vi.fn();
    const onOpenVideoSettings = vi.fn();
    render(
      <ChatProvidersSettings
        settings={settings}
        token="test-token"
        onSettingsChanged={vi.fn()}
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
    expect(screen.getByText(/按实际 Token 从 Mona AI 余额扣费/)).toBeInTheDocument();
    expect(screen.getByText("可用余额")).toBeInTheDocument();
    expect(screen.getAllByText("已配置").length).toBeGreaterThan(0);
    expect(screen.queryByText("已连接")).not.toBeInTheDocument();
    expect(screen.queryByText("我的 API Key")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "编辑供应商" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "删除供应商" })).not.toBeInTheDocument();

    const providerButtons = within(screen.getByRole("complementary")).getAllByRole("button");
    expect(providerButtons[0]).toHaveTextContent("Mona AI");
    expect(providerButtons[0].querySelector("img")).toHaveAttribute("src", "/brand/mona_icon.png");
    expect(providerButtons[1].querySelector("img")).not.toBeNull();

    fireEvent.click(providerButtons[1]);
    expect(screen.getByRole("button", { name: "设置 DeepSeek V4 Flash" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "设置 deepseek-image" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "设置 deepseek-video" })).toHaveLength(1);
    expect(screen.getAllByRole("switch")).toHaveLength(1);
    expect(screen.getAllByText("默认图片")).toHaveLength(1);
    expect(screen.getAllByText("默认视频")).toHaveLength(1);

    openModelMenu("deepseek-video");
    fireEvent.click(screen.getByRole("menuitem", { name: "设为默认图片模型" }));
    expect(onSelectImageModel).toHaveBeenCalledWith("deepseek", "deepseek-video");

    openModelMenu("deepseek-image");
    fireEvent.click(screen.getByRole("menuitem", { name: "图片生成设置" }));
    expect(onOpenImageSettings).toHaveBeenCalledWith("deepseek", "deepseek-image");

    openModelMenu("deepseek-image");
    fireEvent.click(screen.getByRole("menuitem", { name: "设为默认视频模型" }));
    expect(onSelectVideoModel).toHaveBeenCalledWith("deepseek", "deepseek-image");

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

    expect(screen.getByText("服务端尚未开放可用的托管模型")).toBeInTheDocument();
    expect(screen.getByText("服务端暂无可用模型")).toBeInTheDocument();
    expect(screen.getAllByText("未配置").length).toBeGreaterThan(0);
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });

  it("offers one custom model list independently to chat, image, and video", () => {
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
            recommended: false,
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

    const providerButtons = within(screen.getByRole("complementary")).getAllByRole("button");
    fireEvent.click(providerButtons[1]);
    expect(screen.getAllByRole("switch")).toHaveLength(1);
    const qwenSwitch = screen.getByRole("switch", { name: "qwen 不在对话中显示" });
    const qwenDefaultButton = screen.getByRole("button", { name: "设为默认" });
    const qwenRowChildren = [...qwenSwitch.parentElement!.children];
    expect(qwenRowChildren.indexOf(qwenDefaultButton)).toBeLessThan(qwenRowChildren.indexOf(qwenSwitch));
    expect(screen.getAllByRole("button", { name: /^设置 / })).toHaveLength(3);
    expect(screen.queryByRole("button", { name: "设置 qwen" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "设置 songgen" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "设置 world3d" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "设置 misc" })).not.toBeInTheDocument();
    expect(screen.getByText("对话", { exact: true })).toBeInTheDocument();
    expect(screen.getByText("图片", { exact: true })).toBeInTheDocument();
    expect(screen.getByText("视频", { exact: true })).toBeInTheDocument();
    expect(screen.getByText("音频", { exact: true })).toBeInTheDocument();
    expect(screen.getByText("3D", { exact: true })).toBeInTheDocument();
    expect(screen.getAllByText("其他", { exact: true })).toHaveLength(2);
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
    expect(screen.getByRole("menuitem", { name: "设为默认图片模型" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "设为默认视频模型" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "设为默认图片模型" }));
    expect(onSelectImageModel).toHaveBeenCalledWith("custom-relay", "mystery");
    openModelMenu("mystery");
    fireEvent.click(screen.getByRole("menuitem", { name: "设为默认视频模型" }));
    expect(onSelectVideoModel).toHaveBeenCalledWith("custom-relay", "mystery");

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
    const qwenRow = screen.getAllByText("qwen", { exact: true })[0].parentElement!.parentElement!.parentElement!;
    expect(within(qwenRow).getByText("默认图片")).toBeInTheDocument();
    expect(within(qwenRow).getByText("默认视频")).toBeInTheDocument();
    expect(screen.getAllByText("默认图片")).toHaveLength(1);
    expect(screen.getAllByText("默认视频")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "设为默认" })).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("搜索模型"), { target: { value: "h3-video" } });
    expect(screen.getAllByRole("button", { name: /^设置 / })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "设置 h3-video" })).toBeInTheDocument();
  });
});
