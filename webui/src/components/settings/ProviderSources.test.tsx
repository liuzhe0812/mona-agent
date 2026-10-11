import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SettingsPayload } from "@/lib/types";

const native = vi.hoisted(() => ({
  providerExecutors: vi.fn(), executorSettings: vi.fn(), updateExecutorSettings: vi.fn(), engineResources: vi.fn(),
  probe: vi.fn(), login: vi.fn(), loginStatus: vi.fn(), cancelLogin: vi.fn(), accountUsage: vi.fn(), accountUsageChanges: vi.fn(),
}));
vi.mock("@/lib/development-api", async (original) => ({ ...await original<typeof import("@/lib/development-api")>(), developmentApi: native }));
vi.mock("@/lib/api", () => ({ fetchProviderModels: vi.fn(), updateProviderSettings: vi.fn(), updateSettings: vi.fn() }));
import { ChatProvidersSettings } from "./ChatProvidersSettings";
import { fetchProviderModels, updateProviderSettings } from "@/lib/api";
import { modelKey, useModelPreferences } from "@/components/models/model-sources";
const entry = (name: string, label: string, configured: boolean, isBuiltin = false) => ({ name, label, configured, is_builtin: isBuiltin,
  api_key_required: !isBuiltin, api_key_hint: configured ? "syn••••tic" : "", api_base: "https://example.invalid/v1", default_api_base: "https://example.invalid/v1", api_base_editable: true,
  models: [{ id: "shared-id", name: "共享名称", enabled: true, type: "chat" }] });
