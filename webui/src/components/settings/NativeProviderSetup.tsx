import { useCallback, useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";

import { DevelopmentLogin } from "@/components/development/DevelopmentLogin";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { DevelopmentApiError, developmentApi, executorLabels, type DevExecutor, type EngineInstallJob, type EngineResource, type NativeExecutorId } from "@/lib/development-api";
import { openExternalUrl } from "@/lib/tauri";

const WORKBUDDY_URL = "https://www.codebuddy.cn/work/";

type ResourceSnapshot = { resource: EngineResource | null; catalogAvailable: boolean };
type SetupAlert = { title: string; description: string; actionLabel?: string; action?: () => void };

function resourceIsAvailable(resource: EngineResource | null): boolean {
  return !!resource?.installed && !!resource.executable && (!resource.repairRequired || resource.usingManaged === false);
}

function jobIsActive(job: EngineInstallJob | null | undefined): job is EngineInstallJob {
  return !!job && job.state !== "completed" && job.state !== "failed" && job.state !== "cancelled";
}

function resourceCanBePrepared(snapshot: ResourceSnapshot | null): snapshot is ResourceSnapshot & { resource: EngineResource & { packRef: string } } {
  const resource = snapshot?.resource;
  return !!snapshot?.catalogAvailable
    && !!resource?.packRef
    && !resource.catalogError
    && (resource.canPrepare || resource.canUpdate || resource.repairRequired);
}

export function NativeProviderSetup({ executor, enabled, enableBusy, enableAvailable, onEnabledChange, onChanged }: {
  executor: DevExecutor;
  enabled: boolean;
  enableBusy: boolean;
  enableAvailable: boolean;
  onEnabledChange: (enabled: boolean) => void;
  onChanged: () => void;
}) {
  const engineId = executor.id as NativeExecutorId;
  const isWorkBuddy = engineId === "codebuddy";
  const label = executorLabels[engineId];
  const accountLabel = engineId === "codex" ? "ChatGPT" : engineId === "claude" ? "Claude" : label;
  const engineLabel = isWorkBuddy ? "Workbuddy" : label;
  const [readState, setReadState] = useState<"loading" | "ready" | "failed">("loading");
  const [snapshot, setSnapshot] = useState<ResourceSnapshot | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [job, setJob] = useState<EngineInstallJob | null>(null);
  const [pausedJobId, setPausedJobId] = useState<string | null>(null);
  const [loginBusy, setLoginBusy] = useState(false);
  const [managementOpen, setManagementOpen] = useState(false);
  const [managementReadState, setManagementReadState] = useState<"loading" | "ready" | "failed">("loading");
  const [deleteTarget, setDeleteTarget] = useState<EngineResource | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removalUncertain, setRemovalUncertain] = useState(false);
  const [removalComplete, setRemovalComplete] = useState(false);
  const [resourcesAuthoritative, setResourcesAuthoritative] = useState(false);
  const [alert, setAlert] = useState<SetupAlert | null>(null);
  const generation = useRef(0);
  const hasLoaded = useRef(false);
  const resourceReadId = useRef(0);
  const focusRefresh = useRef({ pending: false, lastStartedAt: 0 });
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const programAvailableRef = useRef(executor.programAvailable === true);
  programAvailableRef.current = executor.programAvailable === true;
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;

  const isCurrent = useCallback((epoch: number) => generation.current === epoch, []);

  const readResources = useCallback(async (refresh = false, showFailure = false, notifyAvailabilityChange = refresh): Promise<ResourceSnapshot | null> => {
    const epoch = generation.current;
    const requestId = ++resourceReadId.current;
    const requestIsCurrent = () => isCurrent(epoch) && resourceReadId.current === requestId;
    const wasAvailable = programAvailableRef.current || resourceIsAvailable(snapshotRef.current?.resource ?? null);
    if (hasLoaded.current) setRefreshing(true);
    else setReadState("loading");
    try {
      const result = await developmentApi.engineResources(engineId, refresh);
      if (!requestIsCurrent()) return null;
      const current: ResourceSnapshot = {
        resource: result.components.find((item) => item.executor === engineId) ?? null,
        catalogAvailable: result.catalogAvailable,
      };
      hasLoaded.current = true;
      setSnapshot(current);
      snapshotRef.current = current;
      setJob(current.resource?.job ?? null);
      setPausedJobId(null);
      setReadState("ready");
      if (notifyAvailabilityChange && wasAvailable !== (programAvailableRef.current || resourceIsAvailable(current.resource))) {
        developmentApi.refreshNativeProviders();
        onChangedRef.current();
      }
      return current;
    } catch {
      if (requestIsCurrent()) {
        if (!hasLoaded.current) setReadState("failed");
        else if (showFailure) {
          setAlert({
            title: "暂时无法读取组件状态",
            description: "没有确认组件是否可用，请重新检查后继续。",
            actionLabel: "重新检查",
            action: () => { void readResources(true, true); },
          });
        }
      }
      return null;
    } finally {
      if (requestIsCurrent()) setRefreshing(false);
    }
  }, [engineId, isCurrent]);

  const confirmAvailability = useCallback(async (epoch: number) => {
    const current = await readResources(true, false, false);
    if (!isCurrent(epoch)) return;
    if (current?.resource?.managedInstalled && !current.resource.repairRequired && resourceIsAvailable(current.resource)) {
      developmentApi.refreshNativeProviders();
      onChangedRef.current();
    } else {
      setAlert({
        title: "组件状态待确认",
        description: "准备已结束，但暂未确认组件可用。请重新检查后再继续。",
        actionLabel: "重新检查",
        action: () => { void readResources(true, true); },
      });
    }
  }, [isCurrent, readResources]);

  const refreshLoginProbe = useCallback(async function refreshLoginProbe() {
    const epoch = generation.current;
    try {
      const probe = await developmentApi.probe(undefined, engineId);
      if (!isCurrent(epoch)) return;
      developmentApi.refreshNativeProviders();
      onChangedRef.current();
      if (engineId === "codex" && probe.authMode !== "chatgpt") {
        setAlert({
          title: "ChatGPT 认证尚未确认",
          description: "暂时未确认 ChatGPT 订阅账号，请重新检查。",
          actionLabel: "重新检查",
          action: () => { void refreshLoginProbe(); },
        });
      }
    } catch {
      if (!isCurrent(epoch)) return;
      setAlert({
        title: "认证结果暂时无法确认",
        description: "认证记录会保留，请重新检查。",
        actionLabel: "重新检查",
        action: () => { void refreshLoginProbe(); },
      });
    }
  }, [engineId, isCurrent]);

  useEffect(() => {
    generation.current += 1;
    void readResources();
    return () => { generation.current += 1; };
  }, [readResources]);

  useEffect(() => {
    if (readState !== "ready") return;
    const refreshOnResume = () => {
      if (document.visibilityState !== "visible") return;
      const guard = focusRefresh.current;
      const now = Date.now();
      if (guard.pending || now - guard.lastStartedAt < 5_000) return;
      guard.pending = true;
      guard.lastStartedAt = now;
      void readResources(true).finally(() => { guard.pending = false; });
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") refreshOnResume();
    };
    window.addEventListener("focus", refreshOnResume);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("focus", refreshOnResume);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [executor.programAvailable, readResources, readState]);

  useEffect(() => {
    if (!jobIsActive(job) || pausedJobId === job.id) return;
    const epoch = generation.current;
    const timer = window.setTimeout(() => {
      void developmentApi.executorInstall(engineId, job.id).then((updated) => {
        if (!isCurrent(epoch)) return;
        setJob(updated);
        if (updated.state === "completed") {
          void confirmAvailability(epoch);
        } else if (updated.state === "failed") {
          setPausedJobId(updated.id);
          setAlert({
            title: "准备未能完成",
            description: "组件准备没有完成。请重新检查状态后再试。",
            actionLabel: "重新检查",
            action: () => { void readResources(true, true); },
          });
        }
      }).catch(() => {
        if (!isCurrent(epoch)) return;
        setPausedJobId(job.id);
        setAlert({
          title: "暂时无法读取准备进度",
          description: "准备任务仍可能在进行。请重新检查状态后继续。",
          actionLabel: "重新检查",
          action: () => { void readResources(true, true); },
        });
      });
    }, 900);
    return () => window.clearTimeout(timer);
  }, [confirmAvailability, engineId, isCurrent, job, pausedJobId, readResources]);

  // After removal, fresh resource detection takes precedence over the parent's old executor snapshot.
  const componentAvailable = (!resourcesAuthoritative && executor.programAvailable === true) || resourceIsAvailable(snapshot?.resource ?? null);
  const authenticated = componentAvailable && (engineId === "codex"
    ? executor.probe?.authMode === "chatgpt" : executor.probe?.authentication === "ready");
  const activeJob = jobIsActive(job) ? job : null;
  const totalBytes = activeJob?.totalBytes ?? 0;
  const progress = activeJob && totalBytes > 0
    ? Math.min(100, activeJob.downloadedBytes / totalBytes * 100)
    : null;

  const openWorkBuddySite = async () => {
    const epoch = generation.current;
    try {
      await openExternalUrl(WORKBUDDY_URL);
    } catch {
      if (!isCurrent(epoch)) return;
      setAlert({
        title: "无法打开 WorkBuddy 官网",
        description: "请稍后重试，或在浏览器中打开 WorkBuddy 官网。",
        actionLabel: "重试",
        action: () => { void openWorkBuddySite(); },
      });
    }
  };

  const prepareComponents = async (managedOnly = false) => {
    if (preparing || activeJob) return;
    const epoch = generation.current;
    setPreparing(true);
    setRemovalComplete(false);
    setAlert(null);
    try {
      const latest = await readResources(true, true);
      if (!isCurrent(epoch) || !latest) return;
      if (!managedOnly && !resourcesAuthoritative && programAvailableRef.current) return;
      if (resourceIsAvailable(latest.resource) && (!managedOnly || (latest.resource?.managedInstalled && !latest.resource.repairRequired && !latest.resource.canUpdate))) {
        await confirmAvailability(epoch);
        return;
      }
      if (jobIsActive(latest.resource?.job)) {
        setJob(latest.resource.job);
        return;
      }
      if (!resourceCanBePrepared(latest)) {
        if (latest) {
          setAlert({
            title: "组件资源暂不可用",
            description: "目前无法下载必要组件，请重新检查后再试。",
            actionLabel: "重新检查",
            action: () => { void readResources(true, true); },
          });
        }
        return;
      }
      const result = await developmentApi.prepareExecutor(
        engineId,
        latest.resource.packRef,
        latest.resource.repairRequired,
      );
      if (!isCurrent(epoch)) return;
      if (result.job) {
        setJob(result.job);
        setPausedJobId(null);
        if (result.job.state === "completed") {
          await confirmAvailability(epoch);
        } else if (result.job.state === "failed") {
          setPausedJobId(result.job.id);
          setAlert({
            title: "准备未能完成",
            description: "组件准备没有完成。请重新检查状态后再试。",
            actionLabel: "重新检查",
            action: () => { void readResources(true, true); },
          });
        }
      } else if (result.installed) {
        await confirmAvailability(epoch);
      } else {
        setAlert({
          title: "组件尚未就绪",
          description: "没有确认组件已准备完成。请重新检查后再继续。",
          actionLabel: "重新检查",
          action: () => { void readResources(true, true); },
        });
      }
    } catch {
      if (!isCurrent(epoch)) return;
      setAlert({
        title: "下载请求结果尚未确认",
        description: "任务仍可能在进行。请重新检查状态后继续。",
        actionLabel: "重新检查",
        action: () => { void readResources(true, true); },
      });
    } finally {
      if (isCurrent(epoch)) setPreparing(false);
    }
  };

  const cancelJob = async () => {
    if (!activeJob || cancelling) return;
    setCancelling(true);
    setAlert(null);
    const epoch = generation.current;
    try {
      const updated = await developmentApi.cancelExecutorInstall(engineId, activeJob.id);
      if (!isCurrent(epoch)) return;
      setJob(updated);
      if (updated.state === "cancelled") setPausedJobId(updated.id);
    } catch {
      if (isCurrent(epoch)) {
        setPausedJobId(activeJob.id);
        setAlert({
          title: "无法取消组件准备",
          description: "任务状态暂未确认。请重新检查状态后再继续。",
          actionLabel: "重新检查",
          action: () => { void readResources(true, true); },
        });
      }
    } finally {
      if (isCurrent(epoch)) setCancelling(false);
    }
  };

  const checkRemovalState = async () => {
    const epoch = generation.current;
    const latest = await readResources(true, false, false);
    if (!isCurrent(epoch)) return null;
    developmentApi.refreshNativeProviders();
    onChangedRef.current();
    if (latest?.resource) {
      setRemovalUncertain(false);
    } else {
      setAlert({
        title: "组件状态待确认",
        description: "暂时无法读取卸载后的组件状态，请重新检查后再继续。",
        actionLabel: "重新检查",
        action: () => { void checkRemovalState(); },
      });
    }
    return latest;
  };

  const removeManaged = async (target: EngineResource) => {
    if (removing || preparing || activeJob || loginBusy || removalUncertain) return;
    const epoch = generation.current;
    setRemoving(true);
    setAlert(null);
    try {
      const latest = await readResources(true, true, false);
      if (!isCurrent(epoch) || !latest) return;
      const resource = latest.resource;
      if (!resource?.managedInstalled || !resource.canDelete || jobIsActive(resource.job)
        || (resource.managedVersion ?? null) !== (target.managedVersion ?? null)) {
        setAlert({
          title: "组件状态已变化",
          description: "组件正在准备、版本已变化或已被移除，请重新检查后再卸载。",
          actionLabel: "重新检查",
          action: () => { void readResources(true, true); },
        });
        return;
      }
      setResourcesAuthoritative(true);
      setRemovalUncertain(true);
      const result = await developmentApi.deleteManagedExecutor(engineId, resource.managedVersion ?? undefined);
      if (!isCurrent(epoch)) return;
      if (!result.deleted) throw new Error("delete_unconfirmed");
      setRemovalComplete(true);
      setLoginBusy(false);
      setSnapshot(null);
      snapshotRef.current = null;
      hasLoaded.current = false;
      setReadState("loading");
      await checkRemovalState();
      if (isCurrent(epoch) && result.warning) {
        setAlert({
          title: "组件已卸载，使用设置待确认",
          description: "旧程序位置未能清理，后续准备可能暂时不可用。请重新检查当前状态。",
          actionLabel: "重新检查",
          action: () => { void checkRemovalState(); },
        });
      }
    } catch (cause) {
      if (!isCurrent(epoch)) return;
      const conflict = cause instanceof DevelopmentApiError && cause.code === "conflict";
      const incomplete = cause instanceof DevelopmentApiError && cause.code === "engine_remove_failed";
      setAlert({
        title: conflict ? "暂时无法卸载组件" : incomplete ? "组件卸载未完成" : "卸载结果待确认",
        description: conflict
          ? "当前有操作尚未结束，或组件状态已变化。请完成或取消相关操作后重新检查。"
          : incomplete ? "部分组件文件可能仍然存在，请重新检查当前状态后再继续。"
            : "暂时无法确认组件是否已卸载，请重新检查当前状态后再继续。",
        actionLabel: "重新检查",
        action: () => { void checkRemovalState(); },
      });
    } finally {
      if (isCurrent(epoch)) setRemoving(false);
    }
  };

  const refreshManagement = async () => {
    const epoch = generation.current;
    setManagementReadState("loading");
    const latest = await readResources(true, false, false);
    if (!isCurrent(epoch)) return;
    setManagementReadState(latest?.resource ? "ready" : "failed");
    if (latest?.resource && removalUncertain) {
      setResourcesAuthoritative(true);
      setRemovalUncertain(false);
      developmentApi.refreshNativeProviders();
      onChangedRef.current();
    }
  };

  const downloadAvailable = resourceCanBePrepared(snapshot);
  const resourceUnavailable = !snapshot?.catalogAvailable || !snapshot.resource?.packRef || !!snapshot.resource.catalogError;
  const alertAction = alert?.action;
  const managedResource = snapshot?.resource;
  const managementResource = managementReadState === "ready" ? managedResource : null;
  const detecting = managementReadState === "loading";
  const applicationInstalled = isWorkBuddy ? managementResource?.desktopAppDetected : managementResource?.systemAvailable;
  const selectedEngine = !managementResource ? "状态未确认"
    : !managementResource.installed || !managementResource.executable ? "尚无可用引擎"
      : managementResource.usingManaged === true ? "Mona 托管引擎"
        : managementResource.usingManaged === false ? managementResource.source === "desktop_application" ? `${label} 应用` : "本机已有引擎" : "状态未确认";
  const appComponentUnavailable = isWorkBuddy && managedResource?.desktopAppDetected === true;
  const componentManagement = <Button type="button" variant="ghost" size="xs" className="font-normal" disabled={removing} onClick={() => {
    setManagementOpen(true);
    void refreshManagement();
  }}>管理引擎</Button>;
  const loginControl = <DevelopmentLogin
    executor={engineId}
    disabled={!componentAvailable || removing || removalUncertain}
    authorizationRequired={engineId === "codex" || authenticated || executor.probe?.authentication === "required"}
    actionLabel={authenticated ? "重新认证" : `认证 ${accountLabel}`}
    actionVariant={authenticated ? "ghost" : "default"}
    inline={authenticated}
    compactNotice
    onStateChanged={(state) => setLoginBusy(["starting", "waiting", "cancelling", "unknown"].includes(state))}
    onChanged={refreshLoginProbe}
  />;

  return (
    <>
      {!componentAvailable && readState === "loading" ? (
        <div className="rounded-xl bg-muted/40 p-4 text-caption text-muted-foreground" role="status">
          正在检查 {label} 组件状态…
        </div>
      ) : !componentAvailable && readState === "failed" ? (
        <div className="space-y-3 rounded-xl bg-muted/40 p-4">
          <p role="alert" className="text-caption text-muted-foreground">暂时无法读取 {label} 组件状态，尚未确认是否可用。</p>
          <Button type="button" variant="outline" size="sm" disabled={refreshing} onClick={() => removalUncertain ? void checkRemovalState() : void readResources(true, true)}>
            {refreshing ? "正在重新检查…" : "重新检查"}
          </Button>
        </div>
      ) : !componentAvailable ? (
        <section className="space-y-4 rounded-xl bg-muted/40 p-4">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-title-sm font-semibold">{!isWorkBuddy ? `准备 ${label} 引擎` : appComponentUnavailable ? "暂未能使用 WorkBuddy 应用" : "不安装应用，也能使用订阅"}</h3>
              {componentManagement}
            </div>
            <p className="text-caption text-muted-foreground">{!isWorkBuddy ? `下载必要组件后，认证 ${accountLabel} 账号即可使用订阅。` : appComponentUnavailable ? "已检测到应用，但未找到可复用的组件。请更新 WorkBuddy 后重新检查。" : "两种方式任选其一，无需重复下载。"}</p>
            {appComponentUnavailable && <Button type="button" variant="outline" size="sm" disabled={refreshing} onClick={() => void readResources(true, true)}>
              {refreshing ? "正在重新检查…" : "重新检查"}
            </Button>}
          </div>
          <div className="space-y-4">
            <div className="space-y-3">
              {isWorkBuddy && <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h4 className="text-ui font-medium">{appComponentUnavailable ? "也可使用 Mona 托管引擎" : "在 Mona 中使用订阅"}</h4>
                  {!appComponentUnavailable && <span className="text-micro text-muted-foreground">推荐</span>}
                </div>
                <p className="mt-1 text-caption text-muted-foreground">{appComponentUnavailable ? "无需更改已安装的应用，可按需下载独立组件。" : "无需安装 WorkBuddy 应用，只下载必要组件。"}</p>
              </div>}
              {activeJob ? (
                <div className="space-y-2" role="status">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-caption text-muted-foreground">
                    <span>{pausedJobId === activeJob.id ? "进度暂不可用，请重新检查。" : "正在准备必要组件…"}</span>
                    {progress !== null && <span>{Math.round(progress)}%</span>}
                  </div>
                  <Progress value={progress ?? 0} aria-label="组件准备进度" />
                  <div className="flex flex-wrap items-center gap-2">
                    <Button type="button" variant="outline" size="sm" disabled={cancelling} onClick={() => void cancelJob()}>
                      {cancelling ? "正在取消…" : "取消"}
                    </Button>
                    {pausedJobId === activeJob.id && <Button type="button" variant="ghost" size="sm" disabled={refreshing} onClick={() => void readResources(true, true)}>重新检查</Button>}
                  </div>
                </div>
              ) : (
                <Button type="button" size="sm" disabled={!downloadAvailable || preparing || refreshing || removing || removalUncertain} onClick={() => void prepareComponents()}>
                  {preparing ? "正在准备…" : "下载必要组件"}
                </Button>
              )}
              {resourceUnavailable && !activeJob && !appComponentUnavailable && <div className="flex flex-wrap items-center gap-2 text-caption text-muted-foreground">
                <span>必要组件暂不可用，请重新检查。</span>
                <Button type="button" variant="ghost" size="sm" disabled={refreshing} onClick={() => void readResources(true, true)}>
                  {refreshing ? "正在重新检查…" : "重新检查"}
                </Button>
              </div>}
            </div>
            {isWorkBuddy && !managedResource?.desktopAppDetected && <div className="space-y-2 border-t border-border/50 pt-4">
              <div>
                <h4 className="text-ui font-medium">也想单独使用 WorkBuddy？</h4>
                <p className="mt-1 text-caption text-muted-foreground">前往官网选择并下载安装适合你的应用版本。</p>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={() => void openWorkBuddySite()}>
                下载 WorkBuddy 应用
              </Button>
            </div>}
          </div>
        </section>
      ) : (
        <section className="space-y-3 rounded-xl bg-muted/40 p-4">
          <div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-title-sm font-semibold">{authenticated ? `${label} 已准备就绪` : `使用 ${accountLabel} 订阅的条件已就绪`}</h3>
              {authenticated && <div className="flex items-center gap-2">
                <span className="text-caption text-muted-foreground">{enabled ? "已开启" : "已关闭"}</span>
                <Switch checked={enabled} disabled={!enableAvailable || enableBusy || removing || removalUncertain || loginBusy} onCheckedChange={onEnabledChange} aria-label={`${label} 启用状态`} />
              </div>}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-caption text-muted-foreground">
              <div className="inline-flex flex-wrap items-center gap-1">
                {authenticated
                  ? !loginBusy && <span className="inline-flex items-center gap-1 text-success"><Check className="h-3.5 w-3.5" aria-hidden="true" />已认证</span>
                  : <span>账号尚未认证</span>}
                {authenticated && loginControl}
              </div>
              <span className="inline-flex items-center gap-1"><Check className="h-3.5 w-3.5 text-success" aria-hidden="true" />{engineLabel}引擎</span>
              {componentManagement}
            </div>
          </div>
          {!authenticated && loginControl}
        </section>
      )}

      {removalComplete && <p role="status" className="mt-2 text-caption text-muted-foreground">Mona 下载的组件已卸载。</p>}

      <Dialog open={managementOpen} onOpenChange={setManagementOpen}>
        <DialogContent className="scrollbar-thin scrollbar-track-transparent max-h-[80vh] max-w-3xl overflow-y-auto">
          <div className="flex items-start gap-3">
            <DialogHeader className="min-w-0 flex-1 text-left">
              <DialogTitle>管理引擎 · {label}</DialogTitle>
              <DialogDescription>本机安装与 Mona 托管可以同时存在，分别管理。</DialogDescription>
            </DialogHeader>
            <Button type="button" variant="outline" size="sm" className="shrink-0" disabled={detecting || removing} onClick={() => void refreshManagement()}>{detecting ? "检测中…" : "重新检测"}</Button>
          </div>
          {managementReadState === "failed" && <p role="alert" className="text-caption text-muted-foreground">未能读取最新状态，请重新检测。</p>}
          <div className="grid items-stretch gap-4 sm:grid-cols-2">
            <section aria-label={isWorkBuddy ? "WorkBuddy 应用" : `本机 ${label} 引擎`} className="flex min-w-0 flex-col gap-3 rounded-xl bg-muted/50 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-title-sm font-semibold">{isWorkBuddy ? "WorkBuddy 应用" : `本机 ${label} 引擎`}</h3>
                <span className="text-caption text-muted-foreground">{detecting ? "检测中…" : applicationInstalled === true ? "已安装" : applicationInstalled === false ? "未检测到" : "状态未确认"}</span>
              </div>
              <p className="flex-1 text-caption text-muted-foreground">{isWorkBuddy ? "电脑中单独安装的 WorkBuddy 桌面应用。" : "电脑中已有的引擎程序，由你独立安装和维护。"}</p>
              {isWorkBuddy && applicationInstalled === false && <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => void openWorkBuddySite()}>下载 WorkBuddy 应用</Button>}
            </section>
            <section aria-label="Mona 托管引擎" className="flex min-w-0 flex-col gap-3 rounded-xl bg-muted/50 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-title-sm font-semibold">Mona 托管引擎</h3>
                <span className="text-caption text-muted-foreground">{detecting ? "检测中…" : !managementResource ? "状态未确认" : managementResource.managedInstalled ? managementResource.repairRequired ? "需修复" : "已安装" : "未安装"}</span>
              </div>
              <div className="flex-1 space-y-2 text-caption text-muted-foreground">
                <p>由 Mona 下载和维护，卸载只移除这份引擎。</p>
                {managementResource?.managedVersion && <p>版本 {managementResource.managedVersion}</p>}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {managementResource && resourceCanBePrepared(snapshot) && !activeJob && <Button type="button" variant="outline" size="sm" disabled={preparing || refreshing || removing || loginBusy || removalUncertain} onClick={() => void prepareComponents(true)}>
                  {preparing ? "正在准备…" : managementResource.repairRequired ? "修复托管引擎" : managementResource.managedInstalled ? "更新托管引擎" : "安装托管引擎"}
                </Button>}
                {managementResource?.managedInstalled && managementResource.canDelete && <Button type="button" variant="ghost" size="sm" className="text-destructive hover:text-destructive" disabled={preparing || refreshing || removing || !!activeJob || loginBusy || enableBusy || removalUncertain} onClick={() => {
                  setManagementOpen(false);
                  setDeleteTarget(managementResource);
                }}>卸载托管引擎</Button>}
              </div>
              {activeJob && <div className="space-y-2" role="status">
                <p className="text-caption text-muted-foreground">{pausedJobId === activeJob.id ? "进度暂未确认，请重新检测。" : "正在准备托管引擎…"}</p>
                <Progress value={progress ?? 0} aria-label="托管引擎准备进度" />
                <Button type="button" variant="outline" size="sm" disabled={cancelling} onClick={() => void cancelJob()}>{cancelling ? "正在取消…" : "取消准备"}</Button>
              </div>}
            </section>
          </div>
          <div className="flex items-end gap-4">
            <section aria-label="当前使用" className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-caption">
                <h3 className="font-medium text-muted-foreground">当前使用</h3>
                <p>{detecting ? "检测中…" : selectedEngine}</p>
              </div>
              {managementResource?.installed && managementResource.executable && <p className="mt-1 break-all text-micro text-muted-foreground">{managementResource.executable}</p>}
            </section>
            <Button type="button" variant="outline" className="shrink-0" onClick={() => setManagementOpen(false)}>关闭</Button>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>卸载 Mona 下载的组件？</AlertDialogTitle>
            <AlertDialogDescription>仅卸载 Mona 下载的必要组件，{isWorkBuddy ? "不会卸载 WorkBuddy 应用或你自行安装的程序" : "不会删除你自行安装的程序"}。账号认证、会话和模型偏好会保留。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => {
              const target = deleteTarget;
              setDeleteTarget(null);
              if (target) void removeManaged(target);
            }}>卸载组件</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!alert} onOpenChange={(open) => { if (!open) setAlert(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{alert?.title}</AlertDialogTitle>
            <AlertDialogDescription>{alert?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>关闭</AlertDialogCancel>
            {alertAction && <AlertDialogAction onClick={() => {
              setAlert(null);
              alertAction();
            }}>{alert.actionLabel ?? "重试"}</AlertDialogAction>}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
