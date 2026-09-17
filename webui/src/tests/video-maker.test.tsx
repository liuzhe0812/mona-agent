import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProducingPhase } from "@/components/doc/video/ProducingPhase";
import { StoryboardPhase } from "@/components/doc/video/StoryboardPhase";
import { VideoMakerView } from "@/components/doc/video/VideoMakerView";
import { ClientProvider } from "@/providers/ClientProvider";
import type { VideoScene, VideoSceneWithHtml } from "@/lib/api";
import { useVideoRuntimeDownloadStore } from "@/lib/video-runtime-download-store";

const mocks = vi.hoisted(() => ({
  addVideoScene: vi.fn(),
  archiveVideoProject: vi.fn(),
  buildVideoDownloadUrl: vi.fn(() => "http://download/url"),
  buildVideoPreviewFullUrl: vi.fn(() => "http://preview/full"),
  cancelVideoExport: vi.fn(async () => ({ ok: true, stage: "cancelling" })),
  changeVideoProjectAspect: vi.fn(),
  confirmVideoScene: vi.fn(),
  copyVideoProject: vi.fn(),
  createVideoSeries: vi.fn(),
  createVideoProject: vi.fn(),
  createVideoReview: vi.fn(),
  deleteVideoSeries: vi.fn(),
  deleteVideoProject: vi.fn(),
  deleteVideoScene: vi.fn(),
  downloadVideoRuntime: vi.fn(),
  exportVideoProject: vi.fn(),
  fetchSceneNarrationBytes: vi.fn(async () => null),
  fetchScenePreviewHtml: vi.fn(),
  fetchVideoExportStatus: vi.fn(async () => ({ stage: "idle", progress: 0 })),
  fetchVideoExportPreflight: vi.fn(async () => ({
    ok: true,
    duration: 5,
    fps: 30,
    resolution: [1920, 1080],
    estimatedFrames: 150,
    estimatedOutputBytes: 4_000_000,
    narrationCharacters: 2,
    openReviewCount: 0,
    assetRights: {
      usedAssetCount: 0,
      missingAssetIds: [],
      unconfirmedAssets: [],
      readyForCommercialUse: true,
    },
    billing: {
      monaCredits: 0,
      localRender: true,
      externalProviderBilling: false,
      note: "本地渲染与 Edge 配音不扣 Mona 积分",
    },
  })),
  fetchVideoProject: vi.fn(),
  fetchVideoProjectAssets: vi.fn(async () => ({
    ok: true,
    assets: [],
    unconfirmedCount: 0,
  })),
  fetchVideoProjectVersions: vi.fn(async () => ({ ok: true, versions: [] })),
  fetchVideoBrandKits: vi.fn(async () => ({ brandKits: [] })),
  fetchVideoReviews: vi.fn(async () => ({
    ok: true,
    reviews: [],
    openCount: 0,
  })),
  fetchVideoProjects: vi.fn(async () => ({ projects: [] })),
  fetchVideoProjectsIncludingArchived: vi.fn(async () => ({ projects: [] })),
  fetchVideoRuntimeCheck: vi.fn(async () => ({
    node: { ok: true },
    ffmpeg: { ok: true },
    chrome: { ok: true },
  })),
  fetchVideoSceneTimeline: vi.fn(async () => ({
    ok: true,
    sceneIndex: 1,
    durationMs: 5000,
    subtitleTrack: null,
    motionPlan: null,
  })),
  fetchVideoSeries: vi.fn(async () => ({ series: [] })),
  fetchVideoStyleDraft: vi.fn(),
  saveVideoStyleDraft: vi.fn(),
  validateVideoStyle: vi.fn(),
  lockVideoStyle: vi.fn(),
  previewVideoStyle: vi.fn(async () => ({
    ok: true,
    html: "<html><body>preview</body></html>",
  })),
  uploadVideoBackgroundAsset: vi.fn(),
  deleteVideoBackgroundAsset: vi.fn(),
  buildVideoBackgroundAssetPreviewUrl: vi.fn(() => "http://background/preview"),
  fetchVideoStoryboard: vi.fn(),
  generateSceneHtml: vi.fn(),
  getApiBase: vi.fn(async () => "http://localhost:8765"),
  getServicesHttpBase: vi.fn(async () => "http://localhost:17174"),
  importVideoProjectAsset: vi.fn(),
  lockVideoStoryboard: vi.fn(),
  localizeVideoProject: vi.fn(),
  planVideoProject: vi.fn(),
  regenerateVideoScene: vi.fn(),
  renameVideoProject: vi.fn(),
  reorderVideoScenes: vi.fn(),
  rewriteVideoScene: vi.fn(),
  restoreVideoProjectVersion: vi.fn(async () => ({
    ok: true,
    phase: "producing",
  })),
  resolveVideoReview: vi.fn(),
  saveVideoChatId: vi.fn(),
  startVideoRuntimeDownload: vi.fn(),
  fetchVideoRuntimeDownloadJobs: vi.fn(async () => ({ jobs: [] })),
  updateVideoScene: vi.fn(),
  updateVideoProjectAsset: vi.fn(),
  updateVideoSeries: vi.fn(),
  upgradeVideoProjectStyle: vi.fn(),
  upgradeVideoSeriesProjects: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  ...mocks,
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
      this.name = "ApiError";
    }
  },
}));

vi.mock("@/lib/tauri", () => ({
  downloadMediaUrl: vi.fn(async () => true),
  isTauri: () => false,
  openPathWithSystemApp: vi.fn(async () => {}),
  revealItemInDir: vi.fn(async () => {}),
}));

// DocChatPanel opens its own stream; keep the view tests focused on routing.
vi.mock("@/components/doc/DocChatPanel", () => ({
  DocChatPanel: () => <div data-testid="doc-chat-panel" />,
}));

// happy-dom window is 1024px wide ("medium") which auto-collapses the
// sidebar; force "wide" so history project names render as text.
vi.mock("@/hooks/useBreakpoint", () => ({
  useBreakpoint: () => "wide",
}));