const settings = { agent: { provider: "mona_managed", model: "shared-id" }, chat_providers: [
  entry("mona_managed", "Mona AI", true, true), entry("openai", "OpenAI", false), entry("anthropic", "Anthropic", false),
  { ...entry("custom-test", "我的供应商", true), is_custom: true }, entry("unconfigured-template", "未添加模板", false),
], image_generation: {providers: []}, video_generation: {providers: []} } as unknown as SettingsPayload;
beforeEach(() => {
  vi.clearAllMocks();
  useModelPreferences.setState({ hiddenNative: [], providerOrder: [] });
  native.providerExecutors.mockResolvedValue({ executors: [
    { id: "codex", name: "Codex", available: true, executable: "C:/test/codex.exe", models: [], reason: "检测到本机程序" },
    { id: "claude", name: "Claude Code", available: true, executable: "C:/test/claude.exe", models: [], reason: "检测到本机程序" },
  ] });
  const engineSettings = { revision: "revision-1", values: {}, credentialPresent: {}, enabledEngines: ["codex", "claude"] };
  native.executorSettings.mockResolvedValue(engineSettings);
  native.updateExecutorSettings.mockImplementation(async (_settings, values, enabledEngines) => ({
    ...engineSettings, revision: "revision-2", values: { ...engineSettings.values, ...values },
    enabledEngines: enabledEngines ?? engineSettings.enabledEngines,
  }));
  native.engineResources.mockResolvedValue({ components: [], catalogAvailable: false });
  native.loginStatus.mockResolvedValue({ state: "idle", loginId: null, authUrl: "", reason: "" });
  native.probe.mockResolvedValue({ state: "detected", reason: "已检查", authentication: "unknown" });
  native.accountUsage.mockResolvedValue({ revision: 0, connected: true, email: null, planType: null, limits: [], credits: null, availableResets: null, fetchedAt: null, error: null });
  native.accountUsageChanges.mockImplementation((_executor: string, _revision: number, signal?: AbortSignal) => new Promise((_resolve: unknown, reject: (reason: unknown) => void) => {
    const rejectOnAbort = () => reject(new DOMException("Aborted", "AbortError"));
    if (signal?.aborted) rejectOnAbort(); else signal?.addEventListener("abort", rejectOnAbort, { once: true });
  }));
  native.login.mockImplementation(async () => {
    const status = { state: "waiting", loginId: "test-attempt", authUrl: "https://auth.openai.com/authorize", reason: "等待授权" };
    native.loginStatus.mockResolvedValue(status);
    return status;
  });
});
afterEach(cleanup);
function page() { return render(<ChatProvidersSettings settings={settings} token="synthetic" onSettingsChanged={vi.fn()} onModelNameChange={vi.fn()} />); }
function providerIds(rail: HTMLElement) { return [...rail.querySelectorAll<HTMLElement>("[data-provider-id]")].map((row) => row.dataset.providerId); }
it("keeps official categories and user-added sources separate; opening settings only detects", async () => {
  page();
  const rail = screen.getByRole("complementary");
  await waitFor(() => expect(native.providerExecutors).toHaveBeenCalled());
  const sourceRows = [...rail.querySelectorAll<HTMLElement>("[data-provider-id]")];
  expect(providerIds(rail)).toEqual(["mona_managed", "custom-test", "openai", "anthropic"]);
  expect(sourceRows.slice(0, 3).map((row) => row.querySelector('button:not([aria-label="调整顺序"])')?.textContent)).toEqual([
    expect.stringContaining("Mona AI"), expect.stringContaining("我的供应商"), expect.stringContaining("OpenAI"),
  ]);
  expect(sourceRows.slice(0, 3).every((row) => row.getAttribute("draggable") === "true")).toBe(true);
  expect(sourceRows[3]).toHaveAttribute("draggable", "false");
  expect(within(rail).queryByText("检测到本机 CLI")).not.toBeInTheDocument();
  expect(sourceRows[3].querySelector("button")).toHaveTextContent("Anthropic");
  expect(within(rail).queryByText("未添加模板")).not.toBeInTheDocument();
  expect(native.probe).not.toHaveBeenCalled(); expect(native.login).not.toHaveBeenCalled();
});
it("reorders all sortable sources by keyboard and restores a hidden native model", async () => {
  native.providerExecutors.mockResolvedValue({ executors: [
    { id: "codex", name: "Codex", available: true, executable: "C:/test/codex.exe", reason: "已连接",
      probe: { state: "ready", authentication: "ready", authMode: "chatgpt", reason: "已连接" },
      models: [{ id: "native-shared", label: "原生共享模型" }] },
    { id: "claude", name: "Claude Code", available: true, executable: "C:/test/claude.exe", reason: "已连接",
      probe: { state: "ready", authentication: "ready", reason: "已连接" }, models: [] },
    { id: "codebuddy", name: "CodeBuddy", available: true, executable: "C:/test/codebuddy.exe", reason: "等待连接",
      probe: { state: "detected", authentication: "unknown", reason: "等待连接" }, models: [{ id: "", label: "默认模型" }] },
  ] });
  page();
  const rail = screen.getByRole("complementary");
  await waitFor(() => expect(native.providerExecutors).toHaveBeenCalled());
  expect(providerIds(rail)).toEqual(["mona_managed", "custom-test", "openai", "anthropic", "native:codebuddy"]);
  const currentMona = () => rail.querySelector('[data-provider-id="mona_managed"] button[aria-current="true"]');
  const orderHandle = (source: string) => within(rail).getAllByRole("button", { name: "调整顺序" })
    .find((button) => button.getAttribute("aria-describedby") === `source-name-${source}`)!;
  expect(within(rail).getAllByRole("button", { name: "调整顺序" })).toHaveLength(4);
  expect(orderHandle("openai")).toHaveAttribute("aria-keyshortcuts", "ArrowUp ArrowDown");
  expect(currentMona()).not.toBeNull();

  fireEvent.keyDown(orderHandle("openai"), { key: "ArrowDown" });
  await waitFor(() => expect(providerIds(rail)).toEqual(["mona_managed", "custom-test", "anthropic", "openai", "native:codebuddy"]));
  fireEvent.keyDown(orderHandle("openai"), { key: "ArrowUp" });
  await waitFor(() => expect(providerIds(rail)).toEqual(["mona_managed", "custom-test", "openai", "anthropic", "native:codebuddy"]));
  expect(currentMona()).not.toBeNull();

  fireEvent.click(within(rail).getByRole("button", { name: /OpenAI/ }));
  const modelKeyForNative = modelKey({ provider: "native:codex", model: "native-shared", executor: "codex" });
  const visibleToggle = await screen.findByRole("switch", { name: "Codex 原生共享模型 在选择器中显示" });
  expect(visibleToggle).toHaveAttribute("aria-checked", "true");
  fireEvent.click(visibleToggle);
  await waitFor(() => expect(useModelPreferences.getState().hiddenNative).toContain(modelKeyForNative));

  const hiddenSection = await screen.findByRole("button", { name: "未显示 1" });
  expect(hiddenSection).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(hiddenSection);
  const hiddenToggle = screen.getByRole("switch", { name: "Codex 原生共享模型 在选择器中显示" });
  expect(hiddenToggle).toHaveAttribute("aria-checked", "false");
  fireEvent.click(hiddenToggle);
  await waitFor(() => expect(useModelPreferences.getState().hiddenNative).not.toContain(modelKeyForNative));
  expect(await screen.findByRole("switch", { name: "Codex 原生共享模型 在选择器中显示" })).toHaveAttribute("aria-checked", "true");
});
it("shows a connected subscription independently of API-key configuration", async () => {
  native.providerExecutors.mockResolvedValue({ executors: [{ id: "codex", name: "Codex", available: true, executable: "C:/test/codex.exe", models: [], reason: "已连接", probe: { state: "ready", authentication: "ready", authMode: "chatgpt", reason: "已连接" } }] });
  page();
  const rail = screen.getByRole("complementary");
  await waitFor(() => expect(native.providerExecutors).toHaveBeenCalled());
  expect(within(rail).queryByLabelText("订阅已连接")).not.toBeInTheDocument();
  fireEvent.click(within(rail).getByRole("button", { name: /OpenAI/ }));
  const header = screen.getByRole("heading", { name: "OpenAI" }).closest("header");
  expect(header).not.toBeNull();
  expect(within(header!).getByText("已连接")).toBeInTheDocument();
  expect(within(header!).getByRole("button", { name: "断开连接" })).toBeInTheDocument();
  expect(native.login).not.toHaveBeenCalled();
});
it("keeps model rows simple until per-model settings are requested", async () => {
  page();
  fireEvent.click(within(screen.getByRole("complementary")).getByRole("button", { name: /我的供应商/ }));
  expect(screen.getByRole("button", { name: "设置 共享名称" })).toBeInTheDocument();
  expect(screen.getByRole("switch")).toBeInTheDocument();
  fireEvent.pointerDown(screen.getByRole("button", { name: "管理" }), { button: 0, ctrlKey: false });
  fireEvent.click(await screen.findByRole("menuitem", { name: "分别调整" }));
  fireEvent.pointerDown(screen.getByRole("button", { name: "设置 共享名称" }), { button: 0, ctrlKey: false });
  expect(await screen.findByRole("menuitemradio", { name: "对话" })).toHaveAttribute("aria-checked", "true");
});
it("refreshes only the native channel when no API key is configured", async () => {
  native.probe.mockResolvedValue({ state: "detected", reason: "未认证" });
  page();
  await waitFor(() => expect(native.providerExecutors).toHaveBeenCalled());
  fireEvent.click(within(screen.getByRole("complementary")).getByRole("button", { name: /OpenAI/ }));
  fireEvent.click(screen.getByRole("button", { name: "刷新模型" }));
  await waitFor(() => expect(native.probe).toHaveBeenCalledWith(undefined, "codex"));
  expect(fetchProviderModels).not.toHaveBeenCalled();
  expect(native.login).not.toHaveBeenCalled();
});
it("refreshing the API catalog preserves manually hidden model choices", async () => {
  native.providerExecutors.mockResolvedValue({ executors: [] });
  const configured = { ...settings, chat_providers: settings.chat_providers!.map((source) => source.name !== "custom-test" ? source : {
    ...source, configured: true, models: [...source.models, { id: "hidden", name: "Hidden", type: "chat", enabled: false }],
  }) } as SettingsPayload;
  vi.mocked(fetchProviderModels).mockResolvedValueOnce({ models: ["shared-id", "hidden", "new"], model_details: ["shared-id", "hidden", "new"].map((id) => ({ id, type: "chat",
    ...(id === "shared-id" ? { reasoning_efforts: ["low", "high", "xhigh"], default_reasoning_effort: "high" } : {}),
  })) });
  vi.mocked(updateProviderSettings).mockResolvedValueOnce(configured);
  render(<ChatProvidersSettings settings={configured} token="synthetic" onSettingsChanged={vi.fn()} onModelNameChange={vi.fn()} />);
  fireEvent.click(within(screen.getByRole("complementary")).getByRole("button", { name: /我的供应商/ }));
  fireEvent.click(screen.getByRole("button", { name: "刷新模型" }));
  await waitFor(() => expect(updateProviderSettings).toHaveBeenCalledWith("synthetic", expect.objectContaining({ provider: "custom-test", enabledModels: ["shared-id", "new"],
    discoveredModels: expect.arrayContaining([expect.objectContaining({ id: "shared-id", reasoningEfforts: ["low", "high", "xhigh"], defaultReasoningEffort: "high" })]),
  })));
});
it("native bulk visibility does not hide the same model from an API provider", async () => {
  useModelPreferences.setState({ hiddenNative: [] });
  native.providerExecutors.mockResolvedValue({ executors: [{ id: "codex", name: "Codex", available: true, executable: "C:/test/codex.exe", models: [{ id: "shared-id", label: "共享名称" }], reason: "", probe: { state: "ready", authentication: "ready", authMode: "chatgpt", reason: "" } }] });
  page();
  await waitFor(() => expect(native.providerExecutors).toHaveBeenCalled());
  fireEvent.click(within(screen.getByRole("complementary")).getByRole("button", { name: /OpenAI/ }));
  await screen.findByRole("switch", { name: "Codex 共享名称 在选择器中显示" });
  fireEvent.pointerDown(screen.getByRole("button", { name: "管理" }), { button: 0, ctrlKey: false });
  fireEvent.click(await screen.findByRole("menuitem", { name: "全部隐藏" }));
  const hidden = useModelPreferences.getState().hiddenNative;
  const nativeKey = modelKey({ provider: "native:codex", model: "shared-id", executor: "codex" });
  expect(hidden).toContain(nativeKey);
  expect(hidden).not.toContain(modelKey({ provider: "openai", model: "shared-id" }));

  fireEvent.pointerDown(screen.getByRole("button", { name: "管理" }), { button: 0, ctrlKey: false });
  fireEvent.click(await screen.findByRole("menuitem", { name: "全部显示" }));
  expect(useModelPreferences.getState().hiddenNative).not.toContain(nativeKey);
  useModelPreferences.getState().setNativeVisible([nativeKey], false);
  fireEvent.pointerDown(screen.getByRole("button", { name: "管理" }), { button: 0, ctrlKey: false });
  fireEvent.click(await screen.findByRole("menuitem", { name: "重置显示偏好" }));
  expect(useModelPreferences.getState().hiddenNative).not.toContain(nativeKey);
});
it("uses local Codex authorization without an API fallback", async () => {
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  try {
    page();
    await waitFor(() => expect(native.providerExecutors).toHaveBeenCalled());
    fireEvent.click(within(screen.getByRole("complementary")).getByRole("button", { name: /OpenAI/ }));
    const connect = await screen.findByRole("button", { name: "使用本机 Codex 账号", exact: true });
    await waitFor(() => expect(connect).toBeEnabled());
    fireEvent.click(connect);
    await waitFor(() => expect(open).toHaveBeenCalledWith("https://auth.openai.com/authorize", "_blank", "noopener,noreferrer"));
    expect(native.login).toHaveBeenCalledTimes(1);
    expect(native.login).toHaveBeenCalledWith(undefined, "codex");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "更多连接操作" })).not.toBeInTheDocument();
    expect(screen.queryByText("API Key 接入")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "添加供应商" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByText("OpenAI")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("Anthropic")).not.toBeInTheDocument();
    expect(native.login).toHaveBeenCalledTimes(1);
  } finally { open.mockRestore(); }
});
