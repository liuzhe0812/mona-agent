import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { NoteAgentPanel } from "@/components/notes/NoteAgentPanel";
import { computeNoteBaseHash } from "@/components/notes/note-apply";
import { ResetNoteChatButton } from "@/components/notes/ResetNoteChatButton";
import type { OperationNote } from "@/components/notes/notes-data";
import type { UIMessage } from "@/lib/types";

const streamMock = vi.hoisted(() => ({
  messages: [] as UIMessage[],
  send: vi.fn(),
  stop: vi.fn(),
  setMessages: vi.fn(),
}));

vi.mock("@/hooks/useAttachedDocuments", () => ({
  useAttachedDocuments: () => ({
    documents: [{ name: "support.bin", path: "uploads/chat-1/support.bin" }],
    uploading: false,
    error: null,
    add: vi.fn(),
    remove: vi.fn(),
    clear: vi.fn(),
  }),
}));

vi.mock("@/providers/ClientProvider", () => ({
  useClient: () => ({ client: null, token: "test" }),
  useClientOptional: () => ({ client: null, token: "test" }),
  useClientContextOrNull: () => null,
}));

vi.mock("@/hooks/useSessions", () => ({
  useSessionHistory: () => ({
    messages: [],
    loading: false,
    error: null,
    missing: false,
    hasPendingToolCalls: false,
    refresh: vi.fn(),
    version: 0,
  }),
}));

vi.mock("@/hooks/useMonaStream", () => ({
  useMonaStream: () => ({
    messages: streamMock.messages,
    isStreaming: false,
    stopping: false,
    send: streamMock.send,
    stop: streamMock.stop,
    setMessages: streamMock.setMessages,
    streamError: null,
    dismissStreamError: vi.fn(),
  }),
}));

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return { ...actual, isTauri: () => false };
});

const CONTENT = "# 产品复盘\n\n## 结论\n\n留存下降。\n";

const NOTE: OperationNote = {
  id: "note-1",
  notebookId: "",
  title: "产品复盘",
  preview: "留存下降",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  source: { kind: "manual", label: "手动" },
  contentMarkdown: CONTENT,
  agentChatId: "chat-1",
};

function assistantMessage(id: string, content: string): UIMessage {
  return { id, role: "assistant", content, createdAt: Date.now() };
}

function patchReply(baseHash: string, find: string, replace: string): string {
  return `\`\`\`note-patch\n${JSON.stringify({ baseHash, edits: [{ find, replace }] })}\n\`\`\``;
}

function renderPanel(note: OperationNote = NOTE, onClearChat = vi.fn()) {
  const onApplyResult = vi.fn();
  render(
    <NoteAgentPanel
      note={note}
      transformations={[]}
      onAgentChatIdChange={vi.fn()}
      onApplyResult={onApplyResult}
      onTransformationsChange={vi.fn()}
      onClearChat={onClearChat}
    />,
  );
  return { onApplyResult, onClearChat };
}

describe("NoteAgentPanel 结构化修改", () => {
  beforeEach(() => {
    streamMock.messages = [];
    streamMock.send.mockReset();
    streamMock.stop.mockReset();
    streamMock.setMessages.mockReset();
  });

  it("baseHash 匹配的 note-patch 自动改写笔记正文", async () => {
    streamMock.messages = [
      assistantMessage(
        "m-patch",
        patchReply(computeNoteBaseHash(CONTENT), "留存下降。", "留存下降 5%。"),
      ),
    ];

    const { onApplyResult } = renderPanel();

    await waitFor(() => expect(onApplyResult).toHaveBeenCalledTimes(1));
    const [mode, markdown, messageId] = onApplyResult.mock.calls[0];
    expect(mode).toBe("replace");
    expect(markdown).toContain("留存下降 5%。");
    expect(markdown).not.toContain("留存下降。");
    expect(messageId).toBe("m-patch");
    await screen.findByText("已应用");
  });

  it("baseHash 过期的 note-patch 不自动应用，改为展示过期卡片", async () => {
    streamMock.messages = [
      assistantMessage("m-patch", patchReply("h-stale", "留存下降。", "留存下降 5%。")),
    ];

    const { onApplyResult } = renderPanel();

    await screen.findByText("笔记已修改，该建议已过期");
    expect(onApplyResult).not.toHaveBeenCalled();
  });

  it("note-replace 需用户确认后才应用", async () => {
    streamMock.messages = [assistantMessage("m-replace", "```note-replace\n# 全新正文\n```")];

    const { onApplyResult } = renderPanel();

    await screen.findByText("AI 建议修改笔记");
    expect(onApplyResult).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "应用到笔记" }));
    expect(onApplyResult).toHaveBeenCalledWith("replace", "# 全新正文", "m-replace");
  });

  it("普通回答保持追加/替换手动路径", async () => {
    streamMock.messages = [assistantMessage("m-plain", "这篇笔记在讲留存下降的原因。")];

    const { onApplyResult } = renderPanel();

    await screen.findByRole("button", { name: /替换/ });
    expect(onApplyResult).not.toHaveBeenCalled();
    expect(screen.queryByText("AI 建议修改笔记")).toBeNull();
  });

  it("输入框复用终端模块的 ThreadComposer", async () => {
    renderPanel();

    expect(
      screen.getByPlaceholderText("输入问题，AI 将基于当前笔记回答..."),
    ).toBeInTheDocument();
  });

  it("重置聊天需先确认，取消不清空，确认后才清空", async () => {
    streamMock.messages = [assistantMessage("m-reset", "当前聊天记录")];
    const onClearChat = vi.fn();
    renderPanel(NOTE, onClearChat);

    await screen.findByText("当前聊天记录");
    streamMock.setMessages.mockClear();
    streamMock.setMessages.mockImplementation((next) => {
      streamMock.messages = typeof next === "function" ? next(streamMock.messages) : next;
    });

    await userEvent.click(screen.getByRole("button", { name: "重置会话" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("当前笔记正文会保留");
    expect(streamMock.setMessages).not.toHaveBeenCalledWith([]);
    expect(onClearChat).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(await screen.findByText("当前聊天记录")).toBeInTheDocument();
    expect(streamMock.setMessages).not.toHaveBeenCalledWith([]);
    expect(onClearChat).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "重置会话" }));
    await userEvent.click(screen.getByRole("button", { name: "开始新会话" }));
    expect(streamMock.setMessages).toHaveBeenCalledWith([]);
    expect(onClearChat).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("当前聊天记录")).toBeNull();
  });

  it("不显示总结快捷按钮，仍提供翻译和 HTML 生成", () => {
    renderPanel();

    expect(screen.queryByRole("button", { name: "总结当前笔记" })).toBeNull();
    expect(screen.getByRole("button", { name: "翻译" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "生成HTML文档" })).toBeInTheDocument();
  });

  it("禁用时不打开重置确认", async () => {
    const onReset = vi.fn();
    render(<ResetNoteChatButton disabled onReset={onReset} />);

    const reset = screen.getByRole("button", { name: "重置会话" });
    expect(reset).toBeDisabled();
    await userEvent.click(reset);

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onReset).not.toHaveBeenCalled();
  });

  it("把附件路径和名称传给笔记 Agent", async () => {
    renderPanel();

    await userEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(streamMock.send).toHaveBeenCalledWith(
      expect.any(String),
      undefined,
      expect.objectContaining({
        docPaths: ["uploads/chat-1/support.bin"],
        documentNames: ["support.bin"],
      }),
    );
  });
});
