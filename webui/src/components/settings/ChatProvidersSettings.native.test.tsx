import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatProvidersSettings } from "./ChatProvidersSettings";
import { developmentApi, type DevExecutor } from "@/lib/development-api";
import { modelKey, useModelPreferences } from "@/components/models/model-sources";
import type { SettingsPayload } from "@/lib/types";

vi.mock("@/lib/api", () => ({ fetchProviderModels: vi.fn(), updateProviderSettings: vi.fn(), updateSettings: vi.fn() }));
vi.mock("@/hooks/useLicense", () => ({ useLicense: () => ({ licenseInfo: null }) }));
const openExternalUrl = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@/lib/tauri", async (original) => ({ ...(await original<typeof import("@/lib/tauri")>()), openExternalUrl }));

const settings = { agent: { provider: "mona_managed", model: "fixture-model" }, chat_providers: [{
  name: "mona_managed", label: "Mona AI", is_builtin: true, configured: false,
  api_key_required: false, api_base: "", default_api_base: "", models: [],
}, {
  name: "openai", label: "OpenAI", is_builtin: false, configured: false,
  api_key_required: true, api_base: "", default_api_base: "", models: [],
}, {
  name: "anthropic", label: "Anthropic", is_builtin: false, configured: false,
  api_key_required: true, api_base: "", default_api_base: "", models: [],
}] } as unknown as SettingsPayload;
const buddy: DevExecutor = { id: "codebuddy", name: "CodeBuddy", available: true,
  executable: "test/codebuddy.exe", reason: "已定位本机程序", models: [{ id: "", label: "执行者默认模型" }] };
const probedBuddy: DevExecutor = { ...buddy, probe: { state: "detected", reason: "已检查", authentication: "unknown", protocolVerified: true, models: [] } };
const authorizedBuddy: DevExecutor = { ...buddy, probe: { state: "detected", reason: "已授权", authentication: "ready", protocolVerified: true, modelCatalogState: "unavailable", models: [] } };
const readyBuddy: DevExecutor = { ...buddy, models: [...buddy.models, { id: "fixture-catalog-model", label: "目录模型" }],
  probe: { state: "ready", reason: "已连接", authentication: "ready", protocolVerified: true, modelCatalogState: "ready", defaultModel: "fixture-catalog-model" } };

function setup(executor = buddy) {
  const providers = vi.spyOn(developmentApi, "providerExecutors").mockResolvedValue({ executors: [executor] });
  const probe = vi.spyOn(developmentApi, "probe").mockResolvedValue({ state: "detected", reason: "已检查", authentication: "unknown" });
  const status = vi.spyOn(developmentApi, "loginStatus").mockResolvedValue({ loginId: null, state: "idle", authUrl: "", reason: "" });
  vi.spyOn(developmentApi, "accountUsage").mockResolvedValue({ revision: 0, connected: true, email: null, planType: null,
    limits: [], credits: null, availableResets: null, fetchedAt: null, error: null });
  vi.spyOn(developmentApi, "accountUsageChanges").mockImplementation((_executor, _revision, signal) =>
    new Promise((_resolve, reject) => {
      const rejectOnAbort = () => reject(new DOMException("Aborted", "AbortError"));
      if (signal?.aborted) rejectOnAbort();
      else signal?.addEventListener("abort", rejectOnAbort, { once: true });
    }),
  );
  const login = vi.spyOn(developmentApi, "login");
  const changed = vi.fn();
  const props = { settings, token: "fixture-token", onSettingsChanged: changed, onModelNameChange: vi.fn() };
  const view = render(<ChatProvidersSettings {...props} />);
  return { providers, probe, status, login, changed, view, props };
}

