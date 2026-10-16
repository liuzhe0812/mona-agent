import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { OfficeSessionState } from "@/components/office/types";
import { useWorkspaceStore } from "@/lib/workspace-store";
import { DocMakerView } from "./DocMakerView";

const mocks = vi.hoisted(() => ({
  archiveVideoProject: vi.fn(),
  buildVideoDownloadUrl: vi.fn(() => "http://download/video"),
  copyVideoProject: vi.fn(),
  createOfficeSession: vi.fn(),
  getOfficeSession: vi.fn(),
  importOfficeSession: vi.fn(),
  deleteOfficeSession: vi.fn(),
  deleteVideoProject: vi.fn(),
  fetchVideoProjects: vi.fn(),
  fetchVideoProjectsIncludingArchived: vi.fn(),
  getApiBase: vi.fn(async () => "http://localhost:8765"),
  newChat: vi.fn(),
  renameVideoProject: vi.fn(),
  sendMessage: vi.fn(),
  saveWorkspaceCanvas: vi.fn(),
  revealItemInDir: vi.fn(),
  upgradeVideoProjectStyle: vi.fn(),
  upgradeVideoSeriesProjects: vi.fn(),
}));

vi.mock("@/providers/ClientProvider", () => ({
  useClient: () => ({
    client: {
      newChat: mocks.newChat,
      sendMessage: mocks.sendMessage,
      onVideoProjectChanged: vi.fn(() => () => {}),
      onRunStatus: vi.fn(() => () => {}),
    },
    token: "token",
  }),
}));

vi.mock("@/lib/office-client", () => ({
  createOfficeSession: mocks.createOfficeSession,
  getOfficeSession: mocks.getOfficeSession,
  importOfficeSession: mocks.importOfficeSession,
  deleteOfficeSession: mocks.deleteOfficeSession,
}));

vi.mock("@/lib/api", () => ({
  archiveVideoProject: mocks.archiveVideoProject,
  buildVideoDownloadUrl: mocks.buildVideoDownloadUrl,
  copyVideoProject: mocks.copyVideoProject,
  fetchVideoProjects: mocks.fetchVideoProjects,
  fetchVideoProjectsIncludingArchived: mocks.fetchVideoProjectsIncludingArchived,
  getApiBase: mocks.getApiBase,
  deleteVideoProject: mocks.deleteVideoProject,
  renameVideoProject: mocks.renameVideoProject,
  upgradeVideoProjectStyle: mocks.upgradeVideoProjectStyle,
  upgradeVideoSeriesProjects: mocks.upgradeVideoSeriesProjects,
}));

vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  isTauri: () => true,
  revealItemInDir: mocks.revealItemInDir,
  saveWorkspaceCanvas: mocks.saveWorkspaceCanvas,
}));

vi.mock("@/components/office/OfficeEditorHost", () => ({
  OfficeEditorHost: ({ initialSession }: { initialSession: OfficeSessionState }) => (
    <div>Office 编辑器：{initialSession.displayName}</div>
  ),
}));

vi.mock("@/components/doc/DocChatPanel", async () => {
  const { useEffect } = await import("react");
  return {
    DocChatPanel: ({ chatId, getSendOptions, onReadyChange }: {
      chatId: string;
      getSendOptions?: (content: string) => Record<string, unknown> | undefined;
      onReadyChange?: (chatId: string | null) => void;
    }) => {
      useEffect(() => {
        onReadyChange?.(chatId);
        return () => onReadyChange?.(null);
      }, [chatId, onReadyChange]);
      return (
        <div>
          <span>AI 对话：{chatId}</span>
          <button type="button" onClick={() => mocks.sendMessage(chatId, "修改当前文档", undefined, getSendOptions?.("修改当前文档"))}>发送测试消息</button>
        </div>
      );
    },
  };
});

vi.mock("@/components/doc/video/VideoMakerView", () => ({
  VideoMakerView: ({
    onProjectChange,
    initialProject,
    onStyleWorkspaceChange,
    styleConversationRequest,
  }: {
    onProjectChange?: (project: {
      name: string;
      phase: "storyboard" | "done";
      chatId: string | null;
    }) => void;
    initialProject?: { name: string; phase: string; chatId: string | null } | null;
    onStyleWorkspaceChange?: (state: { chatId: string; visible: boolean; ready: boolean } | null) => void;
    styleConversationRequest?: number;
  }) => (
    <div>
      视频工作流
      <span data-testid="style-conversation-request">{styleConversationRequest}</span>
      <button onClick={() => onStyleWorkspaceChange?.({ chatId: "style-chat", visible: true, ready: true })}>打开风格对话</button>
      <button onClick={() => onStyleWorkspaceChange?.({ chatId: "style-chat", visible: false, ready: true })}>隐藏风格对话</button>
      <span data-testid="embedded-video-project-chat-id">{initialProject?.chatId}</span>
      <button
        type="button"
        onClick={() =>
          onProjectChange?.({
            name: "新建视频",
            phase: "storyboard",
            chatId: "storyboard-chat",
          })
        }
      >
        模拟确认分镜
      </button>
      <button
        type="button"
        onClick={() =>
          onProjectChange?.({
            name: initialProject?.name ?? "新建完成的视频",
            phase: "done",
            chatId: initialProject?.chatId ?? null,
          })
        }
      >
        模拟视频导出完成
      </button>
    </div>
  ),
}));

