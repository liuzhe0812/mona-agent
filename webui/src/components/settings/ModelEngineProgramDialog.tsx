import { useCallback, useEffect, useRef, useState } from "react";
import { Download, FolderOpen, RefreshCw, RotateCw, X } from "lucide-react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { DevelopmentApiError, developmentApi, executorLabels, type EngineInstallJob, type EngineResource, type ExecutorSettings, type NativeExecutorId } from "@/lib/development-api";
import { isTauri } from "@/lib/tauri";

const terminalJob = (state: EngineInstallJob["state"]) => state === "completed" || state === "failed" || state === "cancelled";
const jobStageLabels: Record<string, string> = {
  queued: "排队中",
  downloading: "正在下载",
  installing: "正在安装",
  verifying: "正在验证程序",
  activating: "正在完成安装",
  ready: "已就绪",
  completed: "已完成",
  failed: "准备失败",
  cancelled: "已取消",
};

function managedSource(source: string): boolean {
  return source === "managed" || source === "managed_runtime";
}

function systemExecutable(resource?: EngineResource): string | null {
  if (!resource) return null;
  if (resource.systemExecutable !== undefined) return resource.systemExecutable ?? null;
  return !managedSource(resource.source) && resource.systemAvailable ? resource.executable : null;
}

function systemVersion(resource?: EngineResource): string | null {
  if (!resource) return null;
  if (resource.systemVersion !== undefined) return resource.systemVersion ?? null;
  return !managedSource(resource.source) && resource.systemAvailable
    ? resource.installedVersion
    : null;
}

function managedExecutable(resource?: EngineResource): string | null {
  if (!resource) return null;
  if (resource.managedExecutable !== undefined) return resource.managedExecutable ?? null;
  return managedSource(resource.source) ? resource.executable : null;
}

function managedVersion(resource?: EngineResource): string | null {
  if (!resource) return null;
  if (resource.managedVersion !== undefined) return resource.managedVersion ?? null;
  return managedSource(resource.source) ? resource.installedVersion : null;
}

function formatBytes(value: number): string {
  if (value < 1024) return value + " B";
  const units = ["KB", "MB", "GB"];
  let size = value / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && size >= 1024; index += 1) {
    size /= 1024;
    unit = units[index];
  }
  return (size >= 10 ? size.toFixed(0) : size.toFixed(1)) + " " + unit;
}

function resourceKey(resource: EngineResource): string {
  return resource.executor;
}

function engineJobStage(stage: string, state: EngineInstallJob["state"]): string {
  return jobStageLabels[stage] ?? jobStageLabels[state] ?? "正在准备程序";
}

type DeleteTarget = { executor: NativeExecutorId; version: string | null };

