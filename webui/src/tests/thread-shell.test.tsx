import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ThreadShell } from "@/components/thread/ThreadShell";
import { useFilePreviewStore } from "@/components/deliver/filePreviewStore";
import { ClientProvider } from "@/providers/ClientProvider";
import type { UIMessage } from "@/lib/types";

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...actual,
    isTauri: () => true,
    // Base-URL resolution in api.ts goes through these when isTauri() is
    // true; keep them on fixed loopback ports so stubbed fetch still matches.
    getGatewayStatus: async () => ({ running: true, port: 17173, ws_port: 8765 }),
    getServicesStatus: async () => ({ running: true, port: 17174 }),
    startGateway: async () => 17173,
    startServices: async () => 17174,
    moveToTrash: vi.fn(),
    openPathWithSystemApp: vi.fn(),
    revealItemInDir: vi.fn(),
  };
});

vi.mock("@tauri-apps/plugin-fs", () => ({
  remove: vi.fn(),
}));

vi.mock("@/components/terminal/FileManager/iconCache", () => ({
  getCachedIcon: () => null,
  getIcon: async () => null,
  extractExtension: (name: string) => {
    const dot = name.lastIndexOf(".");
    return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
  },
}));
function makeClient() {
  const errorHandlers = new Set<(err: { kind: string }) => void>();
  const chatHandlers = new Map<string, Set<(ev: import("@/lib/types").InboundEvent) => void>>();
  const sessionUpdateHandlers = new Set<(chatId: string, scope?: string) => void>();
  const artifactsChangedHandlers = new Set<() => void>();
  const goalStateByChatId = new Map<string, import("@/lib/types").GoalStateWsPayload>();
  return {
    status: "open" as const,
    defaultChatId: null as string | null,
    onStatus: () => () => {},
    onRuntimeModelUpdate: () => () => {},
    getRunStartedAt: () => null,
    getGoalState: (chatId: string) => goalStateByChatId.get(chatId),
    onChat: (chatId: string, handler: (ev: import("@/lib/types").InboundEvent) => void) => {
      let handlers = chatHandlers.get(chatId);
      if (!handlers) {
        handlers = new Set();
        chatHandlers.set(chatId, handlers);
      }
      handlers.add(handler);
      return () => {
        handlers?.delete(handler);
      };
    },
    onError: (handler: (err: { kind: string }) => void) => {
      errorHandlers.add(handler);
      return () => {
        errorHandlers.delete(handler);
      };
    },
    onSessionUpdate: (handler: (chatId: string, scope?: string) => void) => {
      sessionUpdateHandlers.add(handler);
      return () => {
        sessionUpdateHandlers.delete(handler);
      };
    },
    onArtifactsChanged: (handler: () => void) => {
      artifactsChangedHandlers.add(handler);
      return () => {
        artifactsChangedHandlers.delete(handler);
      };
    },
    _emitError(err: { kind: string }) {
      for (const h of errorHandlers) h(err);
    },
    _emitChat(chatId: string, ev: import("@/lib/types").InboundEvent) {
      if (ev.event === "goal_state") {
        goalStateByChatId.set(chatId, ev.goal_state);
      }
      for (const h of chatHandlers.get(chatId) ?? []) h(ev);
    },
    _emitSessionUpdate(chatId: string, scope?: string) {
      for (const h of sessionUpdateHandlers) h(chatId, scope);
    },
    _emitArtifactsChanged() {
      for (const h of artifactsChangedHandlers) h();
    },
    sendMessage: vi.fn(),
    newChat: vi.fn(),
    attach: vi.fn(),
    connect: vi.fn(),
    close: vi.fn(),
    updateUrl: vi.fn(),
  };
}

function wrap(client: ReturnType<typeof makeClient>, children: ReactNode) {
  return (
    <ClientProvider
      client={client as unknown as import("@/lib/mona-client").MonaClient}
      token="tok"
    >
      {children}
    </ClientProvider>
  );
}

function session(chatId: string) {
  return {
    key: `websocket:${chatId}`,
    channel: "websocket" as const,
    chatId,
    createdAt: null,
    updatedAt: null,
    preview: "",
  };
}

function transcriptFromSimpleMessages(
  rows: Array<{ role: "user" | "assistant"; content: string }>,
): { schemaVersion: number; messages: UIMessage[] } {
  return {
    schemaVersion: 3,
    messages: rows.map((m, i) => ({
      id: `m-${i}`,
      role: m.role,
      content: m.content,
      createdAt: 1000 + i,
    })),
  };
}

function httpJson(body: unknown) {
  return {
    ok: true,
    status: 200,
    // ``request()`` in api.ts inspects the content-type header on ok
    // responses; a bare ``{ok, json}`` stub would throw TypeError there.
    headers: { get: () => "application/json" },
    json: async () => body,
  };
}

