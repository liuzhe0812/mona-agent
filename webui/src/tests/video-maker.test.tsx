import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProducingPhase } from "@/components/doc/video/ProducingPhase";
import { StoryboardPhase } from "@/components/doc/video/StoryboardPhase";
import { VideoMakerView } from "@/components/doc/video/VideoMakerView";
import { ClientProvider } from "@/providers/ClientProvider";
import type { VideoScene, VideoSceneWithHtml } from "@/lib/api";

const mocks = vi.hoisted(() => ({
  addVideoScene: vi.fn(),
  buildVideoDownloadUrl: vi.fn(() => "http://download/url"),
  buildVideoPreviewFullUrl: vi.fn(() => "http://preview/full"),
  confirmVideoScene: vi.fn(),
  createVideoProject: vi.fn(),
  deleteVideoProject: vi.fn(),
  deleteVideoScene: vi.fn(),
  downloadVideoRuntime: vi.fn(),
  exportVideoProject: vi.fn(),
  fetchSceneNarrationBytes: vi.fn(async () => null),
  fetchScenePreviewHtml: vi.fn(),
  fetchVideoExportStatus: vi.fn(async () => ({ stage: "idle", progress: 0 })),
  fetchVideoProject: vi.fn(),
  fetchVideoProjects: vi.fn(async () => ({ projects: [] })),
  fetchVideoRuntimeCheck: vi.fn(async () => ({
    node: { ok: true },
    ffmpeg: { ok: true },
    chrome: { ok: true },
  })),
  fetchVideoStoryboard: vi.fn(),
  generateSceneHtml: vi.fn(),
  getApiBase: vi.fn(async () => "http://localhost:8765"),
  getServicesHttpBase: vi.fn(async () => "http://localhost:17174"),
  lockVideoStoryboard: vi.fn(),
  regenerateVideoScene: vi.fn(),
  reorderVideoScenes: vi.fn(),
  rewriteVideoScene: vi.fn(),
  saveVideoChatId: vi.fn(),
  updateVideoScene: vi.fn(),
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
  return {
    status: "open" as const,
    defaultChatId: null,
    onStatus: () => () => {},
    onChat: () => () => {},
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
      client={(client ?? makeClient()) as unknown as import("@/lib/mona-client").MonaClient}
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
  localStorage.clear();
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

    expect(await screen.findByText("场景制作 · 1/2 已生成")).toBeInTheDocument();
    const exportButton = screen.getByRole("button", { name: /导出 MP4/ });
    expect(exportButton).toBeDisabled();
    expect(screen.getByText("生成全部场景后可导出（1/2）")).toBeInTheDocument();
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

    expect(await screen.findByText("场景制作 · 2/2 已生成")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /导出 MP4/ })).toBeEnabled();
    expect(
      screen.getByText("全部场景已生成，可以导出 MP4"),
    ).toBeInTheDocument();
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
    expect(
      screen.getByRole("button", { name: /开始生成/ }),
    ).toBeEnabled();
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
      await screen.findByRole("button", { name: /导出 MP4/ }),
    ).toBeInTheDocument();

    // 服务端渲染完成 → WS 推送 status 事件 → 面板切换为可下载状态
    mocks.fetchVideoExportStatus.mockResolvedValue({
      stage: "done",
      progress: 100,
      hasVideo: true,
    });
    act(() => {
      client.__emitVideoProjectChanged({ projectName: "proj", hint: "status" });
    });

    expect(
      await screen.findByRole("button", { name: "下载 MP4" }),
    ).toBeInTheDocument();
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
    });

    render(wrap(<ProducingPhase projectName="proj" />, client));
    expect(await screen.findByText(/帧 10\/150/)).toBeInTheDocument();

    // 帧进度事件 → 立即刷新（不依赖轮询节拍）
    mocks.fetchVideoExportStatus.mockResolvedValue({
      stage: "rendering",
      progress: 42,
      message: "正在渲染场景 1/1 · 帧 60/150",
    });
    act(() => {
      client.__emitVideoProjectChanged({
        projectName: "proj",
        hint: "progress",
      });
    });

    expect(await screen.findByText(/帧 60\/150/)).toBeInTheDocument();
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
      await screen.findByRole("button", { name: /导出 MP4/ }),
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
