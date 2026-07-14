import { TriangleAlert } from "lucide-react";
import { useState } from "react";

import { PanelCard, secondaryButtonClass } from "./SystemUi";
import {
  formatGb,
  formatMbps,
  formatPercent,
  useSystemHistory,
  useSystemOverview,
  type SamplePoint,
} from "./useSystemData";

const TIME_RANGES = [
  { label: "10 分钟", seconds: 600 },
  { label: "30 分钟", seconds: 1800 },
  { label: "1 小时", seconds: 3600 },
] as const;

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

interface Issue {
  title: string;
  detail: string;
  tone: "red" | "orange" | "violet";
}

function buildIssues(
  disks: { driveLetter: string; usagePercent: number; usedGb: number; totalGb: number }[],
): Issue[] {
  const issues: Issue[] = [];
  const critical = disks.find((disk) => disk.usagePercent >= 90);
  const warning = disks.find((disk) => disk.usagePercent >= 80);
  const disk = critical ?? warning;

  if (disk) {
    issues.push({
      title: `${disk.driveLetter}磁盘空间不足`,
      detail: `${disk.driveLetter} 已使用 ${formatGb(disk.usedGb)} / ${formatGb(disk.totalGb)} GB（${formatPercent(disk.usagePercent)}）`,
      tone: critical ? "red" : "orange",
    });
  }
  if (issues.length === 0) {
    issues.push({
      title: "系统状态良好",
      detail: "所有磁盘空间充足，暂未发现需要关注的问题。",
      tone: "violet",
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
    <section className="min-w-0 rounded-xl border border-border/70 bg-card p-3.5 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className="mt-1 text-[28px] font-semibold leading-none tracking-tight">{value}</p>
          <p className="mt-2 truncate text-[11px] text-muted-foreground">{detail}</p>
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

export function OverviewPanel() {
  const { data } = useSystemOverview();
  const [timeRange, setTimeRange] = useState<(typeof TIME_RANGES)[number]>(TIME_RANGES[0]);
  const [sort, setSort] = useState<{ key: ProcessSortKey; direction: SortDirection }>({ key: "cpuPercent", direction: "descending" });
  const { data: history } = useSystemHistory(timeRange.seconds);

  if (!data) {
    return (
      <div className="space-y-3">
        <h2 className="sr-only">电脑状态概览</h2>
        <div className="grid gap-3 md:grid-cols-3">
          {[0, 1, 2].map((index) => <div key={index} className="h-[118px] animate-pulse rounded-xl border border-border/70 bg-card" />)}
        </div>
        <div className="h-64 animate-pulse rounded-xl border border-border/70 bg-card" />
      </div>
    );
  }

  const cDrive = data.disks[0];
  const issues = buildIssues(data.disks);
  const cpuPolyline = buildPolyline(history, (point) => point.cpuUsage);
  const memoryPolyline = buildPolyline(history, (point) => point.memUsage);
  const cpuMiniPolyline = buildPolyline(history, (point) => point.cpuUsage, 120, 48);
  const memoryMiniPolyline = buildPolyline(history, (point) => point.memUsage, 120, 48);
  const networkMiniPolyline = buildPolyline(history, (point) => Math.min(point.netTotalMbps, 100), 120, 48);
  const historyReady = history.length >= 2;
  const timeLabels = buildTimeLabels(history, timeRange.seconds);
  const issueTone = {
    red: "border-red-200/80 bg-red-500/[0.025]",
    orange: "border-orange-200/90 bg-orange-500/[0.025]",
    violet: "border-violet-200/90 bg-violet-500/[0.025]",
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

  return (
    <div className="space-y-3">
      <h2 className="sr-only">电脑状态概览</h2>

      <div className="grid gap-3 md:grid-cols-3">
        <OverviewMetric label="CPU" value={formatPercent(data.cpu.usagePercent)} detail={`${data.cpu.frequencyGhz.toFixed(1)} GHz`} points={cpuMiniPolyline} color="#2f80ff" />
        <OverviewMetric label="内存" value={formatPercent(data.memory.usagePercent)} detail={`${formatGb(data.memory.usedGb)} / ${formatGb(data.memory.totalGb)} GB`} points={memoryMiniPolyline} color="#9367ff" />
        <OverviewMetric label="网络" value={formatMbps(data.network.totalMbps)} detail={`↑ ${formatMbps(data.network.uploadMbps)}　↓ ${formatMbps(data.network.downloadMbps)}`} points={networkMiniPolyline} color="#4caf72" />
      </div>

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
                  className={`rounded px-2.5 py-1 text-[11px] transition ${timeRange.seconds === range.seconds ? "bg-blue-50 text-blue-600 shadow-sm dark:bg-blue-500/15" : "text-muted-foreground hover:text-foreground"}`}
                >
                  {range.label}
                </button>
              ))}
            </div>
          }
        >
          <div className="flex gap-4 text-[11px] text-muted-foreground">
            <span><i className="mr-1 inline-block h-0.5 w-4 align-middle bg-blue-500" />CPU (%)</span>
            <span><i className="mr-1 inline-block h-0.5 w-4 align-middle bg-violet-500" />内存 (%)</span>
          </div>
          <div className="mt-2 grid grid-cols-[30px_minmax(0,1fr)] gap-2">
            <div className="flex h-40 flex-col justify-between pb-0.5 text-right text-[10px] text-muted-foreground"><span>100%</span><span>75%</span><span>50%</span><span>25%</span><span>0%</span></div>
            <div>
              <div className="relative h-40 rounded-sm bg-[linear-gradient(to_bottom,hsl(var(--border)/0.55)_1px,transparent_1px)] bg-[length:100%_25%]">
                {historyReady ? (
                  <svg viewBox="0 0 600 160" className="h-full w-full" preserveAspectRatio="none" aria-label="CPU 与内存趋势图">
                    <polyline points={cpuPolyline} fill="none" stroke="#2f80ff" strokeWidth="2" vectorEffect="non-scaling-stroke" />
                    <polyline points={memoryPolyline} fill="none" stroke="#9367ff" strokeWidth="2" vectorEffect="non-scaling-stroke" />
                  </svg>
                ) : <div className="flex h-full items-center justify-center text-xs text-muted-foreground">正在采集趋势数据</div>}
              </div>
              <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">{timeLabels.map((label) => <span key={label}>{label}</span>)}</div>
            </div>
          </div>
        </PanelCard>

        {cDrive && (
          <PanelCard title={`磁盘空间 (${cDrive.driveLetter})`}>
            <div className="flex items-center gap-5">
              <div className="relative flex h-28 w-28 shrink-0 items-center justify-center rounded-full" style={{ background: `conic-gradient(${cDrive.usagePercent >= 90 ? "#ef4444" : cDrive.usagePercent >= 80 ? "#ff5a52" : "#2f80ff"} 0 ${cDrive.usagePercent}%, hsl(var(--muted)) ${cDrive.usagePercent}% 100%)` }}>
                <div className="flex h-20 w-20 flex-col items-center justify-center rounded-full bg-card"><strong className="text-2xl">{formatPercent(cDrive.usagePercent)}</strong><span className="text-[10px] text-muted-foreground">已使用</span></div>
              </div>
              <div className="min-w-0 flex-1 divide-y divide-border/60 text-xs">
                <div className="pb-2"><p className="text-muted-foreground">已使用</p><p className="mt-1 text-lg font-semibold text-red-500">{formatGb(cDrive.usedGb)} GB</p></div>
                <div className="py-2"><p className="text-muted-foreground">可用</p><p className="mt-1 text-lg font-semibold">{formatGb(cDrive.availableGb)} GB</p></div>
                <div className="pt-2 text-muted-foreground">总容量　{formatGb(cDrive.totalGb)} GB</div>
              </div>
            </div>
          </PanelCard>
        )}
      </div>

      <PanelCard title="当前主要问题">
        <div className="grid gap-3 md:grid-cols-3">
          {issues.map((issue) => (
            <div key={issue.title} className={`rounded-lg border p-3 ${issueTone[issue.tone]}`}>
              <div className="flex items-center gap-2"><TriangleAlert className={`h-4 w-4 ${issue.tone === "red" ? "text-red-500" : issue.tone === "orange" ? "text-orange-500" : "text-violet-500"}`} /><strong className="text-sm">{issue.title}</strong></div>
              <p className="mt-2 min-h-5 text-[11px] leading-5 text-muted-foreground">依据：{issue.detail}</p>
              <button type="button" className={`${secondaryButtonClass} mt-2.5 w-full`}>问 Mona</button>
            </div>
          ))}
        </div>
      </PanelCard>

      <PanelCard title="资源占用较高的程序">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[540px] text-left text-xs">
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
