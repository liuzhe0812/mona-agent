import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AIChat } from "./AIChat";
import { useTerminalStore } from "../store/terminalStore";

const chatMock = vi.hoisted(() => ({
  newChat: vi.fn(),
}));

const historyMock = vi.hoisted(() => ({
  keys: [] as (string | null)[],
}));

vi.mock("@/providers/ClientProvider", () => ({
  useClient: () => ({ client: chatMock, token: "test" }),
  useClientOptional: () => ({ client: chatMock, token: "test" }),
  useClientContextOrNull: () => ({ client: chatMock, token: "test" }),
}));

vi.mock("@/hooks/useSessions", () => ({
  useSessionHistory: (key: string | null) => {
    historyMock.keys.push(key);
    return {
      messages: [],
      loading: false,
      error: null,
      missing: false,
      hasPendingToolCalls: false,
      refresh: vi.fn(),
      version: 0,
    };
  },
}));

vi.mock("@/hooks/useMonaStream", () => ({
  useMonaStream: () => ({
    messages: [],
    isStreaming: false,
    stopping: false,
    send: vi.fn(),
    inject: vi.fn(),
    stop: vi.fn(),
    setMessages: vi.fn(),
  }),
}));

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...actual,
    isTauri: () => false,
    openPathWithSystemApp: vi.fn(),
  };
});

const SSH_SESSION = {
  id: "ssh-session-1",
  configId: "config-1",
  type: "ssh" as const,
  status: "connected" as const,
  title: "10.0.0.1",
};

describe("AIChat terminal session binding", () => {
  beforeEach(() => {
    localStorage.clear();
    historyMock.keys = [];
    chatMock.newChat.mockReset();
    chatMock.newChat.mockResolvedValue("chat-1");
    useTerminalStore.setState({ sessions: [SSH_SESSION], aiChatIds: {} });
  });

  it("creates a visible chat and reuses it after the panel remounts", async () => {
    const first = render(<AIChat sessionId="ssh-session-1" />);
    await waitFor(() => expect(chatMock.newChat).toHaveBeenCalledWith(5_000, false));
    await waitFor(() =>
      expect(useTerminalStore.getState().aiChatIds["ssh-session-1"]).toBe("chat-1"),
    );

    first.unmount();

    await act(async () => {
      render(<AIChat sessionId="ssh-session-1" />);
    });

    expect(chatMock.newChat).toHaveBeenCalledTimes(1);
    expect(historyMock.keys).toContain("websocket:chat-1");
  });

  it("restores the chat bound to the connection after an SSH reconnect", async () => {
    localStorage.setItem(
      "mona.terminal.ai-chat.v1",
      JSON.stringify({ "ssh:config-1": "chat-before-reconnect" }),
    );
    useTerminalStore.setState({
      sessions: [{ ...SSH_SESSION, id: "ssh-session-2" }],
      aiChatIds: {},
    });

    render(<AIChat sessionId="ssh-session-2" />);

    await waitFor(() =>
      expect(useTerminalStore.getState().aiChatIds["ssh-session-2"]).toBe(
        "chat-before-reconnect",
      ),
    );
    expect(chatMock.newChat).not.toHaveBeenCalled();
    expect(historyMock.keys).toContain("websocket:chat-before-reconnect");
  });

  it("keeps the binding so reopening the connection restores the conversation", async () => {
    render(<AIChat sessionId="ssh-session-1" />);
    await waitFor(() =>
      expect(useTerminalStore.getState().aiChatIds["ssh-session-1"]).toBe("chat-1"),
    );

    act(() => {
      useTerminalStore.getState().removeSession("ssh-session-1");
    });
    expect(useTerminalStore.getState().aiChatIds["ssh-session-1"]).toBeUndefined();

    // Reopening the same saved connection gets a new session id.
    act(() => {
      useTerminalStore.setState({
        sessions: [{ ...SSH_SESSION, id: "ssh-session-2" }],
      });
    });
    render(<AIChat sessionId="ssh-session-2" />);

    await waitFor(() =>
      expect(useTerminalStore.getState().aiChatIds["ssh-session-2"]).toBe("chat-1"),
    );
    expect(chatMock.newChat).toHaveBeenCalledTimes(1);
  });

  it("does not persist a binding for a connection-less local shell", async () => {
    useTerminalStore.setState({
      sessions: [{ ...SSH_SESSION, id: "local-1", type: "local", configId: "" }],
      aiChatIds: {},
    });

    render(<AIChat sessionId="local-1" />);

    await waitFor(() =>
      expect(useTerminalStore.getState().aiChatIds["local-1"]).toBe("chat-1"),
    );
    expect(localStorage.getItem("mona.terminal.ai-chat.v1")).toBeNull();
  });

  it("starts a fresh conversation after 重置会话", async () => {
    render(<AIChat sessionId="ssh-session-1" />);
    await waitFor(() =>
      expect(useTerminalStore.getState().aiChatIds["ssh-session-1"]).toBe("chat-1"),
    );

    chatMock.newChat.mockResolvedValue("chat-2");
    act(() => {
      useTerminalStore.getState().setAiChatId("ssh-session-1", null);
    });

    await waitFor(() =>
      expect(useTerminalStore.getState().aiChatIds["ssh-session-1"]).toBe("chat-2"),
    );
    expect(chatMock.newChat).toHaveBeenCalledTimes(2);
  });
});