function makeClient() {
  const videoProjectChangedHandlers = new Set<
    (payload: { projectName: string; hint: string }) => void
  >();
  const chatHandlers = new Map<string, Set<(event: unknown) => void>>();
  const runStatusHandlers = new Set<
    (chatId: string, startedAt: number | null) => void
  >();
  return {
    status: "open" as const,
    defaultChatId: null,
    onStatus: () => () => {},
    onChat: (chatId: string, handler: (event: unknown) => void) => {
      let handlers = chatHandlers.get(chatId);
      if (!handlers) {
        handlers = new Set();
        chatHandlers.set(chatId, handlers);
      }
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    onRunStatus: (handler: (chatId: string, startedAt: number | null) => void) => {
      runStatusHandlers.add(handler);
      return () => {
        runStatusHandlers.delete(handler);
      };
    },
    /** Test helper: simulate a chat-scoped inbound frame. */
    __emitChat: (chatId: string, event: unknown) => {
      for (const handler of chatHandlers.get(chatId) ?? []) handler(event);
    },
    /** Test helper: simulate a run-strip status change. */
    __emitRunStatus: (chatId: string, startedAt: number | null) => {
      for (const handler of runStatusHandlers) handler(chatId, startedAt);
    },
    onError: () => () => {},
    onSessionUpdate: () => () => {},
    onRuntimeModelUpdate: () => () => {},
    onVideoProjectChanged: (
      handler: (payload: { projectName: string; hint: string }) => void,
    ) => {
      videoProjectChangedHandlers.add(handler);
      return () => {
        videoProjectChangedHandlers.delete(handler);
      };
    },
    /** Test helper: simulate a server-pushed video_project_changed frame. */
    __emitVideoProjectChanged: (payload: {
      projectName: string;
      hint: string;
    }) => {
      for (const h of videoProjectChangedHandlers) h(payload);
    },
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

type MockClient = ReturnType<typeof makeClient>;

function wrap(children: ReactNode, client?: MockClient) {
  return (
    <ClientProvider
      client={
        (client ??
          makeClient()) as unknown as import("@/lib/mona-client").MonaClient
      }
      token="tok"
    >
      {children}
    </ClientProvider>
  );
}

function scene(index: number, overrides: Partial<VideoScene> = {}): VideoScene {
  return {
    index,
    title: `场景${index}`,
    duration: 5,
    durationRaw: "5s",
    visual: "画面",
    animation: "动画",
    narration: "旁白",
    assets: [],
    ...overrides,
  } as VideoScene;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchVideoSeries.mockResolvedValue({ series: [] });
  mocks.fetchVideoProjects.mockResolvedValue({ projects: [] });
  mocks.fetchVideoProjectsIncludingArchived.mockResolvedValue({ projects: [] });
  mocks.fetchVideoBrandKits.mockResolvedValue({ brandKits: [] });
  mocks.fetchVideoRuntimeCheck.mockResolvedValue({
    node: { ok: true },
    ffmpeg: { ok: true },
    chrome: { ok: true },
  });
  mocks.fetchVideoRuntimeDownloadJobs.mockResolvedValue({ jobs: [] });
  mocks.fetchVideoProjectAssets.mockResolvedValue({
    ok: true,
    assets: [],
    unconfirmedCount: 0,
  });
  localStorage.clear();
  useVideoRuntimeDownloadStore.setState({ jobs: [], error: null });
  // ScenePreviewFrame measures via ResizeObserver; happy-dom lacks it.
  globalThis.ResizeObserver =
    globalThis.ResizeObserver ??
    (class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver);
});

describe("StoryboardPhase", () => {
  it("surfaces a rejected storyboard request with a retry action", async () => {
    const onRetryGeneration = vi.fn();
    mocks.fetchVideoStoryboard.mockResolvedValue({
      ok: true,
      scenes: [],
      storyboardExists: false,
    });

    render(
      wrap(
        <StoryboardPhase
          projectName="proj"
          onLocked={() => {}}
          generationError="视频助手会话未就绪，请重新发送分镜任务。"
          onRetryGeneration={onRetryGeneration}
        />,
      ),
    );

    expect(await screen.findByText("分镜生成未能启动")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重新发送分镜任务" }));
    expect(onRetryGeneration).toHaveBeenCalledOnce();
  });

  it("shows generated motion summary and subtitle timing status", async () => {
    mocks.fetchVideoStoryboard.mockResolvedValue({
      ok: true,
      scenes: [
        scene(1, {
          motionPlanSummary: "标题淡入上浮 → 要点依次出现",
          audioTimingSource: "provider-boundary",
        }),
      ],
      storyboardExists: true,
    });

    render(wrap(<StoryboardPhase projectName="proj" onLocked={() => {}} />));

    expect(
      await screen.findByText("标题淡入上浮 → 要点依次出现"),
    ).toBeInTheDocument();
    expect(screen.getByText("字幕精确同步")).toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText(/GSAP timeline/),
    ).not.toBeInTheDocument();
  });

  it("binds registered assets and exposes unconfirmed commercial rights", async () => {
    mocks.fetchVideoStoryboard.mockResolvedValue({
      ok: true,
      scenes: [scene(1, { assets: [] })],
      storyboardExists: true,
    });
    mocks.fetchVideoProjectAssets.mockResolvedValue({
      ok: true,
      unconfirmedCount: 1,
      assets: [
        {
          id: "asset-reference",
          kind: "image",
          path: "assets/library/asset-reference.png",
          originalName: "产品参考图.png",
          mimeType: "image/png",
          bytes: 1024,
          sha256: "hash",
          sourceType: "user-upload",
          rightsStatus: "unknown",
          commercialUse: false,
          createdAt: "2026-08-28T00:00:00",
          updatedAt: "2026-08-28T00:00:00",
        },
      ],
    });
    mocks.updateVideoScene.mockResolvedValue({ ok: true });

    render(wrap(<StoryboardPhase projectName="proj" onLocked={() => {}} />));
    const assetButton = await screen.findByRole("button", {
      name: /产品参考图.png/,
    });
    expect(screen.getByText("权利待确认")).toBeInTheDocument();
    fireEvent.click(assetButton);

    await waitFor(
      () => {
        expect(mocks.updateVideoScene).toHaveBeenCalledWith("tok", "proj", {
          index: 1,
          assets: ["asset-reference"],
        });
      },
      { timeout: 2000 },
    );
  });

  it("debounces field edits into one merged save request", async () => {
    mocks.fetchVideoStoryboard.mockResolvedValue({
      ok: true,
      scenes: [scene(1, { title: "开场" }), scene(2, { title: "结尾" })],
      storyboardExists: true,
    });
    mocks.updateVideoScene.mockResolvedValue({ ok: true, scene: scene(1) });

    render(wrap(<StoryboardPhase projectName="proj" onLocked={() => {}} />));

    const titleInput = await screen.findByDisplayValue("开场");
    fireEvent.change(titleInput, { target: { value: "新标题一" } });
    fireEvent.change(titleInput, { target: { value: "新标题二" } });

    await waitFor(
      () => expect(mocks.updateVideoScene).toHaveBeenCalledTimes(1),
      { timeout: 3000 },
    );
    expect(mocks.updateVideoScene).toHaveBeenCalledWith("tok", "proj", {
      index: 1,
      title: "新标题二",
    });
    expect(await screen.findByText("已保存")).toBeInTheDocument();
  });

  it("shows save failure and blocks locking until retry succeeds", async () => {
    mocks.fetchVideoStoryboard.mockResolvedValue({
      ok: true,
      scenes: [scene(1), scene(2)],
      storyboardExists: true,
    });
    mocks.updateVideoScene.mockResolvedValue({ ok: false, error: "boom" });

    render(wrap(<StoryboardPhase projectName="proj" onLocked={() => {}} />));

    const titleInput = await screen.findByDisplayValue("场景1");
    fireEvent.change(titleInput, { target: { value: "改动" } });

    expect(await screen.findByText("保存失败")).toBeInTheDocument();
    const lockButton = screen.getByRole("button", {
      name: /确认分镜，进入制作/,
    });
    expect(lockButton).toBeDisabled();
    expect(mocks.lockVideoStoryboard).not.toHaveBeenCalled();
  });

  it("deletes a scene only after confirmation", async () => {
    mocks.fetchVideoStoryboard.mockResolvedValue({
      ok: true,
      scenes: [scene(1, { title: "开场" }), scene(2, { title: "结尾" })],
      storyboardExists: true,
    });
    mocks.deleteVideoScene.mockResolvedValue({
      ok: true,
      scenes: [scene(1, { title: "结尾" })],
    });

    render(wrap(<StoryboardPhase projectName="proj" onLocked={() => {}} />));

    const deleteButton = await screen.findByRole("button", {
      name: "删除场景",
    });
    fireEvent.click(deleteButton);
    fireEvent.click(await screen.findByRole("button", { name: "删除" }));

    await waitFor(() =>
      expect(mocks.deleteVideoScene).toHaveBeenCalledWith("tok", "proj", 1),
    );
  });
});

describe("ProducingPhase", () => {
  function producingScene(
    index: number,
    overrides: Partial<VideoSceneWithHtml> = {},
  ): VideoSceneWithHtml {
    return { ...scene(index), htmlStatus: "pending", ...overrides };
  }

  beforeEach(() => {
    mocks.fetchVideoProject.mockResolvedValue({
      name: "proj",
      resolution: "1920x1080",
      outputStale: false,
      phase: "producing",
    });
  });

  it("disables export until every scene has generated HTML", async () => {
    mocks.fetchVideoStoryboard.mockResolvedValue({
      ok: true,
      scenes: [
        producingScene(1, { htmlStatus: "previewing", htmlMtime: 100 }),
        producingScene(2, { htmlStatus: "pending" }),
      ],
    });
    mocks.fetchScenePreviewHtml.mockResolvedValue({
      html: "<html>scene</html>",
      needsGeneration: false,
    });

    render(wrap(<ProducingPhase projectName="proj" />));

    expect(
      await screen.findByText("场景制作 · 1/2 已生成"),
    ).toBeInTheDocument();
    const exportButton = screen.getByRole("button", { name: /导出视频/ });
    expect(exportButton).toBeDisabled();
    expect(screen.getByText("生成全部场景后可导出（1/2）")).toBeInTheDocument();
  });

  it("switches a series project to a responsive aspect variant", async () => {
    mocks.fetchVideoProject.mockResolvedValue({
      name: "proj",
      resolution: "1920x1080",
      outputStale: false,
      phase: "done",
      seriesId: "series-a",
      seriesName: "商业系列",
      styleVersion: 1,
      aspectVariant: "16:9",
    });
    mocks.fetchVideoStoryboard.mockResolvedValue({
      ok: true,
      scenes: [producingScene(1, { htmlStatus: "pending" })],
    });
    mocks.changeVideoProjectAspect.mockResolvedValue({
      ok: true,
      aspectVariant: "9:16",
      resolution: "1080x1920",
      phase: "producing",
    });
    render(wrap(<ProducingPhase projectName="proj" />));

    fireEvent.click(await screen.findByRole("button", { name: "切换画幅" }));
    fireEvent.click(screen.getByRole("radio", { name: /竖屏/ }));
    fireEvent.click(screen.getByRole("button", { name: "切换并重新制作" }));

    await waitFor(() =>
      expect(mocks.changeVideoProjectAspect).toHaveBeenCalledWith(
        expect.any(String),
        "proj",
        "9:16",
      ),
    );
  });

  it("enables export when all scenes are previewing without confirmation", async () => {
    // P3: scenes only need generated HTML (ready), not per-scene confirmation.
    mocks.fetchVideoStoryboard.mockResolvedValue({
      ok: true,
      scenes: [
        producingScene(1, { htmlStatus: "previewing", htmlMtime: 100 }),
        producingScene(2, { htmlStatus: "previewing", htmlMtime: 200 }),
      ],
    });
    mocks.fetchScenePreviewHtml.mockResolvedValue({
      html: "<html>scene</html>",
      needsGeneration: false,
    });

    render(wrap(<ProducingPhase projectName="proj" />));

    expect(
      await screen.findByText("场景制作 · 2/2 已生成"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /导出视频/ })).toBeEnabled();
    expect(
      screen.getByText("全部场景已生成，可以导出视频"),
    ).toBeInTheDocument();
  });

  it("checks the system browser only when export starts", async () => {
    mocks.fetchVideoRuntimeCheck.mockResolvedValue({
      node: { ok: true },
      ffmpeg: { ok: true },
      chrome: { ok: false },
    });
    mocks.fetchVideoStoryboard.mockResolvedValue({
      ok: true,
      scenes: [producingScene(1, { htmlStatus: "previewing", htmlMtime: 100 })],
    });
    mocks.fetchScenePreviewHtml.mockResolvedValue({
      html: "<html>scene</html>",
      needsGeneration: false,
    });

    render(wrap(<ProducingPhase projectName="proj" />));
    fireEvent.click(await screen.findByRole("button", { name: /导出视频/ }));
    fireEvent.click(screen.getByRole("button", { name: "开始导出" }));

    expect(
      await screen.findByText("请安装系统 Edge 或 Chrome 后再导出"),
    ).toBeInTheDocument();
    expect(mocks.startVideoRuntimeDownload).not.toHaveBeenCalled();
    expect(mocks.exportVideoProject).not.toHaveBeenCalled();
  });

  it("does not render a confirm button on generated scenes", async () => {
    mocks.fetchVideoStoryboard.mockResolvedValue({
      ok: true,
      scenes: [producingScene(1, { htmlStatus: "previewing", htmlMtime: 100 })],
    });
    mocks.fetchScenePreviewHtml.mockResolvedValue({
      html: "<html>scene</html>",
      needsGeneration: false,
    });

    render(wrap(<ProducingPhase projectName="proj" />));

    await screen.findByText("场景制作 · 1/1 已生成");
    expect(
      screen.queryByRole("button", { name: /确认通过/ }),
    ).not.toBeInTheDocument();
  });

  it("plays scene narration together with the visual timeline", async () => {
    const originalCreateObjectUrl = URL.createObjectURL;
    const originalRevokeObjectUrl = URL.revokeObjectURL;
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:scene-narration"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    const play = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockResolvedValue(undefined);
    const pause = vi
      .spyOn(HTMLMediaElement.prototype, "pause")
      .mockImplementation(() => {});
    mocks.fetchSceneNarrationBytes.mockResolvedValue(
      new Blob(["audio"], { type: "audio/mpeg" }),
    );
    mocks.fetchVideoStoryboard.mockResolvedValue({
      ok: true,
      scenes: [producingScene(1, { htmlStatus: "previewing", htmlMtime: 100 })],
    });
    mocks.fetchScenePreviewHtml.mockResolvedValue({
      html: "<html>scene</html>",
      needsGeneration: false,
    });

    render(wrap(<ProducingPhase projectName="proj" />));
    fireEvent.click(await screen.findByRole("button", { name: "精细时间轴" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "播放时间轴" }),
    );

    await waitFor(() => expect(play).toHaveBeenCalled());
    expect(mocks.fetchSceneNarrationBytes).toHaveBeenCalledWith(
      "tok",
      "proj",
      1,
    );

    play.mockRestore();
    pause.mockRestore();
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: originalCreateObjectUrl,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: originalRevokeObjectUrl,
    });
  });
});

