import { ChevronDown, Loader2, RefreshCw } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { StatusNotice } from "@/components/ui/status-notice";

import type { SystemTab } from "./systemTabs";
import { PanelCard, StatusPill } from "./SystemUi";
import { BOOT_SLOWDOWN_MS, buildInspectionCards, diagnosticLabel, type InspectionCard } from "./inspectionModel";
import {
  formatGb,
  formatMbps,
  formatPercent,
  useBootHistory,
  useStartupItems,
  useSystemDiagnostics,
  useSystemHistory,
  useSystemOverview,
  type BootHistoryResult,
  type DiagnosticCheck,
  type DiskInfo,
  type SamplePoint,
  type SoftwareCheckResult,
  type StartupItem,
  type StorageScanResult,
} from "./useSystemData";

const TIME_RANGES = [
  { label: "10 分钟", seconds: 600 },
  { label: "30 分钟", seconds: 1800 },
  { label: "1 小时", seconds: 3600 },
] as const;

/** 历史图表数据色板（规范 §3.3 数据可视化例外） */
const CHART_COLORS = {
  cpu: "#2f80ff",
  memory: "#9367ff",
  network: "#4caf72",
  diskDanger: "#ef4444",
  diskWarning: "#ff5a52",
} as const;

const PROCESS_COLUMNS = [
  { key: "name", label: "程序" },
  { key: "cpuPercent", label: "CPU" },
  { key: "memoryMb", label: "内存" },
  { key: "diskReadBytesPerSec", label: "磁盘读取" },
  { key: "diskWriteBytesPerSec", label: "磁盘写入" },
] as const;

type ProcessSortKey = (typeof PROCESS_COLUMNS)[number]["key"];
type SortDirection = "ascending" | "descending";

