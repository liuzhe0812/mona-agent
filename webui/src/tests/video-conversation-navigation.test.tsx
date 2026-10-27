import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatSummary } from "@/lib/types";

const harness = vi.hoisted(() => ({
  listSessions: vi.fn(),
  fetchSidebarState: vi.fn(),
  updateSidebarState: vi.fn(),
  sessions: [] as any[],
  persistedSidebarStates: [] as any[],
  projectOwnerChatIds: [] as string[],
}));

vi.mock("@/lib/bootstrap", () => ({
  fetchBootstrap: vi.fn(async () => ({ token: "test-token", ws_path: "/" })),
  deriveWsUrl: vi.fn(async () => "ws://test"),
  loadSavedSecret: vi.fn(() => ""),
  saveSecret: vi.fn(),
  clearSavedSecret: vi.fn(),
  resetGatewayBaseUrl: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    listSessions: harness.listSessions,
    fetchSidebarState: harness.fetchSidebarState,
    updateSidebarState: harness.updateSidebarState,
  };
});

vi.mock("@/lib/native-provider-bootstrap", () => ({
  warmNativeProviderConnections: vi.fn(async () => undefined),
}));

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return { ...actual, isTauri: () => false, getServicesStatus: vi.fn(async () => ({ running: true, port: 17174 })) };
});

vi.mock("@/hooks/useTheme", async () => {
  const ReactModule = await import("react");
  return {
    ThemeProvider: ({ children }: { children: React.ReactNode }) =>
      ReactModule.createElement(ReactModule.Fragment, null, children),
    useTheme: () => ({ theme: "light" as const, toggle: vi.fn() }),
    useThemeValue: () => "light" as const,
  };
});

vi.mock("@/hooks/useLicense", async () => {
  const ReactModule = await import("react");
  return {
    LicenseProvider: ({ children }: { children: React.ReactNode }) =>
      ReactModule.createElement(ReactModule.Fragment, null, children),
    useLicense: () => ({
      licenseActive: true,
      loggedIn: true,
      pricingConfig: null,
      licenseInfo: { account: "test" },
      refreshLicense: vi.fn(),
    }),
  };
});

vi.mock("@/hooks/useCloudUpdates", () => ({ useCloudUpdates: () => undefined }));
vi.mock("@/hooks/useDesktopPreferenceUpdates", () => ({
  useDesktopPreferenceUpdates: () => undefined,
}));
vi.mock("@/components/room/useAgents", () => ({
  invalidateAgents: vi.fn(),
  useAgents: () => new Map(),
}));
vi.mock("@/components/StartupScene", () => ({ StartupScene: () => null }));
vi.mock("@/components/UpdateNotification", () => ({ UpdateNotification: () => null }));
vi.mock("@/components/terminal/VncViewer", () => ({ VncViewer: () => null }));

vi.mock("@/components/shell/SessionListPanel", async () => {
  const ReactModule = await import("react");
  return {
    SessionListPanel: (props: any) => {
      harness.sessions = props.sessions;
      const videoSession = props.sessions.find((session: ChatSummary) => session.agentKind === "video");
      const chatSession = props.sessions.find((session: ChatSummary) => session.agentKind !== "video");
      return ReactModule.createElement(
        "section",
        { "aria-label": "Sessions", "data-testid": "session-list-panel" },
        ReactModule.createElement(
          "button",
          {
            type: "button",
            "data-testid": "select-video-session",
            onClick: () => videoSession && props.onSelect(videoSession.key),
          },
          "Select video conversation",
        ),
        ReactModule.createElement(
          "button",
          {
            type: "button",
            "data-testid": "select-chat-session",
            onClick: () => chatSession && props.onSelect(chatSession.key),
          },
          "Select regular chat",
        ),
        ReactModule.createElement(
          "output",
          { "data-testid": "session-unread-keys" },
          JSON.stringify(props.unreadKeys ?? []),
        ),
      );
    },
  };
});

