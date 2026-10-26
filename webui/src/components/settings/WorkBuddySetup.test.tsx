import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkBuddySetup } from "./WorkBuddySetup";
import {
  developmentApi,
  type DevExecutor,
  type EngineInstallJob,
  type EngineResource,
  type EngineResources,
} from "@/lib/development-api";

const openExternalUrl = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  openExternalUrl,
}));

const absentResource = (overrides: Partial<EngineResource> = {}): EngineResource => ({
  executor: "codebuddy",
  source: "not_detected",
  executable: null,
  systemAvailable: false,
  installed: false,
  managedInstalled: false,
  canPrepare: true,
  canUpdate: false,
  repairRequired: false,
  explicitPath: false,
  packRef: "codebuddy-pack",
  version: "v1",
  installedVersion: null,
  downloadBytes: 4096,
  reason: "",
  job: null,
  ...overrides,
});

const installedResource = (overrides: Partial<EngineResource> = {}) => absentResource({
  source: "managed_runtime",
  executable: "test/codebuddy",
  installed: true,
  managedInstalled: true,
  canPrepare: false,
  canUpdate: false,
  ...overrides,
});

const managedResource = (overrides: Partial<EngineResource> = {}) => installedResource({
  managedExecutable: "managed-codebuddy",
  managedVersion: "managed-v1",
  usingManaged: true,
  canDelete: true,
  ...overrides,
});

const snapshot = (resource: EngineResource | null, catalogAvailable = true): EngineResources => ({
  components: resource ? [resource] : [],
  catalogAvailable,
});

const pendingJob: EngineInstallJob = {
  id: "job-1",
  state: "running",
  stage: "downloading",
  downloadedBytes: 512,
  totalBytes: 1024,
};

const buddy = (overrides: Partial<DevExecutor> = {}): DevExecutor => ({
  id: "codebuddy",
  name: "CodeBuddy",
  available: false,
  programAvailable: false,
  reason: "",
  models: [],
  probe: { state: "unknown", reason: "", authentication: "unknown", modelCatalogState: "unknown" },
  ...overrides,
});

function renderSetup(props: Partial<ComponentProps<typeof WorkBuddySetup>> = {}) {
  const onChanged = vi.fn();
  const onEnabledChange = vi.fn();
  const view = render(<WorkBuddySetup
    executor={buddy()}
    enabled={false}
    enableBusy={false}
    enableAvailable
    onEnabledChange={onEnabledChange}
    onChanged={onChanged}
    {...props}
  />);
  return { ...view, onChanged, onEnabledChange };
}

async function chooseUninstall() {
  const management = await screen.findByRole("button", { name: "管理引擎" });
  fireEvent.click(management);
  const dialog = await screen.findByRole("dialog", { name: "管理引擎 · WorkBuddy" });
  fireEvent.click(within(dialog).getByRole("button", { name: "卸载托管引擎" }));
  return screen.findByRole("alertdialog", { name: "卸载 Mona 下载的组件？" });
}

