import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MonaClient } from "@/lib/mona-client";
import type { ChatSummary } from "@/lib/types";
import { getHostedPlatform } from "@/lib/hosted-platform";
import * as hostedPlatform from "@/lib/hosted-platform";
import { useFilePreviewStore } from "@/components/deliver/filePreviewStore";
import { useOfficeSessionStore } from "@/components/office/office-session-store";
import { WorkApp } from "./WorkApp";

const fixtures = vi.hoisted(() => ({ clients: [] as MonaClient[], thread: vi.fn(), createHostedClient: vi.fn(),
  sessions: new Map<string, ChatSummary[]>(), createChat: vi.fn() }));
vi.mock("./runtime", async original => ({ ...await original<typeof import("./runtime")>(),
  createHostedClient: fixtures.createHostedClient }));
vi.mock("@/components/thread/ThreadShell", async () => {
  const { useContext } = await import("react");
  const { useClient } = await import("@/providers/ClientProvider");
  const { ConversationFileContext } = await import("@/components/deliver/ConversationFileContext");
  return { ThreadShell: (props: { title: string; session: unknown }) => {
    const { client } = useClient();
    const fileAccess = useContext(ConversationFileContext);
    fixtures.thread({ ...props, client, fileAccess });
    return <section data-testid="shared-thread-shell">{props.title}</section>;
  } };
});
vi.mock("@/components/ChatList", () => ({ ChatList: (props: { sessions: Array<{ title: string }> }) =>
  <div data-testid="shared-chat-list">{props.sessions.map(item => item.title).join(",")}</div> }));
vi.mock("@/hooks/useSessions", async original => {
  const actual = await original<typeof import("@/hooks/useSessions")>();
  const { useClientOptional } = await import("@/providers/ClientProvider");
  return { ...actual, useSessions: () => {
    const { token } = useClientOptional();
    return { sessions: fixtures.sessions.get(token) ?? [{ key: `websocket:${token}`, chatId: token, title: token === "synthetic-A" ? "A的会话" : "B的会话",
      channel: "websocket", createdAt: null, updatedAt: null, preview: "" }], loading: false, loaded: true,
      error: null, refresh: vi.fn(), createChat: fixtures.createChat, branchChat: vi.fn(), deleteChat: vi.fn() };
  } };
});
vi.mock("@/hooks/useSidebarState", async original => {
  const actual = await original<typeof import("@/hooks/useSidebarState")>();
  return { ...actual, useSidebarState: () => ({ state: actual.DEFAULT_SIDEBAR_STATE, update: vi.fn(), loading: false }) };
});

const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "Content-Type": "application/json" },
});
function saveAccount(token: string) {
  sessionStorage.setItem("mona-website-session-v1", JSON.stringify({ token, user: { id: token } }));
  sessionStorage.setItem("mona-hosted-work-v1", JSON.stringify({ token, selected: token }));
}

