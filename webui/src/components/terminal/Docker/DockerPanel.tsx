import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, Box, FilePlus2, HardDrive, Loader2, MoreHorizontal, RefreshCw, Search, SquareTerminal } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { StatusNotice } from "@/components/ui/status-notice";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import {
  dockerContainerAction,
  dockerCancelActiveOperation,
  dockerCheckImageUpdate,
  dockerContainerLogs,
  dockerInspectContainer,
  dockerListComposeProjects,
  dockerListContainers,
  dockerListResources,
  dockerProbe,
  dockerReadComposeFile,
  dockerRemoveResource,
  dockerSubscribeLogs,
  dockerUnsubscribeLogs,
  onDockerLogEnded,
  onDockerLogOutput,
} from "./docker-ipc";
import type {
  ComposeProject,
  DockerContainer,
  DockerContainerAction,
  DockerContainerDetail,
  DockerImageUpdate,
  DockerProbe,
  DockerResourceKind,
  DockerResourceSnapshot,
  DockerSnapshot,
} from "./types";
import { ComposeManager } from "./ComposeManager";
import { ContainerTerminalDialog } from "./ContainerTerminalDialog";

export type DockerParentStatus = "connected" | "connecting" | "disconnected" | "error";

export interface DockerPanelProps {
  parentSessionId: string;
  parentStatus: DockerParentStatus;
  hostTitle: string;
  visible: boolean;
}

type ContainerFilter = "all" | "running" | "stopped" | "abnormal";
type DockerTab = "containers" | "compose" | "storage";

const MAX_LIVE_LOG_BYTES = 2 * 1024 * 1024;

const STATE_LABELS: Record<string, string> = {
  running: "运行中",
  created: "已创建",
  paused: "已暂停",
  restarting: "重启中",
  exited: "已退出",
  dead: "已停止",
  unknown: "未知",
};