vi.mock("@/components/canvas/CanvasFileView", () => ({
  CanvasFileView: ({ filePath }: { filePath: string }) => <div>画布编辑器：{filePath}</div>,
}));

function officeSession(type: "docs" | "sheets" | "slides", name: string): OfficeSessionState {
  return {
    sessionId: `${type}-session`,
    displayName: name,
    type,
    version: { editorEpoch: "epoch", modelRevision: 0 },
    checkpointVersion: null,
    savedVersion: null,
    dirty: false,
    editorConnected: false,
    saveState: "clean",
    lastError: null,
  };
}

function videoProject(name: string, chatId: string) {
  return {
    name,
    createdAt: Date.now(),
    resolution: "1920x1080",
    phase: "producing" as const,
    hasVideo: false,
    outputStale: false,
    chatId,
  };
}

function storeVideoTab(project: ReturnType<typeof videoProject>, activeTabId = `video:${project.name}`) {
  localStorage.setItem("mona.ai-docs.workspace.v1", JSON.stringify([{
    id: `video:${project.name}`,
    kind: "video-workflow",
    title: project.name,
    chatId: project.chatId,
    project: { name: project.name, phase: project.phase, chatId: project.chatId },
    createdAt: project.createdAt,
  }]));
  localStorage.setItem("mona.ai-docs.active-tab.v1", activeTabId);
}

