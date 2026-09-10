import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  addAgentKnowledgeDocuments: vi.fn(),
  deleteAgentKnowledgeDocument: vi.fn(),
  listAgentKnowledgeDocuments: vi.fn(),
  listWikiPages: vi.fn(),
  retryAgentKnowledgeDocument: vi.fn(),
  isTauri: vi.fn(),
  materialsImportFiles: vi.fn(),
  open: vi.fn(),
}));

vi.mock("@/lib/materials-api", () => ({
  addAgentKnowledgeDocuments: mocks.addAgentKnowledgeDocuments,
  deleteAgentKnowledgeDocument: mocks.deleteAgentKnowledgeDocument,
  listAgentKnowledgeDocuments: mocks.listAgentKnowledgeDocuments,
  listWikiPages: mocks.listWikiPages,
  retryAgentKnowledgeDocument: mocks.retryAgentKnowledgeDocument,
}));

vi.mock("@/lib/tauri", () => ({
  isTauri: mocks.isTauri,
  materialsImportFiles: mocks.materialsImportFiles,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open }));

import { AgentKnowledgePanel } from "./AgentKnowledgePanel";
import type { AgentKnowledgeDocument } from "@/lib/materials-api";

const availableDocument: AgentKnowledgeDocument = {
  id: "doc-available",
  name: "产品手册.pdf",
  path: "docs/产品手册.pdf",
  size: 2048,
  status: "available",
  phase: "ready",
  updatedAt: "2026-09-05T00:00:00Z",
};

const failedDocument: AgentKnowledgeDocument = {
  id: "doc-failed",
  name: "扫描页.png",
  path: "images/扫描页.png",
  size: 1024,
  status: "unavailable",
  phase: "failed",
  message: "图片内容无法读取。",
  updatedAt: "2026-09-05T00:00:00Z",
};

const learningDocument: AgentKnowledgeDocument = {
  ...failedDocument,
  id: "doc-learning",
  phase: "learning",
  message: "正在读取资料",
  progress: {
    stage: "extracting",
    label: "读取资料",
    detail: "正在读取这份资料的内容。",
    completed: 1,
    total: 4,
    percent: 25,
    evidenceReady: false,
  },
};

const organizingDocument: AgentKnowledgeDocument = {
  ...learningDocument,
  progress: {
    stage: "organizing",
    label: "整理知识",
    detail: "正在整理资料中的章节和重点。",
    completed: 3,
    total: 5,
    percent: 60,
    evidenceReady: true,
  },
};

const evidenceReadyFailedDocument: AgentKnowledgeDocument = {
  ...failedDocument,
  message: "资料已读取，但知识整理没有完成。",
  progress: {
    stage: "failed",
    label: "整理知识",
    detail: "资料内容已读取，但知识整理没有完成。",
    evidenceReady: true,
  },
};