vi.mock("@/components/doc/DocMakerView", async () => {
  const ReactModule = await import("react");
  return {
    DocMakerView: (props: any) => {
      const [visibleChatId, setVisibleChatId] = ReactModule.useState<string | null>(null);
      ReactModule.useEffect(() => {
        props.onVideoChatsChange?.(harness.projectOwnerChatIds);
      }, [props.onVideoChatsChange]);
      ReactModule.useEffect(() => {
        if (!props.visible) {
          setVisibleChatId(null);
          props.onVisibleConversationChange?.(null);
        }
      }, [props.visible, props.onVisibleConversationChange]);

      return ReactModule.createElement(
        "section",
        {
          "data-testid": "doc-maker-view",
          "data-visible": String(props.visible),
          "data-request-chat-id": props.videoConversationRequest?.chatId ?? "",
          "data-request-id": props.videoConversationRequest?.requestId ?? "",
          "data-visible-chat-id": visibleChatId ?? "",
          "data-regular-agent-kind": String(props.sessionAgentKinds?.["regular-chat-1"]),
        },
        ReactModule.createElement(
          "button",
          {
            type: "button",
            "data-testid": "doc-report-visible-conversation",
            onClick: () => {
              const chatId = props.videoConversationRequest?.chatId ?? null;
              setVisibleChatId(chatId);
              props.onVisibleConversationChange?.(chatId);
            },
          },
          "Report visible conversation",
        ),
        ReactModule.createElement(
          "button",
          {
            type: "button",
            "data-testid": "doc-clear-visible-conversation",
            onClick: () => {
              setVisibleChatId(null);
              props.onVisibleConversationChange?.(null);
            },
          },
          "Clear visible conversation",
        ),
      );
    },
  };
});

vi.mock("@/components/thread/ThreadShell", async () => {
  const ReactModule = await import("react");
  return {
    ThreadShell: (props: any) =>
      ReactModule.createElement("div", {
        "data-testid": "thread-shell",
        "data-chat-id": props.session?.chatId ?? "",
      }),
  };
});

import App from "@/App";
import { MonaClient } from "@/lib/mona-client";
import { DEFAULT_SIDEBAR_STATE } from "@/hooks/useSidebarState";

const VIDEO_PREVIEW_AT = "2026-10-15T12:00:00.000Z";
const CHAT_PREVIEW_AT = "2026-10-15T11:00:00.000Z";

function makeSessions(): ChatSummary[] {
  return [
    {
      key: "websocket:video-project-1",
      channel: "websocket",
      chatId: "video-project-1",
      agentKind: "video",
      createdAt: "2026-10-15T10:00:00.000Z",
      updatedAt: VIDEO_PREVIEW_AT,
      title: "Video project",
      preview: "Latest video update",
      previewAt: VIDEO_PREVIEW_AT,
      previewAuthorType: "agent",
    },
    {
      key: "websocket:regular-chat-1",
      channel: "websocket",
      chatId: "regular-chat-1",
      createdAt: "2026-10-15T09:00:00.000Z",
      updatedAt: CHAT_PREVIEW_AT,
      title: "Regular chat",
      preview: "A saved reply",
      previewAt: CHAT_PREVIEW_AT,
      previewAuthorType: "agent",
    },
  ];
}

function makeSidebarState(sessions: ChatSummary[]) {
  const regular = sessions.find((session) => session.agentKind !== "video")!;
  return {
    ...DEFAULT_SIDEBAR_STATE,
    last_read_at_by_key: { [regular.key]: regular.previewAt! },
  };
}

function messageBadge(): string | null {
  const messagesButton = screen.getByRole("button", { name: "Sessions" });
  return messagesButton.querySelector("span.absolute")?.textContent?.trim() ?? null;
}

async function renderReadyApp() {
  render(<App />);
  await waitFor(() => {
    expect(harness.listSessions).toHaveBeenCalled();
    expect(harness.fetchSidebarState).toHaveBeenCalled();
    expect(screen.getByTestId("session-list-panel")).toBeInTheDocument();
  });
}

