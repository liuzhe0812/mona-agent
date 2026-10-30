import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProducingPhase } from "@/components/doc/video/ProducingPhase";
import type { VideoTtsConfig } from "@/lib/api";
import { ClientProvider } from "@/providers/ClientProvider";

const mocks = vi.hoisted(() => ({
  buildVideoDownloadUrl: vi.fn(() => "http://download/video.mp4"),
  cancelVideoExport: vi.fn(),
  createVideoReview: vi.fn(),
  exportVideoProject: vi.fn(),
  fetchSceneNarrationBytes: vi.fn(),
  fetchScenePreviewHtml: vi.fn(),
  fetchVideoExportStatus: vi.fn(),
  fetchVideoExportPreflight: vi.fn(),
  fetchVideoPreviewFullHtml: vi.fn(),
  fetchVideoProject: vi.fn(),
  fetchVideoProjectVersions: vi.fn(),
  fetchVideoReviews: vi.fn(),
  fetchVideoRuntimeCheck: vi.fn(),
  fetchVideoSceneTimeline: vi.fn(),
  fetchVideoStoryboard: vi.fn(),
  getApiBase: vi.fn(async () => "http://api"),
  getServicesHttpBase: vi.fn(async () => "http://services"),
  restoreVideoProjectVersion: vi.fn(),
  resolveVideoReview: vi.fn(),
  updateVideoProjectSettings: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  ...mocks,
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

vi.mock("@/lib/tauri", () => ({
  downloadMediaUrl: vi.fn(async () => true),
  revealItemInDir: vi.fn(async () => {}),
}));

vi.mock("@/components/doc/video/VideoRuntimeDialog", () => ({
  VideoRuntimeDialog: () => null,
}));

function wrap(node: ReactNode) {
  const client = {
    status: "open" as const,
    defaultChatId: null,
    onStatus: () => () => {},
    onChat: () => () => {},
    onError: () => () => {},
    onSessionUpdate: () => () => {},
    onSessionDeleted: () => () => {},
    isChatDeleted: () => false,
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
  return (
    <ClientProvider
      client={client as unknown as import("@/lib/mona-client").MonaClient}
      token="tok"
    >
      {node}
    </ClientProvider>
  );
}

const scene = {
  index: 1,
  title: "开场",
  duration: 5,
  durationRaw: "5s",
  visual: "产品画面",
  animation: "标题淡入",
  narration: "欢迎体验这段视频。",
  assets: [],
  htmlStatus: "previewing",
  htmlMtime: 100,
};

function timeline(caption: string | null = null) {
  return {
    ok: true,
    sceneIndex: 1,
    durationMs: 5000,
    motionPlan: { beats: [] },
    subtitleTrack: {
      timingSource: "provider-boundary",
      cues: caption
        ? [{ id: "cue-1", startMs: 0, endMs: 1000, text: caption }]
        : [],
    },
  };
}

function project(meta: VideoTtsConfig = { narrationEnabled: false }) {
  return {
    name: "proj",
    resolution: "1920x1080",
    outputStale: false,
    phase: "producing",
    meta,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.buildVideoDownloadUrl.mockReturnValue("http://download/video.mp4");
  mocks.fetchVideoPreviewFullHtml.mockResolvedValue("<html><body>full preview</body></html>");
  mocks.getApiBase.mockResolvedValue("http://api");
  mocks.getServicesHttpBase.mockResolvedValue("http://services");
  mocks.fetchVideoProject.mockResolvedValue(project());
  mocks.fetchVideoStoryboard.mockResolvedValue({ ok: true, scenes: [scene] });
  mocks.fetchScenePreviewHtml.mockResolvedValue({
    html: "<html><body>scene</body></html>",
    needsGeneration: false,
  });
  mocks.fetchVideoSceneTimeline.mockResolvedValue(timeline());
  mocks.fetchVideoReviews.mockResolvedValue({ ok: true, reviews: [], openCount: 0 });
  mocks.fetchVideoExportStatus.mockResolvedValue({ stage: "idle", progress: 0 });
  mocks.fetchVideoExportPreflight.mockResolvedValue({ ok: true });
  mocks.fetchVideoProjectVersions.mockResolvedValue({ ok: true, versions: [] });
  mocks.fetchVideoRuntimeCheck.mockResolvedValue({
    node: { ok: true },
    ffmpeg: { ok: true },
    chrome: { ok: true },
  });
  mocks.fetchSceneNarrationBytes.mockResolvedValue(null);
  globalThis.ResizeObserver =
    globalThis.ResizeObserver ??
    (class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver);
});

describe("ProducingPhase playback and narration settings", () => {
  it("shows current-scene controls by default and keeps detail tracks optional", async () => {
    render(wrap(<ProducingPhase projectName="proj" />));
    await screen.findByRole("button", { name: "播放当前场景" });

    expect(
      screen.getByRole("button", { name: "预览整片" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: /草稿已生成/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "播放当前场景" })).toBeEnabled();
    expect(
      screen.getByRole("slider", { name: "场景播放位置" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("画面节拍")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "播放当前场景" }));
    expect(
      await screen.findByRole("button", { name: "暂停当前场景" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "暂停当前场景" }));
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    fireEvent.click(screen.getByRole("button", { name: "显示字幕与动画位置" }));
    expect(screen.getByText("画面节拍")).toBeInTheDocument();

  });

  it("blocks whole-film preview while any scene is still pending", async () => {
    mocks.fetchVideoStoryboard.mockResolvedValue({
      ok: true,
      scenes: [{ ...scene, htmlStatus: "pending" }],
    });
    render(wrap(<ProducingPhase projectName="proj" />));
    const fullPreviewButton = await screen.findByRole("button", {
      name: "预览整片",
    });

    expect(fullPreviewButton).toBeDisabled();
    expect(fullPreviewButton.parentElement).toHaveAttribute(
      "title",
      "生成全部场景后可预览整片（0/1）",
    );
    expect(screen.queryByTitle("proj 整片预览")).not.toBeInTheDocument();
  });

  it("ignores a delayed play result after switching scenes", async () => {
    const originalCreateObjectUrl = URL.createObjectURL;
    const originalRevokeObjectUrl = URL.revokeObjectURL;
    let objectUrlIndex = 0;
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => `blob:scene-${++objectUrlIndex}`),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    let resolvePlay!: () => void;
    const play = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            resolvePlay = resolve;
          }),
      );
    mocks.fetchVideoProject.mockResolvedValue(project({ narrationEnabled: true }));
    mocks.fetchVideoStoryboard.mockResolvedValue({
      ok: true,
      scenes: [scene, { ...scene, index: 2, title: "第二幕" }],
    });
    mocks.fetchSceneNarrationBytes.mockResolvedValue(
      new Blob(["audio"], { type: "audio/mpeg" }),
    );

    try {
      render(wrap(<ProducingPhase projectName="proj" />));
      const playButton = await screen.findByRole("button", {
        name: "播放当前场景",
      });
      await waitFor(() => expect(mocks.fetchSceneNarrationBytes).toHaveBeenCalledOnce());
      await waitFor(() => expect(playButton).toBeEnabled());
      fireEvent.click(playButton);
      await waitFor(() => expect(play).toHaveBeenCalledOnce());

      fireEvent.click(screen.getByRole("option", { name: /第二幕/ }));
      await waitFor(() =>
        expect(mocks.fetchSceneNarrationBytes).toHaveBeenCalledTimes(2),
      );
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "播放当前场景" })).toBeEnabled(),
      );

      await act(async () => resolvePlay());

      expect(screen.getByRole("option", { name: /第二幕/ })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      expect(screen.getByRole("button", { name: "播放当前场景" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "暂停当前场景" })).toBeNull();
    } finally {
      play.mockRestore();
      Object.defineProperty(URL, "createObjectURL", {
        configurable: true,
        value: originalCreateObjectUrl,
      });
      Object.defineProperty(URL, "revokeObjectURL", {
        configurable: true,
        value: originalRevokeObjectUrl,
      });
    }
  });

  it("saves voice settings and refreshes project, scene captions, and narration preload", async () => {
    const user = userEvent.setup();
    let serverMeta: VideoTtsConfig = {
      narrationEnabled: false,
      ttsProvider: "edge",
      ttsVoice: "zh-CN-XiaoyiNeural",
      ttsRate: "+0%",
      subtitleMode: "burned",
    };
    mocks.fetchVideoProject.mockImplementation(async () => project(serverMeta));
    mocks.updateVideoProjectSettings.mockImplementation(
      async (_token: string, _name: string, settings: VideoTtsConfig) => {
        serverMeta = { ...settings };
        mocks.fetchVideoSceneTimeline.mockResolvedValue(timeline("字幕已刷新"));
        return { ok: true, meta: serverMeta };
      },
    );

    render(wrap(<ProducingPhase projectName="proj" />));
    await screen.findByRole("button", { name: "播放当前场景" });
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    fireEvent.click(screen.getByRole("button", { name: "配音设置" }));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("checkbox", { name: "启用旁白配音" }));

    await user.click(screen.getByRole("button", { name: "配音来源" }));
    await user.click(await screen.findByRole("menuitem", { name: "我的语音服务" }));
    expect(screen.getByText(/语音合成/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "配音来源" }));
    await user.click(await screen.findByRole("menuitem", { name: "内置配音" }));

    await user.click(screen.getByRole("button", { name: "配音音色" }));
    await user.click(await screen.findByRole("menuitem", { name: "云希（男·成熟）" }));
    await user.click(screen.getByRole("button", { name: "语速" }));
    await user.click(await screen.findByRole("menuitem", { name: "稍快 (+10%)" }));
    await user.click(screen.getByRole("button", { name: "字幕交付方式" }));
    await user.click(await screen.findByRole("menuitem", { name: "外挂字幕文件" }));
    await user.click(screen.getByRole("button", { name: "保存设置" }));

    await waitFor(() =>
      expect(mocks.updateVideoProjectSettings).toHaveBeenCalledWith(
        "tok",
        "proj",
        {
          narrationEnabled: true,
          ttsProvider: "edge",
          ttsVoice: "zh-CN-YunxiNeural",
          ttsRate: "+10%",
          subtitleMode: "external",
        },
      ),
    );
    await waitFor(() => expect(mocks.fetchVideoProject).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(mocks.fetchVideoStoryboard).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(mocks.fetchVideoSceneTimeline).toHaveBeenCalledTimes(2),
    );
    await waitFor(() =>
      expect(mocks.fetchSceneNarrationBytes).toHaveBeenCalledOnce(),
    );

    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    fireEvent.click(screen.getByRole("button", { name: "显示字幕与动画位置" }));
    expect(await screen.findByText("字幕已刷新")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("does not retry a narration settings write after an unknown failure", async () => {
    mocks.updateVideoProjectSettings.mockRejectedValueOnce(
      new Error("network timeout"),
    );
    render(wrap(<ProducingPhase projectName="proj" />));
    await screen.findByRole("button", { name: "播放当前场景" });
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    fireEvent.click(screen.getByRole("button", { name: "配音设置" }));
    fireEvent.click(await screen.findByRole("button", { name: "保存设置" }));

    await waitFor(() =>
      expect(mocks.updateVideoProjectSettings).toHaveBeenCalledOnce(),
    );
    await waitFor(() =>
      expect(screen.getByRole("dialog")).toHaveTextContent(
        "配音设置保存失败，请检查后重试。",
      ),
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await act(async () => new Promise((resolve) => setTimeout(resolve, 750)));
    expect(mocks.updateVideoProjectSettings).toHaveBeenCalledOnce();
  });

  it("shows full-preview playback errors only from its own frame", async () => {
    render(wrap(<ProducingPhase projectName="proj" />));
    fireEvent.click(await screen.findByRole("button", { name: "预览整片" }));
    const frame = await screen.findByTitle("proj 整片预览");
    expect(mocks.fetchVideoPreviewFullHtml).toHaveBeenCalledWith("tok", "proj", expect.any(AbortSignal));
    expect(frame).toHaveAttribute("srcdoc", "<html><body>full preview</body></html>");

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            type: "mona-video-playback-error",
            sceneIndex: 1,
            message: "场景 1 的旁白播放失败，画面已暂停，请重试。",
          },
          source: null,
        }),
      );
    });
    expect(screen.queryByRole("heading", { name: "整片播放失败" })).toBeNull();

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            type: "mona-video-playback-error",
            sceneIndex: 1,
            message: "场景 1 的旁白播放失败，画面已暂停，请重试。",
          },
          source: frame.contentWindow,
        }),
      );
    });
    expect(
      await screen.findByRole("heading", { name: "整片播放失败" }),
    ).toBeInTheDocument();
    expect(screen.getByText("场景 1 的旁白播放失败，画面已暂停，请重试。"))
      .toBeInTheDocument();
  });

  it("hides internal rendering engine and raw fallback details", async () => {
    mocks.fetchVideoExportStatus.mockResolvedValue({
      stage: "rendering",
      progress: 32,
      message: "正在合成画面",
      actualEngine: "legacy",
      fallbackReason: "internal fallback exception",
    });
    render(wrap(<ProducingPhase projectName="proj" />));

    expect(await screen.findByRole("status")).toHaveTextContent("正在导出 32%");
    expect(screen.queryByText("兼容渲染器")).not.toBeInTheDocument();
    expect(screen.queryByText("HyperFrames")).not.toBeInTheDocument();
    expect(
      screen.queryByText("internal fallback exception"),
    ).not.toBeInTheDocument();
  });
});

it("shows real preparation progress and keeps the director action available while scenes are empty", async () => {
  mocks.fetchVideoStoryboard.mockResolvedValue({ ok: true, scenes: [] });
  mocks.fetchVideoProject.mockResolvedValue({ ...project(), draftSceneCount: 5 });
  const openDirector = vi.fn();
  const view = render(wrap(<ProducingPhase projectName="proj" agentRunning agentActivity="正在准备第 3 段画面草稿" agentStartedAt={Date.now() / 1000 - 130} onOpenChat={openDirector} />));
  expect(await screen.findByText("正在准备第 3 段画面草稿")).toBeInTheDocument();
  expect(screen.getByText(/已用时 2 分/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "查看制作进展" }));
  expect(openDirector).toHaveBeenCalledOnce();
  view.rerender(wrap(<ProducingPhase projectName="proj" agentRunning={false} onOpenChat={openDirector} />));
  expect(await screen.findByText("已保存 5 段草稿，尚未生成可预览画面")).toBeInTheDocument();
  expect(screen.queryByText("正在准备第 3 段画面草稿")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "继续制作" })).toBeEnabled();
});
