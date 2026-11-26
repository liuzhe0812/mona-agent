import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { AiAssistantPanel } from "./AiAssistantPanel";
import * as api from "@/lib/api";
import { developmentApi, type DevExecutor } from "@/lib/development-api";
import type { MonaClient } from "@/lib/mona-client";
import type { ChatSummary, SettingsPayload } from "@/lib/types";
import { ClientProvider } from "@/providers/ClientProvider";

const mocks = vi.hoisted(() => ({ send: vi.fn(), setMessages: vi.fn() }));

vi.mock("@/hooks/useSessions", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/hooks/useSessions")>(),
  useSessionHistory: () => ({ messages: [], loading: false, hasPendingToolCalls: false, version: 0 }),
}));
vi.mock("@/hooks/useMonaStream", () => ({
  useMonaStream: () => ({ messages: [], isStreaming: false, send: mocks.send, setMessages: mocks.setMessages }),
}));
vi.mock("@/components/thread/ThreadMessages", () => ({ ThreadMessages: () => null }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  mocks.send.mockReset();
  mocks.setMessages.mockReset();
});

function setup(reject = false) {
  let settings = {
    agent: { model: "api-model", provider: "example", executor: "mona", native_model: null },
    model_presets: [],
    chat_providers: [{ name: "example", label: "Example API", configured: true, models: [{ id: "api-model", name: "API Model", enabled: true }] }],
  } as SettingsPayload;
  const codex: DevExecutor = {
    id: "codex", name: "Codex", available: true, reason: "已连接",
    probe: { state: "ready", authentication: "ready", reason: "已连接" },
    models: [{ id: "codex-model", label: "原生 Codex", reasoningEfforts: ["low", "high"], reasoningEffort: "high" }],
  };
  vi.spyOn(api, "fetchSettings").mockImplementation(async () => settings);
  vi.spyOn(developmentApi, "providerExecutors").mockResolvedValue({ executors: [codex] });
  const select = vi.spyOn(developmentApi, "selectWorkModelSource").mockImplementation(async (body) => {
    if (reject) throw new Error("private internal detail");
    settings = { ...settings, agent: { ...settings.agent, executor: body.executor, native_model: body.model, native_reasoning_effort: body.effort ?? null } };
    return settings;
  });
  const onOpenSettings = vi.fn();
  const session = { chatId: "browser-chat", key: "websocket:browser-chat" } as ChatSummary;
  render(<ClientProvider client={{} as MonaClient} token="browser-test" modelName="API Model" runtimeStatus="ready">
    <AiAssistantPanel session={session} isAiActive={false} tabId="tab-1" pageUrl="https://example.com" pageTitle="Example" onOpenSettings={onOpenSettings} />
  </ClientProvider>);
  return { select, onOpenSettings };
}

it("switches the Work engine and keeps the browser context on the next message", async () => {
  const { select, onOpenSettings } = setup();
  fireEvent.pointerDown(await screen.findByRole("button", { name: "API Model" }), { button: 0, ctrlKey: false });
  fireEvent.click(await screen.findByRole("menuitem", { name: "OpenAI · 原生 Codex" }));
  await waitFor(() => expect(select).toHaveBeenCalledWith({ executor: "codex", model: "codex-model", effort: "high" }));
  fireEvent.change(screen.getByPlaceholderText("输入消息..."), { target: { value: "总结当前网页" } });
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  expect(mocks.send).toHaveBeenCalledWith("总结当前网页", undefined, {
    browserTabId: "tab-1", browserPageUrl: "https://example.com", browserPageTitle: "Example",
  });

  fireEvent.pointerDown(await screen.findByRole("button", { name: "原生 Codex" }), { button: 0, ctrlKey: false });
  fireEvent.click(await screen.findByRole("button", { name: "添加模型" }));
  expect(onOpenSettings).toHaveBeenCalledWith("models_providers");
});

it("keeps a selection failure visible within the browser sidebar", async () => {
  setup(true);
  const sidebar = screen.getByRole("complementary");
  vi.spyOn(sidebar, "getBoundingClientRect").mockReturnValue({
    x: 700, y: 60, left: 700, top: 60, right: 988, bottom: 660, width: 288, height: 600, toJSON: () => ({}),
  });
  fireEvent.pointerDown(await screen.findByRole("button", { name: "API Model" }), { button: 0, ctrlKey: false });
  fireEvent.click(await screen.findByRole("menuitem", { name: "OpenAI · 原生 Codex" }));
  const dialog = await screen.findByRole("alertdialog", { name: "设置未保存" });
  expect(dialog).toHaveTextContent("模型未切换，设置未保存。请稍后重试。");
  expect(dialog).not.toHaveTextContent("private internal detail");
  expect(dialog).toHaveStyle({ left: "708px", width: "272px" });
});

it("opens model details on demand without covering the model before selection", async () => {
  const { select } = setup();
  fireEvent.pointerDown(await screen.findByRole("button", { name: "API Model" }), { button: 0, ctrlKey: false });
  const row = await screen.findByRole("menuitem", { name: "OpenAI · 原生 Codex" });
  fireEvent.pointerMove(row, { pointerType: "mouse" });
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(screen.queryByRole("slider", { name: "思考强度" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "原生 Codex模型详情" }));
  const slider = await screen.findByRole("slider", { name: "思考强度" });
  fireEvent.keyDown(slider, { key: "Home" });
  await waitFor(() => expect(select).toHaveBeenCalledWith({ executor: "codex", model: "codex-model", effort: "low" }));
});