beforeEach(() => {
  vi.spyOn(developmentApi, "engineResources").mockResolvedValue(snapshot(absentResource()));
  vi.spyOn(developmentApi, "prepareExecutor").mockResolvedValue({ installed: false, job: null });
  vi.spyOn(developmentApi, "executorInstall").mockResolvedValue(pendingJob);
  vi.spyOn(developmentApi, "cancelExecutorInstall").mockResolvedValue({ ...pendingJob, state: "cancelled" });
  vi.spyOn(developmentApi, "deleteManagedExecutor").mockResolvedValue({ deleted: true });
  vi.spyOn(developmentApi, "refreshNativeProviders").mockImplementation(() => {});
  vi.spyOn(developmentApi, "probe").mockResolvedValue({
    state: "ready", reason: "", authentication: "ready", protocolVerified: true, modelCatalogState: "ready",
  });
  vi.spyOn(developmentApi, "loginStatus").mockResolvedValue({ loginId: null, state: "idle", authUrl: "", reason: "" });
  vi.spyOn(developmentApi, "login").mockResolvedValue({ loginId: "login-1", state: "waiting", authUrl: "https://example.test", reason: "等待认证" });
  vi.spyOn(developmentApi, "cancelLogin").mockResolvedValue({ loginId: "login-1", state: "cancelled", authUrl: "", reason: "已取消" });
  openExternalUrl.mockReset();
  openExternalUrl.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("WorkBuddySetup", () => {
  it.each([
    { app: false, managed: true, usingManaged: true, system: false, appStatus: "未检测到", engineStatus: "已安装", current: "Mona 托管引擎", canDelete: true },
    { app: true, managed: false, usingManaged: false, system: true, appStatus: "已安装", engineStatus: "未安装", current: "本机已有引擎", canDelete: false },
    { app: true, managed: true, usingManaged: false, system: true, appStatus: "已安装", engineStatus: "已安装", current: "本机已有引擎", canDelete: true },
    { app: true, managed: true, usingManaged: true, system: false, appStatus: "已安装", engineStatus: "已安装", current: "Mona 托管引擎", canDelete: true },
  ])("separates application, managed engine, and active engine: $app/$managed/$usingManaged", async ({ app, managed, usingManaged, system, appStatus, engineStatus, current, canDelete }) => {
    vi.mocked(developmentApi.engineResources).mockResolvedValue(snapshot(installedResource({
      desktopAppDetected: app, usingManaged, managedInstalled: managed, canDelete: managed, systemAvailable: system,
      managedExecutable: managed ? "managed-codebuddy" : null,
      managedVersion: managed ? "managed-v1" : null,
      executable: usingManaged ? "managed-codebuddy" : system ? "system-codebuddy" : "test/codebuddy",
    })));
    renderSetup({ executor: buddy({
      programAvailable: true,
      probe: { state: "ready", reason: "", authentication: "ready", modelCatalogState: "ready" },
    }) });
    expect(await screen.findByRole("heading", { name: "WorkBuddy 已准备就绪" })).toBeInTheDocument();
    expect(screen.queryByText("未检测到 WorkBuddy 应用")).not.toBeInTheDocument();
    expect(screen.queryByText("Mona 托管引擎")).not.toBeInTheDocument();
    expect(screen.queryByText("本机已有引擎")).not.toBeInTheDocument();
    const management = screen.getByRole("button", { name: "管理引擎" });
    expect(management).toBeEnabled();
    fireEvent.click(management);
    const dialog = await screen.findByRole("dialog", { name: "管理引擎 · WorkBuddy" });
    const appRegion = within(dialog).getByRole("region", { name: "WorkBuddy 应用" });
    const engineRegion = within(dialog).getByRole("region", { name: "Mona 托管引擎" });
    const currentRegion = within(dialog).getByRole("region", { name: "当前使用" });
    expect(await within(appRegion).findByText(appStatus)).toBeInTheDocument();
    expect(await within(engineRegion).findByText(engineStatus)).toBeInTheDocument();
    expect(await within(currentRegion).findByText(current)).toBeInTheDocument();
    const uninstall = within(engineRegion).queryByRole("button", { name: "卸载托管引擎" });
    if (!managed) expect(uninstall).not.toBeInTheDocument();
    else if (canDelete) expect(uninstall).toBeEnabled();
    else if (uninstall) expect(uninstall).toBeDisabled();
    expect(developmentApi.deleteManagedExecutor).not.toHaveBeenCalled();
  });

  it("force-refreshes management state each time the dialog opens", async () => {
    vi.mocked(developmentApi.engineResources)
      .mockResolvedValueOnce(snapshot(installedResource({ desktopAppDetected: false, usingManaged: true })))
      .mockResolvedValueOnce(snapshot(installedResource({ desktopAppDetected: false, usingManaged: true })))
      .mockResolvedValueOnce(snapshot(installedResource({ desktopAppDetected: true, usingManaged: true })));
    renderSetup({ executor: buddy({
      programAvailable: true,
      probe: { state: "ready", reason: "", authentication: "ready", modelCatalogState: "ready" },
    }) });

    expect(await screen.findByRole("heading", { name: "WorkBuddy 已准备就绪" })).toBeInTheDocument();
    const management = await screen.findByRole("button", { name: "管理引擎" });
    fireEvent.click(management);
    let dialog = await screen.findByRole("dialog", { name: "管理引擎 · WorkBuddy" });
    expect(await within(within(dialog).getByRole("region", { name: "WorkBuddy 应用" })).findByText("未检测到")).toBeInTheDocument();
    await waitFor(() => expect(developmentApi.engineResources).toHaveBeenCalledWith("codebuddy", true));
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "管理引擎 · WorkBuddy" })).not.toBeInTheDocument());

    fireEvent.click(management);
    dialog = await screen.findByRole("dialog", { name: "管理引擎 · WorkBuddy" });
    expect(await within(within(dialog).getByRole("region", { name: "WorkBuddy 应用" })).findByText("已安装")).toBeInTheDocument();
    expect(developmentApi.engineResources).toHaveBeenCalledTimes(3);
    expect(developmentApi.engineResources).toHaveBeenNthCalledWith(2, "codebuddy", true);
    expect(developmentApi.engineResources).toHaveBeenNthCalledWith(3, "codebuddy", true);
  });

  it("keeps both installation states unknown when a forced management read fails", async () => {
    vi.mocked(developmentApi.engineResources)
      .mockResolvedValueOnce(snapshot(managedResource({ desktopAppDetected: true, usingManaged: true })))
      .mockRejectedValueOnce(new Error("sensitive resource failure"))
      .mockResolvedValueOnce(snapshot(absentResource({ desktopAppDetected: false })));
    renderSetup({ executor: buddy({
      programAvailable: true,
      probe: { state: "ready", reason: "", authentication: "ready", modelCatalogState: "ready" },
    }) });

    expect(await screen.findByRole("heading", { name: "WorkBuddy 已准备就绪" })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "管理引擎" }));
    const dialog = await screen.findByRole("dialog", { name: "管理引擎 · WorkBuddy" });
    expect(await within(within(dialog).getByRole("region", { name: "WorkBuddy 应用" })).findByText("状态未确认")).toBeInTheDocument();
    expect(await within(within(dialog).getByRole("region", { name: "Mona 托管引擎" })).findByText("状态未确认")).toBeInTheDocument();
    expect(await within(within(dialog).getByRole("region", { name: "当前使用" })).findByText("状态未确认")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "重新检测" })).toBeInTheDocument();
    expect(within(dialog).queryByText("已安装")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("未安装")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("未检测到")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("sensitive resource failure")).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "重新检测" }));
    await waitFor(() => expect(developmentApi.engineResources).toHaveBeenNthCalledWith(3, "codebuddy", true));
    expect(await within(within(dialog).getByRole("region", { name: "WorkBuddy 应用" })).findByText("未检测到")).toBeInTheDocument();
    expect(await within(within(dialog).getByRole("region", { name: "Mona 托管引擎" })).findByText("未安装")).toBeInTheDocument();
  });

  it("offers an application recheck and makes the managed engine optional when app components are unavailable", async () => {
    vi.mocked(developmentApi.engineResources).mockResolvedValue(snapshot(absentResource({ desktopAppDetected: true })));
    renderSetup();
    expect(await screen.findByRole("heading", { name: "暂未能使用 WorkBuddy 应用" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新检查" })).toBeEnabled();
    expect(screen.getByText("也可使用 Mona 托管引擎")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "下载必要组件" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "下载 WorkBuddy 应用" })).not.toBeInTheDocument();
  });

  it.each([false, true])("uses the application even when the managed copy is absent or needs repair: %s", async (repairRequired) => {
    vi.mocked(developmentApi.engineResources).mockResolvedValue(snapshot(installedResource({
      source: "desktop_application", executable: "WorkBuddy/resources/app.asar.unpacked/cli/bin/codebuddy",
      desktopAppDetected: true, systemAvailable: true, managedInstalled: repairRequired, repairRequired, usingManaged: false,
    })));
    renderSetup();

    expect(await screen.findByRole("heading", { name: "使用 WorkBuddy 订阅的条件已就绪" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "认证 WorkBuddy" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "下载必要组件" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "管理引擎" }));
    const dialog = await screen.findByRole("dialog", { name: "管理引擎 · WorkBuddy" });
    expect(await within(within(dialog).getByRole("region", { name: "当前使用" })).findByText("WorkBuddy 应用")).toBeInTheDocument();
    expect(await within(within(dialog).getByRole("region", { name: "Mona 托管引擎" })).findByText(repairRequired ? "需修复" : "未安装")).toBeInTheDocument();
    expect(developmentApi.prepareExecutor).not.toHaveBeenCalled();
  });

  it("offers the two separate setup paths when the component is absent", async () => {
    renderSetup();

    expect(await screen.findByRole("heading", { name: "不安装应用，也能使用订阅" })).toBeInTheDocument();
    expect(screen.getByText("两种方式任选其一，无需重复下载。")).toBeInTheDocument();
    expect(screen.getByText("在 Mona 中使用订阅")).toBeInTheDocument();
    expect(screen.getByText("推荐")).toBeInTheDocument();
    expect(screen.getByText("无需安装 WorkBuddy 应用，只下载必要组件。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "下载必要组件" })).toBeEnabled();
    expect(screen.getByText("也想单独使用 WorkBuddy？")).toBeInTheDocument();
    expect(screen.getByText("前往官网选择并下载安装适合你的应用版本。")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "下载 WorkBuddy 应用" }));
    await waitFor(() => expect(openExternalUrl).toHaveBeenCalledWith("https://www.codebuddy.cn/work/"));
    expect(developmentApi.prepareExecutor).not.toHaveBeenCalled();
    expect(screen.queryByText(/CLI|runtime|Mona 管理/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "管理引擎" })).toBeEnabled();
  });

  it("disables component download when resources are unavailable and lets the user recheck", async () => {
    vi.mocked(developmentApi.engineResources)
      .mockResolvedValueOnce(snapshot(absentResource({ packRef: null, canPrepare: false }), false))
      .mockResolvedValueOnce(snapshot(absentResource()));
    renderSetup();

    expect(await screen.findByRole("button", { name: "下载必要组件" })).toBeDisabled();
    expect(screen.getByText("必要组件暂不可用，请重新检查。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重新检查" }));
    await waitFor(() => expect(developmentApi.engineResources).toHaveBeenCalledWith("codebuddy", true));
    await waitFor(() => expect(screen.getByRole("button", { name: "下载必要组件" })).toBeEnabled());
  });

  it("resumes an existing job, confirms installed state, and never enables WorkBuddy automatically", async () => {
    vi.mocked(developmentApi.engineResources)
      .mockResolvedValueOnce(snapshot(absentResource({ job: pendingJob })))
      .mockResolvedValueOnce(snapshot(installedResource()));
    vi.mocked(developmentApi.executorInstall).mockResolvedValueOnce({ ...pendingJob, state: "completed", downloadedBytes: 1024 });
    const onChanged = vi.fn();
    const onEnabledChange = vi.fn();
    renderSetup({
      executor: buddy({
        programAvailable: false,
        probe: { state: "ready", reason: "", authentication: "ready", modelCatalogState: "unavailable" },
      }),
      onChanged,
      onEnabledChange,
    });

    await waitFor(() => expect(developmentApi.executorInstall).toHaveBeenCalledWith("codebuddy", "job-1"), { timeout: 3000 });
    await waitFor(() => expect(screen.getByRole("heading", { name: "WorkBuddy 已准备就绪" })).toBeInTheDocument());
    expect(developmentApi.prepareExecutor).not.toHaveBeenCalled();
    expect(developmentApi.refreshNativeProviders).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onEnabledChange).not.toHaveBeenCalled();
    expect(screen.getByRole("switch", { name: "WorkBuddy 启用状态" })).toBeInTheDocument();
  });

  it("confirms availability when prepare returns an already completed job", async () => {
    vi.mocked(developmentApi.engineResources)
      .mockResolvedValueOnce(snapshot(absentResource()))
      .mockResolvedValueOnce(snapshot(absentResource()))
      .mockResolvedValueOnce(snapshot(installedResource()));
    vi.mocked(developmentApi.prepareExecutor).mockResolvedValueOnce({
      installed: false,
      job: { ...pendingJob, state: "completed", downloadedBytes: 1024 },
    });
    const { onChanged } = renderSetup({
      executor: buddy({ programAvailable: false, probe: { state: "ready", reason: "", authentication: "ready" } }),
    });

    fireEvent.click(await screen.findByRole("button", { name: "下载必要组件" }));
    expect(await screen.findByRole("heading", { name: "WorkBuddy 已准备就绪" })).toBeInTheDocument();
    expect(developmentApi.executorInstall).not.toHaveBeenCalled();
    expect(developmentApi.refreshNativeProviders).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("shows a safe retry state when prepare returns a failed job", async () => {
    vi.mocked(developmentApi.engineResources)
      .mockResolvedValueOnce(snapshot(absentResource()))
      .mockResolvedValueOnce(snapshot(absentResource()));
    vi.mocked(developmentApi.prepareExecutor).mockResolvedValueOnce({
      installed: false,
      job: { ...pendingJob, state: "failed", error: "sensitive job detail" },
    });
    renderSetup();

    fireEvent.click(await screen.findByRole("button", { name: "下载必要组件" }));
    const dialog = await screen.findByRole("alertdialog", { name: "准备未能完成" });
    expect(dialog).not.toHaveTextContent("sensitive job detail");
    expect(within(dialog).getByRole("button", { name: "重新检查" })).toBeInTheDocument();
    expect(developmentApi.executorInstall).not.toHaveBeenCalled();
  });

  it("rechecks only the component on visible resume and refreshes the parent after availability changes", async () => {
    let resolveRefresh!: (value: EngineResources) => void;
    vi.mocked(developmentApi.engineResources)
      .mockResolvedValueOnce(snapshot(absentResource()))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveRefresh = resolve; }));
    const { onChanged, onEnabledChange } = renderSetup();
    expect(await screen.findByRole("heading", { name: "不安装应用，也能使用订阅" })).toBeInTheDocument();

    const originalVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
    try {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      act(() => {
        window.dispatchEvent(new Event("focus"));
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(developmentApi.engineResources).toHaveBeenCalledTimes(1);

      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      act(() => {
        window.dispatchEvent(new Event("focus"));
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await waitFor(() => expect(developmentApi.engineResources).toHaveBeenCalledWith("codebuddy", true));
      expect(developmentApi.engineResources).toHaveBeenCalledTimes(2);
      await act(async () => { resolveRefresh(snapshot(installedResource())); });
      await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
      expect(developmentApi.refreshNativeProviders).toHaveBeenCalledTimes(1);
      expect(developmentApi.prepareExecutor).not.toHaveBeenCalled();
      expect(onEnabledChange).not.toHaveBeenCalled();
    } finally {
      if (originalVisibility) Object.defineProperty(document, "visibilityState", originalVisibility);
      else Reflect.deleteProperty(document, "visibilityState");
    }
  });

  it("gates enablement on authentication, not catalog availability, and honors enable props", async () => {
    vi.mocked(developmentApi.engineResources).mockResolvedValue(snapshot(installedResource()));
    const props = {
      executor: buddy({
        programAvailable: true,
        probe: { state: "detected", reason: "", authentication: "unknown", modelCatalogState: "unknown" },
      }),
      enableAvailable: false,
    };
    const view = renderSetup(props);

    expect(await screen.findByText("账号尚未认证")).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "WorkBuddy 启用状态" })).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "认证 WorkBuddy" })).toBeEnabled();

    view.rerender(<WorkBuddySetup
      executor={buddy({
        programAvailable: true,
        probe: { state: "detected", reason: "", authentication: "ready", modelCatalogState: "unavailable" },
      })}
      enabled={false}
      enableBusy={false}
      enableAvailable={false}
      onEnabledChange={view.onEnabledChange}
      onChanged={view.onChanged}
    />);
    const toggle = screen.getByRole("switch", { name: "WorkBuddy 启用状态" });
    expect(screen.getByText("已认证")).toBeInTheDocument();
    expect(screen.queryByText("在 Mona 中使用 WorkBuddy")).not.toBeInTheDocument();
    expect(screen.queryByText("关闭后保留认证，随时可以重新开启")).not.toBeInTheDocument();
    expect(toggle).toBeDisabled();

    view.rerender(<WorkBuddySetup
      executor={buddy({
        programAvailable: true,
        probe: { state: "detected", reason: "", authentication: "ready", modelCatalogState: "unavailable" },
      })}
      enabled={false}
      enableBusy
      enableAvailable
      onEnabledChange={view.onEnabledChange}
      onChanged={view.onChanged}
    />);
    expect(screen.getByRole("switch", { name: "WorkBuddy 启用状态" })).toBeDisabled();

    view.rerender(<WorkBuddySetup
      executor={buddy({
        programAvailable: true,
        probe: { state: "detected", reason: "", authentication: "ready", modelCatalogState: "unavailable" },
      })}
      enabled={false}
      enableBusy={false}
      enableAvailable
      onEnabledChange={view.onEnabledChange}
      onChanged={view.onChanged}
    />);
    fireEvent.click(screen.getByRole("switch", { name: "WorkBuddy 启用状态" }));
    expect(view.onEnabledChange).toHaveBeenCalledWith(true);
  });

  it.each([
    {
      name: "a system copy",
      resource: installedResource({ source: "path", systemAvailable: true, managedInstalled: false, canDelete: true }),
    },
    {
      name: "a managed copy without delete permission",
      resource: managedResource({ canDelete: false }),
    },
  ])("keeps management readable for $name without offering uninstall", async ({ resource }) => {
    vi.mocked(developmentApi.engineResources).mockResolvedValue(snapshot(resource));
    renderSetup({ executor: buddy({
      programAvailable: true,
      probe: { state: "ready", reason: "", authentication: "ready", modelCatalogState: "ready" },
    }) });

    expect(await screen.findByRole("heading", { name: "WorkBuddy 已准备就绪" })).toBeInTheDocument();
    const management = screen.getByRole("button", { name: "管理引擎" });
    expect(management).toBeEnabled();
    fireEvent.click(management);
    const dialog = await screen.findByRole("dialog", { name: "管理引擎 · WorkBuddy" });
    const engineRegion = within(dialog).getByRole("region", { name: "Mona 托管引擎" });
    const uninstall = within(engineRegion).queryByRole("button", { name: "卸载托管引擎" });
    if (!resource.managedInstalled) expect(uninstall).not.toBeInTheDocument();
    else if (resource.canDelete) expect(uninstall).toBeDisabled();
    else if (uninstall) expect(uninstall).toBeDisabled();
    expect(developmentApi.deleteManagedExecutor).not.toHaveBeenCalled();
  });

  it("installs a Mona-managed engine from management even when the system engine is already available", async () => {
    const systemResource = installedResource({
      source: "path", executable: "system-codebuddy", systemAvailable: true,
      managedInstalled: false, managedExecutable: null, managedVersion: null,
      usingManaged: false, canPrepare: true, canDelete: false,
    });
    const managedCopy = installedResource({
      source: "path", executable: "system-codebuddy", systemAvailable: true,
      managedInstalled: true, managedExecutable: "managed-codebuddy", managedVersion: "managed-v1",
      usingManaged: false, canPrepare: false, canDelete: true,
    });
    vi.mocked(developmentApi.engineResources)
      .mockResolvedValueOnce(snapshot(systemResource))
      .mockResolvedValueOnce(snapshot(systemResource))
      .mockResolvedValueOnce(snapshot(systemResource))
      .mockResolvedValueOnce(snapshot(managedCopy));
    vi.mocked(developmentApi.prepareExecutor).mockResolvedValueOnce({ installed: true, job: null });
    const { onChanged, onEnabledChange } = renderSetup({ executor: buddy({
      available: true,
      programAvailable: true,
      probe: { state: "ready", reason: "", authentication: "ready", modelCatalogState: "ready" },
    }) });

    expect(await screen.findByRole("heading", { name: "WorkBuddy 已准备就绪" })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "管理引擎" }));
    const dialog = await screen.findByRole("dialog", { name: "管理引擎 · WorkBuddy" });
    const engineRegion = within(dialog).getByRole("region", { name: "Mona 托管引擎" });
    expect(await within(engineRegion).findByText("未安装")).toBeInTheDocument();
    const install = within(engineRegion).getByRole("button", { name: "安装托管引擎" });
    expect(install).toBeEnabled();
    fireEvent.click(install);

    await waitFor(() => expect(developmentApi.prepareExecutor).toHaveBeenCalledWith("codebuddy", "codebuddy-pack", false));
    expect(await within(engineRegion).findByText("已安装")).toBeInTheDocument();
    expect(await within(within(dialog).getByRole("region", { name: "当前使用" })).findByText("本机已有引擎")).toBeInTheDocument();
    expect(developmentApi.engineResources).toHaveBeenCalledTimes(4);
    expect(developmentApi.engineResources).toHaveBeenNthCalledWith(2, "codebuddy", true);
    expect(developmentApi.engineResources).toHaveBeenNthCalledWith(3, "codebuddy", true);
    expect(developmentApi.engineResources).toHaveBeenNthCalledWith(4, "codebuddy", true);
    expect(onEnabledChange).not.toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("allows read-only management while preparation is active", async () => {
    vi.mocked(developmentApi.engineResources).mockResolvedValue(snapshot(managedResource({ job: pendingJob })));
    renderSetup({ executor: buddy({
      programAvailable: true,
      probe: { state: "ready", reason: "", authentication: "ready", modelCatalogState: "ready" },
    }) });

    const management = await screen.findByRole("button", { name: "管理引擎" });
    expect(management).toBeEnabled();
    fireEvent.click(management);
    const dialog = await screen.findByRole("dialog", { name: "管理引擎 · WorkBuddy" });
    const uninstall = within(within(dialog).getByRole("region", { name: "Mona 托管引擎" }))
      .queryByRole("button", { name: "卸载托管引擎" });
    if (uninstall) expect(uninstall).toBeDisabled();
    expect(developmentApi.deleteManagedExecutor).not.toHaveBeenCalled();
  });

  it("starts reauthentication in place with one click and ignores historical completion text", async () => {
    vi.mocked(developmentApi.engineResources).mockResolvedValue(snapshot(managedResource()));
    let completeLogin!: () => void;
    const completedLogin = new Promise<Awaited<ReturnType<typeof developmentApi.loginStatus>>>((resolve) => {
      completeLogin = () => resolve({ loginId: "new-login", state: "succeeded", authUrl: "", reason: "本次认证已完成" });
    });
    vi.mocked(developmentApi.loginStatus).mockResolvedValueOnce({
      loginId: "previous-login",
      state: "succeeded",
      authUrl: "",
      reason: "官方认证流程已完成。请检查连接；这不是开发任务验收。",
    }).mockReturnValueOnce(completedLogin);
    vi.mocked(developmentApi.login).mockResolvedValueOnce({
      loginId: "new-login", state: "waiting", authUrl: "https://example.test/reauthorize", reason: "等待本次认证",
    });
    renderSetup({ executor: buddy({
      programAvailable: true,
      probe: { state: "ready", reason: "", authentication: "ready", modelCatalogState: "unavailable" },
    }) });

    expect(await screen.findByRole("heading", { name: "WorkBuddy 已准备就绪" })).toBeInTheDocument();
    const management = screen.getByRole("button", { name: "管理引擎" });
    expect(management).toBeEnabled();
    const reauthenticate = screen.getByRole("button", { name: "重新认证" });
    await waitFor(() => expect(reauthenticate).toBeEnabled());
    expect(developmentApi.login).not.toHaveBeenCalled();
    expect(screen.queryByText(/这不是开发任务验收/)).not.toBeInTheDocument();
    expect(developmentApi.probe).not.toHaveBeenCalled();
    expect(management).toBeEnabled();
    expect(screen.getByRole("heading", { name: "WorkBuddy 已准备就绪" })).toBeInTheDocument();

    fireEvent.click(reauthenticate);
    await waitFor(() => expect(developmentApi.login).toHaveBeenCalledWith(undefined, "codebuddy"));
    await waitFor(() => expect(openExternalUrl).toHaveBeenCalledWith("https://example.test/reauthorize"));
    expect(screen.getByText("等待浏览器认证…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "取消认证" })).toBeEnabled();
    expect(screen.queryByText("已认证")).not.toBeInTheDocument();
    await waitFor(() => expect(management).toBeEnabled());
    fireEvent.click(management);
    const managementDialog = await screen.findByRole("dialog", { name: "管理引擎 · WorkBuddy" });
    const uninstall = within(within(managementDialog).getByRole("region", { name: "Mona 托管引擎" }))
      .queryByRole("button", { name: "卸载托管引擎" });
    if (uninstall) expect(uninstall).toBeDisabled();
    expect(developmentApi.deleteManagedExecutor).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "管理引擎 · WorkBuddy" })).not.toBeInTheDocument());
    await act(async () => { completeLogin(); await completedLogin; });
    await waitFor(() => expect(screen.getByRole("button", { name: "重新认证" })).toBeEnabled());
    expect(screen.getByText("已认证")).toBeInTheDocument();
    expect(screen.queryByText("等待浏览器认证…")).not.toBeInTheDocument();
    expect(screen.queryByText("本次认证已完成")).not.toBeInTheDocument();
    expect(screen.getAllByLabelText("WorkBuddy 官方登录")).toHaveLength(1);
    expect(developmentApi.login).toHaveBeenCalledTimes(1);
    expect(management).toBeEnabled();
  });

  it("cancels component removal without issuing a delete", async () => {
    vi.mocked(developmentApi.engineResources).mockResolvedValue(snapshot(managedResource()));
    renderSetup({ executor: buddy({
      programAvailable: true,
      probe: { state: "ready", reason: "", authentication: "ready", modelCatalogState: "ready" },
    }) });

    await chooseUninstall();
    const dialog = await screen.findByRole("alertdialog", { name: "卸载 Mona 下载的组件？" });
    expect(dialog).toHaveTextContent(/认证/);
    expect(dialog).toHaveTextContent(/会话/);
    expect(dialog).toHaveTextContent(/模型/);
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(developmentApi.deleteManagedExecutor).not.toHaveBeenCalled();
  });

  it.each(["path", "desktop_application"])("removes the managed copy and keeps the existing $source engine", async (source) => {
    const systemCopy = installedResource({
      source,
      desktopAppDetected: source === "desktop_application",
      executable: "system-codebuddy",
      systemAvailable: true,
      managedInstalled: false,
      usingManaged: false,
      managedExecutable: null,
      managedVersion: null,
      canDelete: false,
    });
    const calls: string[] = [];
    let deleted = false;
    vi.mocked(developmentApi.engineResources).mockImplementation(async (_executor, refresh = false) => {
      calls.push(refresh ? "read-refresh" : "read");
      return snapshot(deleted ? systemCopy : managedResource());
    });
    vi.mocked(developmentApi.deleteManagedExecutor).mockImplementationOnce(async (executor, version) => {
      calls.push("delete");
      expect(executor).toBe("codebuddy");
      expect(version).toBe("managed-v1");
      deleted = true;
      return { deleted: true };
    });
    const { onChanged } = renderSetup({ executor: buddy({
      programAvailable: true,
      probe: { state: "ready", reason: "", authentication: "ready", modelCatalogState: "ready" },
    }) });

    await chooseUninstall();
    const dialog = await screen.findByRole("alertdialog", { name: "卸载 Mona 下载的组件？" });
    fireEvent.click(within(dialog).getByRole("button", { name: "卸载组件" }));
    await waitFor(() => expect(developmentApi.deleteManagedExecutor).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole("button", { name: "管理引擎" })).toBeInTheDocument());
    expect(calls.indexOf("read-refresh")).toBeLessThan(calls.indexOf("delete"));
    expect(calls.lastIndexOf("read-refresh")).toBeGreaterThan(calls.indexOf("delete"));
    expect(screen.getByRole("switch", { name: "WorkBuddy 启用状态" })).toBeInTheDocument();
    expect(developmentApi.refreshNativeProviders).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "管理引擎" }));
    const management = await screen.findByRole("dialog", { name: "管理引擎 · WorkBuddy" });
    expect(await within(within(management).getByRole("region", { name: "当前使用" })).findByText(source === "desktop_application" ? "WorkBuddy 应用" : "本机已有引擎")).toBeInTheDocument();
    expect(await within(within(management).getByRole("region", { name: "Mona 托管引擎" })).findByText("未安装")).toBeInTheDocument();
  });

  it("restores component setup after removal when no system copy remains", async () => {
    const reads = [managedResource(), managedResource(), managedResource(), absentResource()];
    vi.mocked(developmentApi.engineResources).mockImplementation(async () => snapshot(reads.shift() ?? absentResource()));
    vi.mocked(developmentApi.deleteManagedExecutor).mockResolvedValueOnce({ deleted: true });
    renderSetup({ executor: buddy({
      programAvailable: true,
      probe: { state: "ready", reason: "", authentication: "ready", modelCatalogState: "ready" },
    }) });

    await chooseUninstall();
    const dialog = await screen.findByRole("alertdialog", { name: "卸载 Mona 下载的组件？" });
    fireEvent.click(within(dialog).getByRole("button", { name: "卸载组件" }));
    expect(await screen.findByRole("heading", { name: "不安装应用，也能使用订阅" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "下载必要组件" })).toBeEnabled();
    expect(screen.queryByRole("switch", { name: "WorkBuddy 启用状态" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "管理引擎" })).toBeInTheDocument();
    expect(developmentApi.deleteManagedExecutor).toHaveBeenCalledTimes(1);
    expect(developmentApi.prepareExecutor).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "下载必要组件" }));
    await waitFor(() => expect(developmentApi.prepareExecutor).toHaveBeenCalledWith("codebuddy", "codebuddy-pack", false));
  });

  it("does not delete when the managed version changes before confirmation", async () => {
    let forcedReads = 0;
    vi.mocked(developmentApi.engineResources).mockImplementation(async (_executor, refresh = false) => {
      const version = refresh && ++forcedReads > 1 ? "managed-v2" : "managed-v1";
      return snapshot(managedResource({ managedVersion: version }));
    });
    renderSetup({ executor: buddy({
      programAvailable: true,
      probe: { state: "ready", reason: "", authentication: "ready", modelCatalogState: "ready" },
    }) });

    await chooseUninstall();
    const dialog = await screen.findByRole("alertdialog");
    const confirm = within(dialog).queryByRole("button", { name: "卸载组件" });
    if (confirm) fireEvent.click(confirm);
    await waitFor(() => expect(screen.getByRole("alertdialog")).toHaveTextContent(/版本|状态|变化/));
    expect(developmentApi.deleteManagedExecutor).not.toHaveBeenCalled();
    expect(developmentApi.engineResources).toHaveBeenCalledWith("codebuddy", true);
  });

  it("keeps unknown removal results read-only on retry", async () => {
    vi.mocked(developmentApi.engineResources).mockResolvedValue(snapshot(managedResource()));
    vi.mocked(developmentApi.deleteManagedExecutor).mockResolvedValueOnce({ deleted: false });
    renderSetup({ executor: buddy({
      programAvailable: true,
      probe: { state: "ready", reason: "", authentication: "ready", modelCatalogState: "ready" },
    }) });

    await chooseUninstall();
    const dialog = await screen.findByRole("alertdialog", { name: "卸载 Mona 下载的组件？" });
    fireEvent.click(within(dialog).getByRole("button", { name: "卸载组件" }));
    const uncertain = await screen.findByRole("alertdialog", { name: "卸载结果待确认" });
    fireEvent.click(within(uncertain).getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "管理引擎" }));
    const management = await screen.findByRole("dialog", { name: "管理引擎 · WorkBuddy" });
    fireEvent.click(within(management).getByRole("button", { name: "重新检测" }));
    await waitFor(() => expect(developmentApi.engineResources).toHaveBeenCalledWith("codebuddy", true));
    expect(developmentApi.deleteManagedExecutor).toHaveBeenCalledTimes(1);
    expect(within(management).getByRole("region", { name: "Mona 托管引擎" })).toHaveTextContent("已安装");
  });

  it("probes after terminal login status before parent refresh and retries the probe without logging in again", async () => {
    const events: string[] = [];
    vi.mocked(developmentApi.loginStatus)
      .mockResolvedValueOnce({ loginId: null, state: "idle", authUrl: "", reason: "" })
      .mockResolvedValueOnce({ loginId: "new-login", state: "succeeded", authUrl: "", reason: "认证完成" });
    vi.mocked(developmentApi.login).mockResolvedValueOnce({
      loginId: "new-login", state: "waiting", authUrl: "", reason: "等待认证",
    });
    vi.mocked(developmentApi.probe)
      .mockImplementationOnce(async () => { events.push("probe"); throw new Error("sensitive probe detail"); })
      .mockImplementationOnce(async () => {
        events.push("probe");
        return { state: "ready", reason: "", authentication: "ready", protocolVerified: true, modelCatalogState: "ready" };
      });
    vi.mocked(developmentApi.refreshNativeProviders).mockImplementation(() => { events.push("provider refresh"); });
    renderSetup({
      executor: buddy({
        programAvailable: true,
        probe: { state: "ready", reason: "", authentication: "ready", modelCatalogState: "unavailable" },
      }),
      onChanged: () => { events.push("parent refresh"); },
    });

    expect(await screen.findByRole("heading", { name: "WorkBuddy 已准备就绪" })).toBeInTheDocument();
    const reauthenticate = screen.getByRole("button", { name: "重新认证" });
    await waitFor(() => expect(reauthenticate).toBeEnabled());
    expect(developmentApi.login).not.toHaveBeenCalled();

    fireEvent.click(reauthenticate);
    const dialog = await screen.findByRole("alertdialog", { name: "认证结果暂时无法确认" });
    expect(dialog).toHaveTextContent("认证记录会保留，请重新检查。");
    expect(dialog).not.toHaveTextContent("sensitive probe detail");
    expect(events).toEqual(["probe"]);
    expect(developmentApi.login).toHaveBeenCalledTimes(1);

    fireEvent.click(within(dialog).getByRole("button", { name: "重新检查" }));
    await waitFor(() => expect(events).toContain("parent refresh"));
    expect(events).toEqual(["probe", "probe", "provider refresh", "parent refresh"]);
    expect(developmentApi.login).toHaveBeenCalledTimes(1);
  });

  it("reports initial read failure without treating the component as absent, and hides internal errors", async () => {
    vi.mocked(developmentApi.engineResources)
      .mockRejectedValueOnce(new Error("sensitive resource detail"))
      .mockResolvedValueOnce(snapshot(absentResource()))
      .mockResolvedValueOnce(snapshot(absentResource()));
    vi.mocked(developmentApi.prepareExecutor).mockRejectedValueOnce(new Error("sensitive download detail"));
    renderSetup();

    expect(await screen.findByRole("alert")).toHaveTextContent("暂时无法读取 WorkBuddy 组件状态");
    expect(screen.queryByRole("heading", { name: "不安装应用，也能使用订阅" })).not.toBeInTheDocument();
    expect(screen.queryByText(/sensitive resource detail/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重新检查" }));
    expect(await screen.findByRole("heading", { name: "不安装应用，也能使用订阅" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "下载必要组件" }));
    const dialog = await screen.findByRole("alertdialog", { name: "下载请求结果尚未确认" });
    expect(dialog).not.toHaveTextContent("sensitive download detail");
    expect(within(dialog).getByRole("button", { name: "重新检查" })).toBeInTheDocument();
    expect(developmentApi.prepareExecutor).toHaveBeenCalledWith("codebuddy", "codebuddy-pack", false);
  });

  it("keeps an authenticated ready state when resource details cannot be read", async () => {
    vi.mocked(developmentApi.engineResources).mockRejectedValueOnce(new Error("catalog detail"));
    renderSetup({ executor: buddy({
      programAvailable: true,
      probe: { state: "ready", reason: "", authentication: "ready", modelCatalogState: "unavailable" },
    }) });

    expect(await screen.findByRole("switch", { name: "WorkBuddy 启用状态" })).toBeInTheDocument();
    expect(screen.getByText("已认证")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "管理引擎" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("does not treat a managed flag alone as an available component", async () => {
    vi.mocked(developmentApi.engineResources).mockResolvedValue(snapshot(installedResource({
      executable: null,
      repairRequired: true,
    })));
    renderSetup({ executor: buddy({
      programAvailable: false,
      probe: { state: "ready", reason: "", authentication: "ready", modelCatalogState: "unavailable" },
    }) });

    expect(await screen.findByRole("heading", { name: "不安装应用，也能使用订阅" })).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "WorkBuddy 启用状态" })).not.toBeInTheDocument();
    expect(screen.queryByText("已认证")).not.toBeInTheDocument();
  });
});
