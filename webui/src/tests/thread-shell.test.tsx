import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useEffect, useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ThreadShell } from "@/components/thread/ThreadShell";
import i18n from "@/i18n";
import { DeliveredFileCard } from "@/components/deliver/DeliveredFileCard";
import { invalidateAgents } from "@/components/room/useAgents";
import { useFilePreviewStore } from "@/components/deliver/filePreviewStore";
import { ClientProvider } from "@/providers/ClientProvider";
import type { SettingsPayload, UIMessage } from "@/lib/types";
import { useWorkspaceStore } from "@/lib/workspace-store";
import { saveWorkspaceCanvas } from "@/lib/tauri";
import * as api from "@/lib/api";
import { fetchFilePreviewBlob } from "@/lib/api";
import { developmentApi, type DevExecutor } from "@/lib/development-api";
import { nativeProvidersChanged, useNativeProviderState } from "@/lib/native-provider-state";
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
  type UploadResultHandler = Parameters<import("@/lib/mona-client").MonaClient["onDocUploadResult"]>[0];
  const uploadHandlers = new Set<UploadResultHandler>();
  const errorHandlers = new Set<(err: { kind: string }) => void>();
  const chatHandlers = new Map<string, Set<(ev: import("@/lib/types").InboundEvent) => void>>();
  const sessionUpdateHandlers = new Set<(chatId: string, scope?: string) => void>();
  const sessionDeletedHandlers = new Set<(chatId: string) => void>();
  const deletedChatIds = new Set<string>();
  const artifactsChangedHandlers = new Set<() => void>();
  const goalStateByChatId = new Map<string, import("@/lib/types").GoalStateWsPayload>();
  const workTurns = new Map<string, { turnId: string }>();
  return {
    status: "open" as const,
    defaultChatId: null as string | null,
    onStatus: () => () => {},
    onRuntimeModelUpdate: () => () => {},
    onWorkflowRunUpdated: () => () => {},
    onWorkflowUpdated: () => () => {},
    onApprovalRequested: () => () => {},
    onRoomUpdated: () => () => {},
    getRunStartedAt: () => null,
    getWorkTurn: (chatId: string) => workTurns.get(chatId),
    stopWorkTurn: vi.fn(() => new Promise<never>(() => {})),
    getRoomState: () => new Promise<never>(() => {}),
    getWorkflow: async () => ({ draft: null, active: null, activeRevision: null }),
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
    onSessionDeleted: (handler: (chatId: string) => void) => {
      sessionDeletedHandlers.add(handler);
      return () => sessionDeletedHandlers.delete(handler);
    },
    isChatDeleted: (chatId: string) => deletedChatIds.has(chatId),
    forgetDeletedChat: (chatId: string) => {
      if (deletedChatIds.has(chatId)) return;
      deletedChatIds.add(chatId);
      chatHandlers.delete(chatId);
      workTurns.delete(chatId);
      goalStateByChatId.delete(chatId);
      for (const handler of sessionDeletedHandlers) handler(chatId);
    },
    onArtifactsChanged: (handler: () => void) => {
      artifactsChangedHandlers.add(handler);
      return () => {
        artifactsChangedHandlers.delete(handler);
      };
    },
    onDocUploadResult(handler: UploadResultHandler) {
      uploadHandlers.add(handler);
      return () => { uploadHandlers.delete(handler); };
    },
    _emitUpload(result: Parameters<UploadResultHandler>[0]) {
      for (const handler of uploadHandlers) handler(result);
    },
    _emitError(err: { kind: string }) {
      for (const h of errorHandlers) h(err);
    },
    _emitChat(chatId: string, ev: import("@/lib/types").InboundEvent) {
      if (ev.event === "goal_status") {
        if (ev.status === "running" && ev.turn_id) workTurns.set(chatId, { turnId: ev.turn_id });
        else if (ev.status !== "running") workTurns.delete(chatId);
      }
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
    getUserQuestions: () => [],
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

async function startDocumentUpload(client: ReturnType<typeof makeClient>, name: string) {
  const input = screen.getByLabelText("Message input").closest("form")!.querySelector('input[type="file"]')!;
  const file = new File(["bytes"], name);
  Object.defineProperty(file, "path", { value: `D:/input/${name}` });
  const callCount = client.sendDocUpload.mock.calls.length;
  fireEvent.change(input, { target: { files: [file] } });
  await waitFor(() => expect(client.sendDocUpload).toHaveBeenCalledTimes(callCount + 1));
  return client.sendDocUpload.mock.calls[callCount][0];
}

function finishDocumentUpload(client: ReturnType<typeof makeClient>, uploadId: string, name: string, path: string) {
  act(() => client._emitUpload({ ok: true, chatId: uploadId, files: [{ name, path }] }));
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

async function openOfficeSession(
  client: ReturnType<typeof makeClient>,
  chatId: string,
  office: OfficeSessionState,
) {
  await act(async () => {
    client._emitChat(chatId, {
      event: "message",
      chat_id: chatId,
      text: "",
      kind: "progress",
      agent_ui: { kind: "office_session", data: { version: 1, action: "open", session: office } },
    });
  });
  await waitFor(() => expect(screen.getByRole("tab", { name: office.displayName }))
    .toHaveAttribute("aria-selected", "true"));
}

function holdCanvasSave() {
  let release: () => void = () => {};
  const pending = new Promise<void>((resolve) => { release = resolve; });
  vi.mocked(saveWorkspaceCanvas).mockClear().mockImplementationOnce(async (_root, canvas) => {
    await pending;
    return { canvas, path: "D:\\workspace\\canvases\\pending.mona-canvas" };
  });
  return release;
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
      onCreateChat={async (workspace, beforeActivate) => {
        const chatId = await onCreateChat(workspace);
        if (chatId && beforeActivate?.(chatId) !== false) setActiveSession(session(chatId));
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

function GuardedCreationHost({ create, direct = false }: {
  create: () => Promise<string | null>;
  direct?: boolean;
}) {
  const [active, setActive] = useState<ReturnType<typeof session> | null>(null);
  const onCreate = async (_workspace?: string | null, beforeActivate?: (id: string) => boolean) => {
    const id = await create();
    if (id && beforeActivate?.(id) !== false) setActive(session(id));
    return id;
  };
  return <>
    <button onClick={() => setActive(session("existing-b"))}>Browse existing B</button>
    <button onClick={() => setActive(null)}>Return home</button>
    <span data-testid="selected-creation-chat">{active?.chatId ?? "home"}</span>
    <ThreadShell session={active} onToggleSidebar={() => {}}
      onSelectSession={(key) => setActive(session(key.replace(/^websocket:/, "")))}
      pendingDirectAgentId={direct ? "com.mona.test" : undefined}
      onCreateChat={onCreate}
      onCreateDirectChat={(_agent, workspace, beforeActivate) => onCreate(workspace, beforeActivate)} />
  </>;
}

async function chooseNewSidebarTab(label: string): Promise<void> {
  const createButton = await screen.findByRole("button", { name: "新建标签页" });
  fireEvent.pointerDown(createButton, { button: 0, ctrlKey: false });
  fireEvent.click(createButton);
  fireEvent.click(await screen.findByRole("menuitem", { name: label }));
}

describe("ThreadShell", () => {
  let restoreModelSourceSpies: Array<() => void> = [];
  let restoreProviderRequest: (() => void) | undefined;

  beforeEach(() => {
    restoreModelSourceSpies = [];
    const providerRequest = vi.spyOn(developmentApi, "providerExecutors").mockResolvedValue({ executors: [] });
    restoreProviderRequest = () => providerRequest.mockRestore();
    localStorage.clear();
    useNativeProviderState.setState({ revision: 0 });
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

  afterEach(() => {
    restoreModelSourceSpies.forEach((restore) => restore());
    restoreProviderRequest?.();
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

  it("loads native catalog options for ordinary chat, refreshes on revision, and saves both source types", async () => {
    useNativeProviderState.setState({ revision: 0 });
    let currentSettings = {
      agent: {
        model: "shared-model", provider: "example", executor: "mona", native_model: null,
        native_reasoning_effort: null, context_window_source: "catalog", context_window_tokens: 64000,
      },
      model_presets: [],
      chat_providers: [{
        name: "example", label: "Example API", configured: true, api_base: "", default_api_base: "",
        api_key_required: false, api_base_editable: false,
        models: [{ id: "shared-model", name: "API Shared", enabled: true, recommended: false }],
      }],
    } as SettingsPayload;
    const codex: DevExecutor = {
      id: "codex", name: "Codex", available: true, reason: "已连接",
      probe: { state: "ready", authentication: "ready", authMode: "chatgpt", reason: "已连接" },
      models: [{
        id: "codex-model", label: "原生 Codex", reasoningEfforts: ["low", "high"], reasoningEffort: "high",
      }],
    };
    const settingsRequest = vi.spyOn(api, "fetchSettings").mockImplementation(async () => currentSettings);
    const slashRequest = vi.spyOn(api, "listSlashCommands").mockResolvedValue([]);
    const providerRequest = vi.mocked(developmentApi.providerExecutors);
    providerRequest.mockResolvedValue({ executors: [codex] });
    const selectionRequest = vi.spyOn(developmentApi, "selectWorkModelSource").mockImplementation(async (body) => {
      currentSettings = {
        ...currentSettings,
        agent: body.executor === "mona"
          ? { ...currentSettings.agent, executor: "mona", provider: body.provider!, model: body.model, reasoning_effort: body.effort ?? null }
          : { ...currentSettings.agent, executor: body.executor, native_model: body.model, native_reasoning_effort: body.effort ?? null },
      };
      return currentSettings;
    });
    restoreModelSourceSpies.push(
      () => settingsRequest.mockRestore(),
      () => slashRequest.mockRestore(),
      () => selectionRequest.mockRestore(),
    );
    const client = makeClient();

    render(wrap(client, <ThreadShell onToggleSidebar={() => {}} onNewChat={() => {}} />));

    const trigger = await screen.findByRole("button", { name: "API Shared" });
    await waitFor(() => expect(providerRequest).toHaveBeenCalledTimes(1));
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    await waitFor(() => expect(
      [...document.querySelectorAll<HTMLElement>("[data-model-choice]")].map((item) => item.getAttribute("aria-label")),
    ).toContain("OpenAI · 原生 Codex"));
    fireEvent.click(screen.getByRole("menuitem", { name: "OpenAI · 原生 Codex" }));
    await waitFor(() => expect(selectionRequest).toHaveBeenCalledWith({
      executor: "codex", model: "codex-model", effort: "high",
    }));
    await screen.findByRole("button", { name: "原生 Codex" });

    providerRequest.mockResolvedValue({ executors: [{
      ...codex,
      models: [...codex.models, { id: "new-model", label: "目录更新模型" }],
    }] });
    act(() => nativeProvidersChanged());
    await waitFor(() => expect(providerRequest).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(settingsRequest).toHaveBeenCalledTimes(2));
    expect(currentSettings.agent.executor).toBe("codex");
    expect(currentSettings.agent.native_model).toBe("codex-model");
    fireEvent.pointerDown(screen.getByRole("button", { name: "原生 Codex" }), { button: 0, ctrlKey: false });
    expect(await screen.findByRole("menuitem", { name: "OpenAI · 目录更新模型" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "Example API · API Shared" }));
    await waitFor(() => expect(selectionRequest).toHaveBeenLastCalledWith({
      executor: "mona", model: "shared-model", provider: "example", effort: null,
    }));

    expect(settingsRequest).toHaveBeenCalled();
    expect(slashRequest).toHaveBeenCalled();
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
        turn_id: "current-turn",
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
    expect(client.stopWorkTurn).toHaveBeenCalledWith(chatId, "current-turn");
    expect(client.sendMessage).not.toHaveBeenCalled();
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
      expect.stringContaining("请读取 mona-canvas skill"),
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

  it("captures the active Office document for a normal send", async () => {
    const client = makeClient();
    render(wrap(client, <ThreadShell
      session={session("office-normal")}
      title="Office"
      onToggleSidebar={() => {}}
      onNewChat={() => {}}
    />));
    await openOfficeSession(client, "office-normal", officeSession("office-a", "Document A", "sheets"));
    fireEvent.change(screen.getByLabelText("Message input"), { target: { value: "整理这份表格" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(client.sendMessage).toHaveBeenCalledWith(
      "office-normal", "整理这份表格", undefined, expect.objectContaining({
        officeSessionId: "office-a", officeDocumentType: "sheets", officeDisplayName: "Document A",
      }),
    ));
  });

  it("preserves Office A when a pending canvas send switches to chat and Office B", async () => {
    const client = makeClient();
    const releaseSave = holdCanvasSave();
    const view = (chatId: string) => wrap(client, <ThreadShell
      session={session(chatId)}
      title={chatId}
      onToggleSidebar={() => {}}
      onNewChat={() => {}}
    />);
    const { rerender } = render(view("office-chat-a"));
    await openOfficeSession(client, "office-chat-a", officeSession("office-a", "Document A", "sheets"));
    fireEvent.change(screen.getByLabelText("Message input"), { target: { value: "帮我画一个退款审批流程图" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(saveWorkspaceCanvas).toHaveBeenCalledOnce());
    expect(client.sendMessage).not.toHaveBeenCalled();

    rerender(view("office-chat-b"));
    await openOfficeSession(client, "office-chat-b", officeSession("office-b", "Document B", "slides"));
    await act(async () => releaseSave());

    await waitFor(() => expect(client.sendMessage).toHaveBeenCalledWith(
      "office-chat-a", expect.stringContaining("退款审批流程图"), undefined, expect.objectContaining({
        officeSessionId: "office-a", officeDocumentType: "sheets", officeDisplayName: "Document A",
        canvasPath: "D:\\workspace\\canvases\\pending.mona-canvas",
      }),
    ));
  });

  it("preserves the queued prompt's Office context while its canvas is saved", async () => {
    const client = makeClient();
    const consumed = vi.fn();
    const releaseSave = holdCanvasSave();
    const view = (queued: boolean) => wrap(client, <ThreadShell
      session={session("office-queued")}
      title="Queued Office"
      onToggleSidebar={() => {}}
      onNewChat={() => {}}
      queuedPrompt={queued ? { id: "office-queued-prompt", content: "帮我画一个退款审批流程图" } : null}
      onQueuedPromptConsumed={consumed}
    />);
    const { rerender } = render(view(false));
    await openOfficeSession(client, "office-queued", officeSession("office-a", "Document A", "sheets"));
    rerender(view(true));
    await waitFor(() => expect(saveWorkspaceCanvas).toHaveBeenCalledOnce());
    expect(client.sendMessage).not.toHaveBeenCalled();
    await openOfficeSession(client, "office-queued", officeSession("office-b", "Document B", "slides"));
    await act(async () => releaseSave());

    await waitFor(() => expect(client.sendMessage).toHaveBeenCalledWith(
      "office-queued", expect.stringContaining("退款审批流程图"), undefined, expect.objectContaining({
        officeSessionId: "office-a", officeDocumentType: "sheets", officeDisplayName: "Document A",
        canvasPath: "D:\\workspace\\canvases\\pending.mona-canvas",
      }),
    ));
    expect(consumed).toHaveBeenCalledWith("office-queued-prompt");
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
    expect(wireContent).toContain("请读取 mona-canvas skill");
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
      expect.stringContaining("请读取 mona-canvas skill"),
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
      screen.getByRole("textbox", { name: i18n.t("thread.composer.inputAria") }),
    ).toBeInTheDocument();
  });

  it.each(["null", "reject"])("retains the first draft and document when creation fails with %s", async (failure) => {
    const client = makeClient();
    const create = failure === "null" ? vi.fn().mockResolvedValue(null) : vi.fn().mockRejectedValue(new Error("synthetic creation error"));
    render(wrap(client, <GuardedCreationHost create={create} />));
    const upload = await startDocumentUpload(client, "first.pdf");
    finishDocumentUpload(client, upload, "first.pdf", `uploads/${upload}/first.pdf`);
    fireEvent.change(screen.getByLabelText("Message input"), { target: { value: "keep the first request" } });
    fireEvent.keyDown(screen.getByLabelText("Message input"), { key: "Enter" });
    await screen.findByRole("alertdialog");
    fireEvent.click(screen.getByRole("button", { name: i18n.t("common.dismiss") }));
    expect(screen.getByLabelText("Message input")).toHaveValue("keep the first request");
    expect(screen.getByText("first.pdf")).toBeInTheDocument();
    expect(screen.queryByText("synthetic creation error")).not.toBeInTheDocument();
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  it("retries a rejected first input in its original created chat and consumes only after acceptance", async () => {
    const client = makeClient();
    const create = vi.fn().mockResolvedValue("created-first");
    render(wrap(client, <GuardedCreationHost create={create} />));
    const upload = await startDocumentUpload(client, "first.pdf");
    const path = `uploads/${upload}/first.pdf`;
    finishDocumentUpload(client, upload, "first.pdf", path);
    fireEvent.change(screen.getByLabelText("Message input"), { target: { value: "retry original input" } });
    fireEvent.keyDown(screen.getByLabelText("Message input"), { key: "Enter" });
    await waitFor(() => expect(client.sendMessage).toHaveBeenCalledTimes(1));
    const first = client.sendMessage.mock.calls[0][3];
    await act(async () => { first.onAdmission("rejected"); });
    fireEvent.click(screen.getByRole("button", { name: i18n.t("common.dismiss") }));
    fireEvent.click(screen.getByRole("button", { name: "Return home" }));
    expect(screen.getByLabelText("Message input")).toHaveValue("retry original input");
    expect(screen.getByText("first.pdf")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByLabelText("Message input"), { key: "Enter" });
    await waitFor(() => expect(client.sendMessage).toHaveBeenCalledTimes(2));
    expect(create).toHaveBeenCalledTimes(1);
    expect(client.sendMessage.mock.calls[1][0]).toBe("created-first");
    expect(client.sendMessage.mock.calls[1][3]).toEqual(expect.objectContaining({ inputId: first.inputId, docPaths: [path] }));
    await act(async () => { client.sendMessage.mock.calls[1][3].onAdmission("accepted"); });
    fireEvent.click(screen.getByRole("button", { name: "Return home" }));
    expect(screen.getByLabelText("Message input")).toHaveValue("");
    expect(screen.queryByText("first.pdf")).not.toBeInTheDocument();
  });

  it.each(["unknown", "cancelled"])("retains an unresolved first input without creating or sending again after %s", async (state) => {
    const client = makeClient();
    const create = vi.fn().mockResolvedValue("created-first");
    render(wrap(client, <GuardedCreationHost create={create} />));
    fireEvent.change(screen.getByLabelText("Message input"), { target: { value: "unresolved first input" } });
    fireEvent.keyDown(screen.getByLabelText("Message input"), { key: "Enter" });
    await waitFor(() => expect(client.sendMessage).toHaveBeenCalledTimes(1));
    await act(async () => { client.sendMessage.mock.calls[0][3].onAdmission(state); });
    const dismiss = screen.queryByRole("button", { name: i18n.t("common.dismiss") });
    if (dismiss) fireEvent.click(dismiss);
    fireEvent.click(screen.getByRole("button", { name: "Return home" }));
    expect(screen.getByLabelText("Message input")).toHaveValue("unresolved first input");
    fireEvent.keyDown(screen.getByLabelText("Message input"), { key: "Enter" });
    await screen.findByRole("alertdialog");
    expect(create).toHaveBeenCalledTimes(1);
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("does not clear another conversation's draft when the first input is accepted after navigation", async () => {
    const client = makeClient();
    const create = vi.fn().mockResolvedValue("created-first");
    render(wrap(client, <GuardedCreationHost create={create} />));
    const upload = await startDocumentUpload(client, "home.pdf");
    finishDocumentUpload(client, upload, "home.pdf", `uploads/${upload}/home.pdf`);
    fireEvent.change(screen.getByLabelText("Message input"), { target: { value: "home first request" } });
    fireEvent.keyDown(screen.getByLabelText("Message input"), { key: "Enter" });
    await waitFor(() => expect(client.sendMessage).toHaveBeenCalledTimes(1));
    const first = client.sendMessage.mock.calls[0][3];
    fireEvent.click(screen.getByRole("button", { name: "Browse existing B" }));
    fireEvent.change(screen.getByLabelText("Message input"), { target: { value: "B private draft" } });
    const added = await startDocumentUpload(client, "b.pdf");
    finishDocumentUpload(client, added, "b.pdf", `uploads/${added}/b.pdf`);
    await act(async () => { first.onAdmission("accepted"); });
    expect(screen.getByLabelText("Message input")).toHaveValue("B private draft");
    expect(screen.getByText("b.pdf")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Return home" }));
    expect(screen.getByLabelText("Message input")).toHaveValue("");
    expect(screen.queryByText("home.pdf")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Browse existing B" }));
    expect(screen.getByLabelText("Message input")).toHaveValue("B private draft");
    expect(screen.getByText("b.pdf")).toBeInTheDocument();
    expect(create).toHaveBeenCalledTimes(1);
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("preserves the home draft when its created chat is deleted before a late admission", async () => {
    const client = makeClient();
    const create = vi.fn().mockResolvedValue("created-first");
    render(wrap(client, <GuardedCreationHost create={create} />));
    const upload = await startDocumentUpload(client, "home-delete.pdf");
    finishDocumentUpload(client, upload, "home-delete.pdf", `uploads/${upload}/home-delete.pdf`);
    fireEvent.change(screen.getByLabelText("Message input"), { target: { value: "preserve this home request" } });
    fireEvent.keyDown(screen.getByLabelText("Message input"), { key: "Enter" });
    await waitFor(() => expect(client.sendMessage).toHaveBeenCalledTimes(1));
    const first = client.sendMessage.mock.calls[0][3];
    fireEvent.click(screen.getByRole("button", { name: "Return home" }));
    act(() => client.forgetDeletedChat("created-first"));
    await act(async () => { first.onAdmission("accepted"); });
    expect(screen.getByLabelText("Message input")).toHaveValue("preserve this home request");
    expect(screen.getByText("home-delete.pdf")).toBeInTheDocument();
    expect(create).toHaveBeenCalledTimes(1);
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
  });

  it.each(["new home draft", "old home request"])("consumes only the original home revision and document when acceptance arrives late: %s", async (nextDraft) => {
    const client = makeClient();
    const create = vi.fn().mockResolvedValue("created-first");
    render(wrap(client, <GuardedCreationHost create={create} />));
    const upload = await startDocumentUpload(client, "old.pdf");
    finishDocumentUpload(client, upload, "old.pdf", `uploads/${upload}/old.pdf`);
    fireEvent.change(screen.getByLabelText("Message input"), { target: { value: "old home request" } });
    fireEvent.keyDown(screen.getByLabelText("Message input"), { key: "Enter" });
    await waitFor(() => expect(client.sendMessage).toHaveBeenCalledTimes(1));
    const first = client.sendMessage.mock.calls[0][3];
    await act(async () => { first.onAdmission("unknown"); });
    fireEvent.click(screen.getByRole("button", { name: i18n.t("common.dismiss") }));
    fireEvent.click(screen.getByRole("button", { name: "Return home" }));
    fireEvent.change(screen.getByLabelText("Message input"), { target: { value: "intermediate edit" } });
    fireEvent.change(screen.getByLabelText("Message input"), { target: { value: nextDraft } });
    const added = await startDocumentUpload(client, "new.pdf");
    finishDocumentUpload(client, added, "new.pdf", `uploads/${added}/new.pdf`);
    await act(async () => { first.onAdmission("accepted"); });
    expect(screen.getByLabelText("Message input")).toHaveValue(nextDraft);
    expect(screen.queryByText("old.pdf")).not.toBeInTheDocument();
    expect(screen.getByText("new.pdf")).toBeInTheDocument();
    expect(create).toHaveBeenCalledTimes(1);
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("does not send or activate a late first creation after browsing another chat (direct=%s)", async (direct) => {
    const client = makeClient();
    let finish!: (id: string) => void;
    const create = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
    render(wrap(client, <GuardedCreationHost create={create} direct={direct} />));
    fireEvent.change(screen.getByLabelText("Message input"), { target: { value: "private first request" } });
    fireEvent.keyDown(screen.getByLabelText("Message input"), { key: "Enter" });
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Browse existing B" }));
    expect(client.sendMessage).not.toHaveBeenCalled();
    await act(async () => { finish("late-created-a"); });
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(screen.getByTestId("selected-creation-chat")).toHaveTextContent("existing-b");
  });

  it("keeps the newer first request when two creations finish out of order", async () => {
    const client = makeClient();
    let first!: (id: string) => void;
    let second!: (id: string) => void;
    const create = vi.fn()
      .mockImplementationOnce(() => new Promise<string>((resolve) => { first = resolve; }))
      .mockImplementationOnce(() => new Promise<string>((resolve) => { second = resolve; }));
    render(wrap(client, <GuardedCreationHost create={create} />));
    fireEvent.change(screen.getByLabelText("Message input"), { target: { value: "old request" } });
    fireEvent.keyDown(screen.getByLabelText("Message input"), { key: "Enter" });
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Browse existing B" }));
    fireEvent.click(screen.getByRole("button", { name: "Return home" }));
    fireEvent.change(screen.getByLabelText("Message input"), { target: { value: "new request" } });
    fireEvent.keyDown(screen.getByLabelText("Message input"), { key: "Enter" });
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    await act(async () => { second("new-created-c"); });
    await waitFor(() => expect(client.sendMessage).toHaveBeenCalledWith(
      "new-created-c", "new request", undefined, expect.anything(),
    ));
    await act(async () => { first("late-created-a"); });
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("selected-creation-chat")).toHaveTextContent("new-created-c");
  });

  it("creates a chat only when the blank landing sends a first message", async () => {
    const client = makeClient();
    const onNewChat = vi.fn();
    const onCreateChat = vi.fn(async (_workspace?: string | null, beforeActivate?: (chatId: string) => boolean) => {
      beforeActivate?.("chat-new");
      return "chat-new";
    });

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

  it("sends arbitrary file references with the first message from the landing", async () => {
    const client = makeClient();
    const onCreateChat = vi.fn().mockResolvedValue("chat-new");
    render(wrap(client, <WelcomeSessionHost client={client} onCreateChat={onCreateChat} />));
    const input = screen.getByLabelText("Message input").closest("form")!.querySelector('input[type="file"]')!;
    const file = new File(["custom bytes"], "asset.custom");
    Object.defineProperty(file, "path", { value: "D:/input/asset.custom" });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(client.sendDocUpload).toHaveBeenCalledTimes(1));
    expect(onCreateChat).not.toHaveBeenCalled();
    const uploadId = client.sendDocUpload.mock.calls[0][0];
    const path = `uploads/${uploadId}/asset.custom`;
    act(() => client._emitUpload({ ok: true, chatId: uploadId, files: [{ name: file.name, path }] }));
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(client.sendMessage).toHaveBeenCalledWith(
      "chat-new", "", undefined,
      expect.objectContaining({ docPaths: [path] }),
    ));
  });

  it("keeps a completed document draft in its original chat and sends only that chat's documents", async () => {
    const client = makeClient();
    const view = (chatId: string) => wrap(client, <ThreadShell session={session(chatId)} title={chatId} onToggleSidebar={() => {}} />);
    const { rerender } = render(view("document-a"));
    const uploadId = await startDocumentUpload(client, "alpha.txt");
    finishDocumentUpload(client, uploadId, "alpha.txt", "uploads/alpha.txt");
    expect(screen.getByText("alpha.txt")).toBeInTheDocument();

    rerender(view("document-b"));
    expect(screen.queryByText("alpha.txt")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Message input"), { target: { value: "B without a document" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(client.sendMessage).toHaveBeenCalledTimes(1));
    expect(client.sendMessage.mock.calls[0][0]).toBe("document-b");
    expect(client.sendMessage.mock.calls[0][3]?.docPaths).toBeUndefined();

    rerender(view("document-a"));
    expect(screen.getByText("alpha.txt")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Message input"), { target: { value: "A with its document" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(client.sendMessage).toHaveBeenCalledWith(
      "document-a", "A with its document", undefined,
      expect.objectContaining({ docPaths: ["uploads/alpha.txt"] }),
    ));
    const form = screen.getByLabelText("Message input").closest("form")!;
    expect(within(form).queryByText("alpha.txt")).not.toBeInTheDocument();
  });

  it("keeps document drafts independent when one chat removes its file", async () => {
    const client = makeClient();
    const view = (chatId: string) => wrap(client, <ThreadShell session={session(chatId)} title={chatId} onToggleSidebar={() => {}} />);
    const { rerender } = render(view("document-a"));
    const a = await startDocumentUpload(client, "alpha.txt");
    finishDocumentUpload(client, a, "alpha.txt", "uploads/alpha.txt");

    rerender(view("document-b"));
    const b = await startDocumentUpload(client, "beta.txt");
    finishDocumentUpload(client, b, "beta.txt", "uploads/beta.txt");
    expect(screen.getByText("beta.txt")).toBeInTheDocument();
    expect(screen.queryByText("alpha.txt")).not.toBeInTheDocument();

    rerender(view("document-a"));
    expect(screen.getByText("alpha.txt")).toBeInTheDocument();
    expect(screen.queryByText("beta.txt")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "移除" }));
    expect(screen.queryByText("alpha.txt")).not.toBeInTheDocument();

    rerender(view("document-b"));
    expect(screen.getByText("beta.txt")).toBeInTheDocument();
    expect(screen.queryByText("alpha.txt")).not.toBeInTheDocument();
  });

  it("ignores an upload result that arrives after switching chats", async () => {
    const client = makeClient();
    const view = (chatId: string) => wrap(client, <ThreadShell session={session(chatId)} title={chatId} onToggleSidebar={() => {}} />);
    const { rerender } = render(view("document-a"));
    const uploadId = await startDocumentUpload(client, "late.txt");

    rerender(view("document-b"));
    const b = await startDocumentUpload(client, "beta.txt");
    finishDocumentUpload(client, uploadId, "late.txt", "uploads/late.txt");
    expect(screen.queryByText("late.txt")).not.toBeInTheDocument();
    finishDocumentUpload(client, b, "beta.txt", "uploads/beta.txt");
    expect(screen.getByText("beta.txt")).toBeInTheDocument();
    rerender(view("document-a"));
    expect(screen.queryByText("late.txt")).not.toBeInTheDocument();
    expect(screen.queryByText("beta.txt")).not.toBeInTheDocument();
    rerender(view("document-b"));
    expect(screen.getByText("beta.txt")).toBeInTheDocument();
    expect(screen.queryByText("late.txt")).not.toBeInTheDocument();
  });

  it("preserves file references when appending a queued message to a running task", async () => {
    const client = makeClient();
    const chatId = "chat-attachments";
    render(wrap(client, <ThreadShell session={session(chatId)} title="Attachments" onToggleSidebar={() => {}} />));
    act(() => client._emitChat(chatId, {
      event: "goal_status", chat_id: chatId, status: "running", started_at: Date.now() / 1000, turn_id: "attachment-turn",
    }));
    const textarea = screen.getByLabelText("Message input");
    const input = textarea.closest("form")!.querySelector('input[type="file"]')!;
    const file = new File(["bytes"], "archive.zip");
    Object.defineProperty(file, "path", { value: "D:/input/archive.zip" });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(client.sendDocUpload).toHaveBeenCalledTimes(1));
    const uploadId = client.sendDocUpload.mock.calls[0][0];
    act(() => client._emitUpload({
      ok: true, chatId: uploadId, files: [{ name: file.name, path: "uploads/archive.zip" }],
    }));
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(screen.getByText("archive.zip")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit message" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Append to current task" }));
    expect(client.sendMessage).toHaveBeenCalledWith(
      chatId, "", undefined, expect.objectContaining({ docPaths: ["uploads/archive.zip"] }),
    );
  });

  it("keeps pending messages in their original chat when switching conversations", async () => {
    const client = makeClient();
    const view = (chatId: string) => wrap(client, <ThreadShell session={session(chatId)} title={chatId} onToggleSidebar={() => {}} />);
    const { rerender } = render(view("queue-a"));
    act(() => client._emitChat("queue-a", { event: "goal_status", chat_id: "queue-a", status: "running", started_at: 100, turn_id: "queue-turn-a" }));
    fireEvent.change(screen.getByLabelText("Message input"), { target: { value: "A private pending input" } });
    fireEvent.keyDown(screen.getByLabelText("Message input"), { key: "Enter" });
    expect(screen.getByText("A private pending input")).toBeInTheDocument();

    rerender(view("queue-b"));
    expect(screen.queryByText("A private pending input")).not.toBeInTheDocument();
    act(() => client._emitChat("queue-b", { event: "goal_status", chat_id: "queue-b", status: "running", started_at: 100 }));
    fireEvent.change(screen.getByLabelText("Message input"), { target: { value: "B private pending input" } });
    fireEvent.keyDown(screen.getByLabelText("Message input"), { key: "Enter" });

    rerender(view("queue-a"));
    expect(screen.queryByText("B private pending input")).not.toBeInTheDocument();
    expect(screen.getByText("A private pending input")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Append to current task" }));
    expect(client.sendMessage).toHaveBeenCalledWith("queue-a", "A private pending input", undefined, expect.anything());
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("retains a rejected append and removes it only after consuming the same input ID", async () => {
    const client = makeClient();
    const chatId = "queue-receipt";
    render(wrap(client, <ThreadShell session={session(chatId)} title="Receipts" onToggleSidebar={() => {}} />));
    act(() => client._emitChat(chatId, { event: "goal_status", chat_id: chatId, status: "running", started_at: 100, turn_id: "queue-turn" }));
    fireEvent.change(screen.getByLabelText("Message input"), { target: { value: "pending supplement" } });
    fireEvent.keyDown(screen.getByLabelText("Message input"), { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Append to current task" }));
    const first = client.sendMessage.mock.calls[0][3];
    expect(first.inputId).toEqual(expect.any(String));
    expect(screen.getByRole("button", { name: "Append to current task" })).toBeDisabled();
    act(() => first.onAdmission("rejected"));
    expect(screen.getByRole("alertdialog")).toHaveTextContent("Message not sent");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.getByRole("button", { name: "Append to current task" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Append to current task" }));
    const retry = client.sendMessage.mock.calls[1][3];
    expect(retry.inputId).toBe(first.inputId);
    act(() => retry.onAdmission("accepted"));
    expect(screen.getByRole("button", { name: "Append to current task" })).toBeDisabled();
    expect(screen.getByText("Received, waiting to be applied")).toBeInTheDocument();
    act(() => retry.onAdmission("paused"));
    expect(screen.getByRole("button", { name: "Append to current task" })).toBeEnabled();
    expect(screen.getByText("Paused")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Append to current task" }));
    const resumed = client.sendMessage.mock.calls[2][3];
    expect(resumed).toMatchObject({ inputId: first.inputId, resumeInput: true, targetTurnId: "queue-turn" });
    act(() => resumed.onAdmission("consumed"));
    expect(screen.queryByRole("button", { name: "Append to current task" })).not.toBeInTheDocument();
    expect(screen.getByText("pending supplement")).toBeInTheDocument();
    expect(client.sendMessage).toHaveBeenCalledTimes(3);
  });

  it("shows a rejected-send dialog once, keeps the user input, and allows another send without stopping", async () => {
    const client = makeClient();
    const chatId = "chat-rejected-send";
    render(wrap(client, <ThreadShell session={session(chatId)} title="Chat" onToggleSidebar={() => {}} />));
    await waitFor(() => expect(screen.getByLabelText("Message input")).toBeEnabled());
    fireEvent.change(screen.getByLabelText("Message input"), { target: { value: "keep this input" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(client.sendMessage).toHaveBeenCalledTimes(1));
    const taskId = client.sendMessage.mock.calls[0][3].taskId;
    act(() => client._emitChat(chatId, {
      event: "error", chat_id: chatId, task_id: taskId, message_rejected: true, detail: "invalid_agent_kind_context",
    }));
    expect(screen.getAllByRole("alertdialog")).toHaveLength(1);
    expect(screen.getByRole("alertdialog")).toHaveTextContent("Message not sent");
    expect(screen.getByRole("alertdialog")).not.toHaveTextContent("invalid_agent_kind_context");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.getByText("keep this input")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop generating" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Message input"), { target: { value: "continue normally" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(client.sendMessage).toHaveBeenCalledTimes(2));
    expect(client.sendMessage.mock.calls.map((call) => call[1])).toEqual(["keep this input", "continue normally"]);
  });

  it("keeps the first landing message when new chat history is still empty", async () => {
    const client = makeClient();
    const onCreateChat = vi.fn(async (_workspace?: string | null, beforeActivate?: (chatId: string) => boolean) => {
      beforeActivate?.("chat-new");
      return "chat-new";
    });
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

  it("shows assigned quarrel roles in the launch summary and reconciles a full replay", async () => {
    const client = makeClient();
    const chatId = "room-full-discussion-history";
    const topic = "Zhang San thinks Li Si took credit for his work.";
    let historyCalls = 0;
    let displayContent = "";
    let taskId = "";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes(`/api/sessions/websocket%3A${chatId}/webui-thread`)) {
        historyCalls += 1;
        if (url.includes("limit=160")) {
          return httpJson({
            schemaVersion: 3,
            messages: [
              {
                id: "history-answer",
                role: "assistant",
                content: "Previous answer",
                createdAt: 2,
                historyPosition: 1,
              },
            ],
            pagination: { hasMore: true, before: 1, revision: "rev-1", total: 2 },
          });
        }
        return httpJson({
          schemaVersion: 3,
          messages: [
            {
              id: "history-question",
              role: "user",
              content: "Previous question",
              createdAt: 1,
              historyPosition: 0,
            },
            {
              id: "history-answer",
              role: "assistant",
              content: "Previous answer",
              createdAt: 2,
              historyPosition: 1,
            },
            {
              id: "canonical-topic",
              role: "user",
              content: topic,
              ...(displayContent ? { displayContent } : {}),
              ...(taskId ? { taskId } : {}),
              createdAt: 3,
              historyPosition: 2,
            },
          ],
          pagination: { hasMore: false, before: null, revision: "rev-1", total: 3 },
        });
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }));

    render(wrap(
      client,
      <ThreadShell
        session={{
          ...session(chatId),
          conversation: { type: "room", title: "Quarrel room", agentIds: ["agent-a", "agent-b"] },
        }}
        title="Quarrel room"
        onToggleSidebar={() => {}}
        onNewChat={() => {}}
      />,
    ));

    await screen.findByText("Previous answer");
    fireEvent.click(screen.getByRole("button", { name: "Start topic" }));
    fireEvent.click(screen.getByRole("button", { name: /Quarrel/ }));
    expect(screen.getByText("Background")).toBeInTheDocument();
    fireEvent.change(
      screen.getByPlaceholderText("For example: Zhang San thinks Li Si took credit for his work, and they start arguing."),
      { target: { value: topic } },
    );
    fireEvent.change(screen.getByPlaceholderText("Assign a role to agent-a, for example: Zhang San"), {
      target: { value: "Zhang San" },
    });
    fireEvent.change(screen.getByPlaceholderText("Assign a role to agent-b, for example: Zhang San"), {
      target: { value: "Li Si" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start discussion" }));

    await waitFor(() => expect(client.sendMessage).toHaveBeenCalledTimes(1));
    const sendCall = client.sendMessage.mock.calls.at(-1) as unknown as [
      string,
      string,
      unknown,
      {
        displayContent?: string;
        taskId?: string;
        discussion?: {
          mode: string;
          positions: Record<string, string>;
          roles?: Record<string, string>;
        };
      },
    ] | undefined;
    const options = sendCall?.[3];
    expect(options?.displayContent).toContain("Quarrel background:");
    expect(options?.displayContent).toContain("agent-a → Zhang San");
    expect(options?.displayContent).toContain("agent-b → Li Si");
    expect(options?.taskId).toMatch(/^task_/);
    expect(options?.discussion).toMatchObject({
      mode: "quarrel",
      positions: {},
      roles: { "agent-a": "Zhang San", "agent-b": "Li Si" },
    });
    displayContent = options?.displayContent ?? "";
    taskId = options?.taskId ?? "";
    await screen.findByText(/Quarrel background:/);
    expect(historyCalls).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "用户输入历史" }));
    const historyDialog = await screen.findByRole("dialog", { name: "用户输入历史" });
    await waitFor(() => expect(historyCalls).toBe(2));
    fireEvent.click(within(historyDialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(historyDialog).not.toBeInTheDocument());

    expect(screen.getAllByText(/Quarrel background:/)).toHaveLength(1);
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
      expect(screen.getByRole("button", { name: "Mona 快捷提示词" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Mona 快捷提示词" }));
    const suggestions = await screen.findByRole("dialog", { name: "Mona 快捷提示词" });
    fireEvent.click(within(suggestions).getByRole("button", { name: "网页生成笔记" }));

    // Hero chips fill the composer (cursor marker stripped); the user then sends.
    await waitFor(() =>
      expect(screen.getByLabelText("Message input")).toHaveValue("把这个网页转成笔记："),
    );
    expect(client.sendMessage).not.toHaveBeenCalled();
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

  it.each(["local.custom.deleted", "com.example.deleted"])("keeps deleted agent %s history read-only", async (agentId) => {
    const client = makeClient();
    invalidateAgents();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/agents")) return httpJson({ agents: [] });
      if (url.includes("/webui-thread")) return httpJson(transcriptFromSimpleMessages([
        { role: "user", content: "Original request" },
        { role: "assistant", content: "Original answer" },
      ]));
      return { ok: false, status: 404, json: async () => ({}) };
    }));
    render(wrap(client, <ThreadShell
      session={{ ...session("deleted-agent-history"), conversation: { type: "direct", title: "Old chat", agentIds: [agentId], directAgentId: agentId } }}
      title="Old chat"
      onToggleSidebar={() => {}}
      onNewChat={() => {}}
      queuedPrompt={{ id: "queued-after-delete", content: "New request" }}
    />));

    expect(await screen.findByText("Original answer")).toBeInTheDocument();
    expect(screen.getByLabelText("Message input")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    if (agentId.startsWith("local.custom.")) {
      expect(screen.getByText(i18n.t("experts.historyCustomDeleted"))).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: i18n.t("experts.reinstall") })).not.toBeInTheDocument();
    } else {
      expect(screen.getByRole("button", { name: i18n.t("experts.reinstall") })).toBeInTheDocument();
    }
    expect(client.sendMessage).not.toHaveBeenCalled();
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
    await waitFor(() => expect(onCreateDirectChat).toHaveBeenCalledWith("com.mona.xiaohongshu", null, expect.any(Function)));
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

  it("keeps only Mona's interactive companion above the empty landing composer", async () => {
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
    const companion = within(heroComposer).getByRole("button", { name: "Mona 快捷提示词" });
    expect(companion.querySelector("svg.mona-composer-peek")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("What can I do for you?")).toBeInTheDocument();
    expect(within(heroComposer).queryByText("MONA")).not.toBeInTheDocument();
    expect(within(heroComposer).queryByText("网页生成笔记")).not.toBeInTheDocument();
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

  it("keeps the interactive companion distinct from a custom Mona avatar", async () => {
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

    const companion = await within(screen.getByTestId("mona-hero-composer"))
      .findByRole("button", { name: "Mona 快捷提示词" });
    expect(companion.querySelector("svg.mona-composer-peek")).toBeInTheDocument();
    expect(document.querySelector(`img[src="${customAvatar}"]`)).not.toBeInTheDocument();
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
        screen.getByRole("textbox", { name: i18n.t("thread.composer.inputAria") }),
      ).toBeInTheDocument(),
    );
    const input = screen.getByRole("textbox", { name: i18n.t("thread.composer.inputAria") });
    expect(input.className).toContain("min-h-[78px]");
    expect(screen.queryByText("old answer")).not.toBeInTheDocument();
  });

  it("keeps independent unsent text drafts while switching conversations and home", async () => {
    const client = makeClient();
    const view = (chatId?: string) => wrap(client, <ThreadShell
      session={chatId ? session(chatId) : undefined} onToggleSidebar={() => {}}
    />);
    const ui = render(view("draft-a"));
    await waitFor(() => expect(screen.getByLabelText("Message input")).not.toBeDisabled());
    fireEvent.change(screen.getByLabelText("Message input"), { target: { value: "draft owned by A" } });
    ui.rerender(view("draft-b"));
    expect(screen.getByLabelText("Message input")).toHaveValue("");
    fireEvent.change(screen.getByLabelText("Message input"), { target: { value: "draft owned by B" } });
    ui.rerender(view());
    expect(screen.getByLabelText("Message input")).toHaveValue("");
    fireEvent.change(screen.getByLabelText("Message input"), { target: { value: "new chat draft" } });
    ui.rerender(view("draft-a"));
    expect(screen.getByLabelText("Message input")).toHaveValue("draft owned by A");
    ui.rerender(view("draft-b"));
    expect(screen.getByLabelText("Message input")).toHaveValue("draft owned by B");
    fireEvent.keyDown(screen.getByLabelText("Message input"), { key: "Enter" });
    await waitFor(() => expect(client.sendMessage).toHaveBeenCalledWith(
      "draft-b", "draft owned by B", undefined, expect.anything(),
    ));
    ui.rerender(view("draft-a"));
    expect(screen.getByLabelText("Message input")).toHaveValue("draft owned by A");
    ui.rerender(view());
    expect(screen.getByLabelText("Message input")).toHaveValue("new chat draft");
  });

  it("clears only the deleted chat's draft, cached history and append queue", async () => {
    const client = makeClient();
    const view = (id: string) => wrap(client, <ThreadShell session={session(id)} title={id} onToggleSidebar={() => {}} />);
    const ui = render(view("delete-a"));
    await waitFor(() => expect(screen.getByLabelText("Message input")).not.toBeDisabled());
    act(() => {
      client._emitChat("delete-a", { event: "goal_status", chat_id: "delete-a", status: "running", turn_id: "delete-turn", started_at: 10 });
      client._emitChat("delete-a", { event: "message", chat_id: "delete-a", text: "cached A result" });
    });
    fireEvent.change(screen.getByLabelText("Message input"), { target: { value: "queued A request" } });
    fireEvent.keyDown(screen.getByLabelText("Message input"), { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Append to current task" }));
    await waitFor(() => expect(client.sendMessage).toHaveBeenCalledTimes(1));
    const append = client.sendMessage.mock.calls[0][3];
    const a = await startDocumentUpload(client, "delete-a.pdf");
    finishDocumentUpload(client, a, "delete-a.pdf", "uploads/delete-a.pdf");
    fireEvent.change(screen.getByLabelText("Message input"), { target: { value: "remaining A draft" } });
    ui.rerender(view("keep-b"));
    fireEvent.change(screen.getByLabelText("Message input"), { target: { value: "keep B draft" } });
    const b = await startDocumentUpload(client, "keep-b.pdf");
    finishDocumentUpload(client, b, "keep-b.pdf", "uploads/keep-b.pdf");
    act(() => client.forgetDeletedChat("delete-a"));
    await act(async () => { append.onAdmission("paused"); });
    expect(screen.getByLabelText("Message input")).toHaveValue("keep B draft");
    expect(screen.getByText("keep-b.pdf")).toBeInTheDocument();
    ui.rerender(view("delete-a"));
    expect(screen.getByLabelText("Message input")).toHaveValue("");
    expect(screen.getByLabelText("Message input")).toBeDisabled();
    expect(screen.queryByText("cached A result")).not.toBeInTheDocument();
    expect(screen.queryByText("queued A request")).not.toBeInTheDocument();
    expect(screen.queryByText("delete-a.pdf")).not.toBeInTheDocument();
    ui.rerender(view("keep-b"));
    expect(screen.getByLabelText("Message input")).toHaveValue("keep B draft");
    expect(screen.getByText("keep-b.pdf")).toBeInTheDocument();
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
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

  it("keeps a live answer and an independent background result through history refresh", async () => {
    const client = makeClient();
    const chatId = "chat-development-result";
    let withBackground = false;
    const historical = [
      { id: "u-1", role: "user", content: "检查项目", createdAt: 1, historyPosition: 0 },
      { id: "buf-old", role: "assistant", content: "处理中", createdAt: 2, historyPosition: 1,
        taskId: "work-task", streamId: "old-stream" },
    ];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (!String(input).includes("webui-thread")) return { ok: false, status: 404, json: async () => ({}) };
      return httpJson({
        schemaVersion: 3,
        messages: withBackground ? [
          ...historical,
          { id: "buf-current", role: "assistant", content: "处理中", createdAt: 3, historyPosition: 2,
            taskId: "work-task", streamId: "current-stream" },
          { id: "notice-1", role: "assistant", content: "开发任务已完成", createdAt: 4, historyPosition: 3 },
        ] : historical,
        pagination: { hasMore: false, before: null, revision: withBackground ? "revision-2" : "revision-1", total: withBackground ? 4 : 2 },
      });
    }));

    render(wrap(client, <ThreadShell session={session(chatId)} title="开发任务" onToggleSidebar={() => {}} />));
    await screen.findByText("检查项目");
    act(() => {
      client._emitChat(chatId, { event: "artifact_task_started", chat_id: chatId, task_id: "work-task" });
      client._emitChat(chatId, { event: "goal_status", chat_id: chatId, status: "running", turn_id: "work-turn" });
      client._emitChat(chatId, { event: "delta", chat_id: chatId, text: "处理中", task_id: "work-task", stream_id: "current-stream" });
    });
    await waitFor(() => expect(screen.getAllByText("处理中")).toHaveLength(2));
    expect(screen.getByRole("button", { name: i18n.t("thread.composer.stop") })).toBeInTheDocument();

    withBackground = true;
    act(() => client._emitSessionUpdate(chatId, "thread"));
    await screen.findByText("开发任务已完成");
    expect(screen.getAllByText("处理中")).toHaveLength(2);
    expect(screen.getByRole("button", { name: i18n.t("thread.composer.stop") })).toBeInTheDocument();

    act(() => client._emitChat(chatId, {
      event: "delta", chat_id: chatId, text: "完成", task_id: "work-task", stream_id: "current-stream",
    }));
    await screen.findByText("处理中完成");
    expect(screen.getAllByText("处理中")).toHaveLength(1);
    expect(screen.getAllByText("开发任务已完成")).toHaveLength(1);
    expect(screen.getByRole("button", { name: i18n.t("thread.composer.stop") })).toBeInTheDocument();
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

  it("keeps the workspace closed by default when files arrive and allows manual expansion", async () => {
    const client = makeClient();
    useFilePreviewStore.setState(useFilePreviewStore.getInitialState());
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

    await waitFor(() => {
      expect(screen.getByTitle("展开工作区")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "概览" })).not.toBeInTheDocument();
    });
    expect(useFilePreviewStore.getState().workspaceCollapsed).toBe(true);

    fireEvent.click(screen.getByTitle("展开工作区"));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "概览" })).toHaveAttribute("aria-current", "page"),
    );
    expect(screen.queryByRole("tab", { name: "工作区" })).not.toBeInTheDocument();
  });

  it("expands the collapsed workspace when a delivered file is clicked", () => {
    useFilePreviewStore.setState(useFilePreviewStore.getInitialState());
    const file = {
      path: "report.md",
      absolute_path: "/ws/output/report.md",
      name: "report.md",
      size: 1,
      size_human: "1 B",
      mime: "text/markdown",
    };
    render(<DeliveredFileCard file={file} />);

    fireEvent.click(screen.getByRole("button", { name: /report\.md/ }));

    expect(useFilePreviewStore.getState().workspaceCollapsed).toBe(false);
    expect(useFilePreviewStore.getState().file).toEqual(file);
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