function buildPolyline(points: SamplePoint[], extractor: (p: SamplePoint) => number, width = 600, height = 160): string {
  if (points.length === 0) return "";
  if (points.length === 1) {
    const y = height - (extractor(points[0]) / 100) * height;
    return `0,${y.toFixed(1)} ${width},${y.toFixed(1)}`;
  }
  return points
    .map((p, i) => {
      const x = (i / (points.length - 1)) * width;
      const y = height - (extractor(p) / 100) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

function sampleStats(points: SamplePoint[], extractor: (p: SamplePoint) => number): { peak: number; average: number } | null {
  if (points.length === 0) return null;
  const values = points.map(extractor);
  return {
    peak: Math.max(...values),
    average: values.reduce((total, value) => total + value, 0) / values.length,
  };
}

function formatBytesPerSecond(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)} MB/s`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)} KB/s`;
  return `${value.toFixed(0)} B/s`;
}

function buildTimeLabels(points: SamplePoint[], rangeSeconds: number): string[] {
  if (points.length === 0) {
    const now = Date.now();
    const start = now - rangeSeconds * 1000;
    return Array.from({ length: 5 }, (_, i) => {
      const t = start + (rangeSeconds * 1000 * i) / 4;
      return formatClock(new Date(t));
    });
  }
  const last = points[points.length - 1].ts;
  const start = last - rangeSeconds * 1000;
  return Array.from({ length: 5 }, (_, i) => {
    const t = start + (rangeSeconds * 1000 * i) / 4;
    return formatClock(new Date(t));
  });
}

function formatClock(date: Date): string {
  const h = date.getHours().toString().padStart(2, "0");
  const m = date.getMinutes().toString().padStart(2, "0");
  return `${h}:${m}`;
}

type OverviewAction = "scan-storage" | "open-startup";

interface Issue {
  id: OverviewAction;
  drive: string | null;
  title: string;
  evidence: string;
  actionLabel: string;
  priority: string;
  tone: "red" | "orange" | "blue";
}

function formatDuration(milliseconds: number): string {
  return milliseconds < 1000 ? `${milliseconds} ms` : `${(milliseconds / 1000).toFixed(1)} 秒`;
}

function buildIssues(disks: DiskInfo[], startupItems: StartupItem[], bootHistory: BootHistoryResult | null): Issue[] {
  const issues: Issue[] = [];
  const critical = disks.find((disk) => disk.usagePercent >= 90);
  const warning = disks.find((disk) => disk.usagePercent >= 80);
  const disk = critical ?? warning;

  if (disk) {
    issues.push({
      id: "scan-storage",
      drive: `${disk.driveLetter.charAt(0).toUpperCase()}:`,
      title: `${disk.driveLetter}空间紧张`,
      evidence: `可用空间 ${formatGb(disk.availableGb)} GB · 占用 ${formatPercent(disk.usagePercent)}`,
      actionLabel: "查看并扫描",
      priority: critical ? "需关注" : "建议处理",
      tone: critical ? "red" : "orange",
    });
  }

  const recentStartupCount = startupItems.filter((item) => item.isNew).length;
  const bootDelta = bootHistory?.lastDeltaMs ?? 0;
  const bootSlowed = bootDelta >= BOOT_SLOWDOWN_MS;
  if (recentStartupCount > 0 || bootSlowed) {
    const evidence = [
      recentStartupCount > 0 ? `新增 ${recentStartupCount} 项启动项待审查` : "",
      bootSlowed ? `比上次慢 ${formatDuration(bootDelta)}` : "",
    ].filter(Boolean).join(" · ");
    issues.push({
      id: "open-startup",
      drive: null,
      title: bootSlowed ? "启动耗时增加" : "启动项有新增",
      evidence,
      actionLabel: recentStartupCount > 0 ? "审查启动项" : "查看启动趋势",
      priority: "建议检查",
      tone: "orange",
    });
  }

  return issues.slice(0, 3);
}

function OverviewMetric({
  label,
  value,
  unit,
  details,
  points,
  color,
}: {
  label: string;
  value: string;
  unit: string;
  details: string[];
  points: string;
  color: string;
}) {
  return (
    <section className="min-w-0 rounded-xl border border-border/60 bg-card px-4 py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-caption text-muted-foreground">{label}</p>
          <p className="mt-0.5 flex items-baseline gap-1">
            <span className="text-display-sm font-semibold tabular-nums tracking-tight">{value}</span>
            <span className="text-ui font-medium text-muted-foreground">{unit}</span>
          </p>
          {details.map((detail) => (
            <p key={detail} className="mt-0.5 truncate text-micro text-muted-foreground">{detail}</p>
          ))}
        </div>
        <svg
          viewBox="0 0 120 48"
          className="mt-1 h-11 w-[40%] shrink-0"
          preserveAspectRatio="none"
          aria-label={`${label} 迷你趋势`}
        >
          <path d="M0 40H120" stroke="currentColor" className="text-border/70" />
          {points && <polyline points={points} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />}
        </svg>
      </div>
    </section>
  );
}

interface OverviewPanelProps {
  diagnostics: ReturnType<typeof useSystemDiagnostics>;
  storage: StorageScanResult | null;
  software: SoftwareCheckResult | null;
  onNavigate: (tab: SystemTab) => void;
  onClean: () => void;
  cleaning: boolean;
  cleanupNotice: string;
  onUpgrade: () => void;
  updating: boolean;
  updateNotice: string;
  onRecheckSoftware: () => Promise<void>;
  onStartStorageScan: (drive: string) => void;
  storageScanning: boolean;
}

const DIAGNOSTIC_TONE: Record<DiagnosticCheck["status"], { tone: "green" | "orange" | "blue" | "neutral"; label: string }> = {
  clear: { tone: "green", label: "正常" },
  attention: { tone: "orange", label: "需关注" },
  collected: { tone: "blue", label: "已收集" },
  unavailable: { tone: "neutral", label: "不可用" },
};

export function OverviewPanel({ diagnostics, storage, software, onNavigate, onClean, cleaning, cleanupNotice, onUpgrade, updating, updateNotice, onRecheckSoftware, onStartStorageScan, storageScanning }: OverviewPanelProps) {
  const { data, error } = useSystemOverview();
  const { data: startup, refresh: refreshStartup } = useStartupItems();
  const { data: bootHistory, refresh: refreshBoot } = useBootHistory();
  const [rechecking, setRechecking] = useState(false);
  const [timeRange, setTimeRange] = useState<(typeof TIME_RANGES)[number]>(TIME_RANGES[0]);
  const [sort, setSort] = useState<{ key: ProcessSortKey; direction: SortDirection }>({ key: "cpuPercent", direction: "descending" });
  const [expandedIssueId, setExpandedIssueId] = useState<string | null>(null);
  const { data: history } = useSystemHistory(timeRange.seconds);

  if (!data) {
    if (error) {
      return (
        <StatusNotice tone="warning" title="暂时无法读取系统状态" className="p-5">
          <p>{error}</p>
          <p className="mt-1">正在自动重试。</p>
        </StatusNotice>
      );
    }
    return (
      <div className="space-y-5">
        <h2 className="sr-only">电脑状态概览</h2>
        <div className="grid gap-4 md:grid-cols-3">
          {[0, 1, 2].map((index) => <div key={index} className="h-[118px] animate-pulse rounded-xl border border-border/60 bg-card" />)}
        </div>
        <div className="h-64 animate-pulse rounded-xl border border-border/60 bg-card" />
      </div>
    );
  }

  const cDrive = data.disks[0];
  const issues = buildIssues(data.disks, startup?.items ?? [], bootHistory);
  const inspectionIssues = buildInspectionCards({
    diagnostics: [],
    storage,
    software,
    startup: null,
    boot: null,
    maintenance: null,
  }, Infinity);
  const cpuPolyline = buildPolyline(history, (point) => point.cpuUsage);
  const memoryPolyline = buildPolyline(history, (point) => point.memUsage);
  const cpuMiniPolyline = buildPolyline(history, (point) => point.cpuUsage, 120, 48);
  const memoryMiniPolyline = buildPolyline(history, (point) => point.memUsage, 120, 48);
  const networkMiniPolyline = buildPolyline(history, (point) => Math.min(point.netTotalMbps, 100), 120, 48);
  const historyReady = history.length >= 2;
  const timeLabels = buildTimeLabels(history, timeRange.seconds);
  const cpuStats = sampleStats(history, (point) => point.cpuUsage);
  const memoryStats = sampleStats(history, (point) => point.memUsage);
  const networkStats = sampleStats(history, (point) => point.netTotalMbps);
  const lastSampleAt = history.length ? formatClock(new Date(history[history.length - 1].ts)) : null;
  const sortedProcesses = [...data.topProcesses].sort((left, right) => {
    const direction = sort.direction === "ascending" ? 1 : -1;
    if (sort.key === "name") return left.name.localeCompare(right.name) * direction;
    return (left[sort.key] - right[sort.key]) * direction;
  });
  const toggleSort = (key: ProcessSortKey) => {
    setSort((current) => ({
      key,
      direction: current.key === key && current.direction === "descending" ? "ascending" : "descending",
    }));
  };
  const openIssue = (issue: Issue) => {
    if (issue.id === "scan-storage" && issue.drive) {
      onStartStorageScan(issue.drive);
      return;
    }
    onNavigate("startup");
  };
  const openInspection = (issue: InspectionCard) => {
    if (issue.id === "storage") onClean();
    else if (issue.id === "software") onUpgrade();
    else onNavigate(issue.tab);
  };
  const rows = [
    ...diagnostics.checks.map((check) => ({
      id: `diagnostic:${check.id}`,
      title: diagnosticLabel(check.id),
      summary: check.summary,
      detail: check.detail,
      metric: DIAGNOSTIC_TONE[check.status].label,
      tone: DIAGNOSTIC_TONE[check.status].tone,
      actionLabel: null,
      onAction: null,
    })),
    ...issues.map((issue) => ({ id: issue.id, title: issue.title, summary: issue.evidence, detail: issue.evidence, metric: issue.priority, tone: issue.tone, actionLabel: issue.actionLabel, onAction: () => void openIssue(issue) })),
    ...inspectionIssues.map((issue) => ({ id: issue.id, title: issue.title, summary: issue.detail, detail: issue.detail, metric: issue.metric, tone: issue.tone === "warning" ? "orange" as const : "blue" as const, actionLabel: issue.actionLabel ?? "查看", onAction: () => openInspection(issue) })),
  ];
  const recheck = async () => {
    setRechecking(true);
    try {
      await Promise.all([diagnostics.recheck(), refreshStartup(), refreshBoot(), onRecheckSoftware()]);
    } finally {
      setRechecking(false);
    }
  };

  return (
    <div className="space-y-5">
      <h2 className="sr-only">电脑状态概览</h2>

      <div className="flex items-center justify-between gap-3">
        <p className="min-w-0 truncate text-caption text-muted-foreground">系统运行状态与资源使用情况</p>
        <span className="flex shrink-0 items-center gap-1.5 text-micro text-muted-foreground">
          <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-success" />
          {lastSampleAt ? `刚刚更新 · ${lastSampleAt}` : "正在采集"}
        </span>
      </div>

      <section>
        <h2 className="mb-2 text-body font-semibold">系统状态</h2>
        <div className="grid gap-4 md:grid-cols-3">
          <OverviewMetric
            label="CPU"
            value={data.cpu.usagePercent.toFixed(0)}
            unit="%"
            details={[
              `${data.cpu.frequencyGhz.toFixed(1)} GHz`,
              cpuStats ? `峰值 ${cpuStats.peak.toFixed(0)}% · 平均 ${cpuStats.average.toFixed(0)}%` : "正在采集采样",
            ]}
            points={cpuMiniPolyline}
            color={CHART_COLORS.cpu}
          />
          <OverviewMetric
            label="内存"
            value={data.memory.usagePercent.toFixed(0)}
            unit="%"
            details={[
              `${formatGb(data.memory.usedGb)} / ${formatGb(data.memory.totalGb)} GB`,
              memoryStats ? `峰值 ${memoryStats.peak.toFixed(0)}% · 平均 ${memoryStats.average.toFixed(0)}%` : "正在采集采样",
            ]}
            points={memoryMiniPolyline}
            color={CHART_COLORS.memory}
          />
          <OverviewMetric
            label="网络"
            value={data.network.totalMbps.toFixed(1)}
            unit="Mbps"
            details={[
              `↑ ${formatMbps(data.network.uploadMbps)}　↓ ${formatMbps(data.network.downloadMbps)}`,
              networkStats ? `峰值 ${formatMbps(networkStats.peak)} · 平均 ${formatMbps(networkStats.average)}` : "正在采集采样",
            ]}
            points={networkMiniPolyline}
            color={CHART_COLORS.network}
          />
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.7fr)_minmax(280px,0.8fr)]">
        <PanelCard
          title="性能趋势"
          className="rounded-xl"
          headerClassName="border-b-0 px-5 pb-0 pt-4"
          bodyClassName="px-5 pb-5 pt-3"
          action={
            <div className="flex items-center gap-3">
              <div className="hidden items-center gap-3 text-micro text-muted-foreground sm:flex">
                <span className="inline-flex items-center gap-1.5"><i className="h-1.5 w-1.5 rounded-full" style={{ background: CHART_COLORS.cpu }} />CPU</span>
                <span className="inline-flex items-center gap-1.5"><i className="h-1.5 w-1.5 rounded-full" style={{ background: CHART_COLORS.memory }} />内存</span>
              </div>
              <div className="inline-flex rounded-lg bg-muted p-0.5">
                {TIME_RANGES.map((range) => (
                  <Button
                    key={range.seconds}
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => setTimeRange(range)}
                    className={timeRange.seconds === range.seconds ? "rounded-md bg-card text-foreground shadow-surface" : "rounded-md text-muted-foreground"}
                  >
                    {range.label}
                  </Button>
                ))}
              </div>
            </div>
          }
        >
          <div className="grid grid-cols-[30px_minmax(0,1fr)] gap-2">
            <div className="flex h-44 flex-col justify-between pb-0.5 text-right text-micro text-muted-foreground"><span>100%</span><span>75%</span><span>50%</span><span>25%</span><span>0%</span></div>
            <div>
              <div className="relative h-44 rounded-sm bg-[linear-gradient(to_bottom,hsl(var(--border)/0.45)_1px,transparent_1px)] bg-[length:100%_25%]">
                {historyReady ? (
                  <svg viewBox="0 0 600 160" className="h-full w-full" preserveAspectRatio="none" aria-label="CPU 与内存趋势图">
                    <polyline points={cpuPolyline} fill="none" stroke={CHART_COLORS.cpu} strokeWidth="2" vectorEffect="non-scaling-stroke" />
                    <polyline points={memoryPolyline} fill="none" stroke={CHART_COLORS.memory} strokeWidth="2" vectorEffect="non-scaling-stroke" />
                  </svg>
                ) : <div className="flex h-full items-center justify-center text-caption text-muted-foreground">正在采集趋势数据</div>}
              </div>
              <div className="mt-2 flex justify-between text-micro text-muted-foreground">{timeLabels.map((label) => <span key={label}>{label}</span>)}</div>
            </div>
          </div>
        </PanelCard>

        {cDrive && (
          <PanelCard
            title="磁盘空间"
            className="rounded-xl"
            headerClassName="border-b-0 px-5 pb-0 pt-4"
            bodyClassName="px-5 pb-5 pt-3"
            action={<span className="text-micro text-muted-foreground">本地磁盘 · {cDrive.driveLetter.replace(/[:\\]/g, "")}</span>}
          >
            <div className="flex items-center gap-5">
              <div className="relative flex h-32 w-32 shrink-0 items-center justify-center">
                <svg viewBox="0 0 128 128" className="absolute inset-0 h-full w-full" aria-hidden="true">
                  <circle cx="64" cy="64" r="54" fill="none" stroke="hsl(var(--muted))" strokeWidth="13" />
                  <circle
                    cx="64"
                    cy="64"
                    r="54"
                    fill="none"
                    stroke={cDrive.usagePercent >= 90 ? CHART_COLORS.diskDanger : cDrive.usagePercent >= 80 ? CHART_COLORS.diskWarning : CHART_COLORS.cpu}
                    strokeWidth="13"
                    strokeLinecap="round"
                    strokeDasharray={`${(cDrive.usagePercent / 100) * 339.3} 339.3`}
                    transform="rotate(-90 64 64)"
                  />
                </svg>
                <div className="relative flex h-[94px] w-[94px] flex-col items-center justify-center rounded-full bg-card"><strong className="text-title tabular-nums tracking-tight">{formatPercent(cDrive.usagePercent)}</strong><span className="text-micro text-muted-foreground">已使用</span></div>
              </div>
              <div className="min-w-0 flex-1 space-y-3">
                <div><p className="text-micro text-muted-foreground">已使用</p><p className="mt-0.5 text-title-sm tabular-nums">{formatGb(cDrive.usedGb)} GB</p></div>
                <div><p className="text-micro text-muted-foreground">可用</p><p className="mt-0.5 text-title-sm tabular-nums">{formatGb(cDrive.availableGb)} GB</p></div>
                <div><p className="text-micro text-muted-foreground">总容量</p><p className="mt-0.5 text-title-sm tabular-nums">{formatGb(cDrive.totalGb)} GB</p></div>
              </div>
            </div>
            <div className="mt-4 flex items-center justify-between border-t border-border/50 pt-3 text-micro text-muted-foreground">
              <span>共 {data.disks.length} 个分区</span>
              <span>可用 {formatGb(data.disks.reduce((total, disk) => total + disk.availableGb, 0))} GB</span>
            </div>
          </PanelCard>
        )}
      </div>

      <PanelCard
        title="系统健康检查"
        className="rounded-xl"
        headerClassName="border-b-0 px-5 pb-1 pt-4"
        bodyClassName="px-5 pb-4 pt-0"
        action={
          <Button variant="outline" size="sm" className="rounded-full" onClick={() => void recheck()} disabled={diagnostics.loading || rechecking}>
            <RefreshCw className={diagnostics.loading || rechecking ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
            重新检查
          </Button>
        }
      >
        <ul aria-label="系统健康检查" className="divide-y divide-border/50">
          {rows.map((row) => {
            const hasDetails = Boolean(row.detail.trim()) && row.detail.trim() !== row.summary.trim();
            const expanded = hasDetails && expandedIssueId === row.id;
            const content = (
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-ui font-medium">{row.title}</span>
                  <StatusPill tone={row.tone}>{row.metric}</StatusPill>
                </div>
                <span className="min-w-0 whitespace-normal break-words text-caption text-muted-foreground">{row.summary}</span>
              </div>
            );
            const action = row.onAction && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0 rounded-full"
                onClick={row.onAction}
                aria-busy={row.id === "storage" && cleaning}
                disabled={row.id === "scan-storage" ? storageScanning || cleaning : row.id === "storage" ? cleaning || storageScanning : row.id === "software" && updating}
              >
                {row.id === "storage" && cleaning && <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />}
                {row.id === "storage" && cleaning ? "正在清理" : row.id === "software" && updating ? "正在更新" : row.actionLabel}
              </Button>
            );
            return (
              <li key={row.id} data-testid={`inspection-card-${row.id}`}>
                {hasDetails ? (
                  <Button
                    type="button"
                    variant="ghost"
                    aria-label={row.title}
                    aria-expanded={expanded}
                    aria-controls={`inspection-detail-${row.id}`}
                    onClick={() => setExpandedIssueId(expanded ? null : row.id)}
                    className="h-auto w-full items-start justify-start gap-3 rounded-lg px-0 py-3.5 text-left hover:bg-transparent active:bg-transparent"
                  >
                    {content}
                    <ChevronDown className={expanded ? "mt-0.5 h-3.5 w-3.5 shrink-0 rotate-180" : "mt-0.5 h-3.5 w-3.5 shrink-0"} />
                  </Button>
                ) : (
                  <div className="flex items-center justify-between gap-3 py-3.5">
                    {content}
                    {action}
                  </div>
                )}
                {expanded && (
                  <div id={`inspection-detail-${row.id}`} className="pb-3">
                    <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap py-2 font-sans text-ui leading-6 text-muted-foreground scrollbar-thin">{row.detail}</pre>
                    {action && <div className="flex justify-end pt-2">{action}</div>}
                  </div>
                )}
              </li>
            );
          })}
          {rows.length === 0 && <li className="py-3 text-ui text-muted-foreground">{diagnostics.loading ? "正在检查..." : "暂未发现需要处理的问题。"}</li>}
        </ul>
        {cleanupNotice && <p role="status" className="mt-2 text-caption text-muted-foreground">{cleanupNotice}</p>}
        {updateNotice && <p role="status" className="mt-2 text-caption text-muted-foreground">{updateNotice}</p>}
      </PanelCard>

      <PanelCard
        title="资源占用较高的程序"
        className="rounded-xl"
        headerClassName="border-b-0 px-5 pb-0 pt-4"
        bodyClassName="px-5 pb-5 pt-2"
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[540px] text-left text-caption">
            <thead className="text-micro text-muted-foreground"><tr>{PROCESS_COLUMNS.map((column, index) => <th key={column.key} aria-sort={sort.key === column.key ? sort.direction : "none"} className={`pb-2 font-medium${index > 0 ? " text-right" : ""}`}><Button type="button" variant="ghost" size="xs" aria-label={`按 ${column.label} 排序`} onClick={() => toggleSort(column.key)} className={`h-auto gap-1 px-0 py-0 text-micro${index > 0 ? " w-full justify-end" : ""}`}>{column.label}<span aria-hidden>{sort.key === column.key ? sort.direction === "ascending" ? "↑" : "↓" : "↕"}</span></Button></th>)}</tr></thead>
            <tbody>
              {sortedProcesses.map((process) => <tr key={process.pid} className="border-t border-border/50"><td className="py-2.5 text-ui font-medium">{process.name}</td><td className="py-2.5 pl-3 text-right tabular-nums text-muted-foreground"><span className="ml-auto flex max-w-[104px] flex-col items-end gap-1"><span>{process.cpuPercent.toFixed(1)}%</span><span aria-hidden="true" className="block h-1 w-full overflow-hidden rounded-full bg-muted"><span className="block h-full rounded-full bg-info" style={{ width: `${Math.min(Math.max(process.cpuPercent, 0), 100)}%` }} /></span></span></td><td className="py-2.5 text-right tabular-nums text-muted-foreground">{process.memoryMb > 1024 ? `${(process.memoryMb / 1024).toFixed(1)} GB` : `${process.memoryMb} MB`}</td><td className="py-2.5 text-right tabular-nums text-muted-foreground">{formatBytesPerSecond(process.diskReadBytesPerSec)}</td><td className="py-2.5 text-right tabular-nums text-muted-foreground">{formatBytesPerSecond(process.diskWriteBytesPerSec)}</td></tr>)}
              {data.topProcesses.length === 0 && <tr className="border-t border-border/50"><td className="py-3 text-muted-foreground" colSpan={5}>当前没有可展示的进程采样数据。</td></tr>}
            </tbody>
          </table>
        </div>
      </PanelCard>
    </div>
  );
}
