import { ChevronDown, Clock3, HardDrive, RefreshCw } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { StatusNotice } from "@/components/ui/status-notice";

import type { SystemTab } from "./systemTabs";
import { PanelCard, StatusPill } from "./SystemUi";
import {
  DIAGNOSTIC_CHECKS,
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
  type StartupItem,
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
  title: string;
  evidence: string;
  impact: string;
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
      title: `${disk.driveLetter}空间紧张`,
      evidence: `可用空间 ${formatGb(disk.availableGb)} GB · 占用 ${formatPercent(disk.usagePercent)}`,
      impact: "可能影响更新与文件保存",
      actionLabel: "查看并扫描",
      priority: critical ? "需关注" : "建议处理",
      tone: critical ? "red" : "orange",
    });
  }

  const recentStartupCount = startupItems.filter((item) => item.isNew).length;
  const bootDelta = bootHistory?.lastDeltaMs ?? 0;
  if (recentStartupCount > 0 || bootDelta > 0) {
    const evidence = [
      recentStartupCount > 0 ? `新增 ${recentStartupCount} 项启动项待审查` : "",
      bootDelta > 0 ? `比上次慢 ${formatDuration(bootDelta)}` : "",
    ].filter(Boolean).join(" · ");
    issues.push({
      id: "open-startup",
      title: bootDelta > 0 ? "启动耗时增加" : "启动项有新增",
      evidence,
      impact: "可能延长开机等待时间",
      actionLabel: "审查启动项",
      priority: "建议检查",
      tone: "orange",
    });
  }

  return issues.slice(0, 3);
}

