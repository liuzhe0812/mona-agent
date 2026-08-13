import { useState } from "react";
import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SystemAgentChat } from "./SystemAgentChat";

const chatMock = vi.hoisted(() => ({
  send: vi.fn(),
  newChat: vi.fn(() => Promise.resolve("system-agent-chat")),
}));

vi.mock("@/providers/ClientProvider", () => ({
  useClientOptional: () => ({ client: { newChat: chatMock.newChat }, token: "test" }),
  useClientContextOrNull: () => ({ client: { newChat: chatMock.newChat }, token: "test" }),
}));

vi.mock("@/hooks/useSessions", () => ({
  useSessionHistory: () => ({ messages: [], loading: false, error: null, hasPendingToolCalls: false, version: 0 }),
}));

vi.mock("@/hooks/useMonaStream", () => ({
  useMonaStream: () => ({
    messages: [],
    isStreaming: false,
    send: chatMock.send,
    stop: vi.fn(),
    setMessages: vi.fn(),
    streamError: null,
    dismissStreamError: vi.fn(),
  }),
}));

describe("SystemAgentChat", () => {
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
});
