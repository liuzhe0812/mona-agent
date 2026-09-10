import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { OfficeSessionState } from "@/components/office/types";
import { useWorkspaceStore } from "@/lib/workspace-store";
import { DocMakerView } from "./DocMakerView";

const mocks = vi.hoisted(() => ({
  createOfficeSession: vi.fn(),
  getOfficeSession: vi.fn(),
  importOfficeSession: vi.fn(),
  fetchPptProjects: vi.fn(),
  fetchPptProjectPath: vi.fn(),
  fetchPptExportStatus: vi.fn(),
  fetchVideoProjects: vi.fn(),
  newChat: vi.fn(),
  sendMessage: vi.fn(),
  saveWorkspaceCanvas: vi.fn(),
  revealItemInDir: vi.fn(),
}));

vi.mock("@/providers/ClientProvider", () => ({
  useClient: () => ({
    client: { newChat: mocks.newChat, sendMessage: mocks.sendMessage },
    token: "token",
  }),
}));

vi.mock("@/lib/office-client", () => ({
  createOfficeSession: mocks.createOfficeSession,
  getOfficeSession: mocks.getOfficeSession,
  importOfficeSession: mocks.importOfficeSession,
}));

vi.mock("@/lib/api", () => ({
  fetchPptProjects: mocks.fetchPptProjects,
  fetchPptProjectPath: mocks.fetchPptProjectPath,
  fetchPptExportStatus: mocks.fetchPptExportStatus,
  fetchVideoProjects: mocks.fetchVideoProjects,
  getApiBase: vi.fn().mockResolvedValue("http://127.0.0.1:17173"),
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

vi.mock("@/components/doc/DocChatPanel", () => ({
  DocChatPanel: ({ chatId, onSend }: { chatId: string; onSend: (content: string) => void }) => (
    <div>
      <span>AI 对话：{chatId}</span>
      <button type="button" onClick={() => onSend("修改当前文档")}>发送测试消息</button>
    </div>
  ),
}));

vi.mock("@/components/ppt/PptMakerView", () => ({
  PptMakerView: () => <div>PPT 工作流</div>,
}));

vi.mock("@/components/doc/video/VideoMakerView", () => ({
  VideoMakerView: () => <div>视频工作流</div>,
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

describe("DocMakerView", () => {
  beforeEach(() => {
    localStorage.clear();
    mocks.createOfficeSession.mockReset();
    mocks.getOfficeSession.mockReset();
    mocks.importOfficeSession.mockReset();
    mocks.fetchPptProjects.mockReset().mockResolvedValue({ projects: [] });
    mocks.fetchPptProjectPath.mockReset().mockResolvedValue({ path: "D:\\workspace\\ppt_projects\\魔兽世界介绍" });
    mocks.fetchPptExportStatus.mockReset().mockResolvedValue({
      exportFile: "output.pptx",
      hasPptxOutput: true,
    });
    mocks.fetchVideoProjects.mockReset().mockResolvedValue({ projects: [] });
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
    expect(screen.getByRole("button", { name: /视频/ })).toBeInTheDocument();
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
    expect(sidebar.parentElement).toBe(screen.getByTestId("document-workspace"));
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

  it("opens a context menu for history rows, reveals the directory, and can toggle favorite", async () => {
    mocks.fetchPptProjects.mockResolvedValue({
      projects: [{
        name: "魔兽世界介绍",
        createdAt: Date.now(),
        format: "16:9",
        slideCount: 5,
        hasExport: true,
        hasSvgOutput: true,
        hasPptxOutput: true,
        hasSpecLock: true,
        status: "done",
        phase: "done",
        chatId: "ppt-chat",
      }],
    });
    render(<DocMakerView />);

    const row = await screen.findByTestId("document-history-row-ppt:魔兽世界介绍");
    fireEvent.contextMenu(row);

    expect(await screen.findByRole("menuitem", { name: "打开" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "打开文件目录" }));
    await waitFor(() => {
      expect(mocks.fetchPptProjectPath).toHaveBeenCalledWith("token", "魔兽世界介绍");
      expect(mocks.revealItemInDir).toHaveBeenCalledWith(
        "D:\\workspace\\ppt_projects\\魔兽世界介绍/output/output.pptx",
      );
    });

    fireEvent.contextMenu(row);
    const favoriteItem = screen.getByRole("menuitem", { name: "收藏" });
    fireEvent.click(favoriteItem);
    expect(screen.getByRole("button", { name: "取消收藏 魔兽世界介绍" })).toBeInTheDocument();
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

  it("opens the PPT workflow from a collaborative PPT editor", async () => {
    mocks.createOfficeSession.mockResolvedValue(officeSession("slides", "新建演示文稿"));
    render(<DocMakerView />);

    fireEvent.click(screen.getByRole("button", { name: /PPT/ }));
    expect(await screen.findByText("Office 编辑器：新建演示文稿")).toBeInTheDocument();

    const workflowButton = screen.getByRole("button", { name: "启动AI PPT工作流" });
    expect(workflowButton.parentElement).toBe(screen.getByRole("tablist", { name: "打开的文档" }).parentElement);
    fireEvent.click(workflowButton);
    expect(await screen.findByText("PPT 工作流")).toBeInTheDocument();
    expect(screen.getByText("MONA AI")).toBeInTheDocument();
    expect(screen.getByText("AI 对话：chat-1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "返回自由编辑" })).toBeInTheDocument();
  });
});