const HEALTH_LABELS: Record<string, string> = {
  healthy: "健康",
  unhealthy: "不健康",
  starting: "检查中",
  none: "未配置",
  unknown: "未知",
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatBytes(value: number | null): string {
  if (value == null) return "不可用";
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let amount = value;
  let unit = -1;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount.toFixed(amount >= 10 ? 0 : 1)} ${units[unit]}`;
}

function formatPercent(value: string | null): string {
  return value == null || value.trim() === "" ? "不可用" : value;
}

function stateTone(state: string): string {
  if (state === "running") return "border-success/40 bg-success/10 text-success";
  if (state === "restarting") return "border-warning/40 bg-warning/10 text-warning";
  if (state === "exited" || state === "dead") return "border-destructive/30 bg-destructive/5 text-destructive";
  return "border-border/70 text-muted-foreground";
}

function healthTone(health: string | null): string {
  if (health === "healthy") return "text-success";
  if (health === "unhealthy") return "text-destructive";
  if (health === "starting") return "text-warning";
  return "text-muted-foreground";
}

function containerHealth(container: DockerContainer): string | null {
  const status = container.status.toLowerCase();
  if (status.includes("unhealthy")) return "unhealthy";
  if (status.includes("healthy")) return "healthy";
  if (status.includes("health: starting")) return "starting";
  return null;
}

function containerAbnormal(container: DockerContainer): boolean {
  const status = container.status.toLowerCase();
  if (container.state === "dead" || container.state === "restarting") return true;
  if (status.includes("unhealthy") || status.includes("oom")) return true;
  const exited = status.match(/exited\s*\((\d+)\)/);
  return exited ? exited[1] !== "0" : false;
}

function appendBoundedOutput(current: string, chunk: string): { text: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(current + chunk);
  if (bytes.byteLength <= MAX_LIVE_LOG_BYTES) {
    return { text: current + chunk, truncated: false };
  }
  return {
    text: new TextDecoder().decode(bytes.slice(-MAX_LIVE_LOG_BYTES)),
    truncated: true,
  };
}

function containerActions(state: string): DockerContainerAction[] {
  if (state === "running" || state === "restarting") return ["stop", "restart"];
  if (state === "paused") return ["stop", "restart"];
  return ["start", "remove"];
}

const ACTION_LABELS: Record<DockerContainerAction, string> = {
  start: "启动",
  stop: "停止",
  restart: "重启",
  remove: "删除",
};

export function DockerPanel({ parentSessionId, parentStatus, visible }: DockerPanelProps) {
  const connected = parentStatus === "connected";
  const [probe, setProbe] = useState<DockerProbe | null>(null);
  const [snapshot, setSnapshot] = useState<DockerSnapshot | null>(null);
  const [projects, setProjects] = useState<ComposeProject[]>([]);
  const [associatedProjects, setAssociatedProjects] = useState<ComposeProject[]>([]);
  const [resources, setResources] = useState<DockerResourceSnapshot | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedProjectKey, setSelectedProjectKey] = useState<string | null>(null);
  const [detail, setDetail] = useState<DockerContainerDetail | null>(null);
  const [recentLogs, setRecentLogs] = useState<string>("");
  const [liveLogs, setLiveLogs] = useState<string>("");
  const [liveTruncated, setLiveTruncated] = useState(false);
  const [logMode, setLogMode] = useState<"recent" | "live">("recent");
  const [subscriptionId, setSubscriptionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [resourceLoading, setResourceLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [logsLoading, setLogsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [containerError, setContainerError] = useState<string | null>(null);
  const [resourceError, setResourceError] = useState<string | null>(null);
  const [resourceMessage, setResourceMessage] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<DockerContainerAction | null>(null);
  const [resourceBusy, setResourceBusy] = useState<string | null>(null);
  const [imageUpdateBusy, setImageUpdateBusy] = useState<string | null>(null);
  const [imageUpdates, setImageUpdates] = useState<Record<string, DockerImageUpdate>>({});
  const [terminalTarget, setTerminalTarget] = useState<{ id: string; name: string } | null>(null);
  const [associateOpen, setAssociateOpen] = useState(false);
  const [associatePath, setAssociatePath] = useState("");
  const [associateName, setAssociateName] = useState("");
  const [associateBusy, setAssociateBusy] = useState(false);
  const [associateError, setAssociateError] = useState<string | null>(null);
  const [filter, setFilter] = useState<ContainerFilter>("all");
  const [search, setSearch] = useState("");
  const [activeTab, setActiveTab] = useState<DockerTab>("containers");
  const [detailRefresh, setDetailRefresh] = useState(0);
  const subscriptionRef = useRef<string | null>(null);
  const liveLogsRef = useRef("");
  const loadRequestRef = useRef(0);
  const pollInFlightRef = useRef(false);
  const associationsLoadedKeyRef = useRef<string | null>(null);

  const stopLogSubscription = useCallback(() => {
    const current = subscriptionRef.current;
    subscriptionRef.current = null;
    setSubscriptionId(null);
    if (current) {
      void dockerUnsubscribeLogs(current).catch(() => {});
    }
  }, []);

  const loadResources = useCallback(
    async (probeOverride?: DockerProbe | null) => {
      if (!visible || !connected || !parentSessionId) return;
      const targetProbe = probeOverride ?? probe;
      if (!targetProbe?.available) {
        setResourceError("请先完成 Docker 环境探测。");
        return;
      }
      setResourceLoading(true);
      setResourceError(null);
      try {
        setResources(await dockerListResources(parentSessionId));
      } catch (reason) {
        setResourceError(`镜像与空间读取失败：${errorMessage(reason)}`);
      } finally {
        setResourceLoading(false);
      }
    },
    [connected, parentSessionId, probe, visible],
  );

  const load = useCallback(async (): Promise<DockerProbe | null> => {
    if (!connected || !parentSessionId) return null;
    const requestId = ++loadRequestRef.current;
    setLoading(true);
    setError(null);
    setContainerError(null);
    let probed: DockerProbe;
    try {
      probed = await dockerProbe(parentSessionId);
    } catch (reason) {
      if (requestId === loadRequestRef.current && connected) {
        setError(`运行时探测失败：${errorMessage(reason)}`);
        setLoading(false);
      }
      return null;
    }
    if (requestId !== loadRequestRef.current || !connected) return null;
    setProbe(probed);
    if (!probed.available) {
      setError(probed.issue || "远程主机未提供可用的 Docker Engine。");
      setLoading(false);
      return probed;
    }

    const [snapshotResult, projectsResult] = await Promise.allSettled([
      dockerListContainers(parentSessionId),
      dockerListComposeProjects(parentSessionId),
    ]);
    if (requestId !== loadRequestRef.current || !connected) return probed;
    const failures: string[] = [];
    if (snapshotResult.status === "fulfilled") {
      setSnapshot(snapshotResult.value);
      setContainerError(null);
    } else {
      setContainerError(`容器列表读取失败：${errorMessage(snapshotResult.reason)}`);
    }
    if (projectsResult.status === "fulfilled") setProjects(projectsResult.value);
    else if (probed.composeVersion) failures.push(`Compose 项目读取失败：${errorMessage(projectsResult.reason)}`);
    setError(failures.length > 0 ? failures.join("；") : null);
    setLoading(false);
    return probed;
  }, [connected, parentSessionId]);

  useEffect(() => {
    if (connected && visible) void load();
  }, [connected, load, visible]);

  useEffect(() => {
    if (!visible || activeTab !== "containers" || !connected || !probe?.available || loading) return;
    let active = true;
    const timer = window.setInterval(() => {
      if (pollInFlightRef.current || actionBusy) return;
      pollInFlightRef.current = true;
      void dockerListContainers(parentSessionId)
        .then((next) => {
          if (active) {
            setSnapshot(next);
            setContainerError(null);
          }
        })
        .catch((reason) => {
          if (active) setContainerError(`容器列表刷新失败：${errorMessage(reason)}`);
        })
        .finally(() => {
          pollInFlightRef.current = false;
        });
    }, 5_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [actionBusy, activeTab, connected, loading, parentSessionId, probe?.available, visible]);

  useEffect(() => {
    if (!connected) {
      loadRequestRef.current += 1;
      setLoading(false);
    }
  }, [connected]);

  useEffect(() => {
    if (activeTab === "storage" && connected && probe?.available) {
      void loadResources(probe);
    }
  }, [activeTab, connected, loadResources, probe]);

  useEffect(() => {
    if (!snapshot) return;
    setSelectedId((current) =>
      current && snapshot.containers.some((container) => container.id === current)
        ? current
        : snapshot.containers[0]?.id ?? null,
    );
  }, [snapshot]);

  const visibleProjects = useMemo(() => {
    const discoveredPaths = new Set(
      projects.map((project) => project.configFile).filter(Boolean),
    );
    return [
      ...projects,
      ...associatedProjects.filter(
        (project) => !project.configFile || !discoveredPaths.has(project.configFile),
      ),
    ];
  }, [associatedProjects, projects]);

  const associationStorageKey = probe?.engineId
    ? `mona:docker:compose:${encodeURIComponent(probe.targetLabel)}:${probe.engineId}`
    : null;

  useEffect(() => {
    if (!associationStorageKey) return;
    try {
      const parsed = JSON.parse(localStorage.getItem(associationStorageKey) ?? "[]") as unknown;
      const stored = Array.isArray(parsed)
        ? parsed.filter(
            (item): item is ComposeProject =>
              typeof item === "object" &&
              item !== null &&
              typeof (item as ComposeProject).name === "string" &&
              typeof (item as ComposeProject).configFile === "string" &&
              (item as ComposeProject).configFile!.startsWith("/"),
          )
        : [];
      setAssociatedProjects(stored);
    } catch {
      setAssociatedProjects([]);
    }
    associationsLoadedKeyRef.current = associationStorageKey;
  }, [associationStorageKey]);

  useEffect(() => {
    if (!associationStorageKey || associationsLoadedKeyRef.current !== associationStorageKey) return;
    localStorage.setItem(associationStorageKey, JSON.stringify(associatedProjects));
  }, [associatedProjects, associationStorageKey]);

  useEffect(() => {
    setSelectedProjectKey((current) => {
      const keys = visibleProjects.map((project) => `${project.name}:${project.configFile ?? ""}`);
      return current && keys.includes(current) ? current : keys[0] ?? null;
    });
  }, [visibleProjects]);

  useEffect(() => {
    if (!visible || activeTab !== "containers" || !connected || !selectedId || !parentSessionId) return;
    let active = true;
    setDetail(null);
    setRecentLogs("");
    liveLogsRef.current = "";
    setLiveLogs("");
    setLiveTruncated(false);
    setDetailLoading(true);
    setLogsLoading(true);
    setDetailError(null);
    setActionError(null);
    setActionMessage(null);
    Promise.allSettled([
      dockerInspectContainer(parentSessionId, selectedId),
      dockerContainerLogs(parentSessionId, selectedId, 200),
    ]).then(([detailResult, logsResult]) => {
      if (!active) return;
      if (detailResult.status === "fulfilled") setDetail(detailResult.value);
      else setDetailError(`详情读取失败：${errorMessage(detailResult.reason)}`);
      if (logsResult.status === "fulfilled") {
        const output = [
          logsResult.value.stdout,
          logsResult.value.stderr ? `[stderr]\n${logsResult.value.stderr}` : "",
        ]
          .filter(Boolean)
          .join("\n");
        setRecentLogs(`${output}${logsResult.value.truncated ? "\n\n[日志已截断]" : ""}`);
      } else {
        setDetailError((current) =>
          [current, `日志读取失败：${errorMessage(logsResult.reason)}`].filter(Boolean).join("；"),
        );
      }
      setDetailLoading(false);
      setLogsLoading(false);
    });
    return () => {
      active = false;
    };
  }, [activeTab, connected, detailRefresh, parentSessionId, selectedId, visible]);

  useEffect(() => {
    let active = true;
    const outputListener = onDockerLogOutput((event) => {
      if (!active || event.subscriptionId !== subscriptionRef.current) return;
      const next = appendBoundedOutput(liveLogsRef.current, event.data);
      liveLogsRef.current = next.text;
      setLiveLogs(next.text);
      if (next.truncated) setLiveTruncated(true);
    });
    const endedListener = onDockerLogEnded((event) => {
      if (!active || event.subscriptionId !== subscriptionRef.current) return;
      subscriptionRef.current = null;
      setSubscriptionId(null);
    });
    return () => {
      active = false;
      stopLogSubscription();
      void outputListener.then((unlisten) => unlisten()).catch(() => {});
      void endedListener.then((unlisten) => unlisten()).catch(() => {});
    };
  }, [stopLogSubscription]);

  useEffect(() => {
    if (!visible || activeTab !== "containers" || logMode !== "live" || !connected || !selectedId || !parentSessionId) {
      stopLogSubscription();
      return;
    }
    let active = true;
    liveLogsRef.current = "";
    setLiveLogs("");
    setLiveTruncated(false);
    void dockerSubscribeLogs(parentSessionId, selectedId, 200)
      .then((id) => {
        if (!active) {
          void dockerUnsubscribeLogs(id).catch(() => {});
          return;
        }
        subscriptionRef.current = id;
        setSubscriptionId(id);
      })
      .catch((reason) => {
        if (active) setDetailError(`实时日志订阅失败：${errorMessage(reason)}`);
      });
    return () => {
      active = false;
      stopLogSubscription();
    };
  }, [activeTab, connected, parentSessionId, selectedId, logMode, stopLogSubscription, visible]);

  const filteredContainers = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (snapshot?.containers ?? []).filter((container) => {
      const matchesFilter =
        filter === "all" ||
        (filter === "running"
          ? container.state === "running"
          : filter === "stopped"
            ? container.state !== "running"
            : containerAbnormal(container));
      const matchesSearch =
        !needle ||
        [container.name, container.id, container.image, container.composeProject ?? ""]
          .join(" ")
          .toLowerCase()
          .includes(needle);
      return matchesFilter && matchesSearch;
    });
  }, [filter, search, snapshot]);

  const runningCount = snapshot?.containers.filter((container) => container.state === "running").length ?? 0;
  const readError = [error, containerError].filter(Boolean).join("；");

  const handleContainerAction = useCallback(
    async (containerId: string, action: DockerContainerAction) => {
      if (!visible || !connected || !containerId || !parentSessionId) return;
      setSelectedId(containerId);
      setActionBusy(action);
      setActionError(null);
      setActionMessage(null);
      try {
        const result = await dockerContainerAction(parentSessionId, containerId, action);
        setActionMessage(result.verification);
      } catch (reason) {
        setActionError(errorMessage(reason));
      } finally {
        await load();
        setDetailRefresh((value) => value + 1);
        setActionBusy(null);
      }
    },
    [connected, load, parentSessionId, visible],
  );

  const handleCancelOperation = useCallback(async () => {
    try {
      const cancelled = await dockerCancelActiveOperation(parentSessionId);
      setActionMessage(
        cancelled ? "正在取消；完成后将刷新实际状态。" : "操作尚在等待确认，请在确认窗口中拒绝。",
      );
    } catch (reason) {
      setActionError(errorMessage(reason));
    }
  }, [parentSessionId]);

  const handleRemoveResource = useCallback(
    async (kind: DockerResourceKind, resourceId: string) => {
      if (!visible || !connected || !parentSessionId) return;
      const busyKey = `${kind}:${resourceId}`;
      setResourceBusy(busyKey);
      setResourceError(null);
      setResourceMessage(null);
      try {
        const result = await dockerRemoveResource(parentSessionId, kind, resourceId);
        setResourceMessage(result.verification);
        await loadResources();
      } catch (reason) {
        setResourceError(errorMessage(reason));
      } finally {
        setResourceBusy(null);
      }
    },
    [connected, loadResources, parentSessionId, visible],
  );

  const handleCheckImageUpdate = useCallback(
    async (reference: string) => {
      if (!visible || !connected || !parentSessionId) return;
      setImageUpdateBusy(reference);
      setResourceError(null);
      try {
        const result = await dockerCheckImageUpdate(parentSessionId, reference);
        setImageUpdates((current) => ({ ...current, [reference]: result }));
      } catch (reason) {
        setResourceError(errorMessage(reason));
      } finally {
        setImageUpdateBusy(null);
      }
    },
    [connected, parentSessionId, visible],
  );

  const handleAssociateProject = useCallback(async () => {
      if (!visible || !connected || !associatePath.trim()) return;
    setAssociateBusy(true);
    setAssociateError(null);
    try {
      const file = await dockerReadComposeFile(parentSessionId, associatePath.trim());
      const fallbackName = file.workingDirectory.split("/").filter(Boolean).at(-1) || "compose";
      const name = associateName.trim() || fallbackName;
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) {
        throw new Error("项目名只能包含字母、数字、点、下划线和短横线");
      }
      const project: ComposeProject = {
        name,
        status: "已关联",
        configFile: file.resolvedPath,
        manageable: true,
        limitation: null,
      };
      setAssociatedProjects((current) => [
        ...current.filter((item) => item.configFile !== project.configFile),
        project,
      ]);
      setSelectedProjectKey(`${project.name}:${project.configFile}`);
      setAssociateOpen(false);
      setAssociatePath("");
      setAssociateName("");
    } catch (reason) {
      setAssociateError(errorMessage(reason));
    } finally {
      setAssociateBusy(false);
    }
  }, [associateName, associatePath, connected, parentSessionId, visible]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="min-h-0 flex-1 overflow-hidden p-3">
        {!connected ? (
          <StatusNotice tone="warning" title={parentStatus === "connecting" ? "SSH 会话连接中" : "SSH 会话已断开"}>
            {snapshot
              ? "当前显示最近一次读取的 Docker 快照；重新连接后请刷新。"
              : "Docker 管理需要一个已连接的 SSH 会话。"}
          </StatusNotice>
        ) : null}
        {readError && connected ? (
          <StatusNotice tone="danger" title="Docker 数据读取不完整" className="mb-3">
            {readError}
          </StatusNotice>
        ) : null}
        {snapshot?.warnings.length ? (
          <StatusNotice tone="warning" title="部分 Docker 指标不可用" className="mb-3">
            {snapshot.warnings.join("；")}
          </StatusNotice>
        ) : null}
        {probe && !probe.available ? (
          <StatusNotice tone="danger" title="Docker 不可用" className="mb-3">
            {probe.issue || "远程主机未提供可用的 Docker Engine。"}
            {probe.podmanAvailable ? " 已检测到 Podman，当前版本暂不执行 Podman 操作。" : ""}
          </StatusNotice>
        ) : null}
        <Tabs
          value={activeTab}
          onValueChange={(value) => setActiveTab(value as DockerTab)}
          className="flex h-full min-h-0 flex-col"
        >
          <TabsList className="h-8 shrink-0 justify-start rounded-md bg-muted/60 p-0.5">
            <TabsTrigger value="containers" className="h-7 gap-1.5 px-2.5">
              <Box className="h-3.5 w-3.5" /> 容器 <span className="text-micro text-muted-foreground">{runningCount}/{snapshot?.containers.length ?? 0}</span>
            </TabsTrigger>
            <TabsTrigger value="compose" className="h-7 px-2.5">Compose 项目</TabsTrigger>
            <TabsTrigger value="storage" className="h-7 gap-1.5 px-2.5">
              <HardDrive className="h-3.5 w-3.5" /> 镜像与空间
            </TabsTrigger>
          </TabsList>

          <TabsContent value="containers" className="min-h-0 flex-1 overflow-hidden">
            <div className="flex h-full min-h-0 flex-col gap-2">
              <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                <div className="relative min-w-[180px] flex-1 sm:max-w-xs">
                  <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="搜索容器、镜像或项目"
                    className="h-7 pl-7 text-caption"
                    aria-label="搜索容器"
                  />
                </div>
                {(["all", "running", "stopped", "abnormal"] as ContainerFilter[]).map((value) => (
                  <Button
                    key={value}
                    type="button"
                    variant={filter === value ? "secondary" : "ghost"}
                    size="xs"
                    onClick={() => setFilter(value)}
                  >
                    {value === "all"
                      ? "全部"
                      : value === "running"
                        ? "运行中"
                        : value === "stopped"
                          ? "已停止"
                          : "异常"}
                  </Button>
                ))}
                <div className="ml-auto flex items-center gap-1.5">
                  {snapshot ? (
                    <span className="text-micro text-muted-foreground">
                      更新于 {new Date(snapshot.capturedAt).toLocaleTimeString()}
                    </span>
                  ) : null}
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="gap-1"
                    disabled={!connected || loading}
                    onClick={() => void load()}
                    aria-label="刷新 Docker 状态"
                  >
                    {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                    刷新
                  </Button>
                </div>
              </div>
              {loading && !snapshot ? (
                <div className="flex flex-1 items-center justify-center text-caption text-muted-foreground">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 读取 Docker 状态…
                </div>
              ) : snapshot ? (
                <div className="grid min-h-0 flex-1 grid-cols-1 gap-2 lg:grid-cols-[minmax(0,1fr)_minmax(260px,34%)]">
                  <div className="scrollbar-thin min-h-0 overflow-auto rounded-md border border-border/70 bg-card">
                    {filteredContainers.length > 0 ? (
                      <table className="w-full border-collapse text-caption" data-testid="docker-container-table">
                        <thead>
                          <tr>
                            {['容器', '状态', '镜像', '项目', '资源', '端口', '操作'].map((heading) => (
                              <th key={heading} className="sticky top-0 z-10 whitespace-nowrap bg-muted px-2.5 py-1.5 text-left text-micro font-semibold text-muted-foreground">
                                {heading}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {filteredContainers.map((container) => {
                            const health = containerHealth(container);
                            const actions = containerActions(container.state);
                            const usesHostNetwork = container.networks
                              .split(",")
                              .some((network) => network.trim() === "host");
                            const ports = container.ports || (usesHostNetwork ? "Host 网络" : "未映射");
                            return (
                              <tr
                                key={container.id}
                                data-testid={`docker-container-${container.id}`}
                                aria-selected={container.id === selectedId}
                                tabIndex={0}
                                className={`cursor-pointer border-b border-border/50 hover:bg-accent focus-visible:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${container.id === selectedId ? "bg-accent" : ""}`}
                                onClick={() => setSelectedId(container.id)}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter" || event.key === " ") {
                                    event.preventDefault();
                                    setSelectedId(container.id);
                                  }
                                }}
                              >
                                <td className="max-w-[180px] px-2.5 py-2">
                                  <div className="truncate font-medium" title={container.name}>{container.name}</div>
                                  <div className="truncate font-mono text-micro text-muted-foreground">{container.id.slice(0, 12)}</div>
                                </td>
                                <td className="whitespace-nowrap px-2.5 py-2">
                                  <span className={`rounded border px-1.5 py-0.5 text-micro ${stateTone(container.state)}`}>
                                    {STATE_LABELS[container.state] ?? container.state}
                                  </span>
                                  {health ? (
                                    <div className={`mt-1 text-micro ${healthTone(health)}`}>
                                      {HEALTH_LABELS[health] ?? health}
                                    </div>
                                  ) : null}
                                </td>
                                <td className="max-w-[220px] truncate px-2.5 py-2 font-mono text-micro text-foreground/80" title={container.image}>{container.image}</td>
                                <td className="max-w-[120px] truncate px-2.5 py-2 text-micro text-muted-foreground">{container.composeProject || "-"}</td>
                                <td className="whitespace-nowrap px-2.5 py-2 text-micro text-muted-foreground">
                                  CPU {formatPercent(container.cpuPercent)}<br />内存 {container.memoryUsage || "不可用"}
                                </td>
                                <td
                                  className="max-w-[160px] truncate px-2.5 py-2 text-micro text-muted-foreground"
                                  title={container.ports || (usesHostNetwork ? "使用 Host 网络，无独立端口映射" : "未配置端口映射")}
                                >
                                  {ports}
                                </td>
                                <td className="w-12 px-2 py-1.5 text-right" onClick={(event) => event.stopPropagation()}>
                                  <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon"
                                        className="h-7 w-7"
                                        disabled={!connected || Boolean(actionBusy)}
                                        aria-label={`容器操作 ${container.name}`}
                                        onClick={() => setSelectedId(container.id)}
                                      >
                                        <MoreHorizontal className="h-4 w-4" />
                                      </Button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="end" className="w-32">
                                      {container.state === "running" ? (
                                        <>
                                          <DropdownMenuItem
                                            onSelect={() => {
                                              setSelectedId(container.id);
                                              setTerminalTarget({ id: container.id, name: container.name });
                                            }}
                                          >
                                            <SquareTerminal className="h-3.5 w-3.5" />进入终端
                                          </DropdownMenuItem>
                                          <DropdownMenuSeparator />
                                        </>
                                      ) : null}
                                      {actions.filter((action) => action !== "remove").map((action) => (
                                        <DropdownMenuItem
                                          key={action}
                                          onSelect={() => void handleContainerAction(container.id, action)}
                                        >
                                          {ACTION_LABELS[action]}
                                        </DropdownMenuItem>
                                      ))}
                                      {actions.includes("remove") ? (
                                        <>
                                          <DropdownMenuSeparator />
                                          <DropdownMenuItem
                                            className="text-destructive focus:text-destructive"
                                            onSelect={() => void handleContainerAction(container.id, "remove")}
                                          >
                                            删除
                                          </DropdownMenuItem>
                                        </>
                                      ) : null}
                                    </DropdownMenuContent>
                                  </DropdownMenu>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    ) : (
                      <EmptyState className="h-full" title={snapshot.containers.length ? "没有匹配的容器" : "暂无容器"} description={snapshot.containers.length ? "调整筛选条件后重试。" : "当前 Docker Engine 没有容器。"} />
                    )}
                  </div>
                  <ContainerDetailPanel
                    detail={detail}
                    recentLogs={recentLogs}
                    liveLogs={liveLogs}
                    liveTruncated={liveTruncated}
                    logMode={logMode}
                    onLogModeChange={setLogMode}
                    subscriptionId={subscriptionId}
                    loading={detailLoading}
                    logsLoading={logsLoading}
                    error={detailError}
                    actionError={actionError}
                    actionMessage={actionMessage}
                    actionBusy={actionBusy}
                    onCancelOperation={handleCancelOperation}
                    disconnected={!connected}
                  />
                </div>
              ) : error ? (
                <StatusNotice tone="danger" title="无法读取 Docker 容器" className="m-1">请检查 SSH 连接、Docker 服务和当前用户权限。</StatusNotice>
              ) : (
                <EmptyState className="flex-1" title="等待 Docker 数据" description="连接成功后点击刷新读取容器状态。" />
              )}
            </div>
          </TabsContent>

          <TabsContent value="compose" className="min-h-0 flex-1 overflow-hidden">
            <div className="flex h-full min-h-0 flex-col gap-2">
              <div className="flex shrink-0 justify-end">
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  disabled={!connected || !probe?.composeVersion}
                  onClick={() => {
                    setAssociateError(null);
                    setAssociateOpen(true);
                  }}
                >
                  <FilePlus2 className="mr-1 h-3 w-3" />关联 Compose 文件
                </Button>
              </div>
              <ComposeProjects
              projects={visibleProjects}
              available={probe == null || Boolean(probe.composeVersion)}
              parentSessionId={parentSessionId}
              connected={connected}
              visible={visible && activeTab === "compose"}
              selectedKey={selectedProjectKey}
              onSelect={setSelectedProjectKey}
              onChanged={() => void load()}
              />
            </div>
          </TabsContent>

          <TabsContent value="storage" className="min-h-0 flex-1 overflow-hidden">
            <ResourcePanel
              snapshot={resources}
              loading={resourceLoading}
              error={resourceError}
              message={resourceMessage}
              busyKey={resourceBusy}
              connected={connected}
              onRemove={handleRemoveResource}
              imageUpdates={imageUpdates}
              imageUpdateBusy={imageUpdateBusy}
              onCheckImageUpdate={handleCheckImageUpdate}
              onRefresh={() => void loadResources()}
            />
          </TabsContent>
        </Tabs>
      </div>
      {terminalTarget ? (
        <ContainerTerminalDialog
          open
          onOpenChange={(open) => {
            if (!open) setTerminalTarget(null);
          }}
          parentSessionId={parentSessionId}
          containerId={terminalTarget.id}
          containerName={terminalTarget.name}
        />
      ) : null}
      <Dialog open={associateOpen} onOpenChange={setAssociateOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>关联远程 Compose 文件</DialogTitle>
            <DialogDescription>该文件必须位于当前 SSH 主机，并且使用单文件 Compose 配置。</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label htmlFor="docker-compose-path" className="text-caption font-medium">远程绝对路径</label>
              <Input
                id="docker-compose-path"
                value={associatePath}
                onChange={(event) => setAssociatePath(event.target.value)}
                placeholder="/opt/app/compose.yaml"
                disabled={associateBusy}
              />
            </div>
            <div>
              <label htmlFor="docker-compose-name" className="text-caption font-medium">项目名（可选）</label>
              <Input
                id="docker-compose-name"
                value={associateName}
                onChange={(event) => setAssociateName(event.target.value)}
                placeholder="默认使用父目录名"
                disabled={associateBusy}
              />
            </div>
            {associateError ? <StatusNotice tone="danger">{associateError}</StatusNotice> : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAssociateOpen(false)} disabled={associateBusy}>取消</Button>
            <Button onClick={() => void handleAssociateProject()} disabled={associateBusy || !associatePath.trim()}>
              {associateBusy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
              关联
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ContainerDetailPanel({
  detail,
  recentLogs,
  liveLogs,
  liveTruncated,
  logMode,
  onLogModeChange,
  subscriptionId,
  loading,
  logsLoading,
  error,
  actionError,
  actionMessage,
  actionBusy,
  onCancelOperation,
  disconnected,
}: {
  detail: DockerContainerDetail | null;
  recentLogs: string;
  liveLogs: string;
  liveTruncated: boolean;
  logMode: "recent" | "live";
  onLogModeChange: (mode: "recent" | "live") => void;
  subscriptionId: string | null;
  loading: boolean;
  logsLoading: boolean;
  error: string | null;
  actionError: string | null;
  actionMessage: string | null;
  actionBusy: DockerContainerAction | null;
  onCancelOperation: () => void;
  disconnected: boolean;
}) {
  if (loading && !detail) {
    return <div className="flex min-h-[240px] items-center justify-center rounded-md border border-border/70 bg-card text-caption text-muted-foreground"><Loader2 className="mr-2 h-4 w-4 animate-spin" />读取详情…</div>;
  }
  if (!detail) {
    return <EmptyState className="min-h-[240px] rounded-md border border-border/70 bg-card" title="选择一个容器" description="查看详情和最近日志。" />;
  }
  return (
    <aside className="flex min-h-0 flex-col overflow-hidden rounded-md border border-border/70 bg-card" data-testid="docker-container-detail">
      <div className="shrink-0 border-b border-border/70 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <Box className="h-4 w-4 shrink-0 text-info" />
          <h2 className="min-w-0 flex-1 truncate text-caption font-semibold" title={detail.name}>{detail.name}</h2>
          <span className={`rounded border px-1.5 py-0.5 text-micro ${stateTone(detail.state)}`}>{STATE_LABELS[detail.state] ?? detail.state}</span>
        </div>
        <p className="mt-1 truncate font-mono text-micro text-muted-foreground">{detail.id}</p>
      </div>
      <div className="scrollbar-thin min-h-0 flex-1 overflow-auto p-3">
        {error ? <StatusNotice tone="danger" title="部分详情不可用" className="mb-2">{error}</StatusNotice> : null}
        {actionError ? <StatusNotice tone="danger" title="容器操作失败" className="mb-2">{actionError}</StatusNotice> : null}
        {actionMessage ? <StatusNotice tone="success" title="容器操作完成" className="mb-2">{actionMessage}</StatusNotice> : null}
        {disconnected ? <StatusNotice tone="warning" className="mb-2">连接断开，以下为最近一次读取结果。</StatusNotice> : null}
        <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-micro">
          <DetailField label="健康" value={<span className={healthTone(detail.health)}>{detail.health ? HEALTH_LABELS[detail.health] ?? detail.health : "未配置"}</span>} />
          <DetailField label="重启次数" value={detail.restartCount == null ? "不可用" : String(detail.restartCount)} />
          <DetailField label="CPU 配额" value={detail.cpuQuota > 0 ? String(detail.cpuQuota) : "未限制"} />
          <DetailField label="内存上限" value={detail.memoryLimit > 0 ? formatBytes(detail.memoryLimit) : "未限制"} />
          <DetailField label="退出码" value={detail.exitCode == null ? "-" : String(detail.exitCode)} />
          <DetailField label="重启策略" value={detail.restartPolicy || "-"} />
          <DetailField label="OOM 终止" value={detail.oomKilled ? "是" : "否"} />
          <DetailField label="特权模式" value={detail.privileged ? "已启用" : "未启用"} />
          <DetailField label="网络" value={detail.networks.length ? detail.networks.map((network) => network.name).join(", ") : "-"} />
          <DetailField label="挂载" value={detail.mounts.length ? String(detail.mounts.length) : "-"} />
          <DetailField label="环境变量" value={`${detail.environmentNames.length} 个（仅显示名称）`} />
        </dl>
        {detail.error ? <StatusNotice tone="danger" title="容器错误" className="mt-3">{detail.error}</StatusNotice> : null}
        {detail.mounts.length ? (
          <DetailList
            title="挂载"
            lines={detail.mounts.map(
              (mount) => `${mount.source} → ${mount.destination}${mount.readOnly ? "（只读）" : ""}`,
            )}
          />
        ) : null}
        {detail.networks.length ? (
          <DetailList
            title="网络"
            lines={detail.networks.map(
              (network) => `${network.name}${network.ipAddress ? ` · ${network.ipAddress}` : ""}`,
            )}
          />
        ) : null}
        {detail.environmentNames.length ? (
          <DetailList title="环境变量名称" lines={detail.environmentNames} />
        ) : null}
        {actionBusy ? (
          <div className="mt-3 flex items-center gap-2 text-micro text-muted-foreground" data-testid="docker-container-actions">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            正在{ACTION_LABELS[actionBusy]}容器
            <Button type="button" size="xs" variant="ghost" onClick={onCancelOperation}>
              取消操作
            </Button>
          </div>
        ) : null}
        <div className="mt-3">
          <div className="mb-1 flex items-center justify-between gap-2">
            <div className="text-micro font-semibold text-muted-foreground">{logMode === "live" ? "实时日志" : "最近日志"}</div>
            <div className="flex items-center gap-1">
              <Button type="button" variant={logMode === "recent" ? "secondary" : "ghost"} size="xs" onClick={() => onLogModeChange("recent")}>最近</Button>
              <Button type="button" variant={logMode === "live" ? "secondary" : "ghost"} size="xs" disabled={disconnected} onClick={() => onLogModeChange("live")}>实时</Button>
            </div>
          </div>
          {logMode === "live" ? <div className="mb-1 text-micro text-muted-foreground">{subscriptionId ? "订阅中" : "正在连接日志流…"}</div> : null}
          <div className="scrollbar-thin max-h-64 overflow-auto rounded-md border border-border/70 bg-muted/20 p-2 font-mono text-micro leading-4 text-foreground/80" data-testid="docker-container-logs">
            {logMode === "live" ? (
              liveLogs || <span className="text-muted-foreground">等待日志输出…</span>
            ) : logsLoading ? (
              <span className="text-muted-foreground">读取日志…</span>
            ) : (
              recentLogs || <span className="text-muted-foreground">暂无日志</span>
            )}
          </div>
          {logMode === "live" && liveTruncated ? <div className="mt-1 text-micro text-warning">实时日志已裁剪，仅保留最近 2 MiB。</div> : null}
        </div>
      </div>
    </aside>
  );
}

function DetailField({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="truncate text-foreground" title={typeof value === "string" ? value : undefined}>{value}</dd>
    </div>
  );
}

function DetailList({ title, lines }: { title: string; lines: string[] }) {
  return (
    <div className="mt-3 min-w-0">
      <div className="mb-1 text-micro font-semibold text-muted-foreground">{title}</div>
      <div className="space-y-1 rounded-md border border-border/70 bg-muted/20 p-2 font-mono text-micro text-foreground/80">
        {lines.map((line, index) => (
          <div key={`${index}:${line}`} className="break-all">{line}</div>
        ))}
      </div>
    </div>
  );
}

function ComposeProjects({
  projects,
  available,
  parentSessionId,
  connected,
  visible,
  selectedKey,
  onSelect,
  onChanged,
}: {
  projects: ComposeProject[];
  available: boolean;
  parentSessionId: string;
  connected: boolean;
  visible: boolean;
  selectedKey: string | null;
  onSelect: (key: string) => void;
  onChanged: () => void;
}) {
  if (!available) {
    return <StatusNotice tone="info" title="Compose v2 不可用">仍可查看容器；请在远程主机安装或启用 Compose v2 后再管理项目。</StatusNotice>;
  }
  if (projects.length === 0) {
    return <EmptyState className="h-full" title="暂无 Compose 项目" description="仅展示当前 Docker Engine 已发现的 Compose 项目。" />;
  }
  const selected = projects.find(
    (project) => `${project.name}:${project.configFile ?? ""}` === selectedKey,
  ) ?? projects[0];
  return (
    <div className="grid h-full min-h-0 grid-cols-1 gap-2 lg:grid-cols-[minmax(260px,34%)_minmax(0,1fr)]">
      <div className="scrollbar-thin overflow-auto rounded-md border border-border/70 bg-card">
      <table className="w-full border-collapse text-caption" data-testid="docker-compose-table">
        <thead>
          <tr>
            {['项目', '状态', '配置', '管理能力'].map((heading) => (
              <th key={heading} className="sticky top-0 z-10 bg-muted px-2.5 py-1.5 text-left text-micro font-semibold text-muted-foreground">{heading}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {projects.map((project) => (
            <tr
              key={`${project.name}:${project.configFile ?? ""}`}
              className={`cursor-pointer border-b border-border/50 hover:bg-accent focus-visible:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${project === selected ? "bg-accent" : ""}`}
              tabIndex={0}
              onClick={() => onSelect(`${project.name}:${project.configFile ?? ""}`)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelect(`${project.name}:${project.configFile ?? ""}`);
                }
              }}
            >
              <td className="px-2.5 py-2 font-medium">{project.name}</td>
              <td className="px-2.5 py-2"><Badge variant="outline" className="text-micro">{project.status || "未知"}</Badge></td>
              <td className="max-w-[320px] truncate px-2.5 py-2 font-mono text-micro text-muted-foreground" title={project.configFile ?? undefined}>{project.configFile || "未关联"}</td>
              <td className="px-2.5 py-2 text-micro">
                {project.manageable ? <span className="text-success">可管理</span> : <span className="flex items-center gap-1 text-warning" title={project.limitation ?? "缺少可管理配置"}><AlertTriangle className="h-3.5 w-3.5" />只读</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      <ComposeManager
        parentSessionId={parentSessionId}
        project={selected}
        connected={connected}
        visible={visible}
        onChanged={onChanged}
      />
    </div>
  );
}

function ResourcePanel({
  snapshot,
  loading,
  error,
  message,
  busyKey,
  connected,
  onRemove,
  imageUpdates,
  imageUpdateBusy,
  onCheckImageUpdate,
  onRefresh,
}: {
  snapshot: DockerResourceSnapshot | null;
  loading: boolean;
  error: string | null;
  message: string | null;
  busyKey: string | null;
  connected: boolean;
  onRemove: (kind: DockerResourceKind, resourceId: string) => void;
  imageUpdates: Record<string, DockerImageUpdate>;
  imageUpdateBusy: string | null;
  onCheckImageUpdate: (reference: string) => void;
  onRefresh: () => void;
}) {
  if (loading && !snapshot) {
    return <div className="flex h-full items-center justify-center text-caption text-muted-foreground"><Loader2 className="mr-2 h-4 w-4 animate-spin" />读取镜像与空间…</div>;
  }
  if (!snapshot && error) {
    return <StatusNotice tone="danger" title="无法读取镜像与空间" action={<Button type="button" variant="outline" size="xs" disabled={!connected} onClick={onRefresh}>重试</Button>}>{error}</StatusNotice>;
  }
  if (!snapshot) {
    return <EmptyState className="h-full" icon={<HardDrive className="h-5 w-5" />} title="暂无资源数据" description="连接成功并完成 Docker 探测后读取。" />;
  }
  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex shrink-0 items-center justify-between gap-2">
        <span className="text-micro text-muted-foreground">读取于 {new Date(snapshot.capturedAt).toLocaleTimeString()}</span>
        <Button type="button" variant="ghost" size="xs" disabled={!connected || loading} onClick={onRefresh}>
          {loading ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <RefreshCw className="mr-1 h-3 w-3" />}
          刷新
        </Button>
      </div>
      {error ? <StatusNotice tone="danger" title="资源列表读取不完整">{error}</StatusNotice> : null}
      {message ? <StatusNotice tone="success" title="资源操作完成">{message}</StatusNotice> : null}
      {snapshot.warnings.length ? <StatusNotice tone="warning" title="部分资源指标不可用">{snapshot.warnings.join("；")}</StatusNotice> : null}
      <StatusNotice tone="info" title="删除会再次检查引用">
        未挂载的卷仍可能保存业务数据；Mona 仅删除你明确选择并再次确认的单个资源。
      </StatusNotice>
      <div className="scrollbar-thin min-h-0 flex-1 space-y-3 overflow-auto">
        <ResourceSection title={`镜像（${snapshot.images.length}）`}>
          {snapshot.images.length ? (
            <table className="w-full border-collapse text-caption" data-testid="docker-images-table">
              <thead><tr>{["镜像", "大小", "引用", "操作"].map((heading) => <th key={heading} className="sticky top-0 z-10 bg-muted px-2.5 py-1.5 text-left text-micro font-semibold text-muted-foreground">{heading}</th>)}</tr></thead>
              <tbody>
                {snapshot.images.map((image) => {
                  const resourceId = image.id;
                  const reference = `${image.repository}:${image.tag}`;
                  const busy = busyKey === `image:${resourceId}`;
                  const update = imageUpdates[reference];
                  const checking = imageUpdateBusy === reference;
                  return (
                    <tr key={resourceId} className="border-b border-border/50">
                      <td className="max-w-[320px] truncate px-2.5 py-2 font-mono text-micro" title={reference}>{reference}<div className="text-muted-foreground">{image.digest || image.id}</div>{update ? <div className={update.status === "updateAvailable" ? "text-warning" : update.status === "current" ? "text-success" : "text-muted-foreground"}>{update.status === "updateAvailable" ? "有更新" : update.status === "current" ? "当前一致" : `未知：${update.reason ?? "无法比较"}`}</div> : null}</td>
                      <td className="whitespace-nowrap px-2.5 py-2 text-micro text-muted-foreground">{image.size || "-"}</td>
                      <td className="whitespace-nowrap px-2.5 py-2 text-micro text-muted-foreground">{image.containers || "0"}</td>
                      <td className="px-2.5 py-2"><div className="flex items-center gap-1"><Button type="button" variant="ghost" size="xs" disabled={!connected || Boolean(imageUpdateBusy) || image.repository === "<none>" || image.tag === "<none>"} onClick={() => onCheckImageUpdate(reference)} aria-label={`检查镜像更新 ${reference}`}>{checking ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}检查更新</Button><Button type="button" variant="ghost" size="xs" disabled={!connected || Boolean(busyKey)} onClick={() => onRemove("image", resourceId)} aria-label={`删除镜像 ${reference}`} className="text-destructive hover:text-destructive">{busy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}删除</Button></div></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : <EmptyState className="py-6" title="暂无镜像" />}
        </ResourceSection>
        <ResourceSection title={`卷（${snapshot.volumes.length}）`}>
          {snapshot.volumes.length ? (
            <table className="w-full border-collapse text-caption" data-testid="docker-volumes-table">
              <thead><tr>{["名称", "驱动", "范围", "引用", "操作"].map((heading) => <th key={heading} className="sticky top-0 z-10 bg-muted px-2.5 py-1.5 text-left text-micro font-semibold text-muted-foreground">{heading}</th>)}</tr></thead>
              <tbody>
                {snapshot.volumes.map((volume) => {
                  const busy = busyKey === `volume:${volume.name}`;
                  return (
                    <tr key={volume.name} className="border-b border-border/50">
                      <td className="max-w-[280px] truncate px-2.5 py-2 font-mono text-micro" title={volume.name}>{volume.name}</td>
                      <td className="px-2.5 py-2 text-micro text-muted-foreground">{volume.driver || "-"}</td>
                      <td className="px-2.5 py-2 text-micro text-muted-foreground">{volume.scope || "-"}</td>
                      <td className="px-2.5 py-2 text-micro text-muted-foreground">{volume.links || "0"}</td>
                      <td className="px-2.5 py-2"><Button type="button" variant="ghost" size="xs" disabled={!connected || Boolean(busyKey)} onClick={() => onRemove("volume", volume.name)} aria-label={`删除卷 ${volume.name}`} className="text-destructive hover:text-destructive">{busy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}删除</Button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : <EmptyState className="py-6" title="暂无卷" />}
        </ResourceSection>
        <ResourceSection title="磁盘占用">
          {snapshot.diskUsage.length ? (
            <table className="w-full border-collapse text-caption" data-testid="docker-disk-table">
              <thead><tr>{["类型", "数量", "活动", "占用", "可回收"].map((heading) => <th key={heading} className="bg-muted px-2.5 py-1.5 text-left text-micro font-semibold text-muted-foreground">{heading}</th>)}</tr></thead>
              <tbody>{snapshot.diskUsage.map((item) => <tr key={item.kind} className="border-b border-border/50"><td className="px-2.5 py-2 text-micro">{item.kind}</td><td className="px-2.5 py-2 text-micro text-muted-foreground">{item.totalCount}</td><td className="px-2.5 py-2 text-micro text-muted-foreground">{item.active}</td><td className="px-2.5 py-2 text-micro text-muted-foreground">{item.size}</td><td className="px-2.5 py-2 text-micro text-muted-foreground">{item.reclaimable}</td></tr>)}</tbody>
            </table>
          ) : <p className="px-2.5 py-3 text-micro text-muted-foreground">暂无空间统计。</p>}
        </ResourceSection>
      </div>
    </div>
  );
}

function ResourceSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="overflow-hidden rounded-md border border-border/70 bg-card">
      <h2 className="border-b border-border/70 px-3 py-2 text-caption font-semibold">{title}</h2>
      {children}
    </section>
  );
}
