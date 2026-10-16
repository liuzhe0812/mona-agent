import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelEngineProgramDialog } from "./ModelEngineProgramDialog";
import { DevelopmentApiError, developmentApi, type EngineInstallJob, type EngineResource, type ExecutorSettings } from "@/lib/development-api";

const settings: ExecutorSettings = { revision: "revision-1", values: { codexPath: null }, credentialPresent: {}, enabledEngines: [] };
const systemResource: EngineResource = {
  executor: "codex", source: "path", executable: "C:/tools/codex.exe", systemAvailable: true,
  systemExecutable: "C:/tools/codex.exe", systemVersion: "1.2.3",
  installed: true, managedInstalled: false, managedExecutable: null, managedVersion: null, canDelete: false,
  canPrepare: true, canUpdate: false, repairRequired: false, explicitPath: false,
  packRef: "codex@2.0.0", version: "2.0.0", installedVersion: "1.2.3",
  downloadBytes: 7340032, reason: "已检测到系统程序", job: null,
};
const missingResource: EngineResource = {
  ...systemResource, source: "not_detected", executable: null, systemAvailable: false,
  systemExecutable: null, systemVersion: null, installed: false, managedInstalled: false,
  managedExecutable: null, managedVersion: null, canDelete: false,
};
const managedResource: EngineResource = {
  ...systemResource, source: "managed_runtime", executable: "C:/Mona/codex.exe",
  systemAvailable: true, systemExecutable: "C:/tools/codex.exe", systemVersion: "1.2.3",
  installed: true, managedInstalled: true, managedExecutable: "C:/Mona/codex.exe", managedVersion: "1.8.0",
  canDelete: true, canPrepare: false, canUpdate: true, installedVersion: "1.8.0",
};

function renderDialog(resource: EngineResource | EngineResource[] = systemResource, onChanged = vi.fn()) {
  vi.spyOn(developmentApi, "executorSettings").mockResolvedValue(settings);
  const engineResources = vi.spyOn(developmentApi, "engineResources").mockResolvedValue({
    components: Array.isArray(resource) ? resource : [resource],
    catalogAvailable: true,
  });
  render(<ModelEngineProgramDialog open executor="codex" onOpenChange={vi.fn()} onChanged={onChanged} />);
  return { onChanged, engineResources };
}

afterEach(() => vi.restoreAllMocks());