beforeEach(() => {
  vi.clearAllMocks(); sessionStorage.clear(); fixtures.clients.length = 0; fixtures.sessions.clear();
  fixtures.createHostedClient.mockImplementation(async () => {
    const client = new MonaClient({ url: "ws://localhost/fixture" });
    vi.spyOn(client, "connect").mockImplementation(() => undefined);
    vi.spyOn(client, "onStatus").mockImplementation(handler => { handler("open"); return () => undefined; });
    vi.spyOn(client, "sendMessage");
    vi.spyOn(client, "close"); fixtures.clients.push(client);
    return client;
  });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ message: "已退出" })));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("hosted desktop conversation composition", () => {
  it("downloads workspace links with the current account and session", async () => {
    const download = vi.spyOn(hostedPlatform, "downloadHostedFile").mockResolvedValue(undefined);
    saveAccount("synthetic-A"); render(<WorkApp />);
    await screen.findByTestId("shared-thread-shell");
    const access = fixtures.thread.mock.lastCall?.[0].fileAccess;
    expect(access.sessionKey).toBe("websocket:synthetic-A");
    await access.download("deck.pptx");
    await access.download("/workspace/slides/deck.pptx");
    expect(download).toHaveBeenNthCalledWith(1, { path: "deck.pptx", name: "deck.pptx" }, "shared", "websocket:synthetic-A");
    expect(download).toHaveBeenNthCalledWith(2, { path: "slides/deck.pptx", name: "deck.pptx" }, "shared", "websocket:synthetic-A");
    await expect(access.download("../other.pptx")).rejects.toThrow();
    await expect(access.download("/outside/other.pptx")).rejects.toThrow();
    expect(download).toHaveBeenCalledTimes(2);
    await act(async () => { saveAccount("synthetic-B"); window.dispatchEvent(new Event("mona-account-changed")); });
    await waitFor(() => expect(getHostedPlatform()?.token).toBe("synthetic-B"));
    await expect(access.download("deck.pptx")).rejects.toThrow();
    expect(download).toHaveBeenCalledTimes(2);
  });

  it("mounts the existing ThreadShell and ChatList under a real MonaClient", async () => {
    saveAccount("synthetic-A");
    const view = render(<WorkApp />);
    expect(await screen.findByTestId("shared-thread-shell")).toHaveTextContent("A的会话");
    expect(screen.getByTestId("shared-chat-list")).toHaveTextContent("A的会话");
    expect(screen.getByRole("link", { name: "返回官网" })).toHaveAttribute("href", "/");
    expect(fixtures.thread.mock.lastCall?.[0].client).toBeInstanceOf(MonaClient);
    expect(getHostedPlatform()?.token).toBe("synthetic-A");
    expect(screen.queryByRole("button", { name: "退出登录" })).not.toBeInTheDocument();
    view.unmount();
    expect(fixtures.clients[0].close).toHaveBeenCalledOnce();
    expect(getHostedPlatform()).toBeNull();
  });

  it("selects an existing session or creates one real empty chat once without sending a model request", async () => {
    saveAccount("synthetic-A");
    sessionStorage.setItem("mona-hosted-work-v1", JSON.stringify({ token: "synthetic-A", selected: "removed" }));
    const existing = render(<WorkApp />);
    await waitFor(() => expect(fixtures.thread.mock.lastCall?.[0].session?.chatId).toBe("synthetic-A"));
    expect(fixtures.createChat).not.toHaveBeenCalled();
    existing.unmount();

    const id = "a".repeat(32);
    fixtures.sessions.set("synthetic-A", []);
    fixtures.createChat.mockImplementationOnce(async () => {
      fixtures.sessions.set("synthetic-A", [{ key: `websocket:${id}`, chatId: id, title: "",
        channel: "websocket", createdAt: null, updatedAt: null, preview: "" }]);
      return id;
    });
    const view = render(<WorkApp />);
    await waitFor(() => expect(fixtures.thread.mock.lastCall?.[0].session?.chatId).toBe(id));
    expect(JSON.parse(sessionStorage.getItem("mona-hosted-work-v1")!).selected).toBe(id);
    view.rerender(<WorkApp />);
    await act(async () => { window.dispatchEvent(new Event("pageshow")); });
    expect(fixtures.createChat).toHaveBeenCalledOnce();
    expect(fixtures.clients.every(client => vi.mocked(client.sendMessage).mock.calls.length === 0)).toBe(true);
  });

  it("does not activate an old account's empty chat after the account changes", async () => {
    fixtures.sessions.set("synthetic-A", []);
    let finishCreate!: (value: string) => void;
    fixtures.createChat.mockImplementationOnce(() => new Promise<string>(resolve => { finishCreate = resolve; }));
    saveAccount("synthetic-A"); render(<WorkApp />);
    await waitFor(() => expect(fixtures.createChat).toHaveBeenCalledOnce());
    expect(screen.queryByTestId("shared-thread-shell")).not.toBeInTheDocument();
    expect(screen.getByText("正在打开会话…")).toBeInTheDocument();
    await act(async () => {
      saveAccount("synthetic-B"); window.dispatchEvent(new Event("mona-account-changed"));
    });
    await waitFor(() => expect(fixtures.thread.mock.lastCall?.[0].session?.chatId).toBe("synthetic-B"));
    await act(async () => { finishCreate("a".repeat(32)); });
    expect(JSON.parse(sessionStorage.getItem("mona-hosted-work-v1")!)).toMatchObject({ token: "synthetic-B", selected: "synthetic-B" });
    expect(fixtures.thread.mock.lastCall?.[0].session?.chatId).toBe("synthetic-B");
  });

  it("clears private mirrors when the website switches accounts", async () => {
    saveAccount("synthetic-A"); render(<WorkApp />);
    await screen.findByTestId("shared-thread-shell");
    sessionStorage.setItem("mona.office.sessions.v1:websocket:old", "private-office-filename");
    useFilePreviewStore.setState({ file: {
      name: "A私有文件.txt", path: "A私有文件.txt", absolute_path: "/workspace/A私有文件.txt",
      size: 1, size_human: "1 B", mime: "text/plain",
    } });
    useOfficeSessionStore.setState({ sessions: { old: { displayName: "A私有文档" } as never } });
    await act(async () => {
      saveAccount("synthetic-B"); window.dispatchEvent(new Event("mona-account-changed"));
    });
    await waitFor(() => expect(getHostedPlatform()?.token).toBe("synthetic-B"));
    expect(screen.getByTestId("shared-chat-list")).toHaveTextContent("B的会话");
    expect(screen.getByTestId("shared-chat-list")).not.toHaveTextContent("A的会话");
    expect(useFilePreviewStore.getState().file).toBeNull();
    expect(useOfficeSessionStore.getState().sessions).toEqual({});
    expect(sessionStorage.getItem("mona.office.sessions.v1:websocket:old")).toBeNull();
    expect(getHostedPlatform()?.token).toBe("synthetic-B");
    expect(JSON.parse(sessionStorage.getItem("mona-hosted-work-v1")!).token).toBe("synthetic-B");
  });

  it("keeps website account login independent of desktop modules or API secrets", () => {
    render(<WorkApp />);
    expect(screen.getByLabelText("账号")).toBeInTheDocument();
    expect(screen.getByLabelText("密码")).toBeInTheDocument();
    expect(screen.queryByLabelText(/API Key/i)).not.toBeInTheDocument();
    expect(getHostedPlatform()).toBeNull();
  });
});
