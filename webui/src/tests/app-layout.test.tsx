import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatSummary } from "@/lib/types";

const connectSpy = vi.fn();
const refreshSpy = vi.fn();
const createChatSpy = vi.fn().mockResolvedValue("chat-1");
const openPartnerChatSpy = vi.fn();
const deleteChatSpy = vi.fn();
const deleteAgentSpy = vi.fn();
const toggleThemeSpy = vi.fn();
const updateUrlSpy = vi.fn();
const attachSpy = vi.fn();
const warmNativeProviderConnectionsSpy = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const runStatusHandlers = new Set<(chatId: string, startedAt: number | null) => void>();
const sessionDeletedHandlers = new Set<(chatId: string) => void>();
const deletedChatIds = new Set<string>();
function confirmSessionDeleted(chatId: string) {
  if (deletedChatIds.has(chatId)) return;
  deletedChatIds.add(chatId);
  for (const handler of sessionDeletedHandlers) handler(chatId);
}
let observedSessionTokens: string[] = [];
let reauthHandler: (() => Promise<string | null>) | null = null;
let mockSessions: ChatSummary[] = [];

vi.mock("@/hooks/useSessions", async (importOriginal) => {
  const React = await import("react");
  const actual = await importOriginal<typeof import("@/hooks/useSessions")>();
  const provider = await import("@/providers/ClientProvider");
  return {
    ...actual,
    useSessions: () => {
      const { client, token } = provider.useClientOptional();
      observedSessionTokens.push(token);
      const [sessions, setSessions] = React.useState(mockSessions);
      return {
        sessions,
        loading: false,
        loaded: true,
        error: null,
        refresh: refreshSpy,
        createChat: createChatSpy,
        openPartnerChat: openPartnerChatSpy,
        deleteChat: async (key: string) => {
          await deleteChatSpy(key);
          client?.forgetDeletedChat(key.slice("websocket:".length));
          setSessions((prev: ChatSummary[]) => prev.filter((s) => s.key !== key));
        },
      };
    },
  };
});

vi.mock("@/hooks/useTheme", async () => {
  const React = await import("react");
  return {
    ThemeProvider: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    useTheme: () => ({
      theme: "light" as const,
      toggle: toggleThemeSpy,
    }),
    useThemeValue: () => "light" as const,
  };
});

vi.mock("@/hooks/useLicense", async () => {
  const React = await import("react");
  return {
    LicenseProvider: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    useLicense: () => ({
      licenseActive: true,
      loggedIn: true,
      pricingConfig: null,
      licenseInfo: { account: "Settings" },
      refreshLicense: vi.fn(),
    }),
  };
});

vi.mock("@/lib/bootstrap", () => ({
  fetchBootstrap: vi.fn().mockResolvedValue({
    token: "tok",
    ws_path: "/",
  }),
  deriveWsUrl: vi.fn(() => "ws://test"),
  loadSavedSecret: vi.fn(() => ""),
  saveSecret: vi.fn(),
  clearSavedSecret: vi.fn(),
  resetGatewayBaseUrl: vi.fn(),
}));

vi.mock("@/lib/mona-client", async (importOriginal) => {
  const { RoomCommandError } = await importOriginal<typeof import("@/lib/mona-client")>();
  class MockClient {
    constructor(options?: { onReauth?: () => Promise<string | null> }) {
      reauthHandler = options?.onReauth ?? null;
    }
    status = "idle" as const;
    defaultChatId: string | null = null;
    connect = connectSpy;
    onStatus = () => () => {};
    onRuntimeModelUpdate = () => () => {};
    onError = () => () => {};
    onChat = () => () => {};
    onSessionUpdate = () => () => {};
    onSessionDeleted = (handler: (chatId: string) => void) => {
      sessionDeletedHandlers.add(handler);
      return () => sessionDeletedHandlers.delete(handler);
    };
    isChatDeleted = (chatId: string) => deletedChatIds.has(chatId);
    forgetDeletedChat = confirmSessionDeleted;
    deleteAgent = deleteAgentSpy;
    onArtifactsChanged = () => () => {};
    onDocUploadResult = () => () => {};
    onAgentsUpdated = () => () => {};
    onRunStatus = (handler: (chatId: string, startedAt: number | null) => void) => {
      runStatusHandlers.add(handler);
      return () => runStatusHandlers.delete(handler);
    };
    getRunStartedAt = () => null;
    getGoalState = () => undefined;
    getTaskPlan = () => undefined;
    getUserQuestions = () => [];
    sendMessage = vi.fn();
    newChat = vi.fn();
    attach = attachSpy;
    close = vi.fn();
    updateUrl = updateUrlSpy;
  }

  return { MonaClient: MockClient, RoomCommandError };
});

vi.mock("@/lib/native-provider-bootstrap", () => ({
  warmNativeProviderConnections: warmNativeProviderConnectionsSpy,
}));

vi.mock("@/components/terminal/VncViewer", () => ({
  VncViewer: () => null,
}));

vi.mock("@/components/agents/AgentManagementView", async () => {
  const React = await import("react");
  return {
    AgentManagementView: ({ agentId, onBack }: { agentId: string; onBack: () => void }) => React.createElement(
      "section", { "data-testid": "partner-settings" },
      React.createElement("span", null, agentId),
      React.createElement("button", { type: "button", onClick: onBack }, "Back to chat"),
    ),
  };
});

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...actual,
    isTauri: () => false,
    getServicesStatus: async () => ({ running: false, port: null }),
    startServices: async () => 0,
  };
});

import { deriveWsUrl, fetchBootstrap, resetGatewayBaseUrl } from "@/lib/bootstrap";
import * as api from "@/lib/api";
import { DEFAULT_SIDEBAR_STATE } from "@/hooks/useSidebarState";
import { invalidateAgents } from "@/components/room/useAgents";
import App from "@/App";

function getSessionPanel() {
  return screen.getByRole("region", { name: "Sessions" });
}

