import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useEffect, useState, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ThreadShell } from "@/components/thread/ThreadShell";
import { invalidateAgents } from "@/components/room/useAgents";
import { useFilePreviewStore } from "@/components/deliver/filePreviewStore";
import { ClientProvider } from "@/providers/ClientProvider";
import type { UIMessage } from "@/lib/types";
import { useWorkspaceStore } from "@/lib/workspace-store";
import { fetchFilePreviewBlob } from "@/lib/api";
import type { OfficeSessionState } from "@/components/office/types";
import {
  computeFlowchartSemanticHash,
  createBlankFlowchartDocument,
} from "@/components/notes/flowchart/flowchart-document";

const officePreviewState = vi.hoisted(() => ({
  fetchFilePreviewBlob: vi.fn(),
  importOfficeSession: vi.fn(),
  createOfficeSession: vi.fn(),
  hostMounts: 0,
  hostUnmounts: 0,
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchFilePreviewBlob: officePreviewState.fetchFilePreviewBlob,
  };
});

vi.mock("@/lib/office-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/office-client")>();
  return {
    ...actual,
    importOfficeSession: officePreviewState.importOfficeSession,
    createOfficeSession: officePreviewState.createOfficeSession,
  };
});

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
    saveWorkspaceCanvas: vi.fn(async (_root: string, canvas: unknown) => ({
      canvas,
      path: "D:\\workspace\\canvases\\test.mona-canvas",
    })),
    listWorkspaceCanvases: vi.fn().mockResolvedValue([]),
    migrateLegacyCanvases: vi.fn().mockResolvedValue(0),
    readWorkspaceCanvas: vi.fn(),
  };
});

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => undefined),
}));

vi.mock("@/components/canvas/ConversationCanvasPanel", () => ({
  ConversationCanvasPanel: ({ canvas }: { canvas: { note: { title: string }; generationStatus: string; error?: string } }) => (
    <div data-testid="conversation-canvas-panel">
      {canvas.note.title}:{canvas.generationStatus}:{canvas.error ?? ""}
    </div>
  ),
}));

vi.mock("@/components/deliver/GuitarTabPreview", () => ({
  GuitarTabPreview: ({ source }: { source: string }) => (
    <div data-testid="guitar-tab-preview">{source}</div>
  ),
}));

vi.mock("@/components/office/OfficeEditorHost", () => ({
  OfficeEditorHost: ({ initialSession }: { initialSession: { sessionId: string; displayName: string } }) => {
    const [mountId] = useState(() => {
      officePreviewState.hostMounts += 1;
      return officePreviewState.hostMounts;
    });
    useEffect(() => () => {
      officePreviewState.hostUnmounts += 1;
    }, []);
    return (
      <div data-testid="office-editor-panel" data-mount-id={mountId}>
        {initialSession.sessionId}:{initialSession.displayName}
      </div>
    );
  },
}));

vi.mock("@/components/deliver/SidebarLocalTerminal", () => ({
  SidebarLocalTerminal: ({ sessionId }: { sessionId?: string }) => (
    <div data-testid="sidebar-terminal-panel">本地终端:{sessionId ?? "opening"}</div>
  ),
}));

