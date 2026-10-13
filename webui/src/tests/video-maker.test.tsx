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
  copyVideoProject: vi.fn(),
  confirmVideoProjectPlan: vi.fn(),
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
  getApiBase: vi.fn(async () => "http://localhost:8765"),
  getServicesHttpBase: vi.fn(async () => "http://localhost:17174"),
  importVideoProjectAsset: vi.fn(),
  renameVideoProject: vi.fn(),
  reorderVideoScenes: vi.fn(),
  restoreVideoProjectVersion: vi.fn(async () => ({
    ok: true,
    phase: "producing",
  })),
  resolveVideoReview: vi.fn(),
  saveVideoChatId: vi.fn(),
  startVideoRuntimeDownload: vi.fn(),
  fetchVideoRuntimeDownloadJobs: vi.fn(async () => ({ jobs: [] })),
  updateVideoScene: vi.fn(),
  updateVideoProjectSettings: vi.fn(),
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
  mocks.fetchVideoProject.mockReset().mockResolvedValue({
    name: "proj",
    resolution: "1920x1080",
    outputStale: false,
    phase: "storyboard",
    meta: { narrationEnabled: false },
  });
  mocks.createVideoProject.mockReset();
  mocks.saveVideoChatId.mockReset().mockResolvedValue({ ok: true });
  mocks.fetchSceneNarrationBytes.mockReset().mockResolvedValue(null);
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
  it("keeps content editing optional and hides fixed-layout internals", async () => {
    mocks.fetchVideoStoryboard.mockResolvedValue({ ok: true, scenes: [scene(1, { audioTimingSource: "provider-boundary" })] });
    render(wrap(<StoryboardPhase projectName="proj" />));
    await screen.findByDisplayValue("场景1");
    expect(screen.getByText("字幕已同步")).toBeInTheDocument();
    expect(screen.queryByLabelText("场景角色")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("场景布局")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("背景槽位")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /确认分镜/ })).not.toBeInTheDocument();
  });

  it("makes project assets available before any scene exists", async () => {
    mocks.fetchVideoStoryboard.mockResolvedValue({ ok: true, scenes: [] });
    render(wrap(<StoryboardPhase projectName="proj" section="assets" />));
    expect(await screen.findByRole("button", { name: "导入素材" })).toBeInTheDocument();
    expect(screen.getByText(/还没有素材/)).toBeInTheDocument();
  });

  it("disables narration audition when the project has no voice track", async () => {
    mocks.fetchVideoProject.mockResolvedValue({
      name: "proj",
      resolution: "1920x1080",
      outputStale: false,
      phase: "storyboard",
      meta: { narrationEnabled: false },
    });
    mocks.fetchVideoStoryboard.mockResolvedValue({
      ok: true,
      scenes: [scene(1)],
      storyboardExists: true,
    });

    render(wrap(<StoryboardPhase projectName="proj" />));

    const audition = await screen.findByRole("button", { name: "未启用旁白" });
    expect(audition).toBeDisabled();
    fireEvent.click(audition);
    expect(mocks.fetchSceneNarrationBytes).not.toHaveBeenCalled();
  });

  it("shows a dialog when storyboard narration audition fails", async () => {
    mocks.fetchVideoProject.mockResolvedValue({
      name: "proj",
      resolution: "1920x1080",
      outputStale: false,
      phase: "storyboard",
      meta: { narrationEnabled: true },
    });
    mocks.fetchVideoStoryboard.mockResolvedValue({
      ok: true,
      scenes: [scene(1)],
      storyboardExists: true,
    });
    mocks.fetchSceneNarrationBytes.mockRejectedValue(new Error("HTTP 502"));

    render(wrap(<StoryboardPhase projectName="proj" />));
    fireEvent.click(await screen.findByRole("button", { name: "试听" }));

    expect(await screen.findByRole("dialog", { name: "试听旁白失败" })).toHaveTextContent("试听旁白失败");
    expect(screen.getByRole("dialog")).toHaveTextContent("请检查网络连接后重试");
  });

  it("shows the speech component remedy without suggesting a network or voice change", async () => {
    const { ApiError } = await import("@/lib/api");
    mocks.fetchVideoProject.mockResolvedValue({ name: "proj", phase: "producing", meta: { narrationEnabled: true } });
    mocks.fetchVideoStoryboard.mockResolvedValue({ ok: true, scenes: [scene(1)], storyboardExists: true });
    mocks.fetchSceneNarrationBytes.mockRejectedValue(Object.assign(
      new ApiError(503, "配音组件未准备好，请更新应用后重试。"), { code: "TTS_COMPONENT_MISSING" },
    ));
    render(wrap(<StoryboardPhase projectName="proj" />));
    fireEvent.click(await screen.findByRole("button", { name: "试听" }));
    const dialog = await screen.findByRole("dialog", { name: "试听旁白失败" });
    expect(dialog).toHaveTextContent("配音组件未准备好");
    expect(dialog).not.toHaveTextContent("请检查网络连接");
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

    render(wrap(<StoryboardPhase projectName="proj" />));
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

    render(wrap(<StoryboardPhase projectName="proj" />));

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

  it("keeps failed edits until an explicit save retry succeeds", async () => {
    mocks.fetchVideoStoryboard.mockResolvedValue({ ok: true, scenes: [scene(1)] });
    mocks.updateVideoScene.mockResolvedValue({ ok: false, error: "boom" });
    render(wrap(<StoryboardPhase projectName="proj" />));
    fireEvent.change(await screen.findByDisplayValue("场景1"), { target: { value: "改动" } });
    expect(await screen.findByText("保存失败")).toBeInTheDocument();
    expect(screen.getByDisplayValue("改动")).toBeInTheDocument();
    mocks.updateVideoScene.mockResolvedValue({ ok: true });
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("已保存")).toBeInTheDocument();
    expect(mocks.updateVideoScene).toHaveBeenLastCalledWith("tok", "proj", { index: 1, title: "改动" });
  });

  it("keeps pending edits when scene reordering cannot save them", async () => {
    mocks.fetchVideoStoryboard.mockResolvedValue({
      ok: true,
      scenes: [scene(1, { title: "开场" }), scene(2, { title: "结尾" })],
      storyboardExists: true,
    });
    mocks.updateVideoScene.mockResolvedValue({ ok: false, error: "保存失败" });

    render(wrap(<StoryboardPhase projectName="proj" />));
    const title = await screen.findByDisplayValue("开场");
    fireEvent.change(title, { target: { value: "已编辑开场" } });
    fireEvent.click(screen.getByTitle("下移"));

    expect(await screen.findByText("保存失败")).toBeInTheDocument();
    expect(screen.getByDisplayValue("已编辑开场")).toBeInTheDocument();
    expect(mocks.reorderVideoScenes).not.toHaveBeenCalled();

    mocks.updateVideoScene.mockResolvedValue({ ok: true });
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(mocks.updateVideoScene).toHaveBeenCalledTimes(2));
    expect(mocks.updateVideoScene).toHaveBeenLastCalledWith("tok", "proj", {
      index: 1,
      title: "已编辑开场",
    });
    expect(mocks.reorderVideoScenes).not.toHaveBeenCalled();
  });

  it("does not delete a scene while its edits remain unsaved", async () => {
    mocks.fetchVideoStoryboard.mockResolvedValue({
      ok: true,
      scenes: [scene(1, { title: "开场" }), scene(2, { title: "结尾" })],
      storyboardExists: true,
    });
    mocks.updateVideoScene.mockResolvedValue({ ok: false, error: "保存失败" });

    render(wrap(<StoryboardPhase projectName="proj" />));
    const title = await screen.findByDisplayValue("开场");
    fireEvent.change(title, { target: { value: "已编辑开场" } });
    fireEvent.click(screen.getByRole("button", { name: "删除场景" }));
    fireEvent.click(await screen.findByRole("button", { name: "删除" }));

    expect(await screen.findByText("保存失败")).toBeInTheDocument();
    expect(screen.getByDisplayValue("已编辑开场")).toBeInTheDocument();
    expect(mocks.deleteVideoScene).not.toHaveBeenCalled();
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

    render(wrap(<StoryboardPhase projectName="proj" />));

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

  it("retries reading a failed project without sending another creation task", async () => {
    const onRequestAgent = vi.fn();
    mocks.fetchVideoStoryboard.mockResolvedValueOnce({ ok: false, error: "internal parse trace" });
    render(wrap(<ProducingPhase projectName="proj" onRequestAgent={onRequestAgent} />));
    expect(await screen.findByText("视频内容暂时无法读取")).toBeInTheDocument();
    mocks.fetchVideoStoryboard.mockResolvedValue({ ok: true, scenes: [producingScene(1)] });
    fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
    expect(await screen.findByRole("button", { name: "制作这个场景" })).toBeInTheDocument();
    expect(onRequestAgent).not.toHaveBeenCalled();
    expect(screen.queryByText("internal parse trace")).not.toBeInTheDocument();
  });

  it("asks the Agent to make a scene once and refreshes from its saved result", async () => {
    const client = makeClient();
    const onRequestAgent = vi.fn();
    mocks.fetchVideoStoryboard.mockResolvedValue({ ok: true, scenes: [producingScene(1)] });
    mocks.fetchScenePreviewHtml.mockResolvedValue({ html: "<html>new scene</html>", needsGeneration: false });
    render(wrap(<ProducingPhase projectName="proj" onRequestAgent={onRequestAgent} />, client));
    fireEvent.click(await screen.findByRole("button", { name: "制作这个场景" }));
    await waitFor(() => expect(onRequestAgent).toHaveBeenCalledOnce());
    expect(onRequestAgent).toHaveBeenCalledWith(expect.stringContaining("场景 1"));
    mocks.fetchVideoStoryboard.mockResolvedValue({ ok: true, scenes: [producingScene(1, { htmlStatus: "previewing", htmlMtime: 100 })] });
    act(() => client.__emitVideoProjectChanged({ projectName: "proj", hint: "scenes" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "导出视频" })).toBeEnabled());
    expect(await screen.findByRole("button", { name: "播放当前场景" })).toBeEnabled();
    expect(onRequestAgent).toHaveBeenCalledOnce();
  });

  it("sends regeneration and a user adjustment to the same Agent callback", async () => {
    const onRequestAgent = vi.fn();
    mocks.fetchVideoStoryboard.mockResolvedValue({ ok: true, scenes: [producingScene(1, { htmlStatus: "previewing", htmlMtime: 100 })] });
    mocks.fetchScenePreviewHtml.mockResolvedValue({ html: "<html>scene</html>", needsGeneration: false });
    render(wrap(<ProducingPhase projectName="proj" onRequestAgent={onRequestAgent} />));
    fireEvent.click(await screen.findByRole("button", { name: "设置" }));
    fireEvent.click(screen.getByRole("button", { name: "重新生成" }));
    await waitFor(() => expect(onRequestAgent).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "调整内容" }));
    fireEvent.change(screen.getByLabelText("调整要求"), { target: { value: "用趋势图解释数据" } });
    fireEvent.click(screen.getByRole("button", { name: "发送要求" }));
    await waitFor(() => expect(onRequestAgent).toHaveBeenCalledTimes(2));
    expect(onRequestAgent).toHaveBeenLastCalledWith(expect.stringContaining("用趋势图解释数据"));
  });

  it("keeps a failed request explicit and never replays it on refresh", async () => {
    const client = makeClient();
    const onRequestAgent = vi.fn().mockRejectedValue(new Error("timeout"));
    mocks.fetchVideoStoryboard.mockResolvedValue({ ok: true, scenes: [producingScene(1)] });
    render(wrap(<ProducingPhase projectName="proj" onRequestAgent={onRequestAgent} />, client));
    fireEvent.click(await screen.findByRole("button", { name: "制作这个场景" }));
    expect(await screen.findByRole("dialog", { name: "制作要求未能发送" })).toBeInTheDocument();
    act(() => client.__emitVideoProjectChanged({ projectName: "proj", hint: "scenes" }));
    expect(onRequestAgent).toHaveBeenCalledOnce();
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
      await screen.findByText("场景 · 2 段"),
    ).toBeInTheDocument();
    const exportButton = screen.getByRole("button", { name: /导出视频/ });
    expect(exportButton).toBeDisabled();
  });

  it("requests a new orientation through the existing Agent conversation", async () => {
    const onRequestAgent = vi.fn();
    mocks.fetchVideoProject.mockResolvedValue({ name: "proj", resolution: "1920x1080", phase: "done", aspectVariant: "16:9" });
    mocks.fetchVideoStoryboard.mockResolvedValue({ ok: true, scenes: [producingScene(1)] });
    render(wrap(<ProducingPhase projectName="proj" onRequestAgent={onRequestAgent} />));
    fireEvent.click(await screen.findByRole("button", { name: "设置" }));
    fireEvent.click(screen.getByRole("button", { name: "横屏与竖屏" }));
    fireEvent.click(screen.getByRole("radio", { name: /竖屏/ }));
    fireEvent.click(screen.getByRole("button", { name: "调整分镜方案" }));
    await waitFor(() => expect(onRequestAgent).toHaveBeenCalledOnce());
    expect(onRequestAgent).toHaveBeenCalledWith(expect.stringContaining("竖屏"));
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
      await screen.findByText("场景 · 2 段"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /导出视频/ })).toBeEnabled();
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

    await screen.findByText("场景 · 1 段");
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
    mocks.fetchVideoProject.mockResolvedValue({
      name: "proj",
      resolution: "1920x1080",
      outputStale: false,
      phase: "producing",
      meta: { narrationEnabled: true },
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
    fireEvent.click(
      await screen.findByRole("button", { name: "播放当前场景" }),
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

  it("reports a failed narration request and keeps the timeline stopped", async () => {
    mocks.fetchVideoProject.mockResolvedValue({
      name: "proj",
      resolution: "1920x1080",
      outputStale: false,
      phase: "producing",
      meta: { narrationEnabled: true },
    });
    mocks.fetchVideoStoryboard.mockResolvedValue({
      ok: true,
      scenes: [producingScene(1, { htmlStatus: "previewing", htmlMtime: 100 })],
    });
    mocks.fetchScenePreviewHtml.mockResolvedValue({
      html: "<html>scene</html>",
      needsGeneration: false,
    });
    mocks.fetchSceneNarrationBytes.mockRejectedValue(new Error("HTTP 500"));

    render(wrap(<ProducingPhase projectName="proj" />));
    const playTimeline = await screen.findByRole("button", {
      name: "播放当前场景",
    });
    await waitFor(() => expect(playTimeline).toBeEnabled());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(playTimeline);

    expect(await screen.findByRole("dialog")).toHaveTextContent("场景播放失败");
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "请打开设置试听旁白后重试",
    );
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(screen.getByRole("button", { name: "播放当前场景" })).toBeInTheDocument();
  });

  it("reports a rejected narration preview and releases its audio URL", async () => {
    const originalCreateObjectUrl = URL.createObjectURL;
    const originalRevokeObjectUrl = URL.revokeObjectURL;
    const revokeObjectUrl = vi.fn();
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:scene-narration"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectUrl,
    });
    const play = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockRejectedValue(new Error("playback blocked"));
    mocks.fetchVideoProject.mockResolvedValue({
      name: "proj",
      resolution: "1920x1080",
      outputStale: false,
      phase: "producing",
      meta: { narrationEnabled: true },
    });
    mocks.fetchVideoStoryboard.mockResolvedValue({
      ok: true,
      scenes: [producingScene(1, { htmlStatus: "previewing", htmlMtime: 100 })],
    });
    mocks.fetchScenePreviewHtml.mockResolvedValue({
      html: "<html>scene</html>",
      needsGeneration: false,
    });
    mocks.fetchSceneNarrationBytes.mockResolvedValue(
      new Blob(["audio"], { type: "audio/mpeg" }),
    );

    render(wrap(<ProducingPhase projectName="proj" />));
    fireEvent.click(await screen.findByRole("button", { name: "设置" }));
    const playNarration = screen.getByRole("button", { name: "试听旁白" });
    await waitFor(() => expect(playNarration).toBeEnabled());
    fireEvent.click(playNarration);

    expect(await screen.findByRole("dialog", { name: "试听旁白失败" })).toHaveTextContent("试听旁白失败");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "请检查网络连接后重试",
    );
    expect(revokeObjectUrl).toHaveBeenCalledTimes(1);
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:scene-narration");
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    expect(screen.getByRole("button", { name: "试听旁白" })).toBeEnabled();

    play.mockRestore();
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: originalCreateObjectUrl,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: originalRevokeObjectUrl,
    });
  });

  it("plays a silent visual timeline without requesting narration when narration is disabled", async () => {
    mocks.fetchVideoProject.mockResolvedValue({
      name: "proj",
      resolution: "1920x1080",
      outputStale: false,
      phase: "producing",
      meta: { narrationEnabled: false },
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
    fireEvent.click(await screen.findByRole("button", { name: "播放当前场景" }));

    expect(
      await screen.findByRole("button", { name: "暂停当前场景" }),
    ).toBeInTheDocument();
    expect(mocks.fetchSceneNarrationBytes).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("retries timeline audio after narration audition succeeds", async () => {
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
    const mediaElements: HTMLMediaElement[] = [];
    const play = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockImplementation(function (this: HTMLMediaElement) {
        mediaElements.push(this);
        return Promise.resolve();
      });
    const audioBlob = new Blob(["audio"], { type: "audio/mpeg" });
    mocks.fetchVideoProject.mockResolvedValue({
      name: "proj",
      resolution: "1920x1080",
      outputStale: false,
      phase: "producing",
      meta: { narrationEnabled: true },
    });
    mocks.fetchVideoStoryboard.mockResolvedValue({
      ok: true,
      scenes: [producingScene(1, { htmlStatus: "previewing", htmlMtime: 100 })],
    });
    mocks.fetchScenePreviewHtml.mockResolvedValue({
      html: "<html>scene</html>",
      needsGeneration: false,
    });
    mocks.fetchSceneNarrationBytes
      .mockRejectedValueOnce(new Error("HTTP 500"))
      .mockResolvedValue(audioBlob);

    render(wrap(<ProducingPhase projectName="proj" />));
    const playTimeline = await screen.findByRole("button", {
      name: "播放当前场景",
    });
    await waitFor(() => expect(playTimeline).toBeEnabled());
    expect(mocks.fetchSceneNarrationBytes).toHaveBeenCalledTimes(1);

    fireEvent.click(await screen.findByRole("button", { name: "设置" }));
    fireEvent.click(screen.getByRole("button", { name: "试听旁白" }));
    await waitFor(() =>
      expect(mocks.fetchSceneNarrationBytes).toHaveBeenCalledTimes(3),
    );
    await waitFor(() => expect(playTimeline).toBeEnabled());
    act(() => mediaElements[0]?.dispatchEvent(new Event("ended")));
    fireEvent.click(screen.getByRole("button", { name: "返回视频" }));
    fireEvent.click(playTimeline);

    expect(
      await screen.findByRole("button", { name: "暂停当前场景" }),
    ).toBeInTheDocument();
    expect(play).toHaveBeenCalledTimes(2);

    play.mockRestore();
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

describe("VideoMakerView director workspace", () => {
  beforeEach(() => {
    mocks.fetchVideoStoryboard.mockReset().mockResolvedValue({ ok: true, planRevision: 1, scenes: [] });
    mocks.fetchVideoProject.mockImplementation(async (_token: string, name: string) => ({ name, resolution: "1920x1080", phase: "storyboard", meta: { narrationEnabled: true, requirePlanApproval: true, planRevision: 1, approvedPlanRevision: null } }));
    mocks.confirmVideoProjectPlan.mockReset().mockResolvedValue({ ok: true, planRevision: 1 });
    mocks.updateVideoProjectSettings.mockReset();
    mocks.fetchScenePreviewHtml.mockResolvedValue({ html: "<html>scene</html>", needsGeneration: false });
    mocks.fetchVideoExportStatus.mockResolvedValue({ stage: "idle", progress: 0 });
    mocks.createVideoProject.mockResolvedValue({ ok: true });
  });

  it("starts with one description and progressive optional settings", async () => {
    render(wrap(<VideoMakerView />));
    expect(screen.getByLabelText("想做什么视频？")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "准备分镜" })).toBeDisabled();
    expect(screen.queryByText("创建方式")).not.toBeInTheDocument();
    expect(screen.queryByText("系列视频")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "开始制作" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("视频名称")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "更多设置" }));
    expect(screen.getByLabelText("视频名称")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "竖屏" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "配音" })).toBeInTheDocument();
  });

  it("creates once and prepares a plan before the user confirms production", async () => {
    const client = makeClient();
    client.newChat.mockResolvedValue("video-chat");
    render(wrap(<VideoMakerView />, client));
    fireEvent.change(screen.getByLabelText("想做什么视频？"), { target: { value: "介绍我的产品" } });
    fireEvent.click(screen.getByRole("button", { name: "准备分镜" }));
    await waitFor(() => expect(client.sendMessage).toHaveBeenCalledOnce());
    expect(mocks.createVideoProject).toHaveBeenCalledOnce();
    const prompt = client.sendMessage.mock.calls[0][1];
    expect(prompt).toContain("画面：横屏");
    expect(prompt).toContain("用 video.plan 保存方案");
    expect(prompt).toContain("不编写场景源码");
    expect(mocks.confirmVideoProjectPlan).not.toHaveBeenCalled();
    expect(mocks.fetchSceneNarrationBytes).not.toHaveBeenCalled();
    expect(prompt).not.toMatch(/项目目录|video_projects|1920x1080|Role|Background Slot|锁定|Step/);
    expect(client.sendMessage).toHaveBeenCalledWith("video-chat", expect.any(String), undefined, { agentKind: "video", displayContent: "介绍我的产品" });
    expect(await screen.findByRole("heading", { name: /导演台/ })).toBeInTheDocument();
    expect(screen.getByTestId("doc-chat-panel")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /切换到编辑分镜/ })).not.toBeInTheDocument();
    expect(mocks.fetchVideoRuntimeCheck).not.toHaveBeenCalled();
  });

  it("saves a chosen name, orientation, style, and voice as optional inputs", async () => {
    const client = makeClient();
    client.newChat.mockResolvedValue("video-chat");
    render(wrap(<VideoMakerView />, client));
    fireEvent.change(screen.getByLabelText("想做什么视频？"), { target: { value: "介绍产品" } });
    fireEvent.click(screen.getByRole("button", { name: "更多设置" }));
    fireEvent.change(screen.getByLabelText("视频名称"), { target: { value: "产品介绍" } });
    fireEvent.click(screen.getByRole("button", { name: "竖屏" }));
    fireEvent.click(screen.getByRole("button", { name: /简洁浅色/ }));
    expect(screen.getByRole("checkbox", { name: "配音" })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "准备分镜" }));
    await waitFor(() => expect(client.sendMessage).toHaveBeenCalledOnce());
    expect(mocks.createVideoProject).toHaveBeenCalledWith("tok", "产品介绍", "1080x1920", expect.objectContaining({ templateId: "minimal-business", narrationEnabled: true, ttsProvider: "edge", subtitleMode: "burned" }));
  });

  it("reuses a saved style without making users choose a series", async () => {
    mocks.fetchVideoSeries.mockResolvedValue({ series: [{ id: "style-a", name: "我的简洁风格", latestStyleVersion: 2, defaultAspectRatio: "9:16", styleSummary: { enabledAspectRatios: ["9:16"] } }] });
    const client = makeClient();
    client.newChat.mockResolvedValue("video-chat");
    render(wrap(<VideoMakerView />, client));
    fireEvent.change(screen.getByLabelText("想做什么视频？"), { target: { value: "介绍产品" } });
    fireEvent.click(screen.getByRole("button", { name: "更多设置" }));
    fireEvent.click(screen.getByRole("button", { name: "我的风格" }));
    fireEvent.click((await screen.findByText("我的简洁风格")).closest("button")!);
    expect(screen.getByRole("button", { name: "竖屏" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "准备分镜" }));
    await waitFor(() => expect(client.sendMessage).toHaveBeenCalledOnce());
    expect(mocks.createVideoProject.mock.calls[0][3]).toMatchObject({ styleSeriesId: "style-a", styleVersion: 2, aspectVariant: "9:16" });
    expect(mocks.createVideoProject.mock.calls[0][3]).not.toHaveProperty("seriesId");
  });

  it("retries the existing project if creating its conversation fails", async () => {
    const client = makeClient();
    client.newChat.mockRejectedValueOnce(new Error("connection failed")).mockResolvedValue("video-chat");
    render(wrap(<VideoMakerView />, client));
    fireEvent.change(screen.getByLabelText("想做什么视频？"), { target: { value: "介绍产品" } });
    fireEvent.click(screen.getByRole("button", { name: "准备分镜" }));
    const retry = await screen.findByRole("button", { name: "继续准备分镜" });
    expect(client.sendMessage).not.toHaveBeenCalled();
    fireEvent.click(retry);
    await waitFor(() => expect(client.sendMessage).toHaveBeenCalledOnce());
    expect(mocks.createVideoProject).toHaveBeenCalledOnce();
    expect(client.newChat).toHaveBeenCalledTimes(2);
  });

  it("retries saving the same conversation instead of creating another video", async () => {
    const client = makeClient();
    client.newChat.mockResolvedValue("video-chat");
    mocks.saveVideoChatId.mockRejectedValueOnce(new Error("save link failed")).mockResolvedValue({ ok: true });
    render(wrap(<VideoMakerView />, client));
    fireEvent.change(screen.getByLabelText("想做什么视频？"), { target: { value: "介绍产品" } });
    fireEvent.click(screen.getByRole("button", { name: "准备分镜" }));
    fireEvent.click(await screen.findByRole("button", { name: "继续准备分镜" }));
    await waitFor(() => expect(client.sendMessage).toHaveBeenCalledOnce());
    expect(client.newChat).toHaveBeenCalledOnce();
    expect(mocks.createVideoProject).toHaveBeenCalledOnce();
    expect(mocks.saveVideoChatId).toHaveBeenCalledTimes(2);
  });

  it("verifies an uncertain creation result before retrying the existing project", async () => {
    const client = makeClient();
    client.newChat.mockResolvedValue("video-chat");
    mocks.createVideoProject.mockRejectedValueOnce(new Error("response lost"));
    mocks.fetchVideoProject.mockImplementation(async (_token: string, name: string) => ({ name, phase: "storyboard", resolution: "1920x1080", meta: { narrationEnabled: false } }));
    render(wrap(<VideoMakerView />, client));
    fireEvent.change(screen.getByLabelText("想做什么视频？"), { target: { value: "产品介绍" } });
    fireEvent.click(screen.getByRole("button", { name: "准备分镜" }));
    fireEvent.click(await screen.findByRole("button", { name: "继续准备分镜" }));
    await waitFor(() => expect(client.sendMessage).toHaveBeenCalledOnce());
    expect(mocks.createVideoProject).toHaveBeenCalledOnce();
    expect(mocks.fetchVideoProject).toHaveBeenCalledWith("tok", "产品介绍");
  });

  it("uses the embedded video conversation and ordinary visible user text", async () => {
    const client = makeClient();
    const onSendVideoTurn = vi.fn();
    render(wrap(<VideoMakerView embedded hostChatId="host-chat" onSendVideoTurn={onSendVideoTurn} />, client));
    fireEvent.change(screen.getByLabelText("想做什么视频？"), { target: { value: "给新用户介绍产品" } });
    fireEvent.click(screen.getByRole("button", { name: "准备分镜" }));
    await waitFor(() => expect(onSendVideoTurn).toHaveBeenCalledOnce());
    expect(onSendVideoTurn).toHaveBeenCalledWith(expect.stringContaining("用 video.plan 保存方案"), "给新用户介绍产品");
    expect(client.newChat).not.toHaveBeenCalled();
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(screen.queryByTestId("doc-chat-panel")).not.toBeInTheDocument();
  });

  it("opens unconfirmed projects in the main director workspace", async () => {
    render(wrap(<VideoMakerView embedded hostChatId="chat" initialProject={{ name: "旧项目", phase: "storyboard", chatId: "chat" }} />));
    expect(await screen.findByRole("heading", { name: /导演台/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "素材" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "与 Mona 讨论" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "确认并生成" })).toBeDisabled();
  });

  it("keeps the director open and does not confirm or generate when scene saving fails", async () => {
    mocks.fetchVideoProject.mockResolvedValue({ name: "项目", phase: "storyboard", meta: { narrationEnabled: true, requirePlanApproval: true, planRevision: 1, approvedPlanRevision: null } });
    mocks.fetchVideoStoryboard.mockResolvedValue({ ok: true, planRevision: 1, scenes: [scene(1)] });
    mocks.updateVideoScene.mockResolvedValue({ ok: false, error: "save failed" });
    const onSendVideoTurn = vi.fn();
    render(wrap(<VideoMakerView embedded hostChatId="chat" initialProject={{ name: "项目", phase: "storyboard", chatId: "chat" }} onSendVideoTurn={onSendVideoTurn} />));
    fireEvent.change(await screen.findByLabelText("标题"), { target: { value: "新标题" } });
    fireEvent.click(screen.getByRole("button", { name: "确认并生成" }));
    expect(await screen.findByText("保存失败")).toBeInTheDocument();
    expect(screen.getByDisplayValue("新标题")).toBeInTheDocument();
    expect(mocks.confirmVideoProjectPlan).not.toHaveBeenCalled();
    expect(onSendVideoTurn).not.toHaveBeenCalled();
  });

  it("flushes animation changes and confirms the saved revision before starting production", async () => {
    mocks.fetchVideoProject.mockResolvedValue({ name: "项目", phase: "storyboard", meta: { narrationEnabled: true, requirePlanApproval: true, planRevision: 1, approvedPlanRevision: null } });
    mocks.fetchVideoStoryboard.mockResolvedValue({ ok: true, planRevision: 1, scenes: [scene(1)] });
    mocks.updateVideoScene.mockResolvedValue({ ok: true, planRevision: 2 });
    mocks.confirmVideoProjectPlan.mockResolvedValue({ ok: true, planRevision: 2 });
    const onSendVideoTurn = vi.fn();
    render(wrap(<VideoMakerView embedded hostChatId="chat" initialProject={{ name: "项目", phase: "storyboard", chatId: "chat" }} onSendVideoTurn={onSendVideoTurn} />));
    const animation = await screen.findByLabelText("画面如何变化");
    fireEvent.change(animation, { target: { value: "口播到比较时，两种方案左右展开，结果逐渐高亮" } });
    expect(screen.getByRole("button", { name: "预览视频" })).toBeDisabled();
    expect(mocks.fetchSceneNarrationBytes).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认并生成" }));
    await waitFor(() => expect(onSendVideoTurn).toHaveBeenCalledOnce());
    expect(mocks.updateVideoScene).toHaveBeenCalledWith("tok", "项目", { index: 1, animation: "口播到比较时，两种方案左右展开，结果逐渐高亮", expectedPlanRevision: 1 });
    expect(mocks.confirmVideoProjectPlan).toHaveBeenCalledWith("tok", "项目", 2);
    expect(mocks.updateVideoScene.mock.invocationCallOrder[0]).toBeLessThan(mocks.confirmVideoProjectPlan.mock.invocationCallOrder[0]);
    expect(mocks.confirmVideoProjectPlan.mock.invocationCallOrder[0]).toBeLessThan(onSendVideoTurn.mock.invocationCallOrder[0]);
    expect(onSendVideoTurn).toHaveBeenCalledWith(expect.stringContaining("修订号 2"), expect.any(String));
    expect(onSendVideoTurn.mock.calls[0][0]).toContain("不能以静态 PPT 页面切换代替");
    expect(await screen.findByRole("button", { name: "导演台" })).toBeInTheDocument();
  });

  it("does not generate after a confirmation conflict and refreshes the changed plan", async () => {
    mocks.fetchVideoProject.mockResolvedValue({ name: "项目", phase: "storyboard", meta: { narrationEnabled: true, requirePlanApproval: true, planRevision: 3, approvedPlanRevision: null } });
    mocks.fetchVideoStoryboard.mockResolvedValue({ ok: true, planRevision: 3, scenes: [scene(1)] });
    const { ApiError } = await import("@/lib/api");
    mocks.confirmVideoProjectPlan.mockRejectedValue(new ApiError(409, "plan changed"));
    const onSendVideoTurn = vi.fn();
    render(wrap(<VideoMakerView embedded hostChatId="chat" initialProject={{ name: "项目", phase: "storyboard", chatId: "chat" }} onSendVideoTurn={onSendVideoTurn} />));
    await screen.findByLabelText("画面如何变化");
    fireEvent.click(screen.getByRole("button", { name: "确认并生成" }));
    expect(await screen.findByRole("dialog")).toHaveTextContent("分镜方案已发生变化");
    expect(onSendVideoTurn).not.toHaveBeenCalled();
    expect(mocks.confirmVideoProjectPlan).toHaveBeenCalledWith("tok", "项目", 3);
    await waitFor(() => expect(mocks.fetchVideoStoryboard.mock.calls.length).toBeGreaterThan(1));
  });

  it("preserves local edits when saving conflicts with a newer plan and waits for another confirmation", async () => {
    const { ApiError } = await import("@/lib/api");
    mocks.fetchVideoProject.mockResolvedValue({ name: "项目", phase: "storyboard", meta: { narrationEnabled: true, requirePlanApproval: true, planRevision: 3, approvedPlanRevision: null } });
    mocks.fetchVideoStoryboard.mockResolvedValueOnce({ ok: true, planRevision: 3, scenes: [scene(1)] }).mockResolvedValue({ ok: true, planRevision: 4, scenes: [scene(1, { title: "远端标题", narration: "远端修改的旁白" })] });
    mocks.updateVideoScene.mockRejectedValueOnce(new ApiError(409, "plan changed")).mockResolvedValue({ ok: true, planRevision: 5 });
    mocks.confirmVideoProjectPlan.mockResolvedValue({ ok: true, planRevision: 5 });
    const onSendVideoTurn = vi.fn();
    render(wrap(<VideoMakerView embedded hostChatId="chat" initialProject={{ name: "项目", phase: "storyboard", chatId: "chat" }} onSendVideoTurn={onSendVideoTurn} />));
    fireEvent.change(await screen.findByLabelText("标题"), { target: { value: "我的修改" } });
    fireEvent.click(screen.getByRole("button", { name: "确认并生成" }));
    expect(await screen.findByDisplayValue("远端修改的旁白")).toBeInTheDocument();
    expect(screen.getByDisplayValue("我的修改")).toBeInTheDocument();
    expect(mocks.updateVideoScene).toHaveBeenCalledWith("tok", "项目", { index: 1, title: "我的修改", expectedPlanRevision: 3 });
    expect(mocks.confirmVideoProjectPlan).not.toHaveBeenCalled();
    expect(onSendVideoTurn).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认并生成" }));
    await waitFor(() => expect(onSendVideoTurn).toHaveBeenCalledOnce());
    expect(mocks.updateVideoScene).toHaveBeenLastCalledWith("tok", "项目", { index: 1, title: "我的修改", expectedPlanRevision: 4 });
    expect(mocks.confirmVideoProjectPlan).toHaveBeenCalledWith("tok", "项目", 5);
  });

  it("saves voice settings in the director without starting a generation turn", async () => {
    mocks.fetchVideoProject.mockResolvedValue({ name: "项目", phase: "storyboard", meta: { narrationEnabled: true, requirePlanApproval: true, planRevision: 1, approvedPlanRevision: null } });
    mocks.fetchVideoStoryboard.mockResolvedValue({ ok: true, planRevision: 1, scenes: [scene(1)] });
    mocks.updateVideoProjectSettings.mockResolvedValue({ ok: true, meta: { narrationEnabled: false } });
    const onSendVideoTurn = vi.fn();
    render(wrap(<VideoMakerView embedded hostChatId="chat" initialProject={{ name: "项目", phase: "storyboard", chatId: "chat" }} onSendVideoTurn={onSendVideoTurn} />));
    await screen.findByLabelText("画面如何变化");
    fireEvent.click(screen.getByRole("button", { name: "声音与字幕" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "启用旁白配音" }));
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
    await waitFor(() => expect(mocks.updateVideoProjectSettings).toHaveBeenCalledOnce());
    expect(mocks.confirmVideoProjectPlan).not.toHaveBeenCalled();
    expect(onSendVideoTurn).not.toHaveBeenCalled();
  });

  it("does not replay a failed Agent turn from a project-refresh event", async () => {
    const client = makeClient();
    render(wrap(<VideoMakerView embedded hostChatId="chat" initialProject={{ name: "项目", phase: "storyboard", chatId: "chat" }} onSendVideoTurn={vi.fn()} />, client));
    await screen.findByRole("heading", { name: /导演台/ });
    act(() => client.__emitChat("chat", { event: "error", detail: "invalid_agent_kind_context" }));
    expect(await screen.findByText("视频会话未就绪，请重试准备分镜。")).toBeInTheDocument();
    act(() => client.__emitVideoProjectChanged({ projectName: "项目", hint: "scenes" }));
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(mocks.createVideoProject).not.toHaveBeenCalled();
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

    expect(await screen.findByRole("button", { name: "保存视频" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
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
    expect(await screen.findByRole("status")).toHaveTextContent("正在导出 15%");
    expect(screen.queryByText("HyperFrames")).not.toBeInTheDocument();

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

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("正在导出 42%"));
    expect(screen.queryByText("兼容渲染器")).not.toBeInTheDocument();
    expect(screen.queryByText(/HyperFrames 已回退|preflight failed/)).not.toBeInTheDocument();
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
    fireEvent.click(await screen.findByRole("button", { name: "查看进度" }));
    fireEvent.click(screen.getByRole("button", { name: "停止导出" }));

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
    fireEvent.click(await screen.findByRole("button", { name: "设置" }));
    fireEvent.click(screen.getByRole("button", { name: "版本历史" }));

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

  it("shows restore failures without hiding them behind the settings panel", async () => {
    mocks.fetchVideoStoryboard.mockResolvedValue({ ok: true, scenes: [scene(1)] });
    mocks.fetchVideoProjectVersions.mockResolvedValue({ ok: true, versions: [{ id: "backup-1", createdAt: "2026-10-12T10:00:00", label: "之前的版本", reason: "ai-change", changedSceneIndices: [1] }] });
    mocks.restoreVideoProjectVersion.mockResolvedValueOnce({ ok: false, error: "internal restore trace" });
    render(wrap(<ProducingPhase projectName="proj" />));
    fireEvent.click(await screen.findByRole("button", { name: "设置" }));
    fireEvent.click(screen.getByRole("button", { name: "版本历史" }));
    fireEvent.click(await screen.findByRole("button", { name: "恢复" }));
    expect(await screen.findByRole("dialog", { name: "操作遇到问题" })).toHaveTextContent("请检查当前视频后重试");
    expect(screen.queryByText("internal restore trace")).not.toBeInTheDocument();
    expect(mocks.restoreVideoProjectVersion).toHaveBeenCalledOnce();
  });

  it("requests changing text, voice, and subtitles in the same Agent turn", async () => {
    const client = makeClient();
    const onRequestAgent = vi.fn();
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

    render(
      wrap(
        <ProducingPhase projectName="proj" onRequestAgent={onRequestAgent} />,
        client,
      ),
    );
    fireEvent.click(await screen.findByRole("button", { name: "设置" }));
    fireEvent.click(screen.getByRole("button", { name: "换语言" }));
    expect(
      screen.getByRole("radio", { name: "简体中文（当前）" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("radio", { name: "English" }));
    const createButtons = screen.getAllByRole("button", {
      name: "换语言",
    });
    fireEvent.click(createButtons[createButtons.length - 1]);

    await waitFor(() => expect(onRequestAgent).toHaveBeenCalledOnce());
    expect(onRequestAgent).toHaveBeenCalledWith(expect.stringMatching(/English.*旁白与画面文字.*等待导演台确认/));
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

    expect(
      await screen.findByRole("slider", { name: "场景播放位置" }),
    ).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "设置" }));
    fireEvent.click(screen.getByRole("button", { name: "显示字幕与动画位置" }));
    expect(screen.getByText("画面节拍")).toBeInTheDocument();
    expect(screen.getByText("字幕与画面同步")).toBeInTheDocument();
    expect(screen.getByTitle("标题 · 0.0–0.8 秒")).toBeInTheDocument();
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
    fireEvent.click(await screen.findByRole("button", { name: "设置" }));
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
    expect(await screen.findByText("预计时长")).toBeInTheDocument();
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
      wrap(<StoryboardPhase projectName="proj" />, client),
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
    expect(await screen.findByText("制作中")).toBeInTheDocument();

    // 画面制作完成后，历史列表同步可导出状态。
    mocks.fetchVideoProjects.mockResolvedValue({
      projects: [
        {
          name: "新项目",
          createdAt: 1,
          resolution: "1920x1080",
          phase: "exportable",
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

    expect(await screen.findByText("待导出")).toBeInTheDocument();
    expect(screen.queryByText("制作中")).not.toBeInTheDocument();
  });
});