describe("video conversation navigation and read state", () => {
  let connectSpy: ReturnType<typeof vi.spyOn>;
  const originalVisibilityDescriptor = Object.getOwnPropertyDescriptor(document, "visibilityState");

  beforeEach(() => {
    const sessions = makeSessions();
    harness.sessions = sessions;
    harness.persistedSidebarStates = [];
    harness.projectOwnerChatIds = [];
    harness.listSessions.mockReset().mockResolvedValue(sessions);
    harness.fetchSidebarState.mockReset().mockResolvedValue(makeSidebarState(sessions));
    harness.updateSidebarState.mockReset().mockImplementation(async (_token: string, state: any) => {
      const persisted = JSON.parse(JSON.stringify(state));
      harness.persistedSidebarStates.push(persisted);
      return persisted;
    });

    localStorage.removeItem("mona-webui.sidebar.completed-runs.v1");
    localStorage.removeItem("mona-webui.sidebar");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    connectSpy = vi.spyOn(MonaClient.prototype, "connect").mockImplementation(() => undefined);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (originalVisibilityDescriptor) {
      Object.defineProperty(document, "visibilityState", originalVisibilityDescriptor);
    }
  });

  it("routes video sessions to DocMaker and keeps regular chats in ThreadShell", async () => {
    await renderReadyApp();
    expect(connectSpy).toHaveBeenCalledTimes(1);
    expect(harness.sessions.find((session: ChatSummary) => session.chatId === "video-project-1")?.agentKind).toBe("video");

    fireEvent.click(screen.getByTestId("select-video-session"));

    const docView = await screen.findByTestId("doc-maker-view");
    await waitFor(() => expect(docView).toHaveAttribute("data-visible", "true"));
    expect(docView).toHaveAttribute("data-request-chat-id", "video-project-1");
    expect(docView).toHaveAttribute("data-request-id", "1");
    expect(screen.getByTestId("thread-shell").parentElement).toHaveClass("hidden");

    fireEvent.click(screen.getByRole("button", { name: "Sessions" }));
    await screen.findByTestId("session-list-panel");
    fireEvent.click(screen.getByTestId("select-chat-session"));

    await waitFor(() => expect(screen.getByTestId("thread-shell")).toHaveAttribute("data-chat-id", "regular-chat-1"));
    expect(screen.getByTestId("thread-shell").parentElement).not.toHaveClass("hidden");
    expect(docView).toHaveAttribute("data-visible", "false");
    expect(docView).toHaveAttribute("data-request-chat-id", "");
  });

  it.each([null, undefined])("keeps a regular video owner in ThreadShell when its saved kind is %s", async (agentKind) => {
    const sessions = makeSessions();
    sessions[1].agentKind = agentKind;
    harness.listSessions.mockResolvedValue(sessions);
    harness.projectOwnerChatIds = ["regular-chat-1"];
    localStorage.setItem("mona.ai-docs.workspace.v1", JSON.stringify([{
      id: "video:普通聊天视频", kind: "video-workflow", chatId: "regular-chat-1",
      project: { name: "普通聊天视频", phase: "done", chatId: "regular-chat-1" },
    }]));
    await renderReadyApp();
    await screen.findByTestId("doc-maker-view");
    expect(harness.sessions.find((session: ChatSummary) => session.chatId === "regular-chat-1")?.agentKind).not.toBe("video");
    fireEvent.click(screen.getByTestId("select-chat-session"));
    await waitFor(() => expect(screen.getByTestId("thread-shell")).toHaveAttribute("data-chat-id", "regular-chat-1"));
    expect(screen.getByTestId("thread-shell").parentElement).not.toHaveClass("hidden");
    expect(screen.getByTestId("doc-maker-view")).toHaveAttribute("data-visible", "false");
    expect(screen.getByTestId("doc-maker-view")).toHaveAttribute("data-request-chat-id", "");
    expect(screen.getByTestId("doc-maker-view")).toHaveAttribute("data-regular-agent-kind", "null");
  });

  it("marks the visible DocMaker conversation read and retains its marker when cleared or hidden", async () => {
    await renderReadyApp();
    await waitFor(() => expect(messageBadge()).toBe("1"));

    fireEvent.click(screen.getByTestId("select-video-session"));
    const docView = await screen.findByTestId("doc-maker-view");
    await waitFor(() => expect(docView).toHaveAttribute("data-visible", "true"));

    fireEvent.click(screen.getByTestId("doc-report-visible-conversation"));
    await waitFor(() => {
      expect(harness.persistedSidebarStates.some(
        (state: any) => state.last_read_at_by_key["websocket:video-project-1"] === VIDEO_PREVIEW_AT,
      )).toBe(true);
      expect(messageBadge()).toBeNull();
    });
    const writesAfterRead = harness.persistedSidebarStates.length;

    fireEvent.click(screen.getByTestId("doc-clear-visible-conversation"));
    await waitFor(() => expect(docView).toHaveAttribute("data-visible-chat-id", ""));
    expect(harness.persistedSidebarStates).toHaveLength(writesAfterRead);

    fireEvent.click(screen.getByRole("button", { name: "Sessions" }));
    await waitFor(() => expect(docView).toHaveAttribute("data-visible", "false"));
    await screen.findByTestId("session-list-panel");

    expect(harness.persistedSidebarStates).toHaveLength(writesAfterRead);
    expect(harness.persistedSidebarStates.at(-1).last_read_at_by_key["websocket:video-project-1"]).toBe(VIDEO_PREVIEW_AT);
    expect(screen.getByTestId("session-unread-keys")).toHaveTextContent("[]");
    expect(messageBadge()).toBeNull();
  });
});
