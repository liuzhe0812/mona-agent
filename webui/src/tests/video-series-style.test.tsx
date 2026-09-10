import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SeriesStyleEditor } from "@/components/doc/video/style/SeriesStyleEditor";
import type { VideoStyleDraft } from "@/lib/api";
import { ClientProvider } from "@/providers/ClientProvider";

const mocks = vi.hoisted(() => ({
  applyVideoBrandKit: vi.fn(),
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
    mocks.isTauri.mockReturnValue(false);
    mocks.previewVideoStyle.mockResolvedValue({
      ok: true,
      html: '<html><body><div data-template="neon-core">preview</div></body></html>',
    });
    mocks.fetchVideoBrandKits.mockResolvedValue({ brandKits: [] });
  });

  it("uses progressive sections and the production compiler preview", async () => {
    render(
      wrap(<SeriesStyleEditor seriesId="ai-course" initialDraft={draft} />),
    );

    expect(screen.getByText("实时预览")).toBeInTheDocument();
    expect(screen.getByText("与最终场景使用同一个编译器")).toBeInTheDocument();
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
      screen.getByRole("heading", { name: "自定义背景图片" }),
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
      tokens: { colors: { primary: "#2563EB" } },
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
    fireEvent.click(
      await screen.findByRole("button", { name: "应用品牌套件：企业品牌" }),
    );

    await waitFor(() =>
      expect(mocks.applyVideoBrandKit).toHaveBeenCalledWith(
        "tok",
        "ai-course",
        "company-brand",
        1,
      ),
    );
    expect(await screen.findByText(/已锁定 2 项/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "主色常用色 1" })).toBeDisabled();
    const settingsNav = screen.getByRole("navigation", { name: "风格设置" });
    fireEvent.click(
      within(settingsNav).getByRole("button", { name: /文字与组件/ }),
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

    fireEvent.click(
      await screen.findByRole("button", { name: "企业品牌深色背景 Logo" }),
    );

    expect(
      await screen.findByRole("heading", { name: "确认品牌 Logo 使用权" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/logo\.png将复制到项目/)).toBeInTheDocument();
    expect(mocks.uploadVideoBrandLogo).not.toHaveBeenCalled();
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "取消" }),
    );
  });

  it("offers localized presets instead of technical free-form fields", () => {
    render(
      wrap(<SeriesStyleEditor seriesId="ai-course" initialDraft={draft} />),
    );

    const settingsNav = screen.getByRole("navigation", { name: "风格设置" });
    fireEvent.click(
      within(settingsNav).getByRole("button", { name: /动效与字幕/ }),
    );
    const section = screen
      .getByRole("heading", { name: "动效与字幕" })
      .closest("section");
    expect(section).not.toBeNull();
    expect(within(section!).queryByRole("textbox")).not.toBeInTheDocument();
    expect(within(section!).queryByRole("spinbutton")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "入场方式" })).toHaveTextContent(
      "淡入上浮",
    );
    expect(screen.getByRole("button", { name: "强调方式" })).toHaveTextContent(
      "轻微呼吸",
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

    fireEvent.click(screen.getByRole("button", { name: "确认并锁定风格" }));

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

    fireEvent.click(screen.getByRole("button", { name: "确认并锁定风格" }));
    expect(
      screen.getByRole("heading", { name: "创建风格 v2" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/不会影响仍使用 v1 的已完成视频/),
    ).toBeInTheDocument();
    expect(mocks.lockVideoStyle).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "创建 v2" }));
    await waitFor(() => expect(mocks.lockVideoStyle).toHaveBeenCalled());
  });
});