describe("CodeBuddy native source entry", () => {
  afterEach(() => vi.restoreAllMocks());

  it("opens a connection modal without navigating to the CodeBuddy detail page", async () => {
    const { login, changed } = setup();
    const source = await screen.findByRole("button", { name: "CodeBuddy 连接设置" });
    expect(login).not.toHaveBeenCalled();
    fireEvent.click(source);
    const dialog = await screen.findByRole("dialog", { name: "连接 · CodeBuddy" });
    expect(within(dialog).getByText("登录 CodeBuddy 账号连接。")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "连接 CodeBuddy" })).toBeInTheDocument();
    expect(source).not.toHaveAttribute("aria-current", "true");
    expect(screen.queryByRole("switch", { name: "CodeBuddy 默认模型 在选择器中显示" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "删除供应商" })).not.toBeInTheDocument();
    expect(login).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
  });

  it("groups native accounts under their own heading and keeps CodeBuddy after Anthropic", async () => {
    setup();
    const sidebar = screen.getByRole("complementary");
    expect(within(sidebar).getByText("API 来源")).toBeInTheDocument();
    expect(within(sidebar).getByText("订阅与账号")).toBeInTheDocument();
    const anthropic = await within(sidebar).findByRole("button", { name: /Anthropic/ });
    const codebuddy = within(sidebar).getByRole("button", { name: "CodeBuddy 连接设置" });
    expect(anthropic.compareDocumentPosition(codebuddy) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(sidebar).queryByText("用户添加 · 拖动排序")).not.toBeInTheDocument();
  });

  it("retains a disabled Codex account and its model visibility preference", async () => {
    const codex: DevExecutor = {
      id: "codex", name: "Codex", available: false, enabled: false, programAvailable: true,
      executable: "test/codex", reason: "来源已停用",
      probe: { state: "ready", reason: "账号已连接", authentication: "ready", authMode: "chatgpt",
        source: "managed_runtime", version: "mona_development/0.162.0 Codex CLI/0.92.0 (Windows NT 10.0)" },
      models: [{ id: "gpt-native", label: "Native model" }],
    };
    const engineSettings = { revision: "engine-revision", values: { codexPath: "C:/tools/codex.exe", claudePath: null }, credentialPresent: {}, enabledEngines: [] };
    const modelPreference = modelKey({ provider: "native:codex", model: "gpt-native", executor: "codex" });
    useModelPreferences.setState({ hiddenNative: [modelPreference], providerOrder: [] });
    vi.spyOn(developmentApi, "executorSettings").mockResolvedValue(engineSettings);
    const save = vi.spyOn(developmentApi, "updateExecutorSettings").mockResolvedValue({
      ...engineSettings, revision: "engine-revision-2", enabledEngines: ["codex"],
    });
    setup(codex);

    fireEvent.click(await screen.findByRole("button", { name: /OpenAI/ }));
    const engineToggle = await screen.findByRole("switch", { name: "Codex 启用状态" });
    expect(engineToggle).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText("来源：Mona 管理")).toBeInTheDocument();
    expect(screen.getByText("版本：0.92.0")).toBeInTheDocument();
    expect(screen.queryByText("版本：0.162.0")).not.toBeInTheDocument();
    expect(screen.queryByText(/mona_development/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "未显示 1" }));
    const modelToggle = screen.getByRole("switch", { name: "Codex Native model 在选择器中显示" });
    expect(modelToggle).toHaveAttribute("aria-checked", "false");
    expect(modelToggle).toBeEnabled();
    expect(useModelPreferences.getState().hiddenNative).toEqual([modelPreference]);

    fireEvent.click(engineToggle);
    await waitFor(() => expect(save).toHaveBeenCalledWith(engineSettings, {}, ["codex"]));
    expect(useModelPreferences.getState().hiddenNative).toEqual([modelPreference]);
  });

  it("uses the official login in the modal and enters details only after the account is confirmed", async () => {
    const { login, status, probe, providers } = setup();
    const source = await screen.findByRole("button", { name: "CodeBuddy 连接设置" });
    fireEvent.click(source);
    const dialog = await screen.findByRole("dialog", { name: "连接 · CodeBuddy" });
    const connect = within(dialog).getByRole("button", { name: "连接 CodeBuddy" });
    await waitFor(() => expect(connect).not.toBeDisabled());
    const waiting = { loginId: "fixture-login", state: "waiting" as const,
      authUrl: "https://copilot.tencent.com/test-only-authorize", reason: "请在官方页面完成认证" };
    login.mockImplementation(async () => {
      status.mockResolvedValue({ ...waiting, state: "succeeded", authUrl: "", reason: "授权完成" });
      providers.mockResolvedValue({ executors: [authorizedBuddy] });
      probe.mockResolvedValue(authorizedBuddy.probe!);
      return waiting;
    });
    fireEvent.click(connect);
    await waitFor(() => expect(login).toHaveBeenCalledWith(undefined, "codebuddy"));
    await waitFor(() => expect(openExternalUrl).toHaveBeenCalledWith(waiting.authUrl));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "连接 · CodeBuddy" })).not.toBeInTheDocument());
    const confirmedSource = within(screen.getByRole("complementary")).getByRole("button", { name: /CodeBuddy/ });
    await waitFor(() => expect(confirmedSource).toHaveAttribute("aria-current", "true"));
    expect(await screen.findByText("暂时无法获取模型")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "CodeBuddy 默认模型 在选择器中显示" })).toBeDisabled();
    expect(login).toHaveBeenCalledTimes(1);
  });

  it("shows named models immediately when an already connected catalog is available", async () => {
    const { login, view, props } = setup(readyBuddy);
    fireEvent.click(await screen.findByRole("button", { name: "CodeBuddy 连接设置" }));
    expect(await screen.findByRole("switch", { name: "CodeBuddy 目录模型 在选择器中显示" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "连接 · CodeBuddy" })).not.toBeInTheDocument();
    expect(login).not.toHaveBeenCalled();
    view.rerender(<ChatProvidersSettings {...props} settings={{ ...settings }} />);
    expect(screen.getByRole("switch", { name: "CodeBuddy 目录模型 在选择器中显示" })).toBeInTheDocument();
  });

  it("keeps discovery failure explicit and cannot start login without the required program", async () => {
    const { login, probe } = setup({ ...buddy, available: false, executable: undefined, reason: "未找到本地程序" });
    fireEvent.click(await screen.findByRole("button", { name: "CodeBuddy 连接设置" }));
    expect(await screen.findByRole("button", { name: "连接 CodeBuddy" })).toBeDisabled();
    expect(screen.getByText("需安装 CodeBuddy")).toBeInTheDocument();
    expect(login).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });

  it("keeps account and model state in the detail area without sidebar indicators", async () => {
    const ready: DevExecutor = { ...buddy, models: [...buddy.models, { id: "catalog-model", label: "真实目录模型", contextWindow: 192000 }],
      probe: { state: "ready", reason: "账号和目录已同步", authentication: "ready", protocolVerified: true, modelCatalogState: "ready", defaultModel: "catalog-model" } };
    const { login, probe } = setup(ready);
    probe.mockResolvedValue(ready.probe!);
    fireEvent.click(await screen.findByRole("button", { name: "CodeBuddy 连接设置" }));
    expect(await screen.findByRole("switch", { name: "CodeBuddy 真实目录模型 在选择器中显示" })).toBeInTheDocument();
    expect(screen.getAllByText("已连接")).toHaveLength(1);
    const source = screen.getByRole("button", { name: "CodeBuddy 连接设置" });
    expect(within(source).queryByText("1 个模型")).not.toBeInTheDocument();
    expect(within(source).queryByLabelText("已连接")).not.toBeInTheDocument();
    expect(screen.queryByText("192K")).not.toBeInTheDocument();
    expect(screen.queryByText("当前默认：catalog-model")).not.toBeInTheDocument();
    expect(login).not.toHaveBeenCalled();
  });

  it("retries catalog synchronization without another login after a verified account", async () => {
    const unavailable: DevExecutor = { ...buddy, probe: { state: "detected", reason: "模型目录同步失败", authentication: "ready", protocolVerified: true, modelCatalogState: "unavailable" } };
    const { login, providers, probe } = setup(unavailable);
    fireEvent.click(await screen.findByRole("button", { name: "CodeBuddy 连接设置" }));
    expect(await screen.findByText("暂时无法获取模型")).toBeInTheDocument();
    expect(screen.queryByText("模型目录同步失败")).not.toBeInTheDocument();
    expect(screen.queryByText("已连接")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "连接 CodeBuddy" })).not.toBeInTheDocument();
    const ready = { ...unavailable, models: [{ id: "new-model", label: "同步结果" }],
      probe: { ...unavailable.probe!, state: "ready", modelCatalogState: "ready" as const } };
    providers.mockResolvedValue({ executors: [ready] });
    probe.mockResolvedValue(ready.probe);
    fireEvent.pointerDown(screen.getByRole("button", { name: "更多连接操作" }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: "刷新连接与模型" }));
    expect(await screen.findByRole("switch", { name: "CodeBuddy 同步结果 在选择器中显示" })).toBeInTheDocument();
    expect(screen.getAllByText("已连接")).toHaveLength(1);
    expect(login).not.toHaveBeenCalled();
  });

  it("filters the extra source in the same provider list", async () => {
    setup();
    await screen.findByRole("button", { name: "CodeBuddy 连接设置" });
    fireEvent.change(screen.getByPlaceholderText("搜索供应商"), { target: { value: "CodeBuddy" } });
    expect(screen.getByRole("button", { name: "CodeBuddy 连接设置" })).toBeInTheDocument();
    expect(within(screen.getByRole("complementary")).queryByRole("button", { name: /Mona AI/ })).not.toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("搜索供应商"), { target: { value: "Mona" } });
    expect(screen.queryByRole("button", { name: "CodeBuddy 连接设置" })).not.toBeInTheDocument();
  });
});