describe("VideoMakerView", () => {
  it("routes history projects by phase and shows Chinese phase labels", async () => {
    mocks.fetchVideoProjects.mockResolvedValue({
      projects: [
        {
          name: "新项目",
          createdAt: 1,
          resolution: "1920x1080",
          phase: "storyboard",
          hasVideo: false,
          outputStale: false,
          chatId: null,
        },
        {
          name: "旧项目",
          createdAt: 2,
          resolution: "1920x1080",
          phase: "done",
          hasVideo: true,
          outputStale: true,
          chatId: null,
        },
      ],
    });
    mocks.fetchVideoStoryboard.mockResolvedValue({
      ok: true,
      scenes: [scene(1)],
      storyboardExists: true,
    });
    mocks.fetchVideoProject.mockResolvedValue({
      name: "新项目",
      resolution: "1920x1080",
      outputStale: false,
      phase: "storyboard",
      hasStoryboard: true,
    });

    render(wrap(<VideoMakerView />));

    // 历史项目直接展示在侧边栏列表（无 tab 切换），阶段以中文标签呈现
    expect(await screen.findByText("分镜中")).toBeInTheDocument();
    expect(screen.getByText("已完成")).toBeInTheDocument();
    expect(screen.getByText("内容已变化")).toBeInTheDocument();

    // storyboard-phase project routes to the storyboard editor
    fireEvent.click(screen.getByText("新项目"));
    expect(
      await screen.findByRole("button", { name: /确认分镜，进入制作/ }),
    ).toBeInTheDocument();
  });

  it("keeps the create form always editable", async () => {
    render(wrap(<VideoMakerView />));

    const topicInput = screen.getByPlaceholderText(/描述你想制作的视频内容/);
    expect(topicInput).toBeEnabled();
    fireEvent.change(topicInput, { target: { value: "产品介绍视频" } });
    expect(screen.getByRole("button", { name: "生成制作方案" })).toBeEnabled();
  });

  it("batch upgrades eligible videos in one series after confirmation", async () => {
    mocks.fetchVideoProjects.mockResolvedValue({
      projects: [
        {
          name: "第 01 期",
          createdAt: 2,
          resolution: "1920x1080",
          phase: "done",
          hasVideo: true,
          outputStale: false,
          chatId: null,
          seriesId: "series-a",
          seriesName: "商业系列",
          styleVersion: 1,
          latestSeriesStyleVersion: 2,
          styleUpdateAvailable: true,
        },
        {
          name: "第 02 期",
          createdAt: 1,
          resolution: "1920x1080",
          phase: "done",
          hasVideo: true,
          outputStale: false,
          chatId: null,
          seriesId: "series-a",
          seriesName: "商业系列",
          styleVersion: 1,
          latestSeriesStyleVersion: 2,
          styleUpdateAvailable: true,
        },
      ],
    });
    mocks.upgradeVideoSeriesProjects.mockResolvedValue({
      ok: true,
      styleVersion: 2,
      updatedProjectNames: ["第 01 期", "第 02 期"],
      skipped: [],
    });
    render(wrap(<VideoMakerView />));

    fireEvent.click(await screen.findByRole("button", { name: "全部升级" }));
    expect(
      screen.getByRole("heading", { name: "升级系列历史视频？" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "升级所选视频" }));

    await waitFor(() =>
      expect(mocks.upgradeVideoSeriesProjects).toHaveBeenCalledWith(
        expect.any(String),
        "series-a",
        2,
        ["第 01 期", "第 02 期"],
      ),
    );
  });

  it("searches projects and exposes recoverable archived items", async () => {
    const active = {
      name: "产品发布会",
      createdAt: 2,
      resolution: "1920x1080",
      phase: "done" as const,
      hasVideo: true,
      outputStale: false,
      chatId: null,
    };
    const other = { ...active, name: "内部培训", createdAt: 1 };
    mocks.fetchVideoProjects.mockResolvedValue({ projects: [active, other] });
    mocks.fetchVideoProjectsIncludingArchived.mockResolvedValue({
      projects: [
        active,
        other,
        { ...active, name: "往期复盘", archived: true, createdAt: 0 },
      ],
    });
    render(wrap(<VideoMakerView />));
    expect(await screen.findByText("产品发布会")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: "搜索视频项目" }), {
      target: { value: "培训" },
    });
    expect(screen.getByText("内部培训")).toBeInTheDocument();
    expect(screen.queryByText("产品发布会")).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "搜索视频项目" }), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: "查看已归档项目" }));

    expect(await screen.findByText("往期复盘")).toBeInTheDocument();
    expect(screen.getByText("已归档")).toBeInTheDocument();
  });

  it("uses voice presets without technical identifier inputs", async () => {
    render(wrap(<VideoMakerView />));
    fireEvent.click(screen.getByRole("button", { name: "未启用" }));

    expect(screen.getByRole("button", { name: "配音音色" })).toHaveTextContent(
      "晓伊（女·温柔）",
    );
    expect(
      screen.queryByPlaceholderText("zh-CN-XiaoyiNeural"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText("自定义 TTS Voice ID"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("自定义 ID...")).not.toBeInTheDocument();
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "背景音乐混音方式" }),
      { button: 0 },
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: /轻背景/ }));
    expect(screen.getByText("尚未选择音乐文件")).toBeInTheDocument();
  });

  it("reviews and removes outline items before creating the project", async () => {
    mocks.planVideoProject.mockResolvedValue({
      ok: true,
      plan: {
        schemaVersion: 1,
        contentSummary: "先确认覆盖范围",
        outline: [
          {
            id: "outline-01",
            title: "保留章节",
            goal: "讲清核心内容",
            keyPoints: ["要点一"],
            sourceRefs: [],
            estimatedSeconds: 40,
            role: "content",
          },
          {
            id: "outline-02",
            title: "删除章节",
            goal: "不应进入分镜",
            keyPoints: ["无关内容"],
            sourceRefs: [],
            estimatedSeconds: 30,
            role: "content",
          },
        ],
        estimatedSceneCount: 2,
        estimatedDurationSeconds: 70,
        estimatedAssetCount: 2,
        stages: ["确认方案", "生成分镜", "制作场景", "导出交付"],
        billing: { monaCredits: 0, note: "本地规划" },
      },
    });
    mocks.createVideoProject.mockResolvedValue({
      ok: false,
      error: "测试结束",
    });
    render(wrap(<VideoMakerView />));
    fireEvent.change(screen.getByPlaceholderText(/描述你想制作的视频内容/), {
      target: { value: "产品介绍" },
    });

    fireEvent.click(screen.getByRole("button", { name: "生成制作方案" }));
    expect(await screen.findByText("制作方案待确认")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "删除大纲：删除章节" }));
    expect(screen.queryByText("删除章节")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认方案并生成分镜" }));

    await waitFor(() =>
      expect(mocks.createVideoProject).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        "1920x1080",
        expect.objectContaining({
          plan: expect.objectContaining({
            outline: [expect.objectContaining({ title: "保留章节" })],
          }),
        }),
      ),
    );
  });

  it("selects a locked series and inherits its aspect ratio", async () => {
    mocks.fetchVideoSeries.mockResolvedValue({
      series: [
        {
          id: "ai-course",
          name: "AI 编程实战课",
          latestStyleVersion: 1,
          defaultAspectRatio: "9:16",
          episodeCount: 2,
          styleSummary: { name: "科技深色", primaryColor: "#2563EB" },
        },
      ],
    });

    render(wrap(<VideoMakerView />));
    fireEvent.click(screen.getByRole("button", { name: "系列视频" }));
    fireEvent.click(
      await screen.findByRole("button", { name: /^AI 编程实战课/ }),
    );

    expect(screen.getByText("科技深色 · v1")).toBeInTheDocument();
    expect(screen.getByText("继承系列")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "竖屏" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const topicInput = screen.getByPlaceholderText(/描述你想制作的视频内容/);
    fireEvent.change(topicInput, { target: { value: "第 03 期" } });
    expect(screen.getByRole("button", { name: "生成制作方案" })).toBeEnabled();
  });

  it("opens the in-context create-series flow", async () => {
    render(wrap(<VideoMakerView />));
    fireEvent.click(screen.getByRole("button", { name: "系列视频" }));
    fireEvent.click(await screen.findByRole("button", { name: "创建新系列" }));

    expect(
      screen.getByRole("heading", { name: "创建系列" }),
    ).toBeInTheDocument();
    expect(screen.getByText("选择基础风格")).toBeInTheDocument();
    expect(screen.getByAltText("霓虹智核真实编译预览")).toBeInTheDocument();
    expect(screen.getByAltText("山河新章真实编译预览")).toBeInTheDocument();
    expect(screen.getByAltText("奇想实验室真实编译预览")).toBeInTheDocument();
    expect(screen.getByAltText("时代切片真实编译预览")).toBeInTheDocument();
    expect(screen.queryByText("极简商务")).not.toBeInTheDocument();
    expect(screen.queryByText("配置主题")).not.toBeInTheDocument();
  });

  it("binds the latest brand version during series creation", async () => {
    mocks.fetchVideoBrandKits.mockResolvedValue({
      brandKits: [
        {
          id: "company-brand",
          name: "企业品牌",
          revision: 0,
          latestVersion: 3,
          tokens: {},
          brand: { displayName: "MONA" },
          lockedFields: [],
          createdAt: "2026-08-28",
          updatedAt: "2026-08-28",
        },
      ],
    });
    mocks.createVideoSeries.mockResolvedValue({
      ok: false,
      error: "测试结束",
    });
    render(wrap(<VideoMakerView />));
    fireEvent.click(screen.getByRole("button", { name: "系列视频" }));
    fireEvent.click(await screen.findByRole("button", { name: "创建新系列" }));

    fireEvent.change(screen.getByPlaceholderText("例如：AI 编程实战课"), {
      target: { value: "品牌系列" },
    });
    fireEvent.click(await screen.findByRole("button", { name: /企业品牌/ }));
    fireEvent.click(screen.getByRole("button", { name: "下一步：编辑风格" }));

    await waitFor(() =>
      expect(mocks.createVideoSeries).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          name: "品牌系列",
          brandKitId: "company-brand",
          brandKitVersion: 3,
        }),
      ),
    );
  });

  it("deletes a series only after confirmation", async () => {
    const disposableSeries = {
      id: "draft-series",
      name: "待删除系列",
      latestStyleVersion: 0,
      defaultAspectRatio: "16:9" as const,
      episodeCount: 0,
    };
    mocks.fetchVideoSeries
      .mockResolvedValueOnce({ series: [disposableSeries] })
      .mockResolvedValue({ series: [] });
    mocks.deleteVideoSeries.mockResolvedValue({
      ok: true,
      deletedSeriesId: disposableSeries.id,
      detachedEpisodeCount: 0,
    });

    render(wrap(<VideoMakerView />));
    fireEvent.click(screen.getByRole("button", { name: "系列视频" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "删除系列 待删除系列" }),
    );

    expect(
      screen.getByRole("heading", { name: /删除系列“待删除系列”/ }),
    ).toBeInTheDocument();
    expect(mocks.deleteVideoSeries).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "删除系列", exact: true }),
    );

    await waitFor(() =>
      expect(mocks.deleteVideoSeries).toHaveBeenCalledWith(
        "tok",
        disposableSeries.id,
        false,
      ),
    );
  });

  it("renames and archives a series without deleting its videos", async () => {
    const editableSeries = {
      id: "editable-series",
      name: "旧系列名",
      latestStyleVersion: 1,
      defaultAspectRatio: "16:9" as const,
      episodeCount: 2,
    };
    mocks.fetchVideoSeries.mockResolvedValue({ series: [editableSeries] });
    mocks.updateVideoSeries.mockResolvedValue({
      ok: true,
      series: { ...editableSeries, name: "新系列名" },
    });
    render(wrap(<VideoMakerView />));
    fireEvent.click(screen.getByRole("button", { name: "系列视频" }));

    fireEvent.click(
      await screen.findByRole("button", { name: "重命名系列 旧系列名" }),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "系列新名称" }), {
      target: { value: "新系列名" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存名称" }));
    await waitFor(() =>
      expect(mocks.updateVideoSeries).toHaveBeenCalledWith(
        expect.any(String),
        "editable-series",
        { name: "新系列名" },
      ),
    );

    mocks.updateVideoSeries.mockResolvedValue({
      ok: true,
      series: { ...editableSeries, archivedAt: "2026-08-28" },
    });
    fireEvent.click(screen.getByRole("button", { name: "归档系列 旧系列名" }));
    await waitFor(() =>
      expect(mocks.updateVideoSeries).toHaveBeenCalledWith(
        expect.any(String),
        "editable-series",
        { archived: true },
      ),
    );
  });

  it("does not check or download runtime dependencies while creating a video", async () => {
    mocks.fetchVideoRuntimeCheck.mockResolvedValue({
      node: { ok: false },
      ffmpeg: { ok: false },
      chrome: { ok: false },
    });

    render(wrap(<VideoMakerView />));

    expect(
      screen.queryByText("视频依赖未安装，点击此处下载"),
    ).not.toBeInTheDocument();
    expect(mocks.fetchVideoRuntimeCheck).not.toHaveBeenCalled();
    expect(mocks.startVideoRuntimeDownload).not.toHaveBeenCalled();
  });

  it("collapses and expands the sidebar like the PPT module", async () => {
    mocks.fetchVideoProjects.mockResolvedValue({
      projects: [
        {
          name: "新项目",
          createdAt: 1,
          resolution: "1920x1080",
          phase: "storyboard",
          hasVideo: false,
          outputStale: false,
          chatId: null,
        },
      ],
    });

    render(wrap(<VideoMakerView />));

    // 展开态：项目名可见
    expect(await screen.findByText("新项目")).toBeInTheDocument();

    // 收起：项目名让位给图标 rail
    fireEvent.click(screen.getByRole("button", { name: "收起侧栏" }));
    expect(screen.queryByText("新项目")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "展开侧栏" }),
    ).toBeInTheDocument();

    // 再展开：项目名恢复
    fireEvent.click(screen.getByRole("button", { name: "展开侧栏" }));
    expect(await screen.findByText("新项目")).toBeInTheDocument();
  });

  it("returns to the config form via 新建视频 after opening a project", async () => {
    mocks.fetchVideoProjects.mockResolvedValue({
      projects: [
        {
          name: "新项目",
          createdAt: 1,
          resolution: "1920x1080",
          phase: "storyboard",
          hasVideo: false,
          outputStale: false,
          chatId: null,
        },
      ],
    });
    mocks.fetchVideoStoryboard.mockResolvedValue({
      ok: true,
      scenes: [scene(1)],
      storyboardExists: true,
    });
    mocks.fetchVideoProject.mockResolvedValue({
      name: "新项目",
      resolution: "1920x1080",
      outputStale: false,
      phase: "storyboard",
      hasStoryboard: true,
    });

    render(wrap(<VideoMakerView />));

    fireEvent.click(await screen.findByText("新项目"));
    expect(
      await screen.findByRole("button", { name: /确认分镜，进入制作/ }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /新建视频/ }));
    expect(
      await screen.findByPlaceholderText(/描述你想制作的视频内容/),
    ).toBeEnabled();
  });

  it("surfaces a chat-scoped rejection and resends the storyboard brief", async () => {
    const client = makeClient();
    mocks.fetchVideoProjects.mockResolvedValue({
      projects: [
        {
          name: "卡住的项目",
          createdAt: 1,
          resolution: "1920x1080",
          phase: "storyboard",
          hasVideo: false,
          outputStale: false,
          chatId: "chat-video",
        },
      ],
    });
    mocks.fetchVideoStoryboard.mockResolvedValue({
      ok: true,
      scenes: [],
      storyboardExists: false,
    });
    mocks.fetchVideoProject.mockResolvedValue({
      name: "卡住的项目",
      resolution: "1920x1080",
      outputStale: false,
      phase: "storyboard",
      hasStoryboard: false,
    });

    render(wrap(<VideoMakerView />, client));

    // 打开项目 → 进入分镜阶段，此时界面仍是没有场景的加载态
    fireEvent.click(await screen.findByText("卡住的项目"));
    expect(
      await screen.findByText("AI 正在生成分镜草稿..."),
    ).toBeInTheDocument();

    // 网关拒绝视频 turn → 错误帧到达该会话 → 界面给出可操作的失败态
    act(() => {
      client.__emitChat("chat-video", {
        event: "error",
        chat_id: "chat-video",
        detail: "invalid_agent_kind_context",
      });
    });

    expect(await screen.findByText("分镜生成未能启动")).toBeInTheDocument();
    expect(
      screen.getByText("视频助手会话未就绪，请重新发送分镜任务。"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "重新发送分镜任务" }));

    expect(client.sendMessage).toHaveBeenCalledWith(
      "chat-video",
      expect.stringContaining("卡住的项目"),
      undefined,
      expect.objectContaining({ agentKind: "video", displayContent: "重新生成分镜" }),
    );
  });

  it("switches between storyboard and producing views via the step bar", async () => {
    mocks.fetchVideoProjects.mockResolvedValue({
      projects: [
        {
          name: "制作中项目",
          createdAt: 1,
          resolution: "1920x1080",
          phase: "producing",
          hasVideo: false,
          outputStale: false,
          chatId: null,
        },
      ],
    });
    mocks.fetchVideoStoryboard.mockResolvedValue({
      ok: true,
      scenes: [scene(1, { title: "开场" })],
      storyboardExists: true,
    });
    mocks.fetchVideoProject.mockResolvedValue({
      name: "制作中项目",
      resolution: "1920x1080",
      outputStale: false,
      phase: "producing",
    });
    mocks.fetchScenePreviewHtml.mockResolvedValue({
      html: "<html>scene</html>",
      needsGeneration: false,
    });

    render(wrap(<VideoMakerView />));
    fireEvent.click(await screen.findByText("制作中项目"));

    // producing 阶段 → 初始进入制作视图
    expect(await screen.findByText(/场景制作 ·/)).toBeInTheDocument();

    // 步骤条回退到「编辑分镜」：已锁定项目显示「返回制作」，不再重复锁定
    fireEvent.click(screen.getByRole("button", { name: "切换到编辑分镜" }));
    expect(
      await screen.findByRole("button", { name: "返回制作" }),
    ).toBeInTheDocument();
    expect(mocks.lockVideoStoryboard).not.toHaveBeenCalled();

    // 点击「返回制作」切回制作视图（不调用锁定 API，phase 不回退）
    fireEvent.click(screen.getByRole("button", { name: "返回制作" }));
    expect(await screen.findByText(/场景制作 ·/)).toBeInTheDocument();
    expect(mocks.lockVideoStoryboard).not.toHaveBeenCalled();

    // 步骤条「导出交付」与制作场景同视图
    fireEvent.click(screen.getByRole("button", { name: "切换到编辑分镜" }));
    expect(
      await screen.findByRole("button", { name: "返回制作" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "切换到导出交付" }));
    expect(await screen.findByText(/场景制作 ·/)).toBeInTheDocument();
  });

  it("keeps forward steps disabled until the storyboard is locked", async () => {
    mocks.fetchVideoProjects.mockResolvedValue({
      projects: [
        {
          name: "分镜项目",
          createdAt: 1,
          resolution: "1920x1080",
          phase: "storyboard",
          hasVideo: false,
          outputStale: false,
          chatId: null,
        },
      ],
    });
    mocks.fetchVideoStoryboard.mockResolvedValue({
      ok: true,
      scenes: [scene(1)],
      storyboardExists: true,
    });
    mocks.fetchVideoProject.mockResolvedValue({
      name: "分镜项目",
      resolution: "1920x1080",
      outputStale: false,
      phase: "storyboard",
      hasStoryboard: true,
    });

    render(wrap(<VideoMakerView />));
    fireEvent.click(await screen.findByText("分镜项目"));

    expect(
      await screen.findByRole("button", { name: /确认分镜，进入制作/ }),
    ).toBeInTheDocument();
    // 未锁定前：制作场景 / 导出交付 步骤不可点击，防止跳过确认流程
    expect(
      screen.getByRole("button", { name: "切换到制作场景" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "切换到导出交付" }),
    ).toBeDisabled();
    // 配置主题不提供点击回退（新建按钮已覆盖该语义）
    expect(screen.getByRole("button", { name: "配置主题" })).toBeDisabled();
  });
});

