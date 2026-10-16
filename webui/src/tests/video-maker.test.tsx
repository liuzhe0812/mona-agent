import {
  act,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProducingPhase } from "@/components/doc/video/ProducingPhase";
import { StoryboardPhase } from "@/components/doc/video/StoryboardPhase";
import { VideoStyleGallery } from "@/components/doc/video/VideoStyleGallery";
import { VideoMakerView, type EmbeddedVideoProject } from "@/components/doc/video/VideoMakerView";
import { ClientProvider } from "@/providers/ClientProvider";
import type { VideoScene, VideoSceneWithHtml, VideoStyleTemplate, VideoTtsConfig } from "@/lib/api";
import { useVideoRuntimeDownloadStore } from "@/lib/video-runtime-download-store";

const mocks = vi.hoisted(() => ({
  addVideoScene: vi.fn(),
  archiveVideoProject: vi.fn(),
  buildVideoDownloadUrl: vi.fn(() => "http://download/url"),
  fetchVideoPreviewFullHtml: vi.fn(async () => "<!doctype html><html><body>整片画面</body></html>"),
  cancelVideoExport: vi.fn(async () => ({ ok: true, stage: "cancelling" })),
  copyVideoProject: vi.fn(),
  confirmVideoProjectPlan: vi.fn(),
  createVideoSeries: vi.fn(),
  createVideoProject: vi.fn(),
  deleteVideoSeries: vi.fn(),
  deleteVideoProject: vi.fn(),
  deleteVideoScene: vi.fn(),
  downloadMediaUrl: vi.fn(async () => true),
  downloadVideoRuntime: vi.fn(),
  exportVideoProject: vi.fn(),
  fetchSceneAudioMixBytes: vi.fn(async (
    _token: string,
    _name: string,
    _index: number,
    _signal?: AbortSignal,
  ): Promise<Blob | null> => null),
  fetchSceneNarrationBytes: vi.fn(async (
    _token: string,
    _name: string,
    _index: number,
  ): Promise<Blob | null> => null),
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
  fetchVideoSessionModelBinding: vi.fn(async () => null),
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
  fetchVideoStyleTemplates: vi.fn(),
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
vi.mock("@/components/doc/video/VideoModelSelector", () => ({ VideoModelSelector: ({ value, onChange, disabled }: any) => <button disabled={disabled} aria-label="选择制作模型" onClick={() => onChange({ executor: "codex", model: "gpt-6.1-sol", provider: null, effort: "high" })}>{value?.model ?? "跟随 Mona"}</button> }));

const stylePreviewPaths = (id: string) => ({
  poster: `/api/video/style/templates/${id}/preview?kind=poster`,
  motion: `/api/video/style/templates/${id}/preview?kind=motion`,
});

const videoStyleTemplateFixture: VideoStyleTemplate[] = [
  { id: "minimal-business", name: "简洁浅色", description: "浅色背景与清晰层级。" },
  { id: "tech-dark", name: "专业深色", description: "深色背景与冷色重点。" },
  { id: "editorial-magazine", name: "编辑排版", description: "对比鲜明的文字层级。" },
  { id: "knowledge-cards", name: "清晰教学", description: "清晰分组的信息样式。" },
  { id: "dashi-notebook", name: "手绘笔记", description: "米白纸面与手写线稿。", preview: stylePreviewPaths("dashi-notebook") },
  { id: "dashi-flow", name: "扁平流程图", description: "奶油底色与琥珀流程图。", preview: stylePreviewPaths("dashi-flow") },
  { id: "dashi-cartoon", name: "立体卡通", description: "深色背景与立体插画。", preview: stylePreviewPaths("dashi-cartoon") },
  { id: "dashi-collage", name: "超现实拼贴", description: "米灰纸底与概念拼贴。", preview: stylePreviewPaths("dashi-collage") },
  { id: "dashi-paper", name: "复古剪纸", description: "奶油纸与剪纸画面。", preview: stylePreviewPaths("dashi-paper") },
  { id: "dashi-editorial", name: "复古报刊", description: "报纸版式与藏蓝色调。", preview: stylePreviewPaths("dashi-editorial") },
  { id: "dashi-tech", name: "黑底科技", description: "深色背景与暖金线条。", preview: stylePreviewPaths("dashi-tech") },
];

vi.mock("@/lib/tauri", () => ({
  downloadMediaUrl: mocks.downloadMediaUrl,
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

it("shows speech preparation and animation inspection as distinct production stages", async () => {
  const client = makeClient();
  mocks.fetchVideoStoryboard.mockResolvedValue({ok: true, scenes: [scene(1)]});
  render(wrap(<VideoMakerView initialProject={{name: "proj", phase: "storyboard", chatId: "video-progress"}} />, client));
  expect(await screen.findByRole("heading", { name: "proj" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "导演台" })).toHaveAttribute("aria-pressed", "true");
  act(() => {
    client.__emitRunStatus("video-progress", Date.now() / 1000);
    client.__emitChat("video-progress", {event: "message", tool_events: [{name: "video", arguments: {action: "audio", scene_index: 2}}]});
  });
  expect(screen.getByText("正在生成第 2 段配音")).toBeInTheDocument();
  act(() => {
    client.__emitChat("video-progress", {event: "message", tool_events: [{name: "video", arguments: {action: "preview", scene_index: 2}}]});
  });
  expect(screen.getByText("正在检查第 2 段动画")).toBeInTheDocument();
  expect(screen.queryByText(/正在检查.*声音/)).not.toBeInTheDocument();
});

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

async function openMenu(button: HTMLElement) {
  await userEvent.setup().click(button);
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
  mocks.fetchVideoSessionModelBinding.mockReset().mockResolvedValue(null);
  mocks.fetchVideoProject.mockReset().mockResolvedValue({
    name: "proj",
    resolution: "1920x1080",
    outputStale: false,
    phase: "storyboard",
    meta: { narrationEnabled: false },
  });
  mocks.createVideoProject.mockReset();
  mocks.downloadMediaUrl.mockReset().mockResolvedValue(true);
  mocks.saveVideoChatId.mockReset().mockResolvedValue({ ok: true });
  mocks.fetchSceneNarrationBytes.mockReset().mockResolvedValue(null);
  mocks.fetchSceneAudioMixBytes.mockReset().mockResolvedValue(null);
  mocks.fetchVideoPreviewFullHtml.mockReset().mockResolvedValue("<!doctype html><html><body>整片画面</body></html>");
  mocks.fetchVideoStyleTemplates.mockReset().mockResolvedValue({
    templates: videoStyleTemplateFixture,
  });
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

  it("keeps a confirmed storyboard readable and auditionable without edit controls", async () => {
    mocks.fetchVideoProject.mockResolvedValue({
      name: "proj",
      resolution: "1920x1080",
      phase: "producing",
      meta: { narrationEnabled: true, requirePlanApproval: true, planRevision: 4, approvedPlanRevision: 4 },
    });
    mocks.fetchVideoStoryboard.mockResolvedValue({ ok: true, planRevision: 4, scenes: [scene(1)] });
    mocks.fetchSceneNarrationBytes.mockResolvedValue(new Blob(["voice"], { type: "audio/mpeg" }));
    const originalCreateObjectUrl = URL.createObjectURL;
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:storyboard-audition"),
    });
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);

    render(wrap(<StoryboardPhase projectName="proj" readOnly />));

    expect(await screen.findByDisplayValue("场景1")).toHaveAttribute("readonly");
    expect(screen.getByLabelText("场景时长（秒）")).toHaveAttribute("readonly");
    expect(screen.getByLabelText("旁白文本")).toHaveAttribute("readonly");
    expect(screen.getByLabelText("画面描述")).toHaveAttribute("readonly");
    expect(screen.getByLabelText("画面如何变化")).toHaveAttribute("readonly");
    expect(screen.queryByRole("button", { name: "新增场景" })).not.toBeInTheDocument();
    expect(screen.queryByTitle("上移")).not.toBeInTheDocument();
    expect(screen.queryByTitle("下移")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "删除场景" })).not.toBeInTheDocument();

    const audition = await screen.findByRole("button", { name: "试听" });
    expect(audition).toBeEnabled();
    fireEvent.click(audition);
    await waitFor(() => expect(mocks.fetchSceneNarrationBytes).toHaveBeenCalledWith("tok", "proj", 1));
    await waitFor(() => expect(play).toHaveBeenCalled());
    expect(mocks.updateVideoScene).not.toHaveBeenCalled();
    expect(mocks.addVideoScene).not.toHaveBeenCalled();
    expect(mocks.deleteVideoScene).not.toHaveBeenCalled();
    expect(mocks.reorderVideoScenes).not.toHaveBeenCalled();

    play.mockRestore();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: originalCreateObjectUrl });
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

  it("edits long content segments without clamping them to thirty seconds", async () => {
    mocks.fetchVideoStoryboard.mockResolvedValue({ok: true, scenes: [scene(1, {duration: 70})]});
    mocks.updateVideoScene.mockResolvedValue({ok: true, scene: scene(1, {duration: 150})});
    render(wrap(<StoryboardPhase projectName="proj" />));
    const seconds = await screen.findByRole("spinbutton", {name: "场景时长（秒）"});
    expect(seconds).toHaveValue(70);
    const slider = screen.getByRole("slider", {name: "时长（秒）"}) as HTMLInputElement;
    expect(Number(slider.max)).toBeGreaterThanOrEqual(70);
    fireEvent.change(seconds, {target: {value: ""}});
    expect(screen.getByText("请输入大于零的秒数。")).toBeInTheDocument();
    expect(mocks.updateVideoScene).not.toHaveBeenCalled();
    fireEvent.change(seconds, {target: {value: "150"}});
    await waitFor(() => expect(mocks.updateVideoScene).toHaveBeenCalledWith("tok", "proj", {index: 1, duration: 150}));
    fireEvent.blur(seconds);
    expect(seconds).toHaveValue(150);
    expect(Number(slider.max)).toBeGreaterThanOrEqual(150);
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
    const htmlStatus = overrides.htmlStatus ?? "pending";
    const hasHtml = ["previewing", "confirmed"].includes(htmlStatus);
    return {
      ...scene(index),
      htmlStatus,
      htmlPath: overrides.htmlPath ?? (hasHtml ? `drafts/scene_${index}.html` : undefined),
      ...overrides,
    };
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
    expect(onRequestAgent).toHaveBeenCalledWith(
      expect.stringContaining("场景 1"),
      expect.any(String),
    );
    mocks.fetchVideoStoryboard.mockResolvedValue({ ok: true, scenes: [producingScene(1, { htmlStatus: "previewing", htmlMtime: 100 })] });
    act(() => client.__emitVideoProjectChanged({ projectName: "proj", hint: "scenes" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "导出视频" })).toBeEnabled());
    expect(await screen.findByRole("button", { name: "播放当前场景" })).toBeEnabled();
    expect(onRequestAgent).toHaveBeenCalledOnce();
  });

  it("keeps an existing preview and offers whole-production retry after a task error", async () => {
    const onRequestAgent = vi.fn();
    const onRetryGeneration = vi.fn();
    mocks.fetchVideoStoryboard.mockResolvedValue({
      ok: true,
      scenes: [
        producingScene(1, { htmlStatus: "previewing", htmlMtime: 100 }),
        producingScene(2),
      ],
    });
    mocks.fetchScenePreviewHtml.mockResolvedValue({
      html: "<html>scene</html>",
      needsGeneration: false,
    });

    render(
      wrap(
        <ProducingPhase
          projectName="proj"
          onRequestAgent={onRequestAgent}
          generationError="视频任务未能启动，请重试。"
          onRetryGeneration={onRetryGeneration}
        />,
      ),
    );

    expect(await screen.findByRole("dialog", { name: "视频制作遇到问题" })).toHaveTextContent("视频任务未能启动，请重试。");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "继续制作" }));

    expect(onRetryGeneration).toHaveBeenCalledOnce();
    expect(onRequestAgent).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "播放当前场景" })).toBeInTheDocument();
    expect(screen.getByText("场景 · 2 段")).toBeInTheDocument();
  });

  it("does not reopen a dismissed task error on refresh and retries all scenes from the empty state", async () => {
    const client = makeClient();
    const onRequestAgent = vi.fn();
    const onRetryGeneration = vi.fn();
    mocks.fetchVideoStoryboard.mockResolvedValue({ ok: true, scenes: [producingScene(1)] });
    const renderPhase = (generationError: string | null) =>
      wrap(
        <ProducingPhase
          projectName="proj"
          onRequestAgent={onRequestAgent}
          generationError={generationError}
          onRetryGeneration={onRetryGeneration}
        />,
        client,
      );
    const { rerender } = render(renderPhase("视频任务未能启动，请重试。"));

    expect(await screen.findByRole("dialog", { name: "视频制作遇到问题" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("dialog", { name: "视频制作遇到问题" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "继续制作" })).toBeInTheDocument();

    const sceneLoadsBefore = mocks.fetchVideoStoryboard.mock.calls.length;
    act(() => {
      client.__emitVideoProjectChanged({ projectName: "proj", hint: "scenes" });
    });
    await waitFor(() => expect(mocks.fetchVideoStoryboard.mock.calls.length).toBeGreaterThan(sceneLoadsBefore));
    expect(screen.queryByRole("dialog", { name: "视频制作遇到问题" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "继续制作" }));
    expect(onRetryGeneration).toHaveBeenCalledOnce();
    expect(onRequestAgent).not.toHaveBeenCalled();

    rerender(renderPhase(null));
    rerender(renderPhase("视频任务未能启动，请重试。"));
    expect(await screen.findByRole("dialog", { name: "视频制作遇到问题" })).toBeInTheDocument();
  });

  it("regenerates the selected scene from its actions menu", async () => {
    const onRequestAgent = vi.fn();
    mocks.fetchVideoStoryboard.mockResolvedValue({
      ok: true,
      scenes: [
        producingScene(1, { title: "开场", htmlStatus: "previewing", htmlMtime: 100 }),
        producingScene(2, { title: "数据对比", htmlStatus: "previewing", htmlMtime: 200 }),
      ],
    });
    mocks.fetchScenePreviewHtml.mockResolvedValue({ html: "<html>scene</html>", needsGeneration: false });
    render(wrap(<ProducingPhase projectName="proj" onRequestAgent={onRequestAgent} />));
    fireEvent.click(await screen.findByRole("option", { name: "场景 2 数据对比，草稿已生成" }));
    const playhead = await screen.findByRole("slider", { name: "场景播放位置" });
    fireEvent.change(playhead, { target: { value: "3500" } });
    await openMenu(screen.getByRole("button", { name: "片段操作" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "重新制作当前片段" }));
    await waitFor(() => expect(onRequestAgent).toHaveBeenCalledOnce());
    expect(onRequestAgent).toHaveBeenLastCalledWith(
      expect.stringContaining("请重新制作场景 2「数据对比」"),
      expect.any(String),
    );
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

  it("plays the enlarged scene with pause and seek controls", async () => {
    mocks.fetchVideoStoryboard.mockResolvedValue({ ok: true, scenes: [producingScene(1, { htmlStatus: "previewing" })] });
    mocks.fetchScenePreviewHtml.mockResolvedValue({ html: "<html>scene</html>", needsGeneration: false });
    render(wrap(<ProducingPhase projectName="proj" />));
    fireEvent.click(await screen.findByRole("button", { name: "全屏预览当前场景" }));
    const dialog = await screen.findByRole("dialog", { name: "场景 1 全屏预览" });
    fireEvent.click(await within(dialog).findByRole("button", { name: "暂停当前场景" }));
    fireEvent.change(within(dialog).getByRole("slider", { name: "场景播放位置" }), { target: { value: "2000" } });
    expect(within(dialog).getByText("2.0s / 5.0s")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "播放当前场景" })).toBeEnabled();
    fireEvent.click(within(dialog).getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("dialog", { name: "场景 1 全屏预览" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "播放当前场景" })).toBeInTheDocument();
  });

  it("shows full preview loading and aborts preparation when closed", async () => {
    mocks.fetchVideoStoryboard.mockResolvedValue({ ok: true, scenes: [producingScene(1, { htmlStatus: "previewing" })] });
    mocks.fetchScenePreviewHtml.mockResolvedValue({ html: "<html>scene</html>", needsGeneration: false });
    let resolvePreview: (html: string) => void = () => {};
    mocks.fetchVideoPreviewFullHtml.mockImplementationOnce(() => new Promise<string>((resolve) => { resolvePreview = resolve; }));
    render(wrap(<ProducingPhase projectName="proj" />));
    fireEvent.click(await screen.findByRole("button", { name: "预览整片" }));
    const dialog = await screen.findByRole("dialog", { name: "proj · 整片预览" });
    expect(within(dialog).getByText("正在准备整片画面与声音…")).toBeInTheDocument();
    expect(mocks.fetchVideoPreviewFullHtml).toHaveBeenCalledWith("tok", "proj", expect.any(AbortSignal));
    const signal = mocks.fetchVideoPreviewFullHtml.mock.calls[0][2];
    fireEvent.click(within(dialog).getByRole("button", { name: "关闭" }));
    expect(signal.aborted).toBe(true);
    await act(async () => resolvePreview("<html>late preview</html>"));
    expect(screen.queryByTitle("proj 整片预览")).not.toBeInTheDocument();
  });

  it("shows full preview preparation errors and loads playable content after retry", async () => {
    mocks.fetchVideoStoryboard.mockResolvedValue({ ok: true, scenes: [producingScene(1, { htmlStatus: "previewing" })] });
    mocks.fetchScenePreviewHtml.mockResolvedValue({ html: "<html>scene</html>", needsGeneration: false });
    mocks.fetchVideoPreviewFullHtml.mockRejectedValueOnce(new Error("整片预览未能准备，请稍后重试。"));
    render(wrap(<ProducingPhase projectName="proj" />));
    fireEvent.click(await screen.findByRole("button", { name: "预览整片" }));
    const dialog = await screen.findByRole("dialog", { name: "proj · 整片预览" });
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("整片预览未能准备");
    expect(within(dialog).queryByTitle("proj 整片预览")).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "重试预览" }));
    expect(await within(dialog).findByTitle("proj 整片预览")).toHaveAttribute("srcdoc", expect.stringContaining("整片画面"));
  });

  it("keeps project settings local until save and discards them on cancel", async () => {
    const onRequestAgent = vi.fn();
    mocks.fetchVideoProject.mockResolvedValue({
      name: "proj",
      resolution: "1920x1080",
      phase: "producing",
      aspectVariant: "16:9",
      language: "zh-CN",
      meta: {
        narrationEnabled: true,
        ttsProvider: "edge",
        ttsVoice: "zh-CN-XiaoyiNeural",
        ttsRate: "+0%",
        subtitleMode: "burned",
      },
    });
    mocks.fetchVideoStoryboard.mockResolvedValue({
      ok: true,
      scenes: [producingScene(1, { htmlStatus: "previewing" })],
    });
    mocks.fetchScenePreviewHtml.mockResolvedValue({
      html: "<html>scene</html>",
      needsGeneration: false,
    });

    render(wrap(<ProducingPhase projectName="proj" onRequestAgent={onRequestAgent} />));
    fireEvent.click(await screen.findByRole("button", { name: "设置" }));
    const settings = await screen.findByRole("dialog", { name: "视频设置" });
    expect(within(settings).queryByRole("button", { name: /生成|重新制作|导出|版本历史/ })).not.toBeInTheDocument();
    expect(settings).not.toHaveTextContent("审阅意见");
    expect(screen.getByRole("button", { name: "画面比例" })).toHaveTextContent("横屏 · 16:9");
    expect(screen.getByRole("button", { name: "视频语言" })).toHaveTextContent("简体中文");
    expect(screen.getByRole("checkbox", { name: "启用旁白配音" })).toBeChecked();
    expect(screen.getByRole("button", { name: "配音来源" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "配音音色" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "语速" })).toHaveTextContent("正常");
    expect(screen.getByRole("button", { name: "字幕交付方式" })).toHaveTextContent("视频内字幕");
    expect(screen.getByRole("checkbox", { name: "显示辅助线和时间轴详情" })).toBeInTheDocument();

    await openMenu(screen.getByRole("button", { name: "画面比例" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "方形 · 1:1" }));
    await openMenu(screen.getByRole("button", { name: "视频语言" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "English" }));
    await openMenu(screen.getByRole("button", { name: "语速" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "稍快 (+10%)" }));
    await openMenu(screen.getByRole("button", { name: "字幕交付方式" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "外挂字幕文件" }));
    expect(mocks.updateVideoProjectSettings).not.toHaveBeenCalled();
    expect(onRequestAgent).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("dialog", { name: "视频设置" })).not.toBeInTheDocument();
    expect(mocks.updateVideoProjectSettings).not.toHaveBeenCalled();
    expect(onRequestAgent).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    await screen.findByRole("dialog", { name: "视频设置" });
    expect(screen.getByRole("button", { name: "画面比例" })).toHaveTextContent("横屏 · 16:9");
    expect(screen.getByRole("button", { name: "视频语言" })).toHaveTextContent("简体中文");
    expect(screen.getByRole("button", { name: "语速" })).toHaveTextContent("正常");
    expect(screen.getByRole("button", { name: "字幕交付方式" })).toHaveTextContent("视频内字幕");
  });

  it("keeps failed voice settings for a successful retry", async () => {
    const onRequestAgent = vi.fn();
    let serverVoice: VideoTtsConfig = {
      narrationEnabled: true,
      ttsProvider: "edge",
      ttsVoice: "zh-CN-XiaoyiNeural",
      ttsRate: "+0%",
      subtitleMode: "burned" as const,
    };
    mocks.fetchVideoProject.mockImplementation(async () => ({
      name: "proj",
      resolution: "1920x1080",
      phase: "producing",
      aspectVariant: "16:9",
      language: "zh-CN",
      meta: serverVoice,
    }));
    mocks.fetchVideoStoryboard.mockResolvedValue({
      ok: true,
      scenes: [producingScene(1, { htmlStatus: "previewing" })],
    });
    mocks.fetchScenePreviewHtml.mockResolvedValue({
      html: "<html>scene</html>",
      needsGeneration: false,
    });
    mocks.updateVideoProjectSettings
      .mockImplementationOnce(async () => ({ ok: false, error: "save failed" }))
      .mockImplementationOnce(async (_token: string, _name: string, settings: VideoTtsConfig) => {
        serverVoice = { ...settings };
        return { ok: true, meta: serverVoice };
      });

    render(wrap(<ProducingPhase projectName="proj" onRequestAgent={onRequestAgent} />));
    fireEvent.click(await screen.findByRole("button", { name: "设置" }));
    await screen.findByRole("dialog", { name: "视频设置" });
    await openMenu(screen.getByRole("button", { name: "语速" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "稍快 (+10%)" }));
    await openMenu(screen.getByRole("button", { name: "字幕交付方式" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "外挂字幕文件" }));

    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
    await waitFor(() => expect(mocks.updateVideoProjectSettings).toHaveBeenCalledOnce());
    const settingsDialog = screen.getByRole("dialog", { name: "视频设置" });
    expect(within(settingsDialog).getByRole("alert")).toHaveTextContent(
      "设置未能保存，当前修改已保留，请重试。",
    );
    expect(within(settingsDialog).getByRole("button", { name: "语速" })).toHaveTextContent("稍快 (+10%)");
    expect(within(settingsDialog).getByRole("button", { name: "字幕交付方式" })).toHaveTextContent("外挂字幕文件");

    fireEvent.click(within(settingsDialog).getByRole("button", { name: "保存设置" }));
    await waitFor(() => expect(mocks.updateVideoProjectSettings).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "视频设置" })).not.toBeInTheDocument());
    expect(mocks.updateVideoProjectSettings).toHaveBeenNthCalledWith(
      2,
      "tok",
      "proj",
      expect.objectContaining({ ttsRate: "+10%", subtitleMode: "external" }),
    );
    expect(onRequestAgent).not.toHaveBeenCalled();
    expect(mocks.createVideoProject).not.toHaveBeenCalled();
    expect(mocks.exportVideoProject).not.toHaveBeenCalled();
  });

  it("saves aspect and language by preparing an unconfirmed plan only", async () => {
    const onRequestAgent = vi.fn();
    mocks.fetchVideoProject.mockResolvedValue({
      name: "proj",
      resolution: "1920x1080",
      phase: "producing",
      aspectVariant: "16:9",
      language: "zh-CN",
      meta: { narrationEnabled: false },
    });
    mocks.fetchVideoStoryboard.mockResolvedValue({
      ok: true,
      scenes: [producingScene(1, { htmlStatus: "previewing" })],
    });
    mocks.fetchScenePreviewHtml.mockResolvedValue({
      html: "<html>scene</html>",
      needsGeneration: false,
    });

    render(wrap(<ProducingPhase projectName="proj" onRequestAgent={onRequestAgent} />));
    fireEvent.click(await screen.findByRole("button", { name: "设置" }));
    await screen.findByRole("dialog", { name: "视频设置" });
    expect(screen.getByRole("button", { name: "字幕交付方式" })).toHaveTextContent("视频内字幕");
    await openMenu(screen.getByRole("button", { name: "画面比例" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "方形 · 1:1" }));
    await openMenu(screen.getByRole("button", { name: "视频语言" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "English" }));
    fireEvent.click(screen.getByRole("button", { name: "保存并更新方案" }));

    await waitFor(() => expect(onRequestAgent).toHaveBeenCalledOnce());
    expect(onRequestAgent).toHaveBeenCalledWith(
      expect.stringMatching(/方形.*English.*video\.plan.*只准备方案.*等待导演台确认/),
      expect.stringMatching(/^更新视频设置：画面改成方形.*；语言改成English。$/),
    );
    expect(mocks.updateVideoProjectSettings).not.toHaveBeenCalled();
    expect(mocks.updateVideoScene).not.toHaveBeenCalled();
    expect(mocks.addVideoScene).not.toHaveBeenCalled();
    expect(mocks.exportVideoProject).not.toHaveBeenCalled();
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
    mocks.fetchSceneAudioMixBytes.mockResolvedValue(
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
    expect(mocks.fetchSceneAudioMixBytes).toHaveBeenCalledWith(
      "tok",
      "proj",
      1,
      expect.any(AbortSignal),
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

  it("does not silently play when the audio mix fails and resumes after a retry", async () => {
    const originalCreateObjectUrl = URL.createObjectURL;
    const originalRevokeObjectUrl = URL.revokeObjectURL;
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:scene-mix"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const audioBlob = new Blob(["mixed-audio"], { type: "audio/mpeg" });
    let retryRequested = false;
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
    mocks.fetchSceneAudioMixBytes.mockImplementation(async () => {
      if (!retryRequested) throw new Error("HTTP 500");
      return audioBlob;
    });

    const { unmount } = render(wrap(<ProducingPhase projectName="proj" />));
    expect(await screen.findByRole("dialog", { name: "视频声音未能准备" })).toBeInTheDocument();
    expect(play).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    const retry = await screen.findByRole("button", { name: "重试播放" });
    expect(retry).toBeEnabled();
    retryRequested = true;
    fireEvent.click(retry);

    await waitFor(() => expect(mocks.fetchSceneAudioMixBytes.mock.calls.length).toBeGreaterThan(1));
    await waitFor(() => expect(play).toHaveBeenCalledOnce());
    expect(await screen.findByRole("button", { name: "暂停当前场景" })).toBeInTheDocument();
    expect(mocks.fetchSceneNarrationBytes).not.toHaveBeenCalled();

    unmount();
    play.mockRestore();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: originalCreateObjectUrl });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: originalRevokeObjectUrl });
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
    await openMenu(await screen.findByRole("button", { name: "片段操作" }));
    const playNarration = await screen.findByRole("menuitem", { name: "试听这段旁白" });
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
    await openMenu(await screen.findByRole("button", { name: "片段操作" }));
    expect(await screen.findByRole("menuitem", { name: "试听这段旁白" })).toBeEnabled();

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

  it("plays an available audio mix when narration is disabled", async () => {
    const originalCreateObjectUrl = URL.createObjectURL;
    const originalRevokeObjectUrl = URL.revokeObjectURL;
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:music-only-mix"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const audioBlob = new Blob(["music-only-mix"], { type: "audio/mpeg" });
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
    mocks.fetchSceneAudioMixBytes.mockResolvedValue(audioBlob);

    const { unmount } = render(wrap(<ProducingPhase projectName="proj" />));
    const playTimeline = await screen.findByRole("button", { name: "播放当前场景" });
    await waitFor(() => expect(playTimeline).toBeEnabled());
    fireEvent.click(playTimeline);

    await waitFor(() => expect(play).toHaveBeenCalledOnce());
    expect(
      await screen.findByRole("button", { name: "暂停当前场景" }),
    ).toBeInTheDocument();
    expect(mocks.fetchSceneAudioMixBytes).toHaveBeenCalledWith("tok", "proj", 1, expect.any(AbortSignal));
    expect(mocks.fetchSceneNarrationBytes).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    unmount();
    play.mockRestore();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: originalCreateObjectUrl });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: originalRevokeObjectUrl });
  });

  it("does not start a late mix after the user switches scenes during an audio retry", async () => {
    const originalCreateObjectUrl = URL.createObjectURL;
    const originalRevokeObjectUrl = URL.revokeObjectURL;
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:scene-mix"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const audioBlob = new Blob(["mixed-audio"], { type: "audio/mpeg" });
    let sceneOneRequests = 0;
    let resolveSceneOneRetry: ((value: Blob | null) => void) | null = null;
    mocks.fetchVideoProject.mockResolvedValue({
      name: "proj",
      resolution: "1920x1080",
      outputStale: false,
      phase: "producing",
      meta: { narrationEnabled: true },
    });
    mocks.fetchVideoStoryboard.mockResolvedValue({
      ok: true,
      scenes: [
        producingScene(1, { title: "开场", htmlStatus: "previewing", htmlMtime: 100 }),
        producingScene(2, { title: "结尾", htmlStatus: "previewing", htmlMtime: 200 }),
      ],
    });
    mocks.fetchScenePreviewHtml.mockResolvedValue({ html: "<html>scene</html>", needsGeneration: false });
    mocks.fetchSceneAudioMixBytes.mockImplementation((_token, _name, index) => {
      if (index === 1) {
        sceneOneRequests += 1;
        if (sceneOneRequests === 1) return Promise.reject(new Error("mix unavailable"));
        if (sceneOneRequests === 2) {
          return new Promise((resolve) => { resolveSceneOneRetry = resolve; });
        }
      }
      return Promise.resolve(audioBlob);
    });

    const { unmount } = render(wrap(<ProducingPhase projectName="proj" />));
    expect(await screen.findByRole("dialog", { name: "视频声音未能准备" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    fireEvent.click(await screen.findByRole("button", { name: "重试播放" }));
    await waitFor(() => expect(sceneOneRequests).toBe(2));
    expect(resolveSceneOneRetry).not.toBeNull();

    fireEvent.click(await screen.findByRole("option", { name: "场景 2 结尾，草稿已生成" }));
    const playTimeline = await screen.findByRole("button", { name: "播放当前场景" });
    await waitFor(() => expect(playTimeline).toBeEnabled());
    resolveSceneOneRetry?.(audioBlob);
    await act(async () => {});

    expect(play).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "暂停当前场景" })).not.toBeInTheDocument();
    expect(mocks.fetchSceneAudioMixBytes.mock.calls.some(([, , index]) => index === 2)).toBe(true);

    unmount();
    play.mockRestore();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: originalCreateObjectUrl });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: originalRevokeObjectUrl });
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
    mocks.fetchSceneAudioMixBytes
      .mockRejectedValueOnce(new Error("HTTP 500"))
      .mockResolvedValue(audioBlob);
    mocks.fetchSceneNarrationBytes.mockResolvedValue(audioBlob);

    render(wrap(<ProducingPhase projectName="proj" />));
    expect(await screen.findByRole("dialog", { name: "视频声音未能准备" })).toHaveTextContent("视频声音未能准备");
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(await screen.findByRole("button", { name: "重试播放" })).toBeEnabled();
    expect(mocks.fetchSceneAudioMixBytes).toHaveBeenCalledTimes(1);

    await openMenu(await screen.findByRole("button", { name: "片段操作" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "试听这段旁白" }));
    await waitFor(() =>
      expect(mocks.fetchSceneNarrationBytes).toHaveBeenCalledTimes(1),
    );
    await waitFor(() => expect(mocks.fetchSceneAudioMixBytes).toHaveBeenCalledTimes(2));
    act(() => mediaElements[0]?.dispatchEvent(new Event("ended")));
    const playTimeline = await screen.findByRole("button", { name: "播放当前场景" });
    await waitFor(() => expect(playTimeline).toBeEnabled());
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
    expect(client.sendMessage).toHaveBeenCalledWith("video-chat", expect.any(String), undefined, { agentKind: "video", modelBinding: null, displayContent: "介绍我的产品" });
    expect(await screen.findByRole("button", { name: "导演台" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("doc-chat-panel")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /切换到编辑分镜/ })).not.toBeInTheDocument();
    expect(mocks.fetchVideoRuntimeCheck).not.toHaveBeenCalled();
  });

  it("starts a new video with its chosen native model without changing global settings", async () => {
    const client = makeClient();
    const binding = { executor: "codex", model: "gpt-6.1-sol", provider: null, effort: "high" } as const;
    client.newChat.mockResolvedValue("video-chat");
    mocks.fetchVideoSessionModelBinding.mockResolvedValue(binding);
    render(wrap(<VideoMakerView />, client));
    fireEvent.click(screen.getByRole("button", { name: "选择制作模型" }));
    await screen.findByText("gpt-6.1-sol");
    fireEvent.change(screen.getByLabelText("想做什么视频？"), { target: { value: "介绍我的产品" } });
    fireEvent.click(screen.getByRole("button", { name: "准备分镜" }));
    await waitFor(() => expect(client.sendMessage).toHaveBeenCalledOnce());
    expect(client.newChat).toHaveBeenCalledWith(45000, false, null, "video", binding);
    expect(client.sendMessage.mock.calls[0][3]).toMatchObject({ modelBinding: binding });
  });

  it("tracks the selected scene and playhead as video focus, then clears it on exit", async () => {
    const onFocusChange = vi.fn();
    mocks.fetchVideoProject.mockResolvedValue({
      name: "焦点测试",
      resolution: "1920x1080",
      phase: "storyboard",
      meta: {
        narrationEnabled: true,
        requirePlanApproval: false,
        planRevision: 1,
        approvedPlanRevision: null,
      },
    });
    mocks.fetchVideoStoryboard.mockResolvedValue({
      ok: true,
      planRevision: 1,
      scenes: [
        { ...scene(1, { title: "开场" }), htmlStatus: "previewing", htmlPath: "drafts/scene_1.html" },
        { ...scene(2, { title: "转化对比" }), htmlStatus: "previewing", htmlPath: "drafts/scene_2.html" },
      ],
    });
    mocks.fetchScenePreviewHtml.mockResolvedValue({ html: "<html>scene</html>", needsGeneration: false });
    const { unmount } = render(wrap(
      <VideoMakerView
        initialProject={{ name: "焦点测试", phase: "storyboard", chatId: "focus-chat" }}
        onFocusChange={onFocusChange}
      />,
    ));

    await waitFor(() => expect(onFocusChange).toHaveBeenLastCalledWith({
      projectName: "焦点测试",
      sceneIndex: 1,
      sceneTitle: "开场",
      seconds: null,
    }));
    fireEvent.click(screen.getByRole("button", { name: "场景 2 转化对比" }));
    await waitFor(() => expect(onFocusChange).toHaveBeenLastCalledWith({
      projectName: "焦点测试",
      sceneIndex: 2,
      sceneTitle: "转化对比",
      seconds: null,
    }));

    await waitFor(() => expect(screen.getByRole("button", { name: "视频" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "视频" }));
    await waitFor(() => expect(onFocusChange).toHaveBeenLastCalledWith({
      projectName: "焦点测试",
      sceneIndex: 1,
      sceneTitle: "开场",
      seconds: 0,
    }));
    fireEvent.click(await screen.findByRole("option", { name: "场景 2 转化对比，草稿已生成" }));
    const playhead = await screen.findByRole("slider", { name: "场景播放位置" });
    fireEvent.change(playhead, { target: { value: "2750" } });
    await waitFor(() => expect(onFocusChange).toHaveBeenLastCalledWith({
      projectName: "焦点测试",
      sceneIndex: 2,
      sceneTitle: "转化对比",
      seconds: 2.75,
    }));

    unmount();
    expect(onFocusChange).toHaveBeenLastCalledWith(null);
  });

  it("saves a chosen name, orientation, style, and voice as optional inputs", async () => {
    const client = makeClient();
    client.newChat.mockResolvedValue("video-chat");
    render(wrap(<VideoMakerView />, client));
    fireEvent.change(screen.getByLabelText("想做什么视频？"), { target: { value: "介绍产品" } });
    fireEvent.click(screen.getByRole("button", { name: "更多设置" }));
    fireEvent.change(screen.getByLabelText("视频名称"), { target: { value: "产品介绍" } });
    fireEvent.click(screen.getByRole("button", { name: "竖屏" }));
    const basicPalette = await screen.findByRole("button", { name: "基础配色" });
    expect(screen.queryByRole("button", { name: "选择编辑排版" })).not.toBeInTheDocument();
    fireEvent.click(basicPalette);
    fireEvent.click(await screen.findByRole("button", { name: "选择简洁浅色" }));
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
    await userEvent.click(screen.getByRole("tab", { name: "我的", exact: true }));
    fireEvent.click((await screen.findByText("我的简洁风格")).closest("button")!);
    expect(screen.getByRole("button", { name: "横屏" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "准备分镜" }));
    await waitFor(() => expect(client.sendMessage).toHaveBeenCalledOnce());
    expect(mocks.createVideoProject.mock.calls[0][3]).toMatchObject({ styleSeriesId: "style-a", styleVersion: 2, aspectVariant: "16:9" });
    expect(mocks.createVideoProject.mock.calls[0][3]).not.toHaveProperty("seriesId");
  });

  it("passes a dynamically loaded Dashi style into video creation", async () => {
    const client = makeClient();
    client.newChat.mockResolvedValue("video-chat");
    mocks.fetchVideoStyleTemplates.mockResolvedValue({
      templates: [{
        id: "dashi-flow", name: "扁平流程图", description: "奶油底色与琥珀流程图。",
        preview: stylePreviewPaths("dashi-flow"),
      }],
    });
    render(wrap(<VideoMakerView />, client));
    fireEvent.change(screen.getByLabelText("想做什么视频？"), { target: { value: "解释一个三步流程" } });
    expect(await screen.findByRole("button", { name: /由 Mona 推荐/ })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(await screen.findByRole("button", { name: "选择扁平流程图" }));
    fireEvent.click(screen.getByRole("button", { name: "准备分镜" }));

    await waitFor(() => expect(client.sendMessage).toHaveBeenCalledOnce());
    expect(mocks.createVideoProject).toHaveBeenCalledWith(
      "tok",
      "解释一个三步流程",
      "1920x1080",
      expect.objectContaining({ templateId: "dashi-flow" }),
    );
  });

  it("waits for the Services base, then swaps the style poster and motion on hover", async () => {
    const template = videoStyleTemplateFixture.find((style) => style.id === "dashi-flow")!;
    let resolveServicesBase!: (base: string) => void;
    mocks.getServicesHttpBase.mockReturnValueOnce(new Promise((resolve) => {
      resolveServicesBase = resolve;
    }));
    render(<VideoStyleGallery templates={[template]} selectedId="auto" onSelect={vi.fn()} />);

    const card = await screen.findByRole("button", { name: "选择扁平流程图" });
    await waitFor(() => expect(mocks.getServicesHttpBase).toHaveBeenCalled());
    expect(screen.queryByRole("img")).not.toBeInTheDocument();

    await act(async () => { resolveServicesBase("http://localhost:17174"); });
    const poster = await screen.findByRole("img", { name: "扁平流程图风格样片" });
    expect(poster).toHaveAttribute("src", `http://localhost:17174${template.preview!.poster}`);

    fireEvent.mouseEnter(card.parentElement!);
    await waitFor(() => expect(screen.getByRole("img", { name: "扁平流程图风格样片" }))
      .toHaveAttribute("src", `http://localhost:17174${template.preview!.motion}`));
    fireEvent.mouseLeave(card.parentElement!);
    await waitFor(() => expect(screen.getByRole("img", { name: "扁平流程图风格样片" }))
      .toHaveAttribute("src", `http://localhost:17174${template.preview!.poster}`));
  });

  it("falls back to the poster after motion fails and keeps the style selectable", async () => {
    const template = videoStyleTemplateFixture.find((style) => style.id === "dashi-flow")!;
    const onSelect = vi.fn();
    render(<VideoStyleGallery templates={[template]} selectedId="auto" onSelect={onSelect} />);
    const card = await screen.findByRole("button", { name: "选择扁平流程图" });
    const poster = await screen.findByRole("img", { name: "扁平流程图风格样片" });
    expect(poster).toHaveAttribute("src", `http://localhost:17174${template.preview!.poster}`);

    fireEvent.mouseEnter(card.parentElement!);
    const motion = await waitFor(() => {
      const image = screen.getByRole("img", { name: "扁平流程图风格样片" });
      expect(image).toHaveAttribute("src", `http://localhost:17174${template.preview!.motion}`);
      return image;
    });
    fireEvent.error(motion);
    await waitFor(() => expect(screen.getByRole("img", { name: "扁平流程图风格样片" }))
      .toHaveAttribute("src", `http://localhost:17174${template.preview!.poster}`));

    expect(card).toBeEnabled();
    fireEvent.click(card);
    expect(onSelect).toHaveBeenCalledWith("dashi-flow");
  });

  it("applies an enlarged Dashi preview and sends the selected style ID", async () => {
    const client = makeClient();
    client.newChat.mockResolvedValue("video-chat");
    render(wrap(<VideoMakerView />, client));
    fireEvent.change(screen.getByLabelText("想做什么视频？"), { target: { value: "解释一个三步流程" } });

    fireEvent.click(await screen.findByRole("button", { name: "放大预览扁平流程图" }));
    const dialog = await screen.findByRole("dialog", { name: "扁平流程图" });
    expect(await within(dialog).findByRole("img", { name: "扁平流程图动态样片" }))
      .toHaveAttribute("src", `http://localhost:17174${stylePreviewPaths("dashi-flow").motion}`);
    fireEvent.click(within(dialog).getByRole("button", { name: "使用这个风格" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "扁平流程图" })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "选择扁平流程图" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "准备分镜" }));
    await waitFor(() => expect(client.sendMessage).toHaveBeenCalledOnce());
    expect(mocks.createVideoProject.mock.calls[0][3]).toMatchObject({ templateId: "dashi-flow" });
  });

  it("disables Dashi selection, enlargement, and automatic style while creating", async () => {
    const template = videoStyleTemplateFixture.find((style) => style.id === "dashi-flow")!;
    const onSelect = vi.fn();
    render(<VideoStyleGallery templates={[template]} selectedId="dashi-flow" disabled onSelect={onSelect} />);

    expect(await screen.findByRole("button", { name: "选择扁平流程图" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "放大预览扁平流程图" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /由 Mona 推荐/ })).toBeDisabled();
    expect(onSelect).not.toHaveBeenCalled();
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
    await waitFor(() => expect(screen.getByRole("button", { name: "选择制作模型" })).toBeEnabled());
    fireEvent.change(screen.getByLabelText("想做什么视频？"), { target: { value: "给新用户介绍产品" } });
    fireEvent.click(screen.getByRole("button", { name: "准备分镜" }));
    await waitFor(() => expect(onSendVideoTurn).toHaveBeenCalledOnce());
    expect(onSendVideoTurn).toHaveBeenCalledWith(expect.stringContaining("用 video.plan 保存方案"), "给新用户介绍产品", null);
    expect(client.newChat).not.toHaveBeenCalled();
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(screen.queryByTestId("doc-chat-panel")).not.toBeInTheDocument();
  });

  it("creates an embedded conversation only after preparing the plan and sends its first turn to the new id", async () => {
    const client = makeClient();
    const onSendVideoTurn = vi.fn();
    const binding = { executor: "codex", model: "gpt-6.1-sol", provider: null, effort: "high" } as const;
    let resolveChat!: (chatId: string) => void;
    client.newChat.mockImplementation(() => new Promise((resolve) => { resolveChat = resolve; }));
    mocks.fetchVideoSessionModelBinding.mockResolvedValue(binding);
    function Workspace() {
      const [project, setProject] = useState<EmbeddedVideoProject | null>(null);
      return <VideoMakerView embedded hostChatId={project?.chatId ?? null} initialProject={project} onProjectChange={setProject} onSendVideoTurn={onSendVideoTurn} />;
    }
    render(wrap(<Workspace />, client));
    fireEvent.change(screen.getByLabelText("想做什么视频？"), { target: { value: "延迟创建会话" } });
    fireEvent.click(screen.getByRole("button", { name: "选择制作模型" }));
    await screen.findByText("gpt-6.1-sol");
    expect(client.newChat).not.toHaveBeenCalled();
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(mocks.createVideoProject).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "准备分镜" }));
    await waitFor(() => expect(client.newChat).toHaveBeenCalledWith(45000, false, null, "video", binding));
    expect(client.sendMessage).not.toHaveBeenCalled();
    await act(async () => resolveChat("lazy-video-chat"));
    await waitFor(() => expect(client.sendMessage).toHaveBeenCalledOnce());
    expect(client.sendMessage).toHaveBeenCalledWith("lazy-video-chat", expect.stringContaining("用 video.plan 保存方案"), undefined,
      { agentKind: "video", modelBinding: binding, displayContent: "延迟创建会话" });
    expect(mocks.saveVideoChatId).toHaveBeenCalledWith("tok", "延迟创建会话", "lazy-video-chat");
    expect(onSendVideoTurn).not.toHaveBeenCalled();
    expect(client.newChat).toHaveBeenCalledOnce();
  });

  it("reuses a lazily created embedded conversation when linking the project needs a retry", async () => {
    const client = makeClient();
    const onSendVideoTurn = vi.fn();
    client.newChat.mockResolvedValue("lazy-retry-chat");
    mocks.saveVideoChatId.mockRejectedValueOnce(new Error("link failed")).mockResolvedValue({ ok: true });
    render(wrap(<VideoMakerView embedded onSendVideoTurn={onSendVideoTurn} />, client));
    fireEvent.change(screen.getByLabelText("想做什么视频？"), { target: { value: "恢复首次分镜" } });
    fireEvent.click(screen.getByRole("button", { name: "准备分镜" }));
    fireEvent.click(await screen.findByRole("button", { name: "继续准备分镜" }));
    await waitFor(() => expect(client.sendMessage).toHaveBeenCalledOnce());
    expect(client.sendMessage.mock.calls[0][0]).toBe("lazy-retry-chat");
    expect(client.newChat).toHaveBeenCalledOnce();
    expect(mocks.saveVideoChatId).toHaveBeenCalledTimes(2);
    expect(mocks.createVideoProject).toHaveBeenCalledOnce();
    expect(onSendVideoTurn).not.toHaveBeenCalled();
  });

  it("opens unconfirmed projects in the main director workspace", async () => {
    render(wrap(<VideoMakerView embedded hostChatId="chat" initialProject={{ name: "旧项目", phase: "storyboard", chatId: "chat" }} />));
    expect(await screen.findByRole("heading", { name: "旧项目" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "导演台" })).toHaveAttribute("aria-pressed", "true");
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
    expect(screen.getByRole("button", { name: "视频" })).toBeDisabled();
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
    expect(await screen.findByRole("heading", { name: "项目" })).toBeInTheDocument();
    act(() => client.__emitChat("chat", { event: "error", detail: "invalid_agent_kind_context" }));
    expect(await screen.findByText("视频会话未就绪，请重试准备分镜。")).toBeInTheDocument();
    act(() => client.__emitVideoProjectChanged({ projectName: "项目", hint: "scenes" }));
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(mocks.createVideoProject).not.toHaveBeenCalled();
  });
});