function OverviewMetric({
  label,
  value,
  detail,
  points,
  color,
}: {
  label: string;
  value: string;
  detail: string;
  points: string;
  color: string;
}) {
  return (
    <section className="min-w-0 rounded-lg border border-border/70 bg-card p-3.5 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-caption text-muted-foreground">{label}</p>
          <p className="mt-1 text-display-sm font-semibold tracking-tight">{value}</p>
          <p className="mt-2 truncate text-micro text-muted-foreground">{detail}</p>
        </div>
        <svg
          viewBox="0 0 120 48"
          className="h-12 w-[42%] shrink-0"
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
  onNavigate: (tab: SystemTab) => void;
  onStartStorageScan: () => void;
  onAcknowledgeStartupItems: () => Promise<void>;
}

const DIAGNOSTIC_TONE: Record<DiagnosticCheck["status"], { tone: "green" | "orange" | "blue" | "neutral"; label: string }> = {
  clear: { tone: "green", label: "正常" },
  attention: { tone: "orange", label: "需关注" },
  collected: { tone: "blue", label: "已收集" },
  unavailable: { tone: "neutral", label: "不可用" },
};

function DiagnosticsCard() {
  const { checks, loading, recheck } = useSystemDiagnostics();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // 后端返回短 id（如 pending_reboot），命令名为 system_check_<id>
  const labelOf = (id: string) =>
    DIAGNOSTIC_CHECKS.find((item) => item.command === id || item.command === `system_check_${id}`)?.label ?? id;

  return (
    <PanelCard
      title="系统健康检查"
      action={
        <Button variant="outline" size="sm" onClick={() => void recheck()} disabled={loading}>
          <RefreshCw className={loading ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
          重新检查
        </Button>
      }
    >
      {loading && checks.length === 0 ? (
        <div className="space-y-2">
          {[0, 1, 2].map((index) => <div key={index} className="h-8 animate-pulse rounded-lg bg-muted/40" />)}
        </div>
      ) : (
        <ul className="divide-y divide-border/50">
          {checks.map((check) => {
            const tone = DIAGNOSTIC_TONE[check.status] ?? DIAGNOSTIC_TONE.unavailable;
            const expanded = expandedId === check.id;
            return (
              <li key={check.id}>
                <button
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => setExpandedId(expanded ? null : check.id)}
                  className="flex w-full items-center gap-3 py-2.5 text-left"
                >
                  <span className="w-28 shrink-0 text-ui font-medium">{labelOf(check.id)}</span>
                  <StatusPill tone={tone.tone}>{tone.label}</StatusPill>
                  <span className="min-w-0 flex-1 truncate text-caption text-muted-foreground">{check.summary}</span>
                  <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-180" : ""}`} />
                </button>
                {expanded ? (
                  <pre className="mb-3 max-h-48 overflow-y-auto whitespace-pre-wrap rounded-lg bg-muted/40 p-3 font-mono text-micro leading-5 text-muted-foreground scrollbar-thin">{check.detail}</pre>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </PanelCard>
  );
}

export function OverviewPanel({ onNavigate, onStartStorageScan, onAcknowledgeStartupItems }: OverviewPanelProps) {
  const { data, error } = useSystemOverview();
  const { data: startup } = useStartupItems();
  const { data: bootHistory } = useBootHistory();
  const [timeRange, setTimeRange] = useState<(typeof TIME_RANGES)[number]>(TIME_RANGES[0]);
  const [sort, setSort] = useState<{ key: ProcessSortKey; direction: SortDirection }>({ key: "cpuPercent", direction: "descending" });
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
      <div className="space-y-3">
        <h2 className="sr-only">电脑状态概览</h2>
        <div className="grid gap-3 md:grid-cols-3">
          {[0, 1, 2].map((index) => <div key={index} className="h-[118px] animate-pulse rounded-lg border border-border/70 bg-card" />)}
        </div>
        <div className="h-64 animate-pulse rounded-lg border border-border/70 bg-card" />
      </div>
    );
  }

  const cDrive = data.disks[0];
  const issues = buildIssues(data.disks, startup?.items ?? [], bootHistory);
  const cpuPolyline = buildPolyline(history, (point) => point.cpuUsage);
  const memoryPolyline = buildPolyline(history, (point) => point.memUsage);
  const cpuMiniPolyline = buildPolyline(history, (point) => point.cpuUsage, 120, 48);
  const memoryMiniPolyline = buildPolyline(history, (point) => point.memUsage, 120, 48);
  const networkMiniPolyline = buildPolyline(history, (point) => Math.min(point.netTotalMbps, 100), 120, 48);
  const historyReady = history.length >= 2;
  const timeLabels = buildTimeLabels(history, timeRange.seconds);
  const issueTone = {
    red: "border-destructive/30 bg-destructive/5",
    orange: "border-warning/30 bg-warning/5",
    blue: "border-info/30 bg-info/5",
  };
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
  const openIssue = async (issue: Issue) => {
    if (issue.id === "scan-storage") {
      onNavigate("storage");
      onStartStorageScan();
      return;
    }
    if (issue.id === "open-startup") await onAcknowledgeStartupItems();
    onNavigate("startup");
  };

  return (
    <div className="space-y-3">
      <h2 className="sr-only">电脑状态概览</h2>

      {issues.length > 0 && (
        <section className="rounded-lg border border-border/70 bg-card shadow-sm">
          <div className="border-b border-border/60 px-4 py-3">
            <h2 className="text-body font-semibold">现在值得处理</h2>
            <p className="mt-1 text-micro text-muted-foreground">基于本机实时证据，为你排序 {issues.length} 个可执行问题</p>
          </div>
          <div className="grid gap-3 p-3 md:grid-cols-3">
            {issues.map((issue) => {
              const Icon = issue.id === "scan-storage" ? HardDrive : Clock3;
              const pillTone = issue.tone === "red" ? "red" : issue.tone === "orange" ? "orange" : "blue";
              return (
                <article key={issue.id} className={`flex min-w-0 flex-col rounded-lg border p-3 ${issueTone[issue.tone]}`}>
                  <div className="flex items-start gap-3">
                    <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${issue.tone === "red" ? "bg-destructive/10 text-destructive" : issue.tone === "orange" ? "bg-warning/10 text-warning" : "bg-info/10 text-info"}`}><Icon className="h-4 w-4" /></span>
                    <div className="min-w-0 flex-1">
                      <StatusPill tone={pillTone}>{issue.priority}</StatusPill>
                      <h3 className="mt-2 text-body font-semibold">{issue.title}</h3>
                    </div>
                  </div>
                  <p className="mt-3 text-micro leading-5 text-muted-foreground">{issue.evidence}</p>
                  <p className="mt-1 text-micro leading-5 text-muted-foreground">{issue.impact}</p>
                  <div className="mt-3 flex items-center gap-2">
                    <Button type="button" size="sm" onClick={() => void openIssue(issue)} className="flex-1">{issue.actionLabel}</Button>
                    {issue.id === "scan-storage" && <span className="text-micro text-muted-foreground">先分析，暂不清理</span>}
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      )}

      <section>
        <h2 className="mb-2 text-body font-semibold">系统状态</h2>
        <div className="grid gap-3 md:grid-cols-3">
          <OverviewMetric label="CPU" value={formatPercent(data.cpu.usagePercent)} detail={`${data.cpu.frequencyGhz.toFixed(1)} GHz`} points={cpuMiniPolyline} color={CHART_COLORS.cpu} />
          <OverviewMetric label="内存" value={formatPercent(data.memory.usagePercent)} detail={`${formatGb(data.memory.usedGb)} / ${formatGb(data.memory.totalGb)} GB`} points={memoryMiniPolyline} color={CHART_COLORS.memory} />
          <OverviewMetric label="网络" value={formatMbps(data.network.totalMbps)} detail={`↑ ${formatMbps(data.network.uploadMbps)}　↓ ${formatMbps(data.network.downloadMbps)}`} points={networkMiniPolyline} color={CHART_COLORS.network} />
        </div>
      </section>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.7fr)_minmax(280px,0.8fr)]">
        <PanelCard
          title="性能趋势"
          action={
            <div className="inline-flex rounded-md border border-border/80 bg-background p-0.5">
              {TIME_RANGES.map((range) => (
                <button
                  key={range.seconds}
                  type="button"
                  onClick={() => setTimeRange(range)}
                  className={`rounded px-2.5 py-1 text-micro transition ${timeRange.seconds === range.seconds ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                >
                  {range.label}
                </button>
              ))}
            </div>
          }
        >
          <div className="flex gap-4 text-micro text-muted-foreground">
            <span><i className="mr-1 inline-block h-0.5 w-4 align-middle" style={{ background: CHART_COLORS.cpu }} />CPU (%)</span>
            <span><i className="mr-1 inline-block h-0.5 w-4 align-middle" style={{ background: CHART_COLORS.memory }} />内存 (%)</span>
          </div>
          <div className="mt-2 grid grid-cols-[30px_minmax(0,1fr)] gap-2">
            <div className="flex h-40 flex-col justify-between pb-0.5 text-right text-micro text-muted-foreground"><span>100%</span><span>75%</span><span>50%</span><span>25%</span><span>0%</span></div>
            <div>
              <div className="relative h-40 rounded-sm bg-[linear-gradient(to_bottom,hsl(var(--border)/0.55)_1px,transparent_1px)] bg-[length:100%_25%]">
                {historyReady ? (
                  <svg viewBox="0 0 600 160" className="h-full w-full" preserveAspectRatio="none" aria-label="CPU 与内存趋势图">
                    <polyline points={cpuPolyline} fill="none" stroke={CHART_COLORS.cpu} strokeWidth="2" vectorEffect="non-scaling-stroke" />
                    <polyline points={memoryPolyline} fill="none" stroke={CHART_COLORS.memory} strokeWidth="2" vectorEffect="non-scaling-stroke" />
                  </svg>
                ) : <div className="flex h-full items-center justify-center text-caption text-muted-foreground">正在采集趋势数据</div>}
              </div>
              <div className="mt-1 flex justify-between text-micro text-muted-foreground">{timeLabels.map((label) => <span key={label}>{label}</span>)}</div>
            </div>
          </div>
        </PanelCard>

        {cDrive && (
          <PanelCard title={`磁盘空间 (${cDrive.driveLetter})`}>
            <div className="flex items-center gap-5">
              <div className="relative flex h-28 w-28 shrink-0 items-center justify-center rounded-full" style={{ background: `conic-gradient(${cDrive.usagePercent >= 90 ? CHART_COLORS.diskDanger : cDrive.usagePercent >= 80 ? CHART_COLORS.diskWarning : CHART_COLORS.cpu} 0 ${cDrive.usagePercent}%, hsl(var(--muted)) ${cDrive.usagePercent}% 100%)` }}>
                <div className="flex h-20 w-20 flex-col items-center justify-center rounded-full bg-card"><strong className="text-title">{formatPercent(cDrive.usagePercent)}</strong><span className="text-micro text-muted-foreground">已使用</span></div>
              </div>
              <div className="min-w-0 flex-1 divide-y divide-border/60 text-caption">
                <div className="pb-2"><p className="text-muted-foreground">已使用</p><p className="mt-1 text-title-sm text-destructive">{formatGb(cDrive.usedGb)} GB</p></div>
                <div className="py-2"><p className="text-muted-foreground">可用</p><p className="mt-1 text-title-sm">{formatGb(cDrive.availableGb)} GB</p></div>
                <div className="pt-2 text-muted-foreground">总容量　{formatGb(cDrive.totalGb)} GB</div>
              </div>
            </div>
          </PanelCard>
        )}
      </div>

      <DiagnosticsCard />

      <PanelCard title="资源占用较高的程序">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[540px] text-left text-caption">
            <thead className="text-muted-foreground"><tr>{PROCESS_COLUMNS.map((column) => <th key={column.key} aria-sort={sort.key === column.key ? sort.direction : "none"} className="pb-2 font-medium"><button type="button" aria-label={`按 ${column.label} 排序`} onClick={() => toggleSort(column.key)} className="inline-flex items-center gap-1 hover:text-foreground">{column.label}<span aria-hidden>{sort.key === column.key ? sort.direction === "ascending" ? "↑" : "↓" : "↕"}</span></button></th>)}</tr></thead>
            <tbody>
              {sortedProcesses.map((process) => <tr key={process.pid} className="border-t border-border/50"><td className="py-2.5 font-medium">{process.name}</td><td>{process.cpuPercent.toFixed(1)}%</td><td>{process.memoryMb > 1024 ? `${(process.memoryMb / 1024).toFixed(1)} GB` : `${process.memoryMb} MB`}</td><td>{formatBytesPerSecond(process.diskReadBytesPerSec)}</td><td>{formatBytesPerSecond(process.diskWriteBytesPerSec)}</td></tr>)}
              {data.topProcesses.length === 0 && <tr className="border-t border-border/50"><td className="py-3 text-muted-foreground" colSpan={5}>当前没有可展示的进程采样数据。</td></tr>}
            </tbody>
          </table>
        </div>
      </PanelCard>
    </div>
  );
}