describe("DocMakerView", () => {
  beforeEach(() => {
    localStorage.clear();
    mocks.createOfficeSession.mockReset();
    mocks.getOfficeSession.mockReset();
    mocks.importOfficeSession.mockReset();
    mocks.deleteOfficeSession.mockReset().mockResolvedValue(undefined);
    mocks.deleteVideoProject.mockReset().mockResolvedValue({ ok: true });
    mocks.fetchVideoProjects.mockReset().mockResolvedValue({ projects: [] });
    mocks.fetchVideoProjectsIncludingArchived.mockReset().mockResolvedValue({ projects: [] });
    mocks.archiveVideoProject.mockReset().mockResolvedValue({ ok: true });
    mocks.renameVideoProject.mockReset().mockResolvedValue({ ok: true });
    mocks.copyVideoProject.mockReset().mockResolvedValue({ ok: true });
    mocks.newChat.mockReset().mockResolvedValue("chat-1");
    mocks.sendMessage.mockReset();
    mocks.saveWorkspaceCanvas.mockReset().mockImplementation(async (_root, canvas) => ({
      canvas,
      path: `D:\\workspace\\agent-workspaces\\mona\\output\\canvases\\${canvas.title}.mona-canvas`,
    }));
    mocks.revealItemInDir.mockReset().mockResolvedValue(undefined);
    useWorkspaceStore.setState({ workspacePath: "D:\\workspace" });
  });

  it("shows the fixed start page with all six creation types and history tabs", async () => {
    const { container } = render(<DocMakerView />);

    expect(screen.getByRole("heading", { name: "文档" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "AI 文档" })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "开始" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tablist", { name: "打开的文档" }).parentElement).toHaveClass("h-8");
    expect(screen.getByRole("tab", { name: "开始" })).toHaveClass("h-8");
    expect(screen.getByRole("button", { name: /Word/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Excel/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /PPT/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^视频$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /思维导图/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /流程图/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "最近" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "收藏" })).toBeInTheDocument();
    const sidebarToggle = screen.getByRole("button", { name: "打开 MONA AI" });
    expect(sidebarToggle).toBeInTheDocument();
    const pptButton = screen.getByRole("button", { name: /PPT/ });
    expect(pptButton).toHaveClass("h-20", "min-w-0", "gap-3", "p-3");
    expect(pptButton.parentElement).toHaveClass("grid-cols-[repeat(auto-fit,minmax(10rem,1fr))]");
    expect(screen.queryByText("直接编辑或 AI 制作整套")).not.toBeInTheDocument();
    expect(container.querySelector('[data-document-icon="word"]')).toHaveStyle({
      backgroundImage: "url(/brand/sidebar-app-picker-icons.png)",
    });
    expect(container.querySelector('[data-document-icon="excel"]')).toHaveStyle({
      backgroundImage: "url(/brand/sidebar-app-picker-icons.png)",
    });
    expect(container.querySelector('[data-document-icon="ppt"]')).toHaveStyle({
      backgroundImage: "url(/brand/sidebar-app-picker-icons.png)",
    });
    expect(container.querySelector('[data-document-icon="video"]')).toHaveAttribute(
      "src",
      "/brand/document-video-icon.png",
    );
    expect(container.querySelector('[data-document-icon="mindmap"]')).toHaveStyle({
      backgroundImage: "url(/brand/sidebar-app-picker-icons.png)",
    });
    expect(container.querySelector('[data-document-icon="flowchart"]')).toHaveStyle({
      backgroundImage: "url(/brand/sidebar-app-picker-icons.png)",
    });
    fireEvent.click(sidebarToggle);
    const sidebar = screen.getByRole("complementary", { name: "MONA AI 文档助手" });
    expect(screen.getByTestId("document-workspace").contains(sidebar)).toBe(true);
    expect(screen.getByRole("button", { name: "收起 MONA AI" })).toBe(sidebarToggle);
    await waitFor(() => expect(screen.queryByText("正在加载历史…")).not.toBeInTheDocument());
  });

  it("creates Word in its own document tab while keeping start fixed", async () => {
    mocks.createOfficeSession.mockResolvedValue(officeSession("docs", "新建文档"));
    render(<DocMakerView />);

    fireEvent.click(screen.getByRole("button", { name: /Word/ }));

    expect(await screen.findByText("Office 编辑器：新建文档")).toBeInTheDocument();
    expect(mocks.createOfficeSession).toHaveBeenCalledWith({
      ownerSessionKey: "websocket:chat-1",
      type: "docs",
      displayName: "新建文档",
    });
    expect(screen.getByRole("tab", { name: "开始" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /新建文档/ })).toHaveAttribute("aria-selected", "true");

    fireEvent.click(screen.getByRole("button", { name: "打开 MONA AI" }));
    const sidebar = screen.getByRole("complementary", { name: "MONA AI 文档助手" });
    expect(within(sidebar).getByRole("img", { name: "Mona" })).toBeInTheDocument();
    expect(within(sidebar).queryByText("新建文档")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "发送测试消息" }));
    expect(mocks.sendMessage).toHaveBeenCalledWith("chat-1", "修改当前文档", undefined, expect.objectContaining({
      officeSessionId: "docs-session",
      officeDocumentType: "docs",
      officeDisplayName: "新建文档",
    }));
  });

  it("refreshes the start history when an embedded video finishes exporting", async () => {
    const finishedProject = {
      name: "新建视频",
      createdAt: Date.now(),
      resolution: "1920x1080",
      phase: "done" as const,
      hasVideo: true,
      outputStale: false,
      chatId: "storyboard-chat",
    };
    mocks.fetchVideoProjects
      .mockResolvedValueOnce({ projects: [] })
      .mockResolvedValue({ projects: [finishedProject] });
    render(<DocMakerView />);

    fireEvent.click(screen.getByRole("button", { name: /^视频$/ }));
    fireEvent.click(await screen.findByRole("button", { name: "模拟确认分镜" }));
    fireEvent.click(await screen.findByRole("button", { name: "模拟视频导出完成" }));
    fireEvent.click(screen.getByRole("tab", { name: "开始" }));

    expect(
      await screen.findByTestId("document-history-row-video:新建视频"),
    ).toHaveTextContent("视频 · 已完成");
    expect(mocks.fetchVideoProjects).toHaveBeenCalledTimes(3);
  });

  it("opens, restores, and closes a new video tab without creating a chat", async () => {
    const onVisibleConversationChange = vi.fn();
    const onVideoChatsChange = vi.fn();
    const renderView = () => (
      <DocMakerView
        onVisibleConversationChange={onVisibleConversationChange}
        onVideoChatsChange={onVideoChatsChange}
      />
    );
    const view = render(renderView());

    fireEvent.click(screen.getByRole("button", { name: /^视频$/ }));
    expect(await screen.findByRole("tab", { name: "新建视频" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("complementary", { name: "制作对话" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /制作对话/ })).not.toBeInTheDocument();
    await waitFor(() => {
      expect(JSON.parse(localStorage.getItem("mona.ai-docs.workspace.v1") ?? "[]")).toEqual([
        expect.objectContaining({
          kind: "video-workflow",
          chatId: null,
          project: null,
        }),
      ]);
    });
    expect(mocks.newChat).not.toHaveBeenCalled();
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(onVideoChatsChange).toHaveBeenLastCalledWith([]);
    expect(onVideoChatsChange.mock.calls.flatMap(([chatIds]) => chatIds)).not.toContain(null);
    expect(onVisibleConversationChange).toHaveBeenLastCalledWith(null);

    view.unmount();
    render(renderView());
    expect(await screen.findByRole("tab", { name: "新建视频" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("complementary", { name: "制作对话" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /制作对话/ })).not.toBeInTheDocument();
    expect(mocks.newChat).not.toHaveBeenCalled();
    expect(mocks.sendMessage).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "关闭 新建视频" }));
    await waitFor(() => expect(screen.queryByRole("tab", { name: "新建视频" })).not.toBeInTheDocument());
    expect(mocks.newChat).not.toHaveBeenCalled();
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(onVideoChatsChange.mock.calls.flatMap(([chatIds]) => chatIds)).not.toContain(null);
  });

  it("binds the first confirmed storyboard chat to the parent tab and registers it", async () => {
    const onVisibleConversationChange = vi.fn();
    const onVideoChatsChange = vi.fn();
    render(
      <DocMakerView
        onVisibleConversationChange={onVisibleConversationChange}
        onVideoChatsChange={onVideoChatsChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^视频$/ }));
    await screen.findByRole("tab", { name: "新建视频" });
    expect(screen.queryByRole("complementary", { name: "制作对话" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "模拟确认分镜" }));

    const panel = await screen.findByRole("complementary", { name: "制作对话" });
    expect(within(panel).getByText("AI 对话：storyboard-chat")).toBeInTheDocument();
    await waitFor(() => expect(onVisibleConversationChange).toHaveBeenLastCalledWith("storyboard-chat"));
    await waitFor(() => expect(onVideoChatsChange).toHaveBeenLastCalledWith(["storyboard-chat"]));
    expect(screen.getByTestId("embedded-video-project-chat-id")).toHaveTextContent("storyboard-chat");
    expect(mocks.newChat).not.toHaveBeenCalled();
  });

  it("does not reopen a manually collapsed director panel when the bound chat changes phase", async () => {
    render(<DocMakerView />);

    fireEvent.click(screen.getByRole("button", { name: /^视频$/ }));
    await screen.findByRole("tab", { name: "新建视频" });
    fireEvent.click(screen.getByRole("button", { name: "模拟确认分镜" }));
    expect(await screen.findByRole("complementary", { name: "制作对话" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "收起制作对话" }));
    expect(screen.queryByRole("complementary", { name: "制作对话" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "模拟视频导出完成" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "展开制作对话" })).toBeInTheDocument());
    expect(screen.queryByRole("complementary", { name: "制作对话" })).not.toBeInTheDocument();
    expect(screen.getByTestId("embedded-video-project-chat-id")).toHaveTextContent("storyboard-chat");
    expect(mocks.newChat).not.toHaveBeenCalled();
  });

  it("opens the director panel for a video selected from history and keeps it closed after refresh", async () => {
    mocks.fetchVideoProjects.mockResolvedValue({
      projects: [{
        name: "季度培训",
        createdAt: Date.now(),
        resolution: "1920x1080",
        phase: "producing",
        hasVideo: false,
        outputStale: false,
        chatId: "video-chat",
      }],
    });
    render(<DocMakerView />);

    const row = await screen.findByTestId("document-history-row-video:季度培训");
    fireEvent.click(within(row).getByText("季度培训"));

    const directorPanel = await screen.findByRole("complementary", { name: "制作对话" });
    expect(within(directorPanel).getByText("制作对话")).toBeInTheDocument();
    const divider = screen.getByRole("separator", { name: "调整右侧栏宽度" });
    expect(divider).toHaveAttribute("aria-orientation", "vertical");
    expect(divider).toHaveAttribute("tabindex", "0");
    fireEvent.click(screen.getByRole("button", { name: "收起制作对话" }));
    expect(screen.queryByRole("complementary", { name: "制作对话" })).not.toBeInTheDocument();
    expect(screen.queryByRole("separator", { name: "调整右侧栏宽度" })).not.toBeInTheDocument();

    fireEvent.click(await screen.findByRole("button", { name: "模拟视频导出完成" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "展开制作对话" })).toBeInTheDocument());
    expect(screen.queryByRole("complementary", { name: "制作对话" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "展开制作对话" }));
    expect(await screen.findByRole("separator", { name: "调整右侧栏宽度" })).toBeInTheDocument();
  });

  it("reuses an already-open video tab for a requested chat", async () => {
    const project = videoProject("季度培训", "video-chat");
    storeVideoTab(project, "start");
    mocks.fetchVideoProjects.mockResolvedValue({ projects: [project] });
    const onHandled = vi.fn();

    render(
      <DocMakerView
        videoConversationRequest={{ chatId: project.chatId, requestId: 1 }}
        onVideoConversationHandled={onHandled}
      />,
    );

    await waitFor(() => expect(screen.getByRole("tab", { name: project.name })).toHaveAttribute("aria-selected", "true"));
    await waitFor(() => expect(onHandled).toHaveBeenCalledWith(1));
    expect(screen.getAllByRole("tab", { name: project.name })).toHaveLength(1);
    expect(mocks.fetchVideoProjects).toHaveBeenCalledOnce();
    expect(mocks.newChat).not.toHaveBeenCalled();
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it("opens a video project by chatId and deduplicates a repeated request", async () => {
    const project = videoProject("历史培训", "history-video-chat");
    mocks.fetchVideoProjects.mockResolvedValue({ projects: [project] });
    const onHandled = vi.fn();
    const request = (requestId: number) => (
      <DocMakerView
        videoConversationRequest={{ chatId: project.chatId, requestId }}
        onVideoConversationHandled={onHandled}
      />
    );
    const view = render(request(1));

    await waitFor(() => expect(screen.getByRole("tab", { name: project.name })).toHaveAttribute("aria-selected", "true"));
    expect(await screen.findByTestId("embedded-video-project-chat-id")).toHaveTextContent(project.chatId);
    await waitFor(() => expect(onHandled).toHaveBeenCalledWith(1));
    const lookupCount = mocks.fetchVideoProjects.mock.calls.length;

    view.rerender(request(2));

    await waitFor(() => expect(onHandled).toHaveBeenCalledWith(2));
    expect(screen.getAllByRole("tab", { name: project.name })).toHaveLength(1);
    expect(mocks.fetchVideoProjects).toHaveBeenCalledTimes(lookupCount);
    expect(mocks.newChat).not.toHaveBeenCalled();
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it("reports a video chat as visible only while the module and conversation are visible", async () => {
    const project = videoProject("可见性测试", "visible-video-chat");
    const nextProject = videoProject("目标视频", "target-video-chat");
    storeVideoTab(project);
    mocks.fetchVideoProjects.mockResolvedValue({ projects: [project] });
    const onVisibleConversationChange = vi.fn();
    const onVideoConversationHandled = vi.fn();
    const renderView = (visible: boolean, request: { chatId: string; requestId: number } | null = null) => (
      <DocMakerView
        visible={visible}
        videoConversationRequest={request}
        onVideoConversationHandled={onVideoConversationHandled}
        onVisibleConversationChange={onVisibleConversationChange}
      />
    );
    const view = render(renderView(false));

    await screen.findByRole("complementary", { name: "制作对话" });
    await waitFor(() => expect(onVisibleConversationChange).toHaveBeenLastCalledWith(null));
    expect(onVisibleConversationChange).not.toHaveBeenCalledWith(project.chatId);

    view.rerender(renderView(true));
    await waitFor(() => expect(onVisibleConversationChange).toHaveBeenLastCalledWith(project.chatId));
    fireEvent.click(screen.getByRole("button", { name: "收起制作对话" }));
    await waitFor(() => expect(onVisibleConversationChange).toHaveBeenLastCalledWith(null));

    fireEvent.click(screen.getByRole("button", { name: "展开制作对话" }));
    await waitFor(() => expect(onVisibleConversationChange).toHaveBeenLastCalledWith(project.chatId));
    const requestCallStart = onVisibleConversationChange.mock.calls.length;
    let resolveLookup!: (result: { projects: ReturnType<typeof videoProject>[] }) => void;
    const pendingLookup = new Promise<{ projects: ReturnType<typeof videoProject>[] }>((resolve) => {
      resolveLookup = resolve;
    });
    mocks.fetchVideoProjects.mockImplementationOnce(() => pendingLookup);

    view.rerender(renderView(true, { chatId: nextProject.chatId, requestId: 17 }));
    await waitFor(() => expect(mocks.fetchVideoProjects).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(onVisibleConversationChange).toHaveBeenLastCalledWith(null));
    expect(onVisibleConversationChange.mock.calls.slice(requestCallStart)).not.toContainEqual([project.chatId]);

    await act(async () => resolveLookup({ projects: [project, nextProject] }));
    await waitFor(() => expect(onVideoConversationHandled).toHaveBeenCalledWith(17));
    expect(onVisibleConversationChange).toHaveBeenLastCalledWith(null);
    await waitFor(() => expect(
      screen.getAllByTestId("embedded-video-project-chat-id").some((element) => element.textContent === nextProject.chatId),
    ).toBe(true));

    view.rerender(renderView(true, null));
    await waitFor(() => expect(onVisibleConversationChange).toHaveBeenLastCalledWith(nextProject.chatId));
    expect(onVisibleConversationChange.mock.calls.slice(requestCallStart)).not.toContainEqual([project.chatId]);
    expect(mocks.newChat).not.toHaveBeenCalled();
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it("offers history navigation when no video project matches the requested chat", async () => {
    mocks.fetchVideoProjects.mockResolvedValue({ projects: [] });
    const onHandled = vi.fn();
    const onShowChatHistory = vi.fn();

    render(
      <DocMakerView
        videoConversationRequest={{ chatId: "unlinked-video-chat", requestId: 7 }}
        onVideoConversationHandled={onHandled}
        onShowChatHistory={onShowChatHistory}
      />,
    );

    expect(await screen.findByRole("dialog", { name: "视频项目未能打开" })).toHaveTextContent("没有找到这段对话关联的视频项目");
    await waitFor(() => expect(onHandled).toHaveBeenCalledWith(7));
    fireEvent.click(screen.getByRole("button", { name: "查看历史对话" }));

    expect(onShowChatHistory).toHaveBeenCalledWith("unlinked-video-chat");
    expect(mocks.newChat).not.toHaveBeenCalled();
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it("opens the director panel when restoring the active video tab", async () => {
    localStorage.setItem("mona.ai-docs.workspace.v1", JSON.stringify([{
      id: "video:恢复的视频",
      kind: "video-workflow",
      title: "恢复的视频",
      chatId: "video-chat",
      project: { name: "恢复的视频", phase: "producing", chatId: "video-chat" },
      createdAt: Date.now(),
    }]));
    localStorage.setItem("mona.ai-docs.active-tab.v1", "video:恢复的视频");
    render(<DocMakerView />);

    expect(await screen.findByRole("tab", { name: /恢复的视频/ })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByRole("complementary", { name: "制作对话" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "收起制作对话" })).toBeInTheDocument();
  });

  it("drops obsolete PPT workflow tabs from the saved workspace", async () => {
    localStorage.setItem("mona.ai-docs.workspace.v1", JSON.stringify([{
      id: "ppt:旧项目",
      kind: "ppt-workflow",
      title: "旧项目",
      chatId: "ppt-chat",
      ownerSessionKey: "websocket:ppt-chat",
      project: null,
      createdAt: 1,
    }]));
    localStorage.setItem("mona.ai-docs.active-tab.v1", "ppt:旧项目");
    render(<DocMakerView />);

    await waitFor(() => expect(screen.getByRole("tab", { name: "开始" })).toHaveAttribute("aria-selected", "true"));
    expect(screen.queryByRole("tab", { name: "旧项目" })).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("mona.ai-docs.workspace.v1") ?? "[]")).toEqual([]);
  });

  it("opens a context menu for Office history, reveals the file, and can toggle favorite", async () => {
    localStorage.setItem("mona.ai-docs.recent-office.v1", JSON.stringify([{
      key: "office:slides-session",
      sessionId: "slides-session",
      ownerSessionKey: "websocket:slides-chat",
      chatId: "slides-chat",
      title: "季度汇报.pptx",
      officeType: "slides",
      updatedAt: Date.now(),
      sourcePath: "D:\\workspace\\季度汇报.pptx",
    }]));
    render(<DocMakerView />);

    const row = await screen.findByTestId("document-history-row-office:slides-session");
    fireEvent.contextMenu(row);

    expect(await screen.findByRole("menuitem", { name: "打开" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "打开文件目录" }));
    await waitFor(() => {
      expect(mocks.revealItemInDir).toHaveBeenCalledWith("D:\\workspace\\季度汇报.pptx");
    });

    fireEvent.contextMenu(row);
    const favoriteItem = screen.getByRole("menuitem", { name: "收藏" });
    fireEvent.click(favoriteItem);
    expect(screen.getByRole("button", { name: "取消收藏 季度汇报.pptx" })).toBeInTheDocument();
  });

  it("deletes a document project with its files after an explicit confirmation", async () => {
    localStorage.setItem("mona.ai-docs.recent-office.v1", JSON.stringify([{
      key: "office:slides-session",
      sessionId: "slides-session",
      ownerSessionKey: "websocket:slides-chat",
      chatId: "slides-chat",
      title: "季度汇报.pptx",
      officeType: "slides",
      updatedAt: Date.now(),
      sourcePath: "D:\\workspace\\季度汇报.pptx",
    }]));
    render(<DocMakerView />);

    const row = await screen.findByTestId("document-history-row-office:slides-session");
    fireEvent.contextMenu(row);
    fireEvent.click(await screen.findByRole("menuitem", { name: "删除" }));

    // The confirmation states the imported source file is preserved.
    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getByText("删除「季度汇报.pptx」？")).toBeInTheDocument();
    expect(
      screen.getByText(/原文件 D:\\workspace\\季度汇报\.pptx 不会被删除/),
    ).toBeInTheDocument();
    expect(mocks.deleteOfficeSession).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "删除" }));

    await waitFor(() => {
      expect(mocks.deleteOfficeSession).toHaveBeenCalledWith(
        "slides-session",
        "websocket:slides-chat",
      );
    });
    expect(screen.queryByTestId("document-history-row-office:slides-session")).not.toBeInTheDocument();
  });

  it("deletes a video project and closes its open tab after confirmation", async () => {
    mocks.fetchVideoProjects.mockResolvedValue({
      projects: [{
        name: "5个分镜介绍AI模型技术",
        createdAt: Date.now(),
        resolution: "1920x1080",
        phase: "storyboard",
        hasVideo: false,
        outputStale: false,
        chatId: "video-chat",
      }],
    });
    render(<DocMakerView />);

    const row = await screen.findByTestId("document-history-row-video:5个分镜介绍AI模型技术");
    // Open the project, then delete it from the list: the tab must go too.
    fireEvent.click(within(row).getByText("5个分镜介绍AI模型技术"));
    await waitFor(() => expect(screen.getByRole("tab", { name: /5个分镜介绍AI模型技术/ })).toBeInTheDocument());

    fireEvent.contextMenu(row);
    fireEvent.click(await screen.findByRole("menuitem", { name: "删除" }));

    expect(await screen.findByText("删除「5个分镜介绍AI模型技术」？")).toBeInTheDocument();
    expect(screen.getByText(/全部文件（分镜、场景与渲染产物）/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "删除" }));

    await waitFor(() => {
      expect(mocks.deleteVideoProject).toHaveBeenCalledWith("token", "5个分镜介绍AI模型技术");
    });
    expect(screen.queryByTestId("document-history-row-video:5个分镜介绍AI模型技术")).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /5个分镜介绍AI模型技术/ })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "开始" })).toHaveAttribute("aria-selected", "true");
  });

  it("renames an open video tab from the reusable video manager", async () => {
    const original = {
      name: "季度培训",
      createdAt: Date.now(),
      resolution: "1920x1080",
      phase: "storyboard" as const,
      hasVideo: false,
      outputStale: false,
      chatId: "video-chat",
    };
    let projects = [original];
    mocks.fetchVideoProjects.mockImplementation(async () => ({ projects }));
    mocks.renameVideoProject.mockImplementation(
      async (_token: string, oldName: string, newName: string) => {
        expect(oldName).toBe("季度培训");
        projects = [{ ...original, name: newName }];
        return { ok: true };
      },
    );
    render(<DocMakerView />);

    const row = await screen.findByTestId("document-history-row-video:季度培训");
    fireEvent.click(within(row).getByText("季度培训"));
    await screen.findByRole("tab", { name: /季度培训/ });
    fireEvent.click(screen.getByRole("button", { name: "管理视频" }));

    const projectButton = await screen.findByRole("button", {
      name: /打开项目 季度培训/,
    });
    fireEvent.contextMenu(projectButton);
    fireEvent.click(await screen.findByRole("menuitem", { name: "重命名" }));
    fireEvent.change(screen.getByRole("textbox", { name: "项目名称" }), {
      target: { value: "季度培训新版" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存名称" }));
    await waitFor(() => expect(mocks.renameVideoProject).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() =>
      expect(screen.getByRole("tab", { name: /季度培训新版/ })).toBeInTheDocument(),
    );
    expect(screen.queryByRole("tab", { name: /季度培训(?!新版)/ })).not.toBeInTheDocument();
    expect(mocks.renameVideoProject).toHaveBeenCalledWith(
      "token",
      "季度培训",
      "季度培训新版",
    );
  });

  it("closes an open video tab when that project is archived", async () => {
    const project = {
      name: "待归档视频",
      createdAt: Date.now(),
      resolution: "1920x1080",
      phase: "producing" as const,
      hasVideo: false,
      outputStale: false,
      chatId: "video-chat",
    };
    let projects = [project];
    mocks.fetchVideoProjects.mockImplementation(async () => ({ projects }));
    mocks.archiveVideoProject.mockImplementation(async () => {
      projects = [];
      return { ok: true };
    });
    render(<DocMakerView />);

    const row = await screen.findByTestId("document-history-row-video:待归档视频");
    fireEvent.click(within(row).getByText("待归档视频"));
    await screen.findByRole("tab", { name: /待归档视频/ });
    fireEvent.click(screen.getByRole("button", { name: "管理视频" }));

    const projectButton = await screen.findByRole("button", {
      name: /打开项目 待归档视频/,
    });
    fireEvent.contextMenu(projectButton);
    fireEvent.click(await screen.findByRole("menuitem", { name: "归档项目" }));

    await waitFor(() =>
      expect(mocks.archiveVideoProject).toHaveBeenCalledWith(
        "token",
        "待归档视频",
        true,
      ),
    );
    expect(screen.queryByRole("tab", { name: /待归档视频/ })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "开始" })).toHaveAttribute("aria-selected", "true");
  });

  it("keeps the entry and reports the failure when deletion is rejected", async () => {
    localStorage.setItem("mona.ai-docs.recent-office.v1", JSON.stringify([{
      key: "office:slides-session",
      sessionId: "slides-session",
      ownerSessionKey: "websocket:slides-chat",
      chatId: "slides-chat",
      title: "季度汇报.pptx",
      officeType: "slides",
      updatedAt: Date.now(),
    }]));
    mocks.deleteOfficeSession.mockRejectedValue(new Error("文档编辑服务未启动。"));
    render(<DocMakerView />);

    const row = await screen.findByTestId("document-history-row-office:slides-session");
    fireEvent.contextMenu(row);
    fireEvent.click(await screen.findByRole("menuitem", { name: "删除" }));
    fireEvent.click(await screen.findByRole("button", { name: "删除" }));

    expect(await screen.findByText(/删除失败：文档编辑服务未启动。/)).toBeInTheDocument();
    expect(screen.getByTestId("document-history-row-office:slides-session")).toBeInTheDocument();
  });

  it("reveals a saved Office working copy when older history lacks a source path", async () => {
    localStorage.setItem("mona.ai-docs.recent-office.v1", JSON.stringify([{
      key: "office:slides-session",
      sessionId: "slides-session",
      ownerSessionKey: "websocket:slides-chat",
      chatId: "slides-chat",
      title: "新建演示文稿",
      officeType: "slides",
      updatedAt: Date.now(),
    }]));
    mocks.getOfficeSession.mockResolvedValue({
      ...officeSession("slides", "新建演示文稿"),
      workingPath: "D:\\Mona\\office\\sessions\\slides-session\\working.pptx",
    });
    render(<DocMakerView />);

    const row = await screen.findByTestId("document-history-row-office:slides-session");
    fireEvent.contextMenu(row);
    fireEvent.click(await screen.findByRole("menuitem", { name: "打开文件目录" }));

    await waitFor(() => {
      expect(mocks.revealItemInDir).toHaveBeenCalledWith(
        "D:\\Mona\\office\\sessions\\slides-session\\working.pptx",
      );
    });
    expect(localStorage.getItem("mona.ai-docs.recent-office.v1")).toContain("savedPath");
  });

  it("reveals the final rendered video instead of the video project root", async () => {
    mocks.fetchVideoProjects.mockResolvedValue({
      projects: [{
        name: "5个分钟介绍AI模型技术",
        createdAt: Date.now(),
        resolution: "1920x1080",
        phase: "done",
        hasVideo: true,
        outputStale: false,
        chatId: "video-chat",
      }],
    });
    render(<DocMakerView />);

    const row = await screen.findByTestId("document-history-row-video:5个分钟介绍AI模型技术");
    fireEvent.contextMenu(row);
    fireEvent.click(await screen.findByRole("menuitem", { name: "打开文件目录" }));

    await waitFor(() => {
      expect(mocks.revealItemInDir).toHaveBeenCalledWith(
        "D:\\workspace/video_projects/5个分钟介绍AI模型技术/renders/output.mp4",
      );
    });
  });

  it.each([
    ["思维导图", "mindmap", "未命名思维导图"],
    ["流程图", "flowchart", "未命名流程图"],
  ] as const)("creates %s as an editable canvas tab", async (label, kind, title) => {
    render(<DocMakerView />);

    fireEvent.click(screen.getByRole("button", { name: new RegExp(label) }));

    expect(await screen.findByText(new RegExp(`画布编辑器：.*${title}\\.mona-canvas`))).toBeInTheDocument();
    expect(mocks.saveWorkspaceCanvas).toHaveBeenCalledWith(
      "D:/workspace/agent-workspaces/mona/output",
      expect.objectContaining({ kind, title, originChatId: "chat-1" }),
    );
    expect(screen.getByRole("tab", { name: new RegExp(title) })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("complementary", { name: "MONA AI 文档助手" })).toBeInTheDocument();
  });

  it("creates PPT in the native Office editor", async () => {
    mocks.createOfficeSession.mockResolvedValue(officeSession("slides", "新建演示文稿"));
    render(<DocMakerView />);

    fireEvent.click(screen.getByRole("button", { name: /PPT/ }));
    expect(await screen.findByText("Office 编辑器：新建演示文稿")).toBeInTheDocument();
    expect(mocks.createOfficeSession).toHaveBeenCalledWith({
      ownerSessionKey: "websocket:chat-1",
      type: "slides",
      displayName: "新建演示文稿",
    });
    expect(screen.queryByRole("button", { name: "启动AI PPT工作流" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "打开 MONA AI" }));
    fireEvent.click(screen.getByRole("button", { name: "发送测试消息" }));
    expect(mocks.sendMessage).toHaveBeenCalledWith("chat-1", "修改当前文档", undefined, expect.objectContaining({
      officeSessionId: "slides-session",
      officeDocumentType: "slides",
      officeDisplayName: "新建演示文稿",
    }));
  });
  it("routes a style chat back to its existing editor and reads only its visible conversation", async () => {
    const project = videoProject("风格入口测试", "video-chat");
    storeVideoTab(project);
    mocks.fetchVideoProjects.mockResolvedValue({ projects: [project] });
    const onVisible = vi.fn();
    const onHandled = vi.fn();
    const view = render(<DocMakerView onVisibleConversationChange={onVisible} />);
    fireEvent.click(await screen.findByRole("button", { name: "打开风格对话" }));
    await waitFor(() => expect(onVisible).toHaveBeenLastCalledWith("style-chat"));
    expect(screen.queryByRole("complementary", { name: "制作对话" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "隐藏风格对话" }));
    await waitFor(() => expect(onVisible).toHaveBeenLastCalledWith(null));
    view.rerender(<DocMakerView onVisibleConversationChange={onVisible} videoConversationRequest={{ chatId: "style-chat", requestId: 7 }} onVideoConversationHandled={onHandled} />);
    await waitFor(() => expect(onHandled).toHaveBeenCalledWith(7));
    expect(screen.getByTestId("style-conversation-request")).toHaveTextContent("7");
    expect(mocks.newChat).not.toHaveBeenCalled();
  });

});
