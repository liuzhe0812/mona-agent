import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { VideoChatPanel } from "./VideoChatPanel";
import * as api from "@/lib/api";
import { developmentApi, type DevExecutor } from "@/lib/development-api";
import type { MonaClient } from "@/lib/mona-client";
import type { SettingsPayload } from "@/lib/types";
import { ClientProvider } from "@/providers/ClientProvider";

const mocks = vi.hoisted(() => ({ send: vi.fn(), setMessages: vi.fn(), historical: [] }));
vi.mock("@/hooks/useSessions", async (original) => ({
  ...await original<typeof import("@/hooks/useSessions")>(),
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

afterEach(() => {
  vi.restoreAllMocks();
  mocks.send.mockReset();
  mocks.setMessages.mockReset();
});

it("blocks chat until the video binding is known and uses its own model selection", async () => {
  const settings = {
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
  const apiBinding = { executor: "mona", model: "shared-model", provider: "example", effort: null } as const;
  const codexBinding = { executor: "codex", model: "codex-model", provider: null, effort: "high" } as const;
  let finishRead!: (value: typeof apiBinding) => void;
  let finishUpdate!: (value: typeof codexBinding) => void;
  let rejectUpdate!: (error: Error) => void;
  vi.spyOn(api, "fetchSettings").mockResolvedValue(settings);
  vi.spyOn(developmentApi, "providerExecutors").mockResolvedValue({ executors: [codex] });
  const globalSelect = vi.spyOn(developmentApi, "selectWorkModelSource");
  vi.spyOn(api, "fetchVideoSessionModelBinding")
    .mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve; }))
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce(codexBinding);
  const update = vi.fn()
    .mockImplementationOnce(() => new Promise((resolve) => { finishUpdate = resolve; }))
    .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectUpdate = reject; }));
  const client = {
    updateVideoModelBinding: update,
    isChatDeleted: () => false,
    onSessionDeleted: () => () => {},
    onDocUploadResult: () => () => {},
    onRuntimeModelUpdate: () => () => {},
  } as unknown as MonaClient;
  render(<ClientProvider client={client} token="token" modelName="API Shared" runtimeStatus="ready">
    <VideoChatPanel chatId="video-chat" showWorkModelSelector getSendOptions={() => ({ agentKind: "video" })} />
  </ClientProvider>);

  const input = screen.getByRole("textbox", { name: "Message input" });
  expect(input).toBeDisabled();
  await act(async () => finishRead(apiBinding));
  expect(input).toBeEnabled();
  fireEvent.pointerDown(await screen.findByRole("button", { name: "Example API · API Shared" }), { button: 0, ctrlKey: false });
  fireEvent.click(await screen.findByRole("menuitem", { name: "OpenAI · 原生 Codex" }));
  expect(update).toHaveBeenCalledWith("video-chat", codexBinding);
  expect(globalSelect).not.toHaveBeenCalled();
  expect(input).toBeDisabled();
  await act(async () => finishUpdate(codexBinding));
  expect(input).toBeEnabled();

  fireEvent.pointerDown(await screen.findByRole("button", { name: "OpenAI · 原生 Codex" }), { button: 0, ctrlKey: false });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Example API · API Shared" }));
  await act(async () => rejectUpdate(new Error("receipt lost")));
  expect(input).toBeDisabled();
  expect(screen.getByText("请重新读取模型设置后继续。")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "知道了" }));
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await waitFor(() => expect(input).toBeEnabled());
  fireEvent.change(input, { target: { value: "调整分镜" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(mocks.send).toHaveBeenCalledWith("调整分镜", undefined, expect.objectContaining({ agentKind: "video" })));
  expect(globalSelect).not.toHaveBeenCalled();
});