vi.mock("@/components/terminal/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/terminal/ipc")>();
  return {
    ...actual,
    shellSpawn: vi.fn().mockResolvedValue("sidebar-local-shell"),
    shellKill: vi.fn().mockResolvedValue(undefined),
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
    onDocUploadResult: () => () => {},
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
    sendDocUpload: vi.fn(),
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

function officeSession(sessionId: string, displayName: string, type: OfficeSessionState["type"]): OfficeSessionState {
  return {
    sessionId,
    displayName,
    type,
    version: { editorEpoch: "epoch-1", modelRevision: 0 },
    checkpointVersion: null,
    savedVersion: null,
    dirty: true,
    editorConnected: false,
    saveState: "dirty",
    lastError: null,
  };
}

function WelcomeSessionHost({
  client,
  onCreateChat,
}: {
  client: ReturnType<typeof makeClient>;
  onCreateChat: (workspace?: string | null) => Promise<string | null>;
}) {
  const [activeSession, setActiveSession] = useState<ReturnType<typeof session> | null>(null);

  return (
    <ThreadShell
      session={activeSession}
      title={activeSession ? `Chat ${activeSession.chatId}` : "mona"}
      onToggleSidebar={() => {}}
      onGoHome={() => {}}
      onNewChat={() => {}}
      onCreateChat={async (workspace) => {
        const chatId = await onCreateChat(workspace);
        if (chatId) setActiveSession(session(chatId));
        return chatId;
      }}
    />
  );
}

async function expandWorkspaceSection(): Promise<void> {
  const legacyToggle = screen.queryByRole("button", { name: "工作区文件" });
  if (legacyToggle) {
    if (legacyToggle.getAttribute("aria-expanded") === "false") fireEvent.click(legacyToggle);
    return;
  }
  const existing = screen.queryByRole("tab", { name: "工作区" });
  if (existing) {
    fireEvent.click(existing);
    return;
  }
  await chooseNewSidebarTab("工作区");
  const workspaceTab = await screen.findByRole("tab", { name: "工作区" });
  fireEvent.click(workspaceTab);
}

async function chooseNewSidebarTab(label: string): Promise<void> {
  const createButton = await screen.findByRole("button", { name: "新建标签页" });
  fireEvent.pointerDown(createButton, { button: 0, ctrlKey: false });
  fireEvent.click(createButton);
  fireEvent.click(await screen.findByRole("menuitem", { name: label }));
}

describe("ThreadShell", () => {
  beforeEach(() => {
    localStorage.clear();
    useWorkspaceStore.setState({ workspacePath: "D:\\workspace" });
    officePreviewState.fetchFilePreviewBlob.mockReset();
    officePreviewState.importOfficeSession.mockReset();
    officePreviewState.createOfficeSession.mockReset();
    officePreviewState.hostMounts = 0;
    officePreviewState.hostUnmounts = 0;
    // Module-singleton stores leak across tests (e.g. a test that collapses
    // the workspace panel would hide it for every later test): reset.
    useFilePreviewStore.setState({
      file: null,
      scope: "shared",
      sessionKey: null,
      roomId: null,
      splitRatio: 0.72,
      workspaceCollapsed: false,
      fullscreen: false,
      treeCollapsedByOwner: {},
      treeExpansionInitializedByOwner: {},
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

  it("warns during computer control, stops for takeover, and clears when the run ends", async () => {
    const client = makeClient();
    const chatId = "chat-computer-use";
    render(wrap(
      client,
      <ThreadShell
        session={session(chatId)}
        title="Computer use chat"
        onToggleSidebar={() => {}}
      />,
    ));
    await waitFor(() => expect(screen.getByLabelText("Message input")).toBeInTheDocument());

    act(() => {
      client._emitChat(chatId, {
        event: "artifact_task_started",
        chat_id: chatId,
        task_id: "task-previous",
      });
      client._emitChat(chatId, {
        event: "goal_status",
        chat_id: chatId,
        status: "running",
        started_at: Date.now() / 1000 - 5,
      });
      client._emitChat(chatId, {
        event: "message",
        chat_id: chatId,
        text: "computer_act",
        kind: "tool_hint",
        task_id: "task-previous",
        tool_events: [{ phase: "start", call_id: "previous-act", name: "computer_act" }],
      });
      client._emitChat(chatId, { event: "goal_status", chat_id: chatId, status: "idle" });

      client._emitChat(chatId, {
        event: "artifact_task_started",
        chat_id: chatId,
        task_id: "task-current",
      });
      client._emitChat(chatId, {
        event: "goal_status",
        chat_id: chatId,
        status: "running",
        started_at: Date.now() / 1000,
      });
      client._emitChat(chatId, {
        event: "message",
        chat_id: chatId,
        text: "web_search",
        kind: "tool_hint",
        task_id: "task-current",
        tool_events: [{ phase: "start", call_id: "current-search", name: "web_search" }],
      });
    });

    expect(screen.queryByRole("button", { name: "Stop and take over" })).not.toBeInTheDocument();

    act(() => {
      client._emitChat(chatId, {
        event: "message",
        chat_id: chatId,
        text: "computer_act",
        kind: "tool_hint",
        task_id: "task-current",
        tool_events: [{ phase: "start", call_id: "current-act", name: "computer_act" }],
      });
    });

    expect(screen.getByText(
      "AI is controlling the computer. Please avoid using the mouse and keyboard for now.",
    )).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Stop and take over" }));
    expect(client.sendMessage).toHaveBeenCalledWith(
      chatId,
      "/stop",
      undefined,
      { taskId: "task-current" },
    );
    expect(screen.getByText("Stopping computer control. Please wait before taking over.")).toBeInTheDocument();

    act(() => {
      client._emitChat(chatId, { event: "turn_end", chat_id: chatId, task_id: "task-current" });
    });
    expect(screen.queryByText("AI is controlling the computer. Please avoid using the mouse and keyboard for now.")).not.toBeInTheDocument();
    expect(screen.queryByText("Stopping computer control. Please wait before taking over.")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop and take over" })).not.toBeInTheDocument();
  });

  it("shows a retryable error instead of the welcome page when established history fails", async () => {
    const client = makeClient();
    let historyAttempts = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("websocket%3Abroken-history/webui-thread")) {
        historyAttempts += 1;
        return historyAttempts === 1
          ? { ok: false, status: 500 }
          : httpJson(transcriptFromSimpleMessages([
              { role: "user", content: "Recovered question" },
              { role: "assistant", content: "Recovered answer" },
            ]));
      }
      return { ok: false, status: 404 };
    });
    vi.stubGlobal("fetch", fetchMock);

    render(wrap(
      client,
      <ThreadShell
        session={{
          ...session("broken-history"),
          title: "Existing conversation",
          preview: "Earlier message",
        }}
        title="Existing conversation"
        onToggleSidebar={() => {}}
        onGoHome={() => {}}
        onNewChat={() => {}}
      />,
    ));

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load conversation");
    expect(screen.queryByTestId("mona-welcome-shell")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Message input")).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Reload conversation" }));
    await waitFor(() => expect(screen.getByText("Recovered answer")).toBeInTheDocument());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Message input")).toBeEnabled();
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
        expect.objectContaining({ taskId: expect.stringMatching(/^task_/) }),
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

  it("opens a creating flowchart in the right workspace and keeps the main user message concise", async () => {
    const client = makeClient();
    render(wrap(
      client,
      <ThreadShell
        session={session("chat-canvas")}
        title="Canvas chat"
        onToggleSidebar={() => {}}
        onGoHome={() => {}}
        onNewChat={() => {}}
      />,
    ));

    fireEvent.change(screen.getByLabelText("Message input"), {
      target: { value: "帮我画一个退款审批流程图" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(client.sendMessage).toHaveBeenCalledWith(
      "chat-canvas",
      expect.stringContaining("请按 mona-canvas skill 处理"),
      undefined,
      expect.objectContaining({
        displayContent: "帮我画一个退款审批流程图",
        taskId: expect.stringMatching(/^task_/),
      }),
    ));
    expect(await screen.findByTestId("conversation-canvas-panel"))
      .toHaveTextContent("退款审批流程图:creating");
    expect(screen.getByRole("tab", { name: /退款审批流程图/ })).toBeInTheDocument();
    expect(useFilePreviewStore.getState().splitRatio).toBe(0.5);
  });

  it("opens a live Office session from the structured tool event", async () => {
    const client = makeClient();
    render(wrap(
      client,
      <ThreadShell
        session={session("chat-office")}
        title="Office chat"
        onToggleSidebar={() => {}}
        onGoHome={() => {}}
        onNewChat={() => {}}
      />,
    ));

    await act(async () => {
      client._emitChat("chat-office", {
        event: "message",
        chat_id: "chat-office",
        text: "正在打开销售计划",
        kind: "progress",
        agent_ui: {
          kind: "office_session",
          data: {
            version: 1,
            action: "open",
            session: {
              sessionId: "office_1",
              displayName: "销售计划.xlsx",
              type: "sheets",
              version: { editorEpoch: "epoch_1", modelRevision: 0 },
              checkpointVersion: { editorEpoch: "epoch_1", modelRevision: 0 },
              savedVersion: { editorEpoch: "epoch_1", modelRevision: 0 },
              dirty: false,
              editorConnected: false,
              saveState: "clean",
              lastError: null,
            },
          },
        },
      });
    });

    const editor = await screen.findByTestId("office-editor-panel");
    expect(editor).toHaveTextContent("office_1:销售计划.xlsx");
    expect(editor.parentElement).not.toHaveClass("hidden");
    expect(screen.getByRole("tab", { name: /销售计划.xlsx/ }))
      .toHaveAttribute("aria-selected", "true");
    expect(useFilePreviewStore.getState().splitRatio).toBe(0.5);
  });

  it("restores an open Office editor after the desktop UI reloads", async () => {
    const restored = officeSession("office_restore", "季度计划.xlsx", "sheets");
    localStorage.setItem(
      "mona.office.sessions.v1:websocket:chat-office-restore",
      JSON.stringify([restored]),
    );
    const client = makeClient();

    render(wrap(
      client,
      <ThreadShell
        session={session("chat-office-restore")}
        title="Office restore"
        onToggleSidebar={() => {}}
        onGoHome={() => {}}
        onNewChat={() => {}}
      />,
    ));

    const editor = await screen.findByTestId("office-editor-panel");
    expect(editor).toHaveTextContent("office_restore:季度计划.xlsx");
    expect(editor.parentElement).not.toHaveClass("hidden");
    expect(screen.getByRole("tab", { name: /季度计划.xlsx/ }))
      .toHaveAttribute("aria-selected", "true");
  });

  it("promotes an Office file preview to one persistent Office tab", async () => {
    const client = makeClient();
    const file = {
      path: "reports/销售计划.xlsx",
      absolute_path: "C:/workspace/output/reports/销售计划.xlsx",
      name: "销售计划.xlsx",
      size: 4,
      size_human: "4 B",
      mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/artifacts")) {
          return httpJson({ files: [], truncated: false });
        }
        if (url.includes("websocket%3Achat-office-preview/webui-thread")) {
          return httpJson({
            schemaVersion: 3,
            messages: [{
              id: "office-preview-history",
              role: "assistant",
              content: "已生成销售计划",
              createdAt: 1,
              deliveredFiles: [file],
            }],
          });
        }
        return { ok: false, status: 404, json: async () => ({}) };
      }),
    );
    officePreviewState.fetchFilePreviewBlob.mockResolvedValue({
      blob: new Blob([Uint8Array.from([1, 2, 3, 4])], { type: file.mime }),
      mime: file.mime,
    });
    officePreviewState.importOfficeSession.mockResolvedValue(
      officeSession("office-from-preview", file.name, "sheets"),
    );

    render(
      wrap(
        client,
        <ThreadShell
          session={session("chat-office-preview")}
          title="Chat chat-office-preview"
          onToggleSidebar={() => {}}
          onNewChat={() => {}}
        />,
      ),
    );

    await waitFor(() => expect(screen.getByRole("button", { name: /销售计划\.xlsx/ })).toBeInTheDocument());
    fireEvent.doubleClick(await screen.findByRole("button", { name: /销售计划\.xlsx/ }));

    await waitFor(() => expect(officePreviewState.fetchFilePreviewBlob).toHaveBeenCalledOnce());
    await waitFor(() => expect(officePreviewState.importOfficeSession).toHaveBeenCalledOnce());
    const editor = await screen.findByTestId("office-editor-panel");
    expect(editor).toHaveTextContent("office-from-preview:销售计划.xlsx");
    expect(vi.mocked(fetchFilePreviewBlob)).toHaveBeenCalledWith("tok", {
      scope: "shared",
      path: file.path,
      sessionKey: "websocket:chat-office-preview",
      room: null,
      artifactId: null,
    });
    expect(officePreviewState.importOfficeSession).toHaveBeenCalledWith(
      {
        filename: file.name,
        sourceIdentity: file.absolute_path,
        ownerSessionKey: "websocket:chat-office-preview",
      },
      expect.any(ArrayBuffer),
    );
    expect(screen.getAllByRole("tab", { name: /销售计划\.xlsx/ })).toHaveLength(1);
    expect(officePreviewState.hostMounts).toBe(1);
    const mountId = editor.getAttribute("data-mount-id");

    await act(async () => {
      client._emitChat("chat-office-preview", {
        event: "message",
        chat_id: "chat-office-preview",
        text: "Agent 继续编辑销售计划",
        kind: "progress",
        agent_ui: {
          kind: "office_session",
          data: {
            version: 1,
            action: "open",
            session: officeSession("office-from-preview", file.name, "sheets"),
          },
        },
      });
    });

    expect(screen.getAllByTestId("office-editor-panel")).toHaveLength(1);
    expect(screen.getAllByRole("tab", { name: /销售计划\.xlsx/ })).toHaveLength(1);
    expect(officePreviewState.hostMounts).toBe(1);
    expect(screen.getByTestId("office-editor-panel")).toHaveAttribute("data-mount-id", mountId);

    fireEvent.click(screen.getByTitle("收起侧边栏"));
    await screen.findByTitle("展开工作区");
    expect(screen.getByTestId("office-editor-panel")).toHaveAttribute("data-mount-id", mountId);
    expect(officePreviewState.hostMounts).toBe(1);

    fireEvent.click(screen.getByTitle("展开工作区"));
    await waitFor(() => expect(screen.getByTestId("office-editor-panel")).toHaveAttribute(
      "data-mount-id",
      mountId,
    ));
    expect(officePreviewState.hostMounts).toBe(1);
    expect(officePreviewState.hostUnmounts).toBe(0);
  });

  it("creates a blank flowchart from the right workspace without sending a chat message", async () => {
    const client = makeClient();
    render(wrap(
      client,
      <ThreadShell
        session={session("chat-blank-canvas")}
        title="Blank canvas chat"
        onToggleSidebar={() => {}}
        onGoHome={() => {}}
        onNewChat={() => {}}
      />,
    ));

    fireEvent.click(await screen.findByTitle("展开工作区"));
    await chooseNewSidebarTab("流程图");

    await waitFor(() => expect(screen.getByTestId("conversation-canvas-panel"))
      .toHaveTextContent("未命名流程图:idle"));
    expect(screen.getByRole("tab", { name: "未命名流程图" })).toBeInTheDocument();
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  it("opens a blank PPT Office document from the new-tab menu", async () => {
    const client = makeClient();
    officePreviewState.createOfficeSession
      .mockResolvedValueOnce(officeSession("office-ppt", "新建 PPT", "slides"));
    render(wrap(
      client,
      <ThreadShell
        session={session("chat-blank-ppt")}
        title="Blank PPT chat"
        onToggleSidebar={() => {}}
        onGoHome={() => {}}
        onNewChat={() => {}}
      />,
    ));

    fireEvent.click(await screen.findByTitle("展开工作区"));
    await chooseNewSidebarTab("PPT");

    expect(await screen.findByTestId("office-editor-panel"))
      .toHaveTextContent("office-ppt:新建 PPT");
    expect(screen.getByRole("tab", { name: "新建 PPT" })).toBeInTheDocument();
    expect(officePreviewState.createOfficeSession).toHaveBeenCalledWith({
      ownerSessionKey: "websocket:chat-blank-ppt",
      type: "slides",
      displayName: "新建 PPT",
    });
    expect(client.sendMessage).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Message input"), {
      target: { value: "增加一页产品优势" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(client.sendMessage).toHaveBeenCalledWith(
      "chat-blank-ppt",
      "增加一页产品优势",
      undefined,
      expect.objectContaining({
        officeSessionId: "office-ppt",
        officeDocumentType: "slides",
        officeDisplayName: "新建 PPT",
      }),
    ));
  });

  it.each([
    ["Word", "docs", "新建 Word"],
    ["Excel", "sheets", "新建 Excel"],
  ] as const)("opens a blank %s Office document from the new-tab menu", async (label, type, displayName) => {
    const client = makeClient();
    officePreviewState.createOfficeSession
      .mockResolvedValueOnce(officeSession(`office-${type}`, displayName, type));
    render(wrap(
      client,
      <ThreadShell
        session={session(`chat-blank-${type}`)}
        title={`Blank ${label} chat`}
        onToggleSidebar={() => {}}
        onGoHome={() => {}}
        onNewChat={() => {}}
      />,
    ));

    fireEvent.click(await screen.findByTitle("展开工作区"));
    await chooseNewSidebarTab(label);

    expect(await screen.findByTestId("office-editor-panel"))
      .toHaveTextContent(`office-${type}:${displayName}`);
    expect(officePreviewState.createOfficeSession).toHaveBeenCalledWith({
      ownerSessionKey: `websocket:chat-blank-${type}`,
      type,
      displayName,
    });
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  it("reports workspace maximize and restore state to the app shell", async () => {
    const client = makeClient();
    const onRightWorkspaceMaximizedChange = vi.fn();
    const { unmount } = render(wrap(
      client,
      <ThreadShell
        session={session("chat-maximize-workspace")}
        title="Maximize workspace chat"
        onToggleSidebar={() => {}}
        onGoHome={() => {}}
        onNewChat={() => {}}
        onRightWorkspaceMaximizedChange={onRightWorkspaceMaximizedChange}
      />,
    ));

    fireEvent.click(await screen.findByTitle("展开工作区"));
    fireEvent.click(await screen.findByRole("button", { name: "最大化侧边栏" }));
    await waitFor(() => expect(onRightWorkspaceMaximizedChange).toHaveBeenLastCalledWith(true));

    fireEvent.click(screen.getByRole("button", { name: "还原侧边栏" }));
    await waitFor(() => expect(onRightWorkspaceMaximizedChange).toHaveBeenLastCalledWith(false));

    unmount();
    expect(onRightWorkspaceMaximizedChange).toHaveBeenLastCalledWith(false);
  });

  it("opens browser and terminal tabs from the right workspace new-tab menu", async () => {
    const client = makeClient();
    render(wrap(
      client,
      <ThreadShell
        session={{ ...session("chat-tool-tabs"), workspace: "D:\\workspace\\project" }}
        title="Tool tabs chat"
        onToggleSidebar={() => {}}
        onGoHome={() => {}}
        onNewChat={() => {}}
      />,
    ));

    fireEvent.click(await screen.findByTitle("展开工作区"));
    await chooseNewSidebarTab("浏览器");
    await waitFor(() => expect(screen.getByRole("tab", { name: /浏览器/ })).toBeInTheDocument());
    expect(await screen.findByText("正在打开浏览器…")).toBeInTheDocument();

    await chooseNewSidebarTab("终端");
    await waitFor(() => expect(screen.getByRole("tab", { name: /终端/ })).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId("sidebar-terminal-panel"))
      .toHaveTextContent("本地终端:sidebar-local-shell"));
    const { shellSpawn } = await import("@/components/terminal/ipc");
    expect(shellSpawn).toHaveBeenCalledWith(80, 24, "D:\\workspace\\project");
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  it("applies the main conversation flowchart result and hides its internal patch", async () => {
    const client = makeClient();
    render(wrap(
      client,
      <ThreadShell
        session={session("chat-canvas-result")}
        title="Canvas result chat"
        onToggleSidebar={() => {}}
        onGoHome={() => {}}
        onNewChat={() => {}}
      />,
    ));

    fireEvent.change(screen.getByLabelText("Message input"), {
      target: { value: "帮我画一个退款审批流程图" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(client.sendMessage).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId("conversation-canvas-panel"))
      .toHaveTextContent("退款审批流程图:creating"));
    const wireContent = String(client.sendMessage.mock.calls[0]?.[1] ?? "");
    expect(wireContent).toContain("请按 mona-canvas skill 处理");
    expect(wireContent).not.toContain("baseHash 必须为");
    const baseHash = computeFlowchartSemanticHash(createBlankFlowchartDocument());
    const patch = {
      baseHash,
      ops: [{
        name: "replaceGraph",
        graph: {
          direction: "TB",
          nodes: [
            { id: "start", kind: "start", label: "提交退款申请" },
            { id: "review", kind: "process", label: "财务复核" },
            { id: "end", kind: "end", label: "退款完成" },
          ],
          edges: [
            { id: "e1", source: "start", target: "review" },
            { id: "e2", source: "review", target: "end" },
          ],
        },
      }],
    };
    await act(async () => {
      client._emitChat("chat-canvas-result", {
        event: "message",
        chat_id: "chat-canvas-result",
        text: `已生成退款审批流程。\n\n\`\`\`mona-flowchart-patch\n${JSON.stringify(patch)}\n\`\`\``,
      });
      client._emitChat("chat-canvas-result", {
        event: "turn_end",
        chat_id: "chat-canvas-result",
      });
    });

    await waitFor(() => expect(screen.getByTestId("conversation-canvas-panel"))
      .toHaveTextContent("退款审批流程图:idle"));
    expect(screen.getByText("已生成退款审批流程。")).toBeInTheDocument();
    expect(screen.queryByText(/replaceGraph/)).not.toBeInTheDocument();

    client.sendMessage.mockClear();
    fireEvent.change(screen.getByLabelText("Message input"), {
      target: { value: "增加财务复核节点" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(client.sendMessage).toHaveBeenCalledWith(
      "chat-canvas-result",
      expect.stringContaining("请按 mona-canvas skill 处理"),
      undefined,
      expect.objectContaining({
        displayContent: "增加财务复核节点",
        canvasPath: "D:\\workspace\\canvases\\test.mona-canvas",
      }),
    ));
  });

  it("hydrates a background agent reply when returning from another chat", async () => {
    const client = makeClient();
    let agentACompleted = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("websocket%3Achat-a/webui-thread")) {
          return httpJson(transcriptFromSimpleMessages([
            { role: "user", content: "task for A" },
            ...(agentACompleted
              ? [{ role: "assistant" as const, content: "A finished in background" }]
              : []),
          ]));
        }
        if (url.includes("websocket%3Achat-b/webui-thread")) {
          return httpJson(transcriptFromSimpleMessages([
            { role: "user", content: "chat B" },
          ]));
        }
        return { ok: false, status: 404, json: async () => ({}) };
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
          onNewChat={() => {}}
        />,
      ),
    );

    await screen.findByText("task for A");
    rerender(wrap(
      client,
      <ThreadShell
        session={session("chat-b")}
        title="Chat chat-b"
        onToggleSidebar={() => {}}
        onGoHome={() => {}}
        onNewChat={() => {}}
      />,
    ));
    await screen.findByText("chat B");

    agentACompleted = true;
    act(() => client._emitSessionUpdate("chat-a", "thread"));

    rerender(wrap(
      client,
      <ThreadShell
        session={session("chat-a")}
        title="Chat chat-a"
        onToggleSidebar={() => {}}
        onGoHome={() => {}}
        onNewChat={() => {}}
      />,
    ));

    await screen.findByText("A finished in background");
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
        expect.objectContaining({ taskId: expect.stringMatching(/^task_/) }),
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
      screen.getByPlaceholderText("有什么事情，交给Mona吧"),
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

  it("starts a new branch task from a direct assistant reply", async () => {
    const client = makeClient();
    const onBranchChat = vi.fn().mockResolvedValue("chat-branch");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("websocket%3Achat-a/webui-thread")) {
          return httpJson(transcriptFromSimpleMessages([
            { role: "assistant", content: "branch source answer" },
          ]));
        }
        return { ok: false, status: 404, json: async () => ({}) };
      }),
    );

    function BranchHost() {
      const [activeSession, setActiveSession] = useState(session("chat-a"));
      return (
        <ThreadShell
          session={activeSession}
          title={`Chat ${activeSession.chatId}`}
          onToggleSidebar={() => {}}
          onBranchChat={async (sourceChatId, assistantOrdinal, sourceTaskId) => {
            const chatId = await onBranchChat(sourceChatId, assistantOrdinal, sourceTaskId);
            if (chatId) setActiveSession(session(chatId));
            return chatId;
          }}
        />
      );
    }

    render(wrap(client, <BranchHost />));
    await screen.findByText("branch source answer");
    fireEvent.click(screen.getByRole("button", { name: /branch task|分支任务/i }));
    expect(screen.getByRole("alertdialog")).toHaveTextContent(/independent|独立/i);
    fireEvent.click(screen.getByRole("button", { name: /start new task|开启新任务/i }));

    await waitFor(() => expect(onBranchChat).toHaveBeenCalledWith("chat-a", 1, undefined));
    expect(client.sendMessage).not.toHaveBeenCalled();
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
        expect.objectContaining({ taskId: expect.stringMatching(/^task_/) }),
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
        expect.objectContaining({ taskId: expect.stringMatching(/^task_/) }),
      ),
    );
  });

  it("uses the selected agent welcome instead of Mona's dashboard for a new direct chat", async () => {
    const client = makeClient();
    const onCreateDirectChat = vi.fn().mockResolvedValue("partner-chat");
    invalidateAgents();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes("/api/agents")) {
          return httpJson({ agents: [{ id: "com.mona.xiaohongshu", displayName: "小红书运营", enabled: true }] });
        }
        return { ok: false, status: 404, json: async () => ({}) };
      }),
    );

    render(wrap(
      client,
      <ThreadShell
        session={null}
        title="新建对话"
        onToggleSidebar={() => {}}
        onNewChat={() => {}}
        pendingDirectAgentId="com.mona.xiaohongshu"
        onCreateDirectChat={onCreateDirectChat}
      />,
    ));

    expect(await screen.findByTestId("partner-agent-welcome")).toHaveTextContent("小红书运营");
    expect(screen.queryByTestId("mona-welcome-shell")).not.toBeInTheDocument();
    expect(screen.queryByText("网页生成笔记")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Message input"), { target: { value: "帮我写一篇小红书文案" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(onCreateDirectChat).toHaveBeenCalledWith("com.mona.xiaohongshu", null));
  });

  it("uses the summoned display name while the agent list is refreshing", async () => {
    const client = makeClient();
    invalidateAgents();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes("/api/agents")) {
          return httpJson({ agents: [] });
        }
        return { ok: false, status: 404, json: async () => ({}) };
      }),
    );

    render(wrap(
      client,
      <ThreadShell
        session={null}
        title="新建对话"
        onToggleSidebar={() => {}}
        onNewChat={() => {}}
        pendingDirectAgentId="com.mona.academic-researcher"
        pendingDirectAgentName="学者"
        onCreateDirectChat={vi.fn().mockResolvedValue("academic-chat")}
      />,
    ));

    expect(await screen.findByTestId("partner-agent-welcome")).toHaveTextContent("学者");
    expect(screen.queryByText("com.mona.academic-researcher")).not.toBeInTheDocument();
  });

  it("keeps the empty landing branded with Mona's human form and no workspace ornament", async () => {
    const client = makeClient();

    render(
      wrap(
        client,
        <ThreadShell
          session={session("chat-brand")}
          title="Chat chat-brand"
          onToggleSidebar={() => {}}
          onNewChat={() => {}}
        />,
      ),
    );

    await waitFor(() =>
      expect(screen.getByTestId("mona-welcome-shell")).toBeInTheDocument(),
    );

    const heroComposer = screen.getByTestId("mona-hero-composer");
    expect(within(heroComposer).getByTestId("mona-human-portrait")).toHaveClass("mona-home-avatar");
    expect(within(heroComposer).getByTestId("mona-human-portrait-image")).toHaveClass("mona-home-avatar-image");
    expect(within(heroComposer).getByTestId("mona-human-portrait-image")).toHaveAttribute(
      "src",
      "/brand/mona_human_solid.png",
    );
    expect(screen.getByText("What can I do for you?")).toBeInTheDocument();
    expect(screen.getByText("MONA")).toBeInTheDocument();
    expect(screen.queryByText("WORKSPACE")).not.toBeInTheDocument();
    expect(screen.queryByTestId("mona-brand-marker")).not.toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "Mona AI ready" })).not.toBeInTheDocument();
    expect(screen.getByTestId("mona-welcome-shell")).not.toHaveClass(
      "border",
      "shadow-surface",
      "rounded-xl",
    );
    expect(heroComposer).toHaveClass(
      "[&_button[type=submit]]:bg-action",
      "[&_button[type=submit]]:text-action-foreground",
    );
  });

  it("shows the user's Mona avatar on the empty landing", async () => {
    const client = makeClient();
    const customAvatar = "data:image/png;base64,dXNlci1hdmF0YXI=";
    invalidateAgents();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes("/api/agents")) {
          return httpJson({
            agents: [{ id: "mona", displayName: "Mona", avatarUrl: customAvatar, enabled: true }],
          });
        }
        return { ok: false, status: 404, json: async () => ({}) };
      }),
    );

    render(wrap(
      client,
      <ThreadShell
        session={null}
        title="新建对话"
        onToggleSidebar={() => {}}
        onNewChat={() => {}}
      />,
    ));

    const portrait = await within(screen.getByTestId("mona-hero-composer"))
      .findByTestId("mona-human-portrait-image");
    expect(portrait).toHaveAttribute("src", customAvatar);
    expect(portrait).toHaveClass("object-cover");
    expect(portrait).not.toHaveClass("mona-home-avatar-image");
  });

  it("animates the activity icon without a top working line", async () => {
    const client = makeClient();

    render(
      wrap(
        client,
        <ThreadShell
          session={session("chat-working")}
          title="Chat chat-working"
          onToggleSidebar={() => {}}
          onNewChat={() => {}}
        />,
      ),
    );

    expect(screen.queryByTestId("mona-composer-working-line")).not.toBeInTheDocument();

    await act(async () => {
      client._emitChat("chat-working", {
        event: "delta",
        chat_id: "chat-working",
        text: "正在处理",
      });
    });

    expect(screen.queryByTestId("mona-composer-working-line")).not.toBeInTheDocument();

    await act(async () => {
      client._emitChat("chat-working", {
        event: "turn_end",
        chat_id: "chat-working",
      });
    });

    await waitFor(() =>
      expect(screen.queryByTestId("mona-composer-working-line")).not.toBeInTheDocument(),
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
        screen.getByPlaceholderText("有什么事情，交给Mona吧"),
      ).toBeInTheDocument(),
    );
    const input = screen.getByPlaceholderText("有什么事情，交给Mona吧");
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
        expect.objectContaining({ taskId: expect.stringMatching(/^task_/) }),
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
    await expandWorkspaceSection();

    await waitFor(() => {
      expect(screen.getByText("当前会话还没有明确交付的文件")).toBeInTheDocument();
      expect(screen.getByText("工作区暂无文件。")).toBeInTheDocument();
    });
  });

  it("keeps the overview selected when workspace files arrive", async () => {
    const client = makeClient();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes("/api/artifacts")) {
          return httpJson({
            files: [{
              path: "report.md",
              absolute_path: "/ws/output/report.md",
              name: "report.md",
              size: 1,
              size_human: "1 B",
              mime: "text/markdown",
            }],
            truncated: false,
          });
        }
        return { ok: false, status: 404, json: async () => ({}) };
      }),
    );

    render(wrap(
      client,
      <ThreadShell
        session={session("chat-no-auto-workspace")}
        title="Chat no auto workspace"
        onToggleSidebar={() => {}}
        onNewChat={() => {}}
      />,
    ));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "概览" })).toHaveAttribute("aria-current", "page"),
    );
    expect(screen.queryByRole("tab", { name: "工作区" })).not.toBeInTheDocument();
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
              task_files: [
                {
                  path: "helpers/render.py",
                  absolute_path: "/ws/output/helpers/render.py",
                  name: "render.py",
                  size: 8,
                  size_human: "8 B",
                  mime: "text/x-python",
                },
              ],
              task_id: "task-current",
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

    await expandWorkspaceSection();
    expect(await screen.findByText("render.py")).toBeInTheDocument();
    await screen.findByText("scan-file.md");

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

    expect(await screen.findByText("live.png")).toBeInTheDocument();
  });

  it("keeps workspace files out of process artifacts and moves live deliveries out by file identity", async () => {
    const client = makeClient();
    const draft = {
      path: "images/result.png",
      absolute_path: "D:/workspace/output/images/result.png",
      name: "result.png",
      size: 8,
      size_human: "8 B",
      mime: "image/png",
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/api/artifacts")) {
        return httpJson({
          files: [draft, { ...draft, path: "old.mona-canvas", absolute_path: "D:/workspace/output/old.mona-canvas", name: "old.mona-canvas" }],
          session_files: [],
          task_files: [draft],
          task_id: "task-current",
          truncated: false,
        });
      }
      if (String(input).includes("websocket%3Achat-process-identity/webui-thread")) {
        return httpJson(transcriptFromSimpleMessages([
          { role: "user", content: "Generate an image" },
          { role: "assistant", content: "Image generated" },
        ]));
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }));

    render(wrap(client, <ThreadShell session={session("chat-process-identity")} title="Artifacts" onToggleSidebar={() => {}} onNewChat={() => {}} />));

    const processSection = (await screen.findByRole("button", { name: "当前过程产物" })).closest("section")!;
    const deliverySection = screen.getByRole("button", { name: "交付物" }).closest("section")!;
    expect(await within(processSection).findByText("result.png")).toBeInTheDocument();
    await screen.findByText("Image generated");
    expect(screen.queryByText("old.mona-canvas")).not.toBeInTheDocument();

    await act(async () => {
      client._emitChat("chat-process-identity", {
        event: "deliver_files",
        chat_id: "chat-process-identity",
        files: [{ ...draft, path: "D:\\workspace\\output\\images\\result.png", absolute_path: "D:\\workspace\\output\\images\\result.png" }],
      });
    });

    expect(await within(deliverySection).findByText("result.png")).toBeInTheDocument();
    expect(within(processSection).queryByText("result.png")).not.toBeInTheDocument();
    expect(screen.getAllByText("result.png")).toHaveLength(1);
  });

  it("keeps delivered and process scores visible in the musician workspace", async () => {
    const client = makeClient();
    const root = "D:/workspace/agent-workspaces/com.mona.musician/output";
    const scores = ["autumn_memories.abc", "autumn_memories_v2.abc"].map((name) => ({
      path: name, absolute_path: `${root}/${name}`, name,
      size: 1230, size_human: "1.2 KB", mime: "text/vnd.abc",
    }));
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/api/artifacts")) {
        expect(String(input)).toContain("session_key=websocket%3Achat-musician-inventory");
        return httpJson({
          files: scores, session_files: [scores[0]], task_files: [scores[1]],
          task_id: "task-score", truncated: false,
        });
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }));
    render(wrap(client, <ThreadShell
      session={{ ...session("chat-musician-inventory"), conversation: {
        type: "direct", title: "音乐家", agentIds: ["com.mona.musician"],
        directAgentId: "com.mona.musician",
      } }}
      title="音乐家" onToggleSidebar={() => {}} onNewChat={() => {}}
    />));

    await screen.findByText(scores[0].name);
    await screen.findByText(scores[1].name);
    await expandWorkspaceSection();
    for (const score of scores) {
      const visibleRows = screen.getAllByText(score.name).filter((row) => !row.closest(".hidden"));
      expect(visibleRows).toHaveLength(1);
      expect(visibleRows[0]).toBeVisible();
    }
    expect(screen.queryByText("工作区暂无文件。")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "概览" }));
    const deliveries = screen.getByRole("button", { name: "交付物" }).closest("section")!;
    const process = screen.getByRole("button", { name: "当前过程产物" }).closest("section")!;
    expect(within(deliveries).getByText(scores[0].name)).toBeVisible();
    expect(within(process).getByText(scores[1].name)).toBeVisible();
    expect(within(process).queryByText(scores[0].name)).not.toBeInTheDocument();
  });

  it("automatically opens a newly delivered ABC score in the right preview tab", async () => {
    const client = makeClient();
    const score = {
      path: "scores/autumn-memories.abc",
      absolute_path: "D:/workspace/output/scores/autumn-memories.abc",
      name: "autumn-memories.abc",
      size: 72,
      size_human: "72 B",
      mime: "text/vnd.abc",
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/artifacts")) return httpJson({ files: [], truncated: false });
      if (url.includes("websocket%3Achat-score-preview/webui-thread")) {
        return httpJson(transcriptFromSimpleMessages([
          { role: "user", content: "写一首钢琴小品" },
          { role: "assistant", content: "已完成" },
        ]));
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }));
    officePreviewState.fetchFilePreviewBlob.mockResolvedValue({
      blob: new Blob(["X:1\nT:Autumn\nM:4/4\nL:1/8\nK:C\nCDEF GABc|"], { type: "text/vnd.abc" }),
      mime: "text/vnd.abc",
    });

    render(wrap(client, <ThreadShell session={session("chat-score-preview")} title="Score" onToggleSidebar={() => {}} onNewChat={() => {}} />));
    await screen.findByText("已完成");
    expect(useFilePreviewStore.getState().file).toBeNull();

    await act(async () => {
      client._emitChat("chat-score-preview", {
        event: "deliver_files",
        chat_id: "chat-score-preview",
        files: [score],
      });
    });

    await waitFor(() => expect(useFilePreviewStore.getState().file?.name).toBe(score.name));
    expect(await screen.findByRole("tab", { name: score.name })).toHaveAttribute("aria-selected", "true");
    const scorePreview = await screen.findByTestId("music-score-preview");
    expect(scorePreview.closest("[data-preview-tab-id]")).toHaveClass("h-full", "min-h-0");
    await waitFor(() => expect(scorePreview.querySelector("svg")).toBeInTheDocument());

    act(() => {
      useFilePreviewStore.getState().close();
    });
    await act(async () => {
      client._emitChat("chat-score-preview", {
        event: "deliver_files",
        chat_id: "chat-score-preview",
        files: [score],
      });
    });
    expect(useFilePreviewStore.getState().file).toBeNull();
  });

  it("does not automatically open a score restored from session history", async () => {
    const client = makeClient();
    const score = {
      path: "scores/autumn-memories.abc",
      absolute_path: "D:/workspace/output/scores/autumn-memories.abc",
      name: "autumn-memories.abc",
      size: 72,
      size_human: "72 B",
      mime: "text/vnd.abc",
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/artifacts")) return httpJson({ files: [], truncated: false });
      if (url.includes("websocket%3Achat-history-score/webui-thread")) {
        return httpJson({
          schemaVersion: 3,
          messages: [{
            id: "history-score",
            role: "assistant",
            content: "已完成",
            deliveredFiles: [score],
            createdAt: Date.now(),
          }],
        });
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }));

    render(wrap(client, <ThreadShell session={session("chat-history-score")} title="Score" onToggleSidebar={() => {}} onNewChat={() => {}} />));

    await screen.findByText("已完成");
    await waitFor(() => expect(useFilePreviewStore.getState().file).toBeNull());
    expect(officePreviewState.fetchFilePreviewBlob).not.toHaveBeenCalled();
  });

  it("opens a score after each completed file edit, including the same path again", async () => {
    const client = makeClient();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/artifacts")) return httpJson({ files: [], truncated: false });
      if (url.includes("websocket%3Achat-edited-score/webui-thread")) {
        return httpJson(transcriptFromSimpleMessages([
          { role: "user", content: "修改乐谱" },
          { role: "assistant", content: "处理中" },
        ]));
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }));
    officePreviewState.fetchFilePreviewBlob.mockResolvedValue({
      blob: new Blob(["X:1\nT:Edited\nM:4/4\nL:1/8\nK:C\nCDEF GABc|"], { type: "text/vnd.abc" }),
      mime: "text/vnd.abc",
    });
    const edit = (callId: string, phase: "start" | "end", status: "editing" | "done") => ({
      version: 1,
      call_id: callId,
      tool: "write_file",
      path: "scores/edited.abc",
      absolute_path: "D:/workspace/output/scores/edited.abc",
      phase,
      added: 8,
      deleted: 0,
      status,
    } as const);

    render(wrap(client, <ThreadShell session={session("chat-edited-score")} title="Score" onToggleSidebar={() => {}} onNewChat={() => {}} />));
    await screen.findByText("处理中");

    await act(async () => client._emitChat("chat-edited-score", {
      event: "file_edit",
      chat_id: "chat-edited-score",
      edits: [edit("write-1", "start", "editing")],
    }));
    expect(useFilePreviewStore.getState().file).toBeNull();

    await act(async () => client._emitChat("chat-edited-score", {
      event: "file_edit",
      chat_id: "chat-edited-score",
      edits: [edit("write-1", "end", "done")],
    }));
    await waitFor(() => expect(useFilePreviewStore.getState().file?.name).toBe("edited.abc"));

    act(() => useFilePreviewStore.getState().close());
    await act(async () => client._emitChat("chat-edited-score", {
      event: "file_edit",
      chat_id: "chat-edited-score",
      edits: [edit("write-1", "end", "done")],
    }));
    expect(useFilePreviewStore.getState().file).toBeNull();

    await act(async () => client._emitChat("chat-edited-score", {
      event: "file_edit",
      chat_id: "chat-edited-score",
      edits: [edit("write-2", "end", "done")],
    }));
    await waitFor(() => expect(useFilePreviewStore.getState().file?.name).toBe("edited.abc"));
  });

  it("automatically opens a newly delivered AlphaTex guitar tab", async () => {
    const client = makeClient();
    const tab = {
      path: "scores/canon.atex",
      absolute_path: "D:/workspace/output/scores/canon.atex",
      name: "canon.atex",
      size: 180,
      size_human: "180 B",
      mime: "text/plain",
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/artifacts")) return httpJson({ files: [], truncated: false });
      if (url.includes("websocket%3Achat-tab-preview/webui-thread")) {
        return httpJson(transcriptFromSimpleMessages([
          { role: "user", content: "制作吉他六线谱" },
          { role: "assistant", content: "已完成" },
        ]));
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }));
    officePreviewState.fetchFilePreviewBlob.mockResolvedValue({
      blob: new Blob([String.raw`\title "Canon" \track "Guitar" \staff {tabs}`], { type: "text/plain" }),
      mime: "text/plain",
    });

    render(wrap(client, <ThreadShell session={session("chat-tab-preview")} title="Tab" onToggleSidebar={() => {}} onNewChat={() => {}} />));
    await screen.findByText("已完成");

    await act(async () => {
      client._emitChat("chat-tab-preview", {
        event: "deliver_files",
        chat_id: "chat-tab-preview",
        files: [tab],
      });
    });

    await waitFor(() => expect(useFilePreviewStore.getState().file?.name).toBe(tab.name));
    expect(await screen.findByRole("tab", { name: tab.name })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByTestId("guitar-tab-preview")).toBeInTheDocument();
  });

  it("clears process artifacts when switching conversations that share a transport key", async () => {
    const client = makeClient();
    let artifactRequests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes("/api/artifacts")) {
          artifactRequests += 1;
          return httpJson(artifactRequests === 1 ? {
            files: [],
            task_files: [{
              path: "old-process.py",
              absolute_path: "/ws/output/old-process.py",
              name: "old-process.py",
              size: 1,
              size_human: "1 B",
              mime: "text/x-python",
            }],
            task_id: "task-old",
            truncated: false,
          } : { files: [], task_files: [], truncated: false });
        }
        return { ok: false, status: 404, json: async () => ({}) };
      }),
    );
    const sharedTransportKey = "websocket:reused-transport";
    const { rerender } = render(
      wrap(
        client,
        <ThreadShell
          session={{ ...session("chat-artifact-a"), key: sharedTransportKey }}
          title="Chat artifact a"
          onToggleSidebar={() => {}}
          onNewChat={() => {}}
        />,
      ),
    );

    expect(await screen.findByText("old-process.py")).toBeInTheDocument();

    await act(async () => {
      rerender(
        wrap(
          client,
          <ThreadShell
            session={{ ...session("chat-artifact-b"), key: sharedTransportKey }}
            title="Chat artifact b"
            onToggleSidebar={() => {}}
            onNewChat={() => {}}
          />,
        ),
      );
    });

    await waitFor(() => {
      expect(artifactRequests).toBeGreaterThanOrEqual(2);
      expect(screen.queryByText("old-process.py")).not.toBeInTheDocument();
    });
  });

  it("keeps the collapsed workspace reachable when the artifact count grows", async () => {
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

    await expandWorkspaceSection();
    await screen.findByText("a.png");
    fireEvent.click(screen.getByTitle("收起侧边栏"));
    const edge = await screen.findByTitle("展开工作区");
    expect(edge.className).not.toContain("text-primary");

    artifactFiles = [fileA, fileB];
    await act(async () => {
      client._emitChat("chat-edge-flash", {
        event: "turn_end",
        chat_id: "chat-edge-flash",
      });
    });

    fireEvent.click(await screen.findByTitle("展开工作区"));
    await expandWorkspaceSection();
    expect(await screen.findByText("b.png")).toBeInTheDocument();
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

    await expandWorkspaceSection();
    expect((await screen.findAllByText("a.png")).length).toBeGreaterThan(0);
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

    await expandWorkspaceSection();
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
    await screen.findByText("当前会话还没有明确交付的文件");
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
    expect((await screen.findAllByText("a.png")).length).toBeGreaterThan(0);
  });

  it("hides transcript files inside a trashed directory (prefix tombstone)", async () => {
    const client = makeClient();
    const { useWorkspaceStore } = await import("@/lib/workspace-store");
    useWorkspaceStore.setState({ workspacePath: "/ws" });
    const nested = {
      path: "docs/report.md",
      absolute_path: "/ws/agent-workspaces/mona/output/docs/report.md",
      name: "report.md",
      size: 1,
      size_human: "1 B",
      mime: "text/markdown",
    };
    const workspaceOnly = {
      ...nested,
      path: "docs/workspace-note.md",
      absolute_path: "/ws/agent-workspaces/mona/output/docs/workspace-note.md",
      name: "workspace-note.md",
    };
    let artifactFiles: unknown[] = [nested, workspaceOnly];
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
    await expandWorkspaceSection();
    fireEvent.click(await screen.findByText("docs"));
    await screen.findByText("workspace-note.md");
    artifactFiles = [];
    fireEvent.contextMenu(screen.getByText("docs"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "删除" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("文件夹");
    fireEvent.click(screen.getByRole("button", { name: "移至回收站" }));

    const { moveToTrash } = await import("@/lib/tauri");
    await waitFor(() =>
      expect(vi.mocked(moveToTrash)).toHaveBeenCalledWith(
        "/ws/agent-workspaces/mona/output/docs",
      ),
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
    await screen.findByText("当前会话还没有明确交付的文件");
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

    await expandWorkspaceSection();
    await screen.findByText("app.py");
    fireEvent.click(await screen.findByText("src"));
    await screen.findByText("main.py");
    expect(screen.queryByText("本次会话产物")).not.toBeInTheDocument();
    expect(screen.queryByText("old.png")).not.toBeInTheDocument();
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

    await expandWorkspaceSection();
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
