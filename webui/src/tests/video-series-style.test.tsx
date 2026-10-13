import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SeriesStyleEditor } from "@/components/doc/video/style/SeriesStyleEditor";
import { CreateVideoSeriesView } from "@/components/doc/video/style/CreateVideoSeriesView";
import { VideoSeriesSelector } from "@/components/doc/video/style/VideoSeriesSelector";
import type { VideoStyleDraft } from "@/lib/api";
import { ClientProvider } from "@/providers/ClientProvider";

const mocks = vi.hoisted(() => ({
  applyVideoBrandKit: vi.fn(),
  createVideoSeries: vi.fn(),
  createVideoBrandKit: vi.fn(),
  fetchVideoBrandKits: vi.fn(async () => ({ brandKits: [] })),
  fetchVideoStyleDraft: vi.fn(),
  saveVideoStyleDraft: vi.fn(),
  validateVideoStyle: vi.fn(),
  lockVideoStyle: vi.fn(),
  lockVideoBrandKit: vi.fn(),
  previewVideoStyle: vi.fn(),
  uploadVideoBackgroundAsset: vi.fn(),
  uploadVideoBrandLogo: vi.fn(),
  buildVideoBackgroundAssetPreviewUrl: vi.fn(() => "http://background"),
  getServicesHttpBase: vi.fn(async () => "http://services"),
  isTauri: vi.fn(() => false),
  openFileDialog: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ ...mocks }));
vi.mock("@/lib/tauri", () => ({ isTauri: () => mocks.isTauri() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => mocks.openFileDialog(...args),
}));

const draft: VideoStyleDraft = {
  schemaVersion: 1,
  seriesId: "ai-course",
  revision: 0,
  mode: "dark",
  tokens: {
    colors: {
      primary: "#6C5CE7",
      secondary: "#00C2A8",
      background: "#0E1016",
      surface: "#171A23",
      textPrimary: "#FFFFFF",
      textSecondary: "#B7BCCB",
      border: "#2B3040",
    },
    typography: { headingFamily: "Noto Sans SC", bodyFamily: "Noto Sans SC" },
    shape: { cardRadius: 20, cardStyle: "outline", density: "standard" },
  },
  components: {
    cover: "cover-split-v1",
    chapter: "chapter-glow-v1",
    content: "content-outline-v1",
    data: "metric-large-number-v1",
    comparison: "comparison-columns-v1",
    process: "process-node-line-v1",
    quote: "quote-terminal-v1",
    outro: "outro-brand-v1",
  },
  motion: {
    intensity: "standard",
    enterPreset: "fade-rise",
    emphasisPreset: "soft-pulse",
    transitionPreset: "cross-fade",
  },
  backgrounds: {
    default: {
      assetPolicy: "fixed",
      fit: "cover",
      focalPoint: { x: 0.5, y: 0.45 },
      overlay: { color: "#0E1016", opacity: 0.56 },
      blur: 0,
      fallback: "#0E1016",
    },
    roles: { content: { assetPolicy: "episode-replaceable" } },
  },
  subtitle: { position: "bottom-center", style: "caption-rail", maxLines: 2 },
  aspectVariants: { "16:9": { enabled: true } },
};

function client() {
  return {
    status: "open" as const,
    defaultChatId: null,
    onStatus: () => () => {},
    onChat: () => () => {},
    onError: () => () => {},
    onSessionUpdate: () => () => {},
    onRuntimeModelUpdate: () => () => {},
    onVideoProjectChanged: () => () => {},
    getRunStartedAt: () => null,
    getGoalState: () => undefined,
    sendMessage: vi.fn(),
    newChat: vi.fn(),
    attach: vi.fn(),
    connect: vi.fn(),
    close: vi.fn(),
    updateUrl: vi.fn(),
  };
}

