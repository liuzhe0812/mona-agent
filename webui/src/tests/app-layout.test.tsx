import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatSummary } from "@/lib/types";

const connectSpy = vi.fn();
const refreshSpy = vi.fn();
const createChatSpy = vi.fn().mockResolvedValue("chat-1");
const deleteChatSpy = vi.fn();
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

vi.mock("@/lib/mona-client", () => {
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
    sendMessage = vi.fn();
    newChat = vi.fn();
    attach = attachSpy;
    close = vi.fn();
    updateUrl = updateUrlSpy;
  }

  return { MonaClient: MockClient };
});

vi.mock("@/lib/native-provider-bootstrap", () => ({
  warmNativeProviderConnections: warmNativeProviderConnectionsSpy,
}));

vi.mock("@/components/terminal/VncViewer", () => ({
  VncViewer: () => null,
}));

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
    if (target === "session") fireEvent.click(screen.getByTitle("Existing B"));
    else fireEvent.click(screen.getByRole("button", { name: "New browser tab" }));
    await act(async () => { finish("late-created-a"); });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    if (target === "session") expect(screen.getByTitle("Existing B")).toHaveAttribute("aria-pressed", "true");
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
    deleteChatSpy.mockReset();
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
    fireEvent.click(await screen.findByTitle("Alpha"));
    act(() => {
      for (const handler of runStatusHandlers) {
        handler("0", 10);
        handler("1", 20);
        handler("1", null);
      }
    });
    expect(within(screen.getByTitle("Alpha")).getByText("Agent running")).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("mona-webui.sidebar.completed-runs.v1") ?? "[]")).toEqual(["1"]);

    act(() => confirmSessionDeleted("0"));
    expect(screen.getByTitle("Beta")).toHaveAttribute("aria-current", "page");
    expect(within(screen.getByTitle("Alpha")).queryByText("Agent running")).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("mona-webui.sidebar.completed-runs.v1") ?? "[]")).toEqual(["1"]);

    act(() => confirmSessionDeleted("1"));
    expect(screen.getByTitle("Alpha")).not.toHaveAttribute("aria-current", "page");
    expect(screen.getByTitle("Beta")).not.toHaveAttribute("aria-current", "page");
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

    fireEvent.click(within(getSessionPanel()).getByTitle("Canvas chat"));
    fireEvent.click(await screen.findByTitle("展开工作区"));
    fireEvent.click(await screen.findByRole("button", { name: "最大化侧边栏" }));

    await waitFor(() => {
      expect(screen.queryByRole("region", { name: "Sessions" })).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "还原侧边栏" }));
    await waitFor(() => expect(getSessionPanel()).toBeInTheDocument());
  });

  // Legacy monolithic sidebar contracts below are superseded by focused
  // AppRail, ChatList, SessionListPanel and sidebar-state suites.
  it("selects the undeleted neighbor after confirming deletion of the active chat", async () => {
    mockSessions = ["First chat", "Second chat"].map((title, index) => ({
      key: `websocket:chat-${index}`, channel: "websocket", chatId: `chat-${index}`,
      createdAt: null, updatedAt: null, title, preview: "",
    }));
    const { DEFAULT_SIDEBAR_STATE: initialState } = await import("@/hooks/useSidebarState");
    vi.spyOn(api, "fetchSidebarState").mockResolvedValue(initialState);
    vi.spyOn(api, "updateSidebarState").mockImplementation(async (_token, state) => state);
    render(<App />);
    const first = await screen.findByTitle("First chat");
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
    await waitFor(() => expect(screen.getByTitle("Second chat")).toHaveAttribute("aria-current", "page"));
    expect(screen.queryByTitle("First chat")).not.toBeInTheDocument();
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
    fireEvent.click(screen.getByRole("button", { name: /会话列表$/ }));
    const sheet = await screen.findByRole("dialog");
    const sidebar = within(sheet).getByRole("region", { name: "Sessions" });
    fireEvent.contextMenu(await within(sidebar).findByTitle("Mobile chat"));
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
    expect(within(sidebar).getByTitle("Mobile chat")).toBeInTheDocument();
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
    expect(within(pinned).getByTitle("Roadmap")).toBeInTheDocument();
    expect(within(sidebar).queryByTitle("Archived chat")).not.toBeInTheDocument();
    expect(within(sidebar).queryByTitle("Original title")).not.toBeInTheDocument();
    expect(within(within(sidebar).getByRole("region", { name: "Renamed project" })).getByTitle("Project task"))
      .toBeInTheDocument();
    expect(load).toHaveBeenCalledWith("tok");

    fireEvent.contextMenu(within(sidebar).getByTitle("Roadmap"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Unpin" }));
    await waitFor(() => expect(save.mock.calls.at(-1)?.[1].pinned_keys).toEqual([]));
    fireEvent.contextMenu(within(sidebar).getByTitle("Archive target"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Archive" }));
    await waitFor(() => expect(save.mock.calls.at(-1)?.[1].archived_keys).toEqual([
      "websocket:archived", "websocket:regular",
    ]));
    expect(storedState.title_overrides).toEqual({ "websocket:pinned": "Roadmap" });
    expect(storedState.project_names).toEqual({ [workspace]: "Renamed project" });
    const loaded = load.mock.calls.length;
    first.unmount();
    render(<App />);
    await waitFor(() => expect(load.mock.calls.length).toBeGreaterThan(loaded));
    const restored = await screen.findByRole("region", { name: "Sessions" });
    await waitFor(() => expect(within(restored).queryByRole("region", { name: "Pinned" })).not.toBeInTheDocument());
    expect(within(restored).getByTitle("Roadmap")).toBeInTheDocument();
    expect(within(restored).getByRole("region", { name: "Renamed project" })).toBeInTheDocument();
    expect(within(restored).queryByTitle("Archived chat")).not.toBeInTheDocument();
    expect(within(restored).queryByTitle("Archive target")).not.toBeInTheDocument();
    expect(createChatSpy).not.toHaveBeenCalled();
  });

  it.skip("shows running and completed session indicators in the sidebar", async () => {
    mockSessions = [
      {
        key: "websocket:chat-a",
        channel: "websocket",
        chatId: "chat-a",
        createdAt: "2026-04-16T10:00:00Z",
        updatedAt: "2026-04-16T10:00:00Z",
        preview: "Working chat",
      },
      {
        key: "websocket:chat-b",
        channel: "websocket",
        chatId: "chat-b",
        createdAt: "2026-04-16T11:00:00Z",
        updatedAt: "2026-04-16T11:00:00Z",
        preview: "Quiet chat",
      },
    ];

    render(<App />);

    await waitFor(() => expect(connectSpy).toHaveBeenCalled());
    const sidebar = getSessionPanel();
    await waitFor(() =>
      expect(
        within(sidebar).getByTitle("Working chat"),
      ).toBeInTheDocument(),
    );

    act(() => {
      for (const handler of runStatusHandlers) handler("chat-a", 12_345);
    });
    expect(within(sidebar).getByTitle("Agent running")).toBeInTheDocument();

    act(() => {
      for (const handler of runStatusHandlers) handler("chat-a", null);
    });
    expect(within(sidebar).queryByTitle("Agent running")).not.toBeInTheDocument();
    expect(within(sidebar).getByTitle("Agent finished")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(within(sidebar).getByTitle("Working chat"));
    });
    expect(within(sidebar).queryByTitle("Agent finished")).not.toBeInTheDocument();
  });

  it.skip("restores sidebar run indicators after a page reload", async () => {
    mockSessions = [
      {
        key: "websocket:chat-a",
        channel: "websocket",
        chatId: "chat-a",
        createdAt: "2026-04-16T10:00:00Z",
        updatedAt: "2026-04-16T10:00:00Z",
        preview: "Running after reload",
        runStartedAt: 12_345,
      },
      {
        key: "websocket:chat-b",
        channel: "websocket",
        chatId: "chat-b",
        createdAt: "2026-04-16T11:00:00Z",
        updatedAt: "2026-04-16T11:00:00Z",
        preview: "Completed after reload",
      },
    ];
    localStorage.setItem(
      "mona-webui.sidebar.completed-runs.v1",
      JSON.stringify(["chat-b"]),
    );

    render(<App />);

    await waitFor(() => expect(connectSpy).toHaveBeenCalled());
    const sidebar = getSessionPanel();
    await waitFor(() =>
      expect(within(sidebar).getByTitle("Agent running")).toBeInTheDocument(),
    );
    expect(within(sidebar).getByTitle("Agent finished")).toBeInTheDocument();
    expect(attachSpy).toHaveBeenCalledWith("chat-a");
  });

  it.skip("opens the settings view from the sidebar footer", async () => {
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
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes("/api/settings")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              agent: {
                model: "openai/gpt-4o",
                provider: "auto",
                resolved_provider: "openai",
                has_api_key: true,
                model_preset: "default",
                max_tokens: 8192,
                context_window_tokens: 65536,
                temperature: 0.1,
                reasoning_effort: null,
                timezone: "UTC",
                tool_hint_max_length: 40,
              },
              model_presets: [
                {
                  name: "default",
                  label: "Default",
                  active: true,
                  is_default: true,
                  model: "openai/gpt-4o",
                  provider: "auto",
                  max_tokens: 8192,
                  context_window_tokens: 65536,
                  temperature: 0.1,
                  reasoning_effort: null,
                },
                {
                  name: "deep",
                  label: "deep",
                  active: false,
                  is_default: false,
                  model: "anthropic/claude-opus-4-5",
                  provider: "anthropic",
                  max_tokens: 8192,
                  context_window_tokens: 200000,
                  temperature: 0.1,
                  reasoning_effort: "high",
                },
              ],
              providers: [
                {
                  name: "openai",
                  label: "OpenAI",
                  configured: true,
                  api_key_hint: "open••••-key",
                },
                {
                  name: "openrouter",
                  label: "OpenRouter",
                  configured: false,
                  api_key_required: true,
                  default_api_base: "https://openrouter.ai/api/v1",
                },
                {
                  name: "ant_ling",
                  label: "Ant Ling",
                  configured: false,
                  api_key_required: true,
                  default_api_base: "https://api.ant-ling.com/v1",
                },
                {
                  name: "azure_openai",
                  label: "Azure OpenAI",
                  configured: false,
                  api_key_required: true,
                },
                {
                  name: "huggingface",
                  label: "Hugging Face",
                  configured: false,
                  api_key_required: true,
                },
                {
                  name: "siliconflow",
                  label: "SiliconFlow",
                  configured: false,
                  api_key_required: true,
                },
                {
                  name: "volcengine",
                  label: "VolcEngine",
                  configured: false,
                  api_key_required: true,
                },
                {
                  name: "byteplus",
                  label: "BytePlus",
                  configured: false,
                  api_key_required: true,
                },
                {
                  name: "qianfan",
                  label: "Qianfan",
                  configured: false,
                  api_key_required: true,
                },
                {
                  name: "atomic_chat",
                  label: "Atomic Chat",
                  configured: false,
                  api_key_required: false,
                  default_api_base: "http://localhost:1337/v1",
                },
              ],
              web_search: {
                provider: "brave",
                api_key_hint: "BSAo••••ew20",
                base_url: null,
                max_results: 5,
                timeout: 30,
                providers: [
                  { name: "duckduckgo", label: "DuckDuckGo", credential: "none" },
                  { name: "brave", label: "Brave Search", credential: "api_key" },
                  { name: "tavily", label: "Tavily", credential: "api_key" },
                ],
              },
              web: {
                enable: true,
                proxy: null,
                user_agent: null,
                search: { max_results: 5, timeout: 30 },
              },
              image_generation: {
                enabled: false,
                provider: "openrouter",
                provider_configured: true,
                model: "openai/gpt-5.4-image-2",
                default_aspect_ratio: "1:1",
                default_image_size: "1K",
                max_images_per_turn: 4,
                save_dir: "generated",
                providers: [
                  {
                    name: "openrouter",
                    label: "OpenRouter",
                    configured: true,
                    api_key_hint: "sk-o••••test",
                    api_base: "https://openrouter.ai/api/v1",
                    default_api_base: "https://openrouter.ai/api/v1",
                  },
                  {
                    name: "gemini",
                    label: "Gemini",
                    configured: false,
                    api_key_hint: null,
                    api_base: null,
                    default_api_base: "https://generativelanguage.googleapis.com/v1beta/openai/",
                  },
                ],
              },
              runtime: {
                config_path: "/tmp/config.json",
                workspace_path: "/tmp/workspace",
                gateway_host: "127.0.0.1",
                gateway_port: 18790,
                heartbeat: {
                  enabled: true,
                  interval_s: 1800,
                  keep_recent_messages: 8,
                },
                dream: {
                  schedule: "every 2h",
                  max_batch_size: 20,
                  max_iterations: 15,
                  annotate_line_ages: true,
                },
                unified_session: false,
              },
              advanced: {
                restrict_to_workspace: false,
                ssrf_whitelist_count: 0,
                mcp_server_count: 0,
                exec_enabled: true,
                exec_sandbox: null,
                exec_path_append_set: false,
              },
              requires_restart: false,
            }),
          };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      }),
    );

    render(<App />);

    await waitFor(() => expect(connectSpy).toHaveBeenCalled());
    const sidebar = getSessionPanel();
    fireEvent.click(within(sidebar).getByRole("button", { name: "Settings" }));

    expect(document.title).toBe("Settings · mona");
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    const settingsNav = await screen.findByRole("navigation", { name: "Settings sections" });
    expect(settingsNav.className).toContain("overflow-x-auto");
    expect(settingsNav.className).not.toContain("grid-cols-2");
    expect(within(settingsNav).getByRole("button", { name: "General" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(settingsNav).queryByRole("button", { name: "Account" })).not.toBeInTheDocument();
    expect(within(settingsNav).queryByRole("button", { name: "Overview" })).not.toBeInTheDocument();
    expect(within(settingsNav).getByRole("button", { name: "Balance & billing" })).toBeInTheDocument();
    expect(within(settingsNav).getByRole("button", { name: "Usage" })).toBeInTheDocument();
    expect(within(settingsNav).getByRole("button", { name: "Models" })).toBeInTheDocument();
    expect(within(settingsNav).getByRole("button", { name: "Providers" })).toBeInTheDocument();
    expect(within(settingsNav).getByRole("button", { name: "Image" })).toBeInTheDocument();
    expect(within(settingsNav).queryByRole("button", { name: "Web" })).not.toBeInTheDocument();
    expect(within(settingsNav).queryByRole("button", { name: "Runtime" })).not.toBeInTheDocument();
    expect(within(settingsNav).getByRole("button", { name: "Advanced" })).toBeInTheDocument();
    fireEvent.click(within(settingsNav).getByRole("button", { name: "Models" }));
    expect(screen.getByText("AI")).toBeInTheDocument();
    const modelInput = screen.getByDisplayValue("openai/gpt-4o");
    expect(modelInput).toBeInTheDocument();
    fireEvent.change(modelInput, { target: { value: "openai/gpt-4o-mini" } });
    expect(screen.getByText("Unsaved changes.").parentElement?.className).toContain(
      "text-blue-600",
    );
    fireEvent.change(modelInput, { target: { value: "openai/gpt-4o" } });
    fireEvent.click(within(settingsNav).getByRole("button", { name: "Providers" }));
    expect(screen.getByText("OpenRouter")).toBeInTheDocument();
    expect(screen.getByText("Ant Ling")).toBeInTheDocument();
    expect(screen.getAllByText("Not configured").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText("OpenAI"));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByPlaceholderText("Leave blank to keep the current key"), {
      target: { value: "unsaved-openai-key" },
    });
    fireEvent.click(screen.getByText("OpenRouter"));
    fireEvent.click(screen.getByText("OpenAI"));
    expect(screen.getByText("open••••-key")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("unsaved-openai-key")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Ant Ling"));
    expect(screen.getByDisplayValue("https://api.ant-ling.com/v1")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Atomic Chat"));
    expect(screen.getByDisplayValue("http://localhost:1337/v1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();

    fireEvent.click(within(settingsNav).getByRole("button", { name: "Image" }));
    expect(screen.getByRole("heading", { name: "Image" })).toBeInTheDocument();
    expect(screen.getByText("Provider status")).toBeInTheDocument();
    expect(screen.getByDisplayValue("openai/gpt-5.4-image-2")).toBeInTheDocument();
    expect(screen.getByText("Save directory")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    fireEvent.click(within(settingsNav).getByRole("button", { name: "General" }));
    expect(screen.getByText("Search provider")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Brave Search/ })).toBeInTheDocument();
    expect(screen.getByText("BSAo••••ew20")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByPlaceholderText("Leave blank to keep the current key"), {
      target: { value: "unsaved-brave-key" },
    });
    fireEvent.pointerDown(screen.getByRole("button", { name: /Brave Search/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Tavily" }));
    fireEvent.pointerDown(screen.getByRole("button", { name: /Tavily/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Brave Search" }));
    expect(screen.getByText("BSAo••••ew20")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("unsaved-brave-key")).not.toBeInTheDocument();

    expect(screen.getByText("Timezone")).toBeInTheDocument();
    expect(screen.getByText("Workspace path")).toBeInTheDocument();
    expect(screen.queryByText("Bot name")).not.toBeInTheDocument();
    expect(screen.queryByText("Safety")).not.toBeInTheDocument();
    expect(screen.queryByText("Gateway status")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it.skip("returns from settings to the blank start page when no session was active", async () => {
    mockSessions = [
      {
        key: "websocket:chat-a",
        channel: "websocket",
        chatId: "chat-a",
        createdAt: "2026-04-16T10:00:00Z",
        updatedAt: "2026-04-16T10:00:00Z",
        preview: "First chat",
      },
      {
        key: "websocket:chat-b",
        channel: "websocket",
        chatId: "chat-b",
        createdAt: "2026-04-16T11:00:00Z",
        updatedAt: "2026-04-16T11:00:00Z",
        preview: "Second chat",
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes("/api/settings")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              agent: {
                model: "openai/gpt-4o",
                provider: "openai",
                resolved_provider: "openai",
                has_api_key: true,
                model_preset: "default",
                max_tokens: 8192,
                context_window_tokens: 65536,
                temperature: 0.1,
                reasoning_effort: null,
                timezone: "UTC",
                tool_hint_max_length: 40,
              },
              model_presets: [
                {
                  name: "default",
                  label: "Default",
                  active: true,
                  is_default: true,
                  model: "openai/gpt-4o",
                  provider: "openai",
                  max_tokens: 8192,
                  context_window_tokens: 65536,
                  temperature: 0.1,
                  reasoning_effort: null,
                },
              ],
              providers: [{ name: "openai", label: "OpenAI", configured: true }],
              web_search: {
                provider: "duckduckgo",
                api_key_hint: null,
                base_url: null,
                max_results: 5,
                timeout: 30,
                providers: [
                  { name: "duckduckgo", label: "DuckDuckGo", credential: "none" },
                  { name: "brave", label: "Brave Search", credential: "api_key" },
                ],
              },
              web: {
                enable: true,
                proxy: null,
                user_agent: null,
                search: { max_results: 5, timeout: 30 },
              },
              image_generation: {
                enabled: false,
                provider: "openrouter",
                provider_configured: false,
                model: "openai/gpt-5.4-image-2",
                default_aspect_ratio: "1:1",
                default_image_size: "1K",
                max_images_per_turn: 4,
                save_dir: "generated",
                providers: [
                  {
                    name: "openrouter",
                    label: "OpenRouter",
                    configured: false,
                    api_key_hint: null,
                    api_base: null,
                    default_api_base: "https://openrouter.ai/api/v1",
                  },
                ],
              },
              runtime: {
                config_path: "/tmp/config.json",
                workspace_path: "/tmp/workspace",
                gateway_host: "127.0.0.1",
                gateway_port: 18790,
                heartbeat: {
                  enabled: true,
                  interval_s: 1800,
                  keep_recent_messages: 8,
                },
                dream: {
                  schedule: "every 2h",
                  max_batch_size: 20,
                  max_iterations: 15,
                  annotate_line_ages: true,
                },
                unified_session: false,
              },
              advanced: {
                restrict_to_workspace: false,
                ssrf_whitelist_count: 0,
                mcp_server_count: 0,
                exec_enabled: true,
                exec_sandbox: null,
                exec_path_append_set: false,
              },
              requires_restart: false,
            }),
          };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      }),
    );

    render(<App />);

    await waitFor(() => expect(connectSpy).toHaveBeenCalled());
    const sidebar = getSessionPanel();
    fireEvent.click(within(sidebar).getByRole("button", { name: "New chat" }));
    await waitFor(() => expect(document.title).toBe("mona"));

    fireEvent.click(within(sidebar).getByRole("button", { name: "Settings" }));
    const settingsNav = await screen.findByRole("navigation", { name: "Settings sections" });
    expect(within(settingsNav).getByRole("button", { name: "General" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    fireEvent.click(screen.getByRole("button", { name: "Back to chat" }));

    await waitFor(() => expect(document.title).toBe("mona"));
    expect(screen.getByText("What can I do for you?")).toBeInTheDocument();
  });

  it.skip("filters sessions in the centered search dialog", async () => {
    mockSessions = [
      {
        key: "websocket:chat-alpha",
        channel: "websocket",
        chatId: "chat-alpha",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        title: "Q2 roadmap",
        preview: "Project planning notes",
      },
      {
        key: "websocket:chat-beta",
        channel: "websocket",
        chatId: "chat-beta",
        createdAt: "2026-04-15T10:00:00Z",
        updatedAt: "2026-04-15T10:00:00Z",
        preview: "Travel ideas",
      },
    ];

    render(<App />);

    await waitFor(() => expect(connectSpy).toHaveBeenCalled());
    const sidebar = screen.getByRole("navigation");
    expect(within(sidebar).getByText("Q2 roadmap")).toBeInTheDocument();
    expect(within(sidebar).getByText("Travel ideas")).toBeInTheDocument();
    const newChatButton = within(sidebar).getByRole("button", { name: "New chat" });
    const searchButton = within(sidebar).getByRole("button", { name: "Search" });
    expect(
      newChatButton.compareDocumentPosition(searchButton) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    fireEvent.click(searchButton);
    const dialog = await screen.findByRole("dialog", { name: "Search" });
    expect(dialog).toHaveClass("origin-center");
    expect(dialog.className).not.toContain("translate-x");
    expect(dialog.className).not.toContain("translate-y");
    expect(within(dialog).getByText("Q2 roadmap")).toBeInTheDocument();
    expect(within(dialog).getByText("Travel ideas")).toBeInTheDocument();
    expect(within(dialog).queryByText("websocket")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("#1")).not.toBeInTheDocument();

    fireEvent.change(within(dialog).getByRole("textbox", { name: "Search" }), {
      target: { value: "planning" },
    });

    expect(within(dialog).getByText("Q2 roadmap")).toBeInTheDocument();
    expect(within(dialog).queryByText("Travel ideas")).not.toBeInTheDocument();
    expect(within(sidebar).getByText("Travel ideas")).toBeInTheDocument();

    fireEvent.change(within(dialog).getByRole("textbox", { name: "Search" }), {
      target: { value: "road q2" },
    });

    expect(within(dialog).getByText("Q2 roadmap")).toBeInTheDocument();
    expect(within(dialog).queryByText("Travel ideas")).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: /Q2 roadmap/ }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Search" })).not.toBeInTheDocument(),
    );
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

  it.skip("keeps large sidebars light while search still covers every chat", async () => {
    mockSessions = Array.from({ length: 170 }, (_, index) => {
      const chatId = `chat-${index}`;
      return {
        key: `websocket:${chatId}`,
        channel: "websocket" as const,
        chatId,
        createdAt: new Date(Date.UTC(2026, 3, 16, 12, 0 - index)).toISOString(),
        updatedAt: new Date(Date.UTC(2026, 3, 16, 12, 0 - index)).toISOString(),
        title: index === 169 ? "Hidden target" : `Bulk chat ${index}`,
        preview: "",
      };
    });

    render(<App />);

    await waitFor(() => expect(connectSpy).toHaveBeenCalled());
    const sidebar = screen.getByRole("navigation");
    await waitFor(() =>
      expect(within(sidebar).getByTitle("Bulk chat 0")).toBeInTheDocument(),
    );
    expect(within(sidebar).queryByText("Hidden target")).not.toBeInTheDocument();
    expect(within(sidebar).getByRole("button", { name: "Show 10 more" })).toBeInTheDocument();

    fireEvent.click(within(sidebar).getByRole("button", { name: "Search" }));
    const dialog = await screen.findByRole("dialog", { name: "Search" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Search" }), {
      target: { value: "hidden" },
    });
    expect(within(dialog).getByText("Hidden target")).toBeInTheDocument();
  });

  it.skip("opens a blank start page without creating an empty chat", async () => {
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

    const matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes("768px"),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    vi.stubGlobal("matchMedia", matchMedia);

    const { container } = render(<App />);

    await waitFor(() => expect(connectSpy).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "Toggle theme from header" }));
    expect(toggleThemeSpy).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    const desktopAside = container.querySelector("aside.lg\\:block") as HTMLElement;
    await waitFor(() => expect(desktopAside.style.width).toBe("56px"));

    expect(screen.queryByRole("button", { name: "Start a new chat" })).not.toBeInTheDocument();
    const rail = screen.getByRole("navigation");
    expect(within(rail).getByRole("button", { name: "New chat" })).toBeInTheDocument();
    expect(within(rail).getByRole("button", { name: "Search" })).toBeInTheDocument();
    expect(within(rail).getByRole("button", { name: "View" })).toBeInTheDocument();
    expect(within(rail).queryByText("Existing chat")).not.toBeInTheDocument();

    fireEvent.click(within(rail).getByRole("button", { name: "Toggle sidebar" }));
    await waitFor(() => expect(desktopAside.style.width).toBe("272px"));

    const sidebar = getSessionPanel();
    fireEvent.click(within(sidebar).getByRole("button", { name: "New chat" }));
    expect(createChatSpy).not.toHaveBeenCalled();
    expect(screen.getByText("What can I do for you?")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start a new chat" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Toggle theme from header" })).toBeInTheDocument();
    expect(within(sidebar).getByRole("button", { name: "Settings" })).toBeInTheDocument();

    expect(within(sidebar).getByText("Existing chat")).toBeInTheDocument();
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