describe("video_project_changed events (WS push replaces polling)", () => {
  it("ProducingPhase refreshes export status when a status event arrives", async () => {
    const client = makeClient();
    mocks.fetchVideoProject.mockResolvedValue({
      name: "proj",
      resolution: "1920x1080",
      outputStale: false,
      phase: "producing",
    });
    mocks.fetchVideoStoryboard.mockResolvedValue({
      ok: true,
      scenes: [
        {
          ...scene(1),
          htmlStatus: "confirmed",
          htmlMtime: 100,
          confirmedMtime: 100,
        },
      ],
    });
    mocks.fetchScenePreviewHtml.mockResolvedValue({
      html: "<html>scene</html>",
      needsGeneration: false,
    });
    mocks.fetchVideoExportStatus.mockResolvedValue({
      stage: "idle",
      progress: 0,
    });

    render(wrap(<ProducingPhase projectName="proj" />, client));

    // 初始：未导出，显示导出按钮
    expect(
      await screen.findByRole("button", { name: /导出视频/ }),
    ).toBeInTheDocument();

    // 服务端渲染完成 → WS 推送 status 事件 → 面板切换为可下载状态
    mocks.fetchVideoExportStatus.mockResolvedValue({
      stage: "done",
      progress: 100,
      hasVideo: true,
      deliveryArtifacts: {
        package: "renders/delivery.zip",
        srt: "renders/subtitles.srt",
      },
      qualityStatus: "passed",
    });
    act(() => {
      client.__emitVideoProjectChanged({ projectName: "proj", hint: "status" });
    });

    expect(
      await screen.findByRole("button", { name: "单独下载 MP4" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "下载交付包" }),
    ).toBeInTheDocument();
    expect(screen.getByText("交付检查已通过")).toBeInTheDocument();
  });

  it("ProducingPhase refreshes render progress on progress events", async () => {
    const client = makeClient();
    mocks.fetchVideoProject.mockResolvedValue({
      name: "proj",
      resolution: "1920x1080",
      outputStale: false,
      phase: "rendering",
    });
    mocks.fetchVideoStoryboard.mockResolvedValue({
      ok: true,
      scenes: [
        {
          ...scene(1),
          htmlStatus: "confirmed",
          htmlMtime: 100,
          confirmedMtime: 100,
        },
      ],
    });
    mocks.fetchScenePreviewHtml.mockResolvedValue({
      html: "<html>scene</html>",
      needsGeneration: false,
    });
    mocks.fetchVideoExportStatus.mockResolvedValue({
      stage: "rendering",
      progress: 15,
      message: "正在渲染场景 1/1 · 帧 10/150",
      actualEngine: "hyperframes",
    });

    render(wrap(<ProducingPhase projectName="proj" />, client));
    expect(await screen.findByText(/帧 10\/150/)).toBeInTheDocument();
    expect(screen.getByText("HyperFrames")).toBeInTheDocument();

    // 帧进度事件 → 立即刷新（不依赖轮询节拍）
    mocks.fetchVideoExportStatus.mockResolvedValue({
      stage: "rendering",
      progress: 42,
      message: "正在渲染场景 1/1 · 帧 60/150",
      requestedEngine: "auto",
      actualEngine: "legacy",
      fallbackReason: "preflight failed",
    });
    act(() => {
      client.__emitVideoProjectChanged({
        projectName: "proj",
        hint: "progress",
      });
    });

    expect(await screen.findByText(/帧 60\/150/)).toBeInTheDocument();
    expect(screen.getByText("兼容渲染器")).toBeInTheDocument();
    expect(
      screen.getByText(/HyperFrames 已回退：preflight failed/),
    ).toBeInTheDocument();
  });

  it("allows a running export to be stopped without leaving the workbench", async () => {
    const client = makeClient();
    mocks.fetchVideoProject.mockResolvedValue({
      name: "proj",
      resolution: "1920x1080",
      outputStale: false,
      phase: "rendering",
    });
    mocks.fetchVideoStoryboard.mockResolvedValue({
      ok: true,
      scenes: [
        {
          ...scene(1),
          htmlStatus: "confirmed",
          htmlMtime: 100,
          confirmedMtime: 100,
        },
      ],
    });
    mocks.fetchScenePreviewHtml.mockResolvedValue({
      html: "<html>scene</html>",
      needsGeneration: false,
    });
    mocks.fetchVideoExportStatus.mockResolvedValue({
      stage: "rendering",
      progress: 36,
      message: "正在渲染",
      actualEngine: "hyperframes",
    });

    render(wrap(<ProducingPhase projectName="proj" />, client));
    fireEvent.click(await screen.findByRole("button", { name: "停止导出" }));

    await waitFor(() => {
      expect(mocks.cancelVideoExport).toHaveBeenCalledWith("tok", "proj");
    });
    expect(screen.getByText("正在安全停止导出...")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "正在停止..." })).toBeDisabled();
  });

  it("shows automatic project versions and restores one", async () => {
    const client = makeClient();
    mocks.fetchVideoProject.mockResolvedValue({
      name: "proj",
      resolution: "1920x1080",
      outputStale: false,
      phase: "producing",
    });
    mocks.fetchVideoStoryboard.mockResolvedValue({
      ok: true,
      scenes: [
        {
          ...scene(1),
          htmlStatus: "confirmed",
          htmlMtime: 100,
          confirmedMtime: 100,
        },
      ],
    });
    mocks.fetchScenePreviewHtml.mockResolvedValue({
      html: "<html>scene</html>",
      needsGeneration: false,
    });
    mocks.fetchVideoExportStatus.mockResolvedValue({
      stage: "idle",
      progress: 0,
    });
    mocks.fetchVideoProjectVersions.mockResolvedValue({
      ok: true,
      versions: [
        {
          id: "20260827-220000-abcdef12",
          createdAt: "2026-08-27T22:00:00",
          label: "重写场景 1 前",
          reason: "ai-scene-rewrite",
          changedSceneIndices: [1],
        },
      ],
    });

    render(wrap(<ProducingPhase projectName="proj" />, client));
    fireEvent.click(await screen.findByRole("button", { name: "版本历史" }));

    expect(await screen.findByText("重写场景 1 前")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "恢复" }));
    await waitFor(() => {
      expect(mocks.restoreVideoProjectVersion).toHaveBeenCalledWith(
        "tok",
        "proj",
        "20260827-220000-abcdef12",
      );
    });
  });

  it("creates a language version from built-in locale choices", async () => {
    const client = makeClient();
    const onLocalized = vi.fn();
    mocks.fetchVideoProject.mockResolvedValue({
      name: "proj",
      resolution: "1920x1080",
      outputStale: false,
      phase: "producing",
      language: "zh-CN",
    });
    mocks.fetchVideoStoryboard.mockResolvedValue({
      ok: true,
      scenes: [
        {
          ...scene(1),
          htmlStatus: "confirmed",
          htmlMtime: 100,
          confirmedMtime: 100,
        },
      ],
    });
    mocks.fetchScenePreviewHtml.mockResolvedValue({
      html: "<html>scene</html>",
      needsGeneration: false,
    });
    mocks.fetchVideoExportStatus.mockResolvedValue({
      stage: "idle",
      progress: 0,
    });
    mocks.localizeVideoProject.mockResolvedValue({
      ok: true,
      name: "proj-en_us",
      language: "en-US",
    });

    render(
      wrap(
        <ProducingPhase projectName="proj" onLocalized={onLocalized} />,
        client,
      ),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "创建语言版本" }),
    );
    expect(
      screen.getByRole("radio", { name: "简体中文（当前）" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("radio", { name: "English" }));
    const createButtons = screen.getAllByRole("button", {
      name: "创建语言版本",
    });
    fireEvent.click(createButtons[createButtons.length - 1]);

    await waitFor(() => {
      expect(mocks.localizeVideoProject).toHaveBeenCalledWith(
        "tok",
        "proj",
        "en-US",
      );
      expect(onLocalized).toHaveBeenCalledWith("proj-en_us");
    });
  });

  it("opens a script-aligned fine timeline without exposing code", async () => {
    const client = makeClient();
    mocks.fetchVideoProject.mockResolvedValue({
      name: "proj",
      resolution: "1920x1080",
      outputStale: false,
      phase: "producing",
    });
    mocks.fetchVideoStoryboard.mockResolvedValue({
      ok: true,
      scenes: [
        {
          ...scene(1),
          htmlStatus: "confirmed",
          htmlMtime: 100,
          confirmedMtime: 100,
        },
      ],
    });
    mocks.fetchScenePreviewHtml.mockResolvedValue({
      html: "<html>scene</html>",
      needsGeneration: false,
    });
    mocks.fetchVideoExportStatus.mockResolvedValue({
      stage: "idle",
      progress: 0,
    });
    mocks.fetchVideoSceneTimeline.mockResolvedValue({
      ok: true,
      sceneIndex: 1,
      durationMs: 5000,
      motionPlan: {
        beats: [
          {
            id: "beat-01",
            startMs: 0,
            endMs: 800,
            target: "title",
            effect: "fade-rise",
          },
        ],
      },
      subtitleTrack: {
        timingSource: "provider-boundary",
        cues: [
          {
            id: "cue-01",
            startMs: 100,
            endMs: 1800,
            text: "字幕与画面同步",
          },
        ],
      },
    });

    render(wrap(<ProducingPhase projectName="proj" />, client));
    fireEvent.click(await screen.findByRole("button", { name: "精细时间轴" }));

    expect(
      screen.getByRole("slider", { name: "场景播放位置" }),
    ).toBeInTheDocument();
    expect(screen.getByText("画面节拍")).toBeInTheDocument();
    expect(screen.getByText("字幕与画面同步")).toBeInTheDocument();
    expect(screen.getByTitle("标题 · fade-rise")).toBeInTheDocument();
  });

  it("records time-based reviews and blocks final delivery until resolved", async () => {
    const client = makeClient();
    mocks.fetchVideoProject.mockResolvedValue({
      name: "proj",
      resolution: "1920x1080",
      outputStale: false,
      phase: "producing",
    });
    mocks.fetchVideoStoryboard.mockResolvedValue({
      ok: true,
      scenes: [
        {
          ...scene(1),
          htmlStatus: "confirmed",
          htmlMtime: 100,
          confirmedMtime: 100,
        },
      ],
    });
    mocks.fetchScenePreviewHtml.mockResolvedValue({
      html: "<html>scene</html>",
      needsGeneration: false,
    });
    mocks.fetchVideoExportStatus.mockResolvedValue({
      stage: "idle",
      progress: 0,
    });
    mocks.fetchVideoReviews.mockResolvedValue({
      ok: true,
      openCount: 1,
      reviews: [
        {
          id: "review-open",
          sceneIndex: 1,
          timeMs: 1200,
          text: "数据来源待复核",
          status: "open",
          createdAt: "2026-08-27T22:00:00",
        },
      ],
    });
    mocks.createVideoReview.mockResolvedValue({
      ok: true,
      review: {
        id: "review-new",
        sceneIndex: 1,
        timeMs: 0,
        text: "补充品牌标识",
        status: "open",
        createdAt: "2026-08-27T22:01:00",
      },
    });

    render(wrap(<ProducingPhase projectName="proj" />, client));
    expect(await screen.findByText("1 条未解决")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("审阅意见"), {
      target: { value: "补充品牌标识" },
    });
    fireEvent.click(screen.getByRole("button", { name: "记录当前时间点" }));
    await waitFor(() => {
      expect(mocks.createVideoReview).toHaveBeenCalledWith(
        "tok",
        "proj",
        1,
        0,
        "补充品牌标识",
      );
    });

    fireEvent.click(screen.getByRole("button", { name: /导出视频/ }));
    expect(screen.getByRole("radio", { name: /正式版/ })).toBeDisabled();
    expect(screen.getByText("先解决 2 条意见")).toBeInTheDocument();
    expect(await screen.findByText("150 帧")).toBeInTheDocument();
    expect(
      screen.getByText("本地渲染与 Edge 配音不扣 Mona 积分"),
    ).toBeInTheDocument();
  });

  it("ignores events addressed to other projects", async () => {
    const client = makeClient();
    mocks.fetchVideoProject.mockResolvedValue({
      name: "proj",
      resolution: "1920x1080",
      outputStale: false,
      phase: "producing",
    });
    mocks.fetchVideoStoryboard.mockResolvedValue({
      ok: true,
      scenes: [
        {
          ...scene(1),
          htmlStatus: "confirmed",
          htmlMtime: 100,
          confirmedMtime: 100,
        },
      ],
    });
    mocks.fetchScenePreviewHtml.mockResolvedValue({
      html: "<html>scene</html>",
      needsGeneration: false,
    });
    mocks.fetchVideoExportStatus.mockResolvedValue({
      stage: "idle",
      progress: 0,
    });

    render(wrap(<ProducingPhase projectName="proj" />, client));
    expect(
      await screen.findByRole("button", { name: /导出视频/ }),
    ).toBeInTheDocument();
    const callsBefore = mocks.fetchVideoExportStatus.mock.calls.length;

    act(() => {
      client.__emitVideoProjectChanged({
        projectName: "other-proj",
        hint: "status",
      });
    });
    await act(async () => {});

    expect(mocks.fetchVideoExportStatus.mock.calls.length).toBe(callsBefore);
  });

  it("StoryboardPhase reloads scenes when a scenes event arrives", async () => {
    const client = makeClient();
    mocks.fetchVideoStoryboard.mockResolvedValue({
      ok: true,
      scenes: [scene(1, { title: "开场" })],
      storyboardExists: true,
    });

    render(
      wrap(<StoryboardPhase projectName="proj" onLocked={() => {}} />, client),
    );
    expect(await screen.findByDisplayValue("开场")).toBeInTheDocument();
    const callsBefore = mocks.fetchVideoStoryboard.mock.calls.length;

    // AI 重写 storyboard.md → 服务端重解析 → WS 推送 scenes 事件
    mocks.fetchVideoStoryboard.mockResolvedValue({
      ok: true,
      scenes: [scene(1, { title: "AI改写" })],
      storyboardExists: true,
    });
    act(() => {
      client.__emitVideoProjectChanged({ projectName: "proj", hint: "scenes" });
    });

    expect(await screen.findByDisplayValue("AI改写")).toBeInTheDocument();
    expect(mocks.fetchVideoStoryboard.mock.calls.length).toBeGreaterThan(
      callsBefore,
    );
  });

  it("VideoHistory silently refreshes phase labels on phase events", async () => {
    const client = makeClient();
    mocks.fetchVideoProjects.mockResolvedValue({
      projects: [
        {
          name: "新项目",
          createdAt: 1,
          resolution: "1920x1080",
          phase: "storyboard",
          hasVideo: false,
          outputStale: false,
          chatId: null,
        },
      ],
    });

    render(wrap(<VideoMakerView />, client));
    expect(await screen.findByText("分镜中")).toBeInTheDocument();

    // 锁定分镜 → 服务端推送 phase 事件 → 列表阶段标签原地更新
    mocks.fetchVideoProjects.mockResolvedValue({
      projects: [
        {
          name: "新项目",
          createdAt: 1,
          resolution: "1920x1080",
          phase: "producing",
          hasVideo: false,
          outputStale: false,
          chatId: null,
        },
      ],
    });
    act(() => {
      client.__emitVideoProjectChanged({
        projectName: "新项目",
        hint: "phase",
      });
    });

    expect(await screen.findByText("制作中")).toBeInTheDocument();
    expect(screen.queryByText("分镜中")).not.toBeInTheDocument();
  });
});
