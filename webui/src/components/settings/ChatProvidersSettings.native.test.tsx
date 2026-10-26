import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatProvidersSettings } from "./ChatProvidersSettings";
import { developmentApi, type DevExecutor, type EngineResource, type EngineResources, type ExecutorSettings, type NativeProbe } from "@/lib/development-api";
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

const absentBuddyComponent: EngineResource = {
  executor: "codebuddy", source: "not_detected", executable: null, systemAvailable: false,
  installed: false, managedInstalled: false, canPrepare: true, canUpdate: false,
  repairRequired: false, explicitPath: false, packRef: "codebuddy-pack", version: "1.0.0",
  installedVersion: null, downloadBytes: 4096, reason: "", job: null,
};
const installedBuddyComponent: EngineResource = {
  ...absentBuddyComponent, source: "managed_runtime", executable: "test/codebuddy.exe",
  installed: true, managedInstalled: true, canPrepare: false, installedVersion: "1.0.0",
};
const resourceSnapshot = (resource: EngineResource): EngineResources => ({ components: [resource], catalogAvailable: true });
const defaultEngineSettings: ExecutorSettings = {
  revision: "engine-revision", values: { codebuddyPath: null }, credentialPresent: {}, enabledEngines: ["codebuddy"],
};
const subscriptionProviders = [
  {
    id: "codex" as const,
    name: "Codex",
    sourceLabel: /OpenAI/,
    authButton: "认证 ChatGPT",
    readyHeading: "Codex 已准备就绪",
    unauthenticatedProbe: { state: "detected", reason: "", authentication: "unknown" } as NativeProbe,
    authenticatedProbe: { state: "ready", reason: "", authentication: "ready", authMode: "chatgpt" } as NativeProbe,
  },
  {
    id: "claude" as const,
    name: "Claude Code",
    sourceLabel: /Anthropic/,
    authButton: "认证 Claude",
    readyHeading: "Claude Code 已准备就绪",
    unauthenticatedProbe: { state: "detected", reason: "", authentication: "unknown" } as NativeProbe,
    authenticatedProbe: { state: "ready", reason: "", authentication: "ready" } as NativeProbe,
  },
];

function subscriptionExecutor(
  provider: typeof subscriptionProviders[number],
  probe: NativeProbe = provider.unauthenticatedProbe,
): DevExecutor {
  return {
    ...buddy,
    id: provider.id,
    name: provider.name,
    available: true,
    enabled: false,
    programAvailable: true,
    executable: `test/${provider.id}-system`,
    probe,
    models: [{ id: "subscription-model", label: "订阅模型" }],
  };
}

function subscriptionResource(executor: string, overrides: Partial<EngineResource> = {}): EngineResource {
  return {
    ...absentBuddyComponent,
    executor,
    source: "path",
    executable: `test/${executor}-system`,
    systemAvailable: true,
    installed: true,
    managedInstalled: false,
    managedExecutable: null,
    managedVersion: null,
    usingManaged: false,
    canPrepare: true,
    canDelete: false,
    packRef: `${executor}-pack`,
    ...overrides,
  } as EngineResource;
}

function setup(executor = buddy, resources = resourceSnapshot(installedBuddyComponent), engineSettings = defaultEngineSettings) {
  const providers = vi.spyOn(developmentApi, "providerExecutors").mockResolvedValue({ executors: [executor] });
  const engineResources = vi.spyOn(developmentApi, "engineResources").mockResolvedValue(resources);
  const executorSettings = vi.spyOn(developmentApi, "executorSettings").mockResolvedValue(engineSettings);
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
  const prepareExecutor = vi.spyOn(developmentApi, "prepareExecutor").mockResolvedValue({ installed: false, job: null });
  const changed = vi.fn();
  const props = { settings, token: "fixture-token", onSettingsChanged: changed, onModelNameChange: vi.fn() };
  const view = render(<ChatProvidersSettings {...props} />);
  return { providers, engineResources, executorSettings, probe, status, login, prepareExecutor, changed, view, props };
}

