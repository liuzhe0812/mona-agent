import { act, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { buildSharedOutputDir, ThreadShell } from "@/components/thread/ThreadShell";
import { ClientProvider } from "@/providers/ClientProvider";

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

describe("baseline", () => {
  it("keeps dotted Agent IDs in the shared output root", () => {
    expect(buildSharedOutputDir("C:\\work", "com.example.agent")).toBe(
      "C:/work/agent-workspaces/com.example.agent/output",
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

    artifactFiles = [fileA, fileB];
    await act(async () => {
      client._emitArtifactsChanged();
    });

    console.log("artifactFetches after emit:", artifactFetches);
    const panel = document.body.textContent ?? "";
    console.log("has a.png:", panel.includes("a.png"), "has b.png:", panel.includes("b.png"));
    console.log("panel snippet:", panel.slice(0, 3000));

    await screen.findByText("b.png");
    expect(artifactFetches).toBe(2);
  });
});
