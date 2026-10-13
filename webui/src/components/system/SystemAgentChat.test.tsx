import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SystemAgentChat } from "./SystemAgentChat";

const chatMock = vi.hoisted(() => ({
  send: vi.fn(),
  stop: vi.fn(),
  isStreaming: false,
  stopping: false,
  onDocUploadResult: vi.fn(() => () => {}),
  newChat: vi.fn(() => Promise.resolve("system-agent-chat")),
}));

vi.mock("@/providers/ClientProvider", () => ({
  useClientOptional: () => ({ client: { newChat: chatMock.newChat }, token: "test" }),
  useClientContextOrNull: () => ({ client: { newChat: chatMock.newChat, onDocUploadResult: chatMock.onDocUploadResult }, token: "test" }),
}));

vi.mock("@/hooks/useSessions", () => ({
  useSessionHistory: () => ({ messages: [], loading: false, error: null, hasPendingToolCalls: false, version: 0 }),
}));

vi.mock("@/hooks/useMonaStream", () => ({
  useMonaStream: () => ({
    messages: [],
    isStreaming: chatMock.isStreaming,
    stopping: chatMock.stopping,
    send: chatMock.send,
    stop: chatMock.stop,
    setMessages: vi.fn(),
    streamError: null,
    dismissStreamError: vi.fn(),
  }),
}));

describe("SystemAgentChat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chatMock.isStreaming = false;
    chatMock.stopping = false;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ icons: [], agents: [] }))));
  });

  it("creates an ephemeral chat and sends the handoff task", async () => {
    const onChatCreated = vi.fn();
    const onTaskHandled = vi.fn();

    function Harness() {
      const [chatId, setChatId] = useState<string | null>(null);
      return (
        <SystemAgentChat
          chatId={chatId}
          task={{ id: "startup-wechat", title: "禁用 WeChat 启动项", action: "禁用启动项", target: "WeChat", arguments: { id: "wechat", enabled: false }, error: "access denied" }}
          onChatCreated={(id) => { setChatId(id); onChatCreated(id); }}
          onTaskHandled={onTaskHandled}
        />
      );
    }

    render(<Harness />);

    await waitFor(() => expect(chatMock.newChat).toHaveBeenCalledWith(5_000, true));
    await waitFor(() => expect(chatMock.send).toHaveBeenCalledWith(expect.stringContaining("错误：access denied"), undefined, { displayContent: "禁用 WeChat 启动项" }));
    expect(onChatCreated).toHaveBeenCalledWith("system-agent-chat");
    expect(onTaskHandled).toHaveBeenCalledWith("startup-wechat");
  });

  it("sends a multiline follow-up through the shared composer", () => {
    render(<SystemAgentChat chatId="system-agent-chat" task={null} onChatCreated={vi.fn()} onTaskHandled={vi.fn()} />);
    const input = screen.getByPlaceholderText("继续告诉 Mona...");
    fireEvent.change(input, { target: { value: "先检查\n不要删除文件" } });
    fireEvent.click(screen.getByRole("button", { name: "发送给 Mona" }));
    expect(chatMock.send).toHaveBeenCalledWith("先检查\n不要删除文件", undefined, undefined);
    expect(input).toHaveValue("");
  });

  it("keeps stop available with an empty draft and prevents a second stop while confirming", () => {
    chatMock.isStreaming = true;
    const props = { chatId: "system-agent-chat", task: null, onChatCreated: vi.fn(), onTaskHandled: vi.fn() };
    const { rerender } = render(<SystemAgentChat {...props} />);
    const stop = screen.getByRole("button", { name: "停止执行" });
    expect(stop).toBeEnabled();
    fireEvent.click(stop);
    expect(chatMock.stop).toHaveBeenCalledTimes(1);

    chatMock.stopping = true;
    rerender(<SystemAgentChat {...props} />);
    expect(screen.getByRole("button", { name: "Stopping" })).toBeDisabled();
  });
});