describe("AgentKnowledgePanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isTauri.mockReturnValue(true);
    mocks.listAgentKnowledgeDocuments.mockResolvedValue([]);
    mocks.listWikiPages.mockResolvedValue([]);
    mocks.addAgentKnowledgeDocuments.mockResolvedValue([]);
    mocks.deleteAgentKnowledgeDocument.mockResolvedValue(undefined);
    mocks.retryAgentKnowledgeDocument.mockResolvedValue(undefined);
    mocks.materialsImportFiles.mockResolvedValue([]);
    mocks.open.mockResolvedValue(null);
  });

  it("shows user-facing availability and learning states", async () => {
    mocks.listAgentKnowledgeDocuments.mockResolvedValue([availableDocument, failedDocument]);
    const user = userEvent.setup();

    render(<AgentKnowledgePanel agentId="agent.demo" onSelect={() => undefined} />);

    expect(screen.getByText("添加资料，让这个 Agent 在完成任务时参考其中的信息。")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "选择 产品手册.pdf" })).toBeInTheDocument();
    expect(screen.getByText("已学习")).toBeInTheDocument();
    expect(screen.getByText("未学习")).toBeInTheDocument();
    expect(screen.queryByText("可用")).not.toBeInTheDocument();
    expect(screen.queryByText("不可用")).not.toBeInTheDocument();
    expect(screen.queryByText("学习失败")).not.toBeInTheDocument();
    expect(screen.getByText("图片内容无法读取。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "更多操作 扫描页.png" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "删除 扫描页.png" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "更多操作 扫描页.png" }));
    expect(screen.getByRole("menuitem", { name: "重新学习 扫描页.png" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "删除 扫描页.png" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "更多操作 产品手册.pdf" }));
    expect(screen.getByRole("menuitem", { name: "重新学习 产品手册.pdf" })).not.toHaveAttribute("data-disabled");
    expect(screen.queryByText(/知识库|编译|证据覆盖|MD5/)).not.toBeInTheDocument();
  });

  it("selects a document with an Agent-scoped raw path", async () => {
    const onSelect = vi.fn();
    mocks.listAgentKnowledgeDocuments.mockResolvedValue([availableDocument]);
    const user = userEvent.setup();

    render(<AgentKnowledgePanel agentId="agent.demo" onSelect={onSelect} />);
    await user.click(await screen.findByRole("button", { name: "选择 产品手册.pdf" }));

    expect(onSelect).toHaveBeenCalledWith({
      kind: "raw",
      path: "raw/docs/产品手册.pdf",
      agentId: "agent.demo",
    });
  });

  it("expands business-language learning progress inside the document card", async () => {
    mocks.listAgentKnowledgeDocuments.mockResolvedValue([organizingDocument]);
    const user = userEvent.setup();

    render(<AgentKnowledgePanel agentId="agent.demo" onSelect={() => undefined} />);

    const progressButton = await screen.findByRole("button", { name: "查看学习进度 扫描页.png" });
    await user.click(progressButton);

    expect(screen.getByTestId("learning-progress-doc-learning")).toBeInTheDocument();
    expect(screen.getByText("读取资料")).toBeInTheDocument();
    expect(screen.getByText("整理知识")).toBeInTheDocument();
    expect(screen.getByText("可以使用")).toBeInTheDocument();
    expect(screen.getByText("已整理 3/5 部分")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "资料学习进度" })).toHaveAttribute("aria-valuenow", "60");
    expect(screen.getByText("正在整理资料中的章节和重点。")).toBeInTheDocument();
    expect(screen.queryByText(/批次|模型|token|进程|端口|工具名/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "收起学习进度 扫描页.png" }));
    expect(screen.queryByTestId("learning-progress-doc-learning")).not.toBeInTheDocument();
  });

  it("explains when original material is searchable after learning fails", async () => {
    mocks.listAgentKnowledgeDocuments.mockResolvedValue([evidenceReadyFailedDocument]);

    render(<AgentKnowledgePanel agentId="agent.demo" onSelect={() => undefined} />);

    expect(await screen.findByText("资料已读取，但知识整理没有完成。")).toBeInTheDocument();
    expect(screen.getByText("整理未完成")).toBeInTheDocument();
    expect(screen.getByText("原文已可检索，知识整理可重试。")).toBeInTheDocument();
  });

  it("opens compiled learning results in the same Agent scope", async () => {
    const onSelect = vi.fn();
    mocks.listWikiPages.mockResolvedValue([
      { id: "wiki-one", path: "concepts/产品.md", title: "产品", mtime: 1 },
    ]);
    const user = userEvent.setup();

    render(<AgentKnowledgePanel agentId="agent.demo" onSelect={onSelect} />);
    await user.click(screen.getByRole("button", { name: "查看学习结果" }));
    await user.click(await screen.findByRole("button", { name: "产品" }));

    expect(mocks.listWikiPages).toHaveBeenCalledWith(undefined, "agent.demo");
    expect(onSelect).toHaveBeenCalledWith({
      kind: "wiki",
      path: "concepts/产品.md",
      agentId: "agent.demo",
    });
  });

  it("imports selected files and starts learning without a second action", async () => {
    const learnedDocument = { ...availableDocument, path: "产品手册.pdf" };
    mocks.open.mockResolvedValue(["C:\\资料\\产品手册.pdf"]);
    mocks.materialsImportFiles.mockResolvedValue([
      { name: "产品手册.pdf", path: "产品手册.pdf", kind: "file", size: 2048, mtime: null },
    ]);
    mocks.addAgentKnowledgeDocuments.mockResolvedValue([learnedDocument]);
    mocks.listAgentKnowledgeDocuments
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([learnedDocument]);
    const user = userEvent.setup();

    render(<AgentKnowledgePanel agentId="agent.demo" onSelect={() => undefined} />);
    await user.click(screen.getByRole("button", { name: "添加资料" }));

    await waitFor(() => expect(mocks.materialsImportFiles).toHaveBeenCalledWith(
      ["C:\\资料\\产品手册.pdf"],
      "",
      undefined,
      "agent.demo",
    ));
    expect(mocks.addAgentKnowledgeDocuments).toHaveBeenCalledWith(
      "agent.demo",
      ["产品手册.pdf"],
    );
    expect(mocks.open).toHaveBeenCalledWith(expect.objectContaining({
      multiple: true,
      filters: [expect.objectContaining({
        extensions: expect.arrayContaining(["png", "jpg", "jpeg", "webp"]),
      })],
    }));
    expect(await screen.findByRole("button", { name: "选择 产品手册.pdf" })).toBeInTheDocument();
  });

  it("forces a learning document to restart and removes the selected document", async () => {
    const onSelect = vi.fn();
    mocks.listAgentKnowledgeDocuments
      .mockResolvedValueOnce([availableDocument, learningDocument])
      .mockResolvedValueOnce([availableDocument, learningDocument])
      .mockResolvedValueOnce([availableDocument]);
    const user = userEvent.setup();

    render(
      <AgentKnowledgePanel
        agentId="agent.demo"
        selection={{ kind: "raw", path: "raw/images/扫描页.png", agentId: "agent.demo" }}
        onSelect={onSelect}
      />,
    );
    await user.click(await screen.findByRole("button", { name: "更多操作 扫描页.png" }));
    expect(screen.getByText("学习中")).toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "重新学习 扫描页.png" }));
    await waitFor(() => expect(mocks.retryAgentKnowledgeDocument).toHaveBeenCalledWith("doc-learning", "agent.demo"));
    expect(mocks.retryAgentKnowledgeDocument).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "更多操作 扫描页.png" }));
    await user.click(screen.getByRole("menuitem", { name: "删除 扫描页.png" }));
    await user.click(screen.getByRole("button", { name: "删除", exact: true }));
    await waitFor(() => expect(mocks.deleteAgentKnowledgeDocument).toHaveBeenCalledWith("doc-learning", "agent.demo"));
    expect(onSelect).toHaveBeenCalledWith(null);
  });
});
