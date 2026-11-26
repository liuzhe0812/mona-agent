import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { DocChatPanel } from "./DocChatPanel";
import { ThreadComposer } from "@/components/thread/ThreadComposer";
import { useWorkModelSelection } from "@/components/models/useWorkModelSelection";
import * as api from "@/lib/api";
import { developmentApi, type DevExecutor } from "@/lib/development-api";
import type { SettingsPayload } from "@/lib/types";
import { ClientProvider } from "@/providers/ClientProvider";

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  setMessages: vi.fn(),
  historical: [],
}));

vi.mock("@/hooks/useSessions", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/hooks/useSessions")>(),
  useSessionHistory: () => ({ messages: mocks.historical, loading: false, error: null, hasPendingToolCalls: false, version: 0 }),
}));
vi.mock("@/hooks/useMonaStream", () => ({
  useMonaStream: () => ({
    messages: [], isStreaming: false, isAwaitingModelResponse: false, stopping: false,
    send: mocks.send, setMessages: mocks.setMessages, messageRejection: null,
  }),
}));
vi.mock("@/components/thread/ThreadMessages", () => ({ ThreadMessages: () => null }));
vi.mock("@/components/thread/UserQuestionPanel", () => ({ UserQuestionPanel: () => null }));

function OrdinaryComposer() {
  const model = useWorkModelSelection({ token: "token", modelName: "API Shared" });
  return <ThreadComposer onSend={vi.fn()} modelLabel={model.modelLabel} modelOptions={model.modelOptions} onModelSelect={model.selectModel} />;
}

afterEach(() => {
  vi.restoreAllMocks();
  mocks.send.mockReset();
  mocks.setMessages.mockReset();
});

it("switches the document and ordinary Work model together without changing video selection", async () => {
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
      agent: body.executor === "mona"
        ? { ...settings.agent, executor: "mona", provider: body.provider!, model: body.model }
        : { ...settings.agent, executor: body.executor, native_model: body.model, native_reasoning_effort: body.effort ?? null },
    };
    return settings;
  });
  const onOpenSettings = vi.fn();
  const onModelNameChange = vi.fn();

  render(<ClientProvider client={null} token="token" modelName="API Shared" runtimeStatus="ready">
    <div data-testid="work"><OrdinaryComposer /></div>
    <div data-testid="document"><DocChatPanel chatId="office-chat" showWorkModelSelector onOpenSettings={onOpenSettings} onModelNameChange={onModelNameChange} getSendOptions={() => ({ officeSessionId: "office-session" })} /></div>
    <div data-testid="video"><DocChatPanel chatId="video-chat" getSendOptions={() => ({ agentKind: "video" })} /></div>
  </ClientProvider>);

  const work = within(screen.getByTestId("work"));
  const documentPanel = within(screen.getByTestId("document"));
  const video = within(screen.getByTestId("video"));
  fireEvent.pointerDown(await documentPanel.findByRole("button", { name: "API Shared" }), { button: 0, ctrlKey: false });
  fireEvent.click(await screen.findByRole("menuitem", { name: "OpenAI · 原生 Codex" }));
  await waitFor(() => expect(select).toHaveBeenCalledWith({ executor: "codex", model: "codex-model", effort: "high" }));
  expect(onModelNameChange).toHaveBeenCalledWith("codex-model");
  expect(await documentPanel.findByRole("button", { name: "原生 Codex" })).toBeInTheDocument();
  expect(await work.findByRole("button", { name: "原生 Codex" })).toBeInTheDocument();
  expect(video.queryByRole("button", { name: "原生 Codex" })).not.toBeInTheDocument();

  fireEvent.change(documentPanel.getByRole("textbox", { name: "Message input" }), { target: { value: "读取这一页" } });
  fireEvent.keyDown(documentPanel.getByRole("textbox", { name: "Message input" }), { key: "Enter" });
  await waitFor(() => expect(mocks.send).toHaveBeenCalledWith("读取这一页", undefined, expect.objectContaining({ officeSessionId: "office-session" })));
  expect(mocks.send.mock.calls[0][2]).not.toHaveProperty("modelBinding");

  fireEvent.pointerDown(work.getByRole("button", { name: "原生 Codex" }), { button: 0, ctrlKey: false });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Example API · API Shared" }));
  await waitFor(() => expect(select).toHaveBeenLastCalledWith({ executor: "mona", model: "shared-model", provider: "example", effort: null }));
  expect(await documentPanel.findByRole("button", { name: "API Shared" })).toBeInTheDocument();
  expect(video.queryByRole("button", { name: "API Shared" })).not.toBeInTheDocument();
  fireEvent.pointerDown(documentPanel.getByRole("button", { name: "API Shared" }), { button: 0, ctrlKey: false });
  fireEvent.click(await screen.findByRole("button", { name: "添加模型" }));
  expect(onOpenSettings).toHaveBeenCalledWith("models_providers");
});
