import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { AIChat } from "./AIChat";
import { useTerminalStore } from "../store/terminalStore";
import * as api from "@/lib/api";
import { developmentApi, type DevExecutor } from "@/lib/development-api";
import type { MonaClient } from "@/lib/mona-client";
import type { SettingsPayload } from "@/lib/types";
import { ClientProvider } from "@/providers/ClientProvider";

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  setMessages: vi.fn(),
  streaming: false,
}));

vi.mock("@/hooks/useSessions", () => ({
  useSessionHistory: () => ({ messages: [], loading: false, hasPendingToolCalls: false, version: 0 }),
}));
vi.mock("@/hooks/useMonaStream", () => ({
  useMonaStream: () => ({
    messages: [], isStreaming: mocks.streaming, stopping: false,
    send: mocks.send, inject: vi.fn(), stop: vi.fn(), setMessages: mocks.setMessages,
  }),
}));
vi.mock("@/components/thread/ThreadMessages", () => ({ ThreadMessages: () => null }));

afterEach(() => {
  vi.restoreAllMocks();
  mocks.send.mockReset();
  mocks.setMessages.mockReset();
  mocks.streaming = false;
});

it("switches the Work engine from a restored terminal chat and preserves terminal context", async () => {
  let settings = {
    agent: { model: "shared-model", provider: "example", executor: "mona", native_model: null },
    model_presets: [],
    chat_providers: [{
      name: "example", label: "Example API", configured: true,
      models: [{ id: "shared-model", name: "API Shared", enabled: true }],
    }],
  } as SettingsPayload;
  const codex: DevExecutor = {
    id: "codex", name: "Codex", available: true, reason: "已连接",
    probe: { state: "ready", authentication: "ready", reason: "已连接" },
    models: [{ id: "codex-model", label: "原生 Codex", reasoningEfforts: ["low", "high"], reasoningEffort: "high" }],
  };
  vi.spyOn(api, "fetchSettings").mockImplementation(async () => settings);
  vi.spyOn(developmentApi, "providerExecutors").mockResolvedValue({ executors: [codex] });
  const select = vi.spyOn(developmentApi, "selectWorkModelSource").mockImplementation(async (body) => {
    settings = {
      ...settings,
      agent: { ...settings.agent, executor: body.executor, native_model: body.model, native_reasoning_effort: body.effort ?? null },
    };
    return settings;
  });
  const newChat = vi.fn();
  const client = {
    newChat,
    isChatDeleted: () => false,
    onSessionDeleted: () => () => {},
    onDocUploadResult: () => () => {},
  } as unknown as MonaClient;
  const onOpenSettings = vi.fn();
  useTerminalStore.setState({
    sessions: [{ id: "ssh-session", configId: "config-1", type: "ssh", status: "connected", title: "host" }],
    aiChatIds: { "ssh-session": "restored-chat" },
  });
  const view = () => <ClientProvider client={client} token="token" modelName="API Shared" runtimeStatus="ready">
    <AIChat sessionId="ssh-session" onOpenSettings={onOpenSettings} />
  </ClientProvider>;
  const rendered = render(view());

  fireEvent.pointerDown(await screen.findByRole("button", { name: "API Shared" }), { button: 0, ctrlKey: false });
  fireEvent.click(await screen.findByRole("menuitem", { name: "OpenAI · 原生 Codex" }));
  await waitFor(() => expect(select).toHaveBeenCalledWith({ executor: "codex", model: "codex-model", effort: "high" }));
  expect(await screen.findByRole("button", { name: "原生 Codex" })).toBeInTheDocument();
  expect(newChat).not.toHaveBeenCalled();

  const input = screen.getByRole("textbox", { name: "Message input" });
  fireEvent.change(input, { target: { value: "检查文件" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(mocks.send).toHaveBeenCalledWith(
    expect.stringContaining("检查文件"), undefined,
    expect.objectContaining({ terminalSessionId: "ssh-session", displayContent: "检查文件" }),
  ));

  fireEvent.pointerDown(screen.getByRole("button", { name: "原生 Codex" }), { button: 0, ctrlKey: false });
  fireEvent.click(await screen.findByRole("button", { name: "添加模型" }));
  expect(onOpenSettings).toHaveBeenCalledWith("models_providers");

  mocks.streaming = true;
  rendered.rerender(view());
  expect(screen.getByRole("button", { name: "原生 Codex" })).toBeDisabled();
});