describe("ProducingPhase toolbar export button", () => {
  it("keeps export status and its compact stop action inside the toolbar", async () => {
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
          htmlStatus: "previewing",
          htmlPath: "drafts/scene_01.html",
          htmlMtime: 100,
        },
      ],
    });
    mocks.fetchScenePreviewHtml.mockResolvedValue({
      html: "<html>scene</html>",
      needsGeneration: false,
    });
    mocks.fetchVideoExportStatus.mockResolvedValue({ stage: "idle", progress: 0 });

    render(wrap(<ProducingPhase projectName="proj" />, client));

    const readyButton = await screen.findByRole("button", { name: "导出视频" });
    const readyIcon = readyButton.querySelector("svg");
    expect(readyButton).toHaveClass("h-6");
    expect(readyIcon).toHaveClass("h-3.5", "w-3.5");

    mocks.fetchVideoExportStatus.mockResolvedValue({
      stage: "rendering",
      progress: 93,
      message: "正在保存视频（40.0/110.0 秒）...",
    });
    act(() => client.__emitVideoProjectChanged({ projectName: "proj", hint: "progress" }));

    const stopButton = await screen.findByRole("button", { name: "停止导出" });
    expect(stopButton).toBeEnabled();
    expect(stopButton).toHaveClass("h-6");
    expect(stopButton.querySelector("svg")).toHaveClass("h-3.5", "w-3.5");
    expect(screen.queryByRole("button", { name: "导出视频" })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("正在保存视频（40.0/110.0 秒）... · 93%");
    expect(screen.getByRole("status").closest("header")).toBe(stopButton.closest("header"));
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
      releaseType: "final",
      deliveryArtifacts: {
        package: "renders/delivery.zip",
        srt: "renders/subtitles.srt",
      },
      qualityStatus: "passed",
    });
    act(() => {
      client.__emitVideoProjectChanged({ projectName: "proj", hint: "status" });
    });

    await waitFor(() => expect(mocks.getApiBase).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole("button", { name: "查看结果" }));
    const results = await screen.findByRole("dialog", { name: "导出结果" });
    expect(within(results).getByRole("button", { name: "单独下载 MP4" })).toBeInTheDocument();
    expect(within(results).getByRole("button", { name: "下载交付包" })).toBeInTheDocument();
    expect(within(results).getByText("导出检查已通过")).toBeInTheDocument();
    expect(within(results).queryByText("交付版本")).not.toBeInTheDocument();
    fireEvent.click(within(results).getByRole("button", { name: "单独下载 MP4" }));
    await waitFor(() => expect(mocks.downloadMediaUrl).toHaveBeenCalledWith(expect.any(String), "proj.mp4"));
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
    expect(await screen.findByRole("status")).toHaveTextContent("正在渲染场景 1/1 · 帧 10/150 · 15%");
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

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("正在渲染场景 1/1 · 帧 60/150 · 42%"));
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
    expect(screen.queryByRole("button", { name: "查看进度" })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "停止导出" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await waitFor(() => {
      expect(mocks.cancelVideoExport).toHaveBeenCalledWith("tok", "proj");
    });
    expect(await screen.findByRole("button", { name: "正在停止..." })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("正在安全停止导出...");
    fireEvent.click(screen.getByRole("button", { name: "正在停止..." }));
    expect(mocks.cancelVideoExport).toHaveBeenCalledTimes(1);
    mocks.fetchVideoExportStatus.mockResolvedValue({ stage: "cancelled", progress: 36, message: "视频导出已停止" });
    act(() => client.__emitVideoProjectChanged({ projectName: "proj", hint: "status" }));
    expect(await screen.findByRole("button", { name: "导出视频" })).toBeEnabled();
    expect(screen.queryByText("导出已停止")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "正在停止..." })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "查看结果" })).not.toBeInTheDocument();
  });

  it("keeps the workbench visible after starting export", async () => {
    mocks.fetchVideoProject.mockResolvedValue({ name: "proj", resolution: "1920x1080", phase: "exportable" });
    mocks.fetchVideoStoryboard.mockResolvedValue({ ok: true, scenes: [{ ...scene(1), htmlStatus: "confirmed" }] });
    mocks.fetchScenePreviewHtml.mockResolvedValue({ html: "<html>scene</html>", needsGeneration: false });
    mocks.fetchVideoExportStatus.mockResolvedValue({ stage: "idle", progress: 0 });
    mocks.exportVideoProject.mockResolvedValueOnce({ ok: true });
    render(wrap(<ProducingPhase projectName="proj" />));
    const exportButton = await screen.findByRole("button", { name: "导出视频" });
    await waitFor(() => expect(exportButton).toBeEnabled());
    fireEvent.click(exportButton);
    const exportDialog = await screen.findByRole("dialog", { name: "导出视频" });
    expect(within(exportDialog).queryByRole("button", { name: "交付版本" })).not.toBeInTheDocument();
    expect(within(exportDialog).getByRole("button", { name: "导出质量" })).toHaveTextContent("标准（推荐）");
    fireEvent.click(await screen.findByRole("button", { name: "开始导出" }));
    expect(await screen.findByRole("button", { name: "停止导出" })).toBeEnabled();
    expect(mocks.exportVideoProject).toHaveBeenCalledWith("tok", "proj", { quality: "standard" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("准备导出...");
  });

  it("shows an actionable dialog if stopping export is not confirmed", async () => {
    mocks.fetchVideoProject.mockResolvedValue({ name: "proj", resolution: "1920x1080", phase: "rendering" });
    mocks.fetchVideoStoryboard.mockResolvedValue({ ok: true, scenes: [] });
    mocks.fetchVideoExportStatus.mockResolvedValue({ stage: "rendering", progress: 97, message: "正在合成视频声音..." });
    mocks.cancelVideoExport.mockRejectedValueOnce(new Error("response lost"));
    render(wrap(<ProducingPhase projectName="proj" />));
    fireEvent.click(await screen.findByRole("button", { name: "停止导出" }));
    const dialog = await screen.findByRole("dialog", { name: "停止导出未能确认" });
    expect(dialog).toHaveTextContent("将继续更新导出进度，请稍后重试");
    expect(dialog).not.toHaveTextContent("response lost");
    fireEvent.click(within(dialog).getByRole("button", { name: "关闭" }));
    expect(screen.getByRole("button", { name: "停止导出" })).toBeEnabled();
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

  it("shows restore failures from project history", async () => {
    mocks.fetchVideoStoryboard.mockResolvedValue({ ok: true, scenes: [scene(1)] });
    mocks.fetchVideoProjectVersions.mockResolvedValue({ ok: true, versions: [{ id: "backup-1", createdAt: "2026-10-12T10:00:00", label: "之前的版本", reason: "ai-change", changedSceneIndices: [1] }] });
    mocks.restoreVideoProjectVersion.mockResolvedValueOnce({ ok: false, error: "internal restore trace" });
    render(wrap(<ProducingPhase projectName="proj" />));
    fireEvent.click(await screen.findByRole("button", { name: "版本历史" }));
    fireEvent.click(await screen.findByRole("button", { name: "恢复" }));
    expect(await screen.findByRole("dialog", { name: "操作遇到问题" })).toHaveTextContent("请检查当前视频后重试");
    expect(screen.queryByText("internal restore trace")).not.toBeInTheDocument();
    expect(mocks.restoreVideoProjectVersion).toHaveBeenCalledOnce();
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
    await screen.findByRole("dialog", { name: "视频设置" });
    fireEvent.click(screen.getByRole("checkbox", { name: "显示辅助线和时间轴详情" }));
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
    expect(screen.getByText("画面节拍")).toBeInTheDocument();
    expect(screen.getByText("字幕与画面同步")).toBeInTheDocument();
    expect(screen.getByTitle("标题 · 0.0–0.8 秒")).toBeInTheDocument();
  });

  it("keeps old modification notes in history without adding export choices", async () => {
    const client = makeClient();
    mocks.fetchVideoProject.mockResolvedValue({
      name: "proj",
      resolution: "1920x1080",
      outputStale: false,
      phase: "producing",
      aspectVariant: "16:9",
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

    render(wrap(<ProducingPhase projectName="proj" />, client));
    fireEvent.click(await screen.findByRole("button", { name: "版本历史" }));
    const history = await screen.findByRole("dialog", { name: "项目版本历史" });
    const oldNotes = within(history).getByRole("region", { name: "以前保存的修改备注" });
    expect(within(oldNotes).getByText("数据来源待复核")).toBeInTheDocument();
    expect(within(oldNotes).getByRole("button", { name: "标记已处理" })).toBeInTheDocument();

    fireEvent.click(within(history).getByRole("button", { name: "关闭" }));
    fireEvent.click(await screen.findByRole("button", { name: "导出视频" }));
    const exportDialog = await screen.findByRole("dialog", { name: "导出视频" });
    expect(within(exportDialog).getByRole("button", { name: "导出质量" })).toBeInTheDocument();
    expect(within(exportDialog).queryByText("交付版本")).not.toBeInTheDocument();
    expect(within(exportDialog).queryByText("数据来源待复核")).not.toBeInTheDocument();
    expect(within(exportDialog).getByRole("button", { name: "开始导出" })).toBeEnabled();
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