describe("ModelEngineProgramDialog", () => {
  it("separates the detected system program from the Mona-managed download action", async () => {
    renderDialog();

    expect(await screen.findByText("C:/tools/codex.exe · 版本 1.2.3")).toBeInTheDocument();
    const local = screen.getByRole("heading", { name: "本机已安装" }).closest("section");
    const managed = screen.getByRole("heading", { name: "Mona 管理" }).closest("section");
    expect(local).not.toBeNull();
    expect(managed).not.toBeNull();
    expect(within(local!).getByText("C:/tools/codex.exe · 版本 1.2.3")).toBeInTheDocument();
    expect(within(managed!).getByText("未下载 · 下载大小 7.0 MB")).toBeInTheDocument();
    expect(within(managed!).getByRole("button", { name: "下载" })).toBeEnabled();
    expect(within(local!).queryByRole("button", { name: "下载" })).not.toBeInTheDocument();
    expect(screen.getAllByText("C:/tools/codex.exe · 版本 1.2.3")).toHaveLength(1);
    expect(screen.queryByText("managed_runtime")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "连接 Codex" })).not.toBeInTheDocument();
    expect(screen.queryByText("模型偏好")).not.toBeInTheDocument();
  });

  it("shows a missing local program and lets the user save a manually entered path", async () => {
    const configuredSettings: ExecutorSettings = { ...settings, values: { codexPath: "C:/stale/codex.exe" } };
    vi.spyOn(developmentApi, "executorSettings").mockResolvedValue(configuredSettings);
    vi.spyOn(developmentApi, "engineResources").mockResolvedValue({ components: [missingResource], catalogAvailable: true });
    const save = vi.spyOn(developmentApi, "updateExecutorSettings").mockResolvedValue({
      ...settings, revision: "revision-2", values: { codexPath: "D:/apps/codex.exe" },
    });
    render(<ModelEngineProgramDialog open executor="codex" onOpenChange={vi.fn()} onChanged={vi.fn()} />);

    expect(await screen.findByText("未检测到本机程序")).toBeInTheDocument();
    expect(screen.queryByText("使用已配置的本机程序")).not.toBeInTheDocument();
    const input = screen.getByRole("textbox", { name: "Codex 程序路径" });
    expect(input).toHaveValue("C:/stale/codex.exe");
    fireEvent.change(input, { target: { value: "D:/apps/codex.exe" } });
    fireEvent.click(screen.getByRole("button", { name: "保存路径" }));

    await waitFor(() => expect(save).toHaveBeenCalledWith(configuredSettings, { codexPath: "D:/apps/codex.exe" }));
    expect(await screen.findByText("程序路径已保存。")).toBeInTheDocument();
  });

  it("keeps the managed program path and version separate and confirms deletion", async () => {
    const deletedResource: EngineResource = {
      ...systemResource, managedInstalled: false, managedExecutable: null, managedVersion: null,
      canDelete: false, canUpdate: false, canPrepare: true, installed: true,
    };
    const onChanged = vi.fn();
    vi.spyOn(developmentApi, "executorSettings").mockResolvedValue(settings);
    const engineResources = vi.spyOn(developmentApi, "engineResources").mockImplementation(async (_executor, refresh) => ({
      components: [refresh ? deletedResource : managedResource],
      catalogAvailable: true,
    }));
    const remove = vi.spyOn(developmentApi, "deleteManagedExecutor").mockResolvedValue({ deleted: true });
    render(<ModelEngineProgramDialog open executor="codex" onOpenChange={vi.fn()} onChanged={onChanged} />);

    const local = screen.getByRole("heading", { name: "本机已安装" }).closest("section");
    const managed = screen.getByRole("heading", { name: "Mona 管理" }).closest("section");
    expect(await within(local!).findByText("C:/tools/codex.exe · 版本 1.2.3")).toBeInTheDocument();
    expect(within(managed!).getByText("C:/Mona/codex.exe · 版本 1.8.0")).toBeInTheDocument();
    expect(within(managed!).getByRole("button", { name: "更新" })).toBeEnabled();
    fireEvent.click(within(managed!).getByRole("button", { name: "删除" }));

    const confirmation = await screen.findByRole("alertdialog", { name: "删除 Mona 管理的程序？" });
    expect(confirmation).toHaveTextContent("不会删除登录信息、会话或模型设置");
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(within(confirmation).getByRole("button", { name: "删除程序" }));

    await waitFor(() => expect(remove).toHaveBeenCalledWith("codex", "1.8.0"));
    await waitFor(() => expect(engineResources).toHaveBeenCalledWith("codex", true));
    await waitFor(() => expect(developmentApi.executorSettings).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Mona 管理的程序已删除。")).toBeInTheDocument();
  });

  it("keeps reporting a failed status refresh after deletion until retry succeeds", async () => {
    vi.spyOn(developmentApi, "executorSettings").mockResolvedValue(settings);
    vi.spyOn(developmentApi, "engineResources").mockResolvedValueOnce({
      components: [managedResource], catalogAvailable: true,
    }).mockRejectedValueOnce(new Error("unavailable"))
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValue({ components: [systemResource], catalogAvailable: true });
    const remove = vi.spyOn(developmentApi, "deleteManagedExecutor").mockResolvedValue({ deleted: true });
    render(<ModelEngineProgramDialog open executor="codex" onOpenChange={vi.fn()} onChanged={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "删除", exact: true }));
    const confirmation = await screen.findByRole("alertdialog", { name: "删除 Mona 管理的程序？" });
    fireEvent.click(within(confirmation).getByRole("button", { name: "删除程序" }));

    const alert = await screen.findByRole("alertdialog", { name: "程序已删除，但状态暂未刷新" });
    fireEvent.click(within(alert).getByRole("button", { name: "重试" }));
    const repeated = await screen.findByRole("alertdialog", { name: "程序已删除，但状态暂未刷新" });
    fireEvent.click(within(repeated).getByRole("button", { name: "重试" }));
    expect(await screen.findByText("Mona 管理的程序已删除。")).toBeInTheDocument();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("shows the deleted-path warning and uses freshly loaded settings after removal", async () => {
    const freshSettings: ExecutorSettings = { ...settings, revision: "revision-2", values: { codexPath: "C:/Mona/codex.exe" } };
    const deletedResource: EngineResource = {
      ...systemResource, managedInstalled: false, managedExecutable: null, managedVersion: null,
      canDelete: false, canUpdate: false, canPrepare: true, installed: true,
    };
    const update = vi.spyOn(developmentApi, "updateExecutorSettings").mockResolvedValue({
      ...freshSettings, revision: "revision-3", values: { codexPath: null },
    });
    vi.spyOn(developmentApi, "executorSettings").mockResolvedValueOnce(settings).mockResolvedValueOnce(freshSettings);
    vi.spyOn(developmentApi, "engineResources").mockImplementation(async (_executor, refresh) => ({
      components: [refresh ? deletedResource : managedResource],
      catalogAvailable: true,
    }));
    vi.spyOn(developmentApi, "deleteManagedExecutor").mockResolvedValue({
      deleted: true, warning: "程序已删除，但旧路径设置未自动恢复。",
    });
    render(<ModelEngineProgramDialog open executor="codex" onOpenChange={vi.fn()} onChanged={vi.fn()} />);

    const managed = screen.getByRole("heading", { name: "Mona 管理" }).closest("section");
    await within(managed!).findByText("C:/Mona/codex.exe · 版本 1.8.0");
    fireEvent.click(within(managed!).getByRole("button", { name: "删除" }));
    const confirmation = await screen.findByRole("alertdialog", { name: "删除 Mona 管理的程序？" });
    fireEvent.click(within(confirmation).getByRole("button", { name: "删除程序" }));

    const warning = await screen.findByRole("alertdialog", { name: "程序已删除，需清理旧路径" });
    expect(warning).toHaveTextContent("请在“本机已安装”清空旧路径并保存");
    fireEvent.click(within(warning).getByRole("button", { name: "关闭" }));
    const input = screen.getByRole("textbox", { name: "Codex 程序路径" });
    expect(input).toHaveValue("C:/Mona/codex.exe");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "保存路径" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(freshSettings, { codexPath: null }));
  });

  it.each([
    ["engine_remove_failed", 422, "程序删除未完成", "删除可能只完成了一部分，部分程序文件仍可能存在。请刷新检测确认状态，再决定是否重试。", "internal remove detail"],
    ["conflict", 409, "暂时无法删除", "此程序正在下载或更新，请先完成或取消操作，再删除。", "此程序正在下载或更新，请先完成或取消操作，再删除。"],
  ] as const)("explains managed-program removal failure %s", async (code, statusCode, title, expectedMessage, serverMessage) => {
    vi.spyOn(developmentApi, "deleteManagedExecutor").mockRejectedValue(new DevelopmentApiError(statusCode, code, serverMessage));
    renderDialog(managedResource);

    const managed = screen.getByRole("heading", { name: "Mona 管理" }).closest("section");
    await within(managed!).findByText("C:/Mona/codex.exe · 版本 1.8.0");
    fireEvent.click(within(managed!).getByRole("button", { name: "删除" }));
    const confirmation = await screen.findByRole("alertdialog", { name: "删除 Mona 管理的程序？" });
    fireEvent.click(within(confirmation).getByRole("button", { name: "删除程序" }));

    const alert = await screen.findByRole("alertdialog", { name: title });
    expect(alert).toHaveTextContent(expectedMessage);
    if (code === "engine_remove_failed") {
      expect(alert).not.toHaveTextContent("程序未删除");
      expect(alert).not.toHaveTextContent(serverMessage);
    }
  });

  it("offers a managed download even when a system program is already installed and supports cancellation", async () => {
    const running: EngineInstallJob = { id: "job-1", state: "running", stage: "downloading", downloadedBytes: 512, totalBytes: 2048 };
    const cancelled: EngineInstallJob = { ...running, state: "cancelled" };
    const prepare = vi.spyOn(developmentApi, "prepareExecutor").mockResolvedValue({ installed: false, job: running });
    vi.spyOn(developmentApi, "executorInstall").mockResolvedValue(running);
    const cancel = vi.spyOn(developmentApi, "cancelExecutorInstall").mockResolvedValue(cancelled);
    const { onChanged } = renderDialog(systemResource);

    await screen.findByText("未下载 · 下载大小 7.0 MB");
    const managed = screen.getByRole("heading", { name: "Mona 管理" }).closest("section");
    fireEvent.click(within(managed!).getByRole("button", { name: "下载" }));
    expect(await screen.findByText("正在下载")).toBeInTheDocument();
    expect(prepare).toHaveBeenCalledWith("codex", "codex@2.0.0", false);
    fireEvent.click(within(managed!).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith("codex", "job-1"));
    expect(await screen.findByText("程序任务已取消，可重新下载。")).toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("updates an installed Mona-managed program while keeping the system program available", async () => {
    const running: EngineInstallJob = { id: "job-update", state: "running", stage: "downloading", downloadedBytes: 100, totalBytes: 1000 };
    const prepare = vi.spyOn(developmentApi, "prepareExecutor").mockResolvedValue({ installed: false, job: running });
    vi.spyOn(developmentApi, "executorInstall").mockResolvedValue(running);
    renderDialog(managedResource);

    await screen.findByText("C:/Mona/codex.exe · 版本 1.8.0");
    const managed = screen.getByRole("heading", { name: "Mona 管理" }).closest("section");
    expect(within(managed!).getByRole("button", { name: "更新" })).toBeEnabled();
    fireEvent.click(within(managed!).getByRole("button", { name: "更新" }));

    await waitFor(() => expect(prepare).toHaveBeenCalledWith("codex", "codex@2.0.0", false));
  });

  it("refreshes the release before updating instead of submitting the stale displayed version", async () => {
    const running: EngineInstallJob = { id: "latest-release", state: "running", stage: "downloading", downloadedBytes: 0, totalBytes: 1024 };
    const prepare = vi.spyOn(developmentApi, "prepareExecutor").mockResolvedValue({ installed: false, job: running });
    vi.spyOn(developmentApi, "executorInstall").mockResolvedValue(running);
    const { engineResources } = renderDialog(managedResource);
    engineResources.mockResolvedValue({ components: [{ ...managedResource, packRef: "codex@3.0.0", version: "3.0.0" }], catalogAvailable: true });

    fireEvent.click(await screen.findByRole("button", { name: "更新", exact: true }));

    await waitFor(() => expect(engineResources).toHaveBeenCalledWith("codex", true));
    await waitFor(() => expect(prepare).toHaveBeenCalledWith("codex", "codex@3.0.0", false));
    expect(prepare).not.toHaveBeenCalledWith("codex", managedResource.packRef, false);
  });

  it("shows pending and failed official-version lookup states", async () => {
    let resolveLookup: ((value: { components: EngineResource[]; catalogAvailable: boolean }) => void) | undefined;
    vi.spyOn(developmentApi, "executorSettings").mockResolvedValue(settings);
    vi.spyOn(developmentApi, "engineResources").mockImplementation(() => new Promise((resolve) => { resolveLookup = resolve; }));
    render(<ModelEngineProgramDialog open executor="codex" onOpenChange={vi.fn()} onChanged={vi.fn()} />);

    expect(await screen.findByRole("button", { name: "读取中…" })).toBeDisabled();
    await act(async () => {
      resolveLookup?.({ components: [{ ...missingResource, packRef: null, canPrepare: false }], catalogAvailable: false });
    });
    expect(await screen.findByText("官方程序版本暂不可用，请刷新检测后重试。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "下载" })).toBeDisabled();
  });

  it("retries a failed managed install without showing internal error details", async () => {
    const failed: EngineInstallJob = { id: "job-failed", state: "failed", stage: "下载程序", downloadedBytes: 512, totalBytes: 2048, error: "internal detail" };
    const running: EngineInstallJob = { ...failed, id: "job-retry", state: "running", error: null };
    const prepare = vi.spyOn(developmentApi, "prepareExecutor").mockResolvedValue({ installed: false, job: running });
    vi.spyOn(developmentApi, "executorInstall").mockResolvedValue(running);
    renderDialog({ ...missingResource, job: failed });

    await screen.findByText("未下载 · 下载大小 7.0 MB");
    const managed = screen.getByRole("heading", { name: "Mona 管理" }).closest("section");
    expect(within(managed!).getByRole("button", { name: "重试" })).toBeEnabled();
    fireEvent.click(within(managed!).getByRole("button", { name: "重试" }));
    await waitFor(() => expect(prepare).toHaveBeenCalledWith("codex", "codex@2.0.0", false));
    expect(screen.queryByText("internal detail")).not.toBeInTheDocument();
  });

  it("uses one generic alert for program failure and offers a retry", async () => {
    const rawFailure = "download failed at https://cdn.example/private.zip";
    const running: EngineInstallJob = { id: "job-retry", state: "running", stage: "downloading", downloadedBytes: 1, totalBytes: 10 };
    const prepare = vi.spyOn(developmentApi, "prepareExecutor")
      .mockRejectedValueOnce(new Error(rawFailure))
      .mockResolvedValueOnce({ installed: false, job: running });
    vi.spyOn(developmentApi, "executorInstall").mockResolvedValue(running);
    renderDialog(missingResource);

    await screen.findByText("未下载 · 下载大小 7.0 MB");
    const managed = screen.getByRole("heading", { name: "Mona 管理" }).closest("section");
    fireEvent.click(within(managed!).getByRole("button", { name: "下载" }));
    const alert = await screen.findByRole("alertdialog", { name: "程序准备失败" });
    expect(alert).toHaveTextContent("程序准备未完成，你可以重试。");
    expect(alert).not.toHaveTextContent(rawFailure);
    expect(screen.getAllByRole("alertdialog")).toHaveLength(1);
    fireEvent.click(within(alert).getByRole("button", { name: "重试" }));
    await waitFor(() => expect(prepare).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("正在下载")).toBeInTheDocument();
  });

  it("ignores a resource refresh that finishes after switching engines", async () => {
    const claudeResource: EngineResource = {
      ...systemResource, executor: "claude", source: "path", executable: "D:/tools/claude.exe",
      systemExecutable: "D:/tools/claude.exe", systemVersion: "2.0.0", packRef: "claude@2.0.0",
    };
    const staleResource: EngineResource = { ...systemResource, executable: "C:/stale.exe", systemExecutable: "C:/stale.exe", reason: "stale result" };
    let resolveRefresh: ((value: { components: EngineResource[]; catalogAvailable: boolean }) => void) | undefined;
    const engineResources = vi.spyOn(developmentApi, "engineResources").mockImplementation(async (executor, refresh) => {
      if (executor === "codex" && refresh) {
        return new Promise((resolve) => { resolveRefresh = resolve; });
      }
      return { components: [executor === "claude" ? claudeResource : systemResource], catalogAvailable: true };
    });
    vi.spyOn(developmentApi, "executorSettings").mockResolvedValue(settings);
    const props = { open: true, onOpenChange: vi.fn(), onChanged: vi.fn() };
    const view = render(<ModelEngineProgramDialog {...props} executor="codex" />);
    expect(await screen.findByText("C:/tools/codex.exe · 版本 1.2.3")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重新检测" }));
    await waitFor(() => expect(engineResources).toHaveBeenCalledWith("codex", true));

    view.rerender(<ModelEngineProgramDialog {...props} executor="claude" />);
    expect(await screen.findByText("D:/tools/claude.exe · 版本 2.0.0")).toBeInTheDocument();
    await act(async () => {
      resolveRefresh?.({ components: [staleResource], catalogAvailable: true });
    });

    expect(screen.getByText("D:/tools/claude.exe · 版本 2.0.0")).toBeInTheDocument();
    expect(screen.queryByText("C:/stale.exe")).not.toBeInTheDocument();
  });
});