export function ModelEngineProgramDialog({ open, onOpenChange, executor, onChanged }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  executor: NativeExecutorId;
  onChanged: () => void;
}) {
  type FailureAlert = { title: string; message: string; retry?: () => void };
  const [settings, setSettings] = useState<ExecutorSettings>();
  const [values, setValues] = useState<Record<string, string | null>>({});
  const [resources, setResources] = useState<EngineResource[]>([]);
  const [catalogAvailable, setCatalogAvailable] = useState<boolean | null>(null);
  const [jobs, setJobs] = useState<Record<string, EngineInstallJob>>({});
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busyKey, setBusyKey] = useState("");
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [failure, setFailure] = useState<FailureAlert | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const generation = useRef(0);
  const polling = useRef<number | null>(null);
  const prepareRef = useRef<(resource: EngineResource, repair?: boolean) => Promise<void>>(async () => {});
  const refreshRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    const epoch = ++generation.current;
    if (!open) {
      setDeleteTarget(null);
      return;
    }
    let active = true;
    setLoading(true);
    setError("");
    setStatus("");
    setSettings(undefined);
    setValues({});
    setResources([]);
    setJobs({});
    setRefreshing(false);
    setSaving(false);
    setBusyKey("");
    setCatalogAvailable(null);
    setFailure(null);
    setDeleteTarget(null);
    Promise.allSettled([developmentApi.executorSettings(), developmentApi.engineResources(executor)])
      .then(([settingsResult, resourcesResult]) => {
        if (!active || generation.current !== epoch) return;
        if (settingsResult.status === "fulfilled") {
          setSettings(settingsResult.value);
          setValues(settingsResult.value.values);
        } else {
          setError("无法读取程序路径设置。");
        }
        if (resourcesResult.status === "fulfilled") {
          setResources(resourcesResult.value.components);
          setCatalogAvailable(resourcesResult.value.catalogAvailable);
          const initialJobs: Record<string, EngineInstallJob> = {};
          for (const resource of resourcesResult.value.components) {
            if (resource.job) initialJobs[resourceKey(resource)] = resource.job;
          }
          setJobs(initialJobs);
        } else {
          setError((current) => current || "无法检测程序状态，请重试。");
        }
      })
      .finally(() => {
        if (active && generation.current === epoch) setLoading(false);
      });
    return () => { active = false; generation.current += 1; };
  }, [executor, open]);

  const refreshResources = useCallback(async (epoch = generation.current) => {
    const result = await developmentApi.engineResources(executor, true);
    if (open && generation.current === epoch) {
      setResources(result.components);
      setCatalogAvailable(result.catalogAvailable);
      setJobs((current) => {
        const next = { ...current };
        for (const resource of result.components) {
          const key = resourceKey(resource);
          if (resource.job) next[key] = resource.job;
        }
        return next;
      });
    }
    return result;
  }, [executor, open]);

  const refreshAfterDelete = async (epoch: number) => {
    if (open && generation.current === epoch) {
      setSettings(undefined);
      setValues({});
    }
    const [settingsResult, resourcesResult] = await Promise.allSettled([
      developmentApi.executorSettings(),
      refreshResources(epoch),
    ]);
    if (open && generation.current === epoch && settingsResult.status === "fulfilled") {
      setSettings(settingsResult.value);
      setValues(settingsResult.value.values);
    }
    const result = {
      settingsReady: settingsResult.status === "fulfilled",
      resourcesReady: resourcesResult.status === "fulfilled",
    };
    if (open && generation.current === epoch) {
      if (result.settingsReady && result.resourcesReady) {
        setStatus("Mona 管理的程序已删除。");
      } else {
        setStatus("");
        setFailure({
          title: "程序已删除，但状态暂未刷新",
          message: "程序已删除，但程序路径或检测状态暂时无法刷新。请刷新后确认。",
          retry: () => void refreshAfterDelete(generation.current),
        });
      }
    }
    return result;
  };

  const activeJobs = Object.entries(jobs).filter(([, job]) => !terminalJob(job.state));
  useEffect(() => {
    if (!open || !activeJobs.length) return;
    const epoch = generation.current;
    const current = () => open && generation.current === epoch;
    const timer = window.setTimeout(async () => {
      if (polling.current === epoch) return;
      polling.current = epoch;
      try {
        const completed: EngineResource[] = [];
        for (const [key, job] of activeJobs) {
          const resource = resources.find((item) => resourceKey(item) === key);
          if (!resource) continue;
          const updated = await developmentApi.executorInstall(executor, job.id);
          if (!current()) return;
          if (updated.state === "completed") completed.push(resource);
          if (updated.state === "failed") {
            setFailure((existing) => existing ?? {
              title: "程序准备失败",
              message: "程序准备未完成。你可以重试，或刷新检测查看程序状态。",
              retry: () => void prepareRef.current(resource, resource.repairRequired),
            });
          }
          setJobs((currentJobs) => ({ ...currentJobs, [key]: updated }));
        }
        for (const completedResource of completed) {
          try {
            const result = await refreshResources(epoch);
            if (!current()) return;
            const latest = result.components.find((candidate) => candidate.executor === completedResource.executor);
            if (latest?.managedInstalled) {
              setStatus(executorLabels[executor] + " 程序已就绪。");
              developmentApi.refreshNativeProviders();
              onChanged();
            } else {
              setFailure({ title: "程序状态待确认", message: "安装任务已结束，但程序状态尚未确认。请刷新检测后再试。", retry: () => void refreshRef.current() });
            }
          } catch {
            if (current()) setFailure({ title: "程序状态待确认", message: "安装任务已结束，程序状态暂未确认。请刷新检测后再试。", retry: () => void refreshRef.current() });
          }
        }
      } catch {
        if (current()) setStatus("任务进度暂时无法读取，请刷新检测后重试。");
      } finally {
        if (polling.current === epoch) polling.current = null;
      }
    }, 900);
    return () => window.clearTimeout(timer);
  }, [activeJobs, executor, onChanged, open, refreshResources, resources]);

  const refresh = async () => {
    const epoch = generation.current;
    const current = () => open && generation.current === epoch;
    setRefreshing(true);
    setError("");
    setStatus("");
    setFailure(null);
    try {
      await refreshResources(epoch);
      if (!current()) return;
      developmentApi.refreshNativeProviders();
      onChanged();
    } catch {
      if (current()) setFailure({ title: "检测失败", message: "检测未完成，请重试。", retry: () => void refreshRef.current() });
    } finally {
      if (current()) setRefreshing(false);
    }
  };
  refreshRef.current = refresh;

  const savePath = async () => {
    if (!settings || saving) return;
    const epoch = generation.current;
    const current = () => open && generation.current === epoch;
    setSaving(true);
    setError("");
    setStatus("");
    setFailure(null);
    try {
      const saved = await developmentApi.updateExecutorSettings(settings, values);
      developmentApi.refreshNativeProviders();
      onChanged();
      if (!current()) return;
      setSettings(saved);
      setValues(saved.values);
      setStatus("程序路径已保存。");
      try {
        await refreshResources(epoch);
      } catch {
        if (current()) setStatus("程序路径已保存；检测状态暂未刷新。");
      }
    } catch {
      if (current()) setFailure({ title: "路径保存失败", message: "程序路径未保存，请重试。", retry: () => void savePath() });
    } finally {
      if (current()) setSaving(false);
    }
  };

  const choosePath = async () => {
    const epoch = generation.current;
    const current = () => open && generation.current === epoch;
    try {
      const { open: choose } = await import("@tauri-apps/plugin-dialog");
      const selected = await choose({ directory: false, multiple: false, title: "选择 " + executorLabels[executor] + " 程序" });
      if (current() && typeof selected === "string") setValues((currentValues) => ({ ...currentValues, [executor + "Path"]: selected }));
    } catch {
      if (current()) setFailure({ title: "无法选择程序", message: "文件选择器未能打开，请手动填写程序路径。" });
    }
  };

  const prepare = async (resource: EngineResource, repair = false) => {
    const key = resourceKey(resource);
    if (!resource.packRef || busyKey) return;
    const epoch = generation.current;
    const current = () => open && generation.current === epoch;
    setBusyKey(key);
    setError("");
    setStatus("");
    setFailure(null);
    try {
      const result = await developmentApi.prepareExecutor(executor, resource.packRef, repair);
      if (!current()) return;
      if (result.job) {
        setJobs((currentJobs) => ({ ...currentJobs, [key]: result.job! }));
        return;
      }
      if (result.installed) {
        const refreshed = await refreshResources(epoch);
        if (!current()) return;
        const latest = refreshed.components.find((item) => item.executor === executor);
        if (latest?.managedInstalled) {
          setStatus(executorLabels[executor] + " 程序已就绪。");
          developmentApi.refreshNativeProviders();
          onChanged();
          return;
        }
      }
      if (current()) setFailure({ title: "程序尚未就绪", message: "没有确认程序已就绪，请刷新检测后重试。", retry: () => void refreshRef.current() });
    } catch {
      if (current()) setFailure({ title: "程序准备失败", message: "程序准备未完成，你可以重试。", retry: () => void prepareRef.current(resource, repair) });
    } finally {
      if (current()) setBusyKey("");
    }
  };
  prepareRef.current = prepare;

  const cancel = async (resource: EngineResource, job: EngineInstallJob) => {
    const key = resourceKey(resource);
    const epoch = generation.current;
    const current = () => open && generation.current === epoch;
    setBusyKey(key);
    setError("");
    setFailure(null);
    try {
      const updated = await developmentApi.cancelExecutorInstall(executor, job.id);
      if (!current()) return;
      setJobs((currentJobs) => ({ ...currentJobs, [key]: updated }));
    } catch {
      if (current()) setFailure({ title: "无法取消任务", message: "程序任务未能取消，请重试。", retry: () => void cancel(resource, job) });
    } finally {
      if (current()) setBusyKey("");
    }
  };

  const removeManaged = async (target: DeleteTarget) => {
    if (busyKey) return;
    const epoch = generation.current;
    const current = () => open && generation.current === epoch;
    setBusyKey("delete:" + target.executor);
    setError("");
    setStatus("");
    setFailure(null);
    let deleted = false;
    try {
      const result = await developmentApi.deleteManagedExecutor(target.executor, target.version ?? undefined);
      if (result.deleted !== true) throw new Error("delete_not_confirmed");
      deleted = true;
      if (current()) setStatus("Mona 管理的程序已删除，正在刷新检测…");
      const refreshed = await refreshAfterDelete(epoch);
      if (current()) {
        if (result.warning) {
          setFailure({
            title: "程序已删除，需清理旧路径",
            message: result.warning + " 请在“本机已安装”清空旧路径并保存，再重新检测。",
            retry: !refreshed.settingsReady || !refreshed.resourcesReady
              ? () => void refreshAfterDelete(generation.current)
              : undefined,
          });
        }
      }
      developmentApi.refreshNativeProviders();
      onChanged();
    } catch (cause) {
      if (current() && deleted) {
        setFailure({
          title: "程序已删除，但状态暂未刷新",
          message: "程序已删除，但程序路径或检测状态暂时无法刷新。请刷新后确认。",
          retry: () => void refreshAfterDelete(generation.current),
        });
      } else if (current() && cause instanceof DevelopmentApiError && cause.code === "engine_remove_failed") {
        setFailure({
          title: "程序删除未完成",
          message: "删除可能只完成了一部分，部分程序文件仍可能存在。请刷新检测确认状态，再决定是否重试。",
          retry: () => void refreshRef.current(),
        });
      } else if (current() && cause instanceof DevelopmentApiError && cause.code === "conflict") {
        const safeDescription = /[\u3400-\u9fff]/u.test(cause.message)
          ? cause.message
          : "程序未删除。请结束相关操作并刷新检测后重试。";
        setFailure({
          title: "暂时无法删除",
          message: safeDescription,
          retry: () => void refreshRef.current(),
        });
      } else if (current()) {
        setFailure({
          title: "删除结果待确认",
          message: "未能确认程序是否已删除。请刷新检测，确认当前状态后再继续。",
          retry: () => void refreshRef.current(),
        });
      }
    } finally {
      if (current()) setBusyKey("");
    }
  };

  const openDeleteConfirmation = (resource: EngineResource) => {
    setFailure(null);
    setDeleteTarget({ executor: resource.executor, version: resource.managedVersion ?? null });
  };

  const dirty = !!settings && Object.keys(settings.values).some((key) => (values[key] || null) !== (settings.values[key] || null));
  const pathKey = executor + "Path";
  const configuredPath = values[pathKey] ?? "";
  const resource = resources.find((item) => item.executor === executor);
  const jobKey = resource ? resourceKey(resource) : executor;
  const job = jobs[jobKey] ?? resource?.job ?? undefined;
  const active = !!job && !terminalJob(job.state);
  const detectedSystemPath = systemExecutable(resource);
  const detectedSystem = !!detectedSystemPath || !!resource?.systemAvailable;
  const systemVersionText = systemVersion(resource);
  const systemStatus = detectedSystemPath
    ? detectedSystemPath
    : detectedSystem ? "已检测到本机程序" : "未检测到本机程序";
  const systemStatusWithVersion = systemStatus + (systemVersionText ? " · 版本 " + systemVersionText : "");
  const installedManagedPath = resource?.managedInstalled ? managedExecutable(resource) : null;
  const installedManagedVersion = resource?.managedInstalled ? managedVersion(resource) : null;
  const managedStatus = resource?.managedInstalled
    ? (installedManagedPath ?? "Mona 管理的程序已安装") + (installedManagedVersion ? " · 版本 " + installedManagedVersion : "")
    : active
      ? "正在准备 Mona 管理的程序"
      : "未下载" + (resource?.downloadBytes ? " · 下载大小 " + formatBytes(resource.downloadBytes) : "");
  const catalogIssue = catalogAvailable === false || !!resource?.catalogError;
  const canPrepare = !!resource?.packRef
    && !catalogIssue
    && !!resource
    && (resource.canPrepare || resource.canUpdate || resource.repairRequired);
  const showPrepare = resource ? (!resource.managedInstalled || resource.canUpdate || resource.repairRequired) : loading;
  const prepareLabel = !resource
    ? "读取中…"
    : job?.state === "failed" ? "重试"
      : resource.repairRequired ? "修复"
        : resource.managedInstalled && resource.canUpdate ? "更新" : "下载";
  const progress = job && job.totalBytes > 0 ? Math.min(100, job.downloadedBytes / job.totalBytes * 100) : undefined;

  return <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-auto">
        <DialogHeader>
          <DialogTitle>引擎管理 · {executorLabels[executor]}</DialogTitle>
          <DialogDescription>配置本机程序路径，或管理 Mona 提供的程序版本。</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <section className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-ui font-medium">本机已安装</h3>
              <Button type="button" variant="outline" size="sm" disabled={loading || refreshing || !!busyKey} onClick={() => void refresh()}>
                <RefreshCw className={"mr-1.5 h-3.5 w-3.5 " + (refreshing ? "animate-spin" : "")} />
                {refreshing ? "检测中…" : "重新检测"}
              </Button>
            </div>
            <p className="break-all text-caption text-muted-foreground">{loading ? "正在检测本机程序…" : systemStatusWithVersion}</p>
            <div className="flex flex-wrap items-center gap-2">
              <Input className="min-w-0 flex-1" aria-label={executorLabels[executor] + " 程序路径"} placeholder="手动填写本机程序路径"
                value={configuredPath} disabled={loading || saving || !!busyKey || !settings}
                onChange={(event) => setValues((currentValues) => ({ ...currentValues, [pathKey]: event.target.value || null }))} />
              {isTauri() && <Button type="button" variant="outline" size="sm" disabled={loading || saving || !!busyKey || !settings} onClick={() => void choosePath()}>
                <FolderOpen className="mr-1.5 h-3.5 w-3.5" />{detectedSystem ? "更换" : "浏览"}
              </Button>}
              {dirty && <Button type="button" size="sm" disabled={saving || loading || !!busyKey} onClick={() => void savePath()}>{saving ? "保存中…" : "保存路径"}</Button>}
            </div>
          </section>

          <section className="space-y-2 border-t border-border/60 pt-4">
            <h3 className="text-ui font-medium">Mona 管理</h3>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <p className="min-w-0 flex-1 break-all text-caption text-muted-foreground">{loading && !resource ? "正在读取官方程序版本…" : managedStatus}</p>
              <div className="flex shrink-0 items-center gap-2">
                {active
                  ? <Button type="button" variant="outline" size="sm" disabled={busyKey === jobKey} onClick={() => resource && job && void cancel(resource, job)}>
                      <X className="mr-1.5 h-3.5 w-3.5" />取消
                    </Button>
                  : showPrepare && <Button type="button" variant="outline" size="sm" disabled={loading || refreshing || !!busyKey || !canPrepare} onClick={() => resource && void prepare(resource, resource.repairRequired)}>
                      {resource?.repairRequired ? <RotateCw className="mr-1.5 h-3.5 w-3.5" /> : <Download className="mr-1.5 h-3.5 w-3.5" />}
                      {prepareLabel}
                    </Button>}
                {resource?.managedInstalled && resource.canDelete && <Button type="button" variant="dangerSoft" size="sm" disabled={loading || refreshing || !!busyKey || active} onClick={() => openDeleteConfirmation(resource)}>删除</Button>}
              </div>
            </div>
            {job?.state === "cancelled" && !active && <p role="status" className="text-micro text-muted-foreground">程序任务已取消，可重新下载。</p>}
            {active && job && <div className="space-y-1.5">
              <div className="flex justify-between gap-2 text-micro text-muted-foreground">
                <span>{engineJobStage(job.stage, job.state)}</span>
                <span>{progress === undefined ? formatBytes(job.downloadedBytes) + " 已下载" : Math.round(progress) + "%"}</span>
              </div>
              <Progress value={progress} aria-label={executorLabels[executor] + " 程序下载进度"} />
            </div>}
            {catalogIssue
              ? <p role="status" className="text-micro text-muted-foreground">官方程序版本暂不可用，请刷新检测后重试。</p>
              : resource && !resource.packRef && !resource.managedInstalled && !loading
                ? <p role="status" className="text-micro text-muted-foreground">当前没有可下载的 Mona 管理版本。</p>
                : !resource && !loading && !error
                  ? <p role="status" className="text-micro text-muted-foreground">暂未提供 Mona 管理版本。</p>
                  : null}
          </section>
        </div>

        {error && <p role="alert" className="text-caption text-destructive">{error}</p>}
        {status && <p role="status" className="text-caption text-muted-foreground">{status}</p>}
        <div className="flex justify-end"><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>关闭</Button></div>
      </DialogContent>
    </Dialog>

    <AlertDialog open={!!deleteTarget} onOpenChange={(value) => { if (!value) setDeleteTarget(null); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>删除 Mona 管理的程序？</AlertDialogTitle>
          <AlertDialogDescription>
            这会移除 Mona 管理的 {deleteTarget ? executorLabels[deleteTarget.executor] : "引擎"} 程序文件，不会删除登录信息、会话或模型设置。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction onClick={() => { const target = deleteTarget; setDeleteTarget(null); if (target) void removeManaged(target); }}>删除程序</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <AlertDialog open={!!failure} onOpenChange={(value) => { if (!value) setFailure(null); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{failure?.title}</AlertDialogTitle>
          <AlertDialogDescription>{failure?.message}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>关闭</AlertDialogCancel>
          {failure?.retry && <AlertDialogAction onClick={() => { const retry = failure?.retry; setFailure(null); retry?.(); }}>重试</AlertDialogAction>}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>;
}