describe("App layout", () => {
  it.each(["session", "browser"])("does not activate a late Work creation after navigating to %s", async (target) => {
    mockSessions = [{
      key: "websocket:existing-b", channel: "websocket", chatId: "existing-b",
      title: "Existing B", preview: "", createdAt: null, updatedAt: null,
    }];
    vi.spyOn(api, "fetchSidebarState").mockResolvedValue((await import("@/hooks/useSidebarState")).DEFAULT_SIDEBAR_STATE);
    let finish!: (id: string) => void;
    createChatSpy.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; }));
    render(<App />);
    await waitFor(() => expect(connectSpy).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText("Message input"), { target: { value: "first request" } });
    fireEvent.keyDown(screen.getByLabelText("Message input"), { key: "Enter" });
    await waitFor(() => expect(createChatSpy).toHaveBeenCalledTimes(1));
    if (target === "session") fireEvent.click(screen.getByRole("button", { name: "Existing B", exact: true }));
    else fireEvent.click(screen.getByRole("button", { name: "New browser tab" }));
    await act(async () => { finish("late-created-a"); });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    if (target === "session") expect(screen.getByRole("button", { name: "Existing B", exact: true })).toHaveAttribute("aria-pressed", "true");
    else expect(screen.getByRole("tab", { name: "Mona" })).toHaveAttribute("aria-selected", "false");
  });

  it.each(["null", "reject"])("keeps a hidden first draft after %s creation failure and shows the error only on returning home", async (failure) => {
    let finish!: (id: string | null) => void;
    let fail!: (error: Error) => void;
    createChatSpy.mockImplementationOnce(() => new Promise<string | null>((resolve, reject) => { finish = resolve; fail = reject; }));
    render(<App />);
    await waitFor(() => expect(connectSpy).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText("Message input"), { target: { value: "retained home input" } });
    fireEvent.keyDown(screen.getByLabelText("Message input"), { key: "Enter" });
    await waitFor(() => expect(createChatSpy).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "New browser tab" }));
    await act(async () => { if (failure === "null") finish(null); else fail(new Error("synthetic creation failure")); });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Mona" })).toHaveAttribute("aria-selected", "false");
    fireEvent.click(screen.getByRole("tab", { name: "Mona" }));
    expect(await screen.findByRole("alertdialog")).toHaveTextContent("Message not sent");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.getByLabelText("Message input")).toHaveValue("retained home input");
    expect(createChatSpy).toHaveBeenCalledTimes(1);
  });

  beforeEach(() => {
    mockSessions = [];
    connectSpy.mockClear();
    updateUrlSpy.mockClear();
    refreshSpy.mockReset();
    createChatSpy.mockClear();
    openPartnerChatSpy.mockReset().mockResolvedValue(null);
    deleteChatSpy.mockReset();
    deleteAgentSpy.mockReset().mockResolvedValue(undefined);
    toggleThemeSpy.mockReset();
    attachSpy.mockReset();
    warmNativeProviderConnectionsSpy.mockClear();
    runStatusHandlers.clear();
    sessionDeletedHandlers.clear();
    deletedChatIds.clear();
    observedSessionTokens = [];
    reauthHandler = null;
    localStorage.removeItem("mona-webui.sidebar.completed-runs.v1");
    localStorage.removeItem("mona-webui.sidebar");
    vi.mocked(fetchBootstrap).mockReset().mockResolvedValue({
      token: "tok",
      ws_path: "/",
    });
    vi.mocked(resetGatewayBaseUrl).mockClear();
    vi.mocked(deriveWsUrl).mockReset().mockReturnValue("ws://test");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    invalidateAgents();
  });

  it.each(["Pin", "Archive"])("saves batch session %s in one sidebar update", async (action) => {
    mockSessions = ["Alpha", "Beta", "Charlie", "Delta"].map((title, index) => ({
      key: `websocket:${index}`,
      channel: "websocket",
      chatId: String(index),
      createdAt: `2026-10-01T0${4 - index}:00:00Z`,
      updatedAt: `2026-10-01T0${4 - index}:00:00Z`,
      title,
      preview: "",
    }));
    vi.spyOn(api, "fetchSidebarState").mockResolvedValue(DEFAULT_SIDEBAR_STATE);
    const update = vi.spyOn(api, "updateSidebarState").mockImplementation(async (_token, state) => state);

    render(<App />);
    const first = await screen.findByRole("button", { name: "Alpha", exact: true });
    await waitFor(() => expect(api.fetchSidebarState).toHaveBeenCalled());
    fireEvent.click(first);
    fireEvent.click(screen.getByRole("button", { name: "Charlie", exact: true }), { shiftKey: true });
    fireEvent.contextMenu(screen.getByRole("button", { name: "Beta", exact: true }));
    update.mockClear();
    fireEvent.click(await screen.findByRole("menuitem", { name: action }));
    if (action === "Archive") {
      const confirm = await screen.findByRole("alertdialog", { name: "Archive conversations?" });
      expect(update).not.toHaveBeenCalled();
      expect(confirm).toHaveTextContent("Their chat history is kept and remains available for memory search.");
      fireEvent.click(within(confirm).getByRole("button", { name: "Archive" }));
    }

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    const saved = update.mock.calls[0][1];
    expect(action === "Pin" ? saved.pinned_keys : saved.archived_keys)
      .toEqual(["websocket:0", "websocket:1", "websocket:2"]);
    if (action === "Archive") {
      await waitFor(() => expect(screen.getByRole("button", { name: "Delta", exact: true })).toHaveAttribute("aria-current", "page"));
    }
  });

  it("confirms batch session deletion once and reports partial failures", async () => {
    mockSessions = ["Alpha", "Beta", "Charlie", "Delta"].map((title, index) => ({
      key: `websocket:${index}`,
      channel: "websocket",
      chatId: String(index),
      createdAt: `2026-10-01T0${4 - index}:00:00Z`,
      updatedAt: `2026-10-01T0${4 - index}:00:00Z`,
      title,
      preview: "",
    }));
    vi.spyOn(api, "fetchSidebarState").mockResolvedValue(DEFAULT_SIDEBAR_STATE);
    vi.spyOn(api, "updateSidebarState").mockImplementation(async (_token, state) => state);
    deleteChatSpy.mockImplementation(async (key: string) => {
      if (key === "websocket:1") throw new Error("private details");
    });

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Alpha", exact: true }));
    fireEvent.click(screen.getByRole("button", { name: "Charlie", exact: true }), { shiftKey: true });
    fireEvent.contextMenu(screen.getByRole("button", { name: "Beta", exact: true }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));

    expect(await screen.findByText("Delete 3 selected conversations?")).toBeInTheDocument();
    expect(deleteChatSpy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete chat" }));
    expect(await screen.findByText("Some conversations could not be deleted")).toBeInTheDocument();
    expect(deleteChatSpy.mock.calls.map(([key]) => key)).toEqual(["websocket:0", "websocket:1", "websocket:2"]);
    expect(screen.getByText(/Deleted 2 conversations.*1 conversations/)).toBeInTheDocument();
    expect(screen.queryByText("private details")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Alpha", exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Charlie", exact: true })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Beta", exact: true })).toHaveAttribute("aria-current", "page");
  });

  it("warms native provider connection state after bootstrap without opening settings", async () => {
    render(<App />);
    await waitFor(() => expect(warmNativeProviderConnectionsSpy).toHaveBeenCalledTimes(1));
  });

  it("clears confirmed-deleted run state and selects an undeleted neighbor while a stale list remains", async () => {
    mockSessions = ["Alpha", "Beta"].map((title, index) => ({
      key: `websocket:${index}`, channel: "websocket", chatId: String(index),
      createdAt: null, updatedAt: null, title, preview: "",
    }));
    vi.spyOn(api, "fetchSidebarState").mockResolvedValue((await import("@/hooks/useSidebarState")).DEFAULT_SIDEBAR_STATE);
    vi.spyOn(api, "updateSidebarState").mockImplementation(async (_token, state) => state);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Alpha", exact: true }));
    act(() => {
      for (const handler of runStatusHandlers) {
        handler("0", 10);
        handler("1", 20);
        handler("1", null);
      }
    });
    expect(within(screen.getByRole("button", { name: "Alpha", exact: true })).getByRole("img", { name: "Agent running" })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("mona-webui.sidebar.completed-runs.v1") ?? "[]")).toEqual(["1"]);

    act(() => confirmSessionDeleted("0"));
    expect(screen.getByRole("button", { name: "Beta", exact: true })).toHaveAttribute("aria-current", "page");
    expect(within(screen.getByRole("button", { name: "Alpha", exact: true })).queryByRole("img", { name: "Agent running" })).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("mona-webui.sidebar.completed-runs.v1") ?? "[]")).toEqual(["1"]);

    act(() => confirmSessionDeleted("1"));
    expect(screen.getByRole("button", { name: "Alpha", exact: true })).not.toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "Beta", exact: true })).not.toHaveAttribute("aria-current", "page");
    expect(JSON.parse(localStorage.getItem("mona-webui.sidebar.completed-runs.v1") ?? "[]")).toEqual([]);
  });

  it("keeps sidebar layout out of the main thread width contract", async () => {
    const { container } = render(<App />);

    await waitFor(() => expect(connectSpy).toHaveBeenCalled());

    const main = container.querySelector("main");
    expect(main).toBeInTheDocument();
    expect(main).not.toHaveAttribute("style");

    expect(container.querySelector("nav.w-14")).toBeInTheDocument();
  });

  it("shows the session list by default despite a legacy collapsed preference", async () => {
    localStorage.setItem("mona-webui.sidebar", "0");
    render(<App />);

    await waitFor(() => expect(connectSpy).toHaveBeenCalled());
    expect(getSessionPanel()).toBeInTheDocument();
  });

  it("opens the session list after the startup window grows to desktop width", async () => {
    let viewportWidth = 640;
    const widthListeners = new Set<(event: MediaQueryListEvent) => void>();
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
      get matches() { return Number(query.match(/min-width:\s*(\d+)px/)?.[1] ?? Infinity) <= viewportWidth; },
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: (_event: string, handler: (event: MediaQueryListEvent) => void) => {
        if (query === "(min-width: 768px)") widthListeners.add(handler);
      },
      removeEventListener: (_event: string, handler: (event: MediaQueryListEvent) => void) => widthListeners.delete(handler),
      dispatchEvent: vi.fn(),
    })));
    render(<App />);
    await waitFor(() => expect(connectSpy).toHaveBeenCalled());

    act(() => {
      viewportWidth = 1280;
      widthListeners.forEach((handler) => handler({ matches: true } as MediaQueryListEvent));
      fireEvent(window, new Event("resize"));
    });
    expect(getSessionPanel()).toBeInTheDocument();
  });

  it("keeps sidebar toggle states separate across viewport changes and closes the mobile sheet on desktop", async () => {
    let viewportWidth = 1280;
    const widthListeners = new Set<(event: MediaQueryListEvent) => void>();
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
      get matches() { return Number(query.match(/min-width:\s*(\d+)px/)?.[1] ?? Infinity) <= viewportWidth; },
      media: query, onchange: null, addListener: vi.fn(), removeListener: vi.fn(),
      addEventListener: (_event: string, handler: (event: MediaQueryListEvent) => void) => {
        if (query === "(min-width: 768px)") widthListeners.add(handler);
      },
      removeEventListener: (_event: string, handler: (event: MediaQueryListEvent) => void) => widthListeners.delete(handler),
      dispatchEvent: vi.fn(),
    })));
    const resizeTo = (width: number) => act(() => {
      viewportWidth = width;
      widthListeners.forEach((handler) => handler({ matches: width >= 768 } as MediaQueryListEvent));
    });
    const { DEFAULT_SIDEBAR_STATE: initialState } = await import("@/hooks/useSidebarState");
    vi.spyOn(api, "fetchSidebarState").mockResolvedValue(initialState);
    vi.spyOn(api, "updateSidebarState").mockImplementation(async (_token, state) => state);
    render(<App />);
    await waitFor(() => expect(connectSpy).toHaveBeenCalled());

    expect(screen.getByRole("button", { name: "收起会话列表" })).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getByRole("button", { name: "收起会话列表" }));
    expect(screen.getByRole("button", { name: "展开会话列表" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("region", { name: "Sessions" })).not.toBeInTheDocument();

    resizeTo(640);
    const mobileToggle = screen.getByRole("button", { name: "展开会话列表" });
    expect(mobileToggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(mobileToggle);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(mobileToggle).toHaveAttribute("aria-label", "收起会话列表");
    expect(mobileToggle).toHaveAttribute("aria-expanded", "true");

    resizeTo(1280);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(document.body.style.pointerEvents).not.toBe("none");
    expect(screen.getByRole("button", { name: "展开会话列表" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("region", { name: "Sessions" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "展开会话列表" }));
    expect(screen.getByRole("button", { name: "收起会话列表" })).toHaveAttribute("aria-expanded", "true");
    expect(getSessionPanel()).toBeInTheDocument();

    resizeTo(640);
    expect(screen.getByRole("button", { name: "展开会话列表" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    resizeTo(1280);
    expect(screen.getByRole("button", { name: "收起会话列表" })).toHaveAttribute("aria-expanded", "true");
    expect(getSessionPanel()).toBeInTheDocument();
  });

  it("keeps the session list available at 768px and allows manual toggling", async () => {
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
      matches: Number(query.match(/min-width:\s*(\d+)px/)?.[1] ?? Infinity) <= 768,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));
    render(<App />);
    await waitFor(() => expect(connectSpy).toHaveBeenCalled());

    expect(getSessionPanel()).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "收起会话列表" }));
    await waitFor(() => {
      expect(screen.queryByRole("region", { name: "Sessions" })).not.toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: "展开会话列表" }));
    await waitFor(() => expect(getSessionPanel()).toBeInTheDocument());
    expect(getSessionPanel()).toHaveClass("md:flex");

  });

  it("lets a maximized right workspace cover the session list", async () => {
    mockSessions = [
      {
        key: "websocket:chat-canvas",
        channel: "websocket",
        chatId: "chat-canvas",
        createdAt: "2026-09-02T00:00:00Z",
        updatedAt: "2026-09-02T00:00:00Z",
        title: "Canvas chat",
        preview: "Mind map",
      },
    ];

    render(<App />);
    await waitFor(() => expect(connectSpy).toHaveBeenCalled());

    fireEvent.click(within(getSessionPanel()).getByRole("button", { name: "Canvas chat", exact: true }));
    fireEvent.click(await screen.findByTitle("展开工作区"));
    fireEvent.click(await screen.findByRole("button", { name: "最大化侧边栏" }));

    await waitFor(() => {
      expect(screen.queryByRole("region", { name: "Sessions" })).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "还原侧边栏" }));
    await waitFor(() => expect(getSessionPanel()).toBeInTheDocument());
  });

  it("selects the undeleted neighbor after confirming deletion of the active chat", async () => {
    mockSessions = ["First chat", "Second chat"].map((title, index) => ({
      key: `websocket:chat-${index}`, channel: "websocket", chatId: `chat-${index}`,
      createdAt: null, updatedAt: null, title, preview: "",
    }));
    const { DEFAULT_SIDEBAR_STATE: initialState } = await import("@/hooks/useSidebarState");
    vi.spyOn(api, "fetchSidebarState").mockResolvedValue(initialState);
    vi.spyOn(api, "updateSidebarState").mockImplementation(async (_token, state) => state);
    render(<App />);
    const first = await screen.findByRole("button", { name: "First chat", exact: true });
    fireEvent.click(first);
    expect(first).toHaveAttribute("aria-current", "page");
    fireEvent.contextMenu(first);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    const confirmation = await screen.findByRole("alertdialog");
    expect(confirmation).toHaveTextContent("Delete this chat?");
    expect(deleteChatSpy).not.toHaveBeenCalled();
    fireEvent.click(within(confirmation).getByRole("button", { name: "Delete chat" }));
    await waitFor(() => expect(deleteChatSpy).toHaveBeenCalledTimes(1));
    expect(deleteChatSpy).toHaveBeenCalledWith("websocket:chat-0");
    await waitFor(() => expect(screen.getByRole("button", { name: "Second chat", exact: true })).toHaveAttribute("aria-current", "page"));
    expect(screen.queryByRole("button", { name: "First chat", exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(document.body.style.pointerEvents).not.toBe("none");
    expect(createChatSpy).not.toHaveBeenCalled();
  });

  it("keeps mobile chat actions accessible through the sidebar sheet lifecycle", async () => {
    mockSessions = [{
      key: "websocket:mobile-a", channel: "websocket", chatId: "mobile-a",
      createdAt: null, updatedAt: null, title: "Mobile chat", preview: "",
    }];
    const { DEFAULT_SIDEBAR_STATE: initialState } = await import("@/hooks/useSidebarState");
    vi.spyOn(api, "fetchSidebarState").mockResolvedValue(initialState);
    vi.spyOn(api, "updateSidebarState").mockImplementation(async (_token, state) => state);
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
      matches: Number(query.match(/min-width:\s*(\d+)px/)?.[1] ?? Infinity) <= 640,
      media: query, onchange: null, addListener: vi.fn(), removeListener: vi.fn(),
      addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    })));
    render(<App />);
    await waitFor(() => expect(connectSpy).toHaveBeenCalled());
    const toggle = screen.getByRole("button", { name: "展开会话列表" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    const sheet = await screen.findByRole("dialog");
    const sidebar = within(sheet).getByRole("region", { name: "Sessions" });
    fireEvent.contextMenu(await within(sidebar).findByRole("button", { name: "Mobile chat", exact: true }));
    const menu = await screen.findByRole("menu");
    const remove = within(menu).getByRole("menuitem", { name: "Delete" });
    expect(sheet).toContainElement(menu);
    await waitFor(() => expect(menu).toContainElement(document.activeElement as HTMLElement));
    fireEvent.click(remove);
    const confirmation = await screen.findByRole("alertdialog");
    expect(confirmation).toHaveTextContent("Delete this chat?");
    expect(deleteChatSpy).not.toHaveBeenCalled();
    fireEvent.click(within(confirmation).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(screen.getByRole("dialog")).toBe(sheet);
    expect(within(sidebar).getByRole("button", { name: "Mobile chat", exact: true })).toBeInTheDocument();
    expect(deleteChatSpy).not.toHaveBeenCalled();
    fireEvent.keyDown(sheet, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(document.body.style.pointerEvents).not.toBe("none");
  });

  it("restores persisted conversation and project metadata and preserves it across sidebar updates", async () => {
    const workspace = "D:/work/ProjectAlpha";
    mockSessions = [
      { id: "archived", title: "Archived chat" },
      { id: "pinned", title: "Original title" },
      { id: "project", title: "Project task", workspace },
      { id: "regular", title: "Archive target" },
    ].map(({ id, ...fields }) => ({
      key: `websocket:${id}`, channel: "websocket", chatId: id,
      createdAt: null, updatedAt: null, preview: "", ...fields,
    }));
    const { DEFAULT_SIDEBAR_STATE: defaults } = await import("@/hooks/useSidebarState");
    let storedState: typeof defaults = {
      ...defaults, view: { ...defaults.view },
      pinned_keys: ["websocket:pinned"], archived_keys: ["websocket:archived"],
      title_overrides: { "websocket:pinned": "Roadmap" },
      project_names: { [workspace]: "Renamed project" },
    };
    const load = vi.spyOn(api, "fetchSidebarState").mockImplementation(async () => storedState);
    const save = vi.spyOn(api, "updateSidebarState").mockImplementation(async (_token, state) => {
      storedState = state;
      return state;
    });
    const first = render(<App />);
    const sidebar = await screen.findByRole("region", { name: "Sessions" });
    const pinned = await within(sidebar).findByRole("region", { name: "Pinned" });
    expect(within(pinned).getByRole("button", { name: "Roadmap", exact: true })).toBeInTheDocument();
    expect(within(sidebar).queryByRole("button", { name: "Archived chat", exact: true })).not.toBeInTheDocument();
    expect(within(sidebar).queryByRole("button", { name: "Original title", exact: true })).not.toBeInTheDocument();
    expect(within(within(sidebar).getByRole("region", { name: "Renamed project" })).getByRole("button", { name: "Project task", exact: true }))
      .toBeInTheDocument();
    expect(load).toHaveBeenCalledWith("tok");

    fireEvent.contextMenu(within(sidebar).getByRole("button", { name: "Roadmap", exact: true }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Unpin" }));
    await waitFor(() => expect(save.mock.calls.at(-1)?.[1].pinned_keys).toEqual([]));
    fireEvent.contextMenu(within(sidebar).getByRole("button", { name: "Archive target", exact: true }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Archive" }));
    const cancelled = await screen.findByRole("alertdialog", { name: "Archive conversations?" });
    fireEvent.click(within(cancelled).getByRole("button", { name: "Cancel" }));
    expect(storedState.archived_keys).toEqual(["websocket:archived"]);
    const archiveTarget = within(sidebar).getByRole("button", { name: "Archive target", exact: true });
    fireEvent.click(within(archiveTarget.closest("li")!).getByRole("button", { name: "Archive" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Archive conversations?" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(save.mock.calls.at(-1)?.[1].archived_keys).toEqual([
      "websocket:archived", "websocket:regular",
    ]));
    expect(storedState.title_overrides).toEqual({ "websocket:pinned": "Roadmap" });
    expect(deleteChatSpy).not.toHaveBeenCalled();
    expect(storedState.project_names).toEqual({ [workspace]: "Renamed project" });
    const loaded = load.mock.calls.length;
    first.unmount();
    render(<App />);
    await waitFor(() => expect(load.mock.calls.length).toBeGreaterThan(loaded));
    const restored = await screen.findByRole("region", { name: "Sessions" });
    await waitFor(() => expect(within(restored).queryByRole("region", { name: "Pinned" })).not.toBeInTheDocument());
    expect(within(restored).getByRole("button", { name: "Roadmap", exact: true })).toBeInTheDocument();
    expect(within(restored).getByRole("region", { name: "Renamed project" })).toBeInTheDocument();
    expect(within(restored).queryByRole("button", { name: "Archived chat", exact: true })).not.toBeInTheDocument();
    expect(within(restored).queryByRole("button", { name: "Archive target", exact: true })).not.toBeInTheDocument();
    expect(createChatSpy).not.toHaveBeenCalled();
  });

  it("shows run status only on its session and clears it when the run ends", async () => {
    mockSessions = [
      {
        key: "websocket:chat-a",
        channel: "websocket",
        chatId: "chat-a",
        createdAt: null,
        updatedAt: null,
        title: "Working chat",
        preview: "",
      },
      {
        key: "websocket:chat-b",
        channel: "websocket",
        chatId: "chat-b",
        createdAt: null,
        updatedAt: null,
        title: "Quiet chat",
        preview: "",
      },
    ];
    const { DEFAULT_SIDEBAR_STATE: initialState } = await import("@/hooks/useSidebarState");
    vi.spyOn(api, "fetchSidebarState").mockResolvedValue(initialState);
    vi.spyOn(api, "updateSidebarState").mockImplementation(async (_token, state) => state);

    render(<App />);

    await waitFor(() => expect(connectSpy).toHaveBeenCalled());
    const sidebar = getSessionPanel();
    const working = await within(sidebar).findByRole("button", { name: "Working chat", exact: true });
    const quiet = within(sidebar).getByRole("button", { name: "Quiet chat", exact: true });
    expect(within(sidebar).queryByRole("img", { name: "Agent running" })).not.toBeInTheDocument();

    act(() => {
      for (const handler of runStatusHandlers) handler("chat-a", 12_345);
    });
    expect(within(working).getByRole("img", { name: "Agent running" })).toBeInTheDocument();
    expect(within(quiet).queryByRole("img", { name: "Agent running" })).not.toBeInTheDocument();

    act(() => {
      for (const handler of runStatusHandlers) handler("chat-a", null);
    });
    expect(within(sidebar).queryByRole("img", { name: "Agent running" })).not.toBeInTheDocument();
    expect(within(sidebar).queryByText("Agent finished")).not.toBeInTheDocument();
    expect(within(sidebar).queryByTitle("Agent finished")).not.toBeInTheDocument();
  });

  it("restores server-reported runs after reload without reviving completed indicators", async () => {
    mockSessions = [
      {
        key: "websocket:chat-a",
        channel: "websocket",
        chatId: "chat-a",
        createdAt: null,
        updatedAt: null,
        title: "Running after reload",
        preview: "",
        runStartedAt: 12_345,
      },
      {
        key: "websocket:chat-b",
        channel: "websocket",
        chatId: "chat-b",
        createdAt: null,
        updatedAt: null,
        title: "Completed after reload",
        preview: "",
      },
    ];
    const { DEFAULT_SIDEBAR_STATE: initialState } = await import("@/hooks/useSidebarState");
    vi.spyOn(api, "fetchSidebarState").mockResolvedValue(initialState);
    vi.spyOn(api, "updateSidebarState").mockImplementation(async (_token, state) => state);
    localStorage.setItem(
      "mona-webui.sidebar.completed-runs.v1",
      JSON.stringify(["chat-a", "chat-b"]),
    );

    render(<App />);

    await waitFor(() => expect(connectSpy).toHaveBeenCalled());
    const sidebar = getSessionPanel();
    await waitFor(() =>
      expect(within(within(sidebar).getByRole("button", { name: "Running after reload", exact: true })).getByRole("img", { name: "Agent running" })).toBeInTheDocument(),
    );
    expect(within(within(sidebar).getByRole("button", { name: "Completed after reload", exact: true })).queryByRole("img", { name: "Agent running" })).not.toBeInTheDocument();
    expect(within(sidebar).queryByText("Agent finished")).not.toBeInTheDocument();
    expect(within(sidebar).queryByTitle("Agent finished")).not.toBeInTheDocument();
    expect(attachSpy).toHaveBeenCalledTimes(1);
    expect(attachSpy).toHaveBeenCalledWith("chat-a");
  });

  it("opens account settings from the current account entry", async () => {
    mockSessions = [{
      key: "websocket:chat-a", channel: "websocket", chatId: "chat-a",
      createdAt: null, updatedAt: null, title: "Existing chat", preview: "",
    }];
    const { DEFAULT_SIDEBAR_STATE: initialState } = await import("@/hooks/useSidebarState");
    vi.spyOn(api, "fetchSidebarState").mockResolvedValue(initialState);
    vi.spyOn(api, "updateSidebarState").mockImplementation(async (_token, state) => state);
    render(<App />);
    await waitFor(() => expect(connectSpy).toHaveBeenCalled());
    expect(await screen.findByRole("button", { name: "Existing chat", exact: true })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));

    const settingsNav = await screen.findByRole("navigation", { name: "Settings sections" });
    expect(within(settingsNav).getByRole("button", { name: "Account" }))
      .toHaveAttribute("aria-current", "page");
    expect(within(settingsNav).getByRole("button", { name: "General" }))
      .not.toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("heading", { name: "Account" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Back to chat" })).toBeVisible();
    expect(document.title).toBe("Settings · mona");
    expect(createChatSpy).not.toHaveBeenCalled();
  });

  it("returns from account settings to the blank home without selecting or creating a chat", async () => {
    mockSessions = ["First chat", "Second chat"].map((title, index) => ({
      key: `websocket:chat-${index}`, channel: "websocket", chatId: `chat-${index}`,
      createdAt: null, updatedAt: null, title, preview: "",
    }));
    const { DEFAULT_SIDEBAR_STATE: initialState } = await import("@/hooks/useSidebarState");
    vi.spyOn(api, "fetchSidebarState").mockResolvedValue(initialState);
    vi.spyOn(api, "updateSidebarState").mockImplementation(async (_token, state) => state);
    render(<App />);
    await waitFor(() => expect(connectSpy).toHaveBeenCalled());
    await screen.findByRole("button", { name: "First chat", exact: true });
    expect(screen.getByLabelText("Message input")).toHaveValue("");
    expect(document.title).toBe("mona");

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    const settingsNav = await screen.findByRole("navigation", { name: "Settings sections" });
    expect(within(settingsNav).getByRole("button", { name: "Account" }))
      .toHaveAttribute("aria-current", "page");
    fireEvent.click(screen.getByRole("button", { name: "Back to chat" }));

    expect(screen.queryByRole("navigation", { name: "Settings sections" })).not.toBeInTheDocument();
    expect(document.title).toBe("mona");
    expect(screen.getByText("What can I do for you?")).toBeVisible();
    expect(screen.getByLabelText("Message input")).toHaveValue("");
    expect(screen.getByRole("button", { name: "First chat", exact: true })).not.toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "Second chat", exact: true })).not.toHaveAttribute("aria-current", "page");
    expect(createChatSpy).not.toHaveBeenCalled();
    expect(attachSpy).not.toHaveBeenCalled();
  });

  it("filters all search terms across titles and previews and selects the matched chat", async () => {
    mockSessions = [
      { key: "websocket:chat-alpha", channel: "websocket", chatId: "chat-alpha",
        createdAt: null, updatedAt: null, title: "Q2 roadmap", preview: "Project planning notes" },
      { key: "websocket:chat-beta", channel: "websocket", chatId: "chat-beta",
        createdAt: null, updatedAt: null, title: "Q2 review", preview: "Budget notes" },
      { key: "websocket:chat-gamma", channel: "websocket", chatId: "chat-gamma",
        createdAt: null, updatedAt: null, title: "Trip planning", preview: "Travel ideas" },
    ];
    const { DEFAULT_SIDEBAR_STATE: initialState } = await import("@/hooks/useSidebarState");
    vi.spyOn(api, "fetchSidebarState").mockResolvedValue(initialState);
    vi.spyOn(api, "updateSidebarState").mockImplementation(async (_token, state) => state);
    render(<App />);
    await waitFor(() => expect(connectSpy).toHaveBeenCalled());
    const sidebar = getSessionPanel();
    await within(sidebar).findByRole("button", { name: "Q2 roadmap", exact: true });
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const dialog = await screen.findByRole("dialog", { name: "Search" });
    const textbox = within(dialog).getByRole("textbox", { name: "Search" });

    fireEvent.change(textbox, { target: { value: "  Q2   PLANNING  " } });
    expect(within(dialog).getByText("Q2 roadmap")).toBeInTheDocument();
    expect(within(dialog).queryByText("Q2 review")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("Trip planning")).not.toBeInTheDocument();
    expect(within(sidebar).getByRole("button", { name: "Q2 review", exact: true })).toBeInTheDocument();
    expect(within(sidebar).getByRole("button", { name: "Trip planning", exact: true })).toBeInTheDocument();

    fireEvent.change(textbox, { target: { value: "q2 missing" } });
    expect(within(dialog).queryByRole("button", { name: /Q2 roadmap/ })).not.toBeInTheDocument();
    fireEvent.change(textbox, { target: { value: "road q2" } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: /Q2 roadmap/ }));
    });

    expect(screen.queryByRole("dialog", { name: "Search" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Q2 roadmap", exact: true })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "Q2 review", exact: true })).not.toHaveAttribute("aria-current", "page");
    expect(document.title).toBe("Q2 roadmap · mona");
    expect(createChatSpy).not.toHaveBeenCalled();
  });

  it("opens search from the keyboard shortcut", async () => {
    mockSessions = [
      {
        key: "websocket:chat-a",
        channel: "websocket",
        chatId: "chat-a",
        createdAt: "2026-04-16T10:00:00Z",
        updatedAt: "2026-04-16T10:00:00Z",
        preview: "Existing chat",
      },
    ];

    render(<App />);

    await waitFor(() => expect(connectSpy).toHaveBeenCalled());
    fireEvent.keyDown(window, { key: "k", metaKey: true });

    const dialog = await screen.findByRole("dialog", { name: "Search" });
    expect(within(dialog).queryByText("Global actions")).not.toBeInTheDocument();
    expect(within(dialog).getByText("Existing chat")).toBeInTheDocument();

    const textbox = within(dialog).getByRole("textbox", { name: "Search" });
    fireEvent.change(textbox, { target: { value: "missing" } });
    expect(within(dialog).queryByText("Existing chat")).not.toBeInTheDocument();

    fireEvent.change(textbox, { target: { value: "existing" } });
    expect(within(dialog).getByText("Existing chat")).toBeInTheDocument();

    fireEvent.keyDown(textbox, { key: "Enter" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Search" })).not.toBeInTheDocument(),
    );
    expect(createChatSpy).not.toHaveBeenCalled();
  });

  it("limits initial sidebar rows while global search can select a tail session", async () => {
    mockSessions = Array.from({ length: 170 }, (_, index) => {
      const chatId = `chat-${index}`;
      return {
        key: `websocket:${chatId}`,
        channel: "websocket" as const,
        chatId,
        createdAt: new Date(Date.UTC(2026, 3, 16, 12, -index)).toISOString(),
        updatedAt: new Date(Date.UTC(2026, 3, 16, 12, -index)).toISOString(),
        title: index === 169 ? "Hidden target" : `Bulk chat ${index}`,
        preview: "",
      };
    });

    const { DEFAULT_SIDEBAR_STATE: initialState } = await import("@/hooks/useSidebarState");
    vi.spyOn(api, "fetchSidebarState").mockResolvedValue(initialState);
    vi.spyOn(api, "updateSidebarState").mockImplementation(async (_token, state) => state);
    render(<App />);
    await waitFor(() => expect(connectSpy).toHaveBeenCalled());
    const sidebar = getSessionPanel();
    await within(sidebar).findByRole("button", { name: "Bulk chat 0", exact: true });
    expect(within(sidebar).getAllByRole("button", { name: /^Bulk chat \d+$/ })).toHaveLength(160);
    expect(within(sidebar).getByRole("button", { name: "Bulk chat 159", exact: true })).toBeInTheDocument();
    expect(within(sidebar).queryByRole("button", { name: "Bulk chat 160", exact: true })).not.toBeInTheDocument();
    expect(within(sidebar).queryByRole("button", { name: "Hidden target", exact: true })).not.toBeInTheDocument();
    expect(within(sidebar).getByRole("button", { name: "Show 10 more" })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const dialog = await screen.findByRole("dialog", { name: "Search" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Search" }), {
      target: { value: "hidden" },
    });
    expect(within(dialog).getByText("Hidden target")).toBeInTheDocument();
    expect(within(dialog).queryByText("Bulk chat 0")).not.toBeInTheDocument();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Hidden target" }));
    });

    expect(screen.queryByRole("dialog", { name: "Search" })).not.toBeInTheDocument();
    expect(document.title).toBe("Hidden target · mona");
    expect(createChatSpy).not.toHaveBeenCalled();
  });

  it("opens a blank Mona task directly from the existing plus", async () => {
    mockSessions = ["Existing chat", "Another chat"].map((title, index) => ({
      key: `websocket:chat-${index}`, channel: "websocket", chatId: `chat-${index}`,
      createdAt: null, updatedAt: null, title, preview: "",
    }));
    const { DEFAULT_SIDEBAR_STATE: initialState } = await import("@/hooks/useSidebarState");
    vi.spyOn(api, "fetchSidebarState").mockResolvedValue(initialState);
    vi.spyOn(api, "updateSidebarState").mockImplementation(async (_token, state) => state);
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
      matches: Number(query.match(/min-width:\s*(\d+)px/)?.[1] ?? Infinity) <= 1280,
      media: query, onchange: null, addListener: vi.fn(), removeListener: vi.fn(),
      addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    })));
    const user = userEvent.setup();
    // happy-dom puts zero-sized resize handles at the default pointer origin.
    const coords = { clientX: 200, clientY: 200 };
    render(<App />);
    await waitFor(() => expect(connectSpy).toHaveBeenCalled());
    await user.pointer({ target: await screen.findByRole("button", { name: "Existing chat", exact: true }), coords, keys: "[MouseLeft]" });
    expect(screen.getByRole("button", { name: "Existing chat", exact: true })).toHaveAttribute("aria-current", "page");
    expect(createChatSpy).not.toHaveBeenCalled();

    const createTrigger = within(getSessionPanel()).getByRole("button", { name: "New task" });
    await user.pointer({ target: createTrigger, coords, keys: "[MouseLeft]" });

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(document.title).toBe("mona");
    expect(screen.getByText("What can I do for you?")).toBeVisible();
    expect(screen.getByLabelText("Message input")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Existing chat", exact: true })).not.toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "Another chat", exact: true })).not.toHaveAttribute("aria-current", "page");
    expect(createChatSpy).not.toHaveBeenCalled();
  });

  it("resumes a saved partner chat and keeps partner drafts separate from Mona tasks", async () => {
    const cindy = { id: "local.custom.cindy", displayName: "Cindy", enabled: true };
    const sam = { id: "local.custom.sam", displayName: "Sam", enabled: true };
    vi.spyOn(api, "listAgents").mockResolvedValue([cindy, sam]);
    vi.spyOn(api, "fetchSidebarState").mockResolvedValue(DEFAULT_SIDEBAR_STATE);
    mockSessions = [{
      key: "websocket:partner-cindy", channel: "websocket", chatId: "partner-cindy",
      createdAt: null, updatedAt: null, title: "Weekly notes", preview: "Latest reply",
      conversation: { type: "direct", title: "Cindy", agentIds: [cindy.id], directAgentId: cindy.id, partnerConversation: true },
    }];

    render(<App />);
    const partner = await within(getSessionPanel()).findByRole("button", { name: /Cindy/ });
    fireEvent.click(partner);
    expect(partner).toHaveAttribute("aria-current", "page");
    expect(document.title).toBe("Cindy · mona");
    expect(openPartnerChatSpy).not.toHaveBeenCalled();

    const newTask = within(getSessionPanel()).getByRole("button", { name: "New task" });
    fireEvent.click(newTask);
    fireEvent.change(screen.getByLabelText("Message input"), { target: { value: "Draft for Mona" } });
    fireEvent.click(within(getSessionPanel()).getByRole("button", { name: /Sam/ }));
    expect(await screen.findByTestId("partner-agent-welcome")).toHaveTextContent("Sam");
    expect(openPartnerChatSpy).toHaveBeenCalledWith(sam.id, false);
    expect(screen.getByLabelText("Message input")).toHaveValue("");
    fireEvent.change(screen.getByLabelText("Message input"), { target: { value: "Draft for Sam" } });

    fireEvent.click(newTask);
    expect(screen.getByLabelText("Message input")).toHaveValue("Draft for Mona");
    expect(createChatSpy).not.toHaveBeenCalled();
  });

  it("opens partner settings beside the title and returns to the same chat draft", async () => {
    const cindy = { id: "local.custom.cindy", displayName: "Cindy", enabled: true };
    vi.spyOn(api, "listAgents").mockResolvedValue([cindy]);
    vi.spyOn(api, "fetchSidebarState").mockResolvedValue(DEFAULT_SIDEBAR_STATE);
    vi.spyOn(api, "fetchWebuiThread").mockResolvedValue({ schemaVersion: 3, messages: [] });
    mockSessions = [{
      key: "websocket:partner-cindy", channel: "websocket", chatId: "partner-cindy",
      createdAt: null, updatedAt: null, title: "Weekly notes", preview: "Latest reply",
      conversation: { type: "direct", title: "Cindy", agentIds: [cindy.id], directAgentId: cindy.id, partnerConversation: true },
    }];

    render(<App />);
    fireEvent.click(await within(getSessionPanel()).findByRole("button", { name: /Cindy/ }));
    await waitFor(() => expect(screen.getByLabelText("Message input")).toBeEnabled());
    fireEvent.change(screen.getByLabelText("Message input"), { target: { value: "Draft for Cindy" } });
    fireEvent.click(screen.getByRole("button", { name: "Agent settings: Cindy" }));
    expect(screen.getByTestId("partner-settings")).toHaveTextContent(cindy.id);
    expect(screen.getByLabelText("Message input").closest('[aria-hidden="true"]')).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Back to chat" }));
    expect(screen.getByLabelText("Message input")).toHaveValue("Draft for Cindy");
    expect(within(getSessionPanel()).getByRole("button", { name: /Cindy/ })).toHaveAttribute("aria-current", "page");

    fireEvent.click(within(getSessionPanel()).getByRole("button", { name: "New task" }));
    expect(screen.queryByRole("button", { name: "Agent settings: Cindy" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Agent settings: Mona" }));
    expect(screen.getByTestId("partner-settings")).toHaveTextContent("mona");
  });

  it("opens a second chat, saves its alias, and deletes only that conversation", async () => {
    const cindy = { id: "local.custom.cindy", displayName: "Cindy", enabled: true };
    const conversation = { type: "direct" as const, title: "Cindy", agentIds: [cindy.id], directAgentId: cindy.id, partnerConversation: true };
    vi.spyOn(api, "listAgents").mockResolvedValue([cindy]);
    vi.spyOn(api, "fetchSidebarState").mockResolvedValue(DEFAULT_SIDEBAR_STATE);
    const saveSidebar = vi.spyOn(api, "updateSidebarState").mockImplementation(async (_token, state) => state);
    vi.spyOn(api, "fetchWebuiThread").mockResolvedValue({ schemaVersion: 3, messages: [] });
    mockSessions = [
      { key: "websocket:copy", channel: "websocket", chatId: "copy", createdAt: null, updatedAt: null, preview: "",
        conversation: { ...conversation, partnerConversationCopy: true } },
      { key: "websocket:partner", channel: "websocket", chatId: "partner", createdAt: null, updatedAt: null, preview: "Original history",
        conversation },
    ];
    openPartnerChatSpy.mockResolvedValueOnce("copy");

    render(<App />);
    const original = await within(getSessionPanel()).findByRole("button", { name: /Cindy.*Original history/ });
    fireEvent.click(original);
    expect(original).toHaveAttribute("aria-current", "page");
    expect(await screen.findByRole("button", { name: "Agent settings: Cindy" })).toBeVisible();

    fireEvent.contextMenu(original);
    const duplicate = await screen.findByRole("menuitem", { name: "Duplicate partner" });
    expect(screen.queryByRole("menuitem", { name: "Set alias" })).not.toBeInTheDocument();
    fireEvent.click(duplicate);
    const copy = within(getSessionPanel()).getByRole("button", { name: /Cindy · Copy/ });
    await waitFor(() => expect(copy).toHaveAttribute("aria-current", "page"));
    expect(openPartnerChatSpy).toHaveBeenCalledWith(cindy.id, true, true);
    expect(screen.queryByRole("button", { name: /Agent settings:/ })).not.toBeInTheDocument();

    fireEvent.contextMenu(copy);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Set alias" }));
    const aliasDialog = await screen.findByRole("dialog", { name: "Set alias" });
    fireEvent.change(within(aliasDialog).getByRole("textbox"), { target: { value: "Song drafts" } });
    fireEvent.click(within(aliasDialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saveSidebar).toHaveBeenCalledWith("tok", expect.objectContaining({
      title_overrides: { "websocket:copy": "Song drafts" },
    })));
    expect(copy).toHaveTextContent("Song drafts");
    expect(document.title).toBe("Song drafts · mona");
    expect(original).toHaveTextContent("Cindy");

    fireEvent.contextMenu(copy);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete permanently" }));
    const confirmation = await screen.findByRole("alertdialog");
    expect(confirmation).toHaveTextContent("Permanently delete the conversation");
    expect(deleteChatSpy).not.toHaveBeenCalled();
    fireEvent.click(within(confirmation).getByRole("button", { name: "Delete permanently" }));
    await waitFor(() => expect(copy).not.toBeInTheDocument());
    expect(deleteChatSpy).toHaveBeenCalledWith("websocket:copy");
    expect(deleteAgentSpy).not.toHaveBeenCalled();
    expect(original).toBeVisible();
  });

  it("does not re-bootstrap the token during a long-running session", async () => {
    vi.useFakeTimers();

    const { unmount } = render(<App />);
    await act(async () => {});

    expect(connectSpy).toHaveBeenCalled();
    expect(fetchBootstrap).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    });

    expect(fetchBootstrap).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("refreshes the bootstrap token before a WebSocket reconnect", async () => {
    vi.mocked(fetchBootstrap)
      .mockResolvedValueOnce({ token: "tok-1", ws_path: "/" })
      .mockResolvedValueOnce({ token: "tok-2", ws_path: "/" });
    vi.mocked(deriveWsUrl).mockImplementation(
      (_wsPath: string, token: string) => `ws://test?token=${token}`,
    );
    const resetApiBaseSpy = vi.spyOn(api, "resetApiBase");

    render(<App />);
    await waitFor(() => expect(connectSpy).toHaveBeenCalled());
    expect(fetchBootstrap).toHaveBeenCalledTimes(1);
    expect(reauthHandler).toBeTypeOf("function");

    let reconnectUrl: string | null = null;
    await act(async () => {
      reconnectUrl = await reauthHandler!();
    });

    expect(resetApiBaseSpy).toHaveBeenCalledTimes(1);
    expect(resetGatewayBaseUrl).toHaveBeenCalledTimes(1);
    expect(fetchBootstrap).toHaveBeenCalledTimes(2);
    expect(reconnectUrl).toBe("ws://test?token=tok-2");
    await waitFor(() => expect(observedSessionTokens).toContain("tok-2"));
    resetApiBaseSpy.mockRestore();
  });
});