describe("ThreadShell", () => {
  beforeEach(() => {
    // Module-singleton stores leak across tests (e.g. a test that collapses
    // the workspace panel would hide it for every later test): reset.
    useFilePreviewStore.setState({
      file: null,
      scope: "shared",
      sessionKey: null,
      workspaceCollapsed: false,
      fullscreen: false,
      artifactBaseline: null,
      viewedArtifactPaths: new Set(),
      deletedArtifactPaths: new Set(),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({}),
      }),
    );
  });

  beforeEach(async () => {
    // File-level mocks are shared across tests in this file; reset call
    // history so delete-path assertions stay isolated.
    const { moveToTrash } = await import("@/lib/tauri");
    const { remove } = await import("@tauri-apps/plugin-fs");
    vi.mocked(moveToTrash).mockClear();
    vi.mocked(remove).mockClear();
  });

  it("does not navigate away when clicking the chat title", async () => {
    const client = makeClient();
    const onGoHome = vi.fn();
    render(wrap(
      client,
      <ThreadShell
        session={session("chat-title")}
        title="Important conversation"
        onToggleSidebar={() => {}}
        onGoHome={onGoHome}
        onNewChat={() => {}}
      />,
    ));

    await waitFor(() => expect(screen.getByText("Important conversation")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Important conversation"));

    expect(onGoHome).not.toHaveBeenCalled();
  });

  it("restores in-memory messages when switching away and back to a session", async () => {
    const client = makeClient();
    const onNewChat = vi.fn().mockResolvedValue("chat-a");

    const { rerender } = render(
      wrap(
        client,
        <ThreadShell
          session={session("chat-a")}
          title="Chat chat-a"
          onToggleSidebar={() => {}}
          onGoHome={() => {}}
          onNewChat={onNewChat}
        />,
      ),
    );

    fireEvent.change(screen.getByLabelText("Message input"), {
      target: { value: "persist me across tabs" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(client.sendMessage).toHaveBeenCalledWith(
        "chat-a",
        "persist me across tabs",
        undefined,
      ),
    );
    expect(screen.getByText("persist me across tabs")).toBeInTheDocument();

    await act(async () => {
      rerender(
        wrap(
          client,
          <ThreadShell
            session={session("chat-b")}
            title="Chat chat-b"
            onToggleSidebar={() => {}}
            onGoHome={() => {}}
            onNewChat={onNewChat}
          />,
        ),
      );
    });

    await act(async () => {
      rerender(
        wrap(
          client,
          <ThreadShell
            session={session("chat-a")}
            title="Chat chat-a"
            onToggleSidebar={() => {}}
            onGoHome={() => {}}
            onNewChat={onNewChat}
          />,
        ),
      );
    });

    expect(screen.getByText("persist me across tabs")).toBeInTheDocument();
  });

  it("clears the old thread when the active session is removed", async () => {
    const client = makeClient();
    const onNewChat = vi.fn().mockResolvedValue("chat-a");

    const { rerender } = render(
      wrap(
        client,
        <ThreadShell
          session={session("chat-a")}
          title="Chat chat-a"
          onToggleSidebar={() => {}}
          onGoHome={() => {}}
          onNewChat={onNewChat}
        />,
      ),
    );

    fireEvent.change(screen.getByLabelText("Message input"), {
      target: { value: "delete me cleanly" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(client.sendMessage).toHaveBeenCalledWith(
        "chat-a",
        "delete me cleanly",
        undefined,
      ),
    );
    expect(screen.getByText("delete me cleanly")).toBeInTheDocument();

    await act(async () => {
      rerender(
        wrap(
          client,
          <ThreadShell
            session={null}
            title="mona"
            onToggleSidebar={() => {}}
            onGoHome={() => {}}
            onNewChat={onNewChat}
          />,
        ),
      );
    });

    await waitFor(() => {
      expect(screen.queryByText("delete me cleanly")).not.toBeInTheDocument();
    });
    expect(
      screen.getByPlaceholderText("问任何问题、运行终端、查笔记、维护 Windows..."),
    ).toBeInTheDocument();
  });

  it("creates a chat only when the blank landing sends a first message", async () => {
    const client = makeClient();
    const onNewChat = vi.fn();
    const onCreateChat = vi.fn().mockResolvedValue("chat-new");

    render(
      wrap(
        client,
        <ThreadShell
          session={null}
          title="mona"
          onToggleSidebar={() => {}}
          onGoHome={() => {}}
          onNewChat={onNewChat}
          onCreateChat={onCreateChat}
        />,
      ),
    );

    fireEvent.change(screen.getByLabelText("Message input"), {
      target: { value: "start for real" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(onCreateChat).toHaveBeenCalledTimes(1));
    expect(onNewChat).not.toHaveBeenCalled();
  });

  it("keeps the first landing message when new chat history is still empty", async () => {
    const client = makeClient();
    const onCreateChat = vi.fn().mockResolvedValue("chat-new");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 404,
        json: async () => ({}),
      })),
    );

    const { rerender } = render(
      wrap(
        client,
        <ThreadShell
          session={null}
          title="mona"
          onToggleSidebar={() => {}}
          onCreateChat={onCreateChat}
        />,
      ),
    );

    fireEvent.change(screen.getByLabelText("Message input"), {
      target: { value: "first message should stay" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(onCreateChat).toHaveBeenCalledTimes(1));

    await act(async () => {
      rerender(
        wrap(
          client,
          <ThreadShell
            session={session("chat-new")}
            title="Chat chat-new"
            onToggleSidebar={() => {}}
            onCreateChat={onCreateChat}
          />,
        ),
      );
    });

    await waitFor(() =>
      expect(client.sendMessage).toHaveBeenCalledWith(
        "chat-new",
        "first message should stay",
        undefined,
      ),
    );
    await waitFor(() =>
      expect(screen.getByText("first message should stay")).toBeInTheDocument(),
    );
    expect(screen.queryByText("What can I do for you?")).not.toBeInTheDocument();
  });

  it("sends quick action prompts from the empty thread landing", async () => {
    const client = makeClient();
    const onNewChat = vi.fn().mockResolvedValue("chat-a");

    render(
      wrap(
        client,
        <ThreadShell
          session={session("chat-a")}
          title="Chat chat-a"
          onToggleSidebar={() => {}}
          onGoHome={() => {}}
          onNewChat={onNewChat}
        />,
      ),
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "网页生成笔记" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "网页生成笔记" }));

    // Hero chips fill the composer (cursor marker stripped); the user then sends.
    await waitFor(() =>
      expect(screen.getByLabelText("Message input")).toHaveValue("把这个网页转成笔记："),
    );
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(client.sendMessage).toHaveBeenCalledWith(
        "chat-a",
        "把这个网页转成笔记：",
        undefined,
      ),
    );
  });

  it("does not leak the previous thread when opening a brand-new chat", async () => {
    const client = makeClient();
    const onNewChat = vi.fn().mockResolvedValue("chat-new");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("websocket%3Achat-a/webui-thread")) {
          return httpJson(
            transcriptFromSimpleMessages([
              { role: "user", content: "old question" },
              { role: "assistant", content: "old answer" },
            ]),
          );
        }
        return {
          ok: false,
          status: 404,
          json: async () => ({}),
        };
      }),
    );

    const { rerender } = render(
      wrap(
        client,
        <ThreadShell
          session={session("chat-a")}
          title="Chat chat-a"
          onToggleSidebar={() => {}}
          onGoHome={() => {}}
          onNewChat={onNewChat}
        />,
      ),
    );

    await waitFor(() => expect(screen.getByText("old answer")).toBeInTheDocument());

    await act(async () => {
      rerender(
        wrap(
          client,
          <ThreadShell
            session={session("chat-new")}
            title="Chat chat-new"
            onToggleSidebar={() => {}}
            onGoHome={() => {}}
            onNewChat={onNewChat}
          />,
        ),
      );
    });

    expect(screen.queryByText("old answer")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByPlaceholderText("问任何问题、运行终端、查笔记、维护 Windows..."),
      ).toBeInTheDocument(),
    );
    const input = screen.getByPlaceholderText("问任何问题、运行终端、查笔记、维护 Windows...");
    expect(input.className).toContain("min-h-[78px]");
    expect(screen.queryByText("old answer")).not.toBeInTheDocument();
  });

  it("does not cache optimistic messages under the next chat during a session switch", async () => {
    const client = makeClient();
    const onNewChat = vi.fn().mockResolvedValue("chat-b");

    const { rerender } = render(
      wrap(
        client,
        <ThreadShell
          session={session("chat-a")}
          title="Chat chat-a"
          onToggleSidebar={() => {}}
          onGoHome={() => {}}
          onNewChat={onNewChat}
        />,
      ),
    );

    fireEvent.change(screen.getByLabelText("Message input"), {
      target: { value: "only in chat a" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(client.sendMessage).toHaveBeenCalledWith(
        "chat-a",
        "only in chat a",
        undefined,
      ),
    );
    expect(screen.getByText("only in chat a")).toBeInTheDocument();

    await act(async () => {
      rerender(
        wrap(
          client,
          <ThreadShell
            session={session("chat-b")}
            title="Chat chat-b"
            onToggleSidebar={() => {}}
            onGoHome={() => {}}
            onNewChat={onNewChat}
          />,
        ),
      );
    });

    await waitFor(() => {
      expect(screen.queryByText("only in chat a")).not.toBeInTheDocument();
    });

    await act(async () => {
      rerender(
        wrap(
          client,
          <ThreadShell
            session={session("chat-a")}
            title="Chat chat-a"
            onToggleSidebar={() => {}}
            onGoHome={() => {}}
            onNewChat={onNewChat}
          />,
        ),
      );
    });

    expect(screen.getByText("only in chat a")).toBeInTheDocument();

    await act(async () => {
      rerender(
        wrap(
          client,
          <ThreadShell
            session={session("chat-b")}
            title="Chat chat-b"
            onToggleSidebar={() => {}}
            onGoHome={() => {}}
            onNewChat={onNewChat}
          />,
        ),
      );
    });

    await waitFor(() => {
      expect(screen.queryByText("only in chat a")).not.toBeInTheDocument();
    });
  });

  it("keeps live assistant replies after visiting the blank new-chat page", async () => {
    const client = makeClient();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("websocket%3Achat-a/webui-thread")) {
          return httpJson(transcriptFromSimpleMessages([{ role: "user", content: "hello" }]));
        }
        return {
          ok: false,
          status: 404,
          json: async () => ({}),
        };
      }),
    );

    const { rerender } = render(
      wrap(
        client,
        <ThreadShell
          session={session("chat-a")}
          title="Chat chat-a"
          onToggleSidebar={() => {}}
          onNewChat={() => {}}
        />,
      ),
    );

    await waitFor(() => expect(screen.getByText("hello")).toBeInTheDocument());
    await act(async () => {
      client._emitChat("chat-a", {
        event: "message",
        chat_id: "chat-a",
        text: "live assistant reply",
      });
    });
    expect(screen.getByText("live assistant reply")).toBeInTheDocument();

    await act(async () => {
      rerender(
        wrap(
          client,
          <ThreadShell
            session={null}
            title="mona"
            onToggleSidebar={() => {}}
            onNewChat={() => {}}
          />,
        ),
      );
    });

    expect(screen.queryByText("live assistant reply")).not.toBeInTheDocument();
    expect(screen.getByText("What can I do for you?")).toBeInTheDocument();

    await act(async () => {
      rerender(
        wrap(
          client,
          <ThreadShell
            session={session("chat-a")}
            title="Chat chat-a"
            onToggleSidebar={() => {}}
            onNewChat={() => {}}
          />,
        ),
      );
    });

    await waitFor(() => expect(screen.getByText("live assistant reply")).toBeInTheDocument());
  });

  it("does not refetch thread history on turn_end", async () => {
    const client = makeClient();
    let historyCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("websocket%3Achat-a/webui-thread")) {
          historyCalls += 1;
          return httpJson(
            transcriptFromSimpleMessages(
              historyCalls === 1
                ? [{ role: "user", content: "question" }]
                : [
                    { role: "user", content: "question" },
                    { role: "assistant", content: "canonical markdown answer" },
                  ],
            ),
          );
        }
        return {
          ok: false,
          status: 404,
          json: async () => ({}),
        };
      }),
    );

    render(
      wrap(
        client,
        <ThreadShell
          session={session("chat-a")}
          title="Chat chat-a"
          onToggleSidebar={() => {}}
          onNewChat={() => {}}
        />,
      ),
    );

    await waitFor(() => expect(screen.getByText("question")).toBeInTheDocument());
    await act(async () => {
      client._emitChat("chat-a", {
        event: "delta",
        chat_id: "chat-a",
        text: "live half-parsed | markdown",
      });
      client._emitChat("chat-a", {
        event: "turn_end",
        chat_id: "chat-a",
      });
    });

    await waitFor(() => expect(screen.getByText("live half-parsed | markdown")).toBeInTheDocument());
    expect(screen.queryByText("canonical markdown answer")).not.toBeInTheDocument();
    expect(historyCalls).toBe(1);
  });

  it("does not refetch thread history for metadata-only session updates", async () => {
    const client = makeClient();
    let historyCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("websocket%3Achat-a/webui-thread")) {
          historyCalls += 1;
          return httpJson(
            transcriptFromSimpleMessages([
              { role: "user", content: "question" },
              { role: "assistant", content: "answer" },
            ]),
          );
        }
        return {
          ok: false,
          status: 404,
          json: async () => ({}),
        };
      }),
    );

    render(
      wrap(
        client,
        <ThreadShell
          session={session("chat-a")}
          title="Chat chat-a"
          onToggleSidebar={() => {}}
          onNewChat={() => {}}
        />,
      ),
    );

    await waitFor(() => expect(screen.getByText("answer")).toBeInTheDocument());
    expect(historyCalls).toBe(1);

    await act(async () => {
      client._emitSessionUpdate("chat-a", "metadata");
    });

    expect(historyCalls).toBe(1);
  });

  it("scrolls to the bottom after loading a session from the blank new-chat page", async () => {
    const client = makeClient();
    const scrollIntoView = vi.fn();
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("websocket%3Achat-a/webui-thread")) {
          return httpJson(
            transcriptFromSimpleMessages([
              { role: "user", content: "question" },
              { role: "assistant", content: "loaded answer" },
            ]),
          );
        }
        return {
          ok: false,
          status: 404,
          json: async () => ({}),
        };
      }),
    );

    try {
      const { rerender } = render(
        wrap(
          client,
          <ThreadShell
            session={null}
            title="mona"
            onToggleSidebar={() => {}}
            onNewChat={() => {}}
          />,
        ),
      );

      expect(screen.getByText("What can I do for you?")).toBeInTheDocument();
      scrollIntoView.mockClear();

      await act(async () => {
        rerender(
          wrap(
            client,
            <ThreadShell
              session={session("chat-a")}
              title="Chat chat-a"
              onToggleSidebar={() => {}}
              onNewChat={() => {}}
            />,
          ),
        );
      });

      await waitFor(() => expect(screen.getByText("loaded answer")).toBeInTheDocument());
      await waitFor(() =>
        expect(scrollIntoView).toHaveBeenCalledWith({
          block: "end",
          behavior: "auto",
        }),
      );
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    }
  });

  it("opens slash commands on the blank welcome page", async () => {
    const client = makeClient();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/commands")) {
          return httpJson({
            commands: [
              {
                command: "/history",
                title: "Show conversation history",
                description: "Print the last N persisted messages.",
                icon: "history",
                arg_hint: "[n]",
              },
            ],
          });
        }
        return {
          ok: false,
          status: 404,
          json: async () => ({}),
        };
      }),
    );

    render(
      wrap(
        client,
        <ThreadShell
          session={null}
          title="mona"
          onToggleSidebar={() => {}}
          onNewChat={() => {}}
        />,
      ),
    );

    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/commands"),
      expect.objectContaining({
        headers: { Authorization: "Bearer tok" },
      }),
    ));

    fireEvent.change(screen.getByLabelText("Message input"), {
      target: { value: "/" },
    });

    await waitFor(() =>
      expect(screen.getByRole("listbox", { name: "Slash commands" })).toBeInTheDocument(),
    );
    expect(screen.getByRole("option", { name: /\/history/i })).toBeInTheDocument();
  });

  it("surfaces a dismissible banner when the stream reports message_too_big", async () => {
    const client = makeClient();
    const onNewChat = vi.fn().mockResolvedValue("chat-a");

    render(
      wrap(
        client,
        <ThreadShell
          session={session("chat-a")}
          title="Chat chat-a"
          onToggleSidebar={() => {}}
          onGoHome={() => {}}
          onNewChat={onNewChat}
        />,
      ),
    );

    // No banner yet: only appears once the client emits a matching error.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await act(async () => {});
    await act(async () => {
      client._emitError({ kind: "message_too_big" });
    });

    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent("Message too large");

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    await waitFor(() => {
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
  });

  it("clears the stream error banner when the user switches to another chat", async () => {
    const client = makeClient();
    const onNewChat = vi.fn().mockResolvedValue("chat-a");

    const { rerender } = render(
      wrap(
        client,
        <ThreadShell
          session={session("chat-a")}
          title="Chat chat-a"
          onToggleSidebar={() => {}}
          onGoHome={() => {}}
          onNewChat={onNewChat}
        />,
      ),
    );

    await act(async () => {});
    await act(async () => {
      client._emitError({ kind: "message_too_big" });
    });
    expect(await screen.findByRole("alert")).toBeInTheDocument();

    // Switch to a different chat. The banner was about the *previous* send
    // in chat-a; it must not leak into chat-b's view.
    await act(async () => {
      rerender(
        wrap(
          client,
          <ThreadShell
            session={session("chat-b")}
            title="Chat chat-b"
            onToggleSidebar={() => {}}
            onGoHome={() => {}}
            onNewChat={onNewChat}
          />,
        ),
      );
    });

    await waitFor(() => {
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
  });

  it("clears the previous thread immediately while the next session loads", async () => {
    const client = makeClient();
    const onNewChat = vi.fn().mockResolvedValue("chat-b");
    let resolveChatB:
      | ((value: { ok: boolean; status: number; json: () => Promise<unknown> }) => void)
      | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("websocket%3Achat-a/webui-thread")) {
          return Promise.resolve(
            httpJson(
              transcriptFromSimpleMessages([{ role: "assistant", content: "from chat a" }]),
            ),
          );
        }
        if (url.includes("websocket%3Achat-b/webui-thread")) {
          return new Promise((resolve) => {
            resolveChatB = resolve;
          });
        }
        return Promise.resolve({
          ok: false,
          status: 404,
          json: async () => ({}),
        });
      }),
    );

    const { rerender } = render(
      wrap(
        client,
        <ThreadShell
          session={session("chat-a")}
          title="Chat chat-a"
          onToggleSidebar={() => {}}
          onGoHome={() => {}}
          onNewChat={onNewChat}
        />,
      ),
    );

    await waitFor(() => expect(screen.getByText("from chat a")).toBeInTheDocument());

    await act(async () => {
      rerender(
        wrap(
          client,
          <ThreadShell
            session={session("chat-b")}
            title="Chat chat-b"
            onToggleSidebar={() => {}}
            onGoHome={() => {}}
            onNewChat={onNewChat}
          />,
        ),
      );
    });

    expect(screen.queryByText("from chat a")).not.toBeInTheDocument();
    expect(screen.getByText("Loading conversation…")).toBeInTheDocument();

    await act(async () => {
      resolveChatB?.(
        httpJson(transcriptFromSimpleMessages([{ role: "assistant", content: "from chat b" }])),
      );
    });

    await waitFor(() => expect(screen.getByText("from chat b")).toBeInTheDocument());
    expect(screen.queryByText("from chat a")).not.toBeInTheDocument();
  });

  it("reveals the workspace empty state via the collapsed edge button", async () => {
    const client = makeClient();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/artifacts")) {
          return {
            ok: true,
            status: 200,
            headers: { get: () => "application/json" },
            json: async () => ({ files: [], truncated: false }),
          };
        }
        return {
          ok: false,
          status: 404,
          json: async () => ({}),
        };
      }),
    );

    render(
      wrap(
        client,
        <ThreadShell
          session={session("chat-empty-artifacts")}
          title="Chat chat-empty-artifacts"
          onToggleSidebar={() => {}}
          onNewChat={() => {}}
        />,
      ),
    );

    // The workspace panel entry must always be reachable, even with zero
    // artifacts; expanding it shows the empty state instead of dead code.
    const expand = await screen.findByTitle("展开工作区");
    fireEvent.click(expand);

    await waitFor(() =>
      expect(
        screen.getByText("还没有产物。AI 创建的文件会出现在这里。"),
      ).toBeInTheDocument(),
    );
  });

  it("shows this session's delivered files in a dedicated section above the scan tree", async () => {
    const client = makeClient();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/artifacts")) {
          return {
            ok: true,
            status: 200,
            headers: { get: () => "application/json" },
            json: async () => ({
              files: [
                {
                  path: "scan-file.md",
                  absolute_path: "/ws/output/scan-file.md",
                  name: "scan-file.md",
                  size: 5,
                  size_human: "5 B",
                  mime: "text/markdown",
                },
              ],
              truncated: false,
            }),
          };
        }
        if (url.includes("websocket%3Achat-session-files/webui-thread")) {
          return httpJson(
            transcriptFromSimpleMessages([
              { role: "user", content: "make a file" },
              { role: "assistant", content: "done" },
            ]),
          );
        }
        return {
          ok: false,
          status: 404,
          json: async () => ({}),
        };
      }),
    );

    render(
      wrap(
        client,
        <ThreadShell
          session={session("chat-session-files")}
          title="Chat chat-session-files"
          onToggleSidebar={() => {}}
          onNewChat={() => {}}
        />,
      ),
    );

    await waitFor(() =>
      expect(screen.getByText("scan-file.md")).toBeInTheDocument(),
    );
    expect(screen.queryByText("本次会话")).not.toBeInTheDocument();

    await act(async () => {
      client._emitChat("chat-session-files", {
        event: "deliver_files",
        chat_id: "chat-session-files",
        files: [
          {
            path: "/ws/output/live.png",
            absolute_path: "/ws/output/live.png",
            name: "live.png",
            size: 1,
            size_human: "1 B",
            mime: "image/png",
          },
        ],
      });
    });

    const sectionHeader = await screen.findByText("本次会话");
    const sessionRow = within(sectionHeader.parentElement!).getByText("live.png");
    const treeRow = screen.getByText("scan-file.md");
    expect(
      sessionRow.compareDocumentPosition(treeRow) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("flashes the collapsed workspace edge button when the artifact count grows", async () => {
    const client = makeClient();
    const fileA = {
      path: "a.png",
      absolute_path: "/ws/output/a.png",
      name: "a.png",
      size: 1,
      size_human: "1 B",
      mime: "image/png",
    };
    const fileB = { ...fileA, path: "b.png", absolute_path: "/ws/output/b.png", name: "b.png" };
    let artifactFiles: unknown[] = [fileA];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/artifacts")) {
          return {
            ok: true,
            status: 200,
            headers: { get: () => "application/json" },
            json: async () => ({ files: artifactFiles, truncated: false }),
          };
        }
        return {
          ok: false,
          status: 404,
          json: async () => ({}),
        };
      }),
    );

    render(
      wrap(
        client,
        <ThreadShell
          session={session("chat-edge-flash")}
          title="Chat chat-edge-flash"
          onToggleSidebar={() => {}}
          onNewChat={() => {}}
        />,
      ),
    );

    await screen.findByText("a.png");
    fireEvent.click(screen.getByTitle("折叠工作区"));
    const edge = await screen.findByTitle("展开工作区");
    expect(edge.className).not.toContain("text-primary");

    artifactFiles = [fileA, fileB];
    await act(async () => {
      client._emitChat("chat-edge-flash", {
        event: "turn_end",
        chat_id: "chat-edge-flash",
      });
    });

    await waitFor(() =>
      expect(screen.getByTitle("展开工作区").className).toContain("text-primary"),
    );
  });

  it("refetches artifacts when the server pushes artifacts_changed", async () => {
    const client = makeClient();
    const fileA = {
      path: "a.png",
      absolute_path: "/ws/output/a.png",
      name: "a.png",
      size: 1,
      size_human: "1 B",
      mime: "image/png",
    };
    const fileB = { ...fileA, path: "b.png", absolute_path: "/ws/output/b.png", name: "b.png" };
    let artifactFiles: unknown[] = [fileA];
    let artifactFetches = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/artifacts")) {
          artifactFetches += 1;
          return {
            ok: true,
            status: 200,
            headers: { get: () => "application/json" },
            json: async () => ({ files: artifactFiles, truncated: false }),
          };
        }
        return {
          ok: false,
          status: 404,
          json: async () => ({}),
        };
      }),
    );

    render(
      wrap(
        client,
        <ThreadShell
          session={session("chat-watch")}
          title="Chat chat-watch"
          onToggleSidebar={() => {}}
          onNewChat={() => {}}
        />,
      ),
    );

    await screen.findByText("a.png");
    expect(artifactFetches).toBe(1);

    // A background job lands a file on disk without any chat turn: the
    // server-side watch broadcasts the change and the panel must rescan.
    artifactFiles = [fileA, fileB];
    await act(async () => {
      client._emitArtifactsChanged();
    });

    await screen.findByText("b.png");
    expect(artifactFetches).toBe(2);
  });

  it("moves deleted artifacts to the system trash, never a permanent delete", async () => {
    const client = makeClient();
    const fileA = {
      path: "a.png",
      absolute_path: "/ws/output/a.png",
      name: "a.png",
      size: 1,
      size_human: "1 B",
      mime: "image/png",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/artifacts")) {
          return {
            ok: true,
            status: 200,
            headers: { get: () => "application/json" },
            json: async () => ({ files: [fileA], truncated: false }),
          };
        }
        return {
          ok: false,
          status: 404,
          json: async () => ({}),
        };
      }),
    );

    render(
      wrap(
        client,
        <ThreadShell
          session={session("chat-trash")}
          title="Chat chat-trash"
          onToggleSidebar={() => {}}
          onNewChat={() => {}}
        />,
      ),
    );

    await screen.findByText("a.png");
    fireEvent.contextMenu(screen.getByText("a.png"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "删除" }));
    fireEvent.click(await screen.findByRole("button", { name: "移至回收站" }));

    const { moveToTrash } = await import("@/lib/tauri");
    const { remove } = await import("@tauri-apps/plugin-fs");
    await waitFor(() =>
      expect(vi.mocked(moveToTrash)).toHaveBeenCalledWith("/ws/output/a.png"),
    );
    expect(vi.mocked(remove)).not.toHaveBeenCalled();
  });

  it("keeps a trashed artifact hidden after the panel remounts (scan-authoritative tombstone)", async () => {
    const client = makeClient();
    const fileA = {
      path: "a.png",
      absolute_path: "/ws/output/a.png",
      name: "a.png",
      size: 1,
      size_human: "1 B",
      mime: "image/png",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/artifacts")) {
          return {
            ok: true,
            status: 200,
            headers: { get: () => "application/json" },
            json: async () => ({ files: [], truncated: false }),
          };
        }
        if (url.includes("websocket%3Achat-tombstone/webui-thread")) {
          // The file is known only from the immutable transcript history.
          return httpJson({
            schemaVersion: 3,
            messages: [
              {
                id: "m-0",
                role: "assistant",
                content: "done",
                createdAt: 1000,
                deliveredFiles: [fileA],
              },
            ],
          });
        }
        return { ok: false, status: 404, json: async () => ({}) };
      }),
    );

    const first = render(
      wrap(
        client,
        <ThreadShell
          session={session("chat-tombstone")}
          title="Chat chat-tombstone"
          onToggleSidebar={() => {}}
          onNewChat={() => {}}
        />,
      ),
    );

    fireEvent.contextMenu(await screen.findByText("a.png"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "删除" }));
    fireEvent.click(await screen.findByRole("button", { name: "移至回收站" }));

    const { moveToTrash } = await import("@/lib/tauri");
    await waitFor(() =>
      expect(vi.mocked(moveToTrash)).toHaveBeenCalledWith("/ws/output/a.png"),
    );
    await waitFor(() =>
      expect(screen.queryByText("a.png")).not.toBeInTheDocument(),
    );

    // Switching away and back re-parses the immutable transcript; the
    // deletion must survive the remount instead of resurrecting the row.
    first.unmount();
    render(
      wrap(
        client,
        <ThreadShell
          session={session("chat-tombstone")}
          title="Chat chat-tombstone"
          onToggleSidebar={() => {}}
          onNewChat={() => {}}
        />,
      ),
    );
    // Wait for the empty state so "not found" is not just "not loaded yet".
    await screen.findByText(/还没有产物/);
    expect(screen.queryByText("a.png")).not.toBeInTheDocument();
  });

  it("shows a tombstoned file again when a fresh scan contains it (re-created)", async () => {
    const client = makeClient();
    const fileA = {
      path: "a.png",
      absolute_path: "/ws/output/a.png",
      name: "a.png",
      size: 1,
      size_human: "1 B",
      mime: "image/png",
    };
    let artifactFiles: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/artifacts")) {
          return {
            ok: true,
            status: 200,
            headers: { get: () => "application/json" },
            json: async () => ({ files: artifactFiles, truncated: false }),
          };
        }
        if (url.includes("websocket%3Achat-revive/webui-thread")) {
          return httpJson({
            schemaVersion: 3,
            messages: [
              {
                id: "m-0",
                role: "assistant",
                content: "done",
                createdAt: 1000,
                deliveredFiles: [fileA],
              },
            ],
          });
        }
        return { ok: false, status: 404, json: async () => ({}) };
      }),
    );

    render(
      wrap(
        client,
        <ThreadShell
          session={session("chat-revive")}
          title="Chat chat-revive"
          onToggleSidebar={() => {}}
          onNewChat={() => {}}
        />,
      ),
    );

    fireEvent.contextMenu(await screen.findByText("a.png"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "删除" }));
    fireEvent.click(await screen.findByRole("button", { name: "移至回收站" }));
    await waitFor(() =>
      expect(screen.queryByText("a.png")).not.toBeInTheDocument(),
    );

    // The agent re-creates the file on disk: the authoritative scan sees it
    // again and the row comes back (tombstones must not hide live files).
    artifactFiles = [fileA];
    await act(async () => {
      client._emitArtifactsChanged();
    });
    await screen.findByText("a.png");
  });

  it("hides transcript files inside a trashed directory (prefix tombstone)", async () => {
    const client = makeClient();
    const { useWorkspaceStore } = await import("@/lib/workspace-store");
    useWorkspaceStore.setState({ workspacePath: "/ws" });
    const nested = {
      path: "docs/report.md",
      absolute_path: "/ws/output/docs/report.md",
      name: "report.md",
      size: 1,
      size_human: "1 B",
      mime: "text/markdown",
    };
    let artifactFiles: unknown[] = [nested];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/artifacts")) {
          return {
            ok: true,
            status: 200,
            headers: { get: () => "application/json" },
            json: async () => ({ files: artifactFiles, truncated: false }),
          };
        }
        if (url.includes("websocket%3Achat-dirdel/webui-thread")) {
          return httpJson({
            schemaVersion: 3,
            messages: [
              {
                id: "m-0",
                role: "assistant",
                content: "done",
                createdAt: 1000,
                deliveredFiles: [nested],
              },
            ],
          });
        }
        return { ok: false, status: 404, json: async () => ({}) };
      }),
    );

    const first = render(
      wrap(
        client,
        <ThreadShell
          session={session("chat-dirdel")}
          title="Chat chat-dirdel"
          onToggleSidebar={() => {}}
          onNewChat={() => {}}
        />,
      ),
    );

    await screen.findByText("report.md");
    artifactFiles = [];
    fireEvent.contextMenu(screen.getByText("docs"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "删除" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("文件夹");
    fireEvent.click(screen.getByRole("button", { name: "移至回收站" }));

    const { moveToTrash } = await import("@/lib/tauri");
    await waitFor(() =>
      expect(vi.mocked(moveToTrash)).toHaveBeenCalledWith("/ws/output/docs"),
    );
    await waitFor(() =>
      expect(screen.queryByText("report.md")).not.toBeInTheDocument(),
    );

    // The transcript copy of the file stays hidden across a remount too.
    first.unmount();
    render(
      wrap(
        client,
        <ThreadShell
          session={session("chat-dirdel")}
          title="Chat chat-dirdel"
          onToggleSidebar={() => {}}
          onNewChat={() => {}}
        />,
      ),
    );
    await screen.findByText(/还没有产物/);
    expect(screen.queryByText("report.md")).not.toBeInTheDocument();
  });

  it("lists all project directory files for project sessions, never message artifacts", async () => {
    const client = makeClient();
    const appPy = {
      path: "app.py",
      absolute_path: "/proj/app.py",
      name: "app.py",
      size: 3,
      size_human: "3 B",
      mime: "text/x-python",
    };
    const mainPy = {
      path: "src/main.py",
      absolute_path: "/proj/src/main.py",
      name: "main.py",
      size: 3,
      size_human: "3 B",
      mime: "text/x-python",
    };
    let artifactsFetched = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/project-files")) {
          return {
            ok: true,
            status: 200,
            headers: { get: () => "application/json" },
            json: async () => ({ files: [appPy, mainPy], truncated: false }),
          };
        }
        if (url.includes("/api/artifacts")) {
          artifactsFetched += 1;
          return {
            ok: true,
            status: 200,
            headers: { get: () => "application/json" },
            json: async () => ({ files: [], truncated: false }),
          };
        }
        if (url.includes("websocket%3Achat-proj/webui-thread")) {
          // Immutable history claims an artifact; project sessions must not
          // show message artifacts at all — only the project directory scan.
          return httpJson({
            schemaVersion: 3,
            messages: [
              {
                id: "m-0",
                role: "assistant",
                content: "done",
                createdAt: 1000,
                deliveredFiles: [
                  {
                    path: "/proj/old.png",
                    absolute_path: "/proj/old.png",
                    name: "old.png",
                    size: 1,
                    size_human: "1 B",
                    mime: "image/png",
                  },
                ],
              },
            ],
          });
        }
        return { ok: false, status: 404, json: async () => ({}) };
      }),
    );

    render(
      wrap(
        client,
        <ThreadShell
          session={{ ...session("chat-proj"), workspace: "/proj" }}
          title="Chat chat-proj"
          onToggleSidebar={() => {}}
          onNewChat={() => {}}
        />,
      ),
    );

    await screen.findByText("app.py");
    await screen.findByText("main.py");
    expect(screen.getByText("项目文件")).toBeInTheDocument();
    expect(screen.getByText("全部文件")).toBeInTheDocument();
    expect(screen.queryByText("本次会话")).not.toBeInTheDocument();
    expect(screen.queryByText("old.png")).not.toBeInTheDocument();
    expect(screen.queryByText("产物")).not.toBeInTheDocument();
    expect(artifactsFetched).toBe(0);
  });

  it("moves project files to the trash and rescans the project directory", async () => {
    const client = makeClient();
    const appPy = {
      path: "app.py",
      absolute_path: "/proj/app.py",
      name: "app.py",
      size: 3,
      size_human: "3 B",
      mime: "text/x-python",
    };
    let projectFetches = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/project-files")) {
          projectFetches += 1;
          return {
            ok: true,
            status: 200,
            headers: { get: () => "application/json" },
            json: async () => ({ files: [appPy], truncated: false }),
          };
        }
        if (url.includes("websocket%3Achat-projdel/webui-thread")) {
          return httpJson({ schemaVersion: 3, messages: [] });
        }
        return { ok: false, status: 404, json: async () => ({}) };
      }),
    );

    render(
      wrap(
        client,
        <ThreadShell
          session={{ ...session("chat-projdel"), workspace: "/proj" }}
          title="Chat chat-projdel"
          onToggleSidebar={() => {}}
          onNewChat={() => {}}
        />,
      ),
    );

    fireEvent.contextMenu(await screen.findByText("app.py"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "删除" }));
    fireEvent.click(await screen.findByRole("button", { name: "移至回收站" }));

    const { moveToTrash } = await import("@/lib/tauri");
    const { remove } = await import("@tauri-apps/plugin-fs");
    await waitFor(() =>
      expect(vi.mocked(moveToTrash)).toHaveBeenCalledWith("/proj/app.py"),
    );
    expect(vi.mocked(remove)).not.toHaveBeenCalled();
    await waitFor(() => expect(projectFetches).toBeGreaterThanOrEqual(2));
  });
});