describe("WorkBuddy native source entry", () => {
  afterEach(() => vi.restoreAllMocks());

  it("shows inline WorkBuddy setup without exposing engine settings or starting authentication", async () => {
    const { login, changed } = setup();
    const source = await screen.findByRole("button", { name: "WorkBuddy 连接设置" });
    expect(within(source).getByText("待认证")).toBeInTheDocument();
    expect(login).not.toHaveBeenCalled();
    fireEvent.click(source);
    expect(await screen.findByRole("heading", { name: "WorkBuddy", exact: true })).toBeInTheDocument();
    const authenticate = await screen.findByRole("button", { name: "认证 WorkBuddy" });
    await waitFor(() => expect(authenticate).toBeEnabled());
    expect(screen.queryByRole("switch", { name: "WorkBuddy 启用状态" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "管理引擎" })).toBeEnabled();
    expect(screen.queryByPlaceholderText("搜索模型")).not.toBeInTheDocument();
    expect(screen.getByText("认证完成后，自动显示可用模型")).toBeInTheDocument();
    expect(source).toHaveAttribute("aria-current", "true");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "删除供应商" })).not.toBeInTheDocument();
    expect(login).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
  });

  it("groups native accounts under their own heading and keeps WorkBuddy after Anthropic", async () => {
    setup();
    const sidebar = screen.getByRole("complementary");
    expect(within(sidebar).getByText("API 来源")).toBeInTheDocument();
    expect(within(sidebar).getByText("订阅与账号")).toBeInTheDocument();
    const anthropic = await within(sidebar).findByRole("button", { name: /Anthropic/ });
    const codebuddy = within(sidebar).getByRole("button", { name: "WorkBuddy 连接设置" });
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
    const save = vi.spyOn(developmentApi, "updateExecutorSettings").mockResolvedValue({
      ...engineSettings, revision: "engine-revision-2", enabledEngines: ["codex"],
    });
    setup(codex, resourceSnapshot({ ...installedBuddyComponent, executor: "codex", executable: "test/codex" }), engineSettings);

    fireEvent.click(await screen.findByRole("button", { name: /OpenAI/ }));
    const engineToggle = await screen.findByRole("switch", { name: "Codex 启用状态" });
    expect(engineToggle).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("heading", { name: "Codex 已准备就绪" })).toBeInTheDocument();
    expect(screen.getByText("已认证")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "未显示 1" }));
    const modelToggle = screen.getByRole("checkbox", { name: "Codex Native model 在选择器中显示" });
    expect(modelToggle).not.toBeChecked();
    expect(modelToggle).toBeEnabled();
    expect(useModelPreferences.getState().hiddenNative).toEqual([modelPreference]);

    fireEvent.click(engineToggle);
    await waitFor(() => expect(save).toHaveBeenCalledWith(engineSettings, {}, ["codex"]));
    expect(useModelPreferences.getState().hiddenNative).toEqual([modelPreference]);
  });

  it("does not treat Codex API key authentication as a ChatGPT subscription", async () => {
    const codex: DevExecutor = {
      id: "codex", name: "Codex", available: true, programAvailable: true,
      executable: "test/codex", reason: "",
      probe: { state: "ready", reason: "API Key 已连接", authentication: "ready", authMode: "api_key" },
      models: [{ id: "api-key-only-model", label: "API Key 专用模型" }],
    };
    setup(codex, resourceSnapshot({ ...installedBuddyComponent, executor: "codex", executable: "test/codex" }));

    fireEvent.click(await screen.findByRole("button", { name: /OpenAI/ }));

    expect(screen.queryByText("已认证")).not.toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Codex 启用状态" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Codex API Key 专用模型 在选择器中显示")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "认证 ChatGPT" })).toBeInTheDocument();
  });

  it("re-authenticates Codex through its own official login flow", async () => {
    const codex: DevExecutor = {
      id: "codex", name: "Codex", available: true, enabled: true, programAvailable: true,
      executable: "test/codex", reason: "",
      probe: { state: "ready", reason: "账号已连接", authentication: "ready", authMode: "chatgpt" },
      models: [{ id: "gpt-native", label: "Native model" }],
    };
    const codexResource = {
      ...installedBuddyComponent, executor: "codex", executable: "test/codex",
      managedExecutable: "test/codex", usingManaged: true, managedVersion: "codex-managed-v1", canDelete: true,
    } as EngineResource;
    const { login, engineResources } = setup(codex, resourceSnapshot(codexResource));
    const authUrl = "https://chatgpt.com/auth/codex/test-only";
    login.mockResolvedValue({ loginId: "codex-login", state: "waiting", authUrl, reason: "" });

    fireEvent.click(await screen.findByRole("button", { name: /OpenAI/ }));
    fireEvent.click(screen.getByRole("button", { name: "管理引擎" }));
    const management = await screen.findByRole("dialog", { name: "管理引擎 · Codex" });
    expect(within(management).getByRole("region", { name: "Mona 托管引擎" })).toBeInTheDocument();
    expect(engineResources).toHaveBeenCalledWith("codex", true);
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "管理引擎 · Codex" })).not.toBeInTheDocument());
    fireEvent.click(await screen.findByRole("button", { name: "重新认证" }));

    await waitFor(() => expect(login).toHaveBeenCalledWith(undefined, "codex"));
    await waitFor(() => expect(openExternalUrl).toHaveBeenCalledWith(authUrl));
  });

  it("uninstalls the Mona-managed Claude component only after confirming its managed version", async () => {
    const claude: DevExecutor = {
      id: "claude", name: "Claude Code", available: true, enabled: false, programAvailable: true,
      executable: "test/claude", reason: "",
      probe: { state: "ready", reason: "账号已连接", authentication: "ready" },
      models: [{ id: "claude-sonnet", label: "Claude Sonnet" }],
    };
    const managedVersion = "managed-claude-1.0.0";
    const managedClaudeComponent = {
      ...installedBuddyComponent, executor: "claude", executable: "test/claude",
      managedExecutable: "test/claude", usingManaged: true, managedVersion, canDelete: true,
    } as EngineResource;
    const { engineResources } = setup(claude, resourceSnapshot(managedClaudeComponent), {
      ...defaultEngineSettings, enabledEngines: [],
    });
    const events: string[] = [];
    engineResources.mockImplementation(async (executor, forceRefresh) => {
      events.push(forceRefresh ? `refresh:${executor}` : `read:${executor}`);
      return resourceSnapshot(managedClaudeComponent);
    });
    const deleteManagedExecutor = vi.spyOn(developmentApi, "deleteManagedExecutor")
      .mockImplementation(async () => {
        events.push("delete:claude");
        return {} as never;
      });

    fireEvent.click(await screen.findByRole("button", { name: /Anthropic/ }));
    fireEvent.click(await screen.findByRole("button", { name: "管理引擎" }));
    const management = await screen.findByRole("dialog", { name: "管理引擎 · Claude Code" });
    expect(await within(within(management).getByRole("region", { name: "Mona 托管引擎" })).findByText("已安装")).toBeInTheDocument();
    expect(await within(within(management).getByRole("region", { name: "当前使用" })).findByText("Mona 托管引擎")).toBeInTheDocument();
    fireEvent.click(within(management).getByRole("button", { name: "卸载托管引擎" }));
    expect(screen.queryByRole("dialog", { name: "管理引擎 · Claude Code" })).not.toBeInTheDocument();
    const confirmation = await screen.findByRole("alertdialog", { name: "卸载 Mona 下载的组件？" });
    fireEvent.click(within(confirmation).getByRole("button", { name: "卸载组件" }));

    await waitFor(() => expect(deleteManagedExecutor).toHaveBeenCalledWith("claude", managedVersion));
    await waitFor(() => expect(events).toContain("refresh:claude"));
    expect(engineResources).toHaveBeenCalledWith("claude", true);
    expect(events.indexOf("refresh:claude")).toBeLessThan(events.indexOf("delete:claude"));
  });

  it.each(subscriptionProviders)("uses the installed local $name engine without preparing a Mona copy", async (provider) => {
    const engineSettings = {
      ...defaultEngineSettings,
      values: { codebuddyPath: null, codexPath: null, claudePath: null },
      enabledEngines: [],
    };
    const { login, prepareExecutor, engineResources, probe } = setup(
      subscriptionExecutor(provider), resourceSnapshot(subscriptionResource(provider.id)), engineSettings,
    );
    probe.mockResolvedValue(provider.unauthenticatedProbe);

    fireEvent.click(await screen.findByRole("button", { name: provider.sourceLabel }));
    expect(await screen.findByRole("button", { name: provider.authButton })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "下载必要组件" })).not.toBeInTheDocument();
    expect(prepareExecutor).not.toHaveBeenCalled();
    expect(login).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "管理引擎" }));
    const management = await screen.findByRole("dialog", { name: `管理引擎 · ${provider.name}` });
    const localEngine = within(management).getByRole("region", { name: `本机 ${provider.name} 引擎` });
    const managedEngine = within(management).getByRole("region", { name: "Mona 托管引擎" });
    expect(await within(localEngine).findByText("已安装")).toBeInTheDocument();
    expect(await within(managedEngine).findByText("未安装")).toBeInTheDocument();
    expect(await within(within(management).getByRole("region", { name: "当前使用" })).findByText("本机已有引擎")).toBeInTheDocument();
    expect(engineResources).toHaveBeenCalledWith(provider.id, true);
    expect(prepareExecutor).not.toHaveBeenCalled();
  });

  it.each(subscriptionProviders)("keeps the local $name engine available while its Mona copy needs repair", async (provider) => {
    const repairResource = subscriptionResource(provider.id, {
      managedInstalled: true,
      managedExecutable: `test/${provider.id}-managed`,
      managedVersion: `${provider.id}-managed-v1`,
      canDelete: true,
      repairRequired: true,
    });
    const { login, prepareExecutor, probe } = setup(
      subscriptionExecutor(provider), resourceSnapshot(repairResource), {
        ...defaultEngineSettings,
        values: { codebuddyPath: null, codexPath: null, claudePath: null },
        enabledEngines: [],
      },
    );
    probe.mockResolvedValue(provider.unauthenticatedProbe);

    fireEvent.click(await screen.findByRole("button", { name: provider.sourceLabel }));
    expect(await screen.findByRole("button", { name: provider.authButton })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "下载必要组件" })).not.toBeInTheDocument();
    expect(prepareExecutor).not.toHaveBeenCalled();
    expect(login).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "管理引擎" }));
    const management = await screen.findByRole("dialog", { name: `管理引擎 · ${provider.name}` });
    const localEngine = within(management).getByRole("region", { name: `本机 ${provider.name} 引擎` });
    const managedEngine = within(management).getByRole("region", { name: "Mona 托管引擎" });
    expect(await within(localEngine).findByText("已安装")).toBeInTheDocument();
    expect(within(managedEngine).getByRole("button", { name: "修复托管引擎" })).toBeEnabled();
    expect(prepareExecutor).not.toHaveBeenCalled();
  });

  it.each(subscriptionProviders)("keeps $name ready on the local engine after removing its Mona copy", async (provider) => {
    let managedInstalled = true;
    const managedResource = subscriptionResource(provider.id, {
      managedInstalled: true,
      managedExecutable: `test/${provider.id}-managed`,
      managedVersion: `${provider.id}-managed-v1`,
      canDelete: true,
    });
    const localResource = subscriptionResource(provider.id);
    const engineSettings = {
      ...defaultEngineSettings,
      values: { codebuddyPath: null, codexPath: null, claudePath: null },
      enabledEngines: [],
    };
    const { engineResources, login, prepareExecutor } = setup(
      subscriptionExecutor(provider, provider.authenticatedProbe), resourceSnapshot(managedResource), engineSettings,
    );
    engineResources.mockImplementation(async () => resourceSnapshot(managedInstalled ? managedResource : localResource));
    vi.spyOn(developmentApi, "probe").mockResolvedValue(provider.authenticatedProbe);
    const remove = vi.spyOn(developmentApi, "deleteManagedExecutor").mockImplementation(async (id, version) => {
      expect(id).toBe(provider.id);
      expect(version).toBe(`${provider.id}-managed-v1`);
      managedInstalled = false;
      return { deleted: true };
    });
    const save = vi.spyOn(developmentApi, "updateExecutorSettings");

    fireEvent.click(await screen.findByRole("button", { name: provider.sourceLabel }));
    expect(await screen.findByRole("heading", { name: provider.readyHeading })).toBeInTheDocument();
    expect(screen.getByText("已认证")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: `${provider.name} 启用状态` })).not.toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: "管理引擎" }));
    const management = await screen.findByRole("dialog", { name: `管理引擎 · ${provider.name}` });
    expect(await within(within(management).getByRole("region", { name: `本机 ${provider.name} 引擎` })).findByText("已安装")).toBeInTheDocument();
    expect(await within(within(management).getByRole("region", { name: "Mona 托管引擎" })).findByText("已安装")).toBeInTheDocument();
    fireEvent.click(within(management).getByRole("button", { name: "卸载托管引擎" }));
    const confirmation = await screen.findByRole("alertdialog", { name: "卸载 Mona 下载的组件？" });
    fireEvent.click(within(confirmation).getByRole("button", { name: "卸载组件" }));

    await waitFor(() => expect(remove).toHaveBeenCalledWith(provider.id, `${provider.id}-managed-v1`));
    expect(await screen.findByRole("heading", { name: provider.readyHeading })).toBeInTheDocument();
    expect(screen.getByText("已认证")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: `${provider.name} 启用状态` })).not.toBeChecked();
    expect(screen.queryByRole("button", { name: "下载必要组件" })).not.toBeInTheDocument();
    expect(prepareExecutor).not.toHaveBeenCalled();
    expect(login).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "管理引擎" }));
    const afterRemoval = await screen.findByRole("dialog", { name: `管理引擎 · ${provider.name}` });
    expect(await within(within(afterRemoval).getByRole("region", { name: `本机 ${provider.name} 引擎` })).findByText("已安装")).toBeInTheDocument();
    expect(await within(within(afterRemoval).getByRole("region", { name: "Mona 托管引擎" })).findByText("未安装")).toBeInTheDocument();
    expect(await within(within(afterRemoval).getByRole("region", { name: "当前使用" })).findByText("本机已有引擎")).toBeInTheDocument();
  });

  it("uses the official login from the detail page and stays there when the account is confirmed", async () => {
    const { login, status, probe, providers } = setup();
    const source = await screen.findByRole("button", { name: "WorkBuddy 连接设置" });
    fireEvent.click(source);
    const connect = await screen.findByRole("button", { name: "认证 WorkBuddy" });
    expect(screen.getByRole("heading", { name: "WorkBuddy", exact: true })).toBeInTheDocument();
    expect(source).toHaveAttribute("aria-current", "true");
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
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "连接 · WorkBuddy" })).not.toBeInTheDocument());
    const confirmedSource = within(screen.getByRole("complementary")).getByRole("button", { name: /WorkBuddy/ });
    await waitFor(() => expect(confirmedSource).toHaveAttribute("aria-current", "true"));
    expect(await screen.findByRole("switch", { name: "WorkBuddy 启用状态" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "认证 WorkBuddy" })).not.toBeInTheDocument();
    expect(login).toHaveBeenCalledTimes(1);
  });

  it("waits for a post-authentication probe and provider refresh before showing WorkBuddy as ready", async () => {
    const unverified: DevExecutor = {
      ...buddy,
      programAvailable: true,
      models: [],
      probe: { state: "detected", reason: "等待确认", authentication: "unknown", protocolVerified: true, modelCatalogState: "unknown" },
    };
    const ready: DevExecutor = {
      ...unverified,
      models: [{ id: "verified-model", label: "认证后模型" }],
      probe: { state: "ready", reason: "认证已确认", authentication: "ready", protocolVerified: true,
        modelCatalogState: "ready", defaultModel: "verified-model" },
    };
    const engineSettings: ExecutorSettings = { ...defaultEngineSettings, enabledEngines: [] };
    const { login, status, providers, probe, prepareExecutor } = setup(
      unverified, resourceSnapshot(installedBuddyComponent), engineSettings,
    );
    let resolvePostLoginProbe!: (value: NativeProbe) => void;
    let postLoginProbeFinished = false;
    const postLoginProbe = new Promise<NativeProbe>((resolve) => {
      resolvePostLoginProbe = (value) => {
        postLoginProbeFinished = true;
        resolve(value);
      };
    });
    providers.mockImplementation(async () => ({ executors: [postLoginProbeFinished ? ready : unverified] }));
    let probeCount = 0;
    probe.mockImplementation(async () => {
      probeCount += 1;
      return probeCount === 1 ? unverified.probe! : postLoginProbe;
    });
    const updateEnabled = vi.spyOn(developmentApi, "updateExecutorSettings");
    const logout = vi.spyOn(developmentApi, "logout").mockResolvedValue({ ok: true });
    openExternalUrl.mockClear();

    const source = await screen.findByRole("button", { name: "WorkBuddy 连接设置" });
    fireEvent.click(source);
    const authenticate = await screen.findByRole("button", { name: "认证 WorkBuddy" });
    await waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(providers.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(screen.queryByRole("switch", { name: "WorkBuddy 启用状态" })).not.toBeInTheDocument();
    const providerReadsBeforeLogin = providers.mock.calls.length;

    const waiting = { loginId: "fixture-login", state: "waiting" as const,
      authUrl: "https://copilot.tencent.com/test-only-authorize", reason: "请在官方页面完成认证" };
    login.mockImplementation(async () => {
      status.mockResolvedValue({ ...waiting, state: "succeeded", authUrl: "", reason: "授权完成" });
      return waiting;
    });
    fireEvent.click(authenticate);
    await waitFor(() => expect(login).toHaveBeenCalledWith(undefined, "codebuddy"));
    await waitFor(() => expect(openExternalUrl).toHaveBeenCalledWith(waiting.authUrl));
    expect(await screen.findByText("已授权")).toBeInTheDocument();
    await waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
    expect(providers).toHaveBeenCalledTimes(providerReadsBeforeLogin);
    expect(screen.getByText("使用 WorkBuddy 订阅的条件已就绪")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "WorkBuddy 已准备就绪" })).not.toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "WorkBuddy 启用状态" })).not.toBeInTheDocument();

    await act(async () => {
      resolvePostLoginProbe(ready.probe!);
      await postLoginProbe;
    });
    expect(await screen.findByRole("heading", { name: "WorkBuddy 已准备就绪" })).toBeInTheDocument();
    const sourceToggle = screen.getByRole("switch", { name: "WorkBuddy 启用状态" });
    expect(sourceToggle).not.toBeChecked();
    expect(screen.getByLabelText("WorkBuddy 认证后模型 在选择器中显示")).toBeInTheDocument();
    expect(updateEnabled).not.toHaveBeenCalled();
    expect(logout).not.toHaveBeenCalled();
    expect(prepareExecutor).not.toHaveBeenCalled();
  });

  it("shows named models immediately when an already connected catalog is available", async () => {
    const { login, view, props } = setup(readyBuddy);
    fireEvent.click(await screen.findByRole("button", { name: "WorkBuddy 连接设置" }));
    expect(await screen.findByLabelText("WorkBuddy 目录模型 在选择器中显示")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "连接 · WorkBuddy" })).not.toBeInTheDocument();
    expect(login).not.toHaveBeenCalled();
    view.rerender(<ChatProvidersSettings {...props} settings={{ ...settings }} />);
    expect(screen.getByLabelText("WorkBuddy 目录模型 在选择器中显示")).toBeInTheDocument();
  });

  it("keeps WorkBuddy sorting and visibility controls under the filter icon", async () => {
    useModelPreferences.setState({ hiddenNative: [], providerOrder: [] });
    const sortedBuddy: DevExecutor = {
      ...readyBuddy,
      models: [{ id: "z-model", label: "Zeta" }, { id: "a-model", label: "Alpha" }],
      probe: { ...readyBuddy.probe!, defaultModel: "z-model" },
    };
    const { login } = setup(sortedBuddy);
    fireEvent.click(await screen.findByRole("button", { name: "WorkBuddy 连接设置" }));
    expect(await screen.findByLabelText("WorkBuddy Zeta 在选择器中显示")).toBeInTheDocument();
    expect(login).not.toHaveBeenCalled();

    const filter = screen.getByRole("button", { name: "筛选模型" });
    expect(filter.querySelector("svg.lucide-filter")).not.toBeNull();
    const openFilter = () => fireEvent.pointerDown(filter, {
      button: 0, ctrlKey: false, pointerType: "mouse",
    });
    openFilter();
    expect(screen.getByRole("menuitemradio", { name: "按品牌分组" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "按名称排序" }));
    expect(screen.getByText("Alpha").compareDocumentPosition(screen.getByText("Zeta")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const keys = ["z-model", "a-model"].map((model) => modelKey({ provider: "native:codebuddy", model, executor: "codebuddy" }));
    openFilter();
    fireEvent.click(screen.getByRole("menuitem", { name: "全部隐藏" }));
    await waitFor(() => expect(useModelPreferences.getState().hiddenNative).toEqual(keys));
    openFilter();
    fireEvent.click(screen.getByRole("menuitem", { name: "全部显示" }));
    await waitFor(() => expect(useModelPreferences.getState().hiddenNative).toEqual([]));
  });

  it("turns WorkBuddy off without logging out or changing hidden model preferences", async () => {
    const modelPreference = modelKey({ provider: "native:codebuddy", model: "fixture-catalog-model", executor: "codebuddy" });
    useModelPreferences.setState({ hiddenNative: [modelPreference], providerOrder: [] });
    const engineSettings: ExecutorSettings = { ...defaultEngineSettings, enabledEngines: ["codebuddy"] };
    const { login, executorSettings: readEngineSettings } = setup({ ...readyBuddy, programAvailable: true }, resourceSnapshot(installedBuddyComponent), engineSettings);
    const save = vi.spyOn(developmentApi, "updateExecutorSettings").mockImplementation(async (current, values, enabledEngines) => {
      const saved: ExecutorSettings = { ...current, values: { ...current.values, ...values }, enabledEngines: enabledEngines ?? [] };
      readEngineSettings.mockResolvedValue(saved);
      return saved;
    });
    const logout = vi.spyOn(developmentApi, "logout").mockResolvedValue({ ok: true });

    fireEvent.click(await screen.findByRole("button", { name: "WorkBuddy 连接设置" }));
    const toggle = await screen.findByRole("switch", { name: "WorkBuddy 启用状态" });
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(toggle).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "未显示 1" }));
    const modelVisibility = screen.getByLabelText("WorkBuddy 目录模型 在选择器中显示");
    expect(modelVisibility).not.toBeChecked();

    fireEvent.click(toggle);
    await waitFor(() => expect(save).toHaveBeenCalledWith(engineSettings, {}, []));
    await waitFor(() => expect(screen.getByRole("switch", { name: "WorkBuddy 启用状态" })).not.toBeChecked());
    expect(screen.getByText("已认证")).toBeInTheDocument();
    expect(screen.getByLabelText("WorkBuddy 目录模型 在选择器中显示")).not.toBeChecked();
    expect(useModelPreferences.getState().hiddenNative).toEqual([modelPreference]);
    expect(logout).not.toHaveBeenCalled();
    expect(login).not.toHaveBeenCalled();
  });

  it("opens the official plan page and refreshes WorkBuddy on return without starting login", async () => {
    const { login, probe } = setup(readyBuddy);
    openExternalUrl.mockClear();
    fireEvent.click(await screen.findByRole("button", { name: "WorkBuddy 连接设置" }));

    expect(await screen.findByText(/在 Mona 中使用 WorkBuddy 的订阅模型/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看套餐" }));
    await waitFor(() => expect(openExternalUrl).toHaveBeenCalledWith("https://www.codebuddy.cn/pricing/"));
    await waitFor(() => expect(probe).toHaveBeenCalledTimes(1));

    probe.mockClear();
    act(() => {
      fireEvent.focus(window);
      fireEvent(document, new Event("visibilitychange"));
    });
    await waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
    expect(login).not.toHaveBeenCalled();
  });

  it("shows a retryable alert when the official plan page cannot open", async () => {
    const { login } = setup(readyBuddy);
    openExternalUrl.mockClear();
    openExternalUrl.mockRejectedValueOnce(new Error("synthetic opener failure"));
    fireEvent.click(await screen.findByRole("button", { name: "WorkBuddy 连接设置" }));
    fireEvent.click(await screen.findByRole("button", { name: "查看套餐" }));

    const dialog = await screen.findByRole("alertdialog", { name: "套餐页面打不开" });
    expect(within(dialog).getByText("无法打开 WorkBuddy 套餐页面，请稍后重试。")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "关闭" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "重试" })).toBeInTheDocument();
    expect(dialog).not.toHaveTextContent("synthetic opener failure");
    expect(openExternalUrl).toHaveBeenCalledWith("https://www.codebuddy.cn/pricing/");
    expect(login).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "重试" }));
    await waitFor(() => expect(openExternalUrl).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("alertdialog", { name: "套餐页面打不开" })).not.toBeInTheDocument());
    expect(login).not.toHaveBeenCalled();
  });

  it("offers separate component and WorkBuddy app paths when no component is available", async () => {
    const { login, probe, engineResources, prepareExecutor } = setup(
      { ...buddy, available: false, programAvailable: false, executable: undefined, reason: "尚未准备必要组件" },
      resourceSnapshot(absentBuddyComponent),
      { ...defaultEngineSettings, enabledEngines: [] },
    );
    const source = await screen.findByRole("button", { name: "WorkBuddy 连接设置" });
    expect(within(source).getByText("待准备")).toBeInTheDocument();
    fireEvent.click(source);
    expect(await screen.findByRole("button", { name: "下载必要组件" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "下载 WorkBuddy 应用" })).toBeEnabled();
    expect(screen.getByText("无需安装 WorkBuddy 应用，只下载必要组件。")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "WorkBuddy", exact: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "管理引擎" })).toBeEnabled();
    expect(screen.queryByPlaceholderText("搜索模型")).not.toBeInTheDocument();
    expect(screen.getByText("准备就绪后，这里会显示可用模型")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(login).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "下载 WorkBuddy 应用" }));
    await waitFor(() => expect(openExternalUrl).toHaveBeenCalledWith("https://www.codebuddy.cn/work/"));
    expect(prepareExecutor).not.toHaveBeenCalled();

    engineResources.mockResolvedValueOnce(resourceSnapshot(absentBuddyComponent))
      .mockResolvedValueOnce(resourceSnapshot(installedBuddyComponent));
    prepareExecutor.mockResolvedValueOnce({ installed: true, job: null });
    fireEvent.click(screen.getByRole("button", { name: "下载必要组件" }));
    await waitFor(() => expect(prepareExecutor).toHaveBeenCalledWith("codebuddy", "codebuddy-pack", false));
    await waitFor(() => expect(engineResources).toHaveBeenCalledWith("codebuddy", true));
    expect(openExternalUrl).toHaveBeenCalledTimes(1);
  });

  it("offers Claude Code component setup inline when the program is missing", async () => {
    const { login, probe, engineResources } = setup({ ...buddy, id: "claude", name: "Claude Code",
      available: false, programAvailable: false, executable: undefined, models: [] },
      resourceSnapshot({ ...absentBuddyComponent, executor: "claude" }));
    const source = await screen.findByRole("button", { name: /Anthropic/ });
    fireEvent.click(source);

    expect(await screen.findByRole("heading", { name: "Anthropic", exact: true })).toBeInTheDocument();
    expect(source).toHaveAttribute("aria-current", "true");
    expect(await screen.findByRole("button", { name: "下载必要组件" })).toBeEnabled();
    const managementButton = screen.getByRole("button", { name: "管理引擎" });
    expect(managementButton).toBeEnabled();
    fireEvent.click(managementButton);
    const management = await screen.findByRole("dialog", { name: "管理引擎 · Claude Code" });
    expect(await within(within(management).getByRole("region", { name: "Mona 托管引擎" })).findByText("未安装")).toBeInTheDocument();
    expect(engineResources).toHaveBeenCalledWith("claude", true);
    expect(login).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });

  it("keeps account and model state in the detail area without sidebar indicators", async () => {
    const ready: DevExecutor = { ...buddy, models: [...buddy.models, { id: "catalog-model", label: "真实目录模型", contextWindow: 192000 }],
      probe: { state: "ready", reason: "账号和目录已同步", authentication: "ready", protocolVerified: true, modelCatalogState: "ready", defaultModel: "catalog-model" } };
    const { login, probe } = setup(ready);
    probe.mockResolvedValue(ready.probe!);
    fireEvent.click(await screen.findByRole("button", { name: "WorkBuddy 连接设置" }));
    expect(await screen.findByLabelText("WorkBuddy 真实目录模型 在选择器中显示")).toBeInTheDocument();
    expect(screen.getByText("已认证")).toBeInTheDocument();
    const source = screen.getByRole("button", { name: "WorkBuddy 连接设置" });
    expect(within(source).queryByText("1 个模型")).not.toBeInTheDocument();
    expect(within(source).queryByLabelText("已连接")).not.toBeInTheDocument();
    expect(screen.queryByText("192K")).not.toBeInTheDocument();
    expect(screen.queryByText("当前默认：catalog-model")).not.toBeInTheDocument();
    expect(login).not.toHaveBeenCalled();
  });

  it("keeps the WorkBuddy switch when authentication succeeded, and refreshes a failed catalog without login", async () => {
    const unavailable: DevExecutor = { ...buddy, models: [], probe: { state: "detected", reason: "模型目录同步失败", authentication: "ready", protocolVerified: true, modelCatalogState: "unavailable" } };
    const { login, providers, probe } = setup(unavailable);
    fireEvent.click(await screen.findByRole("button", { name: "WorkBuddy 连接设置" }));
    expect(await screen.findByRole("switch", { name: "WorkBuddy 启用状态" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "认证 WorkBuddy" })).not.toBeInTheDocument();
    expect(screen.queryByText("模型目录同步失败")).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText("搜索模型")).toBeInTheDocument();
    expect(screen.getByText("暂未获取模型信息")).toBeInTheDocument();
    await waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
    const ready = { ...unavailable, models: [{ id: "new-model", label: "同步结果" }],
      probe: { ...unavailable.probe!, state: "ready", modelCatalogState: "ready" as const } };
    providers.mockResolvedValue({ executors: [ready] });
    probe.mockClear();
    probe.mockResolvedValue(ready.probe);
    fireEvent.click(screen.getByRole("button", { name: "刷新模型" }));
    await waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
    expect(await screen.findByLabelText("WorkBuddy 同步结果 在选择器中显示")).toBeInTheDocument();
    expect(screen.getByLabelText("WorkBuddy 启用状态")).toBeInTheDocument();
    expect(login).not.toHaveBeenCalled();
  });

  it("filters the extra source in the same provider list", async () => {
    setup();
    await screen.findByRole("button", { name: "WorkBuddy 连接设置" });
    fireEvent.change(screen.getByPlaceholderText("搜索供应商"), { target: { value: "WorkBuddy" } });
    expect(screen.getByRole("button", { name: "WorkBuddy 连接设置" })).toBeInTheDocument();
    expect(within(screen.getByRole("complementary")).queryByRole("button", { name: /Mona AI/ })).not.toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("搜索供应商"), { target: { value: "CodeBuddy" } });
    expect(screen.getByRole("button", { name: "WorkBuddy 连接设置" })).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("搜索供应商"), { target: { value: "Mona" } });
    expect(screen.queryByRole("button", { name: "WorkBuddy 连接设置" })).not.toBeInTheDocument();
  });
});