function wrap(node: React.ReactNode) {
  return (
    <ClientProvider
      client={client() as unknown as import("@/lib/mona-client").MonaClient}
      token="tok"
    >
      {node}
    </ClientProvider>
  );
}

describe("SeriesStyleEditor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.saveVideoStyleDraft.mockReset();
    mocks.isTauri.mockReturnValue(false);
    mocks.previewVideoStyle.mockResolvedValue({
      ok: true,
      html: '<html><body><div data-template="neon-core">preview</div></body></html>',
    });
    mocks.fetchVideoBrandKits.mockResolvedValue({ brandKits: [] });
  });

  it("labels reusable styles in plain language", () => {
    render(
      <VideoSeriesSelector
        labelMode="style"
        series={[
          {
            id: "saved-style",
            name: "培训视频",
            latestStyleVersion: 1,
            episodeCount: 2,
          },
        ]}
        onSelect={vi.fn()}
        onCreate={vi.fn()}
      />,
    );

    expect(screen.getByText("已用于 2 个视频")).toBeInTheDocument();
    expect(screen.getByText("可用于新视频")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新建风格" })).toBeInTheDocument();
  });

  it("uses progressive sections and the production compiler preview", async () => {
    render(
      wrap(<SeriesStyleEditor seriesId="ai-course" initialDraft={draft} />),
    );

    expect(screen.getByText("样式预览")).toBeInTheDocument();
    expect(screen.getByText("预览会随设置更新")).toBeInTheDocument();
    await waitFor(() => expect(mocks.previewVideoStyle).toHaveBeenCalled());
    expect(screen.getByTitle("封面真实预览")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "数据" }));
    await waitFor(() =>
      expect(mocks.previewVideoStyle).toHaveBeenLastCalledWith(
        "tok",
        "ai-course",
        expect.any(Object),
        "data",
        "16:9",
      ),
    );
    const settingsNav = screen.getByRole("navigation", { name: "风格设置" });
    fireEvent.click(within(settingsNav).getByRole("button", { name: /背景/ }));
    expect(
      screen.getByRole("heading", { name: "背景图片" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "选择图片" }),
    ).toBeInTheDocument();
  });

  it("autosaves semantic color changes with revision", async () => {
    mocks.saveVideoStyleDraft.mockResolvedValue({
      ok: true,
      draft: { ...draft, revision: 1 },
    });
    render(
      wrap(<SeriesStyleEditor seriesId="ai-course" initialDraft={draft} />),
    );

    fireEvent.click(screen.getByRole("button", { name: "主色常用色 1" }));

    await waitFor(() => expect(mocks.saveVideoStyleDraft).toHaveBeenCalled(), {
      timeout: 2000,
    });
    expect(mocks.saveVideoStyleDraft.mock.calls[0][2]).toMatchObject({
      revision: 0,
      tokens: { colors: { primary: "#315F9A" } },
    });
  });

  it("applies a reusable brand kit and disables locked brand tokens", async () => {
    mocks.fetchVideoBrandKits.mockResolvedValue({
      brandKits: [
        {
          id: "company-brand",
          name: "企业品牌",
          revision: 0,
          latestVersion: 1,
          tokens: {
            colors: { primary: "#275DFF", secondary: "#00A88F" },
            typography: {
              headingFamily: "Noto Sans SC",
              bodyFamily: "Noto Sans SC",
            },
          },
          brand: { displayName: "MONA" },
          lockedFields: [
            "tokens.colors.primary",
            "tokens.typography.headingFamily",
          ],
          createdAt: "2026-08-28T00:00:00",
          updatedAt: "2026-08-28T00:00:00",
        },
      ],
    });
    mocks.applyVideoBrandKit.mockResolvedValue({
      ok: true,
      draft: {
        ...draft,
        revision: 1,
        tokens: {
          ...draft.tokens,
          colors: { ...draft.tokens?.colors, primary: "#275DFF" },
        },
        brandKit: {
          id: "company-brand",
          version: 1,
          name: "企业品牌",
          lockedFields: [
            "tokens.colors.primary",
            "tokens.typography.headingFamily",
          ],
        },
      },
    });

    render(
      wrap(<SeriesStyleEditor seriesId="ai-course" initialDraft={draft} />),
    );
    fireEvent.click(await screen.findByText("标识与配色（可选）"));
    fireEvent.click(
      await screen.findByRole("button", { name: "应用标识与配色：企业品牌" }),
    );

    await waitFor(() =>
      expect(mocks.applyVideoBrandKit).toHaveBeenCalledWith(
        "tok",
        "ai-course",
        "company-brand",
        1,
      ),
    );
    expect(await screen.findByText(/已固定 2 项设置/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "主色常用色 1" })).toBeDisabled();
    const settingsNav = screen.getByRole("navigation", { name: "风格设置" });
    fireEvent.click(
      within(settingsNav).getByRole("button", { name: /文字/ }),
    );
    expect(screen.getByRole("button", { name: "标题字体" })).toBeDisabled();
  });

  it("opens the rights dialog before importing a brand logo", async () => {
    mocks.isTauri.mockReturnValue(true);
    mocks.openFileDialog.mockResolvedValue("C:\\brand\\logo.png");
    mocks.fetchVideoBrandKits.mockResolvedValue({
      brandKits: [
        {
          id: "company-brand",
          name: "企业品牌",
          revision: 0,
          latestVersion: 1,
          tokens: { colors: {} },
          brand: { displayName: "MONA" },
          lockedFields: [],
          createdAt: "2026-08-28T00:00:00",
          updatedAt: "2026-08-28T00:00:00",
        },
      ],
    });

    render(
      wrap(<SeriesStyleEditor seriesId="ai-course" initialDraft={draft} />),
    );
    fireEvent.click(await screen.findByText("标识与配色（可选）"));

    fireEvent.click(
      await screen.findByRole("button", { name: "企业品牌深色背景标识图片" }),
    );

    expect(
      await screen.findByRole("heading", { name: "确认标识图片使用权" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/logo\.png将复制到项目/)).toBeInTheDocument();
    expect(mocks.uploadVideoBrandLogo).not.toHaveBeenCalled();
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "取消" }),
    );
  });

  it("offers localized presets instead of technical free-form fields", async () => {
    render(
      wrap(<SeriesStyleEditor seriesId="ai-course" initialDraft={draft} />),
    );
    await screen.findByTitle("封面真实预览");

    const settingsNav = screen.getByRole("navigation", { name: "风格设置" });
    fireEvent.click(
      within(settingsNav).getByRole("button", { name: /字幕与动效/ }),
    );
    const section = screen
      .getByRole("heading", { name: "字幕与动效" })
      .closest("section");
    expect(section).not.toBeNull();
    expect(within(section!).queryByRole("textbox")).not.toBeInTheDocument();
    expect(within(section!).queryByRole("spinbutton")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "入场方式" })).toHaveTextContent(
      "淡入上浮",
    );
    expect(screen.getByRole("button", { name: "强调方式" })).toHaveTextContent(
      "淡入强调",
    );
    expect(screen.getByRole("button", { name: "场景切换" })).toHaveTextContent(
      "交叉淡化",
    );
    expect(screen.getByRole("button", { name: "字幕样式" })).toHaveTextContent(
      "底部字幕条",
    );
    expect(screen.queryByDisplayValue("stagger-rise")).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("caption-rail")).not.toBeInTheDocument();
  });

  it("validates then locks an immutable version", async () => {
    const onLocked = vi.fn();
    mocks.validateVideoStyle.mockResolvedValue({
      ok: true,
      valid: true,
      issues: [],
    });
    mocks.lockVideoStyle.mockResolvedValue({
      ok: true,
      version: { ...draft, version: 1 },
    });
    render(
      wrap(
        <SeriesStyleEditor
          seriesId="ai-course"
          initialDraft={draft}
          onLocked={onLocked}
        />,
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "保存风格" }));

    await waitFor(() =>
      expect(onLocked).toHaveBeenCalledWith(
        expect.objectContaining({ version: 1 }),
      ),
    );
    expect(mocks.validateVideoStyle).toHaveBeenCalled();
    expect(mocks.lockVideoStyle).toHaveBeenCalled();
  });

  it("confirms a new version without changing existing videos", async () => {
    mocks.validateVideoStyle.mockResolvedValue({
      ok: true,
      valid: true,
      issues: [],
    });
    mocks.lockVideoStyle.mockResolvedValue({
      ok: true,
      version: { ...draft, version: 2 },
    });
    render(
      wrap(
        <SeriesStyleEditor
          seriesId="ai-course"
          initialDraft={draft}
          currentVersion={1}
        />,
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "保存风格" }));
    expect(
      screen.getByRole("heading", { name: "保存为风格版本 2" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/已经完成的视频保持不变/),
    ).toBeInTheDocument();
    expect(mocks.lockVideoStyle).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "保存版本 2" }));
    await waitFor(() => expect(mocks.lockVideoStyle).toHaveBeenCalled());
  });

  it("waits for the newest draft to save before canceling", async () => {
    let resolveSave!: (value: { ok: boolean; revision: number }) => void;
    mocks.saveVideoStyleDraft.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
    );
    const onCancel = vi.fn();
    render(
      wrap(
        <SeriesStyleEditor
          seriesId="ai-course"
          initialDraft={draft}
          onCancel={onCancel}
        />,
      ),
    );
    await screen.findByTitle("封面真实预览");

    fireEvent.click(screen.getByRole("button", { name: "主色常用色 1" }));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(mocks.saveVideoStyleDraft).toHaveBeenCalledOnce());
    expect(mocks.saveVideoStyleDraft.mock.calls[0][2].revision).toBe(0);
    expect(onCancel).not.toHaveBeenCalled();

    await act(async () => resolveSave({ ok: true, revision: 1 }));
    await waitFor(() => expect(onCancel).toHaveBeenCalledOnce());
  });

  it("blocks cancel after a failed save and does not retry an unknown write", async () => {
    let rejectSave!: (error: Error) => void;
    mocks.saveVideoStyleDraft.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectSave = reject;
        }),
    );
    const onCancel = vi.fn();
    render(
      wrap(
        <SeriesStyleEditor
          seriesId="ai-course"
          initialDraft={draft}
          onCancel={onCancel}
        />,
      ),
    );
    await screen.findByTitle("封面真实预览");

    fireEvent.click(screen.getByRole("button", { name: "主色常用色 1" }));
    await waitFor(() => expect(mocks.saveVideoStyleDraft).toHaveBeenCalledOnce(), {
      timeout: 2500,
    });
    fireEvent.click(screen.getByRole("button", { name: "辅助色常用色 2" }));
    await act(async () => rejectSave(new Error("save timeout")));
    expect(await screen.findByText("save timeout")).toBeInTheDocument();
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "重试保存" })).toBeInTheDocument();
    await act(async () => new Promise((resolve) => setTimeout(resolve, 750)));
    expect(mocks.saveVideoStyleDraft).toHaveBeenCalledOnce();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "取消" }));
    });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("serializes automatic saves and uses the returned revision for later edits", async () => {
    let resolveFirst!: (value: { ok: boolean; revision: number }) => void;
    let resolveSecond!: (value: { ok: boolean; revision: number }) => void;
    mocks.saveVideoStyleDraft
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve;
          }),
      );
    render(
      wrap(<SeriesStyleEditor seriesId="ai-course" initialDraft={draft} />),
    );
    await screen.findByTitle("封面真实预览");

    fireEvent.click(screen.getByRole("button", { name: "主色常用色 1" }));
    await waitFor(() => expect(mocks.saveVideoStyleDraft).toHaveBeenCalledOnce(), {
      timeout: 2500,
    });
    expect(mocks.saveVideoStyleDraft.mock.calls[0][2].revision).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "辅助色常用色 2" }));

    await act(async () => resolveFirst({ ok: true, revision: 1 }));
    await waitFor(() => expect(mocks.saveVideoStyleDraft).toHaveBeenCalledTimes(2));
    expect(mocks.saveVideoStyleDraft.mock.calls[1][2].revision).toBe(1);
    await act(async () => resolveSecond({ ok: true, revision: 2 }));
    await waitFor(() => expect(screen.getByText("已保存")).toBeInTheDocument());
  });

  it("shows each aspect's own enabled state and keeps the series default enabled", async () => {
    render(
      wrap(
        <SeriesStyleEditor
          seriesId="ai-course"
          initialDraft={{
            ...draft,
            aspectVariants: {
              "16:9": { enabled: true },
              "9:16": { enabled: false },
              "1:1": { enabled: false },
            },
          }}
          defaultAspectRatio="9:16"
        />,
      ),
    );
    await screen.findByTitle("封面真实预览");
    fireEvent.click(screen.getByRole("button", { name: /更多设置/ }));

    expect(screen.getByRole("checkbox", { name: "启用横屏" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "启用竖屏" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "启用竖屏" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "启用方形" })).not.toBeChecked();
    expect(screen.getByText("默认，始终启用")).toBeInTheDocument();
  });

  it("offers compiler previews for all eight scene roles", async () => {
    render(
      wrap(<SeriesStyleEditor seriesId="ai-course" initialDraft={draft} />),
    );
    await screen.findByTitle("封面真实预览");

    for (const role of [
      "封面",
      "章节",
      "内容",
      "数据",
      "对比",
      "流程",
      "引用",
      "片尾",
    ]) {
      expect(screen.getByRole("button", { name: role })).toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole("button", { name: "引用" }));
    await waitFor(() =>
      expect(mocks.previewVideoStyle).toHaveBeenLastCalledWith(
        "tok",
        "ai-course",
        expect.any(Object),
        "quote",
        "16:9",
      ),
    );
  });

  it("creates a custom reusable style", async () => {
    const onCreated = vi.fn();
    mocks.createVideoSeries.mockResolvedValue({
      ok: true,
      series: { id: "custom-series" },
      draft: { ...draft, seriesId: "custom-series", baseTemplateId: "custom" },
    });
    render(
      wrap(
        <CreateVideoSeriesView onCancel={vi.fn()} onCreated={onCreated} />,
      ),
    );

    fireEvent.change(await screen.findByPlaceholderText("例如：品牌宣传视频"), {
      target: { value: "自定义课程" },
    });
    fireEvent.click(screen.getByRole("button", { name: /自定义/ }));
    fireEvent.click(screen.getByRole("button", { name: "继续编辑风格" }));

    await waitFor(() =>
      expect(mocks.createVideoSeries).toHaveBeenCalledWith(
        "tok",
        expect.objectContaining({
          name: "自定义课程",
          baseTemplateId: "custom",
          defaultAspectRatio: "16:9",
        }),
      ),
    );
    expect(onCreated).toHaveBeenCalledOnce();
  });

  it("keeps role background edits explicit and mode changes on the series default", async () => {
    const user = userEvent.setup();
    const backgroundDraft: VideoStyleDraft = {
      ...draft,
      backgrounds: {
        default: {
          ...draft.backgrounds?.default,
          assetId: "series-background",
          fit: "cover",
        },
        roles: { content: { assetPolicy: "episode-replaceable" } },
      },
    };
    mocks.saveVideoStyleDraft.mockResolvedValue({ ok: true, revision: 1 });
    render(
      wrap(
        <SeriesStyleEditor
          seriesId="ai-course"
          initialDraft={backgroundDraft}
        />,
      ),
    );
    await screen.findByTitle("封面真实预览");
    const settingsNav = screen.getByRole("navigation", { name: "风格设置" });
    fireEvent.click(within(settingsNav).getByRole("button", { name: /背景/ }));
    await user.click(screen.getByRole("button", { name: "应用到" }));
    await user.click(await screen.findByRole("menuitem", { name: "普通内容" }));
    await user.click(screen.getByRole("button", { name: "图片适配" }));
    await user.click(await screen.findByRole("menuitem", { name: "完整显示" }));

    await waitFor(() => expect(mocks.saveVideoStyleDraft).toHaveBeenCalledOnce(), {
      timeout: 2500,
    });
    await waitFor(() => expect(screen.getByText("已保存")).toBeInTheDocument());
    expect(mocks.saveVideoStyleDraft.mock.calls[0][2].backgrounds?.roles).toEqual(
      { content: { assetPolicy: "episode-replaceable", fit: "contain" } },
    );

    fireEvent.click(within(settingsNav).getByRole("button", { name: /配色/ }));
    fireEvent.click(screen.getByRole("button", { name: "浅色" }));
    await waitFor(() => expect(mocks.saveVideoStyleDraft).toHaveBeenCalledTimes(2), {
      timeout: 2500,
    });
    await waitFor(() => expect(screen.getByText("已保存")).toBeInTheDocument());
    const savedBackgrounds = mocks.saveVideoStyleDraft.mock.calls[1][2].backgrounds;
    expect(savedBackgrounds?.default).toMatchObject({
      assetId: "series-background",
      fit: "cover",
      fallback: "#FFFFFF",
    });
    expect(savedBackgrounds?.roles).toEqual({
      content: { assetPolicy: "episode-replaceable", fit: "contain" },
    });
  });

  it("removes a role image and restores that role to the series default", async () => {
    const user = userEvent.setup();
    const backgroundDraft: VideoStyleDraft = {
      ...draft,
      backgrounds: {
        default: {
          ...draft.backgrounds?.default,
          assetId: "series-background",
        },
        roles: {
          content: {
            assetPolicy: "episode-replaceable",
            fit: "contain",
            assetId: "content-background",
          },
        },
      },
    };
    mocks.saveVideoStyleDraft.mockResolvedValue({ ok: true, revision: 1 });
    render(
      wrap(
        <SeriesStyleEditor
          seriesId="ai-course"
          initialDraft={backgroundDraft}
        />,
      ),
    );
    await screen.findByTitle("封面真实预览");
    const settingsNav = screen.getByRole("navigation", { name: "风格设置" });
    fireEvent.click(within(settingsNav).getByRole("button", { name: /背景/ }));
    await user.click(screen.getByRole("button", { name: "应用到" }));
    await user.click(await screen.findByRole("menuitem", { name: "普通内容" }));

    fireEvent.click(screen.getByRole("button", { name: "移除图片" }));
    await waitFor(() => expect(mocks.saveVideoStyleDraft).toHaveBeenCalledOnce(), {
      timeout: 2500,
    });
    await waitFor(() => expect(screen.getByText("已保存")).toBeInTheDocument());
    expect(
      mocks.saveVideoStyleDraft.mock.calls[0][2].backgrounds?.roles?.content,
    ).toMatchObject({ assetId: null, fit: "contain" });

    fireEvent.click(screen.getByRole("button", { name: "恢复默认" }));
    await waitFor(() => expect(mocks.saveVideoStyleDraft).toHaveBeenCalledTimes(2), {
      timeout: 2500,
    });
    await waitFor(() => expect(screen.getByText("已保存")).toBeInTheDocument());
    expect(mocks.saveVideoStyleDraft.mock.calls[1][2].backgrounds?.roles?.content)
      .toBeNull();
  });
});
